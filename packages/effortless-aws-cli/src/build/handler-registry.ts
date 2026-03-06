import { Project, SyntaxKind, type ObjectLiteralExpression, type PropertyAssignment, type ShorthandPropertyAssignment, type CallExpression, type ArrowFunction, type ParenthesizedExpression, type Node } from "ts-morph";

// ============ Shared AST helpers ============

const parseSource = (source: string) => {
  const project = new Project({ useInMemoryFileSystem: true });
  return project.createSourceFile("input.ts", source);
};

/** Get the bare function name (handles `Eff.defineTable` → `defineTable`) */
const bareName = (expr: string): string => {
  const dot = expr.lastIndexOf(".");
  return dot === -1 ? expr : expr.slice(dot + 1);
};

/** Get initializer of a named property from an object literal.
 *  Handles both `key: value` (PropertyAssignment) and shorthand `key,` (ShorthandPropertyAssignment). */
const getProp = (obj: ObjectLiteralExpression, name: string): Node | undefined => {
  for (const p of obj.getProperties()) {
    if (p.getKind() === SyntaxKind.PropertyAssignment && (p as PropertyAssignment).getName() === name) {
      return (p as PropertyAssignment).getInitializer();
    }
    if (p.getKind() === SyntaxKind.ShorthandPropertyAssignment && (p as ShorthandPropertyAssignment).getName() === name) {
      return (p as ShorthandPropertyAssignment).getNameNode();
    }
  }
  return undefined;
};

/** Find all exported `defineFn(...)` calls, returning { exportName, args } */
const findDefineCalls = (sourceFile: ReturnType<typeof parseSource>, defineFn: string) => {
  const results: { exportName: string; args: ObjectLiteralExpression }[] = [];

  const tryAdd = (callExpr: CallExpression, exportName: string) => {
    if (bareName(callExpr.getExpression().getText()) !== defineFn) return;
    const firstArg = callExpr.getArguments()[0];
    if (firstArg?.getKind() === SyntaxKind.ObjectLiteralExpression) {
      results.push({ exportName, args: firstArg as ObjectLiteralExpression });
    }
  };

  // default export
  const def = sourceFile.getExportAssignment(e => !e.isExportEquals());
  if (def?.getExpression().getKind() === SyntaxKind.CallExpression) {
    tryAdd(def.getExpression().asKindOrThrow(SyntaxKind.CallExpression), "default");
  }

  // named exports
  for (const stmt of sourceFile.getVariableStatements()) {
    if (!stmt.isExported()) continue;
    for (const decl of stmt.getDeclarations()) {
      const init = decl.getInitializer();
      if (init?.getKind() === SyntaxKind.CallExpression) {
        tryAdd(init.asKindOrThrow(SyntaxKind.CallExpression), decl.getName());
      }
    }
  }

  return results;
};

// ============ Config evaluation ============

const RUNTIME_PROPS = ["onRecord", "onBatchComplete", "onBatch", "onMessage", "onObjectCreated", "onObjectRemoved", "setup", "schema", "onError", "deps", "config", "static", "middleware", "auth", "routes", "get", "post"];

