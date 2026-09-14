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

const COLLAPSE_FN =
  String.raw`collapsePane|togglePane|hidePane|setPaneCollapsed|setPaneOpen|setPaneVisible`;
const SET_LAYOUT_FN =
  String.raw`setLayout|applyLayout|setPaneLayout|useLayout`;
const REORDER_FN =
  String.raw`reorderPanes|swapPanes|setPaneOrder|movePane|arrangePanes|setLayoutOrder`;
const RESTORE_FN =
  String.raw`restoreLayout|loadLayout|applyStoredLayout|initLayout|readLayout`;
const PERSIST_FN =
  String.raw`persistLayout|saveLayout|storeLayout|writeLayout`;
const GET_LAYOUT_FN = String.raw`getLayout|readLayoutState|layoutState`;

const THEME_COLOR_PROP =
  String.raw`color|background(?:-color)?|border-color|outline-color|caret-color|fill|stroke|text-decoration-color|--(?:bg|bg-elevated|fg|fg-muted|border|accent|danger)`;
const LAYOUT_PROP =
  String.raw`width|min-width|max-width|flex(?:-basis|-grow|-shrink)?|grid-template(?:-columns|-rows)?|grid`;
const EDITOR_ONLY = String.raw`editor[-_]?only|editorOnly`;
const READER_ONLY = String.raw`reader[-_]?only|readerOnly|preview[-_]?only|previewOnly`;


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

function cssFromFiles(files) {
  const chunks = [];
  for (const f of files) {
    if (/\.css$/i.test(f.path)) {
      chunks.push(f.text);
      continue;
    }
    const re = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
    let m;
    while ((m = re.exec(f.text))) chunks.push(m[1]);
  }
  return chunks.join("\n");
}

function firstOf(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
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

function extractBalanced(src, openIdx) {
  if (openIdx < 0 || src[openIdx] !== "{") return null;
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    if (c === "{") depth += 1;
    else if (c === "}") {
      depth -= 1;
      if (depth === 0) return src.slice(openIdx, i + 1);
    }
  }
  return null;
}

function fnBodies(src, namesAlt) {
  const bodies = [];
  const cleaned = stripComments(src);
  const patterns = [
    new RegExp(
      String.raw`(?:export\s+)?function\s+(?:${namesAlt})\s*\([^)]*\)\s*\{`,
      "gi",
    ),
    new RegExp(
      String.raw`(?:export\s+)?(?:const|let|var)\s+(?:${namesAlt})\s*=\s*(?:async\s*)?(?:function\s*)?\([^)]*\)\s*(?:=>\s*)?\{`,
      "gi",
    ),
    new RegExp(
      String.raw`(?:${namesAlt})\s*:\s*(?:async\s*)?(?:function\s*)?\([^)]*\)\s*(?:=>\s*)?\{`,
      "gi",
    ),
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(cleaned))) {
      const brace = cleaned.indexOf("{", m.index);
      const body = extractBalanced(cleaned, brace);
      if (body) bodies.push(body);
    }
  }
  return bodies;
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

function mockEl(id, extraClass = []) {
  const attrs = { id };
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
      return { width: 240, height: 600, top: 0, left: 0, right: 240, bottom: 600 };
    },
  };
  return el;
}

function installDom() {
  if (globalThis.document?.__lightmdPaneLayoutMock) return globalThis.document;
  const byId = new Map();
  const shell = mockEl("shell");
  for (const id of PANE_IDS) {
    const pane = mockEl(id, ["pane"]);
    byId.set(id, pane);
    shell.appendChild(pane);
  }
  byId.set("shell", shell);
  byId.set("editor-buffer", mockEl("editor-buffer"));
  byId.set("editor-view", mockEl("editor-view"));
  const doc = {
    __lightmdPaneLayoutMock: true,
    documentElement: mockEl("html"),
    body: mockEl("body"),
    getElementById(id) {
      return byId.get(id) || null;
    },
    querySelector(sel) {
      const m = String(sel || "").match(/^#([\w-]+)/);
      return m ? this.getElementById(m[1]) : null;
    },
    querySelectorAll() {
      return [];
    },
    createElement(tag) {
      return mockEl(String(tag));
    },
  };
  globalThis.document = doc;
  if (!globalThis.window) globalThis.window = globalThis;
  return doc;
}

function pickFn(mod, names) {
  if (!mod || typeof mod !== "object") return null;
  for (const name of names) {
    if (typeof mod[name] === "function") return mod[name];
  }
  for (const wrap of ["default", "layout", "layoutApi", "paneLayout", "api"]) {
    const nested = mod[wrap];
    if (nested && nested !== mod && typeof nested === "object") {
      const found = pickFn(nested, names);
      if (found) return found;
    }
  }
  return null;
}

function pickObject(mod, names) {
  if (!mod || typeof mod !== "object") return null;
  for (const name of names) {
    if (mod[name] && typeof mod[name] === "object") return mod[name];
  }
  for (const wrap of ["default", "layout", "prefs", "preferences", "settings", "config"]) {
    const nested = mod[wrap];
    if (nested && nested !== mod && typeof nested === "object") {
      const found = pickObject(nested, names);
      if (found) return found;
    }
  }
  return null;
}

function asBool(value) {
  if (typeof value === "boolean") return value;
  return undefined;
}

function asNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^-?\d+(\.\d+)?(px)?$/.test(value.trim())) {
    return Number.parseFloat(value);
  }
  return undefined;
}

