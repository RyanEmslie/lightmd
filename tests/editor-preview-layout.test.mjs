import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const htmlPath = join(root, "src", "index.html");
const PANE_IDS = ["explorer", "editor", "preview"];
const PREFERRED_MODE = "editor-preview";
const MODE_NAMES = ["editor-preview", "two-pane"];
const MODE_LABEL_RE = /editor\s*\+\s*preview/i;
const OPEN_FILE_MARKER = "notes/a.md";

function labelOf(btn) {
  return (btn.textContent || "").trim() || (btn.getAttribute("aria-label") || "").trim();
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

function mockClassList() {
  const set = new Set();
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

function mockPane(id) {
  const attrs = { id };
  const el = {
    id,
    hidden: false,
    textContent: "",
    style: {},
    classList: mockClassList(),
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

function mockToggle(paneId) {
  const attrs = {
    "data-pane-toggle": paneId,
    "aria-pressed": "true",
    "aria-label": "Hide",
  };
  const el = {
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
  return el;
}

function mockOption(value, label, selected = false) {
  const attrs = { value: String(value) };
  if (selected) attrs.selected = "";
  return {
    value: String(value),
    textContent: String(label),
    text: String(label),
    label: String(label),
    selected: !!selected,
    getAttribute(name) {
      const key = String(name);
      if (key === "value") return String(value);
      return Object.prototype.hasOwnProperty.call(attrs, key) ? attrs[key] : null;
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
      return Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null;
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

function loadHtml() {
  assert.equal(existsSync(htmlPath), true, "src/index.html must exist");
  return readFileSync(htmlPath, "utf8");
}

function paneLayoutSelectInner(html) {
  const m = String(html).match(
    /<select\b[^>]*\bid=["']pane-layout["'][^>]*>([\s\S]*?)<\/select>/i,
  );
  return m ? m[1] : "";
}

function parseSelectOptions(inner) {
  const out = [];
  const re = /<option\b([^>]*)>([\s\S]*?)<\/option>/gi;
  let m;
  while ((m = re.exec(inner))) {
    const attrs = m[1];
    const label = m[2].replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
    const vm = attrs.match(/\bvalue=("([^"]*)"|'([^']*)'|([^\s>]+))/i);
    const value = vm ? (vm[2] ?? vm[3] ?? vm[4] ?? "") : "";
    out.push({
      value,
      label,
      selected: /\bselected\b/i.test(attrs),
    });
  }
  return out;
}

function isEditorPreviewOption(opt) {
  if (!opt) return false;
  if (MODE_NAMES.includes(String(opt.value))) return true;
  const label = String(opt.label || opt.textContent || opt.text || "");
  return MODE_LABEL_RE.test(label);
}

function findEditorPreviewOption(select) {
  const opts = [];
  if (select?.options) opts.push(...select.options);
  if (typeof select?.querySelectorAll === "function") {
    for (const o of select.querySelectorAll("option")) opts.push(o);
  }
  return opts.find((o) => isEditorPreviewOption(o)) || null;
}

function htmlEditorPreviewOption(html) {
  const inner = paneLayoutSelectInner(html);
  assert.ok(inner, "#pane-layout <select> must exist in src/index.html");
  return parseSelectOptions(inner).find(isEditorPreviewOption) || null;
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

function installFixture() {
  const byId = new Map();
  const toggles = [];
  const shell = mockPane("shell");
  byId.set("shell", shell);
  for (const id of PANE_IDS) {
    const pane = mockPane(id);
    byId.set(id, pane);
    shell.appendChild(pane);
    toggles.push(mockToggle(id));
    toggles.push(mockToggle(id));
  }

  const htmlOptions = parseSelectOptions(paneLayoutSelectInner(loadHtml()));
  const optionSpecs =
    htmlOptions.length > 0
      ? htmlOptions
      : [
          { value: "three-pane", label: "Three panes", selected: true },
          { value: "editor-only", label: "Editor only", selected: false },
          { value: "reader-only", label: "Reader only", selected: false },
        ];
  const select = mockSelect("pane-layout", optionSpecs);
  byId.set("pane-layout", select);

  const statusPath = mockPane("status-path");
  byId.set("status-path", statusPath);

  const doc = {
    getElementById(id) {
      return byId.get(String(id)) || null;
    },
    querySelector(sel) {
      const m = String(sel || "").match(/^#([\w-]+)$/);
      return m ? byId.get(m[1]) || null : null;
    },
    querySelectorAll(sel) {
      if (String(sel) === "[data-pane-toggle]") return toggles.slice();
      if (String(sel) === "#pane-layout option" || String(sel) === "option") {
        return select.options.slice();
      }
      return [];
    },
  };

  const storage = memoryStorage();
  globalThis.document = doc;
  globalThis.localStorage = storage;
  if (!globalThis.window) globalThis.window = globalThis;
  return { doc, toggles, select, statusPath, storage };
}

const { doc, toggles, select, statusPath, storage } = installFixture();

const { setLayout, getLayout, persistLayout, restoreLayout, collapsePane } = await import(
  `${pathToFileURL(join(root, "src", "layout.js")).href}?editor-preview-layout=${Date.now()}`
);

function useFixture() {
  globalThis.document = doc;
  globalThis.localStorage = storage;
}

function resetThreePane() {
  useFixture();
  const live = getLayout();
  if (live && typeof live === "object") live.remember = true;
  setLayout("three-pane");
}

function togglesFor(id) {
  return toggles.filter((btn) => btn.getAttribute("data-pane-toggle") === id);
}

function assertOpenFlags(open, expected, when) {
  assert.equal(
    open.explorer,
    expected.explorer,
    `${when}: getLayout().open.explorer must be ${expected.explorer}`,
  );
  assert.equal(
    open.editor,
    expected.editor,
    `${when}: getLayout().open.editor must be ${expected.editor}`,
  );
  assert.equal(
    open.preview,
    expected.preview,
    `${when}: getLayout().open.preview must be ${expected.preview}`,
  );
}

function assertPaneDom(expected, when) {
  for (const id of PANE_IDS) {
    const el = doc.getElementById(id);
    assert.ok(el, `${when}: missing pane #${id}`);
    const shown = paneIsShown(el);
    if (expected[id]) {
      assert.equal(
        shown,
        true,
        `${when}: #${id} must be visible (not hidden / not collapsed)`,
      );
    } else {
      assert.equal(
        shown,
        false,
        `${when}: #${id} must be collapsed/hidden`,
      );
    }
  }
}

function assertPaneToggles(id, { label, pressed }) {
  const pair = togglesFor(id);
  assert.equal(pair.length, 2, `${id} must have two toggles (toolbar + in-pane)`);
  for (const [i, btn] of pair.entries()) {
    const where = i === 0 ? "toolbar" : "in-pane";
    assert.equal(
      labelOf(btn),
      label,
      `${id} ${where} toggle label must be ${label}, got ${JSON.stringify(labelOf(btn))}`,
    );
    assert.equal(
      btn.getAttribute("aria-pressed"),
      pressed,
      `${id} ${where} toggle aria-pressed must be ${pressed}, got ${JSON.stringify(btn.getAttribute("aria-pressed"))}`,
    );
  }
}

test("fixture: layout APIs, panes, existing #pane-layout options, and toggles", () => {
  useFixture();
  assert.equal(typeof setLayout, "function", "setLayout must be exported");
  assert.equal(typeof getLayout, "function", "getLayout must be exported");
  assert.equal(typeof persistLayout, "function", "persistLayout must be exported");
  assert.equal(typeof restoreLayout, "function", "restoreLayout must be exported");
  assert.equal(typeof collapsePane, "function", "collapsePane must be exported");
  assert.ok(doc.getElementById("shell"), "missing #shell");
  for (const id of PANE_IDS) {
    assert.ok(doc.getElementById(id), `missing pane #${id}`);
  }
  const live = doc.getElementById("pane-layout");
  assert.ok(live, "missing #pane-layout");
  const values = [...(live.options || [])].map((o) => String(o.value));
  for (const name of ["three-pane", "editor-only", "reader-only"]) {
    assert.ok(values.includes(name), `#pane-layout must keep existing option ${name}`);
  }
  resetThreePane();
  assertOpenFlags(getLayout().open, { explorer: true, editor: true, preview: true }, "three-pane");
  assertPaneDom({ explorer: true, editor: true, preview: true }, "three-pane");
});

test('setLayout("editor-preview"): explorer closed; editor+preview open', () => {
  resetThreePane();
  setLayout(PREFERRED_MODE);
  const open = getLayout().open;
  assertOpenFlags(open, { explorer: false, editor: true, preview: true }, "editor-preview");
  assertPaneDom({ explorer: false, editor: true, preview: true }, "editor-preview");
});

test('#pane-layout in src/index.html includes Editor + preview option', () => {
  const html = loadHtml();
  const opt = htmlEditorPreviewOption(html);
  assert.ok(
    opt,
    '#pane-layout must include <option value="editor-preview"> (or "two-pane") labeled like "Editor + preview"',
  );
  assert.ok(
    MODE_NAMES.includes(String(opt.value)),
    `Editor + preview option value must be editor-preview or two-pane, got ${JSON.stringify(opt.value)}`,
  );
  assert.match(
    String(opt.label),
    MODE_LABEL_RE,
    `Editor + preview option label must look like "Editor + preview", got ${JSON.stringify(opt.label)}`,
  );
});

test("selecting Editor + preview in #pane-layout applies that layout", () => {
  resetThreePane();
  const live = doc.getElementById("pane-layout");
  assert.ok(live, "missing #pane-layout");
  const opt = findEditorPreviewOption(live);
  assert.ok(
    opt,
    '#pane-layout must include an Editor + preview option (value editor-preview or two-pane) after load',
  );
  live.value = opt.value;
  if (typeof live.dispatchEvent === "function") {
    live.dispatchEvent({ type: "change", target: live });
  } else {
    setLayout(live.value);
  }
  assertOpenFlags(
    getLayout().open,
    { explorer: false, editor: true, preview: true },
    `selecting ${opt.value}`,
  );
});

test('after setLayout("editor-preview"), #pane-layout value is not three-pane', () => {
  resetThreePane();
  setLayout(PREFERRED_MODE);
  const live = doc.getElementById("pane-layout");
  assert.ok(live, "missing #pane-layout");
  assert.notEqual(
    live.value,
    "three-pane",
    'syncLayoutControls must not map editor+preview (explorer collapsed) to "three-pane"',
  );
  assert.ok(
    MODE_NAMES.includes(String(live.value)),
    `#pane-layout select.value must sync to editor-preview (or two-pane), got ${JSON.stringify(live.value)}`,
  );
});

test('setLayout("three-pane") after editor-preview restores explorer and leaves the open file', () => {
  resetThreePane();
  globalThis.__lightmdTestRelative = OPEN_FILE_MARKER;
  statusPath.textContent = OPEN_FILE_MARKER;

  setLayout(PREFERRED_MODE);
  assertOpenFlags(
    getLayout().open,
    { explorer: false, editor: true, preview: true },
    "editor-preview before switching back",
  );

  setLayout("three-pane");
  assertOpenFlags(
    getLayout().open,
    { explorer: true, editor: true, preview: true },
    "three-pane after editor-preview",
  );
  assertPaneDom({ explorer: true, editor: true, preview: true }, "three-pane after editor-preview");

  assert.equal(
    globalThis.__lightmdTestRelative,
    OPEN_FILE_MARKER,
    "layout switch must not clear the open-file marker (globalThis.__lightmdTestRelative)",
  );
  assert.equal(
    statusPath.textContent,
    OPEN_FILE_MARKER,
    "layout switch must not clear #status-path (file state is not layout state)",
  );
});

test("persistLayout/restoreLayout round-trips editor-preview while remember is on", () => {
  resetThreePane();
  const live = getLayout();
  live.remember = true;
  setLayout(PREFERRED_MODE);
  persistLayout();

  live.open.explorer = true;
  live.open.editor = true;
  live.open.preview = true;
  assert.equal(live.open.explorer, true, "precondition: live open mutated to three-pane");

  restoreLayout();
  assertOpenFlags(
    getLayout().open,
    { explorer: false, editor: true, preview: true },
    "restoreLayout after editor-preview persist",
  );
});

test('editor-preview: explorer Hide/Show labels are Show while explorer is collapsed', () => {
  resetThreePane();
  setLayout(PREFERRED_MODE);
  assert.equal(getLayout().open.explorer, false, "editor-preview must collapse explorer");
  assertPaneToggles("explorer", { label: "Show", pressed: "false" });
  assertPaneToggles("editor", { label: "Hide", pressed: "true" });
  assertPaneToggles("preview", { label: "Hide", pressed: "true" });
});
