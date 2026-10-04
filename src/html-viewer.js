export function isHtmlFile(relative) {
  const name = String(relative || "").replace(/\\/g, "/");
  const base = name.slice(name.lastIndexOf("/") + 1);
  return /\.(html|htm)$/i.test(base);
}

// Per file and in memory only: never saved, and off whenever another file (or
// the same one after the viewer was hidden) is shown.
export const htmlJs = {
  enabled: false,
};

const ALLOW_SCRIPTS = "allow-scripts";

// sandbox="" stops scripts but not images, stylesheets, fonts or frames, so an
// opened file could reach the network. This policy blocks every remote load.
const VIEWER_CSP =
  "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; media-src data:; form-action 'none'";
const LEADING_DOCTYPE = /^\s*<!doctype[^>]*>/i;

// The CSP meta goes first, after any doctype so the page keeps standards mode.
function withCsp(html) {
  const policy = htmlJs.enabled ? `${VIEWER_CSP}; script-src 'unsafe-inline'` : VIEWER_CSP;
  const meta = `<meta http-equiv="Content-Security-Policy" content="${policy}">`;
  const doctype = LEADING_DOCTYPE.exec(html);
  const at = doctype ? doctype[0].length : 0;
  return html.slice(0, at) + meta + html.slice(at);
}

let lastHtml = "";
let written = "";
let shownFile = null;
let bound = false;

function currentFile() {
  try {
    const ws = globalThis.lightmdWorkspace;
    return ws ? `${ws.path ?? ""}\n${ws.relative ?? ""}` : "";
  } catch {
    return "";
  }
}

function sandboxValue() {
  return htmlJs.enabled ? ALLOW_SCRIPTS : "";
}

function applySandbox(frame) {
  const sandbox = sandboxValue();
  if (frame.getAttribute("sandbox") === sandbox) return;
  frame.setAttribute("sandbox", sandbox);
}

function syncHtmlJsUi() {
  for (const id of ["html-js", "settings-html-js"]) {
    const control = document.getElementById(id);
    if (control && control.checked !== htmlJs.enabled) {
      control.checked = htmlJs.enabled;
    }
  }
  const warn = document.getElementById("html-js-warn");
  if (warn) warn.hidden = !htmlJs.enabled;
}

// Every srcdoc assignment navigates the frame, even to the same value, so
// write only a document that differs from the loaded one.
function writeSrcdoc(frame, value) {
  if (value === written) return;
  frame.srcdoc = value;
  written = value;
}

export function setHtmlJsEnabled(enabled) {
  htmlJs.enabled = !!enabled;
  syncHtmlJsUi();
  const frame = document.getElementById("html-viewer");
  if (!frame) return;
  applySandbox(frame);
  // The sandbox applies on the next load; the new CSP meta forces that reload.
  if (!frame.hidden) writeSrcdoc(frame, withCsp(lastHtml));
}

function bindToggle() {
  if (bound) return;
  const control = document.getElementById("html-js");
  if (!control) return;
  bound = true;
  control.addEventListener("change", () => {
    setHtmlJsEnabled(!!control.checked);
  });
}

export function showHtmlViewer(html) {
  bindToggle();
  // CodeMirror holds an LF copy of a CRLF file; both are the same document.
  const next = String(html ?? "").replace(/\r\n?/g, "\n");
  const frame = document.getElementById("html-viewer");
  const previewBody = document.getElementById("preview-body");
  const chrome = document.getElementById("html-js-chrome");
  if (!frame) return;
  const file = currentFile();
  if (frame.hidden || file !== shownFile) htmlJs.enabled = false;
  shownFile = file;
  lastHtml = next;
  applySandbox(frame);
  writeSrcdoc(frame, withCsp(next));
  frame.hidden = false;
  if (previewBody) previewBody.hidden = true;
  if (chrome) chrome.hidden = false;
  syncHtmlJsUi();
}

export function hideHtmlViewer() {
  const frame = document.getElementById("html-viewer");
  const previewBody = document.getElementById("preview-body");
  const chrome = document.getElementById("html-js-chrome");
  const warn = document.getElementById("html-js-warn");
  htmlJs.enabled = false;
  shownFile = null;
  lastHtml = "";
  if (frame) {
    writeSrcdoc(frame, "");
    frame.hidden = true;
  }
  if (previewBody) previewBody.hidden = false;
  if (chrome) chrome.hidden = true;
  if (warn) warn.hidden = true;
  syncHtmlJsUi();
}

if (typeof document !== "undefined") {
  bindToggle();
}
