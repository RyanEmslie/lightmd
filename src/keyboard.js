import { collapsePane, getLayout, layout } from "./layout.js";
import { palettes, setTheme, theme } from "./palettes.js";

export { collapsePane, getLayout, layout };
export { palettes, setTheme, theme };

const PANE_BY_DIGIT = { 1: "explorer", 2: "editor", 3: "preview" };
const BOUND = "__lightmdKeyboardBound";

function doc() {
  return typeof globalThis.document !== "undefined" ? globalThis.document : null;
}

function isMac() {
  const nav = globalThis.navigator;
  return /mac|iphone|ipad|ipod/i.test(String(nav?.platform || nav?.userAgent || ""));
}

// macOS shortcuts use Cmd alone: Ctrl belongs to CodeMirror's Mac bindings
// (Ctrl-O splits the line, Ctrl-F moves right) and Ctrl+Cmd to the system.
// Elsewhere Ctrl alone; the Super key belongs to the desktop.
function hasMod(event) {
  return isMac() ? !!event.metaKey && !event.ctrlKey : !!event.ctrlKey && !event.metaKey;
}

// Follow the character the layout types, so Dvorak's Cmd+O (the QWERTY S
// key) opens a folder rather than saving. The physical key only stands in
// when the typed key isn't a Latin letter or digit (a Cyrillic layout,
// Option-modified characters, AZERTY's digit row).
function typedKey(event, codePrefix) {
  const key = typeof event.key === "string" ? event.key : "";
  if (/^[a-z0-9]$/i.test(key)) return key.toLowerCase();
  const code = String(event.code || "");
  return code.startsWith(codePrefix) && code.length === codePrefix.length + 1
    ? code.slice(-1).toLowerCase()
    : "";
}

function clickId(id) {
  const d = doc();
  const el = d && typeof d.getElementById === "function" ? d.getElementById(id) : null;
  if (el && typeof el.click === "function") el.click();
  return el;
}

function callGlobal(name, ...args) {
  const fn = globalThis[name] ?? globalThis.window?.[name];
  if (typeof fn === "function") return fn(...args);
  return undefined;
}

function cyclePalette(current, delta) {
  const names = Object.keys(palettes);
  if (!names.length) return current;
  let i = names.indexOf(current);
  if (i < 0) i = 0;
  return names[(i + delta + names.length) % names.length];
}

function cycleTheme(delta) {
  const d = doc();
  const select =
    d && typeof d.getElementById === "function"
      ? d.getElementById("settings-theme")
      : null;
  const current = (select && select.value) || theme.name;
  const next = cyclePalette(current, delta);
  setTheme(next);
  if (select) {
    select.value = next;
    if (typeof Event === "function" && typeof select.dispatchEvent === "function") {
      select.dispatchEvent(new Event("change"));
    }
  }
}

function onKeydown(event) {
  if (!event) return;
  if (event.defaultPrevented) return;
  if (!hasMod(event)) return;

  const key = event.key;
  const code = event.code;
  const letter = typedKey(event, "Key");

  if (!event.altKey && letter === "o") {
    event.preventDefault();
    clickId("open-folder");
    return;
  }
  if (!event.altKey && letter === "s") {
    event.preventDefault();
    if (event.shiftKey) callGlobal("lightmdSaveAs");
    else if (typeof globalThis.lightmdSave === "function") callGlobal("lightmdSave");
    else clickId("save");
    return;
  }
  if (!event.altKey && !event.shiftKey && letter === "f") {
    event.preventDefault();
    callGlobal("lightmdFind");
    return;
  }

  const digitKey = typedKey(event, "Digit");
  for (const digit of [1, 2, 3]) {
    if (event.altKey) break;
    if (digitKey === String(digit)) {
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
    cycleTheme(left ? -1 : 1);
  }
}

export function bindKeyboard() {
  if (globalThis[BOUND]) return;
  const win = globalThis.window ?? globalThis;
  if (!win || typeof win.addEventListener !== "function") return;
  win.addEventListener("keydown", onKeydown, true);
  globalThis[BOUND] = true;
}

// bindKeyboard() skips hosts without addEventListener; anything else is a bug.
try {
  bindKeyboard();
} catch (err) {
  console.error("LightMD: could not bind keyboard shortcuts", err);
}
