import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(root, "src");

function collectSource(dir) {
  const chunks = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) {
      chunks.push(...collectSource(p));
      continue;
    }
    if (ent.name === "editor.bundle.js") continue;
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

function hasSaveAction(src) {
  if (/\bid=["']save(?:[-_](?:file|button|action|doc|buffer))?["']/i.test(src)) {
    return true;
  }
  if (/\.id\s*=\s*["']save(?:[-_](?:file|button|action|doc|buffer))?["']/i.test(src)) {
    return true;
  }
  if (
    /getElementById\(\s*["']save(?:[-_](?:file|button|action|doc|buffer))?["']\s*\)/.test(
      src,
    )
  ) {
    return true;
  }
  if (/<button\b[^>]*>[\s\S]{0,80}?\bsave\b[\s\S]{0,80}?<\/button>/i.test(src)) {
    return true;
  }
  if (
    /createElement\(\s*["']button["']\)[\s\S]{0,200}?(?:textContent|innerText|innerHTML)\s*=\s*["'][^"']*\bsave\b/i.test(
      src,
    )
  ) {
    return true;
  }
  return false;
}

function hasAccentDirtyDot(src) {
  if (!/\bdirty\b/i.test(src)) return false;
  if (!/--accent/.test(src)) return false;
  return (
    /dirty[-_ ]?dot/i.test(src) ||
    /\bid=["'][^"']*dirty[^"']*["']/i.test(src) ||
    /\.id\s*=\s*["'][^"']*dirty[^"']*["']/i.test(src) ||
    /class=["'][^"']*\bdirty\b/i.test(src) ||
    /classList\.(?:add|toggle)\(\s*["'][^"']*dirty/i.test(src) ||
    /#dirty\b/.test(src) ||
    /\bstatus\b[\s\S]{0,200}\bdirty\b|\bdirty\b[\s\S]{0,200}\bstatus\b/i.test(src)
  );
}

function saveWritesAndClearsDirty(src) {
  const writes =
    /invoke\(\s*["'](?:write_workspace_file|write_file|write)["']/.test(src);
  const clears =
    /dirty\s*=\s*false/.test(src) ||
    /setDirty\(\s*false\s*\)/.test(src) ||
    /classList\.remove\(\s*["'][^"']*dirty/.test(src) ||
    /(?:dataset\.dirty|data-dirty)\s*=\s*["'](?:false)?["']/.test(src) ||
    /getElementById\(\s*["'][^"']*dirty[^"']*["']\s*\)[\s\S]{0,120}?(?:hidden\s*=\s*true|remove\(\)|display\s*=\s*["']none["'])/.test(
      src,
    ) ||
    /#dirty[\s\S]{0,80}(?:hidden|display:\s*none)/.test(src);
  return writes && clears;
}

test("chrome has a Save action (button#save or similar)", () => {
  const src = loadSources();
  assert.ok(
    hasSaveAction(src),
    "missing Save action (button#save or similar)",
  );
});

test("dirty indicator is an accent dirty dot using --accent, not decoration", () => {
  const src = loadSources();
  assert.ok(
    hasAccentDirtyDot(src),
    "missing dirty indicator: accent dirty dot using --accent (dot/status)",
  );
});

test("Save writes the editor buffer and clears dirty", () => {
  const src = loadSources();
  assert.ok(
    saveWritesAndClearsDirty(src),
    "Save must invoke write / write_file / write_workspace_file and clear dirty",
  );
});
