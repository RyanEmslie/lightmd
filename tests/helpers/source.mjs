import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const helperDir = dirname(fileURLToPath(import.meta.url));
export const testsDir = join(helperDir, "..");
export const root = join(helperDir, "..", "..");
export const srcDir = join(root, "src");
export const fixturesDir = join(testsDir, "fixtures");

const SOURCE_EXT = /\.(html|js|mjs|cjs|ts|css)$/i;

export function collectFiles(dir, acc = [], { skipBundle = true } = {}) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) {
      collectFiles(p, acc, { skipBundle });
      continue;
    }
    if (skipBundle && ent.name === "editor.bundle.js") continue;
    acc.push(p);
  }
  return acc;
}

export function readSourceFiles(dir = srcDir, { skipBundle = true } = {}) {
  const chunks = [];
  for (const p of collectFiles(dir, [], { skipBundle })) {
    if (SOURCE_EXT.test(p)) {
      chunks.push({ path: p, text: readFileSync(p, "utf8") });
    }
  }
  return chunks;
}

export function loadSourceFiles(dir = srcDir, opts = {}) {
  assert.equal(existsSync(dir), true, "src/ must exist");
  const files = readSourceFiles(dir, opts);
  assert.ok(files.length > 0, "src/ must contain editor source");
  return files;
}

export function loadSourceText(dir = srcDir, opts = {}) {
  return loadSourceFiles(dir, opts)
    .map((f) => f.text)
    .join("\n");
}

export function loadHtml() {
  const htmlPath = join(srcDir, "index.html");
  assert.equal(existsSync(htmlPath), true, "src/index.html must exist");
  return readFileSync(htmlPath, "utf8");
}

export function inlineScripts(html = loadHtml()) {
  const out = [];
  const re = /<script\b(?![^>]*\bsrc\b)[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) out.push(m[1]);
  return out;
}
