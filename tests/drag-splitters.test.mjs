import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const htmlPath = join(root, "src", "index.html");
const layoutPath = join(root, "src", "layout.js");

const PANE_IDS = ["explorer", "editor", "preview"];
const DEFAULT_ORDER = ["explorer", "editor", "preview"];
const DEFAULT_WIDTHS = { explorer: 240, editor: 400, preview: 400 };
const LAYOUT_KEY = "lightmd.layout";
const MIN_PANE = 160;
const MIN_HIT = 6;
const DRAG_DELTA = 80;

const DRAG_FNS = [
  "dragSplitter",
  "onSplitterPointer",
  "onSplitterPointerDown",
  "handleSplitterPointer",
  "handleSplitterDrag",
  "resizeSplitter",
  "applySplitterDrag",
  "moveSplitter",
];

let layoutRef = {
  order: DEFAULT_ORDER.slice(),
  open: { explorer: true, editor: true, preview: true },
  widths: { ...DEFAULT_WIDTHS },
};

const { doc, storage, splitters } = boot();
const layoutMod = await import(
  `${pathToFileURL(layoutPath).href}?drag-splitters=${Date.now()}`
);
const {
  layout,
  getLayout,
  persistLayout,
  restoreLayout,
  collapsePane,
  setLayout,
  reorderPanes,
} = layoutMod;
layoutRef = getLayout?.() ?? layout ?? layoutRef;

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

function mockClassList(initial = []) {
  const set = new Set(initial);
  return {
    add(...names) {
      for (const n of names) set.add(String(n));
    },
    remove(...names) {
      for (const n of names) set.delete(String(n));
    },
    toggle(name, force) {
      const n = String(name);
      if (force === true) set.add(n);
      else if (force === false) set.delete(n);
      else if (set.has(n)) set.delete(n);
      else set.add(n);
      return set.has(n);
    },
    contains(name) {
      return set.has(String(name));
    },
    get value() {
      return [...set].join(" ");
    },
  };
}

function installListeners(target) {
  const listeners = {};
  target.addEventListener = (type, fn) => {
    if (typeof fn !== "function") return;
    (listeners[String(type)] ||= []).push(fn);
  };
  target.removeEventListener = (type, fn) => {
    const list = listeners[String(type)];
    if (!list) return;
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  };
  target.dispatchEvent = (event) => {
    const type = event?.type ?? event;
    const ev =
      event && typeof event === "object"
        ? event
        : { type, preventDefault() {}, stopPropagation() {} };
    if (ev.target == null) ev.target = target;
    if (ev.currentTarget == null) ev.currentTarget = target;
    if (typeof ev.preventDefault !== "function") ev.preventDefault = () => {};
    if (typeof ev.stopPropagation !== "function") ev.stopPropagation = () => {};
    for (const fn of listeners[String(type)] || []) fn.call(target, ev);
    return true;
  };
  target.__listeners = listeners;
  return listeners;
}

function mockEl(id, extraClass = []) {
  const attrs = { id };
  const listeners = {};
  const el = {
    id,
    tagName: "DIV",
    className: extraClass.join(" "),
    classList: mockClassList(extraClass),
    style: {},
    hidden: false,
    dataset: {},
    children: [],
    parentNode: null,
    textContent: "",
    setPointerCapture() {},
    releasePointerCapture() {},
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
    hasAttribute(name) {
      return Object.prototype.hasOwnProperty.call(attrs, name);
    },
    addEventListener(type, fn) {
      if (typeof fn !== "function") return;
      (listeners[String(type)] ||= []).push(fn);
    },
    removeEventListener(type, fn) {
      const list = listeners[String(type)];
      if (!list) return;
      const i = list.indexOf(fn);
      if (i >= 0) list.splice(i, 1);
    },
    dispatchEvent(event) {
      const type = event?.type ?? event;
      const ev =
        event && typeof event === "object"
          ? event
          : { type, preventDefault() {}, stopPropagation() {} };
      if (ev.target == null) ev.target = el;
      ev.currentTarget = el;
      if (typeof ev.preventDefault !== "function") ev.preventDefault = () => {};
      if (typeof ev.stopPropagation !== "function") ev.stopPropagation = () => {};
      for (const fn of listeners[String(type)] || []) fn.call(el, ev);
      return true;
    },
    appendChild(child) {
      this.children.push(child);
      child.parentNode = this;
      return child;
    },
    insertBefore(child, ref) {
      const i = this.children.indexOf(ref);
      if (i === -1) this.children.push(child);
      else this.children.splice(i, 0, child);
      child.parentNode = this;
      return child;
    },
    getBoundingClientRect() {
      return boundingRectFor(id);
    },
  };
  return el;
}

