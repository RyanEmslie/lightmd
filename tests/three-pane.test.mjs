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

test("no editor tabs", () => {
  const html = loadHtml();
  assert.equal(/\brole=["']tab(?:list)?["']/.test(html), false, "no editor tabs");
  assert.equal(/\bid=["']tabs["']/.test(html), false, "no editor tabs");
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
