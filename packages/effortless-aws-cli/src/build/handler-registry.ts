import { Project, SyntaxKind, type CallExpression, type Node } from "ts-morph";
import { handlers, type HandlerType } from "../core";

// Re-export types from core
export type { HandlerType, SecretEntry, ParamEntry, ExtractedConfig, ApiRouteEntry, BucketRouteEntry, HandlerDefinition } from "../core";

// ============ Entry point generation ============

export const generateEntryPoint = (
  sourcePath: string,
  exportName: string,
  type: HandlerType,
  runtimeDir?: string
): string => {
  const { wrapperFn, wrapperPath } = handlers[type];

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


/** Walk a call expression chain to find a .middleware(fn) call and extract fn text */
const findMiddlewareInChain = (node: Node): string | undefined => {
  if (node.getKind() !== SyntaxKind.CallExpression) return undefined;
  const call = node as CallExpression;
  const expr = call.getExpression();

  // Check if this is .middleware(fn)
  if (expr.getKind() === SyntaxKind.PropertyAccessExpression) {
    const propName = expr.asKindOrThrow(SyntaxKind.PropertyAccessExpression).getName();
    if (propName === "middleware") {
      const arg = call.getArguments()[0];
      return arg?.getText();
    }
  }

  // Recurse into the object expression (the chain before this call)
  if (expr.getKind() === SyntaxKind.PropertyAccessExpression) {
    const obj = expr.asKindOrThrow(SyntaxKind.PropertyAccessExpression).getExpression();
    return findMiddlewareInChain(obj);
  }

  return undefined;
};

/** List of define function names that can produce a static site with middleware */
const staticSiteDefineFns: Set<string> = new Set([handlers.staticSite.defineFn]);

/** Check if an expression chain contains a defineStaticSite call */
const chainContainsDefineFn = (node: Node): boolean => {
  if (node.getKind() === SyntaxKind.CallExpression) {
    const call = node as CallExpression;
    const exprText = bareName(call.getExpression().getText());
    if (staticSiteDefineFns.has(exprText)) return true;
    // Recurse: .method() chains
    const expr = call.getExpression();
    if (expr.getKind() === SyntaxKind.PropertyAccessExpression) {
      return chainContainsDefineFn(expr.asKindOrThrow(SyntaxKind.PropertyAccessExpression).getExpression());
    }
  }
  return false;
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

  let middlewareFnText: string | undefined;
  let exportName: string | undefined;

  // Search exported variable declarations for a defineStaticSite chain with .middleware()
  for (const stmt of sourceFile.getVariableStatements()) {
    if (!stmt.isExported()) continue;
    for (const decl of stmt.getDeclarations()) {
      const init = decl.getInitializer();
      if (!init) continue;
      // Walk the chain looking for .middleware(fn)
      const mw = findMiddlewareInChain(init);
      if (mw && chainContainsDefineFn(init)) {
        middlewareFnText = mw;
        exportName = decl.getName();
        break;
      }
    }
    if (middlewareFnText) break;
  }

  // Also check default export
  if (!middlewareFnText) {
    const def = sourceFile.getExportAssignment(e => !e.isExportEquals());
    if (def) {
      const expr = def.getExpression();
      const mw = findMiddlewareInChain(expr);
      if (mw && chainContainsDefineFn(expr)) {
        middlewareFnText = mw;
        exportName = "default";
      }
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
    ? handlers.staticSite.wrapperPath.replace("~/runtime", runtimeDir)
    : handlers.staticSite.wrapperPath;

  const entryPoint = `${imports}
import { wrapMiddlewareFn } from "${wrapperPath}";
const __middleware = ${middlewareFnText};
export const handler = wrapMiddlewareFn(__middleware);
`;

  return { entryPoint, exportName };
};
