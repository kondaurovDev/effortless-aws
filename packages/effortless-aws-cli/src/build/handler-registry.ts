import { Project, SyntaxKind, type ObjectLiteralExpression, type PropertyAssignment, type ShorthandPropertyAssignment, type CallExpression, type Node } from "ts-morph";

// ============ Types ============

/** Secret entry extracted from handler config at discovery time. */
export type SecretEntry = { propName: string; ssmKey: string; generate?: string };

/** @deprecated Use SecretEntry */
export type ParamEntry = SecretEntry;

export type HandlerDefinition = {
  defineFn: string;
  handlerProps: readonly string[];
  wrapperFn: string;
};

export const handlerRegistry = {
  table: {
    defineFn: "defineTable",
    handlerProps: ["onRecord", "onRecordBatch"],
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
    handlerProps: ["onMessage", "onMessageBatch"],
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
  cron: {
    defineFn: "defineCron",
    handlerProps: ["onTick"],
    wrapperFn: "wrapCron",
    wrapperPath: "~/runtime/wrap-cron",
  },
  api: {
    defineFn: "defineApi",
    handlerProps: ["routes"],
    wrapperFn: "wrapApi",
    wrapperPath: "~/runtime/wrap-api",
  },
  worker: {
    defineFn: "defineWorker",
    handlerProps: ["onMessage"],
    wrapperFn: "wrapWorker",
    wrapperPath: "~/runtime/wrap-worker",
  },
  mcp: {
    defineFn: "defineMcp",
    handlerProps: ["tools", "resources", "prompts"],
    wrapperFn: "wrapMcp",
    wrapperPath: "~/runtime/wrap-mcp",
  },
} as const;

export type HandlerType = keyof typeof handlerRegistry;

/** API route extracted from a static site's routes map */
export type ApiRouteEntry = {
  /** CloudFront path pattern (e.g., "/api/*") */
  pattern: string;
  /** Export name of the referenced API handler */
  handlerExport: string;
};

/** Bucket route extracted from a static site's routes map */
export type BucketRouteEntry = {
  /** CloudFront path pattern (e.g., "/files/*") */
  pattern: string;
  /** Export name of the referenced bucket handler */
  bucketExportName: string;
  /** Access control mode */
  access: "private" | "public";
};

export type ExtractedConfig<T = unknown> = {
  exportName: string;
  config: T;
  hasHandler: boolean;
  depsKeys: string[];
  secretEntries: SecretEntry[];
  staticGlobs: string[];
  routePatterns: string[];
  /** API routes extracted from a static site's routes map (only for staticSite type) */
  apiRoutes: ApiRouteEntry[];
  /** Bucket routes extracted from a static site's routes map (only for staticSite type) */
  bucketRoutes: BucketRouteEntry[];
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

// ============ Middleware extraction (AST — used only for Lambda@Edge) ============

const parseSource = (source: string) => {
  const project = new Project({ useInMemoryFileSystem: true });
  return project.createSourceFile("input.ts", source);
};

const bareName = (expr: string): string => {
  const dot = expr.lastIndexOf(".");
  return dot === -1 ? expr : expr.slice(dot + 1);
};

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

const findDefineCalls = (sourceFile: ReturnType<typeof parseSource>, defineFn: string) => {
  const results: { exportName: string; args: ObjectLiteralExpression }[] = [];

  const tryAdd = (callExpr: CallExpression, exportName: string) => {
    if (bareName(callExpr.getExpression().getText()) !== defineFn) return;
    const firstArg = callExpr.getArguments()[0];
    if (firstArg?.getKind() === SyntaxKind.ObjectLiteralExpression) {
      results.push({ exportName, args: firstArg as ObjectLiteralExpression });
    }
  };

  const def = sourceFile.getExportAssignment(e => !e.isExportEquals());
  if (def?.getExpression().getKind() === SyntaxKind.CallExpression) {
    tryAdd(def.getExpression().asKindOrThrow(SyntaxKind.CallExpression), "default");
  }

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
