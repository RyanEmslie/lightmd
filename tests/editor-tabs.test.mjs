import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, test } from "node:test";
import { bootApp } from "./helpers/app.mjs";
import { loadSourceFiles } from "./helpers/source.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const htmlPath = join(root, "src", "index.html");
const layoutPath = join(root, "src", "layout.js");

const FOLDER = "/tmp/lightmd-editor-tabs";
const FILE_MD = "notes/readme.md";
const FILE_HTML = "page.html";
const BODY_MD = "# Hello markdown\n";
const BODY_HTML = "<h1>Hello html</h1>\n";

const TABLIST_IDS = ["editor-tabs", "tabs", "tab-strip", "tabstrip", "editor-tablist"];
const THEME_TOKEN = /var\(\s*--(?:accent|bg|bg-elevated|fg|fg-muted|border)\s*(?:,[^)]*)?\)/;
const MUTED_TOKEN = /var\(\s*--(?:fg-muted|bg)(?:\s*,[^)]*)?\)/;
const ACCENT_TOKEN = /var\(\s*--accent(?:\s*,[^)]*)?\)/;
const PILL_RADIUS = /(?:9999?px|50%|100(?:px|%)|1[6-9]px|[2-9]\dpx|\d{3,}px)/i;

function loadHtml() {
  assert.equal(existsSync(htmlPath), true, "src/index.html must exist");
  return readFileSync(htmlPath, "utf8");
}

function loadSources() {
  return loadSourceFiles();
}

function joinedSource(files = loadSources()) {
  return files.map((f) => f.text).join("\n");
}

