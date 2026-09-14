import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { loadSourceFiles, collectFiles } from "./helpers/source.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(root, "src");
const htmlPath = join(srcDir, "index.html");

const PANE_IDS = ["explorer", "editor", "preview"];
const PANE_BY_DIGIT = { 1: "explorer", 2: "editor", 3: "preview" };

const BIND_EXPORTS = [
  "bindKeyboard",
  "bindShortcuts",
  "bindKeys",
  "initKeyboard",
  "mountKeyboard",
  "registerKeyboard",
  "attachKeyboard",
  "setupKeyboard",
  "bindKeydown",
  "installKeyboard",
];

const HANDLER_NAMES =
  String.raw`onKeydown|onKeyDown|handleKeydown|handleKeyDown|keyboardHandler|onKey|handleShortcut|handleShortcuts|onShortcut|handleKey`;

const NATIVE_FOCUS = /^(button|select|input|textarea|a)$/i;


function loadSources() {
  return loadSourceFiles();
}

function joinedSource(files = loadSources()) {
  return files.map((f) => f.text).join("\n");
}

function stripComments(src) {
  return String(src || "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function windowsAround(src, re, before, after) {
  const out = [];
  const copy = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
  let m;
  while ((m = copy.exec(src))) {
    const start = Math.max(0, m.index - before);
    const end = Math.min(src.length, m.index + m[0].length + after);
    out.push(src.slice(start, end));
  }
  return out;
}

function fnBodies(src, namesAlt) {
  const cleaned = stripComments(src);
  const bodies = [];
  const patterns = [
    new RegExp(
      String.raw`(?:export\s+)?function\s+(?:${namesAlt})\s*\([^)]*\)\s*\{`,
      "gi",
    ),
    new RegExp(
      String.raw`(?:export\s+)?(?:const|let|var)\s+(?:${namesAlt})\s*=\s*(?:async\s*)?(?:function\s*)?\([^)]*\)\s*(?:=>\s*)?\{`,
      "gi",
    ),
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(cleaned))) {
      const brace = cleaned.indexOf("{", m.index);
      if (brace < 0) continue;
      let depth = 0;
      for (let i = brace; i < cleaned.length; i++) {
        if (cleaned[i] === "{") depth += 1;
        else if (cleaned[i] === "}") {
          depth -= 1;
          if (depth === 0) {
            bodies.push(cleaned.slice(brace, i + 1));
            break;
          }
        }
      }
    }
  }
  return bodies;
}

function isGlobalKeydownCall(src, index) {
  const before = src.slice(Math.max(0, index - 96), index);
  if (
    /(?:window|document|globalThis|self|win|doc|root)\s*(?:\?\.|\.)\s*$/.test(
      before,
    )
  ) {
    return true;
  }
  if (/\.\s*$/.test(before)) return false;
  return /(?:window|document|globalThis|self)\b/.test(before) || !/\S/.test(before);
}

