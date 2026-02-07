import { Project, SyntaxKind, type ObjectLiteralExpression, type PropertyAssignment } from "ts-morph";

// ============ Shared utilities ============

const parseSource = (source: string) => {
  const project = new Project({ useInMemoryFileSystem: true });
  return project.createSourceFile("input.ts", source);
};

const RUNTIME_PROPS = ["onRequest", "onRecord", "onBatchComplete", "context"];

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

// ============ Handler Registry ============

export type HandlerDefinition = {
  defineFn: string;
  handlerProp: string;
  wrapperFn: string;
};

export const handlerRegistry = {
  http: {
    defineFn: "defineHttp",
    handlerProp: "onRequest",
    wrapperFn: "wrapHttp",
    wrapperPath: "~/runtime/wrap-http",
  },
  table: {
    defineFn: "defineTable",
    handlerProp: "onRecord",
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
};

export const extractHandlerConfigs = <T>(source: string, type: HandlerType): ExtractedConfig<T>[] => {
  const { defineFn, handlerProp } = handlerRegistry[type];
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
          const hasHandler = extractPropertyFromObject(objLiteral, handlerProp) !== undefined;
          results.push({ exportName: "default", config: configObj, hasHandler });
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
        const hasHandler = extractPropertyFromObject(objLiteral, handlerProp) !== undefined;
        results.push({ exportName: decl.getName(), config: configObj, hasHandler });
      }
    });
  });

  return results;
};

// ============ Entry point generation ============

export const generateEntryPoint = (
  sourcePath: string,
  exportName: string,
  type: HandlerType
): string => {
  const { wrapperFn, wrapperPath } = handlerRegistry[type];

  const importName = exportName === "default" ? "__handler" : exportName;
  const importStmt = exportName === "default"
    ? `import __handler from "${sourcePath}";`
    : `import { ${exportName} } from "${sourcePath}";`;

  return `${importStmt}
import { ${wrapperFn} } from "${wrapperPath}";
export const handler = ${wrapperFn}(${importName});
`;
};
