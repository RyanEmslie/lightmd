import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { loadSourceFiles, collectFiles } from "./helpers/source.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(root, "src");

const PALETTE_NAMES = [
  "Tokyo Night",
  "Codex Dark",
  "Nord",
  "Dracula",
  "Catppuccin Mocha",
  "Solarized Light",
  "Solarized Dark",
  "Monokai",
  "High Contrast Light",
  "High Contrast Dark",
];

const TOKENS = [
  "--bg",
  "--bg-elevated",
  "--fg",
  "--fg-muted",
  "--border",
  "--accent",
  "--danger",
];

const CSS_WIDE_KEYWORDS =
  /^(inherit|unset|initial|revert|revert-layer|none|currentcolor|transparent)$/i;
const SYSTEM_COLORS =
  /^(AccentColor|AccentColorText|ActiveText|ButtonBorder|ButtonFace|ButtonText|Canvas|CanvasText|Field|FieldText|GrayText|Highlight|HighlightText|LinkText|Mark|MarkText|SelectedItem|SelectedItemText|VisitedText)$/i;


function loadSources() {
  return loadSourceFiles();
}

function joinedSource(files = loadSources()) {
  return files.map((f) => f.text).join("\n");
}

function firstOf(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function normalizeName(name) {
  return String(name)
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\+/g, " plus")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

const PALETTE_NORMALIZED = new Map(
  PALETTE_NAMES.map((name) => [normalizeName(name), name]),
);

function canonicalPaletteName(name) {
  if (name == null) return null;
  return PALETTE_NORMALIZED.get(normalizeName(name)) ?? null;
}

function isRealColor(value) {
  if (typeof value !== "string") return false;
  const v = value.trim();
  if (!v) return false;
  if (CSS_WIDE_KEYWORDS.test(v) || SYSTEM_COLORS.test(v)) return false;
  if (/^var\(/i.test(v)) return false;
  if (/^#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i.test(v)) return true;
  if (
    /^(?:rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color|color-mix)\(/i.test(v)
  ) {
    return true;
  }
  return /^(?:aliceblue|antiquewhite|aqua|aquamarine|azure|beige|bisque|black|blanchedalmond|blue|blueviolet|brown|burlywood|cadetblue|chartreuse|chocolate|coral|cornflowerblue|cornsilk|crimson|cyan|darkblue|darkcyan|darkgoldenrod|darkgray|darkgreen|darkgrey|darkkhaki|darkmagenta|darkolivegreen|darkorange|darkorchid|darkred|darksalmon|darkseagreen|darkslateblue|darkslategray|darkslategrey|darkturquoise|darkviolet|deeppink|deepskyblue|dimgray|dimgrey|dodgerblue|firebrick|floralwhite|forestgreen|fuchsia|gainsboro|ghostwhite|gold|goldenrod|gray|green|greenyellow|grey|honeydew|hotpink|indianred|indigo|ivory|khaki|lavender|lavenderblush|lawngreen|lemonchiffon|lightblue|lightcoral|lightcyan|lightgoldenrodyellow|lightgray|lightgreen|lightgrey|lightpink|lightsalmon|lightseagreen|lightskyblue|lightslategray|lightslategrey|lightsteelblue|lightyellow|lime|limegreen|linen|magenta|maroon|mediumaquamarine|mediumblue|mediumorchid|mediumpurple|mediumseagreen|mediumslateblue|mediumspringgreen|mediumturquoise|mediumvioletred|midnightblue|mintcream|mistyrose|moccasin|navajowhite|navy|oldlace|olive|olivedrab|orange|orangered|orchid|palegoldenrod|palegreen|paleturquoise|palevioletred|papayawhip|peachpuff|peru|pink|plum|powderblue|purple|rebeccapurple|red|rosybrown|royalblue|saddlebrown|salmon|sandybrown|seagreen|seashell|sienna|silver|skyblue|slateblue|slategray|slategrey|snow|springgreen|steelblue|tan|teal|thistle|tomato|turquoise|violet|wheat|white|whitesmoke|yellow|yellowgreen)$/i.test(
    v,
  );
}

function tokenAliases(token) {
  const bare = token.replace(/^--/, "");
  const camel = bare.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  return [token, bare, camel, `--${camel}`];
}

function asTokenMap(value) {
  if (value == null) return null;
  if (typeof value === "string") {
    const out = {};
    const re = /(--[a-z0-9-]+)\s*:\s*([^;]+)/gi;
    let m;
    while ((m = re.exec(value))) out[m[1].toLowerCase()] = m[2].trim();
    return Object.keys(out).length ? out : null;
  }
  if (typeof value !== "object") return null;
  const nested = firstOf(
    value.tokens,
    value.vars,
    value.variables,
    value.css,
    value.cssVars,
    value.colors,
    value.palette,
  );
  if (nested && nested !== value) {
    const inner = asTokenMap(nested);
    if (inner) return inner;
  }
  const out = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw !== "string") continue;
    const aliases = TOKENS.flatMap(tokenAliases);
    const hit = aliases.find((a) => a.toLowerCase() === String(key).toLowerCase());
    if (!hit) continue;
    const token = TOKENS.find((t) =>
      tokenAliases(t).some((a) => a.toLowerCase() === String(key).toLowerCase()),
    );
    if (token) out[token] = raw;
  }
  return Object.keys(out).length ? out : null;
}

function paletteRecord(name, value) {
  const canonical = canonicalPaletteName(name);
  if (!canonical) return null;
  const tokens = asTokenMap(value) || {};
  return { name: canonical, value, tokens };
}

function fromCollection(value, acc = []) {
  if (!value) return acc;
  if (value instanceof Map) {
    for (const [k, v] of value) {
      const rec = paletteRecord(k, v);
      if (rec) acc.push(rec);
    }
    return acc;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === "string") {
        const rec = paletteRecord(item, {});
        if (rec) acc.push(rec);
        continue;
      }
      if (Array.isArray(item) && item.length >= 2) {
        const rec = paletteRecord(item[0], item[1]);
        if (rec) acc.push(rec);
        continue;
      }
      if (item && typeof item === "object") {
        const rec = paletteRecord(
          firstOf(item.name, item.id, item.label, item.title, item.key),
          item,
        );
        if (rec) acc.push(rec);
      }
    }
    return acc;
  }
  if (typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      const rec = paletteRecord(k, v);
      if (rec) acc.push(rec);
    }
  }
  return acc;
}

