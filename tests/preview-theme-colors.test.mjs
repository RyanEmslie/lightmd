import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  applyTheme,
  palettes,
  setPreviewTheme,
  theme,
} from "../src/palettes.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(root, "src");
const INDEX_HTML = join(srcDir, "index.html");
const PALETTES_JS = join(srcDir, "palettes.js");
const PKG_PATH = join(root, "package.json");

const PALETTE_NAMES = [
  "Light",
  "Dark",
  "High Contrast Light",
  "High Contrast Dark",
  "Dark+",
  "Solarized Light",
  "Solarized Dark",
  "Monokai",
];

const CHROME_TOKENS = [
  "--bg",
  "--bg-elevated",
  "--fg",
  "--fg-muted",
  "--border",
  "--accent",
  "--danger",
];

const PREVIEW_TOKENS = ["--h1", "--h2", "--h3", "--link", "--code"];

const DISTINCT_THEMES = ["Monokai", "Solarized Light"];

const HEX = /^#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i;

const SKIP_DIRS = new Set([
  "node_modules",
  "target",
  ".git",
  "dist",
  "dist-ssr",
]);

function isNonEmptyHex(value) {
  return typeof value === "string" && HEX.test(value.trim());
}

function indexHtml() {
  assert.equal(existsSync(INDEX_HTML), true, "src/index.html must exist");
  return readFileSync(INDEX_HTML, "utf8");
}

function styleCss(html = indexHtml()) {
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

function loadCssRules() {
  const css = styleCss();
  assert.ok(css.trim(), "src/index.html must contain a <style> block");
  return parseRules(css);
}

function selectorTargetsPreviewTag(selector, tag) {
  const escaped = String(tag).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(
    String.raw`#(?:preview-body|preview)(?:$|[^\w-])(?:[^,{]*?)(?:\s+|>\s*)${escaped}(?:$|[^\w-])`,
  );
  return String(selector)
    .split(",")
    .map((part) => part.trim())
    .some((part) => {
      if (!part) return false;
      if (/#preview-chrome\b|#preview-theme\b/.test(part)) return false;
      return re.test(part);
    });
}

function previewTagColor(rules, tag) {
  let color = "";
  for (const rule of rules) {
    if (!selectorTargetsPreviewTag(rule.selector, tag)) continue;
    const decls = parseDecls(rule.body);
    if (decls.color) color = decls.color;
  }
  return color;
}

function colorUsesToken(value, token) {
  const name = String(token).replace(/^--/, "");
  return new RegExp(
    String.raw`var\(\s*--${name}\s*(?:,[^)]*)?\)`,
    "i",
  ).test(String(value || ""));
}

function mockStyle() {
  const vars = Object.create(null);
  return {
    setProperty(name, value) {
      vars[name] = String(value);
    },
    getPropertyValue(name) {
      return Object.hasOwn(vars, name) ? vars[name] : "";
    },
  };
}

function mockEl(id) {
  return { id, style: mockStyle() };
}

function installDocument() {
  const byId = new Map();
  for (const id of ["explorer", "editor", "preview", "preview-body"]) {
    byId.set(id, mockEl(id));
  }
  const doc = {
    documentElement: mockEl("html"),
    body: mockEl("body"),
    getElementById(id) {
      const key = String(id);
      if (!byId.has(key)) byId.set(key, mockEl(key));
      return byId.get(key);
    },
  };
  globalThis.document = doc;
  return doc;
}

function cssVar(el, name) {
  return el?.style?.getPropertyValue?.(name) || "";
}

function previewToken(doc, name) {
  return (
    cssVar(doc.getElementById("preview"), name) ||
    cssVar(doc.getElementById("preview-body"), name)
  );
}

function withThemeFixture(run) {
  const prevDoc = globalThis.document;
  const prevTheme = {
    editorTheme: theme.editorTheme,
    previewTheme: theme.previewTheme,
    chromeFollowsEditor: theme.chromeFollowsEditor,
    chromeTheme: theme.chromeTheme,
  };
  const doc = installDocument();
  try {
    return run(doc);
  } finally {
    theme.editorTheme = prevTheme.editorTheme;
    theme.previewTheme = prevTheme.previewTheme;
    theme.chromeFollowsEditor = prevTheme.chromeFollowsEditor;
    if (prevTheme.chromeTheme === undefined) delete theme.chromeTheme;
    else theme.chromeTheme = prevTheme.chromeTheme;
    globalThis.document = prevDoc;
  }
}

function collectFiles(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(ent.name)) continue;
    const p = join(dir, ent.name);
    if (ent.isDirectory()) {
      collectFiles(p, acc);
      continue;
    }
    acc.push(p);
  }
  return acc;
}

