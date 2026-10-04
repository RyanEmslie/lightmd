import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { loadSourceFiles } from "./helpers/source.mjs";
import { buildTauriGlobals, createInvoke } from "./helpers/tauri.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(root, "src");

const PANE_IDS = ["explorer", "editor", "preview"];
const REORDER_IDS = String.raw`pane-order|reorder-panes|pane-reorder`;
const REORDER_DATA = String.raw`data-pane-order|data-reorder-panes`;


function loadSources() {
  return loadSourceFiles();
}

function stripComments(src) {
  return String(src || "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function loadHtml(files = loadSources()) {
  const html = files.filter((f) => /\.html$/i.test(f.path)).map((f) => f.text);
  assert.ok(html.length > 0, "src/ must contain html");
  return html.join("\n");
}

function loadJs(files = loadSources()) {
  return files
    .filter((f) => /\.(js|mjs|cjs|ts)$/i.test(f.path))
    .map((f) => f.text)
    .join("\n");
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
      String.raw`(?:export\s+)?(?:async\s+)?function\s+(?:${namesAlt})\s*\([^)]*\)\s*\{`,
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

function taggedById(src, id) {
  const block = new RegExp(
    `<([a-zA-Z][\\w-]*)\\b[^>]*\\bid=["']${id}["'][^>]*>([\\s\\S]*?)</\\1>`,
    "i",
  );
  const m = src.match(block);
  if (m) return { id, tag: m[1], inner: m[2], full: m[0] };
  const open = src.match(
    new RegExp(`<([a-zA-Z][\\w-]*)\\b[^>]*\\bid=["']${id}["'][^>]*>`, "i"),
  );
  if (open) return { id, tag: open[1], inner: "", full: open[0] };
  return null;
}

function chromeOutsidePanes(html) {
  let out = html;
  for (const id of PANE_IDS) {
    const tagged = taggedById(out, id);
    if (!tagged) continue;
    out = out.replace(tagged.full, `<${tagged.tag} id="${id}"></${tagged.tag}>`);
  }
  return out;
}

function hasThreePaneRestore(chunk) {
  const s = typeof chunk === "string" ? chunk : chunk?.full || chunk?.inner || "";
  if (/\bid=["']pane-layout["']/.test(s)) return true;
  if (/<(?:select|button)\b[^>]*three[-_]?pane/i.test(s)) return true;
  if (/<(?:select|button)\b[^>]*>[^<]*three[-_]?pane/i.test(s)) return true;
  if (
    /<(?:select|button)\b[^>]*>[\s\S]{0,400}?value=["']three[-_]?pane["']/i.test(s)
  ) {
    return true;
  }
  return false;
}

function hasPerPaneRestore(chunk) {
  const s = typeof chunk === "string" ? chunk : chunk?.full || chunk?.inner || "";
  const mentions = (id) =>
    new RegExp(
      String.raw`data-pane-(?:toggle|show)=["']${id}["']`,
      "i",
    ).test(s);
  return mentions("explorer") && mentions("editor") && mentions("preview");
}

function stripHasLayoutWidgets(html) {
  const strip = taggedById(html, "status-strip");
  if (!strip) return true;
  const s = strip.full;
  if (/<(?:select|button|input)\b/i.test(s)) return true;
  if (/\bid=["']pane-layout["']/.test(s)) return true;
  if (/data-pane-toggle|data-pane-show/.test(s)) return true;
  if (new RegExp(String.raw`\bid=["'](?:${REORDER_IDS})["']`).test(s)) return true;
  if (new RegExp(REORDER_DATA).test(s)) return true;
  return false;
}

function restoreChromeRemains(html) {
  if (stripHasLayoutWidgets(html)) return false;
  if (hasThreePaneRestore(html)) return true;
  const settings = taggedById(html, "settings");
  if (settings && hasThreePaneRestore(settings.full)) return true;
  const outside = chromeOutsidePanes(html);
  if (hasThreePaneRestore(outside) && hasPerPaneRestore(outside)) return true;
  return PANE_IDS.every((id) => {
    const pane = taggedById(html, id);
    return (
      pane && hasThreePaneRestore(pane.full) && hasPerPaneRestore(pane.full)
    );
  });
}

function reorderControlRe() {
  return new RegExp(
    String.raw`<(select|button)\b[^>]*(?:\bid=["'](?:${REORDER_IDS})["']|${REORDER_DATA})[^>]*>`,
    "i",
  );
}

function htmlWithoutStatusStrip(html) {
  const strip = taggedById(html, "status-strip");
  if (!strip) return html;
  return html.replace(strip.full, "");
}

function hasReorderControl(html, js) {
  const outsideStrip = htmlWithoutStatusStrip(html);
  if (!reorderControlRe().test(outsideStrip)) return false;
  return bindsReorderPanes(js);
}

function bindsReorderPanes(src) {
  const cleaned = stripComments(src);
  if (
    /addEventListener\(\s*["'](?:change|click)["'][\s\S]{0,500}?\breorderPanes\s*\(/.test(
      cleaned,
    )
  ) {
    return true;
  }
  if (/\.(?:onchange|onclick)\s*=\s*[^\n]{0,200}\breorderPanes\s*\(/.test(cleaned)) {
    return true;
  }
  const bindBodies = fnBodies(
    cleaned,
    String.raw`bindLayoutControls|bindReorder|bindPaneOrder|bindReorderPanes`,
  );
  return bindBodies.some((body) => /\breorderPanes\s*\(/.test(body));
}

function getLayoutHasNoMock(src) {
  const bodies = fnBodies(src, "getLayout");
  if (!bodies.length) return false;
  return bodies.every((body) => !body.includes("__lightmdPaneLayoutMock"));
}

function installLocalStorage() {
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

function installDocument() {
  const doc = {
    getElementById() {
      return null;
    },
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
  };
  globalThis.document = doc;
  if (!globalThis.window) globalThis.window = globalThis;
  return doc;
}

function installPaneDocument() {
  const panes = new Map();
  const paneIds = ["explorer", "editor", "preview"];
  for (const id of paneIds) {
    panes.set(id, {
      id,
      hidden: false,
      style: {},
      classList: {
        add() {},
        remove() {},
      },
      getAttribute() {
        return null;
      },
      removeAttribute() {},
      setAttribute() {},
      appendChild() {},
      addEventListener() {},
    });
  }
  const shell = { style: {}, appendChild() {} };
  const doc = {
    getElementById(id) {
      if (id === "shell") return shell;
      return panes.get(id) || null;
    },
    querySelectorAll() {
      return [];
    },
    addEventListener() {},
  };
  globalThis.document = doc;
  return { doc, panes, shell };
}

async function importLayoutFresh() {
  installLocalStorage();
  installDocument();
  const href = pathToFileURL(join(srcDir, "layout.js")).href;
  return import(`${href}?pane-layout-restore=${Date.now()}-${Math.random()}`);
}

test("restore controls remain when any one pane is visible", () => {
  const html = loadHtml();
  assert.ok(
    restoreChromeRemains(html),
    "restore controls must remain when any one pane is visible (duplicate three-pane / per-pane restore in explorer, editor, and preview, or a bar that is not a pane)",
  );
});

test("status strip stays path dirty word count only (no layout widgets)", () => {
  const html = loadHtml();
  const strip = taggedById(html, "status-strip");
  assert.ok(strip, "missing #status-strip");
  assert.equal(
    stripHasLayoutWidgets(html),
    false,
    "status strip must stay path / dirty / word count only (no select/button/input, no #pane-layout, no data-pane-toggle, no reorder control)",
  );
  assert.match(strip.full, /\bid=["']status-path["']/, "status strip must keep path");
  assert.match(strip.full, /\bid=["']dirty["']/, "status strip must keep dirty");
  assert.match(strip.full, /\bid=["']word-count["']/, "status strip must keep word count");
});

async function restoreWithSavedLayout(saved) {
  const prevDoc = globalThis.document;
  const prevLs = globalThis.localStorage;
  const prevTauri = globalThis.__TAURI__;
  const backend = createInvoke();
  globalThis.__TAURI__ = buildTauriGlobals(backend.invoke).__TAURI__;
  try {
    installLocalStorage().setItem("lightmd.layout", JSON.stringify(saved));
    installDocument();
    const href = pathToFileURL(join(srcDir, "layout.js")).href;
    await import(`${href}?pane-layout-restore=${Date.now()}-${Math.random()}`);
    await new Promise((resolve) => setImmediate(resolve));
    return backend;
  } finally {
    globalThis.document = prevDoc;
    globalThis.localStorage = prevLs;
    if (prevTauri === undefined) delete globalThis.__TAURI__;
    else globalThis.__TAURI__ = prevTauri;
  }
}

const SAVED_WINDOW = { window: { width: 1234, height: 777 }, remember: true };

test("restore applies the persisted window size through the Tauri window API", async () => {
  const backend = await restoreWithSavedLayout(SAVED_WINDOW);
  const calls = backend.invokes.filter((c) => c.cmd === "plugin:window|set_size");
  assert.equal(
    calls.length,
    1,
    "restoreLayout must call getCurrentWindow().setSize() once (copying layout.window is not enough)",
  );
  assert.deepEqual(
    calls[0].args.value,
    { Logical: { width: 1234, height: 777 } },
    "setSize must receive the saved size as a LogicalSize",
  );
});

test("restore leaves the window size alone when remember layout is off", async () => {
  const backend = await restoreWithSavedLayout({ ...SAVED_WINDOW, remember: false });
  assert.equal(
    backend.invokes.some((c) => c.cmd === "plugin:window|set_size"),
    false,
    "with remember layout off, restore must not resize the window",
  );
});

test(
  "the app's capabilities let the window-size restore through",
  { todo: "setSize is rejected: capabilities lack core:window:allow-set-size — fixed by Task 2" },
  async () => {
    const backend = await restoreWithSavedLayout(SAVED_WINDOW);
    const rejected = backend.rejections.find((r) => r.cmd === "plugin:window|set_size");
    assert.equal(rejected, undefined, `setSize was rejected: ${rejected?.error}`);
    assert.equal(backend.windowCalls.length, 1, "the window must actually be resized");
  },
);

test("chrome control rearranges panes (not API-only)", () => {
  const files = loadSources();
  const html = loadHtml(files);
  const js = loadJs(files);
  assert.ok(
    hasReorderControl(html, js),
    "chrome control must rearrange panes (select or buttons with id pane-order / reorder-panes / pane-reorder or data-pane-order, not on the status strip, bound to reorderPanes)",
  );
});

test("getLayout returns the real open state (no __lightmdPaneLayoutMock)", async () => {
  const js = loadJs();
  assert.ok(
    getLayoutHasNoMock(js),
    "getLayout must return the real open state (function body must not mention __lightmdPaneLayoutMock)",
  );

  const prevDoc = globalThis.document;
  const prevLs = globalThis.localStorage;
  try {
    const mod = await importLayoutFresh();
    assert.equal(typeof mod.collapsePane, "function", "missing collapsePane");
    assert.equal(typeof mod.getLayout, "function", "missing getLayout");
    mod.collapsePane("explorer", true);
    assert.equal(
      mod.getLayout()?.open?.explorer,
      false,
      "after collapsePane('explorer', true), getLayout().open.explorer must be false",
    );
  } finally {
    globalThis.document = prevDoc;
    globalThis.localStorage = prevLs;
  }
});

test("reopening a pane after both content panes are hidden restores its grid column", async () => {
  const prevDoc = globalThis.document;
  const prevLs = globalThis.localStorage;
  try {
    const { panes, shell } = installPaneDocument();
    installLocalStorage();
    const href = pathToFileURL(join(srcDir, "layout.js")).href;
    const mod = await import(`${href}?pane-layout-reopen=${Date.now()}-${Math.random()}`);

    mod.setLayout("three-pane");
    mod.collapsePane("editor", true);
    mod.collapsePane("preview", true);
    assert.equal(
      shell.style.gridTemplateColumns,
      "minmax(240px, 1fr)",
    );

    mod.collapsePane("preview", false);
    assert.equal(
      shell.style.gridTemplateColumns,
      "minmax(240px, 1fr) minmax(160px, 1fr)",
    );
    assert.equal(
      panes.get("preview").style.gridColumn,
      "2",
      "reopened preview must stay anchored to its original grid track",
    );
  } finally {
    globalThis.document = prevDoc;
    globalThis.localStorage = prevLs;
  }
});

function rect(width) {
  return { width, height: 600, top: 0, left: 0, right: width, bottom: 600 };
}

test("reopening editor after both content panes hide must not push it off-screen", async () => {
  const prevDoc = globalThis.document;
  const prevLs = globalThis.localStorage;
  const prevWin = globalThis.innerWidth;
  try {
    const { panes, shell } = installPaneDocument();
    installLocalStorage();
    globalThis.innerWidth = 1280;
    if (!globalThis.window) globalThis.window = globalThis;
    globalThis.window.innerWidth = 1280;
    for (const [id, width] of [
      ["explorer", 240],
      ["editor", 520],
      ["preview", 520],
    ]) {
      panes.get(id).getBoundingClientRect = () => rect(width);
    }

    const href = pathToFileURL(join(srcDir, "layout.js")).href;
    const mod = await import(`${href}?pane-offscreen=${Date.now()}-${Math.random()}`);

    mod.setLayout("three-pane");
    mod.collapsePane("preview", true);
    panes.get("explorer").getBoundingClientRect = () => rect(1280);
    panes.get("editor").getBoundingClientRect = () => rect(0);
    mod.collapsePane("editor", true);
    assert.equal(mod.getLayout().open.editor, false);
    assert.equal(mod.getLayout().open.preview, false);

    mod.collapsePane("editor", false);
    const cols = String(shell.style.gridTemplateColumns || "");
    assert.match(
      cols,
      /minmax\(160px, 1fr\)/,
      "reopened editor must receive a content track",
    );
    assert.doesNotMatch(
      cols,
      /minmax\(1280px/,
      "explorer must not keep the full-window width after it was the only visible pane",
    );
    assert.equal(panes.get("editor").hidden, false);
    assert.equal(panes.get("editor").style.gridColumn, "2");

    mod.collapsePane("preview", false);
    const both = String(shell.style.gridTemplateColumns || "");
    const mins = [...both.matchAll(/minmax\((\d+)px/g)].map((m) => Number(m[1]));
    const totalMin = mins.reduce((sum, n) => sum + n, 0);
    assert.ok(
      totalMin <= 1280,
      `editor+preview tracks must fit in the window (got ${both}, min sum ${totalMin})`,
    );
    assert.equal(panes.get("preview").hidden, false);
    assert.equal(panes.get("editor").style.gridColumn, "2");
    assert.equal(panes.get("preview").style.gridColumn, "3");
  } finally {
    globalThis.document = prevDoc;
    globalThis.localStorage = prevLs;
    globalThis.innerWidth = prevWin;
    if (globalThis.window) globalThis.window.innerWidth = prevWin;
  }
});

test("hidden content panes must not remain display:flex in the grid", async () => {
  const prevDoc = globalThis.document;
  const prevLs = globalThis.localStorage;
  try {
    const { panes } = installPaneDocument();
    installLocalStorage();
    const href = pathToFileURL(join(srcDir, "layout.js")).href;
    const mod = await import(`${href}?pane-display=${Date.now()}-${Math.random()}`);
    mod.setLayout("three-pane");
    mod.collapsePane("preview", true);
    assert.equal(
      panes.get("preview").style.display,
      "none",
      "hidden preview must be display:none so it cannot wrap onto a new grid row",
    );
    mod.collapsePane("preview", false);
    assert.equal(
      panes.get("preview").style.display,
      "",
      "shown preview must clear the inline display so CSS flex layout applies",
    );
  } finally {
    globalThis.document = prevDoc;
    globalThis.localStorage = prevLs;
  }
});

test("CSS keeps [hidden] panes out of layout despite #editor/#preview display:flex", () => {
  const html = loadHtml();
  assert.match(
    html,
    /\.pane\[hidden\][^}]*display:\s*none\s*!important/i,
    "hidden panes must be display:none !important so #editor/#preview { display:flex } cannot keep them in the grid",
  );
});
