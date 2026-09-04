import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(root, "src");
const LAYOUT_KEY = "lightmd.layout";

const SAVED_ORDER = ["explorer", "preview", "editor"];
const SAVED_WINDOW = { width: 1111, height: 777 };
const SAVED_WIDTHS = { explorer: 321, editor: 432, preview: 543 };
const DEFAULT_ORDER = ["explorer", "editor", "preview"];
const DEFAULT_WINDOW = { width: 800, height: 600 };
const DEFAULT_WIDTHS = { explorer: 240, editor: 400, preview: 400 };

const { layoutMod, storage, rememberEl } = await boot();
const {
  layout,
  persistLayout,
  restoreLayout,
  reorderPanes,
  collapsePane,
  getLayout,
} = layoutMod;

function memoryStorage() {
  const map = new Map();
  return {
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
}

function mockEl(id, tag = "div") {
  const listeners = {};
  const attrs = { id };
  const el = {
    id,
    tagName: String(tag).toUpperCase(),
    checked: tag === "input",
    hidden: false,
    value: "",
    children: [],
    parentNode: null,
    dataset: {},
    className: "",
    classList: {
      add() {},
      remove() {},
      toggle() {},
      contains() {
        return false;
      },
    },
    style: {
      setProperty(name, value) {
        this[name] = String(value);
      },
    },
    addEventListener(type, fn) {
      (listeners[String(type)] ||= []).push(fn);
    },
    dispatchEvent(event) {
      const type = event?.type ?? event;
      const ev =
        event && typeof event === "object"
          ? event
          : { type, target: el, preventDefault() {}, stopPropagation() {} };
      if (ev.target == null) ev.target = el;
      ev.currentTarget = el;
      for (const fn of listeners[String(type)] || []) fn.call(el, ev);
      return true;
    },
    setAttribute(name, value) {
      attrs[String(name)] = String(value);
      if (name === "hidden") el.hidden = true;
    },
    removeAttribute(name) {
      delete attrs[String(name)];
      if (name === "hidden") el.hidden = false;
    },
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null;
    },
    appendChild(child) {
      this.children.push(child);
      child.parentNode = this;
      return child;
    },
    getBoundingClientRect() {
      const width = SAVED_WIDTHS[id] ?? 240;
      return { width, height: 600, top: 0, left: 0, right: width, bottom: 600 };
    },
  };
  return el;
}