function mockSplitter(name) {
  const el = mockEl(name, ["splitter"]);
  el.setAttribute("role", "separator");
  el.setAttribute("aria-orientation", "vertical");
  el.dataset.splitter = name;
  return el;
}

function mockToggle(paneId) {
  const attrs = {
    "data-pane-toggle": paneId,
    "aria-pressed": "true",
  };
  return {
    textContent: "Hide",
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(attrs, String(name))
        ? attrs[String(name)]
        : null;
    },
    setAttribute(name, value) {
      attrs[String(name)] = String(value);
    },
    removeAttribute(name) {
      delete attrs[String(name)];
    },
    addEventListener() {},
  };
}

function mockSelect(id, value) {
  const listeners = {};
  const el = {
    id,
    tagName: "SELECT",
    value: String(value),
    hidden: false,
    style: {},
    addEventListener(type, fn) {
      (listeners[String(type)] ||= []).push(fn);
    },
    dispatchEvent(event) {
      const type = event?.type ?? event;
      const ev = event && typeof event === "object" ? event : { type };
      if (ev.target == null) ev.target = el;
      for (const fn of listeners[String(type)] || []) fn.call(el, ev);
      return true;
    },
    setAttribute() {},
    getAttribute() {
      return null;
    },
  };
  return el;
}

function liveLayout() {
  try {
    return getLayout?.() ?? layout ?? layoutRef;
  } catch {
    return layoutRef;
  }
}

function boundingRectFor(id) {
  const live = liveLayout();
  const order = Array.isArray(live.order) ? live.order : DEFAULT_ORDER;
  let left = 0;
  for (const paneId of order) {
    const open = live.open?.[paneId] !== false;
    const width = open ? Number(live.widths?.[paneId]) || DEFAULT_WIDTHS[paneId] || 240 : 0;
    if (paneId === id) {
      return { width, height: 600, top: 0, left, right: left + width, bottom: 600 };
    }
    if (String(id).includes(paneId) && String(id).includes("splitter")) {
      return { width: 1, height: 600, top: 0, left: left + width, right: left + width + 1, bottom: 600 };
    }
    left += width;
  }
  if (String(id).includes("splitter")) {
    return { width: 1, height: 600, top: 0, left: 240, right: 241, bottom: 600 };
  }
  const width = Number(live.widths?.[id]) || 240;
  return { width, height: 600, top: 0, left: 0, right: width, bottom: 600 };
}

