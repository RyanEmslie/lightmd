import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(root, "src");

const SYSTEM_SANS = /system-ui|ui-sans-serif/i;
const EDITOR_MONO = /ui-monospace/i;
const CONTROL_TAGS = ["button", "input", "select"];
const PANE_IDS = String.raw`shell|explorer|editor|preview|editor-view|preview-body`;

function collectFiles(dir, acc = []) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) {
      collectFiles(p, acc);
      continue;
    }
    if (ent.name === "editor.bundle.js") continue;
    acc.push(p);
  }
  return acc;
}

function collectSource(dir) {
  const chunks = [];
  for (const p of collectFiles(dir)) {
    if (/\.(html|js|mjs|cjs|ts|css)$/i.test(p)) {
      chunks.push({ path: p, text: readFileSync(p, "utf8") });
    }
  }
  return chunks;
}

function loadSources() {
  assert.equal(existsSync(srcDir), true, "src/ must exist");
  const files = collectSource(srcDir);
  assert.ok(files.length > 0, "src/ must contain editor source");
  return files;
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

function typeTokensIn(text, { size, lineHeight, familyRe }) {
  if (!text) return false;
  const fontVals = [...String(text).matchAll(/font\s*:\s*([^;{}]+)/gi)].map(
    (m) => m[1],
  );
  const sizeInFont = fontVals.some((v) => new RegExp(String.raw`${size}\b`).test(v));
  const lhInFont = fontVals.some((v) =>
    new RegExp(String.raw`/\s*${lineHeight}\b`).test(v),
  );
  const famInFont = familyRe
    ? fontVals.some((v) => familyRe.test(v))
    : true;
  if (sizeInFont && lhInFont && famInFont) return true;

  const sizeOk =
    sizeInFont ||
    new RegExp(String.raw`font-size\s*:\s*${size}\b`, "i").test(text) ||
    new RegExp(String.raw`fontSize\s*[:=]\s*["']${size}["']`).test(text);
  const lhOk =
    lhInFont ||
    new RegExp(String.raw`line-height\s*:\s*${lineHeight}\b`, "i").test(text) ||
    new RegExp(String.raw`lineHeight\s*[:=]\s*["']${lineHeight}["']`).test(text);
  const famOk = !familyRe
    ? true
    : famInFont || familyRe.test(text);
  return Boolean(sizeOk && lhOk && famOk);
}

function rulesMatching(rules, pred) {
  return rules.filter((r) => pred(r.selector));
}

function bodiesOf(rules) {
  return rules.map((r) => r.body).join("\n");
}

function isChromeSelector(selector) {
  return /(?:^|,)\s*(?:html|body|:root|#shell|#editor-chrome|#editor-tabs|#preview-chrome|#html-js-chrome|#status-strip|#explorer-toolbar)\b/i.test(
    selector,
  );
}

function isExplorerSelector(selector) {
  return /(?:^|,)\s*#explorer\b/i.test(selector);
}

function isSettingsSelector(selector) {
  return selector.split(",").some((part) => {
    const last = lastCompound(part);
    if (/^#settings(?:[-_][\w-]+)?$/i.test(last)) return true;
    if (/\.settings(?:[-_][\w-]+)?$/i.test(last.replace(/::?[a-z-]+(\([^)]*\))?/gi, ""))) {
      return true;
    }
    if (/^settings$/i.test(last)) return true;
    return false;
  });
}

function isPreviewSelector(selector) {
  return /(?:^|,)\s*#preview(?:-body)?\b/i.test(selector);
}

function lastCompound(part) {
  const stripped = String(part || "")
    .replace(/::?[a-z-]+(\([^)]*\))?/gi, " ")
    .trim();
  const tokens = stripped.split(/[\s>+~]/).filter(Boolean);
  return tokens[tokens.length - 1] || "";
}

function chromeTypeLocked(rules) {
  const blob = bodiesOf(rulesMatching(rules, isChromeSelector));
  return typeTokensIn(blob, {
    size: "13px",
    lineHeight: "1\\.25",
    familyRe: SYSTEM_SANS,
  });
}

function explorerTypeLocked(rules) {
  const blob = bodiesOf(rulesMatching(rules, isExplorerSelector));
  if (
    typeTokensIn(blob, {
      size: "13px",
      lineHeight: "1\\.25",
      familyRe: SYSTEM_SANS,
    })
  ) {
    return true;
  }
  return chromeTypeLocked(rules);
}

function settingsTypeLocked(rules, src) {
  const blob = bodiesOf(rulesMatching(rules, isSettingsSelector));
  if (
    typeTokensIn(blob, {
      size: "13px",
      lineHeight: "1\\.25",
      familyRe: SYSTEM_SANS,
    })
  ) {
    return true;
  }
  const markup = windowsAround(
    src,
    /#settings\b|\.settings\b|id=["']settings["']|getElementById\(\s*["']settings["']\s*\)/gi,
    80,
    500,
  );
  return markup.some((w) =>
    typeTokensIn(w, {
      size: "13px",
      lineHeight: "1\\.25",
      familyRe: SYSTEM_SANS,
    }),
  );
}

