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
const SIDEBAR_IDS = ["sidebar-toggle", "nav-toggle", "toggle-sidebar", "toggle-nav"];
const SIDEBAR_NAME_RE = /\b(?:toggle\s+)?sidebar\b|\btoggle\s+nav\b/i;
const HIDE_SHOW_RE = /^(hide|show)$/i;
const EXPLORER_OFF_LEFT = [
  ["editor", "explorer", "preview"],
  ["editor", "preview", "explorer"],
  ["preview", "explorer", "editor"],
  ["preview", "editor", "explorer"],
];

const layoutRef = { current: null };

const html = loadHtml();
const fixture = installFixture(html);
const {
  collapsePane,
  setLayout,
  getLayout,
  reorderPanes,
  persistLayout,
  restoreLayout,
  layout,
} = await import(
  `${pathToFileURL(layoutPath).href}?nav-sidebar-toggle=${Date.now()}`
);
layoutRef.current = getLayout?.() ?? layout ?? null;

function loadHtml() {
  assert.equal(existsSync(htmlPath), true, "src/index.html must exist");
  return readFileSync(htmlPath, "utf8");
}

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

function parseAttrs(raw) {
  const attrs = {};
  const s = String(raw || "");
  const re = /([:@]?[\w-]+)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let m;
  while ((m = re.exec(s))) {
    attrs[m[1].toLowerCase()] = m[3] ?? m[4] ?? m[5] ?? "";
  }
  return attrs;
}

function parseSelectOptions(inner) {
  const out = [];
  const re = /<option\b([^>]*)>([\s\S]*?)<\/option>/gi;
  let m;
  while ((m = re.exec(inner))) {
    const attrs = parseAttrs(m[1]);
    const label = m[2].replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
    out.push({
      value: attrs.value ?? "",
      label,
      selected: Object.prototype.hasOwnProperty.call(attrs, "selected"),
    });
  }
  return out;
}

function selectInner(src, id) {
  const m = String(src).match(
    new RegExp(`<select\\b[^>]*\\bid=["']${id}["'][^>]*>([\\s\\S]*?)</select>`, "i"),
  );
  return m ? m[1] : "";
}

function parseButtons(src) {
  const out = [];
  const re = /<button\b([^>]*)>([\s\S]*?)<\/button>/gi;
  let m;
  while ((m = re.exec(String(src || "")))) {
    const attrs = parseAttrs(m[1]);
    const inner = m[2];
    const text = inner.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
    out.push({
      attrs,
      inner,
      text,
      html: m[0],
      index: m.index,
    });
  }
  return out;
}

function taggedById(src, id) {
  const block = new RegExp(
    `<([a-zA-Z][\\w-]*)\\b[^>]*\\bid=["']${id}["'][^>]*>([\\s\\S]*?)</\\1>`,
    "i",
  );
  const m = String(src).match(block);
  if (m) return { id, tag: m[1], inner: m[2], full: m[0], index: m.index };
  return null;
}

function chromeHtml(src) {
  let out = String(src);
  for (const id of PANE_IDS) {
    const tagged = taggedById(out, id);
    if (!tagged) continue;
    out = out.replace(tagged.full, `<${tagged.tag} id="${id}"></${tagged.tag}>`);
  }
  return out;
}

function namesOf(elOrBtn) {
  if (!elOrBtn) return "";
  if (elOrBtn.attrs) {
    return [
      elOrBtn.attrs.id,
      elOrBtn.attrs["aria-label"],
      elOrBtn.attrs.title,
      elOrBtn.attrs.class,
      elOrBtn.text,
    ]
      .filter(Boolean)
      .join(" ");
  }
  return [
    elOrBtn.id,
    elOrBtn.getAttribute?.("aria-label"),
    elOrBtn.getAttribute?.("title"),
    elOrBtn.title,
    elOrBtn.className,
    elOrBtn.classList?.value,
    elOrBtn.textContent,
  ]
    .filter(Boolean)
    .join(" ");
}

function isPlainExplorerHide(elOrBtn) {
  const pane = elOrBtn.attrs
    ? elOrBtn.attrs["data-pane-toggle"]
    : elOrBtn.getAttribute?.("data-pane-toggle");
  const text = elOrBtn.attrs
    ? elOrBtn.text
    : (elOrBtn.textContent || "").replace(/\s+/g, " ").trim();
  const inner = elOrBtn.inner ?? elOrBtn.innerHTML ?? "";
  if (pane !== "explorer") return false;
  if (!HIDE_SHOW_RE.test(String(text || "").trim())) return false;
  if (/<svg\b|<img\b|<i\b/i.test(inner)) return false;
  return true;
}