function looksLikePaletteCollection(value) {
  if (!value) return false;
  const found = fromCollection(value, []);
  return found.length >= 3;
}

function pickPalettes(mod, seen = new Set()) {
  if (!mod || typeof mod !== "object") return [];
  if (seen.has(mod)) return [];
  seen.add(mod);
  const names = [
    "palettes",
    "PALETTES",
    "colorPalettes",
    "themes",
    "THEMES",
    "colorThemes",
    "colors",
  ];
  for (const name of names) {
    if (name in mod && looksLikePaletteCollection(mod[name])) {
      return fromCollection(mod[name]);
    }
  }
  if (looksLikePaletteCollection(mod)) return fromCollection(mod);
  for (const wrap of ["default", "settings", "config", "defaults", "appearance"]) {
    const nested = mod[wrap];
    if (nested && typeof nested === "object" && nested !== mod) {
      const found = pickPalettes(nested, seen);
      if (found.length) return found;
    }
  }
  return [];
}

function asThemePrefs(value) {
  if (!value || typeof value !== "object") return null;
  for (const nestedName of ["theme", "themes", "appearance", "prefs", "preferences"]) {
    if (value[nestedName] && typeof value[nestedName] === "object") {
      const nested = asThemePrefs(value[nestedName]);
      if (nested) return nested;
    }
  }
  const editor = firstOf(
    typeof value.editorTheme === "string" ? value.editorTheme : undefined,
    typeof value.editor === "string" ? value.editor : undefined,
    typeof value.editorPalette === "string" ? value.editorPalette : undefined,
  );
  const preview = firstOf(
    typeof value.previewTheme === "string" ? value.previewTheme : undefined,
    typeof value.preview === "string" ? value.preview : undefined,
    typeof value.previewPalette === "string" ? value.previewPalette : undefined,
  );
  if (typeof editor !== "string" && typeof preview !== "string") return null;
  const chrome = firstOf(
    typeof value.chromeTheme === "string" ? value.chromeTheme : undefined,
    typeof value.chrome === "string" ? value.chrome : undefined,
    typeof value.chromePalette === "string" ? value.chromePalette : undefined,
    typeof value.shellTheme === "string" ? value.shellTheme : undefined,
  );
  const chromeFollowsEditor = firstOf(
    typeof value.chromeFollowsEditor === "boolean"
      ? value.chromeFollowsEditor
      : undefined,
    typeof value.chromeFollows === "boolean" ? value.chromeFollows : undefined,
  );
  return { editor, preview, chrome, chromeFollowsEditor, raw: value };
}