function editorTypeLocked(src) {
  const windows = [
    ...windowsAround(src, /ui-monospace/g, 80, 280),
    ...windowsAround(
      src,
      /#editor-view\b|#editor\b|\.cm-editor|\.cm-scroller|\.cm-content/g,
      40,
      400,
    ),
  ];
  return windows.some((w) =>
    typeTokensIn(w, {
      size: "14px",
      lineHeight: "1\\.45",
      familyRe: EDITOR_MONO,
    }),
  );
}

function previewTypeLocked(rules, src) {
  const blob = bodiesOf(rulesMatching(rules, isPreviewSelector));
  if (
    typeTokensIn(blob, {
      size: "16px",
      lineHeight: "1\\.55",
      familyRe: null,
    })
  ) {
    return true;
  }
  return windowsAround(src, /#preview(?:-body)?\b/g, 40, 400).some((w) =>
    typeTokensIn(w, {
      size: "16px",
      lineHeight: "1\\.55",
      familyRe: null,
    }),
  );
}

function spacingLocked(css, src) {
  const blob = `${css}\n${src}`;
  if (/--(?:space|spacing|unit)\s*:\s*8px/.test(blob)) return true;
  if (/(?:padding|margin|gap)\s*:\s*8px/.test(css)) return true;
  return false;
}

function cssVars(css) {
  const vars = new Map();
  const re = /(--[\w-]+)\s*:\s*([^;{}]+)/g;
  let m;
  while ((m = re.exec(css))) {
    vars.set(m[1].toLowerCase(), m[2].trim());
  }
  return vars;
}

function resolvedRadius(value, vars) {
  if (!value) return null;
  let v = String(value).trim();
  const seen = new Set();
  for (let i = 0; i < 5; i++) {
    if (/^(?:4px(?:\s+4px){0,3})$/i.test(v)) return "4px";
    if (/^50%$/.test(v)) return "50%";
    if (/^(?:0(?:px)?(?:\s+0(?:px)?){0,3})$/i.test(v) || /^none$/i.test(v)) {
      return "0";
    }
    const m = v.match(/^var\(\s*(--[\w-]+)(?:\s*,\s*([^)]+))?\)/i);
    if (!m) return v;
    const name = m[1].toLowerCase();
    if (seen.has(name)) return v;
    seen.add(name);
    if (vars.has(name)) {
      v = vars.get(name);
      continue;
    }
    if (m[2]) {
      v = m[2].trim();
      continue;
    }
    return v;
  }
  return v;
}

function borderRadiusValue(body) {
  const m = String(body || "").match(/border-radius\s*:\s*([^;]+)/i);
  return m ? m[1].trim() : null;
}

