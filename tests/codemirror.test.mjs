import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(root, "src");
const pkgPath = join(root, "package.json");

function loadPkg() {
  assert.equal(existsSync(pkgPath), true, "package.json must exist");
  return JSON.parse(readFileSync(pkgPath, "utf8"));
}

function collectSource(dir) {
  const chunks = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) {
      chunks.push(...collectSource(p));
      continue;
    }
    if (/\.(html|js|mjs|cjs|ts|css)$/i.test(ent.name)) {
      chunks.push(readFileSync(p, "utf8"));
    }
  }
  return chunks;
}

function loadSources() {
  assert.equal(existsSync(srcDir), true, "src/ must exist");
  const files = collectSource(srcDir);
  assert.ok(files.length > 0, "src/ must contain editor source");
  return files.join("\n");
}

function assignsFileContentsViaInnerHTML(src) {
  if (
    /\.innerHTML\s*=\s*(?:await\s+)?(?:body|contents|text|markdown|html|data|result|file)/i.test(
      src,
    )
  ) {
    return true;
  }
  if (
    /(?:editor|buffer|view|content|cm|doc|pane)[\s\S]{0,120}?\.innerHTML\s*=/i.test(
      src,
    )
  ) {
    return true;
  }
  return false;
}

test("package.json depends on CodeMirror 6 (@codemirror/view)", () => {
  const pkg = loadPkg();
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  assert.ok(
    "@codemirror/view" in deps,
    "package.json must depend on CodeMirror 6 (@codemirror/view)",
  );
});

test("editor source uses EditorView with lineWrapping on and lineNumbers off", () => {
  const src = loadSources();
  assert.ok(/\bEditorView\b/.test(src), "editor source must use EditorView");
  assert.ok(
    /EditorView\.lineWrapping|\blineWrapping\s*:\s*true\b/.test(src),
    "EditorView must enable lineWrapping",
  );
  const lineNumbersOn = /\blineNumbers\s*\(/.test(src);
  const lineNumbersExplicitOff = /\blineNumbers\s*:\s*false\b/.test(src);
  assert.ok(
    lineNumbersExplicitOff || !lineNumbersOn,
    "lineNumbers must be off",
  );
});

test("editor font is ui-monospace 14px / 1.45", () => {
  const src = loadSources();
  assert.ok(/ui-monospace/.test(src), "editor font must use ui-monospace");
  assert.ok(/14px/.test(src), "editor font-size must be 14px");
  assert.ok(/1\.45/.test(src), "editor line-height must be 1.45");
});

test("file contents must not be assigned via innerHTML (raw HTML in Markdown is not executed)", () => {
  const src = loadSources();
  assert.equal(
    assignsFileContentsViaInnerHTML(src),
    false,
    "file contents must not be assigned via innerHTML (raw HTML in Markdown is not executed)",
  );
});
