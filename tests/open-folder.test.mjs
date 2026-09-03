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

function explorerHtml(html) {
  const tagged = html.match(
    /<(aside|div|nav|section)\b[^>]*\bid=["']explorer["'][^>]*>[\s\S]*?<\/\1>/i,
  );
  if (tagged) {
    return tagged[0];
  }
  const start = html.search(/\bid=["']explorer["']/i);
  assert.ok(start >= 0, "missing #explorer");
  return html.slice(start);
}

function hasOpenFolderControl(html) {
  const hasId = /\bid=["']open-?folder["']/i.test(html);
  const hasButton =
    /<button\b[^>]*>[\s\S]{0,80}?open\s+folder[\s\S]{0,80}?<\/button>/i.test(
      html,
    );
  return hasId || hasButton;
}

test("explorer has an Open Folder control (button or id)", () => {
  const explorer = explorerHtml(loadHtml());
  assert.ok(
    hasOpenFolderControl(explorer),
    "explorer must have an Open Folder control (button or id)",
  );
});

test("no create, rename, or delete controls in HTML", () => {
  const html = loadHtml();
  const control = (verb) =>
    new RegExp(
      `<button\\b[^>]*>[^<]*\\b${verb}\\b[^<]*</button>` +
        `|\\bid=["'][^"']*${verb}[^"']*["']` +
        `|aria-label=["'][^"']*\\b${verb}\\b[^"']*["']`,
      "i",
    );

  for (const verb of ["create", "rename", "delete"]) {
    assert.equal(
      control(verb).test(html),
      false,
      `must not expose a ${verb} control`,
    );
  }
});
