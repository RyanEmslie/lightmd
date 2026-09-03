import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const htmlPath = join(root, "src", "index.html");

function loadHtml() {
  assert.equal(existsSync(htmlPath), true, "src/index.html must exist");
  return readFileSync(htmlPath, "utf8");
}

function editorHtml(html) {
  const tagged = html.match(
    /<(main|div|section|article)\b[^>]*\bid=["']editor["'][^>]*>[\s\S]*?<\/\1>/i,
  );
  if (tagged) {
    return tagged[0];
  }
  const start = html.search(/\bid=["']editor["']/i);
  assert.ok(start >= 0, "missing #editor");
  return html.slice(start);
}

test("#editor has a textarea so selecting a file can load it (id editor-buffer ok)", () => {
  const editor = editorHtml(loadHtml());
  const textarea = editor.match(/<textarea\b[^>]*>/i);
  assert.ok(
    textarea,
    "missing textarea in #editor (id editor-buffer ok)",
  );
});

test("no tabs and no second textarea", () => {
  const html = loadHtml();
  const editor = editorHtml(html);

  assert.equal(/\brole=["']tab(?:list)?["']/.test(html), false, "no editor tabs");
  assert.equal(/\bid=["']tabs["']/.test(html), false, "no editor tabs");

  const textareas = editor.match(/<textarea\b/gi) ?? [];
  assert.ok(textareas.length > 0, "missing textarea in #editor");
  assert.equal(textareas.length, 1, "no second textarea");
});