function boot() {
  const storage = memoryStorage();
  const byId = new Map();
  const toggles = [];
  const splitters = [];
  const shell = mockEl("shell");
  byId.set("shell", shell);

  for (const id of PANE_IDS) {
    const pane = mockEl(id, ["pane"]);
    byId.set(id, pane);
    shell.appendChild(pane);
    toggles.push(mockToggle(id));
    toggles.push(mockToggle(id));
  }

  const splitterA = mockSplitter("splitter-0");
  const splitterB = mockSplitter("splitter-1");
  splitters.push(splitterA, splitterB);
  byId.get("explorer").appendChild(splitterA);
  byId.get("editor").appendChild(splitterB);

  byId.set("pane-layout", mockSelect("pane-layout", "three-pane"));
  byId.set("pane-order", mockSelect("pane-order", DEFAULT_ORDER.join(",")));
  byId.set("editor-buffer", mockEl("editor-buffer"));
  byId.set("editor-view", mockEl("editor-view"));
  byId.set("preview-body", mockEl("preview-body"));

  const docListeners = {};
  const doc = {
    getElementById(id) {
      return byId.get(String(id)) || null;
    },
    querySelector(sel) {
      const id = String(sel || "").match(/^#([\w-]+)$/);
      if (id) return byId.get(id[1]) || null;
      if (/\.splitter|role=["']separator["']/.test(String(sel))) return splitters[0] || null;
      return null;
    },
    querySelectorAll(sel) {
      const s = String(sel);
      if (s === "[data-pane-toggle]") return toggles.slice();
      if (/\.splitter/.test(s) || /role=["']separator["']/.test(s)) return splitters.slice();
      return [];
    },
    createElement(tag) {
      return mockEl("", [String(tag)]);
    },
    addEventListener(type, fn) {
      (docListeners[String(type)] ||= []).push(fn);
    },
    removeEventListener(type, fn) {
      const list = docListeners[String(type)];
      if (!list) return;
      const i = list.indexOf(fn);
      if (i >= 0) list.splice(i, 1);
    },
    dispatchEvent(event) {
      const type = event?.type ?? event;
      const ev = event && typeof event === "object" ? event : { type };
      for (const fn of docListeners[String(type)] || []) fn.call(doc, ev);
      return true;
    },
  };

  globalThis.document = doc;
  globalThis.localStorage = storage;
  globalThis.innerWidth = 800;
  globalThis.innerHeight = 600;
  installListeners(globalThis);
  globalThis.window = globalThis;
  globalThis.window.innerWidth = 800;
  globalThis.window.innerHeight = 600;

  return { doc, storage, splitters, byId };
}

function useFixture() {
  globalThis.document = doc;
  globalThis.localStorage = storage;
  if (!globalThis.window) globalThis.window = globalThis;
}

function loadHtml() {
  assert.equal(existsSync(htmlPath), true, "src/index.html must exist");
  return readFileSync(htmlPath, "utf8");
}

function stripComments(src) {
  return String(src || "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function cssFromHtml(html) {
  const chunks = [];
  const re = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
  let m;
  while ((m = re.exec(html))) chunks.push(m[1]);
  return chunks.join("\n");
}

function parseDecls(body) {
  const map = {};
  for (const part of String(body || "").split(";")) {
    const i = part.indexOf(":");
    if (i < 0) continue;
    const key = part.slice(0, i).trim().toLowerCase();
    const value = part.slice(i + 1).trim();
    if (key) map[key] = value;
  }
  return map;
}

function cssRules(css) {
  const cleaned = stripComments(css);
  const rules = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(cleaned))) {
    rules.push({ selector: m[1].replace(/@[\w-]+[^{]*/g, "").trim(), body: m[2] });
  }
  return rules;
}

function rootVars(css) {
  const vars = {};
  for (const rule of cssRules(css)) {
    if (!/:root\b/.test(rule.selector)) continue;
    const decls = parseDecls(rule.body);
    for (const [k, v] of Object.entries(decls)) {
      if (k.startsWith("--")) vars[k] = v;
    }
  }
  return vars;
}

function resolveValue(value, vars, depth = 0) {
  if (depth > 5) return String(value || "");
  return String(value || "").replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^)]*))?\)/g, (_, name, fallback) => {
    if (vars[name] != null) return resolveValue(vars[name], vars, depth + 1);
    return fallback != null ? resolveValue(fallback, vars, depth + 1) : "";
  });
}

function px(value, vars = {}) {
  const raw = resolveValue(value, vars).trim();
  const m = raw.match(/^(-?\d*\.?\d+)(px|rem)?$/i);
  if (!m) return null;
  const n = Number.parseFloat(m[1]);
  if (!Number.isFinite(n)) return null;
  if (String(m[2] || "px").toLowerCase() === "rem") return n * 16;
  return n;
}

