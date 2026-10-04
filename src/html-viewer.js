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
let shownJs = false;
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

function writeSrcdoc(frame) {
  frame.srcdoc = withCsp(lastHtml ?? "");
  shownJs = htmlJs.enabled;
}

export function setHtmlJsEnabled(enabled) {
  htmlJs.enabled = !!enabled;
  syncHtmlJsUi();
  const frame = document.getElementById("html-viewer");
  if (!frame) return;
  applySandbox(frame);
  // The sandbox applies on the next load, so reload to start or stop scripts.
  if (!frame.hidden) writeSrcdoc(frame);
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
  const next = html ?? "";
  const frame = document.getElementById("html-viewer");
  const previewBody = document.getElementById("preview-body");
  const chrome = document.getElementById("html-js-chrome");
  if (!frame) return;
  const file = currentFile();
  if (frame.hidden || file !== shownFile) htmlJs.enabled = false;
  shownFile = file;
  const same = lastHtml === next && frame.hidden === false && shownJs === htmlJs.enabled;
  lastHtml = next;
  applySandbox(frame);
  if (!same) writeSrcdoc(frame);
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
  if (frame) {
    frame.srcdoc = "";
    frame.hidden = true;
  }
  if (previewBody) previewBody.hidden = false;
  if (chrome) chrome.hidden = true;
  if (warn) warn.hidden = true;
  lastHtml = "";
  htmlJs.enabled = false;
  shownFile = null;
  syncHtmlJsUi();
}

if (typeof document !== "undefined") {
  bindToggle();
}
