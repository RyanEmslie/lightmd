import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const layoutPath = join(root, "src", "layout.js");

const PANE_IDS = ["explorer", "editor", "preview"];
const DEFAULT_ORDER = ["explorer", "editor", "preview"];
const STUCK_ORDER = ["explorer", "preview", "editor"];
const DEFAULT_WIDTHS = { explorer: 240, editor: 400, preview: 400 };
const LAYOUT_KEY = "lightmd.layout";
const MIN_PANE = 160;
const DEFAULT_WINDOW = { width: 800, height: 600 };

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
  `${pathToFileURL(layoutPath).href}?splitter-stuck-narrow=${Date.now()}`
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

function windowWidth() {
  const w = globalThis.innerWidth ?? globalThis.window?.innerWidth ?? liveLayout().window?.width;
  const n = Number(w);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_WINDOW.width;
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
  globalThis.innerWidth = DEFAULT_WINDOW.width;
  globalThis.innerHeight = DEFAULT_WINDOW.height;
  installListeners(globalThis);
  globalThis.window = globalThis;
  globalThis.window.innerWidth = DEFAULT_WINDOW.width;
  globalThis.window.innerHeight = DEFAULT_WINDOW.height;

  return { doc, storage, splitters, byId };
}

function useFixture() {
  globalThis.document = doc;
  globalThis.localStorage = storage;
  if (!globalThis.window) globalThis.window = globalThis;
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

function tokenizeGrid(grid) {
  const s = String(grid || "").trim();
  if (!s) return [];
  return s.match(/minmax\s*\([^)]*\)|[^\s]+/gi) || [];
}

function parseTrack(token) {
  const t = String(token || "").trim().toLowerCase().replace(/\s+/g, "");
  const minmax = t.match(/^minmax\(([\d.]+)px,(?:1fr|([\d.]+)px)\)$/);
  if (minmax) {
    const min = Number.parseFloat(minmax[1]);
    return { kind: minmax[2] != null ? "px" : "fr", min, px: minmax[2] != null ? Number.parseFloat(minmax[2]) : 0 };
  }
  const px = t.match(/^([\d.]+)px$/);
  if (px) return { kind: "px", min: 0, px: Number.parseFloat(px[1]) };
  if (t === "1fr" || t === "fr") return { kind: "fr", min: 0, px: 0 };
  if (t === "auto" || t === "minmax(auto,1fr)") return { kind: "fr", min: 0, px: 0 };
  return { kind: "fr", min: 0, px: 0 };
}

function displayedWidths() {
  const live = liveLayout();
  const order = (Array.isArray(live.order) ? live.order : DEFAULT_ORDER).filter((id) =>
    PANE_IDS.includes(id),
  );
  const vis = order.filter((id) => live.open?.[id] !== false);
  const W = windowWidth();
  const tokens = tokenizeGrid(gridOf());
  const sizes = { explorer: 0, editor: 0, preview: 0 };

  if (!vis.length) return sizes;

  const tracks = vis.map((id, i) => {
    const orderIdx = order.indexOf(id);
    const token = tokens[orderIdx] ?? tokens[i];
    if (token) return { id, ...parseTrack(token) };
    const stored = Number(live.widths?.[id]);
    if (Number.isFinite(stored) && stored > 0) return { id, kind: "px", min: 0, px: stored };
    return { id, kind: "fr", min: 0, px: 0 };
  });

  let usedPx = 0;
  const fr = [];
  for (const tr of tracks) {
    if (tr.kind === "px") {
      sizes[tr.id] = tr.px;
      usedPx += tr.px;
    } else {
      fr.push(tr);
    }
  }

  let remain = W - usedPx;
  if (fr.length) {
    const minSum = fr.reduce((sum, tr) => sum + (tr.min || 0), 0);
    if (remain >= minSum) {
      const extra = remain - minSum;
      const each = extra / fr.length;
      for (const tr of fr) sizes[tr.id] = (tr.min || 0) + each;
    } else {
      for (const tr of fr) {
        if (tr.min > 0) {
          sizes[tr.id] = tr.min;
          remain -= tr.min;
        } else {
          sizes[tr.id] = Math.max(0, remain);
          remain = 0;
        }
      }
    }
  } else if (usedPx > W) {
    let left = 0;
    for (const id of vis) {
      const avail = Math.max(0, W - left);
      const want = Number(sizes[id]) || 0;
      sizes[id] = Math.min(want, avail);
      left += sizes[id];
    }
  }

  return sizes;
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
  const before = { ...widthsOf(), grid: gridOf(), shown: displayedWidths() };
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
    const shown = displayedWidths();
    const shownChanged = shown[left] !== before.shown[left] || shown[right] !== before.shown[right];
    if (leftChanged && rightChanged) return { ok: true, before, after, grid: gridOf(), shown };
    if (shownChanged) return { ok: true, before, after, grid: gridOf(), shown };
  }
  restore();
  return { ok: false, before, after: widthsOf(), grid: gridOf(), shown: displayedWidths() };
}