function selectorTargetsTag(selector, tag) {
  return selector.split(",").some((part) => {
    if (/:(?:is|where)\(/i.test(part)) {
      return new RegExp(
        String.raw`:(?:is|where)\(\s*[^)]*\b${tag}\b`,
        "i",
      ).test(part);
    }
    const last = lastCompound(part);
    return new RegExp(String.raw`^${tag}(?:[.#\[]|$)`, "i").test(last);
  });
}

function selectorIsPaneOrCard(selector) {
  return selector.split(",").some((part) => {
    const last = lastCompound(part);
    if (!last) return false;
    if (/^#$/.test(last)) return false;
    if (/\.card\b|#card\b/i.test(last)) return true;
    if (/\.pane\b/i.test(last)) return true;
    if (new RegExp(String.raw`^#(?:${PANE_IDS})$`, "i").test(last)) return true;
    if (/^(?:\*|html|body)$/i.test(last)) return true;
    if (/^:root$/i.test(part.trim())) return true;
    return false;
  });
}

function selectorIsDirtyDot(selector) {
  return /#dirty\b|\.dirty\b|dirty[-_]?dot/i.test(selector);
}

function controlRadiusLocked(rules, vars) {
  const found = new Set();
  for (const rule of rules) {
    const raw = borderRadiusValue(rule.body);
    if (!raw) continue;
    const resolved = resolvedRadius(raw, vars);
    if (resolved !== "4px") continue;
    for (const tag of CONTROL_TAGS) {
      if (selectorTargetsTag(rule.selector, tag)) found.add(tag);
    }
  }
  return CONTROL_TAGS.every((tag) => found.has(tag));
}

function paneOrCardHasNonZeroRadius(rules, vars) {
  for (const rule of rules) {
    if (selectorIsDirtyDot(rule.selector)) continue;
    if (!selectorIsPaneOrCard(rule.selector)) continue;
    const raw = borderRadiusValue(rule.body);
    if (!raw) continue;
    const resolved = resolvedRadius(raw, vars);
    if (resolved && resolved !== "0") return true;
  }
  return false;
}

function hasShadow(src) {
  const css = stripComments(src);
  const re =
    /(?:box-shadow|text-shadow|(?:filter|backdrop-filter)\s*:[^;{}]*drop-shadow|boxShadow|textShadow)\s*[:=]\s*([^;{}]+)/gi;
  let m;
  while ((m = re.exec(css))) {
    const value = String(m[1] || "")
      .trim()
      .replace(/^["']|["']$/g, "");
    if (!value || /^none$/i.test(value)) continue;
    if (/^(?:inset\s+)?(?:0(?:px)?\s+){1,3}(?:0(?:px)?)(?:\s+\S+)?$/i.test(value)) {
      continue;
    }
    // Cursor-style editor tabs may use an inset top accent with --accent.
    if (/inset/i.test(value) && /var\(\s*--accent/i.test(value)) continue;
    return true;
  }
  return false;
}

function hasCards(src) {
  const css = stripComments(src);
  if (/\bclass=["'][^"']*\bcard\b/i.test(css)) return true;
  if (/\bid=["'][^"']*\bcard\b/i.test(css)) return true;
  if (/(?:^|[,{\s])\.card\b/m.test(css)) return true;
  return false;
}

function hasIconFont(src) {
  const css = stripComments(src);
  if (/font-?awesome/i.test(css)) return true;
  if (/material[-_]?icons/i.test(css)) return true;
  if (
    /ionicons|glyphicon|bootstrap-icons|feather-icons|fontello|icomoon|icon-font|\bcodicon\b/i.test(
      css,
    )
  ) {
    return true;
  }
  if (/@font-face[\s\S]{0,400}\bicon/i.test(css)) return true;
  if (/fonts\.google(?:apis)?\.com\/icon/i.test(css)) return true;
  if (/<(?:link|script|i|span|div)\b[^>]*(?:font-awesome|material-icons|codicon)/i.test(css)) {
    return true;
  }
  if (/class=["'][^"']*\b(?:fa|fas|far|fab|material-icons|codicon|icon)\b/i.test(css)) {
    return true;
  }
  return false;
}

function hasSplash(src) {
  const css = stripComments(src);
  return /\bsplash(?:screen|_screen|-screen)?\b/i.test(css);
}

test("chrome uses system UI sans 13px / 1.25", () => {
  const files = loadSources();
  const rules = parseRules(cssFromFiles(files));
  assert.ok(
    chromeTypeLocked(rules),
    "missing chrome type lock (system UI sans 13px / 1.25)",
  );
});

test("explorer uses system UI sans 13px / 1.25", () => {
  const files = loadSources();
  const rules = parseRules(cssFromFiles(files));
  assert.ok(
    explorerTypeLocked(rules),
    "missing explorer type lock (system UI sans 13px / 1.25)",
  );
});

test("settings uses system UI sans 13px / 1.25", () => {
  const files = loadSources();
  const src = joinedSource(files);
  const rules = parseRules(cssFromFiles(files));
  assert.ok(
    settingsTypeLocked(rules, src),
    "missing settings type lock (system UI sans 13px / 1.25)",
  );
});

test("editor uses ui-monospace 14px / 1.45", () => {
  const src = joinedSource();
  assert.ok(
    editorTypeLocked(src),
    "missing editor type lock (ui-monospace 14px / 1.45)",
  );
});

test("preview uses 16px / 1.55", () => {
  const files = loadSources();
  const src = joinedSource(files);
  const rules = parseRules(cssFromFiles(files));
  assert.ok(
    previewTypeLocked(rules, src),
    "missing preview type lock (16px / 1.55)",
  );
});

test("spacing unit is 8px", () => {
  const files = loadSources();
  const css = cssFromFiles(files);
  const src = joinedSource(files);
  assert.ok(spacingLocked(css, src), "missing spacing unit lock (8px)");
});

test("corner radius 4px on buttons and inputs only (select/input/button)", () => {
  const files = loadSources();
  const css = cssFromFiles(files);
  const rules = parseRules(css);
  const vars = cssVars(css);
  assert.ok(
    controlRadiusLocked(rules, vars),
    "missing 4px corner radius on buttons and inputs (select/input/button)",
  );
  assert.equal(
    paneOrCardHasNonZeroRadius(rules, vars),
    false,
    "corner radius 4px must not apply to cards/panes",
  );
});

test("no shadows, no cards, no icon font, no splash", () => {
  const src = joinedSource();
  assert.equal(hasShadow(src), false, "visual lock forbids shadows");
  assert.equal(hasCards(src), false, "visual lock forbids cards");
  assert.equal(hasIconFont(src), false, "visual lock forbids an icon font");
  assert.equal(hasSplash(src), false, "visual lock forbids a splash");
});