function pickPrefs(mod) {
  if (!mod || typeof mod !== "object") return null;
  const names = [
    "theme",
    "themes",
    "themePrefs",
    "themePreferences",
    "appearance",
    "prefs",
    "preferences",
    "settings",
    "config",
    "defaults",
    "default",
  ];
  for (const name of names) {
    const prefs = asThemePrefs(mod[name]);
    if (prefs) return prefs;
  }
  const editor = firstOf(
    typeof mod.editorTheme === "string" ? mod.editorTheme : undefined,
    typeof mod.EDITOR_THEME === "string" ? mod.EDITOR_THEME : undefined,
  );
  const preview = firstOf(
    typeof mod.previewTheme === "string" ? mod.previewTheme : undefined,
    typeof mod.PREVIEW_THEME === "string" ? mod.PREVIEW_THEME : undefined,
  );
  if (typeof editor === "string" || typeof preview === "string") {
    return asThemePrefs({
      editorTheme: editor,
      previewTheme: preview,
      chromeTheme: firstOf(mod.chromeTheme, mod.CHROME_THEME),
      chromeFollowsEditor: firstOf(
        mod.chromeFollowsEditor,
        mod.CHROME_FOLLOWS_EDITOR,
      ),
      raw: mod,
    });
  }
  return asThemePrefs(mod);
}

function looksLikeCmMap(value) {
  if (value == null) return false;
  if (typeof value === "function") return true;
  if (Array.isArray(value) && value.length > 0) return true;
  if (typeof value !== "object") return false;
  const keys = Object.keys(value);
  if (
    keys.some(
      (k) =>
        k === "&" ||
        k.startsWith("& ") ||
        k.includes("cm-") ||
        k.includes(".cm") ||
        k === "caretColor" ||
        k === "backgroundColor",
    )
  ) {
    return true;
  }
  if (value.extension || value.style || typeof value.of === "function") {
    return true;
  }
  return false;
}

function pickCmThemes(mod) {
  if (!mod || typeof mod !== "object") return null;
  const maps = firstOf(
    mod.codeMirrorThemes,
    mod.cmThemes,
    mod.editorThemes,
    mod.codemirrorThemes,
    mod.codeMirrorThemeMap,
  );
  if (maps && typeof maps === "object") return maps;
  const fn = firstOf(
    typeof mod.codeMirrorTheme === "function" ? mod.codeMirrorTheme : undefined,
    typeof mod.cmTheme === "function" ? mod.cmTheme : undefined,
    typeof mod.editorThemeFor === "function" ? mod.editorThemeFor : undefined,
    typeof mod.themeForPalette === "function" ? mod.themeForPalette : undefined,
    typeof mod.editorTheme === "function" ? mod.editorTheme : undefined,
  );
  if (fn) return fn;
  return null;
}

function paletteCmMap(rec, cmThemes) {
  if (!rec) return null;
  const value = rec.value;
  if (value && typeof value === "object") {
    for (const key of [
      "cm",
      "codemirror",
      "codeMirror",
      "cmTheme",
      "codeMirrorTheme",
      "editorTheme",
      "editor",
      "theme",
    ]) {
      if (looksLikeCmMap(value[key])) return value[key];
    }
    if (looksLikeCmMap(value) && !asTokenMap(value)) return value;
  }
  if (typeof cmThemes === "function") {
    try {
      const out = firstOf(
        cmThemes(rec.name),
        cmThemes(rec.value),
        cmThemes(normalizeName(rec.name)),
      );
      if (looksLikeCmMap(out)) return out;
    } catch {
      return null;
    }
  }
  if (cmThemes && typeof cmThemes === "object") {
    for (const [k, v] of cmThemes instanceof Map
      ? cmThemes
      : Object.entries(cmThemes)) {
      if (canonicalPaletteName(k) === rec.name && looksLikeCmMap(v)) return v;
    }
  }
  return null;
}

