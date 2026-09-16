import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { loadSourceFiles } from "./helpers/source.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(root, "src");

const PANE_IDS = ["explorer", "editor", "preview"];
const REORDER_IDS = String.raw`pane-order|reorder-panes|pane-reorder`;
const REORDER_DATA = String.raw`data-pane-order|data-reorder-panes`;
const WINDOW_HELPERS = String.raw`applyWindowSize|setWindowSize`;


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

function restoreAppliesWindowSize(src) {
  const cleaned = stripComments(src);
  const bodies = fnBodies(cleaned, "restoreLayout");
  if (!bodies.length) return false;
  let blob = bodies.join("\n");
  if (new RegExp(String.raw`\b(?:${WINDOW_HELPERS})\s*\(`).test(blob)) {
    blob += `\n${fnBodies(cleaned, WINDOW_HELPERS).join("\n")}`;
  }
  return /setSize\s*\(|\bLogicalSize\b|\bPhysicalSize\b/.test(blob);
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

test("restore applies persisted window size (setSize/LogicalSize/PhysicalSize in restore path)", () => {
  const js = loadJs();
  assert.ok(
    restoreAppliesWindowSize(js),
    "restoreLayout must apply persisted window size via setSize / LogicalSize / PhysicalSize (copying layout.window is not enough)",
  );
});

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