function loadPkg() {
  assert.equal(existsSync(PKG_PATH), true, "package.json must exist");
  return JSON.parse(readFileSync(PKG_PATH, "utf8"));
}

function depNames(pkg) {
  return [
    ...Object.keys(pkg.dependencies || {}),
    ...Object.keys(pkg.devDependencies || {}),
  ];
}

test("every shipped palette defines hand-authored --h1 --h2 --h3 --link --code hex tokens", () => {
  assert.equal(existsSync(PALETTES_JS), true, "src/palettes.js must exist");
  const missing = [];
  for (const name of PALETTE_NAMES) {
    const palette = palettes[name];
    assert.ok(palette && typeof palette === "object", `missing shipped palette ${name}`);
    for (const token of PREVIEW_TOKENS) {
      const value = palette[token];
      if (!isNonEmptyHex(value)) {
        missing.push(
          `${name} ${token} must be a hand-authored non-empty hex string (got ${JSON.stringify(value)})`,
        );
      }
    }
  }
  assert.equal(
    missing.length,
    0,
    `every shipped palette must define --h1, --h2, --h3, --link, --code as non-empty hex (not only the 7 chrome tokens). ${missing.join("; ")}`,
  );
});

test("preview CSS maps #preview-body h1/h2/h3, a, and code/pre to heading/link/code tokens", () => {
  const rules = loadCssRules();
  const failures = [];
  const required = [
    ["h1", "--h1"],
    ["h2", "--h2"],
    ["h3", "--h3"],
    ["a", "--link"],
  ];
  for (const [tag, token] of required) {
    const color = previewTagColor(rules, tag);
    if (!colorUsesToken(color, token)) {
      failures.push(
        `#preview-body ${tag} must use color: var(${token}) (got ${JSON.stringify(color) || "no color rule"})`,
      );
    }
  }
  const codeColor = previewTagColor(rules, "code");
  const preColor = previewTagColor(rules, "pre");
  if (!colorUsesToken(codeColor, "--code") && !colorUsesToken(preColor, "--code")) {
    failures.push(
      `#preview-body code/pre must use color: var(--code) (got code=${JSON.stringify(codeColor) || "no color rule"} pre=${JSON.stringify(preColor) || "no color rule"})`,
    );
  }
  assert.equal(
    failures.length,
    0,
    `preview CSS must map #preview-body h1/h2/h3, a, and code/pre onto --h1/--h2/--h3/--link/--code (current CSS uses --fg for body only). ${failures.join("; ")}`,
  );
});

test("Monokai and Solarized Light --h1/--h2/--fg are distinct after applyTheme/setPreviewTheme", () => {
  assert.equal(typeof setPreviewTheme, "function");
  assert.equal(typeof applyTheme, "function");

  for (const name of DISTINCT_THEMES) {
    const palette = palettes[name];
    assert.ok(palette, `missing shipped palette ${name}`);
    const h1 = palette["--h1"];
    const h2 = palette["--h2"];
    const fg = palette["--fg"];
    assert.ok(
      isNonEmptyHex(h1) && isNonEmptyHex(h2) && isNonEmptyHex(fg),
      `${name} must define non-empty hex --h1, --h2, and --fg (got --h1=${JSON.stringify(h1)} --h2=${JSON.stringify(h2)} --fg=${JSON.stringify(fg)})`,
    );
    assert.notEqual(h1, h2, `${name} --h1 must differ from --h2`);
    assert.notEqual(h1, fg, `${name} --h1 must differ from --fg`);
    assert.notEqual(h2, fg, `${name} --h2 must differ from --fg`);
  }

  withThemeFixture((doc) => {
    for (const name of DISTINCT_THEMES) {
      setPreviewTheme(name);
      applyTheme();
      const h1 = previewToken(doc, "--h1");
      const h2 = previewToken(doc, "--h2");
      const fg = previewToken(doc, "--fg");
      assert.equal(
        h1,
        palettes[name]["--h1"],
        `setPreviewTheme(${JSON.stringify(name)}) must paint preview --h1 from the palette`,
      );
      assert.equal(
        h2,
        palettes[name]["--h2"],
        `setPreviewTheme(${JSON.stringify(name)}) must paint preview --h2 from the palette`,
      );
      assert.equal(
        fg,
        palettes[name]["--fg"],
        `setPreviewTheme(${JSON.stringify(name)}) must paint preview --fg from the palette`,
      );
      assert.notEqual(h1, h2, `${name} applied --h1 must differ from --h2`);
      assert.notEqual(h1, fg, `${name} applied --h1 must differ from --fg`);
      assert.notEqual(h2, fg, `${name} applied --h2 must differ from --fg`);
    }
  });
});

