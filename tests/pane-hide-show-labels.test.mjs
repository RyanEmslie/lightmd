import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const PANE_IDS = ["explorer", "editor", "preview"];

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
  };
}

function mockPane(id) {
  const attrs = { id };
  const el = {
    id,
    hidden: false,
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

function installFixture() {
  const byId = new Map();
  const toggles = [];
  const shell = mockPane("shell");
  byId.set("shell", shell);
  for (const id of PANE_IDS) {
    const pane = mockPane(id);
    byId.set(id, pane);
    shell.appendChild(pane);
    // toolbar (top-bar) + in-pane, matching index.html
    toggles.push(mockToggle(id));
    toggles.push(mockToggle(id));
  }

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
      return [];
    },
  };

  globalThis.document = doc;
  globalThis.localStorage = memoryStorage();
  if (!globalThis.window) globalThis.window = globalThis;
  return { doc, toggles };
}

const { doc, toggles } = installFixture();

const { collapsePane, setLayout, getLayout } = await import(
  `${pathToFileURL(join(root, "src", "layout.js")).href}?pane-hide-show-labels=${Date.now()}`
);

function useFixture() {
  globalThis.document = doc;
}

function togglesFor(id) {
  return toggles.filter((btn) => btn.getAttribute("data-pane-toggle") === id);
}

function assertPairedToggles() {
  for (const id of PANE_IDS) {
    const pair = togglesFor(id);
    assert.equal(pair.length, 2, `${id} must have two toggles (toolbar + in-pane)`);
    assert.equal(
      labelOf(pair[0]),
      labelOf(pair[1]),
      `${id} toolbar and in-pane labels must match (got ${JSON.stringify(labelOf(pair[0]))} vs ${JSON.stringify(labelOf(pair[1]))})`,
    );
    assert.equal(
      pair[0].getAttribute("aria-pressed"),
      pair[1].getAttribute("aria-pressed"),
      `${id} toolbar and in-pane aria-pressed must match (got ${JSON.stringify(pair[0].getAttribute("aria-pressed"))} vs ${JSON.stringify(pair[1].getAttribute("aria-pressed"))})`,
    );
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

function assertAllToggles(expected) {
  for (const id of PANE_IDS) {
    const open = expected[id];
    assertPaneToggles(id, {
      label: open ? "Hide" : "Show",
      pressed: open ? "true" : "false",
    });
  }
  assertPairedToggles();
}

function resetThreePane() {
  useFixture();
  setLayout("three-pane");
}

test("fixture: six data-pane-toggle buttons (toolbar + in-pane) start as Hide", () => {
  useFixture();
  const found = globalThis.document.querySelectorAll("[data-pane-toggle]");
  assert.equal(found.length, 6, "querySelectorAll([data-pane-toggle]) must return all six buttons");
  for (const id of PANE_IDS) {
    assert.equal(togglesFor(id).length, 2, `${id} must have toolbar + in-pane toggles`);
  }
  for (const id of ["explorer", "editor", "preview"]) {
    assert.ok(globalThis.document.getElementById(id), `missing pane #${id}`);
  }
  assert.ok(globalThis.document.getElementById("shell"), "missing #shell");
  resetThreePane();
  assert.equal(typeof collapsePane, "function", "collapsePane must be exported");
  assert.equal(typeof setLayout, "function", "setLayout must be exported");
  assert.equal(typeof getLayout, "function", "getLayout must be exported");
  for (const btn of found) {
    assert.equal(labelOf(btn), "Hide", "initial toggle label must be Hide");
    assert.equal(btn.getAttribute("aria-pressed"), "true", "initial aria-pressed must be true");
  }
});

test('collapsePane("explorer", true): explorer Show / unpressed; editor and preview stay Hide', () => {
  resetThreePane();
  collapsePane("explorer", true);
  assert.equal(getLayout().open.explorer, false, "getLayout().open.explorer must be false after collapse");
  assertAllToggles({ explorer: false, editor: true, preview: true });
});

test('collapsePane("explorer", false): explorer Hide / pressed; open true', () => {
  resetThreePane();
  collapsePane("explorer", true);
  collapsePane("explorer", false);
  assert.equal(getLayout().open.explorer, true, "getLayout().open.explorer must be true after show");
  assertAllToggles({ explorer: true, editor: true, preview: true });
});

test('setLayout("editor-only"): explorer+preview Show; editor Hide', () => {
  resetThreePane();
  setLayout("editor-only");
  assert.equal(getLayout().open.explorer, false);
  assert.equal(getLayout().open.editor, true);
  assert.equal(getLayout().open.preview, false);
  assertAllToggles({ explorer: false, editor: true, preview: false });
});

test('setLayout("reader-only"): explorer+editor Show; preview Hide', () => {
  resetThreePane();
  setLayout("reader-only");
  assert.equal(getLayout().open.explorer, false);
  assert.equal(getLayout().open.editor, false);
  assert.equal(getLayout().open.preview, true);
  assertAllToggles({ explorer: false, editor: false, preview: true });
});

test('setLayout("three-pane"): all six toggles Hide and pressed', () => {
  resetThreePane();
  setLayout("editor-only");
  setLayout("three-pane");
  assert.equal(getLayout().open.explorer, true);
  assert.equal(getLayout().open.editor, true);
  assert.equal(getLayout().open.preview, true);
  assertAllToggles({ explorer: true, editor: true, preview: true });
});

test("paired toolbar and in-pane toggles stay in sync after each change", () => {
  resetThreePane();
  const steps = [
    () => collapsePane("explorer", true),
    () => collapsePane("explorer", false),
    () => setLayout("editor-only"),
    () => setLayout("reader-only"),
    () => setLayout("three-pane"),
    () => collapsePane("editor", true),
    () => collapsePane("preview", true),
    () => setLayout("three-pane"),
  ];
  for (const step of steps) {
    step();
    assertPairedToggles();
  }
});
