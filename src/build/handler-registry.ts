import { Project, SyntaxKind, type ObjectLiteralExpression, type PropertyAssignment, type CallExpression, type ArrayLiteralExpression } from "ts-morph";

// ============ Shared utilities ============

const parseSource = (source: string) => {
  const project = new Project({ useInMemoryFileSystem: true });
  return project.createSourceFile("input.ts", source);
};

const RUNTIME_PROPS = ["onRequest", "onRecord", "onBatchComplete", "onBatch", "onMessage", "onObjectCreated", "onObjectRemoved", "setup", "schema", "onError", "deps", "config", "static", "middleware", "routes"];

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
 * Extract param entries from the config property of a handler definition.
 * Reads: config: { dbUrl: "database-url", appConfig: param("app-config", TOML.parse) }
 * Returns: [{ propName: "dbUrl", ssmKey: "database-url" }, { propName: "appConfig", ssmKey: "app-config" }]
 */
export type ParamEntry = { propName: string; ssmKey: string };

const extractParamEntries = (obj: ObjectLiteralExpression): ParamEntry[] => {
  const configProp = obj.getProperties().find(p => {
    if (p.getKind() === SyntaxKind.PropertyAssignment) {
      return (p as PropertyAssignment).getName() === "config";
    }
    return false;
  });

  if (!configProp || configProp.getKind() !== SyntaxKind.PropertyAssignment) return [];

  const init = (configProp as PropertyAssignment).getInitializer();
  if (!init || init.getKind() !== SyntaxKind.ObjectLiteralExpression) return [];

  const configObj = init as ObjectLiteralExpression;
  const entries: ParamEntry[] = [];

  for (const p of configObj.getProperties()) {
    if (p.getKind() !== SyntaxKind.PropertyAssignment) continue;

    const propAssign = p as PropertyAssignment;
    const propName = propAssign.getName();
    const propInit = propAssign.getInitializer();

    if (!propInit) continue;

    // Plain string: config: { dbUrl: "database-url" }
    if (propInit.getKind() === SyntaxKind.StringLiteral) {
      const ssmKey = propInit.asKindOrThrow(SyntaxKind.StringLiteral).getLiteralValue();
      entries.push({ propName, ssmKey });
      continue;
    }

    // param() call: config: { dbUrl: param("database-url") } or param("key", transform)
    if (propInit.getKind() !== SyntaxKind.CallExpression) continue;

    const callExpr = propInit as CallExpression;
    const callArgs = callExpr.getArguments();
    if (callArgs.length === 0) continue;

    const firstArg = callArgs[0]!;
    if (firstArg.getKind() === SyntaxKind.StringLiteral) {
      const ssmKey = firstArg.asKindOrThrow(SyntaxKind.StringLiteral).getLiteralValue();
      entries.push({ propName, ssmKey });
    }
  }

  return entries;
};

/**
 * Extract static file glob patterns from the static property of a handler config.
 * Reads: static: ["src/templates/*.ejs", "src/assets/*.css"]
 * Returns: ["src/templates/*.ejs", "src/assets/*.css"]
 */
const extractStaticGlobs = (obj: ObjectLiteralExpression): string[] => {
  const staticProp = obj.getProperties().find(p => {
    if (p.getKind() === SyntaxKind.PropertyAssignment) {
      return (p as PropertyAssignment).getName() === "static";
    }
    return false;
  });

  if (!staticProp || staticProp.getKind() !== SyntaxKind.PropertyAssignment) return [];

  const init = (staticProp as PropertyAssignment).getInitializer();
  if (!init || init.getKind() !== SyntaxKind.ArrayLiteralExpression) return [];

  const arrayLiteral = init as ArrayLiteralExpression;
  return arrayLiteral.getElements()
    .filter(e => e.getKind() === SyntaxKind.StringLiteral)
    .map(e => e.asKindOrThrow(SyntaxKind.StringLiteral).getLiteralValue());
};

/**
 * Extract route path patterns from the routes property of a static site config.
 * Reads: routes: { "/api/*": api, "/auth/*": auth }
 * Returns: ["/api/*", "/auth/*"]
 */
const extractRoutePatterns = (obj: ObjectLiteralExpression): string[] => {
  const routesProp = obj.getProperties().find(p => {
    if (p.getKind() === SyntaxKind.PropertyAssignment) {
      return (p as PropertyAssignment).getName() === "routes";
    }
    return false;
  });

  if (!routesProp || routesProp.getKind() !== SyntaxKind.PropertyAssignment) return [];

  const init = (routesProp as PropertyAssignment).getInitializer();
  if (!init || init.getKind() !== SyntaxKind.ObjectLiteralExpression) return [];

  const routesObj = init as ObjectLiteralExpression;
  return routesObj.getProperties()
    .map(p => {
      if (p.getKind() !== SyntaxKind.PropertyAssignment) return "";
      const nameNode = (p as PropertyAssignment).getNameNode();
      // String literal keys like "/api/*"
      if (nameNode.getKind() === SyntaxKind.StringLiteral) {
        return nameNode.asKindOrThrow(SyntaxKind.StringLiteral).getLiteralValue();
      }
      // Identifier keys (unlikely for path patterns but handle gracefully)
      return nameNode.getText();
    })
    .filter(Boolean);
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
  app: {
    defineFn: "defineApp",
    handlerProps: [],
    wrapperFn: "wrapApp",
    wrapperPath: "~/runtime/wrap-app",
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
} as const;

export type HandlerType = keyof typeof handlerRegistry;

// ============ Config extraction ============

export type ExtractedConfig<T = unknown> = {
  exportName: string;
  config: T;
  hasHandler: boolean;
  depsKeys: string[];
  paramEntries: ParamEntry[];
  staticGlobs: string[];
  routePatterns: string[];
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
          const config = evalConfig<T>(configText, "default");
          const hasHandler = handlerProps.some(p => extractPropertyFromObject(objLiteral, p) !== undefined);
          const depsKeys = extractDepsKeys(objLiteral);
          const paramEntries = extractParamEntries(objLiteral);
          const staticGlobs = extractStaticGlobs(objLiteral);
          const routePatterns = extractRoutePatterns(objLiteral);
          results.push({ exportName: "default", config, hasHandler, depsKeys, paramEntries, staticGlobs, routePatterns });
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
        const exportName = decl.getName();
        const config = evalConfig<T>(configText, exportName);
        const hasHandler = handlerProps.some(p => extractPropertyFromObject(objLiteral, p) !== undefined);
        const depsKeys = extractDepsKeys(objLiteral);
        const paramEntries = extractParamEntries(objLiteral);
        const staticGlobs = extractStaticGlobs(objLiteral);
        const routePatterns = extractRoutePatterns(objLiteral);
        results.push({ exportName, config, hasHandler, depsKeys, paramEntries, staticGlobs, routePatterns });
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
