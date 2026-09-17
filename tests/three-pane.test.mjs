import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const htmlPath = join(root, "src", "index.html");
const confPath = join(root, "src-tauri", "tauri.conf.json");

function loadHtml() {
  assert.equal(existsSync(htmlPath), true, "src/index.html must exist");
  return readFileSync(htmlPath, "utf8");
}

function paneTag(html, id) {
  return html.match(new RegExp(`<[^>]*\\bid=["']${id}["'][^>]*>`));
}

test("three visible panes: explorer | editor | preview", () => {
  const html = loadHtml();
  const ids = ["explorer", "editor", "preview"];
  const indexes = [];

  for (const id of ids) {
    const tag = paneTag(html, id);
    assert.ok(tag, `missing pane #${id}`);
    assert.equal(/\bhidden\b/.test(tag[0]), false, `#${id} must be visible`);
    assert.equal(
      /display\s*:\s*none/i.test(tag[0]),
      false,
      `#${id} must be visible`,
    );
    indexes.push(html.indexOf(tag[0]));
  }

  assert.ok(
    indexes[0] < indexes[1] && indexes[1] < indexes[2],
    "panes must be explorer | editor | preview",
  );
});

test("default columns 240px 1fr 1fr", () => {
  const html = loadHtml();
  assert.match(
    html,
    /grid-template-columns\s*:\s*240px\s+1fr\s+1fr/,
    "default columns must be 240px 1fr 1fr",
  );
});

test("pane min-width 160px", () => {
  const html = loadHtml();
  assert.match(html, /min-width\s*:\s*160px/, "pane min-width must be 160px");
});

test("1px splitters using --border", () => {
  const html = loadHtml();
  const splitters = [
    ...(html.match(/class=["'][^"']*\bsplitter\b[^"']*["']/g) ?? []),
    ...(html.match(/role=["']separator["']/g) ?? []),
  ];
  assert.ok(splitters.length >= 2, "two 1px splitters required between panes");
  assert.match(html, /(?:width|border(?:-right|-left)?)\s*:\s*1px/, "splitters must be 1px");
  assert.match(html, /var\(--border\)/, "splitters must use --border");
});

test("settings and preview chrome sit in explorer; editor and preview meet the shell top", () => {
  const html = loadHtml();
  const explorer = html.match(
    /<aside\b[^>]*\bid=["']explorer["'][^>]*>[\s\S]*?<\/aside>/i,
  );
  assert.ok(explorer, "missing #explorer");
  assert.match(
    explorer[0],
    /\bid=["']layout-bar["']/,
    "settings/preview chrome (#layout-bar) must live in #explorer, not as a full-width bar above the shell",
  );
  assert.match(
    explorer[0],
    /\bid=["']settings-open["']/,
    "#settings-open must sit above the navigation, inside #explorer",
  );
  assert.match(
    explorer[0],
    /\bid=["']toggle-preview["']/,
    "#toggle-preview must sit above the navigation, inside #explorer",
  );

  const shellIdx = html.search(/\bid=["']shell["']/i);
  assert.ok(shellIdx >= 0, "missing #shell");
  const beforeShell = html.slice(0, shellIdx);
  assert.equal(
    /\bid=["']layout-bar["']/.test(beforeShell),
    false,
    "#layout-bar must not precede #shell as window-wide chrome",
  );

  const css = html.replace(/<script[\s\S]*?<\/script>/gi, "");
  assert.match(
    css,
    /#editor\s*,\s*#preview[\s\S]{0,200}?padding(?:-top)?\s*:\s*0/,
    "#editor and #preview must have no top padding so they extend to the top of the page",
  );
  assert.match(
    css,
    /#editor-tabs\s*\{[^}]*margin(?:-top)?\s*:\s*0/,
    "#editor-tabs must sit flush at the top of the editor pane (no negative/offset margin above the page)",
  );
});

test("Cursor-style editor tab strip is allowed in #editor", () => {
  const html = loadHtml();
  assert.equal(/\bid=["']tabs["']/.test(html), false, "use #editor-tabs, not generic #tabs");
  const editor = html.match(
    /<(main|div|section|article)\b[^>]*\bid=["']editor["'][^>]*>[\s\S]*?<\/\1>/i,
  );
  assert.ok(editor, "missing #editor");
  assert.match(
    editor[0],
    /\bid=["']editor-tabs["']|\brole=["']tablist["']/,
    "Cursor-style #editor-tabs (role=tablist) lives in #editor",
  );
  const explorer = html.match(/<aside\b[^>]*\bid=["']explorer["'][^>]*>[\s\S]*?<\/aside>/i);
  if (explorer) {
    assert.equal(
      /\brole=["']tablist["']/.test(explorer[0]),
      false,
      "tab strip must not live in #explorer",
    );
  }
});

test("native title bar (decorations not false)", () => {
  assert.equal(existsSync(confPath), true, "src-tauri/tauri.conf.json must exist");
  const conf = JSON.parse(readFileSync(confPath, "utf8"));
  const decorations = conf.app?.windows?.[0]?.decorations;
  assert.notEqual(
    decorations,
    false,
    "tauri.conf.json must not set decorations false",
  );
});