function paneOpenFrom(entry, id) {
  if (entry == null) return undefined;
  if (typeof entry === "boolean") return entry;
  if (typeof entry === "string") {
    if (/^(open|visible|shown|true)$/i.test(entry)) return true;
    if (/^(collapsed|closed|hidden|false)$/i.test(entry)) return false;
  }
  if (typeof entry !== "object") return undefined;
  const collapsed = asBool(
    firstOf(entry.collapsed, entry.closed, entry.hidden, entry.isCollapsed),
  );
  if (collapsed !== undefined) return !collapsed;
  const open = asBool(
    firstOf(entry.open, entry.visible, entry.shown, entry.isOpen, entry.expanded),
  );
  if (open !== undefined) return open;
  if (entry.id === id || entry.name === id || entry.pane === id) {
    return paneOpenFrom(
      firstOf(entry.state, entry.status, entry.collapsed, entry.open),
      id,
    );
  }
  return undefined;
}

function widthsFrom(value) {
  if (!value) return null;
  if (Array.isArray(value) && value.length >= 1) {
    const nums = value.map(asNumber).filter((n) => n !== undefined);
    return nums.length ? nums : null;
  }
  if (typeof value !== "object") return null;
  const nested = firstOf(
    value.widths,
    value.paneWidths,
    value.sizes,
    value.columns,
    value.paneSizes,
  );
  if (nested && nested !== value) {
    const inner = widthsFrom(nested);
    if (inner) return inner;
  }
  const out = {};
  let found = false;
  for (const id of PANE_IDS) {
    const n = asNumber(
      firstOf(value[id], value[`${id}Width`], value[`${id}width`]),
    );
    if (n !== undefined) {
      out[id] = n;
      found = true;
    }
  }
  return found ? out : null;
}

function windowSizeFrom(value) {
  if (!value || typeof value !== "object") return null;
  const nested = firstOf(
    value.window,
    value.windowSize,
    value.size,
    value.bounds,
    value.outer,
  );
  const src = nested && typeof nested === "object" ? nested : value;
  const width = asNumber(
    firstOf(src.width, src.innerWidth, src.outerWidth, src.w, value.windowWidth),
  );
  const height = asNumber(
    firstOf(src.height, src.innerHeight, src.outerHeight, src.h, value.windowHeight),
  );
  if (width === undefined && height === undefined) return null;
  return { width, height };
}

function normalizeLayout(value) {
  if (!value || typeof value !== "object") return null;
  const nested = firstOf(
    value.layout,
    value.layoutPrefs,
    value.paneLayout,
    value.panes,
    value.prefs,
  );
  const src =
    nested && typeof nested === "object" && !Array.isArray(nested) ? { ...value, ...nested } : value;

  const open = {};
  let sawOpen = false;
  const collapsedList = firstOf(src.collapsed, src.closed, src.hiddenPanes);
  if (Array.isArray(collapsedList)) {
    for (const id of PANE_IDS) {
      open[id] = !collapsedList.map(String).includes(id);
      sawOpen = true;
    }
  }
  const openList = firstOf(src.open, src.visible, src.openPanes);
  if (Array.isArray(openList)) {
    for (const id of PANE_IDS) {
      open[id] = openList.map(String).includes(id);
      sawOpen = true;
    }
  }
  for (const id of PANE_IDS) {
    const entry = firstOf(
      src[id],
      src.panes && src.panes[id],
      src.open && src.open[id],
      src.visible && src.visible[id],
      src.collapsed && src.collapsed[id],
    );
    const parsed = paneOpenFrom(entry, id);
    if (parsed !== undefined) {
      open[id] = parsed;
      sawOpen = true;
    }
  }

  const order = Array.isArray(src.order)
    ? src.order.map(String)
    : Array.isArray(src.paneOrder)
      ? src.paneOrder.map(String)
      : null;

  return {
    raw: value,
    open: sawOpen ? open : null,
    widths: widthsFrom(src) || widthsFrom(value),
    order,
    window: windowSizeFrom(src) || windowSizeFrom(value),
    name: firstOf(src.name, src.layout, src.mode, src.preset),
  };
}

function storageEntries(ls) {
  const out = [];
  if (!ls) return out;
  const len = ls.length ?? 0;
  if (len && typeof ls.key === "function") {
    for (let i = 0; i < len; i++) {
      const key = ls.key(i);
      if (key == null) continue;
      out.push({ key: String(key), value: ls.getItem(key) });
    }
    return out;
  }
  if (typeof ls.getItem === "function") {
    for (const key of [
      "layout",
      "lightmd.layout",
      "lightmd-layout",
      "pane-layout",
      "paneLayout",
      "layoutPrefs",
      "prefs",
      "window",
      "windowSize",
    ]) {
      const value = ls.getItem(key);
      if (value != null) out.push({ key, value });
    }
  }
  return out;
}