function installDom(ls) {
  const byId = new Map();
  function el(id, tag) {
    const key = String(id);
    if (!byId.has(key)) byId.set(key, mockEl(key, tag));
    return byId.get(key);
  }
  el("shell");
  el("explorer");
  el("editor");
  el("preview");
  el("editor-buffer");
  el("editor-view");
  el("preview-body");
  const remember = el("settings-remember-layout", "input");
  remember.checked = true;
  remember.type = "checkbox";

  const doc = {
    documentElement: mockEl("html"),
    body: mockEl("body"),
    getElementById(id) {
      return byId.get(String(id)) || null;
    },
    querySelector(sel) {
      const m = String(sel || "").match(/^#([\w-]+)$/);
      return m ? byId.get(m[1]) || null : null;
    },
    querySelectorAll() {
      return [];
    },
    createElement(tag) {
      return mockEl("", tag);
    },
  };

  globalThis.document = doc;
  globalThis.localStorage = ls;
  globalThis.innerWidth = SAVED_WINDOW.width;
  globalThis.innerHeight = SAVED_WINDOW.height;
  if (!globalThis.addEventListener) globalThis.addEventListener = () => {};
  globalThis.window = globalThis;
  globalThis.window.innerWidth = SAVED_WINDOW.width;
  globalThis.window.innerHeight = SAVED_WINDOW.height;
  return { doc, rememberEl: remember };
}

async function boot() {
  const storage = memoryStorage();
  const { rememberEl } = installDom(storage);
  const layoutHref = pathToFileURL(join(srcDir, "layout.js")).href;
  const settingsHref = pathToFileURL(join(srcDir, "settings.js")).href;
  const layoutMod = await import(layoutHref);
  const settingsMod = await import(settingsHref);
  if (typeof settingsMod.bindSettings === "function") settingsMod.bindSettings();
  return { layoutMod, settingsMod, storage, rememberEl };
}

function parseJson(raw) {
  if (raw == null || raw === "") return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function storageEntries(ls) {
  const out = [];
  const len = ls.length ?? 0;
  for (let i = 0; i < len; i++) {
    const key = ls.key(i);
    if (key == null) continue;
    out.push({ key: String(key), value: ls.getItem(key), parsed: parseJson(ls.getItem(key)) });
  }
  return out;
}

function layoutPayload(ls) {
  const direct = parseJson(ls.getItem(LAYOUT_KEY));
  if (direct && typeof direct === "object") return direct;
  for (const { key, parsed } of storageEntries(ls)) {
    if (!parsed || typeof parsed !== "object") continue;
    if (/layout|pane|window|pref/i.test(key)) return parsed;
    if (parsed.order || parsed.open || parsed.widths || parsed.window || "remember" in parsed) {
      return parsed;
    }
  }
  return direct;
}

function snapshotGeometry(payload, live) {
  const src = payload && typeof payload === "object" ? payload : {};
  const liveSrc = live && typeof live === "object" ? live : {};
  const win = src.window && typeof src.window === "object" ? src.window : src;
  const liveWin = liveSrc.window && typeof liveSrc.window === "object" ? liveSrc.window : {};
  const open = src.open && typeof src.open === "object" ? src.open : liveSrc.open;
  const widths = src.widths && typeof src.widths === "object" ? src.widths : liveSrc.widths;
  return {
    order: Array.isArray(src.order) ? src.order.map(String) : liveSrc.order?.slice?.() ?? null,
    open: open ? { ...open } : null,
    widths: widths ? { ...widths } : null,
    window: {
      width: Number(win.width ?? win.innerWidth ?? liveWin.width),
      height: Number(win.height ?? win.innerHeight ?? liveWin.height),
    },
    remember: typeof src.remember === "boolean" ? src.remember : liveSrc.remember,
  };
}

function resetLiveToDefaults() {
  layout.order = DEFAULT_ORDER.slice();
  layout.open.explorer = true;
  layout.open.editor = true;
  layout.open.preview = true;
  layout.widths.explorer = DEFAULT_WIDTHS.explorer;
  layout.widths.editor = DEFAULT_WIDTHS.editor;
  layout.widths.preview = DEFAULT_WIDTHS.preview;
  layout.window.width = DEFAULT_WINDOW.width;
  layout.window.height = DEFAULT_WINDOW.height;
}

function seedRememberedLayout() {
  storage.clear();
  resetLiveToDefaults();
  layout.remember = true;
  rememberEl.checked = true;
  globalThis.innerWidth = SAVED_WINDOW.width;
  globalThis.innerHeight = SAVED_WINDOW.height;
  globalThis.window.innerWidth = SAVED_WINDOW.width;
  globalThis.window.innerHeight = SAVED_WINDOW.height;
  reorderPanes(SAVED_ORDER.slice());
  collapsePane("explorer", true);
  persistLayout();
  const stored = layoutPayload(storage);
  assert.ok(stored && typeof stored === "object", "precondition: remember-on persist must write a layout payload");
  const snap = snapshotGeometry(stored, getLayout?.() ?? layout);
  assert.deepEqual(snap.order, SAVED_ORDER, "precondition: stored order must be the saved pane order");
  assert.equal(snap.open?.explorer, false, "precondition: stored open.explorer must be false");
  assert.equal(snap.widths?.explorer, SAVED_WIDTHS.explorer, "precondition: stored explorer width must be the saved width");
  assert.equal(snap.window.width, SAVED_WINDOW.width, "precondition: stored window width must be the saved size");
  assert.equal(snap.window.height, SAVED_WINDOW.height, "precondition: stored window height must be the saved size");
  assert.notEqual(snap.remember, false, "precondition: stored remember must not already be false");
  return snap;
}

function turnRememberOff() {
  rememberEl.checked = false;
  rememberEl.dispatchEvent({
    type: "change",
    target: rememberEl,
    bubbles: true,
  });
  layout.remember = false;
  persistLayout();
}

function recordsRememberFalseOrClearsGeometry(ls, prior) {
  const entries = storageEntries(ls);
  if (entries.some((e) => e.parsed && typeof e.parsed === "object" && e.parsed.remember === false)) {
    return true;
  }
  if (entries.length === 0) return true;
  const stored = layoutPayload(ls);
  if (stored == null) return true;
  const snap = snapshotGeometry(stored, {});
  const orderSame = Array.isArray(snap.order) && JSON.stringify(snap.order) === JSON.stringify(prior.order);
  const openSame = snap.open && snap.open.explorer === prior.open.explorer;
  const widthSame = snap.widths && snap.widths.explorer === prior.widths.explorer;
  const windowSame =
    snap.window.width === prior.window.width && snap.window.height === prior.window.height;
  return !orderSame && !openSame && !widthSame && !windowSame;
}

test("after setting remember off, storage records remember:false or clears geometry", () => {
  const prior = seedRememberedLayout();
  turnRememberOff();
  assert.ok(
    recordsRememberFalseOrClearsGeometry(storage, prior),
    "after setting remember off (Settings change or persistLayout API), storage must record remember:false or clear geometry so restore does not reapply prior panes/window",
  );
});

test("restoreLayout after remember off does not reapply saved order/open/widths/window", () => {
  const prior = seedRememberedLayout();
  turnRememberOff();
  resetLiveToDefaults();
  restoreLayout();
  const live = getLayout?.() ?? layout;
  assert.notDeepEqual(
    live.order?.map?.(String) ?? live.order,
    prior.order,
    "restoreLayout after remember off must not reapply previously saved pane order",
  );
  assert.notEqual(
    live.open?.explorer,
    prior.open.explorer,
    "restoreLayout after remember off must not reapply previously saved open/collapsed panes",
  );
  assert.notEqual(
    live.widths?.explorer,
    prior.widths.explorer,
    "restoreLayout after remember off must not reapply previously saved pane widths",
  );
  assert.notEqual(
    live.window?.width,
    prior.window.width,
    "restoreLayout after remember off must not reapply previously saved window width",
  );
  assert.notEqual(
    live.window?.height,
    prior.window.height,
    "restoreLayout after remember off must not reapply previously saved window height",
  );
});
