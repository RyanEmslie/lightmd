export function isHtmlFile(relative) {
  const name = String(relative || "").replace(/\\/g, "/");
  const base = name.slice(name.lastIndexOf("/") + 1);
  return /\.(html|htm)$/i.test(base);
}

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
let bound = false;

function sandboxValue() {
  return htmlJs.enabled ? ALLOW_SCRIPTS : "";
}

function applySandbox(frame) {
  const sandbox = sandboxValue();
  if (frame.getAttribute("sandbox") === sandbox) return;
  frame.setAttribute("sandbox", sandbox);
}

function syncHtmlJsUi() {
  const control = document.getElementById("html-js");
  if (control && control.checked !== htmlJs.enabled) {
    control.checked = htmlJs.enabled;
  }
  const warn = document.getElementById("html-js-warn");
  if (warn) warn.hidden = !htmlJs.enabled;
}

function reloadSrcdoc(frame) {
  frame.srcdoc = withCsp(lastHtml ?? "");
}

export function setHtmlJsEnabled(enabled) {
  htmlJs.enabled = !!enabled;
  syncHtmlJsUi();
  const frame = document.getElementById("html-viewer");
  if (!frame) return;
  applySandbox(frame);
  if (!frame.hidden) reloadSrcdoc(frame);
}

function bindToggle() {
  if (bound) return;
  const control = document.getElementById("html-js");
  if (!control) return;
  bound = true;
  control.addEventListener("change", () => {
    setHtmlJsEnabled(!!control.checked);
    import("./session.js")
      .then((m) => {
        if (typeof m.persistSession === "function") {
          m.persistSession({ htmlJs: !!control.checked });
        }
      })
      .catch(() => {});
  });
}

export function showHtmlViewer(html) {
  bindToggle();
  const next = html ?? "";
  const frame = document.getElementById("html-viewer");
  const previewBody = document.getElementById("preview-body");
  const chrome = document.getElementById("html-js-chrome");
  if (!frame) return;
  const same = lastHtml === next && frame.hidden === false;
  lastHtml = next;
  applySandbox(frame);
  if (!same) frame.srcdoc = withCsp(lastHtml);
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
}

if (typeof document !== "undefined") {
  bindToggle();
}