function setters(mod) {
  if (!mod || typeof mod !== "object") {
    return { setEditor: null, setPreview: null, setTheme: null };
  }
  return {
    setEditor: firstOf(
      typeof mod.setEditorTheme === "function" ? mod.setEditorTheme : undefined,
      typeof mod.setEditorPalette === "function"
        ? mod.setEditorPalette
        : undefined,
      typeof mod.applyEditorTheme === "function"
        ? mod.applyEditorTheme
        : undefined,
    ),
    setPreview: firstOf(
      typeof mod.setPreviewTheme === "function" ? mod.setPreviewTheme : undefined,
      typeof mod.setPreviewPalette === "function"
        ? mod.setPreviewPalette
        : undefined,
      typeof mod.applyPreviewTheme === "function"
        ? mod.applyPreviewTheme
        : undefined,
    ),
    setTheme: firstOf(
      typeof mod.setTheme === "function" ? mod.setTheme : undefined,
      typeof mod.applyTheme === "function" ? mod.applyTheme : undefined,
      typeof mod.setThemes === "function" ? mod.setThemes : undefined,
    ),
  };
}

function readNamed(prefs, which) {
  if (!prefs) return null;
  if (which === "editor") return canonicalPaletteName(prefs.editor) || prefs.editor || null;
  if (which === "preview") {
    return canonicalPaletteName(prefs.preview) || prefs.preview || null;
  }
  return canonicalPaletteName(prefs.chrome) || prefs.chrome || null;
}

