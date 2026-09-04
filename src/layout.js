const PANE_IDS = ["explorer", "editor", "preview"];
const STORAGE_KEY = "lightmd.layout";
const MIN_PANE = 160;
const SIDEBAR_TOGGLE_IDS = ["sidebar-toggle", "nav-toggle", "toggle-sidebar", "toggle-nav"];
const SIDEBAR_NAME_RE = /\b(?:toggle\s+)?sidebar\b|\btoggle\s+nav\b/i;

export const layout = {
  order: ["explorer", "editor", "preview"],
  open: { explorer: true, editor: true, preview: true },
  widths: { explorer: 240, editor: 400, preview: 400 },
  window: { width: 800, height: 600 },
  remember: true,
  fixed: { explorer: true, editor: false, preview: false },
};

let drag = null;
let pointerTrackingBound = false;
const boundSplitters = new WeakSet();

function doc() {
  return typeof globalThis.document !== "undefined" ? globalThis.document : null;
}

function storage() {
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
}

function isPaneId(id) {
  return PANE_IDS.includes(id);
}

function normalizeOrder(order) {
  const incoming = Array.isArray(order) ? order.map(String).filter(isPaneId) : [];
  const source = incoming.length ? incoming : layout.order;
  const seen = new Set();
  const content = [];
  for (const id of source) {
    if (!isPaneId(id) || id === "explorer" || seen.has(id)) continue;
    seen.add(id);
    content.push(id);
  }
  for (const id of PANE_IDS) {
    if (id === "explorer" || seen.has(id)) continue;
    content.push(id);
  }
  return ["explorer", ...content];
}

function contentOrder(order = layout.order) {
  return normalizeOrder(order).filter((id) => id !== "explorer");
}

function elId(el) {
  return String(el?.id || (typeof el?.getAttribute === "function" ? el.getAttribute("id") : "") || "");
}

function isSidebarToggleEl(el) {
  if (!el) return false;
  if (SIDEBAR_TOGGLE_IDS.includes(elId(el))) return true;
  const names = [
    typeof el.getAttribute === "function" ? el.getAttribute("aria-label") : "",
    typeof el.getAttribute === "function" ? el.getAttribute("title") : "",
    el.title,
  ]
    .filter(Boolean)
    .join(" ");
  return SIDEBAR_NAME_RE.test(names);
}

function windowSize() {
  const win = globalThis.window ?? globalThis;
  const width =
    typeof win.innerWidth === "number" && Number.isFinite(win.innerWidth)
      ? win.innerWidth
      : layout.window.width;
  const height =
    typeof win.innerHeight === "number" && Number.isFinite(win.innerHeight)
      ? win.innerHeight
      : layout.window.height;
  return { width, height };
}

function clampOpenWidth(n, fallback = 240) {
  const w = Number(n);
  const base = Number.isFinite(w) && w > 0 ? w : fallback;
  return Math.max(MIN_PANE, base);
}

function clampOpenPaneWidths() {
  for (const id of PANE_IDS) {
    if (layout.open[id] === false) continue;
    layout.widths[id] = clampOpenWidth(layout.widths[id], layout.widths[id] || 240);
  }
}

function captureWidths() {
  const d = doc();
  if (!d || typeof d.getElementById !== "function") return;
  for (const id of PANE_IDS) {
    if (layout.open[id] === false) continue;
    const el = d.getElementById(id);
    const width = el?.getBoundingClientRect?.()?.width;
    if (typeof width === "number" && Number.isFinite(width) && width > 0) {
      layout.widths[id] = clampOpenWidth(width, layout.widths[id] || 240);
    }
  }
  clampOpenPaneWidths();
}

function columnFor(id) {
  if (layout.open[id] === false) return "0px";
  if (id === "explorer" || layout.fixed[id]) {
    return `minmax(${clampOpenWidth(layout.widths[id])}px, 1fr)`;
  }
  return `minmax(${MIN_PANE}px, 1fr)`;
}

function visiblePaneIds() {
  return layout.order.filter((id) => isPaneId(id) && layout.open[id] !== false);
}