function layoutsFromStorage(ls) {
  const layouts = [];
  for (const { key, value } of storageEntries(ls)) {
    if (value == null || value === "") continue;
    let parsed = value;
    try {
      parsed = JSON.parse(value);
    } catch {
      parsed = value;
    }
    const layout = normalizeLayout(
      typeof parsed === "object" && parsed ? { key, ...parsed } : { key, value: parsed },
    );
    if (layout && (layout.open || layout.widths || layout.window || layout.order)) {
      layouts.push({ key, layout });
    } else if (/layout|pane|window|pref/i.test(key)) {
      layouts.push({
        key,
        layout: {
          raw: parsed,
          open: null,
          widths: widthsFrom(parsed),
          order: null,
          window: windowSizeFrom(parsed) || windowSizeFrom({ [key]: parsed }),
          name: null,
        },
      });
    }
  }
  return layouts;
}

function asLayoutApi(mod) {
  if (!mod || typeof mod !== "object") return null;
  const collapsePane = pickFn(mod, [
    "collapsePane",
    "togglePane",
    "hidePane",
    "setPaneCollapsed",
    "setPaneOpen",
    "setPaneVisible",
  ]);
  const setLayout = pickFn(mod, [
    "setLayout",
    "applyLayout",
    "setPaneLayout",
    "useLayout",
  ]);
  const reorder = pickFn(mod, [
    "reorderPanes",
    "swapPanes",
    "setPaneOrder",
    "movePane",
    "arrangePanes",
    "setLayoutOrder",
  ]);
  const restore = pickFn(mod, [
    "restoreLayout",
    "loadLayout",
    "applyStoredLayout",
    "initLayout",
    "readLayout",
  ]);
  const persist = pickFn(mod, [
    "persistLayout",
    "saveLayout",
    "storeLayout",
    "writeLayout",
  ]);
  const getLayout = pickFn(mod, ["getLayout", "readLayoutState", "layoutState"]);
  const layoutObj = pickObject(mod, [
    "layout",
    "layoutPrefs",
    "paneLayout",
    "LAYOUT",
    "defaultLayout",
  ]);
  if (
    !collapsePane &&
    !setLayout &&
    !reorder &&
    !restore &&
    !persist &&
    !getLayout &&
    !layoutObj
  ) {
    return null;
  }
  return {
    collapsePane,
    setLayout,
    reorder,
    restore,
    persist,
    getLayout,
    layoutObj,
    raw: mod,
  };
}

async function importSrcModules() {
  installLocalStorage();
  installDom();
  const files = collectFiles(srcDir);
  const mods = [];
  for (const p of files) {
    if (!/\.(js|mjs|css)$/i.test(p) && !/\.cjs$/i.test(p)) continue;
    if (/editor\.bundle\.js$/i.test(p)) continue;
    try {
      const mod = await import(pathToFileURL(p).href);
      mods.push(mod);
    } catch {
      // DOM or otherwise unusable in Node: keep looking.
    }
  }
  return mods;
}

async function loadLayoutApi() {
  const files = loadSources();
  const src = joinedSource(files);
  const css = cssFromFiles(files);
  const mods = await importSrcModules();
  let api = null;
  for (const mod of mods) {
    const found = asLayoutApi(mod);
    if (found) {
      api = found;
      if (found.collapsePane || found.setLayout || found.reorder) break;
    }
  }
  return { files, src, css, api, storage: installLocalStorage(), doc: installDom() };
}

function currentLayout(api) {
  if (!api) return null;
  if (typeof api.getLayout === "function") {
    try {
      const got = normalizeLayout(api.getLayout());
      if (got) return got;
    } catch {
      // keep looking
    }
  }
  const fromObj = normalizeLayout(api.layoutObj);
  if (fromObj) return fromObj;
  const stored = layoutsFromStorage(installLocalStorage());
  return stored[0]?.layout ?? null;
}

function callCollapse(api, id, collapsed = true) {
  if (!api) return false;
  const fn = api.collapsePane;
  if (typeof fn !== "function") return false;
  const attempts = [
    () => fn(id, collapsed),
    () => fn(id),
    () => fn({ id, collapsed, open: !collapsed }),
    () => fn(id, { collapsed, open: !collapsed }),
  ];
  for (const attempt of attempts) {
    try {
      attempt();
      return true;
    } catch {
      // try the next calling convention
    }
  }
  return false;
}

function callSetLayout(api, name) {
  if (!api || typeof api.setLayout !== "function") return false;
  const attempts = [
    () => api.setLayout(name),
    () =>
      api.setLayout(
        name === "editor-only" || name === "editorOnly" || name === "editor"
          ? { explorer: false, editor: true, preview: false }
          : name === "reader-only" || name === "readerOnly" || name === "reader"
            ? { explorer: false, editor: false, preview: true }
            : name,
      ),
  ];
  for (const attempt of attempts) {
    try {
      attempt();
      return true;
    } catch {
      // try the next calling convention
    }
  }
  return false;
}

