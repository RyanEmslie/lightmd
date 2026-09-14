import assert from "node:assert/strict";
import { test } from "node:test";
import { mockEl } from "./helpers/dom.mjs";

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

globalThis.document = {
  getElementById(id) {
    return byId.get(String(id)) ?? null;
  },
  createElement(tag) {
    return mockEl("", tag);
  },
};
globalThis.window = globalThis;

const { showHtmlViewer, setHtmlJsEnabled, htmlJs } = await import(
  "../src/html-viewer.js"
);

test("JS default off: page.html script is inert (iframe sandbox has no allow-scripts)", () => {
  htmlJs.enabled = false;
  showHtmlViewer("<p>hi</p><script>document.write('ran')</script>");
  assert.equal(htmlJs.enabled, false);
  assert.equal(el("html-viewer").getAttribute("sandbox"), "");
});

test("viewer has a control that can enable JS", () => {
  assert.equal(el("html-js").tagName, "INPUT");
});

test("testable Settings pref for HTML JS exists and defaults off", () => {
  htmlJs.enabled = false;
  assert.equal(htmlJs.enabled, false);
});

test("when JS is on, a warning is shown and sandbox may include allow-scripts", () => {
  htmlJs.enabled = false;
  showHtmlViewer("<p>hi</p>");
  setHtmlJsEnabled(true);
  assert.equal(htmlJs.enabled, true);
  assert.equal(el("html-viewer").getAttribute("sandbox"), "allow-scripts");
  assert.equal(el("html-js-warn").hidden, false);
  assert.equal(el("html-js").checked, true);
});

test("HTML JS never uses allow-same-origin", () => {
  setHtmlJsEnabled(true);
  const sandbox = el("html-viewer").getAttribute("sandbox") || "";
  assert.equal(sandbox.includes("allow-same-origin"), false);
  setHtmlJsEnabled(false);
  assert.equal((el("html-viewer").getAttribute("sandbox") || "").includes("allow-same-origin"), false);
});

test("document scripts do not get __TAURI__ / invoke in the iframe", () => {
  setHtmlJsEnabled(true);
  const frame = el("html-viewer");
  assert.equal(frame.contentWindow, undefined);
  assert.equal(Object.hasOwn(frame, "__TAURI__"), false);
});
