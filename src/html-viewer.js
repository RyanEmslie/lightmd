export function isHtmlFile(relative) {
  const name = String(relative || "").replace(/\\/g, "/");
  const base = name.slice(name.lastIndexOf("/") + 1);
  return /\.(html|htm)$/i.test(base);
}

export function showHtmlViewer(html) {
  const frame = document.getElementById("html-viewer");
  const previewBody = document.getElementById("preview-body");
  if (!frame) return;
  frame.setAttribute("sandbox", "");
  frame.srcdoc = html ?? "";
  frame.hidden = false;
  if (previewBody) previewBody.hidden = true;
}

export function hideHtmlViewer() {
  const frame = document.getElementById("html-viewer");
  const previewBody = document.getElementById("preview-body");
  if (frame) {
    frame.srcdoc = "";
    frame.hidden = true;
  }
  if (previewBody) previewBody.hidden = false;
}