function paneLooksHidden(el) {
  if (!el) return false;
  if (el.hidden) return true;
  if (el.getAttribute?.("hidden") != null) return true;
  if (el.getAttribute?.("aria-hidden") === "true") return true;
  const cls = el.classList?.value || el.className || "";
  if (/\b(?:collapsed|closed|hidden|is-collapsed)\b/i.test(cls)) return true;
  const width = String(el.style?.width || el.style?.flexBasis || "");
  if (/^0(?:px)?$/.test(width.trim())) return true;
  const flex = String(el.style?.flex || el.style?.flexGrow || "");
  if (/^0(?:\s|$)/.test(flex.trim())) return true;
  if (/display\s*:\s*none/i.test(el.getAttribute?.("style") || "")) return true;
  return false;
}

function explorerHiddenInDom(doc) {
  return paneLooksHidden(doc?.getElementById?.("explorer"));
}

function sourceHasCollapseFn(src) {
  const cleaned = stripComments(src);
  if (new RegExp(String.raw`\b(?:${COLLAPSE_FN})\s*\(`).test(cleaned) === false) {
    if (!new RegExp(String.raw`export\s+\{[^}]*\b(?:${COLLAPSE_FN})\b`).test(cleaned)) {
      return false;
    }
  }
  if (/\bborder-collapse\b/i.test(cleaned) && !new RegExp(String.raw`\b(?:${COLLAPSE_FN})\b`).test(cleaned)) {
    return false;
  }
  return new RegExp(String.raw`\b(?:${COLLAPSE_FN})\b`).test(cleaned);
}

function sourceCollapsesAllPanes(src) {
  if (!sourceHasCollapseFn(src)) return false;
  const cleaned = stripComments(src);
  const bodies = fnBodies(cleaned, COLLAPSE_FN);
  const blob = bodies.length ? bodies.join("\n") : cleaned;
  const mentions = PANE_IDS.filter((id) => new RegExp(String.raw`\b${id}\b`).test(blob));
  if (mentions.length === 3) return true;
  const list =
    /PANE(?:_IDS|S)?\s*=\s*\[[^\]]+\]/.exec(cleaned)?.[0] ||
    /(?:explorer|editor|preview).{0,80}(?:explorer|editor|preview).{0,80}(?:explorer|editor|preview)/.exec(
      cleaned,
    )?.[0];
  if (list && PANE_IDS.every((id) => list.includes(id))) return true;
  const generic =
    new RegExp(String.raw`\b(?:${COLLAPSE_FN})\s*\(\s*(?:id|pane|name|which)\b`).test(
      cleaned,
    ) || new RegExp(String.raw`\b(?:${COLLAPSE_FN})\s*\(\s*[A-Za-z_]`).test(cleaned);
  const idsPresent = PANE_IDS.every((id) =>
    new RegExp(String.raw`["']${id}["']`).test(cleaned),
  );
  return generic && idsPresent;
}

function collapseHidesExplorer(src, api, doc) {
  if (api && callCollapse(api, "explorer", true)) {
    const layout = currentLayout(api);
    if (layout?.open && layout.open.explorer === false) return true;
    if (explorerHiddenInDom(doc)) return true;
    const stored = layoutsFromStorage(installLocalStorage());
    if (stored.some((s) => s.layout.open && s.layout.open.explorer === false)) {
      return true;
    }
  }
  const cleaned = stripComments(src);
  if (!sourceHasCollapseFn(cleaned) && !new RegExp(String.raw`\b(?:${SET_LAYOUT_FN})\b`).test(cleaned)) {
    return false;
  }
  const bodies = [
    ...fnBodies(cleaned, COLLAPSE_FN),
    ...fnBodies(cleaned, SET_LAYOUT_FN),
  ].join("\n");
  const blob = bodies || cleaned;
  const explorerWindows = windowsAround(
    blob,
    /explorer/gi,
    80,
    400,
  );
  const hides = (text) =>
    /hidden\s*=\s*true/.test(text) ||
    /\.hidden\s*=/.test(text) ||
    /classList\.(?:add|toggle)\(\s*["'](?:collapsed|closed|hidden|is-collapsed)["']/.test(
      text,
    ) ||
    /setAttribute\(\s*["']hidden["']/.test(text) ||
    /aria-hidden/.test(text) ||
    /style\.(?:width|flexBasis|flex)\s*=\s*["']0/.test(text) ||
    /width\s*:\s*0(?:px)?/.test(text) ||
    /flex(?:-basis)?\s*:\s*0/.test(text) ||
    /grid-template-columns/.test(text) && /0(?:px|fr)?/.test(text) ||
    /display\s*:\s*none/.test(text) ||
    /open(?:Panes)?\s*\[[^\]]{0,40}explorer[^\]]{0,40}\]\s*=\s*false/.test(text) ||
    /explorer["']?\s*:\s*false/.test(text);
  if (explorerWindows.some(hides)) return true;
  if (/#explorer(?:\.collapsed|\.closed|\.hidden|\[hidden\]|\[data-collapsed\])/.test(cleaned)) {
    return true;
  }
  if (
    /\.pane\.(?:collapsed|closed|hidden)|\[data-collapsed\]|#shell\.(?:explorer-collapsed|collapsed)/.test(
      cleaned,
    )
  ) {
    return true;
  }
  return false;
}

function durationMsList(value) {
  const out = [];
  const re = /(\d*\.?\d+)\s*(ms|s)\b/gi;
  let m;
  while ((m = re.exec(value))) {
    const n = Number.parseFloat(m[1]);
    if (!Number.isFinite(n)) continue;
    out.push(m[2].toLowerCase() === "s" ? n * 1000 : n);
  }
  return out;
}

function isCollapseDuration(ms) {
  return Math.abs(ms - 120) < 0.5;
}

function transitionPropsAndTimes(value) {
  const v = String(value || "").trim();
  const times = durationMsList(v);
  const withoutTimes = v
    .replace(/(\d*\.?\d+)\s*(ms|s)\b/gi, " ")
    .replace(
      /\b(?:ease(?:-in)?(?:-out)?|linear|step-start|step-end|steps\([^)]*\)|cubic-bezier\([^)]*\))\b/gi,
      " ",
    )
    .replace(/[,/]/g, " ")
    .trim();
  const props = withoutTimes
    ? withoutTimes.split(/\s+/).filter((tok) => /^[A-Za-z-]+$/.test(tok))
    : [];
  return { times, props, raw: v };
}