function paneWidth(id) {
  const d = doc();
  const el = d && typeof d.getElementById === "function" ? d.getElementById(id) : null;
  const measured = el?.getBoundingClientRect?.()?.width;
  if (typeof measured === "number" && Number.isFinite(measured) && measured > 0) {
    return measured;
  }
  const stored = Number(layout.widths[id]);
  if (Number.isFinite(stored) && stored > 0) return stored;
  return 240;
}

function isSplitterEl(el) {
  if (!el) return false;
  if (el.classList && typeof el.classList.contains === "function" && el.classList.contains("splitter")) {
    return true;
  }
  if (/\bsplitter\b/.test(el.className || "")) return true;
  if (typeof el.getAttribute === "function" && el.getAttribute("role") === "separator") return true;
  return false;
}

function collectSplitters(d) {
  const out = [];
  const seen = new Set();
  if (!d || typeof d.querySelectorAll !== "function") return out;
  for (const sel of [".splitter", '[role="separator"]']) {
    let list = [];
    try {
      list = d.querySelectorAll(sel) || [];
    } catch {
      list = [];
    }
    for (const el of list) {
      if (!el || seen.has(el)) continue;
      seen.add(el);
      out.push(el);
    }
  }
  return out;
}

function showSplitter(el) {
  if (!el) return;
  el.hidden = false;
  if (typeof el.removeAttribute === "function") el.removeAttribute("hidden");
  if (el.style) el.style.display = "";
}

function hideSplitter(el) {
  if (!el) return;
  el.hidden = true;
  if (typeof el.setAttribute === "function") el.setAttribute("hidden", "");
  if (el.dataset) {
    el.dataset.left = "";
    el.dataset.right = "";
  }
}

function pairForSplitter(el) {
  if (!el) return null;
  const left = el.dataset?.left;
  const right = el.dataset?.right;
  if (isPaneId(left) && isPaneId(right) && layout.open[left] !== false && layout.open[right] !== false) {
    return [left, right];
  }
  const parentId = el.parentNode?.id;
  const vis = visiblePaneIds();
  const idx = vis.indexOf(parentId);
  if (idx >= 0 && idx < vis.length - 1) return [vis[idx], vis[idx + 1]];
  return null;
}

function freezeVisiblePaneWidths(except = []) {
  const skip = new Set(except);
  for (const id of visiblePaneIds()) {
    layout.fixed[id] = true;
    if (skip.has(id)) continue;
    layout.widths[id] = clampOpenWidth(paneWidth(id), layout.widths[id] || 240);
  }
}

function liftPairToMin(leftStart, rightStart) {
  let left = leftStart;
  let right = rightStart;
  if (left < MIN_PANE) {
    right -= MIN_PANE - left;
    left = MIN_PANE;
  }
  if (right < MIN_PANE) {
    left -= MIN_PANE - right;
    right = MIN_PANE;
  }
  left = Math.max(MIN_PANE, left);
  right = Math.max(MIN_PANE, right);
  return { left, right };
}

function applySplitterDelta(left, right, delta, startLeft, startRight) {
  if (!isPaneId(left) || !isPaneId(right)) return false;
  if (layout.open[left] === false || layout.open[right] === false) return false;
  freezeVisiblePaneWidths([left, right]);
  const sl = Number(startLeft);
  const sr = Number(startRight);
  let leftStart = Number.isFinite(sl) && sl > 0 ? sl : paneWidth(left);
  let rightStart = Number.isFinite(sr) && sr > 0 ? sr : paneWidth(right);
  let d = Number(delta);
  if (!Number.isFinite(d)) d = 0;
  let minD = MIN_PANE - leftStart;
  let maxD = rightStart - MIN_PANE;
  if (maxD < minD) {
    const lifted = liftPairToMin(leftStart, rightStart);
    leftStart = lifted.left;
    rightStart = lifted.right;
    minD = MIN_PANE - leftStart;
    maxD = rightStart - MIN_PANE;
  }
  if (minD <= maxD) {
    if (d < minD) d = minD;
    if (d > maxD) d = maxD;
  } else {
    d = 0;
  }
  layout.widths[left] = Math.max(MIN_PANE, leftStart + d);
  layout.widths[right] = Math.max(MIN_PANE, rightStart - d);
  layout.fixed[left] = true;
  layout.fixed[right] = true;
  applyLayoutToDom();
  return true;
}