function hasCursorLikeAffordance(elOrBtn) {
  if (!elOrBtn || isPlainExplorerHide(elOrBtn)) return false;
  const inner = String(elOrBtn.inner ?? elOrBtn.innerHTML ?? "");
  const text = String(
    elOrBtn.attrs ? elOrBtn.text : (elOrBtn.textContent || ""),
  )
    .replace(/\s+/g, " ")
    .trim();
  const cls = String(
    elOrBtn.attrs ? elOrBtn.attrs.class || "" : elOrBtn.className || elOrBtn.classList?.value || "",
  );
  const id = elOrBtn.attrs ? elOrBtn.attrs.id || "" : elOrBtn.id || "";
  if (/<svg\b|<img\b|<i\b/i.test(inner)) return true;
  if (/\b(?:icon|codicon|sidebar-toggle|toggle-sidebar|nav-toggle)\b/i.test(`${cls} ${id}`)) {
    return !HIDE_SHOW_RE.test(text);
  }
  if (elOrBtn.attrs?.["data-icon"] || elOrBtn.getAttribute?.("data-icon")) return true;
  if (text === "" && SIDEBAR_NAME_RE.test(namesOf(elOrBtn))) return true;
  return false;
}

function isSidebarToggleCandidate(elOrBtn) {
  if (!elOrBtn || isPlainExplorerHide(elOrBtn)) return false;
  const id = elOrBtn.attrs ? elOrBtn.attrs.id || "" : elOrBtn.id || "";
  if (SIDEBAR_IDS.includes(String(id))) return true;
  if (SIDEBAR_NAME_RE.test(namesOf(elOrBtn))) return true;
  return false;
}

function liveLayout() {
  try {
    return getLayout?.() ?? layout ?? layoutRef.current;
  } catch {
    return layoutRef.current;
  }
}

function boundingRectFor(id) {
  const live = liveLayout() || {
    order: DEFAULT_ORDER.slice(),
    open: { explorer: true, editor: true, preview: true },
    widths: { ...DEFAULT_WIDTHS },
  };
  const order = Array.isArray(live.order) ? live.order.map(String) : DEFAULT_ORDER.slice();
  const seq =
    order.includes("explorer") || live.open?.explorer === false
      ? order
      : ["explorer", ...order];
  let left = 0;
  for (const paneId of seq) {
    const open = live.open?.[paneId] !== false;
    const width = open ? Number(live.widths?.[paneId]) || DEFAULT_WIDTHS[paneId] || 240 : 0;
    if (paneId === id) {
      return { width, height: 600, top: 0, left, right: left + width, bottom: 600 };
    }
    left += width;
  }
  const width = Number(live.widths?.[id]) || 240;
  return { width, height: 600, top: 0, left: 0, right: width, bottom: 600 };
}

function mockEl(id, extraClass = [], tag = "div") {
  const listeners = {};
  const attrs = {};
  if (id) attrs.id = String(id);
  const classList = mockClassList(extraClass);
  const el = {
    id: id ? String(id) : "",
    tagName: String(tag).toUpperCase(),
    className: extraClass.join(" "),
    classList,
    style: {},
    hidden: false,
    textContent: "",
    innerHTML: "",
    title: "",
    value: "",
    dataset: {},
    children: [],
    parentNode: null,
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
          : { type, target: el, preventDefault() {}, stopPropagation() {} };
      if (ev.target == null) ev.target = el;
      ev.currentTarget = el;
      for (const fn of listeners[String(type)] || []) fn.call(el, ev);
      return true;
    },
    click() {
      this.dispatchEvent({ type: "click", target: el, preventDefault() {}, stopPropagation() {} });
    },
    setAttribute(name, value) {
      const key = String(name);
      attrs[key] = String(value);
      if (key === "hidden") el.hidden = true;
      if (key === "id") el.id = String(value);
      if (key === "title") el.title = String(value);
      if (key === "class") {
        el.className = String(value);
        for (const n of String(value).split(/\s+/).filter(Boolean)) classList.add(n);
      }
    },
    removeAttribute(name) {
      const key = String(name);
      delete attrs[key];
      if (key === "hidden") el.hidden = false;
    },
    getAttribute(name) {
      const key = String(name);
      return Object.prototype.hasOwnProperty.call(attrs, key) ? attrs[key] : null;
    },
    hasAttribute(name) {
      return Object.prototype.hasOwnProperty.call(attrs, String(name));
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
      return boundingRectFor(el.id);
    },
  };
  return el;
}