function propsAreLayoutOnly(props) {
  if (!props.length) return false;
  if (props.some((p) => /^all$/i.test(p))) return false;
  if (props.some((p) => new RegExp(String.raw`^(?:${THEME_COLOR_PROP})$`, "i").test(p))) {
    return false;
  }
  return props.every((p) => new RegExp(String.raw`^(?:${LAYOUT_PROP})$`, "i").test(p));
}

function declIsCollapse120(value) {
  const { times, props, raw } = transitionPropsAndTimes(value);
  if (!times.some(isCollapseDuration)) return false;
  if (/\ball\b/i.test(raw) && !propsAreLayoutOnly(props)) return false;
  if (new RegExp(THEME_COLOR_PROP, "i").test(raw) && !propsAreLayoutOnly(props)) {
    return false;
  }
  if (!props.length) {
    // `transition: 120ms` with no property list means `all` — not allowed.
    return false;
  }
  return propsAreLayoutOnly(props);
}

function parseCssRules(css) {
  const cleaned = stripComments(css);
  const rules = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(cleaned))) {
    const selector = m[1].replace(/@[\w-]+[^{]*/g, "").trim();
    if (!selector) continue;
    rules.push({ selector, body: m[2] });
  }
  return rules;
}

function ruleHasCollapse120(body) {
  const shorthand = String(body || "").match(/transition\s*:\s*([^;]+)/i);
  if (shorthand && declIsCollapse120(shorthand[1])) return true;
  const duration = String(body || "").match(/transition-duration\s*:\s*([^;]+)/i);
  const property = String(body || "").match(/transition-property\s*:\s*([^;]+)/i);
  if (duration && property) {
    const times = durationMsList(duration[1]);
    const props = property[1]
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    return times.some(isCollapseDuration) && propsAreLayoutOnly(props);
  }
  return false;
}

function hasExplorerCollapse120(css, src) {
  const blob = stripComments(`${css}\n${src}`);
  if (parseCssRules(blob).some((rule) => ruleHasCollapse120(rule.body))) {
    return true;
  }
  const transitionRe = /transition(?:-property|-duration)?\s*:\s*([^;{}]+)/gi;
  let m;
  while ((m = transitionRe.exec(blob))) {
    if (declIsCollapse120(m[1])) return true;
  }
  if (
    /(?:width|flex(?:-basis)?|grid-template-columns)[^;{}]{0,80}(?:120\s*ms|0\.12\s*s)/i.test(
      blob,
    )
  ) {
    return true;
  }
  if (
    /(?:120\s*ms|0\.12\s*s)[^;{}]{0,80}(?:width|flex(?:-basis)?|grid-template-columns)/i.test(
      blob,
    )
  ) {
    return true;
  }
  if (
    /\b(?:COLLAPSE(?:_|-)?(?:MS|DURATION|DELAY)|collapse(?:Duration|Ms|Delay)|PANE_COLLAPSE_MS)\s*[:=]\s*120\b/.test(
      blob,
    )
  ) {
    return true;
  }
  if (
    /(?:style\.)?transition(?:Duration)?\s*[:=]\s*["'`][^"'`]*(?:width|flex|grid)[^"'`]*120\s*ms/i.test(
      blob,
    ) ||
    /(?:style\.)?transition(?:Duration)?\s*[:=]\s*["'`][^"'`]*120\s*ms[^"'`]*(?:width|flex|grid)/i.test(
      blob,
    )
  ) {
    return true;
  }
  return false;
}