function persistAfterDrag(end) {
  if (end) persistLayout();
  else if (layout.remember !== false) persistLayout();
}

function eventClientX(ev) {
  const x = Number(ev?.clientX);
  if (Number.isFinite(x)) return x;
  const pageX = Number(ev?.pageX);
  if (Number.isFinite(pageX)) return pageX;
  return null;
}

function onSplitterDown(ev) {
  if (drag) return;
  const target = ev?.currentTarget && isSplitterEl(ev.currentTarget) ? ev.currentTarget : ev?.target;
  const el = isSplitterEl(target) ? target : null;
  if (!el) return;
  const pair = pairForSplitter(el);
  if (!pair) return;
  const startX = eventClientX(ev);
  if (startX == null) return;
  if (typeof ev.preventDefault === "function") ev.preventDefault();
  freezeVisiblePaneWidths();
  drag = {
    left: pair[0],
    right: pair[1],
    startX,
    startLeft: paneWidth(pair[0]),
    startRight: paneWidth(pair[1]),
    pointerId: ev.pointerId,
    el,
  };
  if (ev.pointerId != null && typeof el.setPointerCapture === "function") {
    try {
      el.setPointerCapture(ev.pointerId);
    } catch {
      // capture is optional in tests / non-pointer hosts
    }
  }
}

function onPointerMove(ev) {
  if (!drag) return;
  const x = eventClientX(ev);
  if (x == null) return;
  const delta = x - drag.startX;
  applySplitterDelta(drag.left, drag.right, delta, drag.startLeft, drag.startRight);
  persistAfterDrag(false);
}

function onPointerUp(ev) {
  if (!drag) return;
  const x = eventClientX(ev);
  if (x != null) {
    applySplitterDelta(drag.left, drag.right, x - drag.startX, drag.startLeft, drag.startRight);
  }
  const el = drag.el;
  const pointerId = drag.pointerId;
  drag = null;
  if (pointerId != null && el && typeof el.releasePointerCapture === "function") {
    try {
      el.releasePointerCapture(pointerId);
    } catch {
      // ignore
    }
  }
  persistAfterDrag(true);
}

function ensureSplitterBound(el) {
  if (!el || boundSplitters.has(el)) return;
  if (typeof el.addEventListener !== "function") return;
  boundSplitters.add(el);
  el.addEventListener("pointerdown", onSplitterDown);
  el.addEventListener("mousedown", onSplitterDown);
}

function placeSplitters() {
  const d = doc();
  if (!d) return;
  const vis = visiblePaneIds();
  const splitters = collectSplitters(d);
  const used = new Set();
  for (let i = 0; i < vis.length - 1; i++) {
    const leftId = vis[i];
    const rightId = vis[i + 1];
    const leftEl = typeof d.getElementById === "function" ? d.getElementById(leftId) : null;
    let splitter = null;
    const kids = leftEl && Array.isArray(leftEl.children) ? leftEl.children : leftEl?.children;
    if (kids) {
      for (const child of kids) {
        if (isSplitterEl(child) && !used.has(child)) {
          splitter = child;
          break;
        }
      }
    }
    if (!splitter) {
      splitter = splitters.find((s) => !used.has(s)) || null;
    }
    if (!splitter) continue;
    used.add(splitter);
    if (leftEl && splitter.parentNode !== leftEl && typeof leftEl.appendChild === "function") {
      leftEl.appendChild(splitter);
    }
    if (splitter.dataset) {
      splitter.dataset.left = leftId;
      splitter.dataset.right = rightId;
    }
    showSplitter(splitter);
    ensureSplitterBound(splitter);
  }
  for (const splitter of splitters) {
    if (used.has(splitter)) continue;
    hideSplitter(splitter);
  }
}

function bindPointerTracking() {
  if (pointerTrackingBound) return;
  pointerTrackingBound = true;
  const targets = [doc(), globalThis];
  for (const t of targets) {
    if (!t || typeof t.addEventListener !== "function") continue;
    t.addEventListener("pointermove", onPointerMove);
    t.addEventListener("pointerup", onPointerUp);
    t.addEventListener("pointercancel", onPointerUp);
    t.addEventListener("mousemove", onPointerMove);
    t.addEventListener("mouseup", onPointerUp);
  }
}