function styleCss(html) {
  const chunks = [];
  const re = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
  let m;
  while ((m = re.exec(html))) chunks.push(m[1]);
  return chunks.join("\n");
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

function stripComments(css) {
  return String(css || "").replace(/\/\*[\s\S]*?\*\//g, "");
}

function parseRules(css) {
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

function parseDecls(body) {
  const out = {};
  for (const chunk of String(body || "").split(";")) {
    const i = chunk.indexOf(":");
    if (i < 0) continue;
    const prop = chunk.slice(0, i).trim().toLowerCase();
    const value = chunk.slice(i + 1).trim();
    if (prop) out[prop] = value;
  }
  return out;
}

function taggedById(src, id) {
  const block = new RegExp(
    `<([a-zA-Z][\\w-]*)\\b[^>]*\\bid=["']${id}["'][^>]*>([\\s\\S]*?)</\\1>`,
    "i",
  );
  const m = String(src).match(block);
  if (m) {
    return { id, tag: m[1], inner: m[2], full: m[0], index: m.index, attrs: m[0] };
  }
  const open = String(src).match(
    new RegExp(`<([a-zA-Z][\\w-]*)\\b[^>]*\\bid=["']${id}["'][^>]*>`, "i"),
  );
  if (open) {
    return {
      id,
      tag: open[1],
      inner: "",
      full: open[0],
      index: open.index,
      attrs: open[0],
    };
  }
  return null;
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

function basename(relative) {
  const n = String(relative || "").replace(/\\/g, "/");
  const i = n.lastIndexOf("/");
  return i >= 0 ? n.slice(i + 1) : n;
}

function extOf(relative) {
  const name = basename(relative);
  const i = name.lastIndexOf(".");
  if (i <= 0) return "";
  return name.slice(i + 1).toLowerCase();
}

function isTabSelector(selector) {
  const s = String(selector || "");
  if (/#editor-(?:view|buffer|chrome|theme)\b/.test(s)) return false;
  if (/#editor-tabs\b/.test(s)) return true;
  if (/#tabs\b|#tab-strip\b|#tabstrip\b|#editor-tablist\b/.test(s)) return true;
  if (/\[role=["']tab(?:list)?["']\]/.test(s)) return true;
  if (/\.editor-tabs?\b/.test(s)) return true;
  if (/\.tablist\b|\.tab-strip\b|\.tab-bar\b|\.tab-row\b|\.tabstrip\b/.test(s)) {
    return true;
  }
  if (/(?:^|,)\s*\.tab(?:-[\w]+)?\b/.test(s)) return true;
  if (/#editor\b/.test(s) && /\.tab\b/.test(s)) return true;
  return false;
}

function isTablistSelector(selector) {
  const s = String(selector || "");
  return (
    /#editor-tabs\b|#tab-strip\b|#tabstrip\b|#editor-tablist\b|#tabs\b/.test(s) ||
    /\[role=["']tablist["']\]/.test(s) ||
    /\.tablist\b|\.tab-strip\b|\.tab-bar\b|\.tabstrip\b|\.editor-tabs\b/.test(s)
  );
}

function isActiveTabSelector(selector) {
  if (!isTabSelector(selector)) return false;
  return /\[aria-selected=["']true["']\]|\.active\b|\.selected\b|\.tab-active\b|\.is-active\b|\[aria-current/.test(
    selector,
  );
}

function isInactiveTabSelector(selector) {
  if (!isTabSelector(selector)) return false;
  if (isActiveTabSelector(selector)) return false;
  return (
    /:not\(\s*\[aria-selected=["']true["']\]\s*\)|:not\(\s*\.(?:active|selected|tab-active|is-active)\b/.test(
      selector,
    ) ||
    /\.inactive\b|\.tab-inactive\b/.test(selector) ||
    isTablistSelector(selector)
  );
}

function radiusTooLarge(value) {
  const v = String(value || "").trim();
  if (!v) return false;
  if (PILL_RADIUS.test(v)) return true;
  const nums = [...v.matchAll(/(\d+(?:\.\d+)?)\s*px/gi)].map((m) => Number(m[1]));
  return nums.some((n) => n > 4);
}

function hasTopAccent(selector, body) {
  const sel = String(selector || "");
  const blob = String(body || "");
  if (ACCENT_TOKEN.test(blob) === false) return false;
  if (/border-top(?:-color|-width|-style)?\s*:/i.test(blob)) return true;
  if (/border-block-start(?:-color)?\s*:/i.test(blob)) return true;
  if (/box-shadow\s*:[^;{}]*inset/i.test(blob)) return true;
  if (
    /::(?:before|after)/i.test(sel) &&
    /(?:^|;)\s*top\s*:\s*0/i.test(blob) &&
    /background(?:-color)?\s*:/i.test(blob)
  ) {
    return true;
  }
  if (/linear-gradient\s*\(\s*(?:to\s+bottom\s*,\s*)?var\(\s*--accent/i.test(blob)) {
    return true;
  }
  return false;
}

function findEditorTabStrip(html) {
  const editor = taggedById(html, "editor");
  const shell = taggedById(html, "shell");
  const region = editor?.full || "";

  for (const id of TABLIST_IDS) {
    const hit = taggedById(region, id) || taggedById(html, id);
    if (!hit) continue;
    const inEditor = region.includes(hit.full) || (editor && hit.index >= 0 && editor.index >= 0 &&
      html.indexOf(hit.full) >= html.indexOf(editor.full) &&
      html.indexOf(hit.full) < html.indexOf(editor.full) + editor.full.length);
    const inExplorer = (() => {
      const ex = taggedById(html, "explorer");
      return ex ? ex.full.includes(hit.full) : false;
    })();
    const inPreview = (() => {
      const pv = taggedById(html, "preview");
      return pv ? pv.full.includes(hit.full) : false;
    })();
    return { ...hit, inEditor, inExplorer, inPreview, via: `#${id}` };
  }

  const roleRe =
    /<([a-zA-Z][\w-]*)\b([^>]*\brole=["']tablist["'][^>]*)>/i;
  const inEditor = region.match(roleRe);
  if (inEditor) {
    const attrs = parseAttrs(inEditor[2]);
    return {
      tag: inEditor[1],
      inner: "",
      full: inEditor[0],
      index: (editor?.index ?? 0) + (inEditor.index ?? 0),
      attrs: inEditor[0],
      inEditor: true,
      inExplorer: false,
      inPreview: false,
      via: `role=tablist#${attrs.id || ""}`,
      id: attrs.id || "",
    };
  }

  const inShell = (shell?.inner || html).match(roleRe);
  if (inShell) {
    const attrs = parseAttrs(inShell[2]);
    const full = inShell[0];
    const abs = html.indexOf(full);
    const editorIdx = html.search(/\bid=["']editor["']/i);
    const viewIdx = html.search(/\bid=["']editor-view["']/i);
    const inExplorer = (() => {
      const ex = taggedById(html, "explorer");
      return ex ? ex.full.includes(full) : false;
    })();
    const inPreview = (() => {
      const pv = taggedById(html, "preview");
      return pv ? pv.full.includes(full) : false;
    })();
    return {
      tag: inShell[1],
      inner: "",
      full,
      index: abs,
      attrs: full,
      inEditor: editorIdx >= 0 && abs > editorIdx && (viewIdx < 0 || abs < viewIdx),
      inExplorer,
      inPreview,
      via: `role=tablist#${attrs.id || ""}`,
      id: attrs.id || "",
    };
  }
  return null;
}

function stripIsAboveEditor(html, strip) {
  if (!strip) return false;
  if (strip.inExplorer || strip.inPreview) return false;
  const editor = taggedById(html, "editor");
  const viewIdx = html.search(/\bid=["']editor-view["']/i);
  const bufferIdx = html.search(/\bid=["']editor-buffer["']/i);
  const surface = [viewIdx, bufferIdx].filter((n) => n >= 0);
  const surfaceIdx = surface.length ? Math.min(...surface) : -1;
  if (strip.inEditor) {
    if (surfaceIdx < 0) return true;
    const abs = html.indexOf(strip.full);
    return abs >= 0 && abs < surfaceIdx;
  }
  if (editor) {
    const abs = html.indexOf(strip.full);
    const editorAbs = html.indexOf(editor.full);
    if (abs >= 0 && editorAbs >= 0 && abs < editorAbs) {
      const between = html.slice(abs, editorAbs);
      if (/<aside\b[^>]*\bid=["']explorer["']/i.test(between)) return false;
      return true;
    }
  }
  return false;
}

function descendants(rootEl) {
  const out = [];
  const walk = (n) => {
    for (const c of n.children || []) {
      out.push(c);
      walk(c);
    }
  };
  walk(rootEl);
  return out;
}

function boot() {
  const rt = bootApp({
    folderPath: FOLDER,
    files: { [FILE_MD]: BODY_MD, [FILE_HTML]: BODY_HTML },
  });
  return Object.assign(rt, { editor: rt.el("editor") });
}

function tabStripEl(doc, editor) {
  for (const id of TABLIST_IDS) {
    const node = doc.getElementById(id);
    if (node) return node;
  }
  const listed = doc.querySelector('[role="tablist"]');
  if (listed) return listed;
  if (editor) {
    const inside = editor.querySelector('[role="tablist"]');
    if (inside) return inside;
  }
  return null;
}

function tabNodes(strip) {
  if (!strip) return [];
  const fromRole = strip.querySelectorAll('[role="tab"]');
  if (fromRole.length) return fromRole;
  const fromClass = descendants(strip).filter((el) => {
    const cls = String(el.className || "");
    return /\btab\b|\beditor-tab\b/.test(cls);
  });
  if (fromClass.length) return fromClass;
  return (strip.children || []).filter((el) => {
    const tag = el.tagName;
    return tag === "BUTTON" || tag === "DIV" || tag === "SPAN" || tag === "A" || tag === "LI";
  });
}

function tabRelative(tab) {
  if (!tab) return "";
  return (
    tab.dataset?.path ||
    tab.dataset?.relative ||
    tab.dataset?.file ||
    tab.getAttribute?.("data-path") ||
    tab.getAttribute?.("data-relative") ||
    tab.getAttribute?.("data-file") ||
    tab.getAttribute?.("title") ||
    ""
  );
}

function tabFor(tabs, relative) {
  const name = basename(relative);
  return (
    tabs.find((t) => tabRelative(t) === relative) ||
    tabs.find((t) => tabRelative(t) === name) ||
    tabs.find((t) => String(t.textContent || "").includes(name)) ||
    null
  );
}

function isActiveTab(tab) {
  if (!tab) return false;
  const aria = tab.getAttribute?.("aria-selected") ?? tab.attributes?.["aria-selected"];
  if (aria === "true" || aria === true) return true;
  if (tab.getAttribute?.("aria-current") === "page" || tab.getAttribute?.("aria-current") === "true") {
    return true;
  }
  if (
    tab.classList?.contains?.("active") ||
    tab.classList?.contains?.("selected") ||
    tab.classList?.contains?.("tab-active") ||
    tab.classList?.contains?.("is-active")
  ) {
    return true;
  }
  return /\b(?:active|selected|tab-active|is-active)\b/.test(String(tab.className || ""));
}

function isIconNode(node, ext) {
  if (!node) return false;
  const tag = String(node.tagName || "").toUpperCase();
  if (tag === "IMG" || tag === "SVG") return true;
  if (tag === "I") return true;
  const cls = String(node.className || "");
  if (/\bicon\b|\bfile-icon\b|\bfile-type\b|\bext-icon\b/.test(cls)) return true;
  const dataExt = node.dataset?.ext ?? node.getAttribute?.("data-ext");
  const dataType = node.dataset?.type ?? node.getAttribute?.("data-type");
  const dataKind = node.dataset?.kind ?? node.getAttribute?.("data-kind");
  if ((dataExt != null && dataExt !== "") || dataType || dataKind) {
    return tag === "SPAN" || tag === "I" || tag === "IMG" || tag === "SVG" || /\bicon\b/.test(cls);
  }
  if (ext && new RegExp(String.raw`\b(?:icon|type|ext|file)[-_]?${ext}\b`, "i").test(cls)) {
    return true;
  }
  return false;
}

function hasFileTypeIcon(tab, relative) {
  const ext = extOf(relative);
  const nodes = descendants(tab);
  return nodes.some((n) => isIconNode(n, ext));
}

function hasFileName(tab, relative) {
  const name = basename(relative);
  const text = String(tab.textContent || "");
  const title = String(tab.title || tab.getAttribute?.("title") || "");
  const label = String(tab.getAttribute?.("aria-label") || "");
  return text.includes(name) || title.includes(name) || label.includes(name);
}

function closeControl(tab) {
  const nodes = [tab, ...descendants(tab)];
  for (const n of nodes) {
    if (n === tab) continue;
    const label = [
      n.textContent,
      n.getAttribute?.("aria-label"),
      n.title,
      n.className,
      n.dataset?.action,
    ]
      .filter(Boolean)
      .join(" ");
    if (/close|×|✕|\u00d7|\u2715|\bx\b/i.test(label)) return n;
    if (/\bclose\b|\btab-close\b/.test(String(n.className || ""))) return n;
  }
  return null;
}

function currentRelativeOf(win) {
  return win.lightmdWorkspace?.relative ?? null;
}

function emptyRelative(value) {
  return value == null || value === "" || value === false;
}

test("tab strip exists above the editor with Cursor-style flush rectangular CSS and top accent", () => {
  const html = loadHtml();
  const files = loadSources();
  const css = `${styleCss(html)}\n${cssFromFiles(files)}`;
  const rules = parseRules(css);
  const src = joinedSource(files);

  const strip = findEditorTabStrip(html);
  assert.ok(
    strip,
    "tab strip must exist as #editor-tabs (or #tabs / #tab-strip) or role=tablist above the editor",
  );
  assert.equal(
    strip.inExplorer,
    false,
    "editor tab strip must not live in #explorer",
  );
  assert.equal(
    strip.inPreview,
    false,
    "editor tab strip must not live in #preview",
  );
  assert.equal(
    /\bhidden\b/i.test(strip.full),
    false,
    "tab strip must be present (not hidden) above the editor",
  );
  assert.ok(
    stripIsAboveEditor(html, strip),
    "tab strip (#editor-tabs or role=tablist) must sit above the editor surface (#editor-view / #editor-buffer), not below it",
  );

  const tabRules = rules.filter((r) => isTabSelector(r.selector));
  const srcHasTabCss =
    /#editor-tabs\b|\[role=["']tab(?:list)?["']\]|\.editor-tab\b|\.tablist\b/.test(src);
  assert.ok(
    tabRules.length > 0 || srcHasTabCss,
    "missing Cursor-style CSS for the editor tab strip / tabs (#editor-tabs, [role=tablist], .tab)",
  );

  const pill = tabRules.filter((r) => radiusTooLarge(parseDecls(r.body)["border-radius"]));
  assert.equal(
    pill.length,
    0,
    `no Obsidian-style large border-radius pill chrome on tabs (got ${pill
      .map((r) => `${r.selector}{border-radius:${parseDecls(r.body)["border-radius"]}}`)
      .join("; ")})`,
  );
  assert.equal(
    /border-radius\s*:\s*[^;]*(?:9999?px|50%|[8-9]px|[1-9]\dpx)/i.test(
      tabRules.map((r) => r.body).join("\n"),
    ),
    false,
    "tabs must be flush rectangular (border-radius 0–4px), not rounded pills",
  );

  const listRules = tabRules.filter((r) => isTablistSelector(r.selector));
  const listDisplay = listRules
    .map((r) => parseDecls(r.body).display || "")
    .join(" ");
  assert.ok(
    /flex|grid|inline-flex/i.test(listDisplay) ||
      /display\s*:\s*(?:inline-)?flex|display\s*:\s*grid/i.test(
        listRules.map((r) => r.body).join("\n"),
      ),
    "tab strip must lay out flush rectangular tabs in a row (display: flex/grid on #editor-tabs / [role=tablist])",
  );

  const activeRules = tabRules.filter((r) => isActiveTabSelector(r.selector));
  const accented = activeRules.filter((r) => hasTopAccent(r.selector, r.body));
  const anyAccent =
    accented.length > 0 ||
    tabRules.some((r) => hasTopAccent(r.selector, r.body) && ACCENT_TOKEN.test(r.body));
  assert.ok(
    anyAccent,
    "active tab must have a top accent using var(--accent) (border-top, inset box-shadow, or ::before at top) — not a hardcoded color",
  );
});

describe("editor tabs: open, switch, close", { concurrency: false }, () => {
  test("opening two files yields two tabs with filename and file-type icon; active matches currentRelative", async () => {
    const rt = boot();
    try {
      await rt.win.lightmdOpenFolder(FOLDER);
      await rt.win.lightmdOpenFile(FILE_MD);
      await rt.win.lightmdOpenFile(FILE_HTML);

      const strip = tabStripEl(rt.doc, rt.editor);
      assert.ok(
        strip,
        "after applyFile, a tab strip (#editor-tabs or role=tablist) must exist above the editor",
      );
      const tabs = tabNodes(strip);
      assert.equal(
        tabs.length,
        2,
        `opening/applying two different files must yield two tabs (got ${tabs.length})`,
      );

      const mdTab = tabFor(tabs, FILE_MD);
      const htmlTab = tabFor(tabs, FILE_HTML);
      assert.ok(mdTab, `missing tab for ${FILE_MD} (filename ${basename(FILE_MD)})`);
      assert.ok(htmlTab, `missing tab for ${FILE_HTML}`);
      assert.notEqual(mdTab, htmlTab, "the two files must not share a single tab");

      assert.ok(
        hasFileName(mdTab, FILE_MD),
        `tab for ${FILE_MD} must show file name text ${JSON.stringify(basename(FILE_MD))} (got ${JSON.stringify(mdTab.textContent)})`,
      );
      assert.ok(
        hasFileName(htmlTab, FILE_HTML),
        `tab for ${FILE_HTML} must show file name text ${JSON.stringify(basename(FILE_HTML))} (got ${JSON.stringify(htmlTab.textContent)})`,
      );
      assert.ok(
        hasFileTypeIcon(mdTab, FILE_MD),
        `tab for ${FILE_MD} must include a file-type icon (img/svg/span.icon with type class or data-ext), not text-only`,
      );
      assert.ok(
        hasFileTypeIcon(htmlTab, FILE_HTML),
        `tab for ${FILE_HTML} must include a file-type icon (img/svg/span.icon with type class or data-ext), not text-only`,
      );

      assert.equal(
        currentRelativeOf(rt.win),
        FILE_HTML,
        "after opening the second file, currentRelative / lightmdWorkspace.relative must be that file",
      );
      assert.equal(
        isActiveTab(htmlTab),
        true,
        "active tab must match currentRelative (the last applied file)",
      );
      assert.equal(
        isActiveTab(mdTab),
        false,
        "the inactive file's tab must not stay marked active",
      );
    } finally {
      rt.cleanup();
    }
  });

  test("clicking an inactive tab switches the editor buffer and currentRelative", async () => {
    const rt = boot();
    try {
      await rt.win.lightmdOpenFolder(FOLDER);
      await rt.win.lightmdOpenFile(FILE_MD);
      await rt.win.lightmdOpenFile(FILE_HTML);

      const strip = tabStripEl(rt.doc, rt.editor);
      assert.ok(strip, "tab strip is required to switch files by clicking a tab");
      const tabs = tabNodes(strip);
      const mdTab = tabFor(tabs, FILE_MD);
      const htmlTab = tabFor(tabs, FILE_HTML);
      assert.ok(mdTab, `missing inactive tab for ${FILE_MD}`);
      assert.ok(htmlTab, `missing active tab for ${FILE_HTML}`);
      assert.equal(isActiveTab(mdTab), false, "precondition: md tab is inactive");
      assert.equal(
        currentRelativeOf(rt.win),
        FILE_HTML,
        "precondition: currentRelative is the html file",
      );
      assert.equal(rt.el("editor-buffer").value, BODY_HTML, "precondition: buffer is html file");

      mdTab.click();

      assert.equal(
        currentRelativeOf(rt.win),
        FILE_MD,
        "clicking the inactive tab must switch currentRelative to that file",
      );
      assert.equal(
        rt.el("editor-buffer").value,
        BODY_MD,
        "clicking the inactive tab must switch the editor buffer to that file",
      );
      const after = tabNodes(tabStripEl(rt.doc, rt.editor));
      const mdAfter = tabFor(after, FILE_MD);
      const htmlAfter = tabFor(after, FILE_HTML);
      assert.equal(isActiveTab(mdAfter), true, "clicked tab must become active");
      assert.equal(isActiveTab(htmlAfter), false, "previous tab must become inactive");
    } finally {
      rt.cleanup();
    }
  });

  test("close on a tab removes it; closing active activates another or empty state", async () => {
    const rt = boot();
    try {
      await rt.win.lightmdOpenFolder(FOLDER);
      await rt.win.lightmdOpenFile(FILE_MD);
      await rt.win.lightmdOpenFile(FILE_HTML);

      let strip = tabStripEl(rt.doc, rt.editor);
      assert.ok(strip, "tab strip is required to close tabs");
      let tabs = tabNodes(strip);
      const mdTab = tabFor(tabs, FILE_MD);
      const htmlTab = tabFor(tabs, FILE_HTML);
      assert.ok(mdTab && htmlTab, "precondition: two open tabs");

      const closeInactive = closeControl(mdTab);
      assert.ok(
        closeInactive,
        `each tab must have a close (×) control (missing on ${FILE_MD})`,
      );
      closeInactive.click();

      strip = tabStripEl(rt.doc, rt.editor);
      tabs = tabNodes(strip);
      assert.equal(
        tabs.length,
        1,
        "close (×) on a tab must remove it from the strip",
      );
      assert.ok(
        tabFor(tabs, FILE_HTML),
        "closing the inactive tab must leave the other file open",
      );
      assert.equal(
        tabFor(tabs, FILE_MD),
        null,
        "closed tab must no longer be in the strip",
      );
      assert.equal(
        currentRelativeOf(rt.win),
        FILE_HTML,
        "closing an inactive tab must keep the active file",
      );

      const remaining = tabFor(tabs, FILE_HTML);
      const closeActive = closeControl(remaining);
      assert.ok(closeActive, `active tab must have a close (×) control`);
      closeActive.click();

      strip = tabStripEl(rt.doc, rt.editor);
      tabs = strip ? tabNodes(strip) : [];
      assert.equal(tabs.length, 0, "closing the last tab must leave an empty strip");
      assert.ok(
        emptyRelative(currentRelativeOf(rt.win)),
        "closing the last tab must clear currentRelative (empty state)",
      );
      const buffer = rt.el("editor-buffer").value;
      assert.ok(
        buffer == null || buffer === "",
        "closing the last tab must leave the editor buffer empty",
      );
      assert.equal(
        rt.win.lightmdEditor.editable,
        false,
        "closing the last tab (empty workspace) must make the editor not editable — type only in a new note or open file",
      );

      await rt.win.lightmdOpenFile(FILE_MD);
      assert.equal(
        rt.win.lightmdEditor.editable,
        true,
        "opening a file must make the editor editable again",
      );
      await rt.win.lightmdOpenFile(FILE_HTML);
      strip = tabStripEl(rt.doc, rt.editor);
      tabs = tabNodes(strip);
      const active = tabFor(tabs, FILE_HTML);
      const other = tabFor(tabs, FILE_MD);
      assert.ok(active && other, "precondition: reopen two tabs");
      const closeCurrent = closeControl(active);
      assert.ok(closeCurrent, "active tab close (×) is required");
      closeCurrent.click();

      strip = tabStripEl(rt.doc, rt.editor);
      tabs = tabNodes(strip);
      assert.equal(tabs.length, 1, "closing the active tab must leave the other open tab");
      assert.ok(tabFor(tabs, FILE_MD), `remaining tab must be ${FILE_MD}`);
      assert.equal(
        currentRelativeOf(rt.win),
        FILE_MD,
        "closing the active tab must make another open tab active (currentRelative)",
      );
      assert.equal(
        isActiveTab(tabFor(tabs, FILE_MD)),
        true,
        "the remaining tab must become the active tab",
      );
      assert.equal(
        rt.el("editor-buffer").value,
        BODY_MD,
        "the remaining tab's file must load into the editor buffer",
      );
    } finally {
      rt.cleanup();
    }
  });
});

test("inactive tabs / strip are lower contrast (theme tokens); works for .md and .html", async () => {
  const files = loadSources();
  const css = `${styleCss(loadHtml())}\n${cssFromFiles(files)}`;
  const rules = parseRules(css);
  const tabRules = rules.filter((r) => isTabSelector(r.selector));
  assert.ok(
    tabRules.length > 0,
    "missing tab CSS so inactive tabs cannot use lower-contrast theme tokens",
  );

  const inactiveBlob = tabRules
    .filter((r) => isInactiveTabSelector(r.selector) || isTablistSelector(r.selector))
    .map((r) => r.body)
    .join("\n");
  const tokenBlob = tabRules.map((r) => r.body).join("\n");
  assert.ok(
    MUTED_TOKEN.test(inactiveBlob) || MUTED_TOKEN.test(tokenBlob),
    "inactive tabs / strip must use lower-contrast theme tokens (var(--fg-muted) and/or var(--bg)), not a hardcoded color",
  );
  assert.ok(
    THEME_TOKEN.test(tokenBlob),
    "tab chrome must use theme tokens (--accent / --fg-muted / --bg / --bg-elevated / --fg / --border)",
  );
  assert.equal(
    /#ff00ff|#e91e63|#ff00aa/i.test(tokenBlob),
    false,
    "tab accent/contrast must follow theme tokens, not a hardcoded magenta",
  );

  const rt = boot();
  try {
    await rt.win.lightmdOpenFolder(FOLDER);
    await rt.win.lightmdOpenFile(FILE_MD);
    await rt.win.lightmdOpenFile(FILE_HTML);
    const strip = tabStripEl(rt.doc, rt.editor);
    assert.ok(strip, "tab strip must exist for .md and .html");
    const tabs = tabNodes(strip);
    const mdTab = tabFor(tabs, FILE_MD);
    const htmlTab = tabFor(tabs, FILE_HTML);
    assert.ok(mdTab, `must open a tab for .md (${FILE_MD})`);
    assert.ok(htmlTab, `must open a tab for .html (${FILE_HTML})`);
    assert.ok(hasFileName(mdTab, FILE_MD) && hasFileTypeIcon(mdTab, FILE_MD), ".md tab: filename + icon");
    assert.ok(
      hasFileName(htmlTab, FILE_HTML) && hasFileTypeIcon(htmlTab, FILE_HTML),
      ".html tab: filename + icon",
    );
  } finally {
    rt.cleanup();
  }
});

test("three-pane layout / splitters still work", async () => {
  const html = loadHtml();
  assert.match(
    html,
    /grid-template-columns\s*:\s*240px\s+1fr\s+1fr/,
    "shell grid must stay 240px 1fr 1fr",
  );
  const ids = ["explorer", "editor", "preview"];
  const indexes = [];
  for (const id of ids) {
    const tag = html.match(new RegExp(`<[^>]*\\bid=["']${id}["'][^>]*>`));
    assert.ok(tag, `missing pane #${id}`);
    indexes.push(html.indexOf(tag[0]));
  }
  assert.ok(
    indexes[0] < indexes[1] && indexes[1] < indexes[2],
    "panes must remain explorer | editor | preview",
  );
  const splitters = [
    ...(html.match(/class=["'][^"']*\bsplitter\b[^"']*["']/g) ?? []),
    ...(html.match(/role=["']separator["']/g) ?? []),
  ];
  assert.ok(splitters.length >= 2, "two 1px splitters required between panes");
  assert.match(html, /var\(--border\)/, "splitters must still use --border");

  const prevDoc = globalThis.document;
  const prevWin = globalThis.window;
  const prevLs = globalThis.localStorage;
  try {
    const map = new Map();
    globalThis.localStorage = {
      getItem(key) {
        return map.has(String(key)) ? map.get(String(key)) : null;
      },
      setItem(key, value) {
        map.set(String(key), String(value));
      },
      removeItem(key) {
        map.delete(String(key));
      },
    };
    globalThis.document = {
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
    const mod = await import(`${pathToFileURL(layoutPath).href}?editor-tabs=${Date.now()}`);
    assert.equal(typeof mod.getLayout, "function", "layout.js must still export getLayout");
    assert.equal(typeof mod.setLayout, "function", "layout.js must still export setLayout");
    assert.equal(typeof mod.dragSplitter, "function", "layout.js must still export dragSplitter");
    const live = mod.getLayout();
    assert.deepEqual(
      live.order,
      ["explorer", "editor", "preview"],
      "layout.order must remain explorer, editor, preview",
    );
    mod.setLayout("three-pane");
    assert.equal(mod.getLayout().open.explorer, true, 'setLayout("three-pane"): explorer open');
    assert.equal(mod.getLayout().open.editor, true, 'setLayout("three-pane"): editor open');
    assert.equal(mod.getLayout().open.preview, true, 'setLayout("three-pane"): preview open');
    const before = { ...mod.getLayout().widths };
    mod.dragSplitter("explorer", "editor", 40);
    const after = mod.getLayout().widths;
    assert.ok(
      Number(after.explorer) !== Number(before.explorer) ||
        Number(after.editor) !== Number(before.editor) ||
        typeof mod.dragSplitter === "function",
      "dragSplitter must remain callable without throwing",
    );
  } finally {
    globalThis.document = prevDoc;
    globalThis.window = prevWin;
    if (prevLs === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = prevLs;
  }
});
