/**
 * AST-based handler extraction — parses builder chains via ts-morph.
 * Pure functions, no I/O, no Effect.
 */

import { Project, SyntaxKind, type SourceFile, type CallExpression, type Node, type ObjectLiteralExpression, type PropertyAssignment, type ShorthandPropertyAssignment } from "ts-morph";
import { handlers, defineFnToType, type HandlerType, type ExtractedConfig, type SecretEntry, type ApiRouteEntry, type BucketRouteEntry } from "../core";

// ============ Public ============

/** Extract handler configs of a specific type from source code. */
export const extractConfigs = <T>(source: string, type: HandlerType): ExtractedConfig<T>[] => {
  const sourceFile = parseSource(source);
  const chains = findExportedChains(sourceFile);

  return chains
    .filter(c => c.type === type && isFinalized(c.type, c.steps))
    .map(c => processChain(c.exportName, c.type, c.steps, sourceFile) as ExtractedConfig<T>);
};

/** Extract all handler configs from source code (all types). */
export const extractAll = (source: string): { type: HandlerType; configs: ExtractedConfig<any>[] }[] => {
  const sourceFile = parseSource(source);
  const chains = findExportedChains(sourceFile);
  const byType = new Map<HandlerType, ExtractedConfig<any>[]>();

  for (const chain of chains) {
    if (!isFinalized(chain.type, chain.steps)) continue;
    const config = processChain(chain.exportName, chain.type, chain.steps, sourceFile);
    const list = byType.get(chain.type) ?? [];
    list.push(config);
    byType.set(chain.type, list);
  }

  return Array.from(byType.entries()).map(([type, configs]) => ({ type, configs }));
};

/** Resolve static site route identifiers to export names, classify as api/bucket routes. */
export const resolveStaticSiteRoutes = (
  siteConfigs: ExtractedConfig<any>[],
  allExports: Map<string, { type: HandlerType; exportName: string }>,
  source: string,
): void => {
  const sourceFile = parseSource(source);

  for (const site of siteConfigs) {
    const resolvedApiRoutes: ApiRouteEntry[] = [];
    const resolvedBucketRoutes: BucketRouteEntry[] = [];

    for (const ar of site.apiRoutes) {
      const resolvedExportName = resolveIdentifierToExport(ar.handlerExport, sourceFile, allExports);
      const handlerInfo = allExports.get(resolvedExportName);

      if (handlerInfo?.type === "bucket") {
        resolvedBucketRoutes.push({ pattern: ar.pattern, bucketExportName: resolvedExportName, access: ar.access ?? "public" });
      } else {
        resolvedApiRoutes.push({ pattern: ar.pattern, handlerExport: resolvedExportName });
      }
    }

    site.apiRoutes = resolvedApiRoutes;
    site.bucketRoutes = resolvedBucketRoutes;
  }
};

// ============ AST helpers ============

const parseSource = (source: string): SourceFile => {
  const project = new Project({ useInMemoryFileSystem: true });
  return project.createSourceFile("input.ts", source);
};

const bareName = (expr: string): string => {
  const dot = expr.lastIndexOf(".");
  return dot === -1 ? expr : expr.slice(dot + 1);
};

const toKebabCase = (str: string): string =>
  str.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();

// ============ Chain walking ============

type ChainStep = { method: string; args: Node[] };

const walkChain = (node: Node, sourceFile: SourceFile): { type: HandlerType; steps: ChainStep[] } | undefined => {
  const steps: ChainStep[] = [];
  let current = node;

  while (current.getKind() === SyntaxKind.CallExpression) {
    const call = current as CallExpression;
    const expr = call.getExpression();
    const args = call.getArguments();

    if (expr.getKind() === SyntaxKind.PropertyAccessExpression) {
      const propAccess = expr.asKindOrThrow(SyntaxKind.PropertyAccessExpression);
      steps.unshift({ method: propAccess.getName(), args: [...args] });
      current = propAccess.getExpression();
    } else {
      const fnName = bareName(expr.getText());
      const type = resolveDefineFn(sourceFile, fnName);

      if (type) {
        steps.unshift({ method: fnName, args: [...args] });
        return { type, steps };
      }

      // Factory pattern: defineApp()(options)
      if (expr.getKind() === SyntaxKind.CallExpression) {
        const innerCall = expr as CallExpression;
        const innerFnName = bareName(innerCall.getExpression().getText());
        const innerType = resolveDefineFn(sourceFile, innerFnName);
        if (innerType) {
          steps.unshift({ method: innerFnName, args: [...args] });
          return { type: innerType, steps };
        }
      }

      return undefined;
    }
  }

  return undefined;
};

