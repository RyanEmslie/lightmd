const PANE_IDS = ["explorer", "editor", "preview"];
const STORAGE_KEY = "lightmd.layout";

export const layout = {
  order: ["explorer", "editor", "preview"],
  open: { explorer: true, editor: true, preview: true },
  widths: { explorer: 240, editor: 400, preview: 400 },
  window: { width: 800, height: 600 },
  remember: true,
};

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

function captureWidths() {
  const d = doc();
  if (!d || typeof d.getElementById !== "function") return;
  for (const id of PANE_IDS) {
    if (layout.open[id] === false) continue;
    const el = d.getElementById(id);
    const width = el?.getBoundingClientRect?.()?.width;
    if (typeof width === "number" && Number.isFinite(width) && width > 0) {
      layout.widths[id] = width;
    }
  }
}

function columnFor(id) {
  if (layout.open[id] === false) return "0px";
  if (id === "explorer") return `${layout.widths.explorer || 240}px`;
  return "1fr";
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
}

function syncLayoutControls() {
  const d = doc();
  if (!d || typeof d.getElementById !== "function") return;
  const select = d.getElementById("pane-layout");
  if (select) {
    const { explorer, editor, preview } = layout.open;
    if (!explorer && editor && !preview) select.value = "editor-only";
    else if (!explorer && !editor && preview) select.value = "reader-only";
    else select.value = "three-pane";
  }
  const orderSelect = d.getElementById("pane-order");
  if (orderSelect) {
    orderSelect.value = layout.order.join(",");
  }
  const toggles =
    typeof d.querySelectorAll === "function"
      ? d.querySelectorAll("[data-pane-toggle]")
      : [];
  for (const btn of toggles) {
    const id = btn.getAttribute?.("data-pane-toggle");
    if (!isPaneId(id)) continue;
    const open = layout.open[id] !== false;
    if (typeof btn.setAttribute === "function") {
      btn.setAttribute("aria-pressed", open ? "true" : "false");
    }
  }
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
  if (layout.remember === false) return;
  captureWidths();
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
    window: {
      width: size.width,
      height: size.height,
      innerWidth: size.width,
      innerHeight: size.height,
    },
    remember: layout.remember !== false,
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
  if (Array.isArray(parsed.order)) {
    const next = parsed.order.map(String).filter(isPaneId);
    if (next.length) layout.order = next;
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
  const win = parsed.window && typeof parsed.window === "object" ? parsed.window : parsed;
  const width = Number(win.width ?? win.innerWidth);
  const height = Number(win.height ?? win.innerHeight);
  if (Number.isFinite(width) && width > 0) layout.window.width = width;
  if (Number.isFinite(height) && height > 0) layout.window.height = height;
  if (typeof parsed.remember === "boolean") layout.remember = parsed.remember;
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
      if (next.length) layout.order = next;
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
    if (next.length) layout.order = next;
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
      reorderPanes(orderSelect.value.split(",").map((s) => s.trim()));
    });
  }
  const toggles =
    typeof d.querySelectorAll === "function"
      ? d.querySelectorAll("[data-pane-toggle]")
      : [];
  for (const btn of toggles) {
    if (typeof btn.addEventListener !== "function") continue;
    btn.addEventListener("click", () => {
      const id = btn.getAttribute?.("data-pane-toggle");
      if (!isPaneId(id)) return;
      collapsePane(id, layout.open[id] !== false);
    });
  }
  if (typeof globalThis.addEventListener === "function") {
    globalThis.addEventListener("resize", () => {
      persistLayout();
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