function extraMotionBeyondCollapse120(css, src) {
  const blob = stripComments(`${css}\n${src}`);
  const transitionRe = /transition(?:-property|-duration)?\s*:\s*([^;{}]+)/gi;
  let m;
  while ((m = transitionRe.exec(blob))) {
    const value = m[1];
    if (/^\s*none\s*$/i.test(value)) continue;
    const { times, props, raw } = transitionPropsAndTimes(value);
    if (!times.length || times.every((ms) => ms === 0)) continue;
    if (declIsCollapse120(value)) continue;
    if (times.some((ms) => ms > 0)) {
      if (propsAreLayoutOnly(props) && times.every((ms) => ms === 0 || isCollapseDuration(ms))) {
        continue;
      }
      if (new RegExp(THEME_COLOR_PROP, "i").test(raw)) return true;
      if (/\ball\b/i.test(raw)) return true;
      if (!propsAreLayoutOnly(props) || !times.every((ms) => ms === 0 || isCollapseDuration(ms))) {
        return true;
      }
    }
  }
  const animRe = /animation(?:-name|-duration)?\s*:\s*([^;{}]+)/gi;
  while ((m = animRe.exec(blob))) {
    const value = m[1];
    if (/^\s*none\s*$/i.test(value)) continue;
    const times = durationMsList(value);
    if (times.some((ms) => ms > 0)) return true;
    if (!times.length && !/^\s*$/.test(value)) return true;
  }
  if (/\.startViewTransition\s*\(/.test(blob)) return true;
  if (/@keyframes\b/.test(blob) && /animation(?:-name)?\s*:/.test(blob)) return true;
  return false;
}

function hasThemeColorMotion(src) {
  const css = stripComments(src);
  const transitionRe = /transition(?:-property)?\s*:\s*([^;{}]+)/gi;
  let m;
  while ((m = transitionRe.exec(css))) {
    const { times, props, raw } = transitionPropsAndTimes(m[1]);
    if (!times.some((ms) => ms > 0)) continue;
    if (propsAreLayoutOnly(props) && times.every((ms) => ms === 0 || isCollapseDuration(ms))) {
      continue;
    }
    if (/\ball\b/i.test(raw)) return true;
    if (new RegExp(THEME_COLOR_PROP, "i").test(raw)) return true;
  }
  return false;
}

function namedLayoutInSource(src, nameAlt) {
  const cleaned = stripComments(src);
  if (new RegExp(String.raw`["'](?:${nameAlt})["']`).test(cleaned)) return true;
  if (new RegExp(String.raw`\b(?:${nameAlt})\b`).test(cleaned)) return true;
  return false;
}

function editorOnlyByCollapse(src) {
  const cleaned = stripComments(src);
  const bodies = [
    ...fnBodies(cleaned, SET_LAYOUT_FN),
    ...fnBodies(cleaned, COLLAPSE_FN),
  ].join("\n");
  const blob = bodies || cleaned;
  const explorerClosed =
    /explorer["']?\s*:\s*false/.test(blob) ||
    /collapsePane\s*\(\s*["']explorer["']/.test(blob) ||
    /["']explorer["'][\s\S]{0,120}(?:collapsed|hidden|false)/.test(blob);
  const previewClosed =
    /preview["']?\s*:\s*false/.test(blob) ||
    /collapsePane\s*\(\s*["']preview["']/.test(blob) ||
    /["']preview["'][\s\S]{0,120}(?:collapsed|hidden|false)/.test(blob);
  const editorOpen =
    /editor["']?\s*:\s*true/.test(blob) ||
    /["']editor["']/.test(blob);
  return explorerClosed && previewClosed && editorOpen;
}

function readerOnlyByCollapse(src) {
  const cleaned = stripComments(src);
  const bodies = [
    ...fnBodies(cleaned, SET_LAYOUT_FN),
    ...fnBodies(cleaned, COLLAPSE_FN),
  ].join("\n");
  const blob = bodies || cleaned;
  const explorerClosed =
    /explorer["']?\s*:\s*false/.test(blob) ||
    /collapsePane\s*\(\s*["']explorer["']/.test(blob);
  const editorClosed =
    /editor["']?\s*:\s*false/.test(blob) ||
    /collapsePane\s*\(\s*["']editor["']/.test(blob);
  const previewOpen =
    /preview["']?\s*:\s*true/.test(blob) ||
    /["']preview["']/.test(blob);
  return explorerClosed && editorClosed && previewOpen;
}

function runtimeNamedLayout(api, names, expectedOpen) {
  if (!api?.setLayout) return false;
  for (const name of names) {
    if (!callSetLayout(api, name)) continue;
    const layout = currentLayout(api);
    if (!layout?.open) continue;
    const ok = PANE_IDS.every((id) => layout.open[id] === expectedOpen[id]);
    if (ok) return true;
  }
  return false;
}

function hasRearrange(src, api) {
  if (api?.reorder) return true;
  const cleaned = stripComments(src);
  if (new RegExp(String.raw`\b(?:${REORDER_FN})\s*\(`).test(cleaned)) return true;
  if (new RegExp(String.raw`export\s+\{[^}]*\b(?:${REORDER_FN})\b`).test(cleaned)) {
    return true;
  }
  const drag =
    /\bdraggable\s*=\s*["']true["']/.test(cleaned) ||
    /\.draggable\s*=\s*true/.test(cleaned) ||
    /addEventListener\(\s*["'](?:dragstart|drop|dragover)["']/.test(cleaned);
  const paneDrag =
    drag &&
    (/\bpane\b/i.test(cleaned) || PANE_IDS.some((id) => cleaned.includes(id)));
  if (paneDrag) {
    const windows = windowsAround(
      cleaned,
      /dragstart|drop|dragover|draggable/gi,
      120,
      400,
    );
    if (
      windows.some(
        (w) =>
          /shell|pane|explorer|editor|preview|insertBefore|appendChild|order/i.test(
            w,
          ),
      )
    ) {
      return true;
    }
  }
  const orderApi =
    /\b(?:paneOrder|layout\.order|setPaneOrder|order\s*=\s*\[)/.test(cleaned) &&
    /insertBefore|appendChild|style\.order|flex.*order/.test(cleaned);
  return Boolean(orderApi);
}

function layoutStorageWindows(src) {
  return windowsAround(
    stripComments(src),
    /localStorage\.(?:setItem|getItem)|window\.localStorage/g,
    80,
    500,
  );
}

function persistsPaneLayout(src, api, storage) {
  if (api) {
    const before = storageEntries(storage).length;
    try {
      callCollapse(api, "explorer", true);
    } catch {
      // ignore
    }
    try {
      api.persist?.();
    } catch {
      // ignore
    }
    const stored = layoutsFromStorage(storage);
    if (
      stored.some(
        (s) =>
          (s.layout.open && typeof s.layout.open.explorer === "boolean") ||
          s.layout.widths,
      )
    ) {
      return true;
    }
    if (storageEntries(storage).length > before && /layout|pane/i.test(JSON.stringify(storageEntries(storage)))) {
      return true;
    }
  }
  const cleaned = stripComments(src);
  if (!/localStorage/.test(cleaned)) return false;
  const windows = layoutStorageWindows(cleaned);
  if (!windows.length) return false;
  const writes = /localStorage\.setItem/.test(cleaned);
  const reads = /localStorage\.getItem/.test(cleaned);
  if (!writes || !reads) return false;
  const layoutish = windows.some((w) =>
    /layout|pane|width|collapsed|open|visible|order/i.test(w),
  );
  const widths = windows.some((w) =>
    /width|flex-basis|grid-template-columns|paneWidth|columns/i.test(w),
  );
  const open = windows.some((w) =>
    /collapsed|open|visible|hidden|closed/i.test(w),
  );
  const restore =
    new RegExp(String.raw`\b(?:${RESTORE_FN})\s*\(`).test(cleaned) ||
    windows.some((w) => /getItem/.test(w));
  return layoutish && widths && open && restore;
}

function persistsWindowSize(src, api, storage) {
  if (api) {
    const stored = layoutsFromStorage(storage);
    if (stored.some((s) => s.layout.window && (s.layout.window.width || s.layout.window.height))) {
      return true;
    }
    const layout = currentLayout(api);
    if (layout?.window && (layout.window.width || layout.window.height)) {
      if (/localStorage/.test(src)) return true;
    }
  }
  const cleaned = stripComments(src);
  const windows = layoutStorageWindows(cleaned);
  const fromStorage = windows.some(
    (w) =>
      /window(?:Size|Width|Height)|innerWidth|innerHeight|outerWidth|outerHeight/.test(
        w,
      ) ||
      (/\bwidth\b/i.test(w) && /\bheight\b/i.test(w) && /localStorage/.test(w)),
  );
  if (fromStorage && /localStorage\.setItem/.test(cleaned) && /localStorage\.getItem/.test(cleaned)) {
    return true;
  }
  const cargoPath = join(root, "src-tauri", "Cargo.toml");
  const confPath = join(root, "src-tauri", "tauri.conf.json");
  const cargo = existsSync(cargoPath) ? readFileSync(cargoPath, "utf8") : "";
  const conf = existsSync(confPath) ? readFileSync(confPath, "utf8") : "";
  if (/tauri-plugin-window-state/.test(cargo) || /window-state|windowState/.test(conf)) {
    return true;
  }
  if (
    /PhysicalSize|LogicalSize|innerSize|outerSize|setSize/.test(cleaned) &&
    /localStorage/.test(cleaned)
  ) {
    return true;
  }
  return false;
}

function defaultPanesVisibleInHtml() {
  assert.equal(existsSync(htmlPath), true, "src/index.html must exist");
  const html = readFileSync(htmlPath, "utf8");
  const indexes = [];
  for (const id of PANE_IDS) {
    const tag = html.match(new RegExp(`<[^>]*\\bid=["']${id}["'][^>]*>`));
    assert.ok(tag, `missing pane #${id}`);
    assert.equal(/\bhidden\b/.test(tag[0]), false, `#${id} must be visible`);
    assert.equal(
      /display\s*:\s*none/i.test(tag[0]),
      false,
      `#${id} must be visible`,
    );
    indexes.push(html.indexOf(tag[0]));
  }
  assert.ok(
    indexes[0] < indexes[1] && indexes[1] < indexes[2],
    "default panes must be explorer | editor | preview",
  );
  return html;
}

test("all three panes (explorer, editor, preview) are collapsible", async () => {
  const { src, api } = await loadLayoutApi();
  let runtime = false;
  if (api?.collapsePane) {
    runtime = PANE_IDS.every((id) => callCollapse(api, id, true));
  }
  assert.ok(
    runtime || sourceCollapsesAllPanes(src),
    "missing collapsePane (explorer, editor, and preview must be collapsible)",
  );
});

test("collapsing the explorer hides it with a 120ms animation", async () => {
  const { src, css, api, doc } = await loadLayoutApi();
  assert.ok(
    collapseHidesExplorer(src, api, doc),
    "collapsing the explorer must hide it with a 120ms animation (transition 120ms on width/flex/grid, not on theme colors)",
  );
  assert.ok(
    hasExplorerCollapse120(css, src),
    "collapsing the explorer must hide it with a 120ms animation (transition 120ms on width/flex/grid, not on theme colors)",
  );
});

test("editor-only and reader-only layouts work by collapsing", async () => {
  const { src, api } = await loadLayoutApi();
  const editorRuntime = runtimeNamedLayout(
    api,
    ["editor-only", "editorOnly", "editor"],
    { explorer: false, editor: true, preview: false },
  );
  const readerRuntime = runtimeNamedLayout(
    api,
    ["reader-only", "readerOnly", "reader", "preview-only", "preview"],
    { explorer: false, editor: false, preview: true },
  );
  const editorSrc =
    namedLayoutInSource(src, EDITOR_ONLY) || editorOnlyByCollapse(src);
  const readerSrc =
    namedLayoutInSource(src, READER_ONLY) || readerOnlyByCollapse(src);
  assert.ok(
    editorRuntime || editorSrc,
    "missing editor-only layout (explorer+preview collapsed)",
  );
  assert.ok(
    readerRuntime || readerSrc,
    "missing reader-only layout (explorer+editor collapsed)",
  );
  assert.ok(
    (api?.setLayout && (editorRuntime || readerRuntime)) ||
      new RegExp(String.raw`\b(?:${SET_LAYOUT_FN})\b`).test(stripComments(src)) ||
      (editorSrc && readerSrc),
    "missing setLayout (editor-only = explorer+preview collapsed; reader-only = explorer+editor collapsed)",
  );
});

test("panes can be rearranged (order is not fixed)", async () => {
  const { src, api } = await loadLayoutApi();
  if (typeof api?.reorder === "function") {
    api.reorder(["preview", "editor", "explorer"]);
    const after = currentLayout(api);
    assert.ok(after?.order, "getLayout must return order after reorder");
    assert.deepEqual(
      after.order,
      ["explorer", "preview", "editor"],
      "reorder must keep explorer first and swap editor/preview",
    );
    return;
  }
  assert.ok(
    hasRearrange(src, api),
    "missing pane rearrange (reorder/swap/drag API or controls)",
  );
});

test("restart restores pane widths and which panes were open (persist layout)", async () => {
  const { src, api, storage } = await loadLayoutApi();
  let restored = false;
  if (api && (api.persist || api.restore || api.collapsePane || api.setLayout)) {
    try {
      callCollapse(api, "explorer", true);
      api.persist?.();
    } catch {
      // ignore
    }
    const snap = layoutsFromStorage(storage);
    try {
      callCollapse(api, "explorer", false);
    } catch {
      // ignore
    }
    try {
      api.restore?.();
    } catch {
      // ignore
    }
    const after = currentLayout(api) || layoutsFromStorage(storage)[0]?.layout;
    if (
      snap.some((s) => s.layout.open && s.layout.open.explorer === false) &&
      after?.open?.explorer === false
    ) {
      restored = true;
    }
    if (snap.some((s) => s.layout.widths) && after?.widths) restored = true;
  }
  assert.ok(
    restored || persistsPaneLayout(src, api, storage),
    "restart must restore pane widths and which panes were open (persist layout in localStorage)",
  );
});

test("window size is persisted", async () => {
  const { src, api, storage } = await loadLayoutApi();
  assert.ok(
    persistsWindowSize(src, api, storage),
    "window size must be persisted",
  );
});

test("default remains all three panes visible", async () => {
  defaultPanesVisibleInHtml();
  const { api } = await loadLayoutApi();
  api.setLayout?.("three-pane");
  const layout = currentLayout(api);
  if (layout?.open) {
    for (const id of PANE_IDS) {
      assert.equal(
        layout.open[id],
        true,
        `default must remain all three panes visible (#${id} open)`,
      );
    }
  }
});

test("theme switch stays instant; nothing else animates besides pane collapse 120ms", async () => {
  const { src, css } = await loadLayoutApi();
  assert.equal(
    hasThemeColorMotion(`${css}\n${src}`),
    false,
    "theme switch must stay instant (no CSS transition/animation on theme colors)",
  );
  assert.ok(
    hasExplorerCollapse120(css, src),
    "nothing else animates besides pane collapse 120ms (missing transition 120ms on width/flex/grid)",
  );
  assert.equal(
    extraMotionBeyondCollapse120(css, src),
    false,
    "nothing else animates besides pane collapse 120ms",
  );
});
