import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { mockEl } from "./helpers/dom.mjs";
import { fixturesDir } from "./helpers/source.mjs";

const byId = new Map();
const tagById = {
  "html-viewer": "iframe",
  "html-js": "input",
  "html-js-warn": "div",
  "html-js-chrome": "div",
  "preview-body": "div",
};

function el(id) {
  return byId.get(String(id));
}

for (const [id, tag] of Object.entries(tagById)) {
  byId.set(id, mockEl(id, tag));
}
el("html-js").checked = false;
el("html-js-warn").hidden = true;
el("html-viewer").hidden = true;
el("html-js-chrome").hidden = true;

globalThis.document = {
  getElementById(id) {
    return byId.get(String(id)) ?? null;
  },
  createElement(tag) {
    return mockEl("", tag);
  },
};
globalThis.window = globalThis;

const {
  isHtmlFile,
  showHtmlViewer,
  hideHtmlViewer,
  setHtmlJsEnabled,
  htmlJs,
} = await import("../src/html-viewer.js");

function loadPageFixture() {
  const path = join(fixturesDir, "page.html");
  assert.equal(existsSync(path), true, "tests/fixtures/page.html must exist");
  const html = readFileSync(path, "utf8");
  assert.match(html, /<script\b/i);
  assert.match(html, /document\.write/);
  return html;
}

test("fixture page.html (or .htm) has a script that would write to the page if it ran", () => {
  loadPageFixture();
});

test("opening .html/.htm uses a sandboxed viewer with JS off by default", () => {
  htmlJs.enabled = false;
  const html = loadPageFixture();
  showHtmlViewer(html);
  const frame = el("html-viewer");
  assert.equal(isHtmlFile("page.html"), true);
  assert.equal(isHtmlFile("nested/page.htm"), true);
  assert.equal(frame.hidden, false);
  assert.equal(frame.srcdoc, html);
  assert.equal(
    frame.getAttribute("sandbox"),
    "",
    "JS default off: sandbox must not include allow-scripts",
  );
  assert.equal(el("preview-body").hidden, true);
});

test("HTML viewer is not a general-purpose browser", () => {
  assert.equal(globalThis.document.getElementById("address-bar"), null);
  assert.equal(el("html-viewer").tagName, "IFRAME");
});

test("document scripts do not get app file or Node access", () => {
  htmlJs.enabled = false;
  showHtmlViewer(loadPageFixture());
  const frame = el("html-viewer");
  assert.equal(frame.contentWindow, undefined);
  assert.equal(frame.getAttribute("sandbox").includes("allow-same-origin"), false);
  hideHtmlViewer();
  assert.equal(frame.srcdoc, "");
  assert.equal(frame.hidden, true);
});
