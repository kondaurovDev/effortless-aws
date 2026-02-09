import { Project, SyntaxKind, type ObjectLiteralExpression, type PropertyAssignment, type CallExpression } from "ts-morph";

// ============ Shared utilities ============

const parseSource = (source: string) => {
  const project = new Project({ useInMemoryFileSystem: true });
  return project.createSourceFile("input.ts", source);
};

const RUNTIME_PROPS = ["onRequest", "onRecord", "onBatchComplete", "onBatch", "context", "schema", "onError", "deps", "params"];

const buildConfigWithoutRuntime = (obj: ObjectLiteralExpression): string => {
  const props = obj.getProperties()
    .filter(p => {
      if (p.getKind() === SyntaxKind.PropertyAssignment) {
        const propAssign = p as PropertyAssignment;
        return !RUNTIME_PROPS.includes(propAssign.getName());
      }
      return true;
    })
    .map(p => p.getText())
    .join(", ");
  return `{ ${props} }`;
};

const extractPropertyFromObject = (obj: ObjectLiteralExpression, propName: string): string | undefined => {
  const prop = obj.getProperties().find(p => {
    if (p.getKind() === SyntaxKind.PropertyAssignment) {
      return (p as PropertyAssignment).getName() === propName;
    }
    return false;
  });

  if (prop && prop.getKind() === SyntaxKind.PropertyAssignment) {
    const propAssign = prop as PropertyAssignment;
    return propAssign.getInitializer()?.getText();
  }
  return undefined;
};

/**
 * Extract dependency key names from the deps property of a handler config.
 * Handles: deps: { orders, users } (ShorthandPropertyAssignment)
 * And:     deps: { orders: orders } (PropertyAssignment)
 */
const extractDepsKeys = (obj: ObjectLiteralExpression): string[] => {
  const depsProp = obj.getProperties().find(p => {
    if (p.getKind() === SyntaxKind.PropertyAssignment) {
      return (p as PropertyAssignment).getName() === "deps";
    }
    return false;
  });

  if (!depsProp || depsProp.getKind() !== SyntaxKind.PropertyAssignment) return [];

  const init = (depsProp as PropertyAssignment).getInitializer();
  if (!init || init.getKind() !== SyntaxKind.ObjectLiteralExpression) return [];

  const depsObj = init as ObjectLiteralExpression;
  return depsObj.getProperties()
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

/**
 * Extract param entries from the params property of a handler config.
 * Reads: params: { dbUrl: param("database-url"), config: param("app-config", TOML.parse) }
 * Returns: [{ propName: "dbUrl", ssmKey: "database-url" }, { propName: "config", ssmKey: "app-config" }]
 */
export type ParamEntry = { propName: string; ssmKey: string };

const extractParamEntries = (obj: ObjectLiteralExpression): ParamEntry[] => {
  const paramsProp = obj.getProperties().find(p => {
    if (p.getKind() === SyntaxKind.PropertyAssignment) {
      return (p as PropertyAssignment).getName() === "params";
    }
    return false;
  });

  if (!paramsProp || paramsProp.getKind() !== SyntaxKind.PropertyAssignment) return [];

  const init = (paramsProp as PropertyAssignment).getInitializer();
  if (!init || init.getKind() !== SyntaxKind.ObjectLiteralExpression) return [];

  const paramsObj = init as ObjectLiteralExpression;
  const entries: ParamEntry[] = [];

  for (const p of paramsObj.getProperties()) {
    if (p.getKind() !== SyntaxKind.PropertyAssignment) continue;

    const propAssign = p as PropertyAssignment;
    const propName = propAssign.getName();
    const propInit = propAssign.getInitializer();

    // Expect: param("some-key") or param("some-key", transform)
    if (!propInit || propInit.getKind() !== SyntaxKind.CallExpression) continue;

    const callExpr = propInit as CallExpression;
    const callArgs = callExpr.getArguments();
    if (callArgs.length === 0) continue;

    const firstArg = callArgs[0]!;
    // Extract string literal value
    if (firstArg.getKind() === SyntaxKind.StringLiteral) {
      const ssmKey = firstArg.asKindOrThrow(SyntaxKind.StringLiteral).getLiteralValue();
      entries.push({ propName, ssmKey });
    }
  }

  return entries;
};

// ============ Handler Registry ============

export type HandlerDefinition = {
  defineFn: string;
  handlerProps: readonly string[];
  wrapperFn: string;
};

export const handlerRegistry = {
  http: {
    defineFn: "defineHttp",
    handlerProps: ["onRequest"],
    wrapperFn: "wrapHttp",
    wrapperPath: "~/runtime/wrap-http",
  },
  table: {
    defineFn: "defineTable",
    handlerProps: ["onRecord", "onBatch"],
    wrapperFn: "wrapTableStream",
    wrapperPath: "~/runtime/wrap-table-stream",
  },
} as const;

export type HandlerType = keyof typeof handlerRegistry;

// ============ Config extraction ============

export type ExtractedConfig<T = unknown> = {
  exportName: string;
  config: T;
  hasHandler: boolean;
  depsKeys: string[];
  paramEntries: ParamEntry[];
};

export const extractHandlerConfigs = <T>(source: string, type: HandlerType): ExtractedConfig<T>[] => {
  const { defineFn, handlerProps } = handlerRegistry[type];
  const sourceFile = parseSource(source);
  const results: ExtractedConfig<T>[] = [];

  const exportDefault = sourceFile.getExportAssignment(e => !e.isExportEquals());
  if (exportDefault) {
    const expr = exportDefault.getExpression();
    if (expr.getKind() === SyntaxKind.CallExpression) {
      const callExpr = expr.asKindOrThrow(SyntaxKind.CallExpression);
      if (callExpr.getExpression().getText() === defineFn) {
        const args = callExpr.getArguments();
        const firstArg = args[0];
        if (firstArg && firstArg.getKind() === SyntaxKind.ObjectLiteralExpression) {
          const objLiteral = firstArg as ObjectLiteralExpression;
          const configText = buildConfigWithoutRuntime(objLiteral);
          const configObj = new Function(`return ${configText}`)() as T;
          const hasHandler = handlerProps.some(p => extractPropertyFromObject(objLiteral, p) !== undefined);
          const depsKeys = extractDepsKeys(objLiteral);
          const paramEntries = extractParamEntries(objLiteral);
          results.push({ exportName: "default", config: configObj, hasHandler, depsKeys, paramEntries });
        }
      }
    }
  }

  sourceFile.getVariableStatements().forEach(stmt => {
    if (!stmt.isExported()) return;

    stmt.getDeclarations().forEach(decl => {
      const initializer = decl.getInitializer();
      if (!initializer || initializer.getKind() !== SyntaxKind.CallExpression) return;

      const callExpr = initializer.asKindOrThrow(SyntaxKind.CallExpression);
      if (callExpr.getExpression().getText() !== defineFn) return;

      const args = callExpr.getArguments();
      const firstArg = args[0];
      if (firstArg && firstArg.getKind() === SyntaxKind.ObjectLiteralExpression) {
        const objLiteral = firstArg as ObjectLiteralExpression;
        const configText = buildConfigWithoutRuntime(objLiteral);
        const configObj = new Function(`return ${configText}`)() as T;
        const hasHandler = handlerProps.some(p => extractPropertyFromObject(objLiteral, p) !== undefined);
        const depsKeys = extractDepsKeys(objLiteral);
        const paramEntries = extractParamEntries(objLiteral);
        results.push({ exportName: decl.getName(), config: configObj, hasHandler, depsKeys, paramEntries });
      }
    });
  });

  return results;
};

// ============ Entry point generation ============

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
