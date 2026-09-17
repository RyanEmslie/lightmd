import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const INDEX_HTML = join(root, "src", "index.html");

const SIDEBAR_IDS = new Set([
  "sidebar-toggle",
  "nav-toggle",
  "toggle-sidebar",
  "toggle-nav",
]);

const OPEN_FOLDER_RE = /\bopen\s+folder\b/i;
const NEW_NOTE_RE = /\bnew\s+note\b/i;
const SAVE_AS_RE = /\bsave\s+as\b/i;
const HIDE_SHOW_RE = /^(hide|show)$/i;
const TEXT_ACTION_RE = /\b(?:open\s+folder|new\s+note|save\s+as)\b|^(hide|show)$/i;
const CONTRAST_COLOR = /var\(\s*--fg\s*\)|currentColor/i;
const FG_VAR = /var\(\s*--fg\s*\)/;

function loadHtml() {
  assert.equal(existsSync(INDEX_HTML), true, "src/index.html must exist");
  return readFileSync(INDEX_HTML, "utf8");
}

function styleCss(html) {
  const chunks = [];
  const re = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
  let m;
  while ((m = re.exec(html))) chunks.push(m[1]);
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

function visibleLabel(inner) {
  return String(inner || "")
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, " ")
    .replace(/<(?:img|i|use)\b[^>]*(?:\/>|>[\s\S]*?<\/(?:i|use)>)/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseButtons(src) {
  const out = [];
  const re = /<button\b([^>]*)>([\s\S]*?)<\/button>/gi;
  let m;
  while ((m = re.exec(String(src || "")))) {
    const attrs = parseAttrs(m[1]);
    const inner = m[2];
    out.push({
      attrs,
      inner,
      text: visibleLabel(inner),
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
  if (m) {
    return { id, tag: m[1], inner: m[2], full: m[0], index: m.index };
  }
  return null;
}

function openTagById(src, tag, id) {
  const re = new RegExp(
    `<${tag}\\b[^>]*\\bid=["']${id}["'][^>]*>`,
    "i",
  );
  return src.match(re)?.[0] || null;
}

function layoutBarHtml(html) {
  return taggedById(html, "layout-bar")?.full || "";
}

function explorerTopChrome(html) {
  const explorer = taggedById(html, "explorer");
  const toolbar = taggedById(html, "explorer-toolbar");
  let prefix = "";
  if (explorer) {
    const cut = explorer.inner.search(/\bid=["']file-list["']/i);
    prefix = cut >= 0 ? explorer.inner.slice(0, cut) : explorer.inner;
  }
  const toolbarHtml = toolbar ? toolbar.full : "";
  if (toolbarHtml && prefix.includes(toolbarHtml)) return prefix;
  return `${prefix}\n${toolbarHtml}`;
}

function navExplorerChrome(html) {
  return `${layoutBarHtml(html)}\n${explorerTopChrome(html)}`;
}

function buttonById(buttons, id) {
  return buttons.find((b) => b.attrs.id === String(id)) || null;
}

function isSidebarToggle(btn) {
  const id = String(btn?.attrs?.id || "");
  if (SIDEBAR_IDS.has(id)) return true;
  const names = [id, btn?.attrs?.["aria-label"], btn?.attrs?.title, btn?.attrs?.class]
    .filter(Boolean)
    .join(" ");
  return /\b(?:toggle\s+)?sidebar\b|\btoggle\s+nav\b/i.test(names);
}

function accessibleName(btn) {
  return [btn?.attrs?.["aria-label"], btn?.attrs?.title].filter(Boolean).join(" ");
}

function hasMarkupIcon(btn) {
  const inner = String(btn?.inner || "");
  if (/<svg\b|<img\b|<i\b|<use\b/i.test(inner)) return true;
  if (btn?.attrs?.["data-icon"] || btn?.attrs?.["data-lucide"] || btn?.attrs?.["data-feather"]) {
    return true;
  }
  if (/\b(?:icon|codicon)\b/i.test(String(btn?.attrs?.class || ""))) return true;
  return false;
}

function escapeRe(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function selectorTargetsId(selector, id) {
  const escaped = escapeRe(id);
  return new RegExp(String.raw`(^|,)\s*#${escaped}(?:$|[^\w-])`).test(selector);
}

function selectorTargetsClass(selector, cls) {
  const escaped = escapeRe(cls);
  return new RegExp(String.raw`(^|,)\s*\.${escaped}(?:$|[^\w-])`).test(selector);
}

function cssIconFor(rules, btn) {
  const id = btn.attrs.id || "";
  const classes = String(btn.attrs.class || "")
    .split(/\s+/)
    .filter(Boolean);
  for (const rule of rules) {
    const parts = String(rule.selector || "").split(",");
    const applies = parts.some((part) => {
      const p = part.trim();
      if (id && new RegExp(String.raw`#${escapeRe(id)}(?:$|[^\w-]|::)`).test(p)) {
        return true;
      }
      return classes.some((cls) =>
        new RegExp(String.raw`\.${escapeRe(cls)}(?:$|[^\w-]|::)`).test(p),
      );
    });
    if (!applies) continue;
    const decls = parseDecls(rule.body);
    const content = String(decls.content || "").trim();
    const pseudo = /::?(?:before|after)\b/i.test(rule.selector);
    if (content && !/^(none|normal)$/i.test(content)) return true;
    if (
      pseudo &&
      /(?:-webkit-)?mask(?:-image)?|background-image/i.test(rule.body)
    ) {
      return true;
    }
    if (decls["background-image"] && decls["background-image"] !== "none") {
      return true;
    }
  }
  return false;
}

function hasIcon(btn, rules) {
  return hasMarkupIcon(btn) || cssIconFor(rules, btn);
}

function isIconOnly(btn, rules) {
  if (TEXT_ACTION_RE.test(btn.text)) return false;
  return hasIcon(btn, rules);
}

function hideButtonsInNav(html, buttonsInChrome) {
  const layout = layoutBarHtml(html);
  const explorerChrome = explorerTopChrome(html);
  return buttonsInChrome.filter((btn) => {
    if (isSidebarToggle(btn)) return false;
    const inLayout = layout.includes(btn.html);
    const inExplorer = explorerChrome.includes(btn.html);
    if (!inLayout && !inExplorer) return false;
    if (/^(preview|editor)$/i.test(btn.text)) return false;
    if (HIDE_SHOW_RE.test(btn.text)) return true;
    const pane = btn.attrs["data-pane-toggle"];
    return Boolean(pane);
  });
}

function contrastPaint(rules, btn) {
  const merged = {};
  const id = btn.attrs.id || "";
  const classes = String(btn.attrs.class || "")
    .split(/\s+/)
    .filter(Boolean);
  const pane = btn.attrs["data-pane-toggle"];
  for (const rule of rules) {
    const parts = String(rule.selector || "").split(",");
    const applies = parts.some((part) => {
      const p = part.trim();
      if (id && selectorTargetsId(p, id)) return true;
      if (id && new RegExp(String.raw`#${escapeRe(id)}\s+svg\b`).test(p)) {
        return true;
      }
      if (classes.some((cls) => selectorTargetsClass(p, cls))) return true;
      if (/#layout-bar(?:$|[^\w-]).*\bbutton\b/i.test(p)) return true;
      if (/#explorer(?:-toolbar)?(?:$|[^\w-]).*\bbutton\b/i.test(p)) return true;
      if (pane && /\[data-pane-toggle/.test(p)) return true;
      return false;
    });
    if (applies) Object.assign(merged, parseDecls(rule.body));
  }
  const svg = String(btn.inner || "");
  const svgFill = svg.match(/\bfill=["']([^"']+)["']/i)?.[1] || "";
  const svgStroke = svg.match(/\bstroke=["']([^"']+)["']/i)?.[1] || "";
  return {
    color: merged.color || "",
    fill: merged.fill || svgFill,
    stroke: merged.stroke || svgStroke,
  };
}

function hasIconContrast(rules, btn) {
  const paint = contrastPaint(rules, btn);
  return (
    CONTRAST_COLOR.test(paint.color) ||
    CONTRAST_COLOR.test(paint.fill) ||
    CONTRAST_COLOR.test(paint.stroke)
  );
}

const html = loadHtml();
const cssRules = parseRules(styleCss(html));
const allButtons = parseButtons(html);
const chromeHtml = navExplorerChrome(html);
const chromeButtons = parseButtons(chromeHtml);

test("#open-folder and #new-note (and Hide if in nav header) are icon-only without visible text labels", () => {
  const openFolder = buttonById(allButtons, "open-folder");
  const newNote = buttonById(allButtons, "new-note");
  assert.ok(openFolder, "missing button#open-folder");
  assert.ok(newNote, "missing button#new-note");

  assert.equal(
    OPEN_FOLDER_RE.test(openFolder.text),
    false,
    `#open-folder must not use visible text "Open Folder" as button textContent (got ${JSON.stringify(openFolder.text)}); icon-only with SVG/CSS icon child`,
  );
  assert.equal(
    NEW_NOTE_RE.test(newNote.text),
    false,
    `#new-note must not use visible text "New Note" as button textContent (got ${JSON.stringify(newNote.text)}); icon-only with SVG/CSS icon child`,
  );
  assert.equal(
    isIconOnly(openFolder, cssRules),
    true,
    `#open-folder must be icon-only (SVG/CSS icon child OK), not a text button (text=${JSON.stringify(openFolder.text)} inner=${JSON.stringify(openFolder.inner.trim())})`,
  );
  assert.equal(
    isIconOnly(newNote, cssRules),
    true,
    `#new-note must be icon-only (SVG/CSS icon child OK), not a text button (text=${JSON.stringify(newNote.text)} inner=${JSON.stringify(newNote.inner.trim())})`,
  );

  const hides = hideButtonsInNav(html, chromeButtons);
  for (const btn of hides) {
    const where = btn.attrs.id
      ? `#${btn.attrs.id}`
      : `[data-pane-toggle=${JSON.stringify(btn.attrs["data-pane-toggle"] || "")}]`;
    assert.equal(
      HIDE_SHOW_RE.test(btn.text),
      false,
      `nav header Hide must not use visible text "Hide"/"Show" as button textContent (${where} got ${JSON.stringify(btn.text)}); icon-only if still present in nav header`,
    );
    assert.equal(
      isIconOnly(btn, cssRules),
      true,
      `nav header Hide must be icon-only if still present (${where} text=${JSON.stringify(btn.text)})`,
    );
  }
});

test("#toggle-preview is icon-only with an accessible Preview name", () => {
  const preview = buttonById(allButtons, "toggle-preview");
  assert.ok(preview, "missing button#toggle-preview");
  assert.equal(
    /preview/i.test(preview.text),
    false,
    `#toggle-preview must not use visible text "Preview" (got ${JSON.stringify(preview.text)}); icon-only with SVG`,
  );
  assert.equal(
    isIconOnly(preview, cssRules),
    true,
    `#toggle-preview must be icon-only (SVG/CSS icon child), not a text button (text=${JSON.stringify(preview.text)} inner=${JSON.stringify(preview.inner.trim())})`,
  );
  assert.match(
    accessibleName(preview),
    /preview/i,
    `#toggle-preview aria-label and/or title must convey Preview (got aria-label=${JSON.stringify(preview.attrs["aria-label"] || "")} title=${JSON.stringify(preview.attrs.title || "")})`,
  );
});

test("tooltips/accessible names still convey Open Folder and New Note (and Save As if in nav header)", () => {
  const openFolder = buttonById(allButtons, "open-folder");
  const newNote = buttonById(allButtons, "new-note");
  assert.ok(openFolder, "missing button#open-folder");
  assert.ok(newNote, "missing button#new-note");

  const openName = accessibleName(openFolder);
  const newName = accessibleName(newNote);
  assert.ok(
    OPEN_FOLDER_RE.test(openName),
    `#open-folder accessible name via aria-label and/or title must convey Open Folder (got aria-label=${JSON.stringify(openFolder.attrs["aria-label"] || "")} title=${JSON.stringify(openFolder.attrs.title || "")})`,
  );
  assert.ok(
    NEW_NOTE_RE.test(newName),
    `#new-note accessible name via aria-label and/or title must convey New Note (got aria-label=${JSON.stringify(newNote.attrs["aria-label"] || "")} title=${JSON.stringify(newNote.attrs.title || "")})`,
  );

  const saveAs = buttonById(chromeButtons, "save-as");
  if (saveAs) {
    assert.ok(
      SAVE_AS_RE.test(accessibleName(saveAs)),
      `#save-as in the nav header must expose Save As via aria-label and/or title (got aria-label=${JSON.stringify(saveAs.attrs["aria-label"] || "")} title=${JSON.stringify(saveAs.attrs.title || "")})`,
    );
  }

  for (const btn of hideButtonsInNav(html, chromeButtons)) {
    const name = accessibleName(btn);
    assert.ok(
      name.trim(),
      `nav header Hide must have an accessible name via aria-label and/or title tooltip (got ${JSON.stringify(name)})`,
    );
  }
});

test("nav header / explorer chrome top row have no text-label buttons for Open Folder, New Note, Hide", () => {
  const labeled = chromeButtons.filter((btn) => TEXT_ACTION_RE.test(btn.text));
  assert.equal(
    labeled.length,
    0,
    `no text-label buttons for Open Folder / New Note / Hide / Save As in #layout-bar / #explorer / #explorer-toolbar (got ${labeled
      .map((b) => `${b.attrs.id || b.attrs["data-pane-toggle"] || "button"}=${JSON.stringify(b.text)}`)
      .join("; ")})`,
  );
});

test("theme tokens keep icon contrast (color: var(--fg) or currentColor)", () => {
  const openFolder = buttonById(allButtons, "open-folder");
  const newNote = buttonById(allButtons, "new-note");
  assert.ok(openFolder, "missing button#open-folder");
  assert.ok(newNote, "missing button#new-note");
  assert.equal(
    hasIconContrast(cssRules, openFolder),
    true,
    `#open-folder icon contrast must use color: var(--fg) or currentColor (got ${JSON.stringify(contrastPaint(cssRules, openFolder))})`,
  );
  assert.equal(
    hasIconContrast(cssRules, newNote),
    true,
    `#new-note icon contrast must use color: var(--fg) or currentColor (got ${JSON.stringify(contrastPaint(cssRules, newNote))})`,
  );

  for (const btn of hideButtonsInNav(html, chromeButtons)) {
    const where = btn.attrs.id
      ? `#${btn.attrs.id}`
      : `[data-pane-toggle=${JSON.stringify(btn.attrs["data-pane-toggle"] || "")}]`;
    assert.equal(
      hasIconContrast(cssRules, btn),
      true,
      `nav header Hide ${where} icon contrast must use color: var(--fg) or currentColor (got ${JSON.stringify(contrastPaint(cssRules, btn))})`,
    );
  }
});

test("open-folder and new-note still exist as buttons", () => {
  for (const id of ["open-folder", "new-note"]) {
    const btn = buttonById(allButtons, id);
    assert.ok(btn, `missing button#${id}`);
    assert.equal(
      /<button\b/i.test(btn.html),
      true,
      `#${id} must remain a <button>`,
    );
    const type = String(btn.attrs.type || "").toLowerCase();
    assert.ok(
      type === "button" || type === "",
      `#${id} must remain a button (type=${JSON.stringify(btn.attrs.type || "")})`,
    );
  }
});