function assignTheme(api, which, name) {
  const { setEditor, setPreview, setTheme } = api.setters;
  if (which === "editor" && typeof setEditor === "function") {
    setEditor(name);
    return true;
  }
  if (which === "preview" && typeof setPreview === "function") {
    setPreview(name);
    return true;
  }
  if (typeof setTheme === "function") {
    setTheme({ [which]: name });
    return true;
  }
  const keys =
    which === "editor"
      ? ["editor", "editorTheme", "editorPalette"]
      : which === "preview"
        ? ["preview", "previewTheme", "previewPalette"]
        : ["chrome", "chromeTheme", "chromePalette"];
  const targets = [api.prefs?.raw, api.themeObj].filter(Boolean);
  for (const target of targets) {
    if (typeof target !== "object") continue;
    for (const key of keys) {
      if (key in target) {
        try {
          target[key] = name;
          if (api.prefs) api.prefs[which] = name;
          return true;
        } catch {
          // const binding or frozen object
        }
      }
    }
  }
  if (api.prefs && typeof api.prefs === "object") {
    try {
      api.prefs[which] = name;
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

function sourceHasCmPaletteMaps(files) {
  return files.some((file) => {
    const src = file.text;
    const hasTheme = /EditorView\.theme\s*\(/.test(src);
    const usesVars =
      /EditorView\.theme[\s\S]{0,2500}var\(--(?:bg|fg|accent)/.test(src) ||
      /var\(--(?:bg|fg|accent)[\s\S]{0,2500}EditorView\.theme/.test(src);
    const maps =
      /\b(?:cmThemes|codeMirrorThemes|editorThemes|cmTheme)\s*=/.test(src);
    const builder =
      /\b(?:codeMirrorTheme|cmTheme|editorThemeFor|themeForPalette)\s*\(/.test(
        src,
      );
    return hasTheme && (usesVars || maps || builder);
  });
}

function sourceSaysChromeFollowsEditor(src) {
  return (
    /chromeFollowsEditor\s*[:=]\s*true/.test(src) ||
    /chrome(?:Theme|Palette)?\s*[:=]\s*["'`]editor["'`]/.test(src) ||
    /chrome[\s\S]{0,100}follow[\s\S]{0,50}editor/i.test(src) ||
    /follow[\s\S]{0,50}editor[\s\S]{0,50}(?:theme|palette)/i.test(src)
  );
}

function prefsFromSource(src) {
  const editor =
    src.match(/\beditor(?:Theme|Palette)?\s*[:=]\s*["'`]([^"'`]+)["'`]/i) ||
    src.match(/\bEDITOR_THEME\s*[:=]\s*["'`]([^"'`]+)["'`]/);
  const preview =
    src.match(/\bpreview(?:Theme|Palette)?\s*[:=]\s*["'`]([^"'`]+)["'`]/i) ||
    src.match(/\bPREVIEW_THEME\s*[:=]\s*["'`]([^"'`]+)["'`]/);
  if (!editor && !preview) return null;
  const chrome = src.match(
    /\bchrome(?:Theme|Palette)?\s*[:=]\s*["'`]([^"'`]+)["'`]/i,
  );
  const follows = /chromeFollowsEditor\s*[:=]\s*true/.test(src);
  return {
    editor: editor && editor[1],
    preview: preview && preview[1],
    chrome: chrome && chrome[1],
    chromeFollowsEditor: follows || undefined,
    raw: null,
  };
}

async function importSrcModules() {
  const files = collectFiles(srcDir);
  const mods = [];
  for (const p of files) {
    if (!/\.(js|mjs|cjs)$/i.test(p)) continue;
    if (/editor\.bundle\.js$/i.test(p)) continue;
    try {
      const mod = await import(pathToFileURL(p).href);
      mods.push(mod);
    } catch {
      // DOM or otherwise unusable in Node: keep looking.
    }
  }
  for (const p of files) {
    if (!/\.json$/i.test(p)) continue;
    if (!/palette|theme|color/i.test(p)) continue;
    try {
      mods.push(JSON.parse(readFileSync(p, "utf8")));
    } catch {
      // ignore invalid json
    }
  }
  return mods;
}

let cachedApi;

async function loadApi() {
  if (cachedApi) return cachedApi;
  const files = loadSources();
  const src = joinedSource(files);
  const mods = await importSrcModules();
  let palettes = [];
  let prefs = null;
  let cmThemes = null;
  let settersFrom = { setEditor: null, setPreview: null, setTheme: null };
  let themeObj = null;
  let modRef = null;
  for (const mod of mods) {
    if (!palettes.length) {
      const found = pickPalettes(mod);
      if (found.length) palettes = found;
    }
    if (!prefs) {
      const found = pickPrefs(mod);
      if (found) {
        prefs = found;
        themeObj = found.raw || mod;
        modRef = mod;
      }
    }
    if (!cmThemes) {
      const found = pickCmThemes(mod);
      if (found) cmThemes = found;
    }
    const s = setters(mod);
    if (s.setEditor || s.setPreview || s.setTheme) {
      settersFrom = s;
      modRef = mod;
    }
  }
  if (!prefs) prefs = prefsFromSource(src);
  cachedApi = {
    files,
    src,
    palettes,
    prefs,
    cmThemes,
    setters: settersFrom,
    themeObj,
    mod: modRef,
    defaultEditor: readNamed(prefs, "editor"),
    defaultPreview: readNamed(prefs, "preview"),
    defaultChrome: readNamed(prefs, "chrome"),
    defaultChromeFollows: prefs?.chromeFollowsEditor,
  };
  return cachedApi;
}

function missingPaletteNames(palettes) {
  const have = new Set(palettes.map((p) => p.name));
  return PALETTE_NAMES.filter((name) => !have.has(name));
}

function paletteByName(palettes, name) {
  const canonical = canonicalPaletteName(name);
  return palettes.find((p) => p.name === canonical) || null;
}

function classifyAccentContexts(src) {
  const uses = { selection: false, focus: false, dirty: false, decoration: false };
  const re = /var\(--accent\)/g;
  let m;
  while ((m = re.exec(src))) {
    const start = Math.max(0, m.index - 220);
    const ctx = src.slice(start, m.index + m[0].length + 80);
    const isDirty = /#dirty\b|dirty[-_ ]?dot|\bdirty\b/i.test(ctx);
    const isSelection =
      /::selection|\bselection\b|cm-selection|caret-color|\.cm-selectionBackground|aria-selected|\.selected\b|#file-list\b/i.test(
        ctx,
      );
    const isFocus =
      /:focus(?:-visible|-within)?\b|\bfocus-visible\b|\boutline(?:-color)?\b/i.test(
        ctx,
      );
    const isTab =
      /#editor-tabs\b|\[role=["']tab(?:list)?["']\]|\.editor-tab\b|\btablist\b|\bactive tab\b/i.test(
        ctx,
      );
    if (isDirty) uses.dirty = true;
    if (isSelection) uses.selection = true;
    if (isFocus) uses.focus = true;
    if (!isDirty && !isSelection && !isFocus && !isTab) uses.decoration = true;
  }
  return uses;
}

test("Codex palettes exist", async () => {
  const api = await loadApi();
  assert.ok(
    api.palettes.length > 0,
    "missing palettes (testable export/object is enough)",
  );
  const missing = missingPaletteNames(api.palettes);
  assert.equal(
    missing.length,
    0,
    `missing named palettes: ${missing.join(", ")}`,
  );
});

test("each palette maps onto the seven CSS tokens with real color values", async () => {
  const api = await loadApi();
  assert.ok(
    api.palettes.length > 0,
    "missing palettes that map onto --bg --bg-elevated --fg --fg-muted --border --accent --danger",
  );
  const missing = missingPaletteNames(api.palettes);
  assert.equal(
    missing.length,
    0,
    `missing named palettes: ${missing.join(", ")}`,
  );
  for (const rec of api.palettes) {
    if (!PALETTE_NAMES.includes(rec.name)) continue;
    for (const token of TOKENS) {
      const value = rec.tokens[token];
      assert.ok(
        typeof value === "string" && value.trim() !== "",
        `${rec.name} missing token ${token} (seven tokens, real color values, not empty)`,
      );
      assert.ok(
        isRealColor(value),
        `${rec.name} ${token} must be a real color value, not empty (got ${JSON.stringify(value)})`,
      );
    }
  }
});

test("default theme is Tokyo Night", async () => {
  const { theme } = await import("../src/palettes.js");
  assert.equal(theme.name, "Tokyo Night", "default app theme must be Tokyo Night");
});

test("one named theme paints the whole app", async () => {
  const { theme, setTheme } = await import("../src/palettes.js");
  assert.equal(typeof setTheme, "function", "missing setTheme");
  const prev = theme.name;
  try {
    setTheme("Tokyo Night");
    setTheme("Nord");
    assert.equal(theme.name, "Nord", "setTheme must set the single app theme");
  } finally {
    setTheme(prev);
  }
});

test("CSS variables plus CodeMirror theme maps for each palette", async () => {
  const api = await loadApi();
  for (const token of TOKENS) {
    assert.ok(
      api.src.includes(token),
      `missing CSS variable ${token}`,
    );
  }
  assert.ok(
    api.palettes.length > 0,
    "missing palettes (each palette must be able to theme the editor)",
  );
  const missing = missingPaletteNames(api.palettes);
  assert.equal(
    missing.length,
    0,
    `missing named palettes: ${missing.join(", ")}`,
  );
  const sourceMaps = sourceHasCmPaletteMaps(api.files);
  for (const name of PALETTE_NAMES) {
    const rec = paletteByName(api.palettes, name);
    const map = paletteCmMap(rec, api.cmThemes);
    assert.ok(
      map || sourceMaps,
      `${name} missing CodeMirror theme map (each palette can theme the editor)`,
    );
  }
});

test("--accent is for selection, focus, dirty, and active editor tab", async () => {
  const api = await loadApi();
  const uses = classifyAccentContexts(api.src);
  assert.ok(uses.selection, "missing --accent for selection");
  assert.ok(uses.focus, "missing --accent for focus");
  assert.ok(uses.dirty, "missing --accent for dirty");
  assert.equal(
    uses.decoration,
    false,
    "--accent is for selection, focus, dirty, and Cursor-style active tab (not general chrome decoration)",
  );
});