test("switching previewTheme changes --h1/--link/--code, not only --bg", () => {
  assert.equal(typeof setPreviewTheme, "function");
  assert.equal(typeof applyTheme, "function");
  assert.ok(palettes.Monokai && palettes["Solarized Light"]);

  withThemeFixture((doc) => {
    setPreviewTheme("Monokai");
    applyTheme();
    const before = {
      bg: previewToken(doc, "--bg"),
      h1: previewToken(doc, "--h1"),
      link: previewToken(doc, "--link"),
      code: previewToken(doc, "--code"),
    };
    assert.equal(before.bg, palettes.Monokai["--bg"]);

    setPreviewTheme("Solarized Light");
    applyTheme();
    const after = {
      bg: previewToken(doc, "--bg"),
      h1: previewToken(doc, "--h1"),
      link: previewToken(doc, "--link"),
      code: previewToken(doc, "--code"),
    };
    assert.equal(after.bg, palettes["Solarized Light"]["--bg"]);
    assert.notEqual(
      after.bg,
      before.bg,
      "Monokai vs Solarized Light must differ in --bg",
    );

    const changed = ["h1", "link", "code"].filter(
      (key) => after[key] && before[key] && after[key] !== before[key],
    );
    assert.ok(
      changed.length > 0,
      `switching previewTheme from Monokai to Solarized Light must change at least one of --h1/--link/--code, not only --bg (before=${JSON.stringify(before)} after=${JSON.stringify(after)})`,
    );
  });
});

test("existing seven chrome tokens remain on every shipped palette", () => {
  const missing = [];
  for (const name of PALETTE_NAMES) {
    const palette = palettes[name];
    assert.ok(palette && typeof palette === "object", `missing shipped palette ${name}`);
    for (const token of CHROME_TOKENS) {
      const value = palette[token];
      if (!isNonEmptyHex(value)) {
        missing.push(
          `${name} ${token} must remain a non-empty hex string (got ${JSON.stringify(value)})`,
        );
      }
    }
  }
  assert.equal(
    missing.length,
    0,
    `keep the existing 7 chrome tokens --bg --bg-elevated --fg --fg-muted --border --accent --danger. ${missing.join("; ")}`,
  );

  withThemeFixture((doc) => {
    setPreviewTheme("Dark");
    applyTheme();
    for (const token of CHROME_TOKENS) {
      assert.equal(
        previewToken(doc, token),
        palettes.Dark[token],
        `applyTheme must still paint preview ${token} from the 7 chrome tokens`,
      );
    }
  });
});

test("no VS Code or TextMate theme import files", () => {
  const files = collectFiles(srcDir);
  const banned = [];
  for (const p of files) {
    const rel = relative(root, p).replace(/\\/g, "/");
    if (/editor\.bundle\.js$/i.test(rel)) continue;
    if (/\.(tmTheme|tmLanguage)$/i.test(rel)) {
      banned.push(rel);
      continue;
    }
    if (/(?:^|\/)(?:vscode|textmate|tmtheme)/i.test(rel)) {
      banned.push(rel);
    }
  }
  assert.equal(
    banned.length,
    0,
    `do not add VS Code or TextMate theme import files: ${banned.join(", ")}`,
  );

  const srcText = files
    .filter((p) => /\.(html|js|mjs|cjs|ts|css|json)$/i.test(p))
    .filter((p) => !/editor\.bundle\.js$/i.test(p))
    .map((p) => readFileSync(p, "utf8"))
    .join("\n");
  assert.equal(
    /\b(?:shiki|highlight\.js|vscode-oniguruma|tmTheme|TextMate)\b/i.test(srcText),
    false,
    "src must not import VS Code, TextMate, Shiki, or highlight.js theme packs",
  );

  const pkg = loadPkg();
  const bannedDeps = depNames(pkg).filter((name) =>
    /^(?:shiki|highlight\.js|vscode-oniguruma|vscode-theme|textmate)/i.test(name),
  );
  assert.equal(
    bannedDeps.length,
    0,
    `package.json must not add VS Code/TextMate/Shiki/highlight.js theme deps: ${bannedDeps.join(", ")}`,
  );
});