export function dragSplitter(left, right, deltaX) {
  if (left && typeof left === "object") {
    deltaX = left.deltaX ?? left.delta ?? deltaX;
    right = left.right ?? right;
    left = left.left;
  } else if (right && typeof right === "object") {
    deltaX = right.deltaX ?? right.delta ?? deltaX;
  } else if (typeof left === "number" && typeof right === "number") {
    const vis = visiblePaneIds();
    const pair = vis[left] && vis[left + 1] ? [vis[left], vis[left + 1]] : null;
    if (!pair) return;
    left = pair[0];
    deltaX = right;
    right = pair[1];
  }
  const ok = applySplitterDelta(left, right, deltaX, paneWidth(left), paneWidth(right));
  if (ok) persistAfterDrag(true);
}

function applyPane(el, open) {
  if (!el) return;
  el.hidden = !open;
  if (open) {
    if (typeof el.removeAttribute === "function") el.removeAttribute("hidden");
    if (el.classList && typeof el.classList.remove === "function") {
      el.classList.remove("collapsed", "closed", "hidden", "is-collapsed");
    }
    if (el.style) {
      el.style.width = "";
      el.style.minWidth = "";
      el.style.flex = "";
      el.style.flexBasis = "";
    }
  } else {
    if (typeof el.setAttribute === "function") el.setAttribute("hidden", "");
    if (el.classList && typeof el.classList.add === "function") {
      el.classList.add("collapsed");
    }
    if (el.style) {
      el.style.width = "0px";
      el.style.minWidth = "0px";
      el.style.flex = "0";
      el.style.flexBasis = "0px";
    }
  }
}

function applyLayoutToDom() {
  const d = doc();
  layout.order = normalizeOrder(layout.order);
  if (!d || typeof d.getElementById !== "function") return;
  const shell = d.getElementById("shell");
  const cols = [];
  for (const id of layout.order) {
    if (!isPaneId(id)) continue;
    cols.push(columnFor(id));
    applyPane(d.getElementById(id), layout.open[id] !== false);
  }
  if (shell && shell.style) {
    shell.style.gridTemplateColumns = cols.join(" ");
  }
  if (shell && typeof shell.appendChild === "function") {
    for (const id of layout.order) {
      const el = d.getElementById(id);
      if (el) shell.appendChild(el);
    }
  }
  syncLayoutControls();
  placeSplitters();
}

function syncSidebarToggle() {
  const d = doc();
  if (!d || typeof d.getElementById !== "function") return;
  const open = layout.open.explorer !== false;
  const pressed = open ? "true" : "false";
  for (const id of SIDEBAR_TOGGLE_IDS) {
    const btn = d.getElementById(id);
    if (!btn || typeof btn.setAttribute !== "function") continue;
    btn.setAttribute("aria-pressed", pressed);
    btn.setAttribute("aria-expanded", pressed);
  }
}

function syncLayoutControls() {
  const d = doc();
  if (!d || typeof d.getElementById !== "function") return;
  const select = d.getElementById("pane-layout");
  if (select) {
    const { explorer, editor, preview } = layout.open;
    if (!explorer && editor && !preview) select.value = "editor-only";
    else if (!explorer && !editor && preview) select.value = "reader-only";
    else if (!explorer && editor && preview) select.value = "editor-preview";
    else select.value = "three-pane";
  }
  const orderSelect = d.getElementById("pane-order");
  if (orderSelect) {
    orderSelect.value = contentOrder().join(",");
  }
  const toggles =
    typeof d.querySelectorAll === "function"
      ? d.querySelectorAll("[data-pane-toggle]")
      : [];
  for (const btn of toggles) {
    const id = btn.getAttribute?.("data-pane-toggle");
    if (!isPaneId(id)) continue;
    const open = layout.open[id] !== false;
    const pressed = open ? "true" : "false";
    if (isSidebarToggleEl(btn)) {
      if (typeof btn.setAttribute === "function") {
        btn.setAttribute("aria-pressed", pressed);
        btn.setAttribute("aria-expanded", pressed);
      }
      continue;
    }
    const label = open ? "Hide" : "Show";
    if (typeof btn.setAttribute === "function") {
      btn.setAttribute("aria-pressed", pressed);
      if (btn.getAttribute?.("aria-label") != null) {
        btn.setAttribute("aria-label", label);
      }
      if (btn.getAttribute?.("title") != null) {
        btn.setAttribute("title", label);
      }
    }
    const markup = String(btn.innerHTML || "");
    if (!/<svg\b|<img\b|<i\b|<use\b/i.test(markup)) {
      btn.textContent = label;
    }
  }
  syncSidebarToggle();
}

