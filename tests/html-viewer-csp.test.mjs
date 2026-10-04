import assert from "node:assert/strict";
import { test } from "node:test";
import { mockEl } from "./helpers/dom.mjs";

// sandbox="" stops scripts but not images, stylesheets, fonts or frames, so
// the srcdoc carries its own CSP. tests/e2e/html-viewer.test.mjs checks that
// WebKit then makes no request.

const byId = new Map();
for (const [id, tag] of Object.entries({
  "html-viewer": "iframe",
  "html-js": "input",
  "html-js-warn": "div",
  "html-js-chrome": "div",
  "preview-body": "div",
})) {
  byId.set(id, mockEl(id, tag));
}
byId.get("html-js").checked = false;

globalThis.document = {
  getElementById(id) {
    return byId.get(String(id)) ?? null;
  },
  createElement(tag) {
    return mockEl("", tag);
  },
};
globalThis.window = globalThis;

const { showHtmlViewer, hideHtmlViewer, setHtmlJsEnabled } = await import(
  "../src/html-viewer.js"
);

const frame = byId.get("html-viewer");
const POLICY =
  "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; media-src data:; form-action 'none'";
const META = `<meta http-equiv="Content-Security-Policy" content="${POLICY}">`;
const META_JS = `<meta http-equiv="Content-Security-Policy" content="${POLICY}; script-src 'unsafe-inline'">`;

test("the srcdoc starts with a CSP that blocks remote images, styles, fonts, media and frames", () => {
  hideHtmlViewer();
  const html = '<h1>Doc</h1>\n<img src="http://127.0.0.1:47811/pixel.gif">';
  showHtmlViewer(html);
  assert.equal(frame.srcdoc, META + html);
  assert.equal(frame.getAttribute("sandbox"), "");
});

test("a leading doctype stays first so the page keeps standards mode", () => {
  hideHtmlViewer();
  showHtmlViewer("<!DOCTYPE html>\n<html><head><title>t</title></head></html>");
  assert.equal(
    frame.srcdoc,
    `<!DOCTYPE html>${META}\n<html><head><title>t</title></head></html>`,
  );
  hideHtmlViewer();
  showHtmlViewer("\n  <!doctype html><p>x</p>");
  assert.equal(frame.srcdoc, `\n  <!doctype html>${META}<p>x</p>`);
});

test("the CSP allows inline scripts only while JavaScript is on for the file", () => {
  hideHtmlViewer();
  const html = "<p id=out></p><script>out.textContent = 'ran'</script>";
  showHtmlViewer(html);
  assert.equal(frame.srcdoc, META + html, "JS off: no script-src");
  setHtmlJsEnabled(true);
  assert.equal(frame.getAttribute("sandbox"), "allow-scripts");
  assert.equal(frame.srcdoc, META_JS + html, "JS on: inline scripts only, still no remote loads");
  setHtmlJsEnabled(false);
  assert.equal(frame.getAttribute("sandbox"), "");
  assert.equal(frame.srcdoc, META + html, "JS off again: the document reloads without script-src");
});