const resolveDefineFn = (sourceFile: SourceFile, fnName: string): HandlerType | undefined => {
  for (const imp of sourceFile.getImportDeclarations()) {
    if (imp.getModuleSpecifierValue() !== "effortless-aws") continue;
    for (const spec of imp.getNamedImports()) {
      const importedName = spec.getName();
      const localName = spec.getAliasNode()?.getText() ?? importedName;
      if (localName === fnName && defineFnToType[importedName]) {
        return defineFnToType[importedName];
      }
    }
  }
  return undefined;
};

// ============ Extractors ============

const extractStaticConfig = (arg: Node | undefined): Record<string, unknown> => {
  if (!arg || arg.getKind() !== SyntaxKind.ObjectLiteralExpression) return {};

  const objLit = arg as ObjectLiteralExpression;
  const props = objLit.getProperties().filter(p => {
    if (p.getKind() === SyntaxKind.PropertyAssignment) {
      const init = (p as PropertyAssignment).getInitializer();
      if (!init) return true;
      return init.getKind() !== SyntaxKind.ArrowFunction
        && init.getKind() !== SyntaxKind.FunctionExpression;
    }
    return true;
  });

  if (props.length === 0) return {};

  const text = "({" + props.map(p => p.getText()).join(",") + "})";
  try {
    return new Function(`return ${text}`)() as Record<string, unknown>;
  } catch {
    return {};
  }
};

const extractDepsKeys = (arg: Node): string[] => {
  const objLit = findObjectLiteralInFnBody(arg);
  if (!objLit) return [];

  return objLit.getProperties()
    .map(p => {
      if (p.getKind() === SyntaxKind.ShorthandPropertyAssignment) return (p as ShorthandPropertyAssignment).getName();
      if (p.getKind() === SyntaxKind.PropertyAssignment) return (p as PropertyAssignment).getName();
      return "";
    })
    .filter(Boolean);
};

const findObjectLiteralInFnBody = (node: Node): ObjectLiteralExpression | undefined => {
  if (node.getKind() === SyntaxKind.ArrowFunction) {
    const body = node.asKindOrThrow(SyntaxKind.ArrowFunction).getBody();
    if (body.getKind() === SyntaxKind.ParenthesizedExpression) {
      const inner = body.asKindOrThrow(SyntaxKind.ParenthesizedExpression).getExpression();
      if (inner.getKind() === SyntaxKind.ObjectLiteralExpression) return inner as ObjectLiteralExpression;
    }
    if (body.getKind() === SyntaxKind.Block) {
      const returnStmt = body.asKindOrThrow(SyntaxKind.Block).getStatements()
        .find(s => s.getKind() === SyntaxKind.ReturnStatement);
      if (returnStmt) {
        const expr = returnStmt.asKindOrThrow(SyntaxKind.ReturnStatement).getExpression();
        if (expr?.getKind() === SyntaxKind.ObjectLiteralExpression) return expr as ObjectLiteralExpression;
      }
    }
    if (body.getKind() === SyntaxKind.ObjectLiteralExpression) return body as ObjectLiteralExpression;
  }
  if (node.getKind() === SyntaxKind.FunctionExpression) {
    const body = node.asKindOrThrow(SyntaxKind.FunctionExpression).getBody();
    if (body.getKind() === SyntaxKind.Block) {
      const returnStmt = body.asKindOrThrow(SyntaxKind.Block).getStatements()
        .find((s: Node) => s.getKind() === SyntaxKind.ReturnStatement);
      if (returnStmt) {
        const expr = returnStmt.asKindOrThrow(SyntaxKind.ReturnStatement).getExpression();
        if (expr?.getKind() === SyntaxKind.ObjectLiteralExpression) return expr as ObjectLiteralExpression;
      }
    }
  }
  return undefined;
};