function mockOption(value, label, selected = false) {
  return {
    value: String(value),
    textContent: String(label),
    text: String(label),
    label: String(label),
    selected: !!selected,
    getAttribute(name) {
      if (String(name) === "value") return String(value);
      return null;
    },
  };
}

function mockSelect(id, optionSpecs) {
  const listeners = {};
  const options = optionSpecs.map((o) => mockOption(o.value, o.label, o.selected));
  const selected = optionSpecs.find((o) => o.selected) || optionSpecs[0];
  const attrs = { id };
  const el = {
    id,
    tagName: "SELECT",
    value: selected ? String(selected.value) : "",
    options,
    children: options.slice(),
    hidden: false,
    style: {},
    classList: mockClassList(),
    addEventListener(type, fn) {
      if (typeof fn !== "function") return;
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
    },
    removeAttribute(name) {
      delete attrs[String(name)];
    },
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(attrs, String(name))
        ? attrs[String(name)]
        : null;
    },
    querySelectorAll(sel) {
      if (String(sel).trim() === "option") return options.slice();
      return [];
    },
    appendChild(child) {
      this.children.push(child);
      if (child && child.value != null) options.push(child);
      return child;
    },
  };
  return el;
}

function mockToggle(paneId) {
  const el = mockEl("", [], "button");
  el.setAttribute("type", "button");
  el.setAttribute("data-pane-toggle", paneId);
  el.setAttribute("aria-pressed", "true");
  el.textContent = "Hide";
  return el;
}