const evalConfig = <T>(configText: string, exportName: string): T => {
  try {
    return new Function(`return ${configText}`)() as T;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Failed to extract config for "${exportName}": ${msg}.\n` +
      `Handler config must use only literal values (no variables, imports, or expressions).`
    );
  }
};

const buildConfigWithoutRuntime = (obj: ObjectLiteralExpression): string => {
  const props = obj.getProperties()
    .filter(p => {
      if (p.getKind() === SyntaxKind.PropertyAssignment) {
        return !RUNTIME_PROPS.includes((p as PropertyAssignment).getName());
      }
      if (p.getKind() === SyntaxKind.ShorthandPropertyAssignment) {
        return !RUNTIME_PROPS.includes(p.asKindOrThrow(SyntaxKind.ShorthandPropertyAssignment).getName());
      }
      return true;
    })
    .map(p => p.getText())
    .join(", ");
  return `{ ${props} }`;
};

// ============ Property extractors ============

/** Convert camelCase property name to kebab-case SSM key. */
const toKebabCase = (str: string): string =>
  str.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();

const extractDepsKeys = (obj: ObjectLiteralExpression): string[] => {
  let init = getProp(obj, "deps");
  if (!init) return [];

  // Unwrap arrow function: deps: () => ({ ... })
  if (init.getKind() === SyntaxKind.ArrowFunction) {
    const body = (init as ArrowFunction).getBody();
    if (body.getKind() === SyntaxKind.ParenthesizedExpression) {
      init = (body as ParenthesizedExpression).getExpression();
    }
  }

  if (init.getKind() !== SyntaxKind.ObjectLiteralExpression) return [];

  return (init as ObjectLiteralExpression).getProperties()
    .map(p => {
      if (p.getKind() === SyntaxKind.ShorthandPropertyAssignment) {
        return p.asKindOrThrow(SyntaxKind.ShorthandPropertyAssignment).getName();
      }
      if (p.getKind() === SyntaxKind.PropertyAssignment) {
        return (p as PropertyAssignment).getName();
      }
      return "";
    })
    .filter(Boolean);
};

// ============ Secrets / Params extraction ============

export type GenerateSpec =
  | { type: "hex"; bytes: number }
  | { type: "base64"; bytes: number }
  | { type: "uuid" };

export type SecretEntry = { propName: string; ssmKey: string; generate?: GenerateSpec };

/** @deprecated Use SecretEntry */
export type ParamEntry = SecretEntry;

const parseGenerateSpec = (text: string | undefined): GenerateSpec | undefined => {
  if (!text) return undefined;
  const hexMatch = text.match(/generateHex\((\d+)\)/);
  if (hexMatch) return { type: "hex", bytes: Number(hexMatch[1]) };
  const base64Match = text.match(/generateBase64\((\d+)\)/);
  if (base64Match) return { type: "base64", bytes: Number(base64Match[1]) };
  if (text.includes("generateUuid")) return { type: "uuid" };
  return undefined;
};

const extractSecretEntries = (obj: ObjectLiteralExpression): SecretEntry[] => {
  const init = getProp(obj, "config");
  if (!init || init.getKind() !== SyntaxKind.ObjectLiteralExpression) return [];

  const configObj = init as ObjectLiteralExpression;
  const entries: SecretEntry[] = [];

  for (const p of configObj.getProperties()) {
    if (p.getKind() !== SyntaxKind.PropertyAssignment) continue;

    const propAssign = p as PropertyAssignment;
    const propName = propAssign.getName();
    const propInit = propAssign.getInitializer();
    if (!propInit) continue;

    // Legacy plain string: config: { dbUrl: "database-url" }
    if (propInit.getKind() === SyntaxKind.StringLiteral) {
      entries.push({ propName, ssmKey: propInit.asKindOrThrow(SyntaxKind.StringLiteral).getLiteralValue() });
      continue;
    }

    if (propInit.getKind() !== SyntaxKind.CallExpression) continue;
    const callExpr = propInit as CallExpression;
    const fnName = bareName(callExpr.getExpression().getText());

    if (fnName === "secret") {
      const callArgs = callExpr.getArguments();
      if (callArgs.length === 0) {
        entries.push({ propName, ssmKey: toKebabCase(propName) });
        continue;
      }

      const firstArg = callArgs[0]!;
      if (firstArg.getKind() === SyntaxKind.ObjectLiteralExpression) {
        const optObj = firstArg as ObjectLiteralExpression;
        const keyText = getProp(optObj, "key")?.getText();
        const ssmKey = keyText ? keyText.replace(/^["']|["']$/g, "") : toKebabCase(propName);
        const generate = parseGenerateSpec(getProp(optObj, "generate")?.getText());
        entries.push({ propName, ssmKey, ...(generate ? { generate } : {}) });
      }
      continue;
    }

    // Legacy param("key") or param("key", transform)
    if (fnName === "param") {
      const firstArg = callExpr.getArguments()[0];
      if (firstArg?.getKind() === SyntaxKind.StringLiteral) {
        entries.push({ propName, ssmKey: firstArg.asKindOrThrow(SyntaxKind.StringLiteral).getLiteralValue() });
      }
    }
  }

  return entries;
};

const extractStaticGlobs = (obj: ObjectLiteralExpression): string[] => {
  const init = getProp(obj, "static");
  if (!init || init.getKind() !== SyntaxKind.ArrayLiteralExpression) return [];

  return init.asKindOrThrow(SyntaxKind.ArrayLiteralExpression).getElements()
    .filter(e => e.getKind() === SyntaxKind.StringLiteral)
    .map(e => e.asKindOrThrow(SyntaxKind.StringLiteral).getLiteralValue());
};

const extractRoutePatterns = (obj: ObjectLiteralExpression): string[] => {
  const init = getProp(obj, "routes");
  if (!init || init.getKind() !== SyntaxKind.ObjectLiteralExpression) return [];

  return (init as ObjectLiteralExpression).getProperties()
    .map(p => {
      if (p.getKind() !== SyntaxKind.PropertyAssignment) return "";
      const nameNode = (p as PropertyAssignment).getNameNode();
      if (nameNode.getKind() === SyntaxKind.StringLiteral) {
        return nameNode.asKindOrThrow(SyntaxKind.StringLiteral).getLiteralValue();
      }
      return nameNode.getText();
    })
    .filter(Boolean);
};

// ============ Auth config extraction ============

export type AuthConfig = {
  loginPath: string;
  public?: string[];
  expiresIn?: string | number;
};

const extractAuthConfigFromCall = (callExpr: CallExpression): AuthConfig | undefined => {
  if (bareName(callExpr.getExpression().getText()) !== "defineAuth") return undefined;
  const firstArg = callExpr.getArguments()[0];
  if (!firstArg || firstArg.getKind() !== SyntaxKind.ObjectLiteralExpression) return undefined;
  try {
    return new Function(`return ${firstArg.getText()}`)() as AuthConfig;
  } catch {
    return undefined;
  }
};

const extractAuthConfig = (obj: ObjectLiteralExpression, sourceFile: ReturnType<typeof parseSource>): AuthConfig | undefined => {
  const init = getProp(obj, "auth");
  if (!init) return undefined;

  // Direct call: auth: defineAuth({ ... })
  if (init.getKind() === SyntaxKind.CallExpression) {
    return extractAuthConfigFromCall(init as CallExpression);
  }

  // Identifier reference: auth: protect  OR  shorthand: auth,
  if (init.getKind() === SyntaxKind.Identifier) {
    const varInit = sourceFile.getVariableDeclaration(init.getText())?.getInitializer();
    if (varInit?.getKind() === SyntaxKind.CallExpression) {
      return extractAuthConfigFromCall(varInit as CallExpression);
    }
  }

  return undefined;
};

// ============ Handler Registry ============

export type HandlerDefinition = {
  defineFn: string;
  handlerProps: readonly string[];
  wrapperFn: string;
};

export const handlerRegistry = {
  table: {
    defineFn: "defineTable",
    handlerProps: ["onRecord", "onBatch"],
    wrapperFn: "wrapTableStream",
    wrapperPath: "~/runtime/wrap-table-stream",
  },
  app: {
    defineFn: "defineApp",
    handlerProps: [],
    wrapperFn: "",
    wrapperPath: "",
  },
  staticSite: {
    defineFn: "defineStaticSite",
    handlerProps: ["middleware"],
    wrapperFn: "wrapMiddleware",
    wrapperPath: "~/runtime/wrap-middleware",
  },
  fifoQueue: {
    defineFn: "defineFifoQueue",
    handlerProps: ["onMessage", "onBatch"],
    wrapperFn: "wrapFifoQueue",
    wrapperPath: "~/runtime/wrap-fifo-queue",
  },
  bucket: {
    defineFn: "defineBucket",
    handlerProps: ["onObjectCreated", "onObjectRemoved"],
    wrapperFn: "wrapBucket",
    wrapperPath: "~/runtime/wrap-bucket",
  },
  mailer: {
    defineFn: "defineMailer",
    handlerProps: [],
    wrapperFn: "",
    wrapperPath: "",
  },
  api: {
    defineFn: "defineApi",
    handlerProps: ["get", "post"],
    wrapperFn: "wrapApi",
    wrapperPath: "~/runtime/wrap-api",
  },
} as const;

export type HandlerType = keyof typeof handlerRegistry;

// ============ Config extraction ============

export type ExtractedConfig<T = unknown> = {
  exportName: string;
  config: T;
  hasHandler: boolean;
  depsKeys: string[];
  secretEntries: SecretEntry[];
  staticGlobs: string[];
  routePatterns: string[];
  authConfig?: AuthConfig;
};

export const extractHandlerConfigs = <T>(source: string, type: HandlerType): ExtractedConfig<T>[] => {
  const { defineFn, handlerProps } = handlerRegistry[type];
  const sourceFile = parseSource(source);

  return findDefineCalls(sourceFile, defineFn).map(({ exportName, args }) => {
    const config = evalConfig<T>(buildConfigWithoutRuntime(args), exportName);
    const hasHandler = handlerProps.some(p => getProp(args, p) !== undefined);
    const authCfg = extractAuthConfig(args, sourceFile);
    return {
      exportName,
      config,
      hasHandler,
      depsKeys: extractDepsKeys(args),
      secretEntries: extractSecretEntries(args),
      staticGlobs: extractStaticGlobs(args),
      routePatterns: extractRoutePatterns(args),
      ...(authCfg ? { authConfig: authCfg } : {}),
    };
  });
};

// ============ Entry point generation ============

/**
 * Generate a standalone middleware entry point that extracts only the middleware
 * function from the handler definition via AST, avoiding bundling the entire handler
 * and its dependencies (which would pull in heavy modules like HTTP clients).
 */
export const generateMiddlewareEntryPoint = (
  source: string,
  runtimeDir: string
): { entryPoint: string; exportName: string } => {
  const sourceFile = parseSource(source);
  const calls = findDefineCalls(sourceFile, handlerRegistry.staticSite.defineFn);

  let middlewareFnText: string | undefined;
  let exportName: string | undefined;

  for (const call of calls) {
    const mw = getProp(call.args, "middleware")?.getText();
    if (mw) {
      middlewareFnText = mw;
      exportName = call.exportName;
      break;
    }
  }

  if (!middlewareFnText || !exportName) {
    throw new Error("Could not extract middleware function from source");
  }

  // Only include imports whose bindings are actually referenced in the middleware fn
  const imports = sourceFile.getImportDeclarations()
    .filter(d => {
      const defaultImport = d.getDefaultImport()?.getText();
      if (defaultImport && middlewareFnText!.includes(defaultImport)) return true;
      for (const spec of d.getNamedImports()) {
        const alias = spec.getAliasNode()?.getText() ?? spec.getName();
        if (middlewareFnText!.includes(alias)) return true;
      }
      const ns = d.getNamespaceImport()?.getText();
      if (ns && middlewareFnText!.includes(ns)) return true;
      return false;
    })
    .map(d => d.getText())
    .join("\n");

  const wrapperPath = runtimeDir
    ? handlerRegistry.staticSite.wrapperPath.replace("~/runtime", runtimeDir)
    : handlerRegistry.staticSite.wrapperPath;

  const entryPoint = `${imports}
import { wrapMiddlewareFn } from "${wrapperPath}";
const __middleware = ${middlewareFnText};
export const handler = wrapMiddlewareFn(__middleware);
`;

  return { entryPoint, exportName };
};

export const generateEntryPoint = (
  sourcePath: string,
  exportName: string,
  type: HandlerType,
  runtimeDir?: string
): string => {
  const { wrapperFn, wrapperPath } = handlerRegistry[type];

  const resolvedWrapperPath = runtimeDir
    ? wrapperPath.replace("~/runtime", runtimeDir)
    : wrapperPath;

  const importName = exportName === "default" ? "__handler" : exportName;
  const importStmt = exportName === "default"
    ? `import __handler from "${sourcePath}";`
    : `import { ${exportName} } from "${sourcePath}";`;

  return `${importStmt}
import { ${wrapperFn} } from "${resolvedWrapperPath}";
export const handler = ${wrapperFn}(${importName});
`;
};
