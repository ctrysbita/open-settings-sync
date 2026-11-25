import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import { join, resolve } from "node:path";
import { test } from "node:test";
import ts from "typescript";

const srcRoot = resolve(__dirname, "..", "..", "src");
const nodeBuiltins = new Set(builtinModules);

function extractSpecifiers(fileName: string, text: string): string[] {
  const sourceFile = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const specifiers: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteral(node.moduleReference.expression)
    ) {
      specifiers.push(node.moduleReference.expression.text);
    } else if (ts.isCallExpression(node)) {
      const [first] = node.arguments;
      if (first && ts.isStringLiteralLike(first)) {
        if (
          node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && node.expression.text === "require")
        ) {
          specifiers.push(first.text);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return specifiers;
}

async function readImports(directory: string): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
    const text = await readFile(join(directory, entry.name), "utf8");
    result.set(entry.name, extractSpecifiers(entry.name, text));
  }
  return result;
}

test("src/sync remains pure with no Node.js, VS Code, or adapter imports", async () => {
  const imports = await readImports(join(srcRoot, "sync"));
  assert.ok(imports.size > 0);
  for (const [file, specifiers] of imports) {
    for (const specifier of specifiers) {
      assert.ok(
        !specifier.startsWith("node:") &&
          !nodeBuiltins.has(specifier) &&
          specifier !== "vscode" &&
          !specifier.startsWith("../platform") &&
          !specifier.startsWith("../git") &&
          !specifier.startsWith("../storage") &&
          !specifier.startsWith("../editor"),
        `src/sync/${file} must not import "${specifier}"`,
      );
    }
  }
});

test("src/platform depends only on Node.js and src/sync", async () => {
  const imports = await readImports(join(srcRoot, "platform"));
  assert.ok(imports.size > 0);
  for (const [file, specifiers] of imports) {
    for (const specifier of specifiers) {
      assert.ok(
        specifier !== "vscode" &&
          !specifier.startsWith("../editor") &&
          !specifier.startsWith("../git") &&
          !specifier.startsWith("../storage"),
        `src/platform/${file} must not import "${specifier}"`,
      );
    }
  }
});

test("src/git and src/storage stay isolated from each other and from editor adapters", async () => {
  for (const [layer, forbidden] of [
    ["git", "../storage"],
    ["storage", "../git"],
  ] as const) {
    const imports = await readImports(join(srcRoot, layer));
    assert.ok(imports.size > 0);
    for (const [file, specifiers] of imports) {
      for (const specifier of specifiers) {
        assert.ok(
          specifier !== "vscode" &&
            !specifier.startsWith("../editor") &&
            !specifier.startsWith(forbidden),
          `src/${layer}/${file} must not import "${specifier}"`,
        );
      }
    }
  }
});

test("src/editor does not depend back on extension entry wiring", async () => {
  const imports = await readImports(join(srcRoot, "editor"));
  assert.ok(imports.size > 0);
  for (const [file, specifiers] of imports) {
    for (const specifier of specifiers) {
      assert.ok(
        !specifier.startsWith("../extension"),
        `src/editor/${file} must not import "${specifier}"`,
      );
    }
  }
});