function applyWindowSize() {
  const width = layout.window.width;
  const height = layout.window.height;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return;
  try {
    const tw = globalThis.__TAURI__?.window || globalThis.__TAURI__?.webviewWindow;
    const LogicalSize = tw?.LogicalSize || globalThis.__TAURI__?.dpi?.LogicalSize;
    const getCurrent = tw?.getCurrentWindow || tw?.getCurrentWebviewWindow;
    if (typeof getCurrent === "function" && LogicalSize) {
      const size = new LogicalSize(width, height);
      const win = getCurrent();
      if (win && typeof win.setSize === "function") {
        const ret = win.setSize(size);
        if (ret && typeof ret.catch === "function") ret.catch(() => {});
      }
    }
  } catch {}
}

export function persistLayout() {
  const ls = storage();
  if (!ls || typeof ls.setItem !== "function") return;
  if (layout.remember === false) {
    try {
      ls.setItem(STORAGE_KEY, JSON.stringify({ remember: false }));
    } catch {
      // ignore quota / missing storage
    }
    return;
  }
  captureWidths();
  clampOpenPaneWidths();
  layout.order = normalizeOrder(layout.order);
  const size = windowSize();
  layout.window.width = size.width;
  layout.window.height = size.height;
  const collapsed = {
    explorer: !layout.open.explorer,
    editor: !layout.open.editor,
    preview: !layout.open.preview,
  };
  const payload = {
    order: layout.order.slice(),
    open: { ...layout.open },
    collapsed,
    widths: { ...layout.widths },
    fixed: { ...layout.fixed },
    window: {
      width: size.width,
      height: size.height,
      innerWidth: size.width,
      innerHeight: size.height,
    },
    remember: true,
  };
  try {
    ls.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // ignore quota / missing storage
  }
}

export function restoreLayout() {
  const ls = storage();
  if (!ls || typeof ls.getItem !== "function") return;
  const raw = ls.getItem(STORAGE_KEY);
  if (raw == null || raw === "") return;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return;
  }
  if (!parsed || typeof parsed !== "object") return;
  if (parsed.remember === false) {
    layout.remember = false;
    return;
  }
  if (Array.isArray(parsed.order)) {
    const next = parsed.order.map(String).filter(isPaneId);
    if (next.length) layout.order = normalizeOrder(next);
  } else {
    layout.order = normalizeOrder(layout.order);
  }
  let sawOpen = false;
  if (parsed.open && typeof parsed.open === "object" && !Array.isArray(parsed.open)) {
    for (const id of PANE_IDS) {
      if (typeof parsed.open[id] === "boolean") {
        layout.open[id] = parsed.open[id];
        sawOpen = true;
      }
    }
  }
  if (!sawOpen && parsed.collapsed && typeof parsed.collapsed === "object") {
    if (Array.isArray(parsed.collapsed)) {
      for (const id of PANE_IDS) {
        layout.open[id] = !parsed.collapsed.map(String).includes(id);
      }
    } else {
      for (const id of PANE_IDS) {
        if (typeof parsed.collapsed[id] === "boolean") {
          layout.open[id] = !parsed.collapsed[id];
        }
      }
    }
  }
  if (parsed.widths && typeof parsed.widths === "object") {
    for (const id of PANE_IDS) {
      const n = Number(parsed.widths[id]);
      if (Number.isFinite(n) && n > 0) layout.widths[id] = n;
    }
  }
  layout.fixed = { explorer: true, editor: false, preview: false };
  if (parsed.fixed && typeof parsed.fixed === "object") {
    for (const id of PANE_IDS) {
      if (typeof parsed.fixed[id] === "boolean") layout.fixed[id] = parsed.fixed[id];
    }
  }
  const win = parsed.window && typeof parsed.window === "object" ? parsed.window : parsed;
  const width = Number(win.width ?? win.innerWidth);
  const height = Number(win.height ?? win.innerHeight);
  if (Number.isFinite(width) && width > 0) layout.window.width = width;
  if (Number.isFinite(height) && height > 0) layout.window.height = height;
  if (typeof parsed.remember === "boolean") layout.remember = parsed.remember;
  clampOpenPaneWidths();
  applyWindowSize();
  applyLayoutToDom();
}

