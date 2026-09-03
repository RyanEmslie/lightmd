import { collapsePane, getLayout, layout } from "./layout.js";
import { palettes, setEditorTheme, setPreviewTheme, theme } from "./palettes.js";

export { collapsePane, getLayout, layout };
export { palettes, setEditorTheme, setPreviewTheme, theme };

const PANE_BY_DIGIT = { 1: "explorer", 2: "editor", 3: "preview" };
const BOUND = "__lightmdKeyboardBound";

function doc() {
  return typeof globalThis.document !== "undefined" ? globalThis.document : null;
}

function clickId(id) {
  const d = doc();
  const el = d && typeof d.getElementById === "function" ? d.getElementById(id) : null;
  if (el && typeof el.click === "function") el.click();
  return el;
}

function cyclePalette(current, delta) {
  const names = Object.keys(palettes);
  if (!names.length) return current;
  let i = names.indexOf(current);
  if (i < 0) i = 0;
  return names[(i + delta + names.length) % names.length];
}

function cycleEditorTheme(delta) {
  const d = doc();
  const select = d && typeof d.getElementById === "function" ? d.getElementById("editor-theme") : null;
  const current = (select && select.value) || theme.editorTheme;
  const next = cyclePalette(current, delta);
  setEditorTheme(next);
  if (select) select.value = next;
}

function cyclePreviewTheme(delta) {
  const d = doc();
  const select = d && typeof d.getElementById === "function" ? d.getElementById("preview-theme") : null;
  const current = (select && select.value) || theme.previewTheme;
  const next = cyclePalette(current, delta);
  setPreviewTheme(next);
  if (select) select.value = next;
}

function onKeydown(event) {
  if (!event) return;
  if (event.defaultPrevented) return;
  if (event.metaKey && !event.ctrlKey) return;
  if (!event.ctrlKey) return;

  const key = event.key;
  const code = event.code;

  if (!event.altKey && (key === "o" || key === "O" || code === "KeyO")) {
    event.preventDefault();
    clickId("open-folder");
    return;
  }
  if (!event.altKey && (key === "s" || key === "S" || code === "KeyS")) {
    event.preventDefault();
    clickId("save");
    return;
  }
  if (!event.altKey && (key === "f" || key === "F" || code === "KeyF")) {
    event.preventDefault();
    const d = doc();
    const query = d && typeof d.getElementById === "function" ? d.getElementById("find-query") : null;
    if (query && typeof query.focus === "function") query.focus();
    const find = d && typeof d.getElementById === "function" ? d.getElementById("find") : null;
    if (find && typeof find.click === "function") find.click();
    return;
  }

  for (const digit of [1, 2, 3]) {
    if (event.altKey) break;
    if (key === String(digit) || code === `Digit${digit}`) {
      event.preventDefault();
      const pane = PANE_BY_DIGIT[digit];
      collapsePane(pane, layout.open[pane] !== false);
      return;
    }
  }

  const left = key === "ArrowLeft" || key === "Left" || code === "ArrowLeft";
  const right = key === "ArrowRight" || key === "Right" || code === "ArrowRight";
  if (event.altKey && (left || right)) {
    event.preventDefault();
    const delta = left ? -1 : 1;
    if (event.shiftKey) cyclePreviewTheme(delta);
    else cycleEditorTheme(delta);
  }
}

export function bindKeyboard() {
  if (globalThis[BOUND]) return;
  const win = globalThis.window ?? globalThis;
  if (!win || typeof win.addEventListener !== "function") return;
  win.addEventListener("keydown", onKeydown, true);
  globalThis[BOUND] = true;
}

try {
  bindKeyboard();
} catch {
  // DOM-optional: Node imports this module with a document mock.
}