function attrSelectorMatch(el, sel) {
  const s = String(sel || "").trim();
  const id = s.match(/^#([\w-]+)$/);
  if (id) return el.id === id[1];
  const attrEq = s.match(/^\[([\w-]+)=["']?([^"'\]]+)["']?\]$/);
  if (attrEq) return el.getAttribute?.(attrEq[1]) === attrEq[2];
  const attrHas = s.match(/^\[([\w-]+)\]$/);
  if (attrHas) return el.getAttribute?.(attrHas[1]) != null;
  if (s === "button") return el.tagName === "BUTTON";
  if (s === "option") return el.tagName === "OPTION" || el.value != null;
  if (s.startsWith(".")) return el.classList?.contains?.(s.slice(1));
  return false;
}

function installFixture(src) {
  const storage = memoryStorage();
  const byId = new Map();
  const buttons = [];
  const toggles = [];
  const all = [];

  function register(el) {
    all.push(el);
    if (el.id) byId.set(String(el.id), el);
    if (el.tagName === "BUTTON") buttons.push(el);
    return el;
  }

  const shell = register(mockEl("shell"));
  for (const id of PANE_IDS) {
    const pane = register(mockEl(id, ["pane"], id === "explorer" ? "aside" : id === "editor" ? "main" : "section"));
    shell.appendChild(pane);
    const a = mockToggle(id);
    const b = mockToggle(id);
    register(a);
    register(b);
    toggles.push(a, b);
  }

  const layoutBar = register(mockEl("layout-bar"));
  const layoutOpts = parseSelectOptions(selectInner(src, "pane-layout"));
  const orderOpts = parseSelectOptions(selectInner(src, "pane-order"));
  const layoutSelect = mockSelect(
    "pane-layout",
    layoutOpts.length
      ? layoutOpts
      : [
          { value: "three-pane", label: "Three panes", selected: true },
          { value: "editor-preview", label: "Editor + preview", selected: false },
          { value: "editor-only", label: "Editor only", selected: false },
          { value: "reader-only", label: "Reader only", selected: false },
        ],
  );
  const orderSelect = mockSelect(
    "pane-order",
    orderOpts.length
      ? orderOpts
      : [{ value: DEFAULT_ORDER.join(","), label: "Explorer, editor, preview", selected: true }],
  );
  register(layoutSelect);
  register(orderSelect);
  layoutBar.appendChild(layoutSelect);
  layoutBar.appendChild(orderSelect);

  const chrome = chromeHtml(src);
  const shellIdx = src.search(/\bid=["']shell["']/);
  for (const btn of parseButtons(src)) {
    if (!isSidebarToggleCandidate(btn)) continue;
    if (isPlainExplorerHide(btn)) continue;
    const inExplorer = (() => {
      const pane = taggedById(src, "explorer");
      if (!pane) return false;
      const start = src.indexOf(pane.full);
      return btn.index >= start && btn.index < start + pane.full.length;
    })();
    const inChrome = chrome.includes(btn.html) || (shellIdx >= 0 && btn.index < shellIdx);
    if (inExplorer && !inChrome) continue;
    const el = mockEl(btn.attrs.id || "sidebar-toggle", String(btn.attrs.class || "").split(/\s+/).filter(Boolean), "button");
    for (const [k, v] of Object.entries(btn.attrs)) {
      el.setAttribute(k, v);
    }
    el.innerHTML = btn.inner;
    el.textContent = btn.text;
    if (btn.attrs.title) el.title = btn.attrs.title;
    register(el);
    layoutBar.appendChild(el);
  }

  register(mockEl("editor-buffer"));
  register(mockEl("editor-view"));
  register(mockEl("preview-body"));
  const remember = register(mockEl("settings-remember-layout", [], "input"));
  remember.checked = true;
  remember.type = "checkbox";

  const doc = {
    documentElement: mockEl("html"),
    body: mockEl("body"),
    getElementById(id) {
      return byId.get(String(id)) || null;
    },
    querySelector(sel) {
      const list = this.querySelectorAll(sel);
      return list[0] || null;
    },
    querySelectorAll(sel) {
      const s = String(sel || "").trim();
      if (s === "[data-pane-toggle]") return toggles.slice();
      if (s === "button") return buttons.slice();
      const id = s.match(/^#([\w-]+)$/);
      if (id) {
        const el = byId.get(id[1]);
        return el ? [el] : [];
      }
      return all.filter((el) => attrSelectorMatch(el, s));
    },
    createElement(tag) {
      return mockEl("", [], tag);
    },
  };

  globalThis.document = doc;
  globalThis.localStorage = storage;
  globalThis.innerWidth = 800;
  globalThis.innerHeight = 600;
  if (!globalThis.window) globalThis.window = globalThis;
  globalThis.window.innerWidth = 800;
  globalThis.window.innerHeight = 600;

  return { doc, storage, byId, buttons, toggles, layoutSelect, orderSelect, layoutBar, shell };
}

function useFixture() {
  globalThis.document = fixture.doc;
  globalThis.localStorage = fixture.storage;
  if (!globalThis.window) globalThis.window = globalThis;
}

function paneLooksHidden(el) {
  if (!el) return true;
  if (el.hidden) return true;
  if (el.getAttribute?.("hidden") != null) return true;
  if (el.getAttribute?.("aria-hidden") === "true") return true;
  if (el.classList?.contains?.("collapsed")) return true;
  if (el.classList?.contains?.("closed")) return true;
  if (el.classList?.contains?.("hidden")) return true;
  if (el.classList?.contains?.("is-collapsed")) return true;
  const width = String(el.style?.width || "");
  if (/^0(?:px)?$/.test(width.trim())) return true;
  return false;
}

function visibleChromeIds(live = liveLayout()) {
  const order = Array.isArray(live?.order) ? live.order.map(String) : DEFAULT_ORDER.slice();
  const vis = [];
  if (live?.open?.explorer !== false && !order.includes("explorer")) vis.push("explorer");
  for (const id of order) {
    if (!PANE_IDS.includes(id)) continue;
    if (live?.open?.[id] === false) continue;
    if (!vis.includes(id)) vis.push(id);
  }
  return vis;
}

function explorerIsLeftmostWhenOpen(live = liveLayout()) {
  if (live?.open?.explorer === false) return true;
  const vis = visibleChromeIds(live);
  if (vis[0] === "explorer") return true;
  const kids = (fixture.shell.children || []).filter(
    (el) => PANE_IDS.includes(el.id) && !paneLooksHidden(el),
  );
  if (kids[0]?.id === "explorer") return true;
  const rect = fixture.doc.getElementById("explorer")?.getBoundingClientRect?.();
  return vis[0] === "explorer" || (rect && rect.left === 0 && rect.width > 0);
}

function optionIncludesExplorer(opt) {
  const value = String(opt?.value ?? "");
  const label = String(opt?.label ?? opt?.textContent ?? opt?.text ?? "");
  const ids = value.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
  return ids.includes("explorer") || /\bexplorer\b/i.test(label);
}

function orderStripHasExplorer() {
  const htmlOpts = parseSelectOptions(selectInner(html, "pane-order"));
  const liveOpts = [...(fixture.orderSelect?.options || [])];
  const fromHtml = htmlOpts.some(optionIncludesExplorer);
  const fromLive = liveOpts.some(optionIncludesExplorer);
  return fromHtml || fromLive;
}

function findSidebarToggle() {
  const doc = fixture.doc;
  for (const id of SIDEBAR_IDS) {
    const el = doc.getElementById(id);
    if (el && !isPlainExplorerHide(el)) return { el, from: "dom", id };
  }
  for (const el of fixture.buttons) {
    if (isSidebarToggleCandidate(el) && hasCursorLikeAffordance(el)) {
      return { el, from: "dom", id: el.id };
    }
    if (isSidebarToggleCandidate(el) && !isPlainExplorerHide(el)) {
      return { el, from: "dom", id: el.id };
    }
  }
  const chrome = chromeHtml(html);
  const shellIdx = html.search(/\bid=["']shell["']/);
  for (const btn of parseButtons(html)) {
    if (!isSidebarToggleCandidate(btn) || isPlainExplorerHide(btn)) continue;
    const inExplorer = (() => {
      const pane = taggedById(html, "explorer");
      if (!pane) return false;
      const start = html.indexOf(pane.full);
      return btn.index >= start && btn.index < start + pane.full.length;
    })();
    const inChrome = chrome.includes(btn.html) || (shellIdx >= 0 && btn.index < shellIdx);
    if (inExplorer && !inChrome) continue;
    return { el: null, from: "html", btn, id: btn.attrs.id || "" };
  }
  return null;
}

function click(el) {
  assert.ok(el, "sidebar toggle element must exist to click");
  if (typeof el.click === "function") el.click();
  else el.dispatchEvent?.({ type: "click", target: el, preventDefault() {}, stopPropagation() {} });
}

function navCollapsed() {
  const live = liveLayout();
  const explorer = fixture.doc.getElementById("explorer");
  if (live?.open?.explorer === false) return true;
  if (paneLooksHidden(explorer)) return true;
  const width = explorer?.getBoundingClientRect?.()?.width;
  if (width === 0) return true;
  return false;
}

function remainingWidthWhenNavCollapsed() {
  const live = liveLayout();
  const shell = fixture.shell;
  const cols = String(shell.style?.gridTemplateColumns || "");
  const parts = cols.split(/\s+/).filter(Boolean);
  const order = Array.isArray(live?.order) ? live.order.map(String) : [];
  const idx = order.indexOf("explorer");
  if (live?.open?.explorer !== false && !paneLooksHidden(fixture.doc.getElementById("explorer"))) {
    return false;
  }
  if (idx === -1) return live?.open?.editor !== false || live?.open?.preview !== false;
  const col = (parts[idx] || "").replace(/\s+/g, "");
  const explorerZero =
    /^(0(?:px)?|minmax\(0(?:px)?[,)]|minmax\(0,)/.test(col) || col === "0";
  const editorOpen = live?.open?.editor !== false;
  const previewOpen = live?.open?.preview !== false;
  return explorerZero && (editorOpen || previewOpen);
}

function assertToggleAria(toggle, open, when) {
  const pressed = toggle.getAttribute?.("aria-pressed");
  const expanded = toggle.getAttribute?.("aria-expanded");
  const want = open ? "true" : "false";
  assert.ok(
    pressed === want || expanded === want,
    `${when}: sidebar toggle aria-pressed or aria-expanded must be ${want} (pressed=${JSON.stringify(pressed)} expanded=${JSON.stringify(expanded)})`,
  );
}

function resetThreePane() {
  useFixture();
  const live = liveLayout();
  if (live && typeof live === "object") {
    live.remember = true;
    if (live.widths) {
      live.widths.explorer = DEFAULT_WIDTHS.explorer;
      live.widths.editor = DEFAULT_WIDTHS.editor;
      live.widths.preview = DEFAULT_WIDTHS.preview;
    }
    if (Array.isArray(live.order)) live.order = DEFAULT_ORDER.slice();
  }
  if (typeof reorderPanes === "function") reorderPanes(DEFAULT_ORDER.slice());
  setLayout("three-pane");
}

test("explorer is always the leftmost visible chrome when open", () => {
  useFixture();
  assert.equal(typeof reorderPanes, "function", "reorderPanes must be exported");
  assert.equal(typeof getLayout, "function", "getLayout must be exported");

  for (const next of EXPLORER_OFF_LEFT) {
    resetThreePane();
    reorderPanes(next.slice());
    const live = liveLayout();
    assert.equal(
      live.open.explorer,
      true,
      `after reorderPanes(${JSON.stringify(next)}) explorer must still be open for this check`,
    );
    const order = Array.isArray(live.order) ? live.order.map(String) : [];
    const explorerIdx = order.indexOf("explorer");
    assert.ok(
      explorerIdx <= 0,
      `layout.order must never place explorer middle/right (after reorderPanes(${JSON.stringify(next)}) order=${JSON.stringify(order)}; Order UI may drop explorer permutations or reorderPanes may ignore moving it off the left)`,
    );
    assert.equal(
      explorerIsLeftmostWhenOpen(live),
      true,
      `explorer must stay the leftmost visible chrome after reorderPanes(${JSON.stringify(next)})`,
    );
  }
  resetThreePane();
  assert.equal(
    visibleChromeIds()[0],
    "explorer",
    "default three-pane: explorer must be the leftmost visible chrome",
  );
});

test("sidebar toggle control exists with Cursor-like affordance", () => {
  useFixture();
  const found = findSidebarToggle();
  assert.ok(
    found,
    "a sidebar toggle control must exist (e.g. #sidebar-toggle or a button with aria-label/title Sidebar / Toggle sidebar) in the title/toolbar chrome — not only data-pane-toggle=explorer Hide buttons",
  );
  const affordance = found.el ? hasCursorLikeAffordance(found.el) : hasCursorLikeAffordance(found.btn);
  assert.ok(
    affordance,
    "sidebar toggle must have Cursor-like icon/markup distinguishable from plain Hide text (svg/img/icon class/empty aria-labelled control)",
  );
  if (found.el) {
    assert.equal(
      isPlainExplorerHide(found.el),
      false,
      "primary sidebar control must not be only a data-pane-toggle=explorer Hide/Show text button",
    );
  } else {
    assert.equal(isPlainExplorerHide(found.btn), false);
  }
});

test("sidebar toggle collapses and expands nav with matching aria state", () => {
  resetThreePane();
  const found = findSidebarToggle();
  assert.ok(found?.el, "sidebar toggle element must exist in the document to collapse/expand nav");
  const toggle = found.el;
  assert.equal(navCollapsed(), false, "precondition: nav must start expanded");
  assertToggleAria(toggle, true, "nav expanded");

  click(toggle);
  assert.equal(
    navCollapsed(),
    true,
    "clicking the sidebar toggle must collapse nav (open.explorer false / width 0 / hidden)",
  );
  assertToggleAria(toggle, false, "nav collapsed");

  click(toggle);
  assert.equal(navCollapsed(), false, "clicking the sidebar toggle again must expand nav");
  assert.equal(liveLayout().open.explorer, true, "expanded nav: getLayout().open.explorer must be true");
  assertToggleAria(toggle, true, "nav expanded again");
});

test("collapsed nav yields remaining width to editor+preview; expanded nav is flush left", () => {
  resetThreePane();
  const found = findSidebarToggle();
  assert.ok(found?.el, "sidebar toggle is required to collapse nav for remaining-width");

  assert.equal(
    explorerIsLeftmostWhenOpen(),
    true,
    "when expanded, nav must be flush left",
  );
  const openRect = fixture.doc.getElementById("explorer").getBoundingClientRect();
  assert.equal(openRect.left, 0, "when expanded, explorer left edge must be 0 (flush left)");
  assert.ok(openRect.width > 0, "when expanded, explorer must consume a positive width");

  click(found.el);
  assert.equal(navCollapsed(), true, "toggle must collapse nav");
  assert.equal(
    liveLayout().open.editor !== false && liveLayout().open.preview !== false,
    true,
    "collapsing nav must leave editor and preview open",
  );
  assert.ok(
    remainingWidthWhenNavCollapsed(),
    "when nav is collapsed, editor+preview must use remaining width (explorer column 0 / omitted, not a reserved 240px slot)",
  );

  click(found.el);
  assert.equal(navCollapsed(), false, "toggle must expand nav again");
  reorderPanes(["preview", "editor", "explorer"]);
  assert.equal(
    liveLayout().open.explorer,
    true,
    "explorer stays open after expand + reorder attempt",
  );
  assert.equal(
    explorerIsLeftmostWhenOpen(),
    true,
    "when expanded, nav must stay flush left even if Order/reorder tries to move it",
  );
  assert.equal(
    fixture.doc.getElementById("explorer").getBoundingClientRect().left,
    0,
    "expanded nav flush left: explorer.getBoundingClientRect().left must be 0",
  );
});

test("nav open/collapsed state persists with remember-layout", () => {
  resetThreePane();
  const live = liveLayout();
  live.remember = true;
  const found = findSidebarToggle();
  assert.ok(found?.el, "sidebar toggle is required to persist nav collapsed state the same way as other layout flags");

  click(found.el);
  assert.equal(navCollapsed(), true, "precondition: nav collapsed before persist");
  persistLayout();

  const raw = fixture.storage.getItem(LAYOUT_KEY);
  assert.ok(raw, `persistLayout must write ${LAYOUT_KEY}`);
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  assert.ok(parsed && typeof parsed === "object", `${LAYOUT_KEY} must be JSON`);
  const storedOpen =
    parsed.open && typeof parsed.open === "object" ? parsed.open.explorer : undefined;
  const storedCollapsed =
    parsed.collapsed && typeof parsed.collapsed === "object"
      ? parsed.collapsed.explorer
      : undefined;
  assert.ok(
    storedOpen === false || storedCollapsed === true,
    "remember-layout payload must record nav collapsed (open.explorer false or collapsed.explorer true), same as other pane flags",
  );

  live.open.explorer = true;
  live.open.editor = true;
  live.open.preview = true;
  restoreLayout();
  assert.equal(
    liveLayout().open.explorer,
    false,
    "restoreLayout must reapply collapsed nav when remember-layout is on",
  );

  click(found.el);
  persistLayout();
  live.open.explorer = false;
  restoreLayout();
  assert.equal(
    liveLayout().open.explorer,
    true,
    "restoreLayout must reapply expanded nav when remember-layout is on",
  );
});

test("editor-preview, three-pane, and editor+preview hide-show still work; explorer is not in the reorderable strip", () => {
  resetThreePane();
  assert.equal(typeof setLayout, "function", "setLayout must be exported");
  assert.equal(typeof collapsePane, "function", "collapsePane must be exported");

  setLayout("editor-preview");
  let open = liveLayout().open;
  assert.equal(open.explorer, false, 'setLayout("editor-preview"): explorer closed');
  assert.equal(open.editor, true, 'setLayout("editor-preview"): editor open');
  assert.equal(open.preview, true, 'setLayout("editor-preview"): preview open');

  setLayout("three-pane");
  open = liveLayout().open;
  assert.equal(open.explorer, true, 'setLayout("three-pane"): explorer open');
  assert.equal(open.editor, true, 'setLayout("three-pane"): editor open');
  assert.equal(open.preview, true, 'setLayout("three-pane"): preview open');

  collapsePane("editor", true);
  assert.equal(liveLayout().open.editor, false, "collapsePane(editor) must still hide editor");
  collapsePane("editor", false);
  assert.equal(liveLayout().open.editor, true, "collapsePane(editor, false) must still show editor");
  collapsePane("preview", true);
  assert.equal(liveLayout().open.preview, false, "collapsePane(preview) must still hide preview");
  collapsePane("preview", false);
  assert.equal(liveLayout().open.preview, true, "collapsePane(preview, false) must still show preview");

  const editorToggles = fixture.toggles.filter(
    (btn) => btn.getAttribute("data-pane-toggle") === "editor",
  );
  const previewToggles = fixture.toggles.filter(
    (btn) => btn.getAttribute("data-pane-toggle") === "preview",
  );
  assert.ok(editorToggles.length >= 1, "editor Hide/Show toggles must still exist");
  assert.ok(previewToggles.length >= 1, "preview Hide/Show toggles must still exist");

  assert.equal(
    orderStripHasExplorer(),
    false,
    "explorer must not appear in the reorderable Order strip (options are editor/preview only)",
  );
});
