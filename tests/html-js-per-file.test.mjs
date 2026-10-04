import assert from "node:assert/strict";
import { test } from "node:test";
import { memoryStorage, mockEl } from "./helpers/dom.mjs";

// "Enable JavaScript" applies to the file on screen and lives in memory only:
// a hostile page that hangs the app must not come back on the next launch.

const byId = new Map();
for (const [id, tag] of Object.entries({
  "html-viewer": "iframe",
  "html-js": "input",
  "html-js-warn": "div",
  "html-js-chrome": "div",
  "settings-html-js": "input",
  "preview-body": "div",
})) {
  byId.set(id, mockEl(id, tag));
}
const el = (id) => byId.get(id);
el("html-js").checked = false;
el("settings-html-js").checked = false;

const storage = memoryStorage();
globalThis.localStorage = storage;
globalThis.document = {
  getElementById(id) {
    return byId.get(String(id)) ?? null;
  },
  createElement(tag) {
    return mockEl("", tag);
  },
};
globalThis.window = globalThis;

const { showHtmlViewer, hideHtmlViewer, setHtmlJsEnabled, htmlJs } = await import(
  "../src/html-viewer.js"
);
const { persistSession, restoreSession, getSession } = await import("../src/session.js");

function openFile(relative, html = `<p>${relative}</p>`) {
  globalThis.lightmdWorkspace = { path: "/ws", relative, contents: html };
  showHtmlViewer(html);
}

function assertJsOff(message) {
  assert.equal(htmlJs.enabled, false, message);
  assert.equal(el("html-viewer").getAttribute("sandbox"), "", `${message}: sandbox`);
  assert.doesNotMatch(el("html-viewer").srcdoc, /script-src/, `${message}: CSP`);
  assert.equal(el("html-js").checked, false, `${message}: viewer checkbox`);
  assert.equal(el("settings-html-js").checked, false, `${message}: Settings checkbox`);
  assert.equal(el("html-js-warn").hidden, true, `${message}: warning`);
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("JavaScript stays on while the same file re-renders", () => {
  openFile("a.html");
  setHtmlJsEnabled(true);
  openFile("a.html", "<p>a.html edited</p>");
  assert.equal(htmlJs.enabled, true);
  assert.equal(el("html-viewer").getAttribute("sandbox"), "allow-scripts");
  assert.equal(el("settings-html-js").checked, true, "Settings mirrors the file's toggle");
});

test("opening another HTML file starts with JavaScript off", () => {
  openFile("a.html");
  setHtmlJsEnabled(true);
  openFile("b.html");
  assertJsOff("b.html must not inherit a.html's JavaScript");
});

test("leaving the HTML file and coming back starts with JavaScript off", () => {
  openFile("a.html");
  setHtmlJsEnabled(true);
  hideHtmlViewer();
  assert.equal(htmlJs.enabled, false, "hiding the viewer turns JavaScript off");
  openFile("a.html");
  assertJsOff("a.html after a Markdown file");
});

test("the toggle never writes the session", async () => {
  storage.clear();
  openFile("a.html");
  setHtmlJsEnabled(false);
  el("html-js").click();
  await settle();
  assert.equal(htmlJs.enabled, true, "the viewer checkbox turns JavaScript on");
  persistSession({ htmlJs: true, htmlJsEnabled: true, theme: "Monokai" });
  await settle();
  const stored = JSON.parse(storage.getItem("lightmd.session") ?? "{}");
  assert.equal("htmlJs" in stored, false, `stored session: ${JSON.stringify(stored)}`);
  assert.equal("htmlJsEnabled" in stored, false);
  assert.equal(stored.theme, "Monokai", "other fields still persist");
  setHtmlJsEnabled(false);
});

test("restore ignores htmlJs saved by older versions", async () => {
  hideHtmlViewer();
  storage.clear();
  storage.setItem(
    "lightmd.session",
    JSON.stringify({ restore: true, theme: "Monokai", htmlJs: true, htmlJsEnabled: true }),
  );
  await restoreSession();
  assert.equal(htmlJs.enabled, false);
  assert.notEqual(getSession().htmlJs, true);
  openFile("page.html");
  assertJsOff("the first HTML file after a relaunch");
});
