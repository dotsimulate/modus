import { resolve } from "node:path";

function pathVariants(path: string): string[] {
  const absolute = resolve(path);
  return [...new Set([absolute, absolute.replaceAll("\\", "/")])];
}

/** Replace Bun's generated CommonJS module directories with the bundle's runtime directory. */
export function makeBundlePortable(
  source: string,
  moduleDirectories: string[],
  privateHostPaths: Array<string | undefined>,
): string {
  let portable = source;
  for (const moduleDirectory of moduleDirectories) {
    const declarations = pathVariants(moduleDirectory)
      .map((path) => `var __dirname = ${JSON.stringify(path)};`);
    const matches = declarations.reduce(
      (total, declaration) => total + portable.split(declaration).length - 1,
      0,
    );
    if (matches !== 1) {
      throw new Error(
        `Expected one bundled __dirname declaration for ${moduleDirectory}; found ${matches}`,
      );
    }
    for (const declaration of declarations) {
      portable = portable.replace(declaration, "var __dirname = import.meta.dir;");
    }
  }

  for (const privatePath of privateHostPaths) {
    if (!privatePath?.trim()) continue;
    for (const variant of pathVariants(privatePath)) {
      if (portable.includes(variant) || portable.includes(JSON.stringify(variant).slice(1, -1))) {
        throw new Error(`Bundled JavaScript contains private host path ${privatePath}`);
      }
    }
  }
  return portable;
}
