import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  applyTheme,
  palettes,
  setTheme,
  theme,
} from "../src/palettes.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const INDEX_HTML = join(root, "src", "index.html");

const REFERENCE_CONTROLS = ["pane-order"];
const UNTHEMED_CONTROLS = [
  "pane-layout",
  "pane-order",
];

const FG_VAR = /var\(\s*--fg\s*\)/;
const BG_VAR = /var\(\s*--bg(?:-elevated)?\s*\)/;
const BORDER_VAR = /var\(\s*--border\s*\)/;

function indexHtml() {
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

function loadCssRules() {
  const css = styleCss();
  assert.ok(css.trim(), "src/index.html must contain a <style> block");
  return parseRules(css);
}

function selectorTargetsId(selector, id) {
  const escaped = String(id).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(String.raw`(^|,)\s*#${escaped}(?:$|[^\w-])`).test(selector);
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

function declsForId(rules, id) {
  const merged = {};
  for (const rule of rules) {
    if (selectorTargetsId(rule.selector, id)) {
      Object.assign(merged, parseDecls(rule.body));
    }
  }
  return merged;
}

function themeTokenReport(decls) {
  const color = decls.color || "";
  const background = decls.background || decls["background-color"] || "";
  const border =
    decls.border ||
    decls["border-color"] ||
    decls["border-top-color"] ||
    "";
  const missing = [];
  if (!FG_VAR.test(color)) missing.push("color: var(--fg)");
  if (!BG_VAR.test(background)) {
    missing.push("background: var(--bg) or var(--bg-elevated)");
  }
  if (!BORDER_VAR.test(border)) missing.push("border: var(--border)");
  return { ok: missing.length === 0, missing, color, background, border };
}

function missingTokenFailures(rules, ids) {
  const failures = [];
  for (const id of ids) {
    const report = themeTokenReport(declsForId(rules, id));
    if (!report.ok) {
      failures.push(
        `#${id} missing ${report.missing.join(", ")} (got color=${JSON.stringify(report.color)} background=${JSON.stringify(report.background)} border=${JSON.stringify(report.border)})`,
      );
    }
  }
  return failures;
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
  for (const id of ["explorer", "editor", "preview"]) {
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

function withThemeFixture(run) {
  const prevDoc = globalThis.document;
  const prevName = theme.name;
  const doc = installDocument();
  try {
    return run(doc);
  } finally {
    theme.name = prevName;
    globalThis.document = prevDoc;
  }
}

function isSharedChromeButtonSelector(selector) {
  return String(selector)
    .split(",")
    .some((part) => {
      const p = part.trim();
      if (/#open-folder(?:$|[^\w-])/.test(p)) return true;
      if (/#settings-open(?:$|[^\w-])/.test(p)) return true;
      if (/\[data-pane-toggle/.test(p)) return true;
      if (/#layout-bar(?:$|[^\w-])/.test(p) && /\bbutton\b/.test(p)) return true;
      if (/#explorer(?:-toolbar)?(?:$|[^\w-])/.test(p) && /\bbutton\b/.test(p)) {
        return true;
      }
      return false;
    });
}

function hasFixedHexPaint(value) {
  const v = String(value || "").trim();
  if (!v) return false;
  if (/var\(\s*--/.test(v)) return false;
  return /#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})\b/i.test(v);
}

test("layout, sort, and find controls use chrome theme tokens", () => {
  const rules = loadCssRules();
  for (const id of REFERENCE_CONTROLS) {
    const report = themeTokenReport(declsForId(rules, id));
    assert.equal(
      report.ok,
      true,
      `#${id} is the reference pattern (layout-bar / settings inputs) and must keep color/background/border theme tokens: missing ${report.missing.join(", ")}`,
    );
  }
  const failures = missingTokenFailures(rules, UNTHEMED_CONTROLS);
  assert.equal(
    failures.length,
    0,
    `#pane-layout and #pane-order must use theme tokens --bg or --bg-elevated, --fg, and --border for background/color/border (same pattern as settings inputs). ${failures.join("; ")}`,
  );
});

test("setTheme updates documentElement vars and control rules use them", () => {
  assert.equal(typeof setTheme, "function");
  assert.equal(typeof applyTheme, "function");
  assert.ok(palettes["Tokyo Night"] && palettes["Solarized Light"]);

  withThemeFixture((doc) => {
    setTheme("Tokyo Night");
    applyTheme();
    const before = cssVar(doc.documentElement, "--bg");
    assert.equal(
      before,
      palettes["Tokyo Night"]["--bg"],
      "setTheme must paint documentElement --bg from the named palette",
    );

    setTheme("Solarized Light");
    applyTheme();
    const after = cssVar(doc.documentElement, "--bg");
    assert.equal(
      after,
      palettes["Solarized Light"]["--bg"],
      "setTheme to a light palette must change documentElement --bg",
    );
    assert.notEqual(
      after,
      before,
      "documentElement --bg must change when the theme switches to Solarized Light",
    );
    assert.equal(
      cssVar(doc.body, "--bg"),
      "",
      "body inherits from :root (no per-element tokens)",
    );
    assert.equal(cssVar(doc.getElementById("explorer"), "--bg"), "");
    assert.equal(cssVar(doc.getElementById("editor"), "--bg"), "");
    assert.equal(cssVar(doc.getElementById("preview"), "--bg"), "");
  });

  const failures = missingTokenFailures(loadCssRules(), UNTHEMED_CONTROLS);
  assert.equal(
    failures.length,
    0,
    `control rules for #pane-layout and #pane-order must still reference var(--fg) / var(--bg or --bg-elevated) / var(--border) so they follow chrome CSS variables. ${failures.join("; ")}`,
  );
});

test("layout-bar and explorer chrome buttons do not use fixed hex backgrounds", () => {
  const rules = loadCssRules();
  const hexRules = [];
  for (const rule of rules) {
    if (!isSharedChromeButtonSelector(rule.selector)) continue;
    const decls = parseDecls(rule.body);
    const background = decls.background || decls["background-color"] || "";
    const color = decls.color || "";
    if (hasFixedHexPaint(background) || hasFixedHexPaint(color)) {
      hexRules.push(
        `${rule.selector.trim()} { background=${JSON.stringify(background)} color=${JSON.stringify(color)} }`,
      );
    }
  }
  assert.equal(
    hexRules.length,
    0,
    `layout-bar / explorer chrome buttons that are shared chrome must not use fixed hex backgrounds that ignore tokens: ${hexRules.join("; ")}`,
  );
});