function setWindow(width, height = DEFAULT_WINDOW.height) {
  const w = Number(width);
  const h = Number(height);
  globalThis.innerWidth = w;
  globalThis.innerHeight = h;
  if (!globalThis.window) globalThis.window = globalThis;
  globalThis.window.innerWidth = w;
  globalThis.window.innerHeight = h;
  const live = liveLayout();
  if (live.window && typeof live.window === "object") {
    live.window.width = w;
    live.window.height = h;
  }
}

function resetFixed(live) {
  if (!live.fixed || typeof live.fixed !== "object") live.fixed = {};
  live.fixed.explorer = true;
  live.fixed.editor = false;
  live.fixed.preview = false;
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
  resetFixed(live);
  const width = opts.windowWidth ?? DEFAULT_WINDOW.width;
  const height = opts.windowHeight ?? DEFAULT_WINDOW.height;
  setWindow(width, height);
  setLayout("three-pane");
  if (opts.order && opts.order.join(",") !== DEFAULT_ORDER.join(",")) {
    reorderPanes(opts.order.slice());
  }
  assignWidths({ ...DEFAULT_WIDTHS });
  resetFixed(live);
  applyDom();
}

function visibleIds(live = liveLayout()) {
  return (live.order || DEFAULT_ORDER).filter(
    (id) => PANE_IDS.includes(id) && live.open?.[id] !== false,
  );
}

function assertVisiblePanesUsable(when) {
  const live = liveLayout();
  const vis = visibleIds(live);
  const shown = displayedWidths();
  const stored = widthsOf(live);
  for (const id of vis) {
    const gridW = Number(shown[id]);
    const storedW = Number(stored[id]);
    const usable = Number.isFinite(gridW) ? gridW : storedW;
    assert.ok(
      usable >= MIN_PANE - 0.5,
      `${when}: visible pane ${id} must stay >= ~${MIN_PANE}px (grid/on-screen ${gridW}, layout.widths ${storedW}, grid ${JSON.stringify(gridOf())})`,
    );
    if (Number.isFinite(storedW) && storedW > 0) {
      assert.ok(
        storedW >= MIN_PANE - 0.5,
        `${when}: layout.widths.${id} must stay >= ~${MIN_PANE}px (got ${storedW})`,
      );
    }
  }
}

function editorUsablePx() {
  return Number(displayedWidths().editor);
}

function dragOrThrow(left, right, delta) {
  const picked = pickDragFn(layoutMod);
  assert.ok(picked, "dragSplitter (or equivalent) must be exported");
  picked.fn(left, right, delta);
}

test("explorer|preview|editor: drag explorer|preview must not stick editor narrower than ~160px", () => {
  reset({ order: STUCK_ORDER, windowWidth: DEFAULT_WINDOW.width });
  const live = liveLayout();
  assert.deepEqual(live.order, STUCK_ORDER, "precondition: Order Explorer, preview, editor");
  assert.equal(live.open.explorer, true);
  assert.equal(live.open.preview, true);
  assert.equal(live.open.editor, true);

  assignWidths({ explorer: 280, preview: 500, editor: 400 });
  applyDom();

  const squeeze = tryDrag("explorer", "preview", 280);
  assert.ok(
    squeeze.ok,
    "dragSplitter(explorer, preview, +delta) must run so fixed siblings can take most width",
  );

  const editorAfter = editorUsablePx();
  const stayedUsable = editorAfter >= MIN_PANE - 0.5;

  if (!stayedUsable) {
    dragOrThrow("preview", "editor", -240);
    const editorRecovered = editorUsablePx();
    assert.ok(
      editorRecovered >= MIN_PANE - 0.5,
      `editor was ${editorAfter}px after explorer|preview drag (grid ${JSON.stringify(gridOf())}); dragSplitter(preview, editor, negative delta) must restore editor to >= ~${MIN_PANE}px (got ${editorRecovered}px)`,
    );

    const beforeGrow = editorRecovered;
    dragOrThrow("preview", "editor", -80);
    const grown = editorUsablePx();
    assert.ok(
      grown >= MIN_PANE - 0.5,
      `editor must remain >= ~${MIN_PANE}px while expanding further (got ${grown}px)`,
    );
    assert.ok(
      grown > beforeGrow + 8,
      `editor must stay expandable after recovery (was ${beforeGrow}px, after further drag ${grown}px, grid ${JSON.stringify(gridOf())})`,
    );
  } else {
    const beforeGrow = editorAfter;
    dragOrThrow("preview", "editor", -80);
    const grown = editorUsablePx();
    assert.ok(
      grown >= MIN_PANE - 0.5,
      `editor must remain >= ~${MIN_PANE}px (got ${grown}px, grid ${JSON.stringify(gridOf())})`,
    );
    assert.ok(
      grown > beforeGrow + 8,
      `after explorer|preview drag, editor must remain expandable via dragSplitter(preview, editor, negative delta) (was ${beforeGrow}px, after ${grown}px, grid ${JSON.stringify(gridOf())})`,
    );
  }

  assertVisiblePanesUsable("after explorer|preview squeeze (and optional recovery)");
});