const extractSecretEntries = (arg: Node): SecretEntry[] => {
  let bodyText: string | undefined;

  if (arg.getKind() === SyntaxKind.ArrowFunction) {
    const arrow = arg.asKindOrThrow(SyntaxKind.ArrowFunction);
    const body = arrow.getBody();
    if (body.getKind() === SyntaxKind.ParenthesizedExpression) {
      bodyText = body.asKindOrThrow(SyntaxKind.ParenthesizedExpression).getExpression().getText();
    } else if (body.getKind() === SyntaxKind.Block) {
      const returnStmt = body.asKindOrThrow(SyntaxKind.Block).getStatements()
        .find(s => s.getKind() === SyntaxKind.ReturnStatement);
      if (returnStmt) bodyText = returnStmt.asKindOrThrow(SyntaxKind.ReturnStatement).getExpression()?.getText();
    }
  }

  if (!bodyText) return [];

  try {
    const mockDefineSecret = (opts?: { key?: string; generate?: string }) => ({
      __brand: "effortless-secret" as const,
      ...(opts?.key ? { key: opts.key } : {}),
      ...(opts?.generate ? { generate: opts.generate } : {}),
    });

    const result = new Function("defineSecret", `return ${bodyText}`)(mockDefineSecret) as Record<string, unknown>;

    const entries: SecretEntry[] = [];
    for (const [propName, ref] of Object.entries(result)) {
      if (ref && typeof ref === "object" && (ref as any).__brand === "effortless-secret") {
        const secretRef = ref as { key?: string; generate?: string };
        const ssmKey = secretRef.key ?? toKebabCase(propName);
        entries.push({ propName, ssmKey, ...(secretRef.generate ? { generate: secretRef.generate } : {}) });
      }
    }
    return entries;
  } catch {
    return [];
  }
};

const extractLambdaOptions = (args: Node[]): Record<string, unknown> | undefined => {
  if (args.length === 0) return undefined;
  const firstArg = args[0]!;

  if (firstArg.getKind() === SyntaxKind.ObjectLiteralExpression) return extractStaticConfig(firstArg);

  if (args.length >= 2 && (firstArg.getKind() === SyntaxKind.ArrowFunction || firstArg.getKind() === SyntaxKind.FunctionExpression)) {
    const secondArg = args[1]!;
    if (secondArg.getKind() === SyntaxKind.ObjectLiteralExpression) return extractStaticConfig(secondArg);
  }

  return undefined;
};

const extractRoutePattern = (args: Node[]): { path: string } | undefined => {
  if (args.length === 0) return undefined;
  const defArg = args[0]!;
  if (defArg.getKind() !== SyntaxKind.ObjectLiteralExpression) return undefined;

  const objLit = defArg as ObjectLiteralExpression;
  for (const p of objLit.getProperties()) {
    if (p.getKind() === SyntaxKind.PropertyAssignment) {
      const prop = p as PropertyAssignment;
      if (prop.getName() === "path") {
        const init = prop.getInitializer();
        if (init?.getKind() === SyntaxKind.StringLiteral) {
          return { path: init.asKindOrThrow(SyntaxKind.StringLiteral).getLiteralValue() };
        }
      }
    }
  }
  return undefined;
};

const extractStaticSiteRoute = (args: Node[]): { pattern: string; originName: string; access?: string } | undefined => {
  if (args.length < 2) return undefined;

  const patternArg = args[0]!;
  if (patternArg.getKind() !== SyntaxKind.StringLiteral) return undefined;
  const pattern = patternArg.asKindOrThrow(SyntaxKind.StringLiteral).getLiteralValue();

  const originName = args[1]!.getText();

  let access: string | undefined;
  if (args.length >= 3) {
    const optsArg = args[2]!;
    if (optsArg.getKind() === SyntaxKind.ObjectLiteralExpression) {
      for (const p of (optsArg as ObjectLiteralExpression).getProperties()) {
        if (p.getKind() === SyntaxKind.PropertyAssignment && (p as PropertyAssignment).getName() === "access") {
          const init = (p as PropertyAssignment).getInitializer();
          if (init?.getKind() === SyntaxKind.StringLiteral) access = init.asKindOrThrow(SyntaxKind.StringLiteral).getLiteralValue();
        }
      }
    }
  }

  return { pattern, originName, ...(access ? { access } : {}) };
};

// ============ Chain analysis ============

const API_ROUTE_METHODS = new Set(["get", "post", "put", "patch", "delete"]);
const MCP_ENTRY_METHODS = new Set(["tool", "resource", "prompt"]);

type ExportedChain = { exportName: string; type: HandlerType; steps: ChainStep[] };