export function collapsePane(id, collapsed) {
  if (!isPaneId(id)) return;
  layout.open[id] = !collapsed;
  applyLayoutToDom();
  persistLayout();
}

export function setLayout(nameOrState) {
  if (nameOrState === "editor-only" || nameOrState === "editorOnly") {
    layout.open.explorer = false;
    layout.open.editor = true;
    layout.open.preview = false;
  } else if (nameOrState === "reader-only" || nameOrState === "readerOnly") {
    layout.open.explorer = false;
    layout.open.editor = false;
    layout.open.preview = true;
  } else if (nameOrState === "editor-preview" || nameOrState === "two-pane") {
    layout.open.explorer = false;
    layout.open.editor = true;
    layout.open.preview = true;
  } else if (nameOrState === "three-pane" || nameOrState === "default") {
    layout.open.explorer = true;
    layout.open.editor = true;
    layout.open.preview = true;
  } else if (nameOrState && typeof nameOrState === "object") {
    for (const id of PANE_IDS) {
      if (typeof nameOrState[id] === "boolean") layout.open[id] = nameOrState[id];
    }
    const nested = nameOrState.open;
    if (nested && typeof nested === "object") {
      for (const id of PANE_IDS) {
        if (typeof nested[id] === "boolean") layout.open[id] = nested[id];
      }
    }
    if (Array.isArray(nameOrState.order)) {
      const next = nameOrState.order.map(String).filter(isPaneId);
      if (next.length) layout.order = normalizeOrder(next);
    }
  } else {
    return;
  }
  applyLayoutToDom();
  persistLayout();
}

export function reorderPanes(order) {
  if (Array.isArray(order)) {
    const next = order.map(String).filter(isPaneId);
    if (next.length) layout.order = normalizeOrder(next);
  } else {
    layout.order = normalizeOrder(layout.order);
  }
  applyLayoutToDom();
  persistLayout();
}

export function getLayout() {
  return layout;
}

function bindLayoutControls() {
  const d = doc();
  if (!d || typeof d.getElementById !== "function") return;
  const select = d.getElementById("pane-layout");
  if (select && typeof select.addEventListener === "function") {
    select.addEventListener("change", () => {
      setLayout(select.value);
    });
  }
  const orderSelect = d.getElementById("pane-order");
  if (orderSelect && typeof orderSelect.addEventListener === "function") {
    orderSelect.addEventListener("change", () => {
      reorderPanes(String(orderSelect.value || "").split(",").map((s) => s.trim()));
    });
  }
  const toggles =
    typeof d.querySelectorAll === "function"
      ? d.querySelectorAll("[data-pane-toggle]")
      : [];
  for (const btn of toggles) {
    if (typeof btn.addEventListener !== "function") continue;
    if (isSidebarToggleEl(btn)) continue;
    btn.addEventListener("click", () => {
      const id = btn.getAttribute?.("data-pane-toggle");
      if (!isPaneId(id)) return;
      collapsePane(id, layout.open[id] !== false);
    });
  }
  bindSidebarToggle();
  if (typeof globalThis.addEventListener === "function") {
    globalThis.addEventListener("resize", () => {
      persistLayout();
    });
  }
  placeSplitters();
  bindPointerTracking();
}

function bindSidebarToggle() {
  const d = doc();
  if (!d || typeof d.getElementById !== "function") return;
  const seen = new Set();
  for (const id of SIDEBAR_TOGGLE_IDS) {
    const btn = d.getElementById(id);
    if (!btn || seen.has(btn) || typeof btn.addEventListener !== "function") continue;
    seen.add(btn);
    btn.addEventListener("click", () => {
      collapsePane("explorer", layout.open.explorer !== false);
    });
  }
}

try {
  restoreLayout();
} catch {
  // DOM-optional: Node imports this module with a document mock.
}

try {
  bindLayoutControls();
} catch {
  // mock document has no addEventListener
}