test("after any dragSplitter sequence, every visible pane stays >= ~160px", () => {
  const sequences = [
    {
      name: "default order explorer|editor then editor|preview",
      order: DEFAULT_ORDER,
      windowWidth: DEFAULT_WINDOW.width,
      drags: [
        ["explorer", "editor", 80],
        ["editor", "preview", 80],
      ],
    },
    {
      name: "Order explorer,preview,editor: explorer|preview takes most width",
      order: STUCK_ORDER,
      windowWidth: DEFAULT_WINDOW.width,
      drags: [["explorer", "preview", 400]],
    },
    {
      name: "Order explorer,preview,editor at a tighter window",
      order: STUCK_ORDER,
      windowWidth: 700,
      drags: [
        ["explorer", "preview", 300],
        ["preview", "editor", -120],
      ],
    },
    {
      name: "wide restored pair then explorer|preview drag",
      order: STUCK_ORDER,
      windowWidth: DEFAULT_WINDOW.width,
      seed: { explorer: 300, preview: 500, editor: 400 },
      drags: [["explorer", "preview", 200]],
    },
  ];

  for (const seq of sequences) {
    reset({ order: seq.order, windowWidth: seq.windowWidth });
    if (seq.seed) {
      assignWidths(seq.seed);
      applyDom();
    }
    for (const [left, right, delta] of seq.drags) {
      tryDrag(left, right, delta);
      assertVisiblePanesUsable(`${seq.name} after dragSplitter(${left}, ${right}, ${delta})`);
    }
  }
});

test("remember-on restoreLayout does not restore an open pane narrower than ~160px", () => {
  reset({ remember: true, order: STUCK_ORDER, windowWidth: DEFAULT_WINDOW.width });
  const live = liveLayout();
  live.remember = true;
  storage.setItem(
    LAYOUT_KEY,
    JSON.stringify({
      remember: true,
      order: STUCK_ORDER.slice(),
      open: { explorer: true, editor: true, preview: true },
      collapsed: { explorer: false, editor: false, preview: false },
      widths: { explorer: 520, preview: 420, editor: 40 },
      fixed: { explorer: true, editor: true, preview: true },
      window: { width: DEFAULT_WINDOW.width, height: DEFAULT_WINDOW.height },
    }),
  );
  restoreLayout();
  const restored = liveLayout();
  assert.equal(restored.open.editor, true, "precondition: editor stays open");
  assert.equal(paneIsShown(doc.getElementById("editor")), true, "precondition: editor is visible");
  assertVisiblePanesUsable("restoreLayout of a remembered unusable right pane");

  const shown = displayedWidths();
  assert.ok(
    Number(shown.editor) >= MIN_PANE - 0.5,
    `restoreLayout must clamp or redistribute so editor on-screen width >= ~${MIN_PANE}px (got ${shown.editor}, layout.widths ${restored.widths?.editor}, grid ${JSON.stringify(gridOf())})`,
  );
  assert.ok(
    Number(restored.widths?.editor) >= MIN_PANE - 0.5,
    `restoreLayout must not keep layout.widths.editor < ~${MIN_PANE}px (got ${restored.widths?.editor})`,
  );

  const payload = storedPayload();
  assert.notEqual(payload?.remember, false, "remember-on restore must not flip remember off");
});