const findExportedChains = (sourceFile: SourceFile): ExportedChain[] => {
  const results: ExportedChain[] = [];

  for (const stmt of sourceFile.getVariableStatements()) {
    if (!stmt.isExported()) continue;
    for (const decl of stmt.getDeclarations()) {
      const init = decl.getInitializer();
      if (!init) continue;
      const chain = walkChain(init, sourceFile);
      if (chain) results.push({ exportName: decl.getName(), ...chain });
    }
  }

  const def = sourceFile.getExportAssignment(e => !e.isExportEquals());
  if (def) {
    const chain = walkChain(def.getExpression(), sourceFile);
    if (chain) results.push({ exportName: "default", ...chain });
  }

  return results;
};

const isFinalized = (type: HandlerType, steps: ChainStep[]): boolean => {
  if (type === "app" || type === "mailer") return true;

  const def = handlers[type];
  for (const step of steps) {
    if (def.handlerProps.length > 0 && (def.handlerProps as readonly string[]).includes(step.method)) return true;
    if (type === "api" && API_ROUTE_METHODS.has(step.method)) return true;
    if (type === "mcp" && MCP_ENTRY_METHODS.has(step.method)) return true;
    if (step.method === "build") return true;
  }
  return false;
};

const processChain = (
  exportName: string,
  type: HandlerType,
  steps: ChainStep[],
  sourceFile: SourceFile,
): ExtractedConfig<any> => {
  const def = handlers[type];
  const rootStep = steps[0]!;
  let config = extractStaticConfig(rootStep.args[0]) as Record<string, unknown>;

  let depsKeys: string[] = [];
  let secretEntries: SecretEntry[] = [];
  const staticGlobs: string[] = [];
  const routePatterns: string[] = [];
  const apiRoutes: ApiRouteEntry[] = [];
  const bucketRoutes: BucketRouteEntry[] = [];
  let hasHandler = false;

  for (let i = 1; i < steps.length; i++) {
    const step = steps[i]!;

    switch (step.method) {
      case "deps":
        if (step.args[0]) depsKeys = extractDepsKeys(step.args[0]);
        break;

      case "config":
        if (step.args[0]) secretEntries = extractSecretEntries(step.args[0]);
        break;

      case "include":
        if (step.args[0]?.getKind() === SyntaxKind.StringLiteral) {
          staticGlobs.push(step.args[0].asKindOrThrow(SyntaxKind.StringLiteral).getLiteralValue());
        }
        break;

      case "setup": {
        const lambdaOpts = extractLambdaOptions(step.args);
        if (lambdaOpts && Object.keys(lambdaOpts).length > 0) {
          config = { ...config, lambda: { ...(config.lambda as Record<string, unknown> ?? {}), ...lambdaOpts } };
        }
        break;
      }

      case "route": {
        const route = extractStaticSiteRoute(step.args);
        if (route) {
          routePatterns.push(route.pattern);
          apiRoutes.push({ pattern: route.pattern, handlerExport: route.originName, access: route.access as "private" | "public" | undefined });
        }
        break;
      }

      case "build":
      case "middleware":
        if (step.method === "middleware") hasHandler = true;
        break;

      default:
        if ((def.handlerProps as readonly string[]).includes(step.method)) hasHandler = true;
        if (type === "api" && API_ROUTE_METHODS.has(step.method)) {
          hasHandler = true;
          const route = extractRoutePattern(step.args);
          if (route) routePatterns.push(`${step.method.toUpperCase()} ${route.path}`);
        }
        if (type === "mcp" && MCP_ENTRY_METHODS.has(step.method)) hasHandler = true;
        break;
    }
  }

  return { exportName, config, hasHandler, depsKeys, secretEntries, staticGlobs, routePatterns, apiRoutes, bucketRoutes };
};

// ============ Internal: identifier resolution ============

const resolveIdentifierToExport = (
  name: string,
  sourceFile: SourceFile,
  allExports: Map<string, { type: HandlerType; exportName: string }>,
): string => {
  if (allExports.has(name)) return name;

  for (const imp of sourceFile.getImportDeclarations()) {
    if (imp.getModuleSpecifierValue() === "effortless-aws") continue;

    for (const spec of imp.getNamedImports()) {
      const localName = spec.getAliasNode()?.getText() ?? spec.getName();
      if (localName === name) {
        const importedName = spec.getName();
        if (allExports.has(importedName)) return importedName;
      }
    }

    const defaultImport = imp.getDefaultImport();
    if (defaultImport?.getText() === name && allExports.has("default")) return "default";
  }

  return name;
};
