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
  // The viewer adds only its CSP meta (tests/html-viewer-csp.test.mjs).
  assert.equal(
    frame.srcdoc.replace(/<meta http-equiv="Content-Security-Policy" content="[^"]*">/, ""),
    html,
  );
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

test("showHtmlViewer does not rewrite srcdoc when the HTML is unchanged", () => {
  const frame = el("html-viewer");
  htmlJs.enabled = false;
  let writes = 0;
  let current = frame.srcdoc;
  Object.defineProperty(frame, "srcdoc", {
    configurable: true,
    get() {
      return current;
    },
    set(value) {
      writes += 1;
      current = value;
    },
  });
  showHtmlViewer("<p>stable</p>");
  const afterOpen = writes;
  assert.ok(afterOpen >= 1, "first showHtmlViewer must assign srcdoc");
  showHtmlViewer("<p>stable</p>");
  assert.equal(
    writes,
    afterOpen,
    "re-showing the same HTML must not assign srcdoc again (iframe reload flickers the preview)",
  );
  showHtmlViewer("<p>changed</p>");
  assert.equal(writes, afterOpen + 1, "changed HTML must still update srcdoc");
});

// Every srcdoc assignment navigates the iframe, even to the same value.
function countSrcdocWrites(frame) {
  const counter = { writes: 0 };
  let current = frame.srcdoc;
  Object.defineProperty(frame, "srcdoc", {
    configurable: true,
    get() {
      return current;
    },
    set(value) {
      counter.writes += 1;
      current = value;
    },
  });
  return counter;
}

test("showHtmlViewer compares the HTML with line endings normalized", () => {
  const frame = el("html-viewer");
  htmlJs.enabled = false;
  const counter = countSrcdocWrites(frame);
  showHtmlViewer("<p>a</p>\r\n<p>b</p>\r\n");
  const afterOpen = counter.writes;
  showHtmlViewer("<p>a</p>\n<p>b</p>\n");
  assert.equal(
    counter.writes,
    afterOpen,
    "the editor's LF copy of a CRLF file is the same document; reloading it flickers",
  );
  showHtmlViewer("<p>a</p>\n<p>c</p>\n");
  assert.equal(counter.writes, afterOpen + 1, "a real change still reloads");
});

test("hideHtmlViewer assigns srcdoc only when there is something to clear", () => {
  const frame = el("html-viewer");
  showHtmlViewer("<p>shown</p>");
  const counter = countSrcdocWrites(frame);
  hideHtmlViewer();
  assert.equal(counter.writes, 1, "hiding a shown document clears it once");
  assert.equal(frame.srcdoc, "");
  hideHtmlViewer();
  hideHtmlViewer();
  assert.equal(
    counter.writes,
    1,
    "every Markdown render calls hideHtmlViewer; an empty frame must not be navigated again",
  );
});

test("HTML viewer CSS isolates the iframe from sibling explorer paints", () => {
  const htmlPath = join(fixturesDir, "..", "..", "src", "index.html");
  const html = readFileSync(htmlPath, "utf8");
  const css = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)]
    .map((m) => m[1])
    .join("\n");
  assert.match(
    css,
    /#html-viewer\s*\{[^}]*(?:isolation\s*:\s*isolate|transform\s*:\s*translateZ\(\s*0\s*\)|contain\s*:\s*(?:paint|layout|strict))/i,
    "#html-viewer must be composited separately so explorer :hover paints cannot flicker the iframe",
  );
  assert.match(
    css,
    /#explorer\s*\{[^}]*contain\s*:\s*paint|#preview\s*\{[^}]*(?:isolation\s*:\s*isolate|contain\s*:\s*paint)/i,
    "explorer/preview must contain paints so hovering file rows does not invalidate the HTML iframe",
  );
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
