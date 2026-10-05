import { EditorView } from "@codemirror/view";
import { outlineFromMarkdown } from "./preview.js";
import { previewDefaults } from "./settings.js";

// The Outline section in the explorer lists the open document's headings;
// clicking one moves the editor cursor to it and scrolls the preview to it.
// Scroll sync keeps the editor and the markdown preview on the same part of
// the document, using the data-line attributes renderPreview() adds.

function doc() {
  return typeof globalThis.document !== "undefined" ? globalThis.document : null;
}

function byId(id) {
  const d = doc();
  return d && typeof d.getElementById === "function" ? d.getElementById(id) : null;
}

let outlineKey = null;
let staleOutline = null; // { body, lineOffset } while the section is collapsed

// `body` is the markdown below any frontmatter, starting `lineOffset` lines
// into the file; null clears the outline (HTML files, no document).
export function updateOutline(body, lineOffset = 0) {
  const section = byId("outline");
  const list = byId("outline-list");
  if (!list) return;
  if (section && section.open === false) {
    staleOutline = { body, lineOffset };
    return;
  }
  staleOutline = null;
  const items = body == null ? [] : outlineFromMarkdown(body, lineOffset);
  const key = JSON.stringify(items);
  if (key === outlineKey) return;
  outlineKey = key;
  const d = doc();
  list.replaceChildren(
    ...items.map((item) => {
      const li = d.createElement("li");
      const button = d.createElement("button");
      button.type = "button";
      button.textContent = item.text || "Untitled heading";
      button.dataset.level = String(item.level);
      button.dataset.line = String(item.line);
      if (item.id) button.dataset.target = item.id;
      li.append(button);
      return li;
    }),
  );
  if (section) section.hidden = items.length === 0;
}

function editorView() {
  return globalThis.lightmdEditor && globalThis.lightmdEditor.view;
}

// Programmatic scrolls of one side must not echo back from the other.
const quietUntil = { editor: 0, preview: 0 };
function quiet(side) {
  quietUntil[side] = Date.now() + 150;
}

function scrollPreviewTo(top) {
  const body = byId("preview-body");
  if (!body) return;
  quiet("preview");
  body.scrollTop = top;
}

function scrollEditorTo(top) {
  const view = editorView();
  if (!view) return;
  quiet("editor");
  view.scrollDOM.scrollTop = top;
}

function jumpTo(line, targetId) {
  const view = editorView();
  if (view) {
    const n = Math.min(Math.max(line + 1, 1), view.state.doc.lines);
    const pos = view.state.doc.line(n).from;
    quiet("editor");
    view.dispatch({
      selection: { anchor: pos },
      effects: EditorView.scrollIntoView(pos, { y: "start" }),
    });
    view.focus();
  }
  const body = byId("preview-body");
  const heading = targetId ? byId(targetId) : null;
  if (body && heading && body.contains(heading)) {
    scrollPreviewTo(body.scrollTop + heading.getBoundingClientRect().top - body.getBoundingClientRect().top);
  }
}

// [{ line, top }] for the preview's top-level blocks, top in scroll coordinates.
function previewAnchors(body) {
  const base = body.getBoundingClientRect().top - body.scrollTop;
  const out = [];
  for (const el of body.children) {
    const line = Number(el.getAttribute("data-line"));
    if (!el.hasAttribute("data-line") || !Number.isFinite(line)) continue;
    out.push({ line, top: el.getBoundingClientRect().top - base });
  }
  return out;
}

// Linear interpolation between the anchors around `value` in field `from`.
function interpolate(anchors, from, to, value) {
  let a = null;
  let b = null;
  for (const anchor of anchors) {
    if (anchor[from] <= value) a = anchor;
    else {
      b = anchor;
      break;
    }
  }
  if (!a) return b ? b[to] * (value / Math.max(b[from], 1)) : 0;
  if (!b || b[from] === a[from]) return a[to];
  return a[to] + ((b[to] - a[to]) * (value - a[from])) / (b[from] - a[from]);
}

function markdownPreviewShown(body) {
  const viewer = byId("html-viewer");
  return body && !body.hidden && (!viewer || viewer.hidden);
}

function atBottom(el) {
  return el.scrollTop + el.clientHeight >= el.scrollHeight - 2;
}

function syncPreviewFromEditor() {
  const view = editorView();
  const body = byId("preview-body");
  if (!view || !markdownPreviewShown(body)) return;
  const scroller = view.scrollDOM;
  if (atBottom(scroller) && scroller.scrollTop > 0) {
    scrollPreviewTo(body.scrollHeight);
    return;
  }
  const block = view.lineBlockAtHeight(scroller.scrollTop);
  const line = view.state.doc.lineAt(block.from).number - 1;
  const frac = block.height > 0 ? (scroller.scrollTop - block.top) / block.height : 0;
  scrollPreviewTo(interpolate(previewAnchors(body), "line", "top", line + frac));
}

function syncEditorFromPreview() {
  const view = editorView();
  const body = byId("preview-body");
  if (!view || !markdownPreviewShown(body)) return;
  if (atBottom(body) && body.scrollTop > 0) {
    scrollEditorTo(view.scrollDOM.scrollHeight);
    return;
  }
  const pos = interpolate(previewAnchors(body), "top", "line", body.scrollTop);
  const lines = view.state.doc.lines;
  const n = Math.min(Math.floor(pos) + 1, lines);
  const top = view.lineBlockAt(view.state.doc.line(n).from).top;
  const next = n < lines ? view.lineBlockAt(view.state.doc.line(n + 1).from).top : top;
  scrollEditorTo(top + (next - top) * (pos - Math.floor(pos)));
}

function onScroll(side, sync) {
  let frame = null;
  return () => {
    if (!previewDefaults.syncScroll || Date.now() < quietUntil[side] || frame !== null) return;
    frame = requestAnimationFrame(() => {
      frame = null;
      sync();
    });
  };
}

export function bindOutlineAndScrollSync(view) {
  const list = byId("outline-list");
  if (list) {
    list.addEventListener("click", (event) => {
      const button = event.target && event.target.closest && event.target.closest("button[data-line]");
      if (button) jumpTo(Number(button.dataset.line), button.dataset.target);
    });
  }
  const section = byId("outline");
  if (section) {
    section.addEventListener("toggle", () => {
      if (section.open && staleOutline) updateOutline(staleOutline.body, staleOutline.lineOffset);
    });
  }
  const body = byId("preview-body");
  if (view && body) {
    view.scrollDOM.addEventListener("scroll", onScroll("editor", syncPreviewFromEditor), { passive: true });
    body.addEventListener("scroll", onScroll("preview", syncEditorFromPreview), { passive: true });
  }
}