function hasWindowOrDocumentKeydown(src) {
  const cleaned = stripComments(src);
  if (
    /(?:window|document|globalThis|self)\s*(?:\?\.|\.)\s*(?:addEventListener\(\s*["']keydown["']|onkeydown\s*=)/.test(
      cleaned,
    )
  ) {
    return true;
  }
  if (
    /\bon\(\s*(?:window|document|globalThis|self|d|doc|win)\s*,\s*["']keydown["']/.test(
      cleaned,
    )
  ) {
    return true;
  }
  const re = /addEventListener\(\s*["']keydown["']/g;
  let m;
  while ((m = re.exec(cleaned))) {
    if (isGlobalKeydownCall(cleaned, m.index)) return true;
  }
  return false;
}

function globalKeydownBodies(src) {
  const cleaned = stripComments(src);
  const bodies = [...fnBodies(cleaned, HANDLER_NAMES)];
  const listenerRe =
    /(?:window|document|globalThis|self|win|doc)\s*(?:\?\.|\.)\s*addEventListener\(\s*["']keydown["']\s*,\s*/g;
  let m;
  while ((m = listenerRe.exec(cleaned))) {
    const after = cleaned.slice(m.index + m[0].length);
    const name = after.match(/^([A-Za-z_$][\w$]*)/);
    if (name && !/^(function|async)$/.test(name[1])) {
      bodies.push(...fnBodies(cleaned, name[1]));
    }
    bodies.push(after.slice(0, 5000));
  }
  const bare = /addEventListener\(\s*["']keydown["']\s*,\s*/g;
  while ((m = bare.exec(cleaned))) {
    if (!isGlobalKeydownCall(cleaned, m.index)) continue;
    bodies.push(cleaned.slice(m.index, Math.min(cleaned.length, m.index + 5000)));
  }
  const onRe =
    /(?:window|document|globalThis|self)\s*(?:\?\.|\.)\s*onkeydown\s*=\s*/g;
  while ((m = onRe.exec(cleaned))) {
    bodies.push(cleaned.slice(m.index, Math.min(cleaned.length, m.index + 5000)));
  }
  const onCall =
    /\bon\(\s*(?:window|document|globalThis|self|d|doc|win)\s*,\s*["']keydown["']\s*,\s*/g;
  while ((m = onCall.exec(cleaned))) {
    const after = cleaned.slice(m.index + m[0].length);
    const name = after.match(/^([A-Za-z_$][\w$]*)/);
    if (name && !/^(function|async)$/.test(name[1])) {
      bodies.push(...fnBodies(cleaned, name[1]));
    }
    bodies.push(after.slice(0, 5000));
  }
  return bodies;
}

function keyPattern(spec) {
  if (spec.letter) {
    const k = spec.letter;
    const upper = k.toUpperCase();
    const lower = k.toLowerCase();
    const code = spec.code || `Key${upper}`;
    const keyCode = spec.keyCode;
    return new RegExp(
      String.raw`(?:` +
        String.raw`\.key\s*===?\s*["']${lower}["']` +
        String.raw`|\.key\s*===?\s*["']${upper}["']` +
        String.raw`|\.key\.toLowerCase\(\)\s*===?\s*["']${lower}["']` +
        String.raw`|\.key\.toUpperCase\(\)\s*===?\s*["']${upper}["']` +
        String.raw`|["']${lower}["']\s*===?\s*\w+\.key` +
        String.raw`|["']${upper}["']\s*===?\s*\w+\.key` +
        String.raw`|\.code\s*===?\s*["']${code}["']` +
        (keyCode != null ? String.raw`|\.keyCode\s*===?\s*${keyCode}` : "") +
        String.raw`|includes\(\s*["']${lower}["']` +
        String.raw`|/\^?${lower}\$?/i` +
        String.raw`)`,
      "i",
    );
  }
  if (spec.digit) {
    const d = spec.digit;
    const code = `Digit${d}`;
    const keyCode = 48 + Number(d);
    return new RegExp(
      String.raw`(?:` +
        String.raw`\.key\s*===?\s*["']${d}["']` +
        String.raw`|\.code\s*===?\s*["']${code}["']` +
        String.raw`|\.keyCode\s*===?\s*${keyCode}` +
        String.raw`|["']${d}["']\s*===?\s*\w+\.key` +
        String.raw`)`,
    );
  }
  if (spec.arrow) {
    const name = spec.arrow;
    const short = name.replace(/^Arrow/, "");
    const keyCode = name === "ArrowLeft" ? 37 : 39;
    return new RegExp(
      String.raw`(?:` +
        String.raw`\.key\s*===?\s*["'](?:${name}|${short})["']` +
        String.raw`|\.code\s*===?\s*["']${name}["']` +
        String.raw`|\.keyCode\s*===?\s*${keyCode}` +
        String.raw`|["'](?:${name}|${short})["']\s*===?\s*\w+\.key` +
        String.raw`)`,
      "i",
    );
  }
  return /(?:)/;
}

function hasCtrlKey(windowText) {
  return /\bctrlKey\b/.test(windowText);
}

function isMetaOnly(windowText) {
  return /\bmetaKey\b/.test(windowText) && !/\bctrlKey\b/.test(windowText);
}

function chordStringRe(label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\+/g, "\\s*\\+\\s*");
  return new RegExp(escaped.replace(/Ctrl/g, "(?:Ctrl|Control|ctl)"), "i");
}

function handlerWindows(src) {
  const cleaned = stripComments(src);
  const out = [...globalKeydownBodies(cleaned)];
  out.push(
    ...windowsAround(cleaned, /\bctrlKey\b/g, 240, 520),
    ...windowsAround(cleaned, /Ctrl\s*\+\s*[A-Z0-9]/gi, 80, 280),
  );
  return out;
}

function windowHasChord(windowText, spec) {
  const keyRe = keyPattern(spec);
  const chordLabel = spec.chord;
  const hasKey = keyRe.test(windowText) || (chordLabel && chordStringRe(chordLabel).test(windowText));
  if (!hasKey) return false;
  if (spec.alt && !/\baltKey\b/.test(windowText) && !/Alt/i.test(windowText)) {
    if (!(chordLabel && chordStringRe(chordLabel).test(windowText))) return false;
  }
  if (spec.shift) {
    if (!/\bshiftKey\b/.test(windowText) && !/\bShift\b/.test(windowText)) return false;
  } else if (spec.shift === false) {
    // non-shift chords may still mention shiftKey as a guard; that's fine
  }
  if (hasCtrlKey(windowText)) return !isMetaOnly(windowText);
  if (chordLabel && chordStringRe(chordLabel).test(windowText)) return true;
  return false;
}

function sourceHasShortcut(src, spec, actionRe) {
  if (!hasWindowOrDocumentKeydown(src)) return false;
  const windows = handlerWindows(src);
  return windows.some((w) => windowHasChord(w, spec) && actionRe.test(w));
}

const OPEN_FOLDER_ACTION =
  /#open-folder|["']open-folder["']|openFolder|open_folder|pickFolder|lightmdOpenFolder|open-folder/;
const SAVE_ACTION =
  /#save\b|getElementById\(\s*["']save["']|querySelector\(\s*["']#save["']|["']save["']\s*\)\s*\.click|\bsave(?:File|Doc|Buffer|Now)?\s*\(|\bsaveButton\b|lightmdSave|write_workspace_file|\.click\(\)[\s\S]{0,80}save|save[\s\S]{0,80}\.click\(/;
const FIND_ACTION =
  /#find\b|#find-query|getElementById\(\s*["']find(?:-query)?["']|querySelector\(\s*["']#find|runFind|applyFind|openFind|lightmdFind|findInBuffer|findInFile/;

function collapseAction(pane) {
  return new RegExp(
    String.raw`(?:collapsePane|togglePane|hidePane|setPaneCollapsed|setPaneOpen|setPaneVisible)\s*\(\s*["']${pane}["']` +
      String.raw`|["']${pane}["'][\s\S]{0,120}(?:collapsePane|togglePane|hidePane)` +
      String.raw`|data-pane-toggle=["']${pane}["'][\s\S]{0,80}\.click` +
      String.raw`|pane[-_]?toggle["']\s*,\s*["']${pane}["']`,
  );
}

const THEME_ACTION =
  /setTheme|cycleTheme|#theme\b/;

function mockClassList() {
  const set = new Set();
  return {
    add(name) {
      set.add(String(name));
    },
    remove(name) {
      set.delete(String(name));
    },
    toggle(name, force) {
      const key = String(name);
      if (force === true) set.add(key);
      else if (force === false) set.delete(key);
      else if (set.has(key)) set.delete(key);
      else set.add(key);
      return set.has(key);
    },
    contains(name) {
      return set.has(String(name));
    },
  };
}

function mockEl(id, tag = "div") {
  const attrs = { id };
  const listeners = [];
  const el = {
    id,
    tagName: String(tag).toUpperCase(),
    nodeName: String(tag).toUpperCase(),
    className: "",
    classList: mockClassList(),
    style: {
      setProperty(name, value) {
        this[name] = value;
      },
    },
    hidden: false,
    value: "",
    checked: false,
    textContent: "",
    innerHTML: "",
    children: [],
    parentNode: null,
    clicked: 0,
    focused: 0,
    dataset: {},
    setAttribute(name, value) {
      attrs[String(name)] = String(value);
      if (name === "hidden") el.hidden = true;
      if (name === "id") el.id = String(value);
    },
    removeAttribute(name) {
      delete attrs[String(name)];
      if (name === "hidden") el.hidden = false;
    },
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null;
    },
    hasAttribute(name) {
      return Object.prototype.hasOwnProperty.call(attrs, name);
    },
    addEventListener(type, fn) {
      listeners.push({ type: String(type), fn });
    },
    removeEventListener(type, fn) {
      const i = listeners.findIndex((l) => l.type === String(type) && l.fn === fn);
      if (i >= 0) listeners.splice(i, 1);
    },
    click() {
      el.clicked += 1;
      for (const l of listeners) {
        if (l.type === "click") {
          try {
            l.fn.call(el, { type: "click", target: el, preventDefault() {} });
          } catch {
            // ignore
          }
        }
      }
    },
    focus() {
      el.focused += 1;
    },
    dispatchEvent(event) {
      for (const l of listeners) {
        if (l.type === event.type) {
          try {
            l.fn.call(el, event);
          } catch {
            // ignore
          }
        }
      }
      return !event?.defaultPrevented;
    },
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
    appendChild(child) {
      this.children.push(child);
      child.parentNode = this;
      return child;
    },
    getBoundingClientRect() {
      return { width: 240, height: 600, top: 0, left: 0, right: 240, bottom: 600 };
    },
  };
  return el;
}

function ensureKeyboardEvent() {
  if (typeof globalThis.KeyboardEvent === "function") return globalThis.KeyboardEvent;
  class KeyboardEvent {
    constructor(type, init = {}) {
      this.type = type;
      this.key = init.key ?? "";
      this.code = init.code ?? "";
      this.keyCode = init.keyCode ?? 0;
      this.which = init.which ?? this.keyCode;
      this.ctrlKey = !!init.ctrlKey;
      this.metaKey = !!init.metaKey;
      this.altKey = !!init.altKey;
      this.shiftKey = !!init.shiftKey;
      this.repeat = !!init.repeat;
      this.bubbles = init.bubbles !== false;
      this.cancelable = init.cancelable !== false;
      this.defaultPrevented = false;
      this.target = init.target ?? null;
      this.currentTarget = null;
    }
    preventDefault() {
      this.defaultPrevented = true;
    }
    stopPropagation() {}
    stopImmediatePropagation() {
      this._immediate = true;
    }
  }
  globalThis.KeyboardEvent = KeyboardEvent;
  return KeyboardEvent;
}

function attachListenable(obj, bucket) {
  const origAdd =
    typeof obj.addEventListener === "function" ? obj.addEventListener.bind(obj) : null;
  const origRemove =
    typeof obj.removeEventListener === "function"
      ? obj.removeEventListener.bind(obj)
      : null;
  obj.addEventListener = function (type, fn, opts) {
    bucket.push({ target: obj, type: String(type), fn, opts });
    if (origAdd) return origAdd(type, fn, opts);
  };
  obj.removeEventListener = function (type, fn, opts) {
    const i = bucket.findIndex(
      (l) => l.target === obj && l.type === String(type) && l.fn === fn,
    );
    if (i >= 0) bucket.splice(i, 1);
    if (origRemove) return origRemove(type, fn, opts);
  };
  obj.dispatchEvent = function (event) {
    event.target = event.target ?? obj;
    for (const l of bucket) {
      if (l.target !== obj) continue;
      if (l.type !== event.type) continue;
      event.currentTarget = obj;
      try {
        l.fn.call(obj, event);
      } catch {
        // handler errors must not crash the test
      }
      if (event._immediate) break;
    }
    return !event.defaultPrevented;
  };
}

function installLocalStorage() {
  if (globalThis.localStorage && typeof globalThis.localStorage.getItem === "function") {
    return globalThis.localStorage;
  }
  const map = new Map();
  const ls = {
    getItem(key) {
      const k = String(key);
      return map.has(k) ? map.get(k) : null;
    },
    setItem(key, value) {
      map.set(String(key), String(value));
    },
    removeItem(key) {
      map.delete(String(key));
    },
    clear() {
      map.clear();
    },
    key(index) {
      return [...map.keys()][index] ?? null;
    },
    get length() {
      return map.size;
    },
  };
  globalThis.localStorage = ls;
  return ls;
}

function installRuntimeDom() {
  ensureKeyboardEvent();
  installLocalStorage();
  const listeners = [];
  const byId = new Map();
  const tagById = {
    "open-folder": "button",
    save: "button",
    find: "button",
    "find-query": "input",
    theme: "select",
    explorer: "aside",
    editor: "main",
    preview: "section",
    shell: "div",
  };
  function el(id) {
    const key = String(id);
    if (!byId.has(key)) byId.set(key, mockEl(key, tagById[key] || "div"));
    return byId.get(key);
  }
  for (const id of [
    "shell",
    "explorer",
    "editor",
    "preview",
    "open-folder",
    "save",
    "find",
    "find-query",
    "theme",
    "editor-buffer",
    "editor-view",
    "settings",
    "pane-layout",
    "pane-order",
  ]) {
    el(id);
  }
  el("theme").value = "Tokyo Night";

  const doc = {
    documentElement: mockEl("html"),
    body: mockEl("body"),
    getElementById(id) {
      return el(id);
    },
    querySelector(sel) {
      const m = String(sel || "").match(/^#([\w-]+)$/);
      return m ? el(m[1]) : null;
    },
    querySelectorAll(sel) {
      if (String(sel) === "[data-pane-toggle]") return [];
      const m = String(sel || "").match(/^#([\w-]+)$/);
      return m ? [el(m[1])] : [];
    },
    createElement(tag) {
      return mockEl("", tag);
    },
  };
  attachListenable(doc, listeners);

  const win = globalThis.window && globalThis.window !== globalThis ? globalThis.window : {};
  attachListenable(win, listeners);
  win.document = doc;
  globalThis.window = win;
  globalThis.document = doc;
  if (typeof globalThis.addEventListener !== "function") {
    attachListenable(globalThis, listeners);
  } else {
    attachListenable(globalThis, listeners);
  }

  const calls = {
    openFolder: 0,
    save: 0,
    find: 0,
  };
  win.lightmdOpenFolder = function () {
    calls.openFolder += 1;
  };
  win.lightmdSave = function () {
    calls.save += 1;
  };
  win.lightmdFind = function () {
    calls.find += 1;
  };

  return { doc, win, listeners, el, calls };
}

function keydownBinds(listeners) {
  return listeners.filter((l) => String(l.type).toLowerCase() === "keydown");
}

function dispatchKeydown(listeners, init) {
  const KeyboardEvent = ensureKeyboardEvent();
  const event = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ...init,
  });
  const seen = new Set();
  for (const l of keydownBinds(listeners)) {
    if (typeof l.fn !== "function") continue;
    if (seen.has(l.fn)) continue;
    seen.add(l.fn);
    event.currentTarget = l.target;
    event.target = event.target ?? l.target;
    try {
      l.fn.call(l.target, event);
    } catch {
      // ignore
    }
    if (event._immediate) break;
  }
  const win = globalThis.window;
  const doc = globalThis.document;
  if (seen.size === 0) {
    if (win && typeof win.dispatchEvent === "function") win.dispatchEvent(event);
    if (doc && typeof doc.dispatchEvent === "function" && doc !== win) {
      doc.dispatchEvent(event);
    }
  }
  return event;
}

function callBindExports(mod) {
  if (!mod || typeof mod !== "object") return;
  for (const name of BIND_EXPORTS) {
    if (typeof mod[name] === "function") {
      try {
        mod[name]();
      } catch {
        // ignore
      }
    }
  }
  if (mod.default && typeof mod.default === "object") {
    for (const name of BIND_EXPORTS) {
      if (typeof mod.default[name] === "function") {
        try {
          mod.default[name]();
        } catch {
          // ignore
        }
      }
    }
  }
  for (const name of String(HANDLER_NAMES).split("|")) {
    const fn = mod[name];
    if (typeof fn === "function" && globalThis.window && typeof globalThis.window.addEventListener === "function") {
      try {
        globalThis.window.addEventListener("keydown", fn);
      } catch {
        // ignore
      }
    }
  }
}

let runtimePromise;

async function loadRuntime() {
  if (runtimePromise) return runtimePromise;
  runtimePromise = (async () => {
    const prevDoc = globalThis.document;
    const prevWin = globalThis.window;
    const installed = installRuntimeDom();
    const mods = [];
    const files = collectFiles(srcDir);
    for (const p of files) {
      if (!/\.(js|mjs|cjs)$/i.test(p)) continue;
      if (/editor\.bundle\.js$/i.test(p)) continue;
      try {
        const mod = await import(`${pathToFileURL(p).href}?keyboard=${Date.now()}`);
        mods.push(mod);
        callBindExports(mod);
      } catch {
        // DOM or CodeMirror: keep looking.
      }
    }
    return { ...installed, mods, prevDoc, prevWin };
  })();
  return runtimePromise;
}

function openedFolder(rt) {
  const btn = rt.el("open-folder");
  return btn.clicked > 0 || rt.calls.openFolder > 0;
}

function saved(rt) {
  const btn = rt.el("save");
  return btn.clicked > 0 || rt.calls.save > 0;
}

function found(rt) {
  const btn = rt.el("find");
  const query = rt.el("find-query");
  return btn.clicked > 0 || query.focused > 0 || rt.calls.find > 0;
}

function layoutOpen(mods) {
  for (const mod of mods) {
    if (typeof mod.getLayout === "function") {
      try {
        const layout = mod.getLayout();
        if (layout?.open) return layout.open;
      } catch {
        // keep looking
      }
    }
    if (mod.layout?.open) return mod.layout.open;
  }
  return null;
}

function themeState(mods) {
  for (const mod of mods) {
    if (mod.theme && typeof mod.theme === "object") return mod.theme;
  }
  return null;
}

function restorePanes(mods) {
  for (const mod of mods) {
    if (typeof mod.setLayout === "function") {
      try {
        mod.setLayout("three-pane");
      } catch {
        // ignore
      }
    }
    if (typeof mod.collapsePane === "function") {
      for (const id of PANE_IDS) {
        try {
          mod.collapsePane(id, false);
        } catch {
          // ignore
        }
      }
    }
  }
}

async function runtimeChord(init, observe) {
  const rt = await loadRuntime();
  const binds = keydownBinds(rt.listeners);
  if (!binds.length) return { bind: false, ok: false };
  const before = observe.snapshot ? observe.snapshot(rt) : null;
  dispatchKeydown(rt.listeners, init);
  const ok = observe.check(rt, before);
  if (observe.restore) observe.restore(rt, before);
  return { bind: true, ok };
}

function sectionFrom(blob, name, restNames) {
  const startRe = new RegExp(String.raw`\b${name}\b`);
  const start = blob.search(startRe);
  if (start < 0) return "";
  const rest = blob.slice(start);
  const next = new RegExp(String.raw`\b(?:${restNames.join("|")})\b`);
  const skip = rest.slice(name.length);
  const idx = skip.search(next);
  if (idx < 0) return rest;
  return rest.slice(0, name.length + idx);
}

function keyboardSection(blob) {
  return sectionFrom(blob, "Keyboard", [
    "Appearance",
    "Editor",
    "Preview",
    "Workspace",
    "About",
  ]);
}

function settingsBlob(files) {
  const html = files
    .filter((f) => /\.html$/i.test(f.path))
    .map((f) => f.text.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ""))
    .join("\n");
  const js = files
    .filter((f) => /settings/i.test(f.path) && /\.(js|mjs|cjs|ts)$/i.test(f.path))
    .map((f) => f.text)
    .join("\n");
  return `${html}\n${js}`;
}

function hasRemapInputs(section) {
  if (/<(?:input|textarea|select)\b/i.test(section)) return true;
  if (/\bcontenteditable\b/i.test(section)) return true;
  if (/\b(?:remap|rebind|keybinding-input|shortcut-input)\b/i.test(section)) {
    return true;
  }
  if (/press\s+(?:a\s+)?(?:new\s+)?key|custom(?:ize)?\s+shortcut/i.test(section)) {
    return true;
  }
  if (/\bVim\b/.test(section) && /remap|rebind|mode/i.test(section)) return true;
  return false;
}

function documentsChord(section, chord) {
  if (chordStringRe(chord).test(section)) return true;
  if (/\bLeft$/.test(chord) && chordStringRe(chord.replace(/Left$/, "ArrowLeft")).test(section)) {
    return true;
  }
  if (/\bRight$/.test(chord) && chordStringRe(chord.replace(/Right$/, "ArrowRight")).test(section)) {
    return true;
  }
  return false;
}

function extractElement(src, openMatch) {
  const tag = openMatch[1];
  const start = openMatch.index;
  const openTag = openMatch[0];
  if (/\/>\s*$/.test(openTag)) return { open: openTag, full: openTag, tag };
  const lower = String(tag).toLowerCase();
  const openRe = new RegExp(String.raw`<${lower}\b`, "gi");
  const closeRe = new RegExp(String.raw`</${lower}\s*>`, "gi");
  let depth = 1;
  let i = start + openTag.length;
  while (i < src.length && depth > 0) {
    openRe.lastIndex = i;
    closeRe.lastIndex = i;
    const nextOpen = openRe.exec(src);
    const nextClose = closeRe.exec(src);
    if (!nextClose) break;
    if (nextOpen && nextOpen.index < nextClose.index) {
      depth += 1;
      i = nextOpen.index + nextOpen[0].length;
    } else {
      depth -= 1;
      i = nextClose.index + nextClose[0].length;
    }
  }
  return { open: openTag, full: src.slice(start, i), tag };
}

function tabindexOf(openTag) {
  const m = String(openTag).match(/\btabindex\s*=\s*["'](-?\d+)["']/i);
  return m ? Number(m[1]) : null;
}

function elementById(src, id) {
  const re = new RegExp(
    String.raw`<([a-zA-Z][\w-]*)\b[^>]*\bid=["']${id}["'][^>]*>`,
    "i",
  );
  const m = String(src).match(re);
  if (!m) return null;
  return extractElement(src, m);
}

function isTrapped(openTag) {
  return tabindexOf(openTag) === -1;
}

function hasNativeOrTab(text) {
  if (/<(?:button|select|input|textarea|a)\b/i.test(text)) {
    const trappedNative = text.match(
      /<(?:button|select|input|textarea|a)\b[^>]*\btabindex=["']-1["'][^>]*>/gi,
    );
    const natives = text.match(/<(?:button|select|input|textarea|a)\b/gi) || [];
    if (natives.length && (!trappedNative || trappedNative.length < natives.length)) {
      return true;
    }
  }
  if (/\btabindex\s*=\s*["'](?:0|[1-9]\d*)["']/i.test(text)) return true;
  return false;
}

function reachable(src, id) {
  const el = elementById(src, id);
  if (!el) return false;
  if (isTrapped(el.open)) return false;
  if (NATIVE_FOCUS.test(el.tag)) return true;
  if (tabindexOf(el.open) != null && tabindexOf(el.open) >= 0) return true;
  return hasNativeOrTab(el.full);
}

test("Ctrl+O opens folder", async () => {
  const src = joinedSource();
  const staticOk = sourceHasShortcut(
    src,
    { letter: "o", code: "KeyO", keyCode: 79, chord: "Ctrl+O" },
    OPEN_FOLDER_ACTION,
  );
  const rt = await runtimeChord(
    { key: "o", code: "KeyO", keyCode: 79, ctrlKey: true, metaKey: false },
    {
      snapshot(state) {
        return { clicked: state.el("open-folder").clicked, calls: state.calls.openFolder };
      },
      check(state, before) {
        if (openedFolder(state)) {
          if (before && state.el("open-folder").clicked === before.clicked && state.calls.openFolder === before.calls) {
            dispatchKeydown(state.listeners, {
              key: "O",
              code: "KeyO",
              keyCode: 79,
              ctrlKey: true,
              metaKey: false,
            });
          }
          return openedFolder(state);
        }
        dispatchKeydown(state.listeners, {
          key: "O",
          code: "KeyO",
          keyCode: 79,
          ctrlKey: true,
          metaKey: false,
        });
        return openedFolder(state);
      },
    },
  );
  if (rt.bind) {
    assert.ok(
      rt.ok,
      "missing Ctrl+O shortcut: keydown handler for key o/O with ctrlKey must click #open-folder or call open-folder (not meta-only)",
    );
    return;
  }
  assert.ok(
    staticOk,
    "missing Ctrl+O shortcut: keydown handler for key o/O with ctrlKey that clicks #open-folder or calls open-folder (not meta-only)",
  );
});

test("Ctrl+S saves", async () => {
  const src = joinedSource();
  const staticOk = sourceHasShortcut(
    src,
    { letter: "s", code: "KeyS", keyCode: 83, chord: "Ctrl+S" },
    SAVE_ACTION,
  );
  const rt = await runtimeChord(
    { key: "s", code: "KeyS", keyCode: 83, ctrlKey: true, metaKey: false },
    {
      check(state) {
        if (saved(state)) return true;
        dispatchKeydown(state.listeners, {
          key: "S",
          code: "KeyS",
          keyCode: 83,
          ctrlKey: true,
          metaKey: false,
        });
        return saved(state);
      },
    },
  );
  if (rt.bind) {
    assert.ok(
      rt.ok,
      "missing Ctrl+S shortcut: keydown handler for key s/S with ctrlKey must save (click #save or call save)",
    );
    return;
  }
  assert.ok(
    staticOk,
    "missing Ctrl+S shortcut: keydown handler for key s/S with ctrlKey that saves (click #save or call save)",
  );
});

test("Ctrl+F finds", async () => {
  const src = joinedSource();
  const staticOk = sourceHasShortcut(
    src,
    { letter: "f", code: "KeyF", keyCode: 70, chord: "Ctrl+F" },
    FIND_ACTION,
  );
  const rt = await runtimeChord(
    { key: "f", code: "KeyF", keyCode: 70, ctrlKey: true, metaKey: false },
    {
      check(state) {
        if (found(state)) return true;
        dispatchKeydown(state.listeners, {
          key: "F",
          code: "KeyF",
          keyCode: 70,
          ctrlKey: true,
          metaKey: false,
        });
        return found(state);
      },
    },
  );
  if (rt.bind) {
    assert.ok(
      rt.ok,
      "missing Ctrl+F shortcut: keydown handler for key f/F with ctrlKey must find (click #find or call find)",
    );
    return;
  }
  assert.ok(
    staticOk,
    "missing Ctrl+F shortcut: keydown handler for key f/F with ctrlKey that finds (click #find or call find)",
  );
});

test("Ctrl+1/2/3 toggle explorer editor preview", async () => {
  const src = joinedSource();
  const staticOk = [1, 2, 3].every((digit) =>
    sourceHasShortcut(
      src,
      { digit: String(digit), chord: `Ctrl+${digit}` },
      collapseAction(PANE_BY_DIGIT[digit]),
    ),
  );
  const rt = await loadRuntime();
  const binds = keydownBinds(rt.listeners);
  if (binds.length) {
    restorePanes(rt.mods);
    const results = {};
    for (const digit of [1, 2, 3]) {
      const pane = PANE_BY_DIGIT[digit];
      const before = layoutOpen(rt.mods);
      const beforeOpen = before ? before[pane] !== false : true;
      dispatchKeydown(rt.listeners, {
        key: String(digit),
        code: `Digit${digit}`,
        keyCode: 48 + digit,
        ctrlKey: true,
        metaKey: false,
        altKey: false,
        shiftKey: false,
      });
      const after = layoutOpen(rt.mods);
      results[pane] = after ? after[pane] !== beforeOpen || after[pane] !== (before?.[pane] ?? true) : false;
      if (after && before && after[pane] !== before[pane]) results[pane] = true;
      restorePanes(rt.mods);
    }
    const ok = PANE_IDS.every((id) => results[id]);
    assert.ok(
      ok,
      "missing Ctrl+1/2/3 shortcut: keydown must collapsePane explorer/editor/preview",
    );
    return;
  }
  assert.ok(
    staticOk,
    "missing Ctrl+1/2/3 shortcut: keydown handler with ctrlKey must collapsePane explorer/editor/preview",
  );
});

test("Ctrl+Alt arrows cycle the app theme", async () => {
  const src = joinedSource();
  const leftTheme = sourceHasShortcut(
    src,
    { arrow: "ArrowLeft", alt: true, chord: "Ctrl+Alt+Left" },
    THEME_ACTION,
  );
  const rightTheme = sourceHasShortcut(
    src,
    { arrow: "ArrowRight", alt: true, chord: "Ctrl+Alt+Right" },
    THEME_ACTION,
  );
  const staticOk = leftTheme && rightTheme;
  const rt = await loadRuntime();
  const binds = keydownBinds(rt.listeners);
  if (binds.length) {
    const theme = themeState(rt.mods);
    const before = theme?.name ?? rt.el("theme").value;
    dispatchKeydown(rt.listeners, {
      key: "ArrowRight",
      code: "ArrowRight",
      keyCode: 39,
      ctrlKey: true,
      altKey: true,
      shiftKey: false,
      metaKey: false,
    });
    const afterRight = themeState(rt.mods)?.name ?? rt.el("theme").value;
    dispatchKeydown(rt.listeners, {
      key: "ArrowLeft",
      code: "ArrowLeft",
      keyCode: 37,
      ctrlKey: true,
      altKey: true,
      shiftKey: false,
      metaKey: false,
    });
    const afterLeft = themeState(rt.mods)?.name ?? rt.el("theme").value;
    assert.ok(
      afterRight !== before || afterLeft !== before || afterLeft !== afterRight,
      "missing Ctrl+Alt+ArrowLeft/ArrowRight shortcut: keydown must cycle setTheme",
    );
    return;
  }
  assert.ok(
    staticOk,
    "missing Ctrl+Alt+ArrowLeft/ArrowRight shortcut: keydown with ctrlKey+altKey must setTheme",
  );
});

test("Settings keyboard list documents the shortcuts and stays read-only", () => {
  const files = loadSources();
  const blob = settingsBlob(files);
  const section = keyboardSection(blob);
  assert.ok(section, "missing Keyboard shortcuts list in Settings");
  const required = [
    "Ctrl+O",
    "Ctrl+S",
    "Ctrl+F",
    "Ctrl+1",
    "Ctrl+2",
    "Ctrl+3",
    "Ctrl+Alt+Left",
    "Ctrl+Alt+Right",
  ];
  const missing = required.filter((chord) => !documentsChord(section, chord));
  assert.equal(
    missing.length,
    0,
    `Settings Keyboard list must document the shortcuts (missing ${missing.join(", ")})`,
  );
  assert.match(
    section,
    /Cycle theme/i,
    "Settings Keyboard list must document Cycle theme",
  );
  assert.equal(
    hasRemapInputs(section),
    false,
    "Keyboard list is read-only (no remappable keys, no Vim)",
  );
});

test("explorer editor panes save and themes are reachable from the keyboard", () => {
  assert.equal(existsSync(htmlPath), true, "src/index.html must exist");
  const src = joinedSource();
  const html = existsSync(htmlPath) ? readFileSync(htmlPath, "utf8") : src;
  const ids = [
    "explorer",
    "editor",
    "preview",
    "save",
    "theme",
  ];
  for (const id of ids) {
    assert.ok(reachable(html, id) || reachable(src, id), `missing keyboard reachability for #${id} (tabindex or native control; no tabindex=-1)`);
  }
  const paneToggles =
    /data-pane-toggle=["'](?:explorer|editor|preview)["']/i.test(html) ||
    /data-pane-toggle=["'](?:explorer|editor|preview)["']/i.test(src);
  const paneToggleTrapped = /data-pane-toggle=["'][^"']+["'][^>]*tabindex=["']-1["']/i.test(
    html,
  );
  assert.ok(
    paneToggles && !paneToggleTrapped,
    "missing keyboard reachability for panes (tabindex or native controls; no tabindex=-1)",
  );
  for (const id of ids) {
    const el = elementById(html, id) || elementById(src, id);
    if (!el) continue;
    assert.equal(
      isTrapped(el.open),
      false,
      `#${id} must not be trapped with tabindex=-1`,
    );
  }
});

function cycleFnPersistsTheme(body) {
  const text = String(body || "");
  if (/persistSession\s*\(/.test(text)) return true;
  const assign = /\.value\s*=/g;
  let m;
  while ((m = assign.exec(text))) {
    const after = text.slice(m.index);
    const dispatched =
      /dispatchEvent\s*\(\s*["']change["']/.test(after) ||
      /dispatchEvent\s*\(\s*new\s+(?:Custom)?Event\s*\(\s*["']change["']/.test(
        after,
      ) ||
      /new\s+Event\s*\(\s*["']change["']/.test(after);
    if (dispatched) return true;
  }
  return false;
}

function keyboardSettingsRows(section) {
  const rows = [];
  const re =
    /<(li|div)\b(?=[^>]*\bclass=["'][^"']*\bsettings-row\b)[^>]*>([\s\S]*?)<\/\1>/gi;
  let m;
  while ((m = re.exec(section))) {
    const text = String(m[2] || "")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
    rows.push(text);
  }
  return rows;
}

test("keyboard theme cycle persists", async () => {
  const files = loadSources();
  const keyboardFile = files.find((f) => /keyboard\.(js|mjs|cjs)$/i.test(f.path));
  const src = keyboardFile?.text || joinedSource(files);
  const themeBodies = fnBodies(src, "cycleTheme");
  const staticOk =
    themeBodies.length > 0 && themeBodies.every(cycleFnPersistsTheme);

  let runtimeOk = true;
  let ranRuntime = false;
  try {
    const rt = await loadRuntime();
    const binds = keydownBinds(rt.listeners);
    if (binds.length) {
      ranRuntime = true;
      const persistCalls = [];
      const wrap = (obj, name) => {
        if (!obj || typeof obj[name] !== "function") return;
        const orig = obj[name];
        obj[name] = function wrappedPersist(...args) {
          persistCalls.push(args);
          return orig.apply(this, args);
        };
      };
      wrap(globalThis, "lightmdPersistSession");
      wrap(globalThis, "persistSession");
      if (globalThis.window && globalThis.window !== globalThis) {
        wrap(globalThis.window, "lightmdPersistSession");
        wrap(globalThis.window, "persistSession");
      }
      for (const mod of rt.mods || []) {
        wrap(mod, "persistSession");
      }

      dispatchKeydown(rt.listeners, {
        key: "ArrowRight",
        code: "ArrowRight",
        keyCode: 39,
        ctrlKey: true,
        altKey: true,
        shiftKey: false,
        metaKey: false,
      });

      const themeName = rt.el("theme").value || themeState(rt.mods)?.name;

      const calledWith = (key, value) =>
        persistCalls.some((args) =>
          args.some(
            (arg) => arg && typeof arg === "object" && arg[key] === value,
          ),
        );

      let stored = null;
      try {
        const raw = globalThis.localStorage?.getItem("lightmd.session");
        stored = raw ? JSON.parse(raw) : null;
      } catch {
        stored = null;
      }

      runtimeOk =
        calledWith("theme", themeName) ||
        (stored && stored.theme === themeName);
    }
  } catch {
    // loadRuntime may already have bound the singleton; static scan still fails.
  }

  assert.ok(
    staticOk,
    "cycleTheme must persistSession(...) or dispatchEvent(\"change\") / new Event(\"change\") after setting select.value",
  );
  if (ranRuntime) {
    assert.ok(
      runtimeOk,
      "Ctrl+Alt+ArrowRight must persist the new theme via persistSession or localStorage lightmd.session",
    );
  }
});

test("settings keyboard list has no unlabeled Toggle panes row", () => {
  const files = loadSources();
  const blob = settingsBlob(files);
  const section = keyboardSection(blob);
  const unlabeled = keyboardSettingsRows(section).filter((text) =>
    /^toggle panes$/i.test(text),
  );
  assert.equal(
    unlabeled.length,
    0,
    'Keyboard section must not contain a settings-row whose text is exactly "Toggle panes" (Ctrl+1/2/3 already document pane toggles)',
  );
});