function isSplitterSelector(selector) {
  return String(selector)
    .split(",")
    .some((part) => {
      const s = part.trim();
      return /(^|[\s>+~])\.splitter\b/.test(s) || /\[role=["']separator["']\]/.test(s);
    });
}

function splitterRules(css) {
  return cssRules(css).filter((rule) => isSplitterSelector(rule.selector));
}

function paddingX(decls, vars) {
  const inline = px(decls["padding-inline"], vars);
  if (inline != null) return inline * 2;
  const left = px(decls["padding-left"], vars);
  const right = px(decls["padding-right"], vars);
  if (left != null || right != null) return (left ?? 0) + (right ?? 0);
  const pad = String(decls.padding || "").trim();
  if (!pad) return 0;
  const parts = pad.split(/\s+/).map((p) => px(p, vars));
  if (parts.length === 1 && parts[0] != null) return parts[0] * 2;
  if (parts.length >= 2 && parts[1] != null) return parts[1] * 2;
  return 0;
}

function insetExtraX(decls, vars) {
  const inset = String(decls.inset || "").trim();
  if (inset) {
    const parts = inset.split(/\s+/);
    if (parts.length === 2 || parts.length === 4) {
      const right = px(parts[1], vars);
      const left = parts.length === 4 ? px(parts[3], vars) : px(parts[1], vars);
      if (left != null && right != null) return Math.abs(left) + Math.abs(right);
    }
  }
  const left = px(decls.left, vars);
  const right = px(decls.right, vars);
  if (left != null && right != null && (left < 0 || right < 0)) {
    return Math.abs(Math.min(0, left)) + Math.abs(Math.min(0, right));
  }
  return 0;
}

function hitPxFromDecls(decls, vars) {
  const width = px(decls.width, vars) ?? 0;
  const minWidth = px(decls["min-width"], vars) ?? 0;
  const pad = paddingX(decls, vars);
  const extra = insetExtraX(decls, vars);
  const borderBox = /border-box/i.test(String(decls["box-sizing"] || ""));
  const content = borderBox ? Math.max(width, minWidth) : Math.max(width, minWidth) + pad;
  return Math.max(content, minWidth, extra + (width || 0), borderBox ? width : width + pad);
}

function splitterHitTargetPx(css) {
  const vars = rootVars(css);
  let best = 0;
  for (const rule of splitterRules(css)) {
    best = Math.max(best, hitPxFromDecls(parseDecls(rule.body), vars));
  }
  return best;
}

function splitterHasResizeCursor(css) {
  return splitterRules(css).some((rule) =>
    /cursor\s*:\s*(col-resize|ew-resize)\b/i.test(rule.body),
  );
}

function paneIsShown(el) {
  if (!el) return false;
  if (el.hidden) return false;
  if (el.getAttribute?.("hidden") != null) return false;
  if (el.classList?.contains?.("collapsed")) return false;
  if (el.classList?.contains?.("closed")) return false;
  if (el.classList?.contains?.("hidden")) return false;
  if (el.classList?.contains?.("is-collapsed")) return false;
  return true;
}

function storedPayload() {
  const raw = storage.getItem(LAYOUT_KEY);
  if (raw == null || raw === "") return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function widthsOf(live = liveLayout()) {
  return {
    explorer: Number(live.widths?.explorer),
    editor: Number(live.widths?.editor),
    preview: Number(live.widths?.preview),
  };
}

function gridOf() {
  return String(doc.getElementById("shell")?.style?.gridTemplateColumns || "").trim();
}

function pickDragFn(mod) {
  for (const name of DRAG_FNS) {
    if (typeof mod[name] === "function") return { name, fn: mod[name] };
  }
  return null;
}

function visiblePairs(live = liveLayout()) {
  const vis = (live.order || DEFAULT_ORDER).filter(
    (id) => PANE_IDS.includes(id) && live.open?.[id] !== false,
  );
  const pairs = [];
  for (let i = 0; i < vis.length - 1; i++) pairs.push([vis[i], vis[i + 1]]);
  return pairs;
}

function firePointer(target, type, clientX, extra = {}) {
  if (!target || typeof target.dispatchEvent !== "function") return;
  const ev = {
    type,
    clientX,
    clientY: 120,
    pageX: clientX,
    pageY: 120,
    buttons: /up|end/.test(type) ? 0 : 1,
    button: 0,
    pointerId: 1,
    pointerType: "mouse",
    bubbles: true,
    cancelable: true,
    target,
    currentTarget: target,
    preventDefault() {},
    stopPropagation() {},
    stopImmediatePropagation() {},
    ...extra,
  };
  target.dispatchEvent(ev);
}

function pointerDrag(left, right, delta) {
  const live = liveLayout();
  const leftEl = doc.getElementById(left);
  const startX = leftEl?.getBoundingClientRect?.()?.right ?? 240;
  const endX = startX + delta;
  const inner =
    leftEl?.children?.find?.((c) => /\bsplitter\b/.test(c.className || c.classList?.value || "")) ||
    null;
  const indexed = splitters[visiblePairs(live).findIndex(([a, b]) => a === left && b === right)];
  const targets = [inner, indexed, ...splitters].filter(Boolean);
  const sequences = [
    ["pointerdown", "pointermove", "pointerup"],
    ["mousedown", "mousemove", "mouseup"],
  ];
  for (const target of targets) {
    for (const [down, move, up] of sequences) {
      firePointer(target, down, startX);
      firePointer(target, move, endX, { movementX: delta });
      firePointer(doc, move, endX, { movementX: delta });
      firePointer(globalThis, move, endX, { movementX: delta });
      firePointer(target, up, endX);
      firePointer(doc, up, endX);
      firePointer(globalThis, up, endX);
    }
  }
}

function assignWidths(next) {
  const live = liveLayout();
  for (const id of PANE_IDS) {
    if (next[id] != null) live.widths[id] = next[id];
  }
}

function applyDom() {
  const live = liveLayout();
  setLayout({
    open: { ...live.open },
    order: Array.isArray(live.order) ? live.order.slice() : DEFAULT_ORDER.slice(),
  });
}

function tryDrag(left, right, delta) {
  const before = { ...widthsOf(), grid: gridOf() };
  const restore = () => {
    assignWidths({
      explorer: before.explorer,
      editor: before.editor,
      preview: before.preview,
    });
    applyDom();
  };

  const picked = pickDragFn(layoutMod);
  const attempts = [];
  if (picked) {
    const fn = picked.fn;
    attempts.push(() => fn(left, right, delta));
    attempts.push(() => fn({ left, right, deltaX: delta, delta }));
    attempts.push(() => fn(left, right, { deltaX: delta, delta }));
    const idx = visiblePairs().findIndex(([a, b]) => a === left && b === right);
    if (idx >= 0) attempts.push(() => fn(idx, delta));
    attempts.push(() => fn(left, delta));
  }
  attempts.push(() => pointerDrag(left, right, delta));

  for (const attempt of attempts) {
    restore();
    try {
      attempt();
    } catch {
      continue;
    }
    const after = widthsOf();
    const leftChanged = after[left] !== before[left];
    const rightChanged = after[right] !== before[right];
    if (leftChanged && rightChanged) return { ok: true, before, after, grid: gridOf() };
  }
  restore();
  return { ok: false, before, after: widthsOf(), grid: gridOf() };
}

function reset(opts = {}) {
  useFixture();
  storage.clear();
  const live = liveLayout();
  live.remember = opts.remember !== false;
  live.order = (opts.order || DEFAULT_ORDER).slice();
  live.open.explorer = true;
  live.open.editor = true;
  live.open.preview = true;
  live.widths.explorer = DEFAULT_WIDTHS.explorer;
  live.widths.editor = DEFAULT_WIDTHS.editor;
  live.widths.preview = DEFAULT_WIDTHS.preview;
  live.window.width = 800;
  live.window.height = 600;
  globalThis.innerWidth = 800;
  globalThis.innerHeight = 600;
  setLayout("three-pane");
  if (opts.order && opts.order.join(",") !== DEFAULT_ORDER.join(",")) {
    reorderPanes(opts.order.slice());
  }
  assignWidths({ ...DEFAULT_WIDTHS });
  applyDom();
  if (opts.remember === false) {
    live.remember = false;
    persistLayout();
  }
}

test("splitters have a clear drag hit target and col-resize cursor", () => {
  const html = loadHtml();
  const css = cssFromHtml(html);
  const found = [
    ...(html.match(/class=["'][^"']*\bsplitter\b[^"']*["']/g) ?? []),
    ...(html.match(/role=["']separator["']/g) ?? []),
  ];
  assert.ok(found.length >= 2, "two vertical splitters are required between panes");
  const hit = splitterHitTargetPx(css);
  assert.ok(
    hit >= MIN_HIT,
    `splitter drag hit target must be at least ${MIN_HIT}px (padding, ::before/::after inset, or min-width); a decorative 1px .splitter is not a usable hit target (got ${hit}px)`,
  );
  assert.equal(
    splitterHasResizeCursor(css),
    true,
    "splitter CSS (or ::before/::after) must set cursor: col-resize (or ew-resize)",
  );
});

test("dragSplitter / onSplitterPointer updates adjacent widths, grid columns, and min ~160px", () => {
  reset();
  const live = liveLayout();
  assert.equal(typeof persistLayout, "function");
  assert.equal(typeof getLayout, "function");

  const first = tryDrag("explorer", "editor", DRAG_DELTA);
  assert.ok(
    first.ok,
    "dragSplitter(left, right, deltaX) / onSplitterPointer / equivalent pointer path must update layout.widths for both adjacent visible panes",
  );
  assert.notEqual(first.after.explorer, first.before.explorer, "explorer width must change");
  assert.notEqual(first.after.editor, first.before.editor, "editor width must change");
  assert.ok(
    first.after.explorer > first.before.explorer,
    "positive delta must grow the left (earlier in Order) pane",
  );
  assert.ok(
    Math.abs(first.after.explorer - first.before.explorer) >= 20,
    `drag of ${DRAG_DELTA}px must move the left pane by a visible amount`,
  );
  assert.notEqual(
    first.grid,
    first.before.grid,
    "shell grid-template-columns must change when a splitter is dragged",
  );
  assert.match(
    first.grid,
    new RegExp(String(Math.round(first.after.explorer))),
    "grid columns must include the dragged pane's pixel width",
  );

  reset();
  const second = tryDrag("editor", "preview", DRAG_DELTA);
  assert.ok(
    second.ok,
    "dragging the splitter between editor and preview must update both adjacent layout.widths (not only explorer px + 1fr 1fr)",
  );
  assert.notEqual(second.after.editor, second.before.editor);
  assert.notEqual(second.after.preview, second.before.preview);
  assert.notEqual(
    second.grid,
    "240px 1fr 1fr",
    "editor|preview drag must change grid columns away from the default 240px 1fr 1fr",
  );

  reset();
  const grew = tryDrag("explorer", "editor", DRAG_DELTA);
  assert.ok(grew.ok, "precondition: positive drag must work before min-width clamp");
  const shrunk = tryDrag("explorer", "editor", -500);
  assert.ok(
    shrunk.ok || liveLayout().widths.explorer !== grew.after.explorer,
    "negative drag must run so min width can be enforced",
  );
  const explorerW = liveLayout().widths.explorer;
  assert.ok(
    explorerW >= MIN_PANE - 0.5,
    `cannot drag below min width ~${MIN_PANE}px without Hide (got ${explorerW})`,
  );
  assert.ok(
    explorerW < 200,
    `huge negative drag must shrink toward min ~${MIN_PANE}px, not ignore the drag (got ${explorerW})`,
  );
  assert.equal(live.open.explorer, true, "min-width clamp must not Hide/collapse the pane");
  assert.equal(paneIsShown(doc.getElementById("explorer")), true, "clamped pane stays visible");
});

test("with remember layout on, persistLayout stores dragged widths and restoreLayout reloads them", () => {
  reset({ remember: true });
  const drag = tryDrag("explorer", "editor", DRAG_DELTA);
  assert.ok(drag.ok, "precondition: drag must update live widths before persist");
  const live = liveLayout();
  live.remember = true;
  persistLayout();
  const stored = storedPayload();
  assert.ok(stored && typeof stored === "object", "persistLayout must write lightmd.layout");
  assert.notEqual(stored.remember, false, "remember-on persist must not record remember:false");
  assert.equal(
    Number(stored.widths?.explorer),
    Number(live.widths.explorer),
    "persistLayout must store the dragged explorer width",
  );
  assert.equal(
    Number(stored.widths?.editor),
    Number(live.widths.editor),
    "persistLayout must store the dragged editor width",
  );
  const dragged = { ...widthsOf(live) };
  assignWidths({ ...DEFAULT_WIDTHS });
  assert.equal(live.widths.explorer, DEFAULT_WIDTHS.explorer, "precondition: live widths reset");
  restoreLayout();
  const restored = liveLayout();
  assert.equal(
    Number(restored.widths.explorer),
    dragged.explorer,
    "restoreLayout must reload dragged explorer width",
  );
  assert.equal(
    Number(restored.widths.editor),
    dragged.editor,
    "restoreLayout must reload dragged editor width",
  );
});

test("with remember off, drag updates live widths but restore does not reapply sticky custom widths", () => {
  reset({ remember: false });
  const live = liveLayout();
  live.remember = false;
  const drag = tryDrag("explorer", "editor", DRAG_DELTA);
  assert.ok(
    drag.ok,
    "with remember off, drag must still update live in-session layout.widths",
  );
  assert.notEqual(
    live.widths.explorer,
    DEFAULT_WIDTHS.explorer,
    "remember-off drag must change live explorer width this session",
  );
  const custom = { ...widthsOf(live) };
  persistLayout();
  const stored = storedPayload();
  const storedCustom =
    stored &&
    stored.remember !== false &&
    Number(stored.widths?.explorer) === custom.explorer;
  assert.equal(
    storedCustom,
    false,
    "remember off must not persist sticky custom widths (existing #65: remember:false or cleared geometry)",
  );
  assignWidths({ ...DEFAULT_WIDTHS });
  restoreLayout();
  const after = liveLayout();
  assert.notEqual(
    Number(after.widths.explorer),
    custom.explorer,
    "restoreLayout after remember off must not reapply sticky custom widths",
  );
  assert.equal(
    Number(after.widths.explorer),
    DEFAULT_WIDTHS.explorer,
    "restoreLayout after remember off leaves session defaults, not the dragged widths",
  );
});

test("hidden panes are skipped; splitters follow visible adjacent panes across at least two orders", () => {
  const orders = [
    ["explorer", "editor", "preview"],
    ["preview", "editor", "explorer"],
  ];
  for (const order of orders) {
    reset({ order });
    const [a, b, c] = order;
    const allOpen = tryDrag(a, b, DRAG_DELTA);
    assert.ok(
      allOpen.ok,
      `order ${order.join("|")}: drag between the first two visible panes must update both widths`,
    );
    assert.notEqual(allOpen.after[a], allOpen.before[a], `${a} width must change`);
    assert.notEqual(allOpen.after[b], allOpen.before[b], `${b} width must change`);

    reset({ order });
    collapsePane(c, true);
    const hiddenWidth = liveLayout().widths[c];
    const pair = visiblePairs();
    assert.equal(
      pair.length,
      1,
      `order ${order.join("|")} with ${c} hidden: exactly one splitter pair between remaining visible panes`,
    );
    assert.deepEqual(pair[0], [a, b]);
    const skipped = tryDrag(a, b, DRAG_DELTA);
    assert.ok(
      skipped.ok,
      `order ${order.join("|")}: splitter between remaining visible panes ${a}|${b} must still drag`,
    );
    assert.equal(liveLayout().open[c], false, `hidden ${c} must stay hidden`);
    assert.equal(
      liveLayout().widths[c],
      hiddenWidth,
      `drag must not change hidden pane ${c} width`,
    );
    assert.equal(paneIsShown(doc.getElementById(c)), false, `#${c} stays collapsed/hidden`);

    reset({ order });
    collapsePane(b, true);
    const middleHidden = liveLayout().widths[b];
    const across = visiblePairs();
    assert.equal(
      across.length,
      1,
      `order ${order.join("|")} with middle ${b} hidden: skip it and split the two visible panes`,
    );
    assert.deepEqual(across[0], [a, c]);
    const jumped = tryDrag(a, c, DRAG_DELTA);
    assert.ok(
      jumped.ok,
      `order ${order.join("|")}: hidden middle pane is skipped; drag ${a}|${c}`,
    );
    assert.equal(liveLayout().open[b], false, `middle ${b} stays hidden`);
    assert.equal(liveLayout().widths[b], middleHidden, `hidden middle ${b} width unchanged`);
  }

  reset();
  setLayout("editor-preview");
  assert.equal(liveLayout().open.explorer, false, "precondition: editor-preview hides explorer");
  const ep = tryDrag("editor", "preview", DRAG_DELTA);
  assert.ok(
    ep.ok,
    "editor-preview (explorer hidden) still has a draggable splitter between editor and preview",
  );
  assert.equal(liveLayout().open.explorer, false);
});

test("existing collapse/Hide and editor-preview layout still work", () => {
  reset();
  collapsePane("explorer", true);
  const live = liveLayout();
  assert.equal(live.open.explorer, false, "collapsePane(explorer, true) still hides explorer");
  assert.equal(paneIsShown(doc.getElementById("explorer")), false, "#explorer is collapsed/hidden");
  assert.equal(live.open.editor, true);
  assert.equal(live.open.preview, true);
  collapsePane("explorer", false);
  assert.equal(live.open.explorer, true, "collapsePane(explorer, false) still shows explorer");
  assert.equal(paneIsShown(doc.getElementById("explorer")), true);

  setLayout("editor-preview");
  assert.equal(live.open.explorer, false, 'setLayout("editor-preview") still closes explorer');
  assert.equal(live.open.editor, true);
  assert.equal(live.open.preview, true);
  assert.equal(paneIsShown(doc.getElementById("explorer")), false);
  assert.equal(paneIsShown(doc.getElementById("editor")), true);
  assert.equal(paneIsShown(doc.getElementById("preview")), true);

  setLayout("three-pane");
  assert.equal(live.open.explorer, true, 'setLayout("three-pane") still restores explorer');
  assert.equal(live.open.editor, true);
  assert.equal(live.open.preview, true);
  for (const id of PANE_IDS) {
    assert.equal(paneIsShown(doc.getElementById(id)), true, `#${id} visible in three-pane`);
  }
});
