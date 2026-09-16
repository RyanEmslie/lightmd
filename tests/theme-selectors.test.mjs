import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { loadSourceFiles, collectFiles } from "./helpers/source.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(root, "src");

const THEME_CONTROL_ID = String.raw`(?:settings-)?theme`;
const SET_THEME = String.raw`setTheme`;
const BIND_THEME =
  String.raw`bindThemeSelectors|mountThemeSelectors|wireThemeSelectors|bindThemeControls|attachThemeSelectors|bindThemePicker`;

const THEME_COLOR_PROP =
  String.raw`color|background(?:-color)?|border-color|outline-color|caret-color|fill|stroke|text-decoration-color|--(?:bg|bg-elevated|fg|fg-muted|border|accent|danger)`;
const LAYOUT_PROP =
  String.raw`width|min-width|max-width|height|min-height|max-height|flex(?:-basis|-grow|-shrink)?|grid-template(?:-columns|-rows)?|transform|left|right|top|bottom|margin|padding|inset`;


function loadSources() {
  return loadSourceFiles();
}

function joinedSource(files = loadSources()) {
  return files.map((f) => f.text).join("\n");
}

function isSettingsPath(p) {
  return /settings/i.test(p);
}

function chromeSource(files) {
  return files
    .filter((f) => !isSettingsPath(f.path))
    .map((f) => f.text)
    .join("\n");
}

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function controlIdRe(idAlt) {
  const id = `(?:${idAlt})`;
  return new RegExp(
    String.raw`(?:\bid=["']${id}["']|\bfor=["']${id}["']|\bname=["']${id}["']|getElementById\(\s*["']${id}["']\s*\)|querySelector(?:All)?\(\s*["']#${id}["']\s*\)|\.id\s*=\s*["']${id}["'])`,
    "i",
  );
}

function hasControlId(src, idAlt) {
  return controlIdRe(idAlt).test(src);
}

function hasSelectOrControlMarkup(src, idAlt) {
  const id = `(?:${idAlt})`;
  const tag = new RegExp(
    String.raw`<(?:select|input|button)\b[^>]*(?:\bid=["']${id}["']|\bname=["']${id}["'])`,
    "i",
  );
  const role = new RegExp(
    String.raw`<(?:div|span|button|input|select)\b[^>]*(?:\bid=["']${id}["'][^>]*role=["'](?:combobox|listbox|button)["']|role=["'](?:combobox|listbox|button)["'][^>]*\bid=["']${id}["'])`,
    "i",
  );
  const created = new RegExp(
    String.raw`createElement\(\s*["'](?:select|input|button)["']\s*\)[\s\S]{0,400}\.id\s*=\s*["']${id}["']`,
    "i",
  );
  const createdFlip = new RegExp(
    String.raw`\.id\s*=\s*["']${id}["'][\s\S]{0,400}createElement\(\s*["'](?:select|input|button)["']\s*\)`,
    "i",
  );
  return (
    tag.test(src) ||
    role.test(src) ||
    created.test(src) ||
    createdFlip.test(src) ||
    hasControlId(src, idAlt)
  );
}

function hasChromeThemeSelectors(files) {
  const src = joinedSource(files);
  return hasSelectOrControlMarkup(src, String.raw`settings-theme`);
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

function windowHasChange(window) {
  return (
    /addEventListener\(\s*["'](?:change|input)["']/i.test(window) ||
    /on(?:change|input)\s*=/i.test(window) ||
    /\.onchange\s*=/i.test(window)
  );
}

function windowHasSetter(window, setterAlt) {
  return new RegExp(String.raw`\b(?:${setterAlt})\s*\(`, "i").test(window);
}

function windowHasBind(window) {
  return new RegExp(String.raw`\b(?:${BIND_THEME})\s*\(`, "i").test(window);
}

function bindFnBodies(src) {
  const bodies = [];
  const names = BIND_THEME;
  const fn = new RegExp(
    String.raw`(?:export\s+)?function\s+(?:${names})\s*\([^)]*\)\s*\{([\s\S]{0,2500}?)\}`,
    "gi",
  );
  const assign = new RegExp(
    String.raw`(?:export\s+)?(?:const|let|var)\s+(?:${names})\s*=\s*(?:async\s*)?\([^)]*\)\s*=>\s*\{([\s\S]{0,2500}?)\}`,
    "gi",
  );
  let m;
  while ((m = fn.exec(src))) bodies.push(m[1] || m[0]);
  while ((m = assign.exec(src))) bodies.push(m[1] || m[0]);
  return bodies;
}

function bindUsesSetters(src) {
  const bodies = bindFnBodies(src);
  if (bodies.length) {
    return bodies.some((body) => windowHasSetter(body, SET_THEME));
  }
  if (!new RegExp(String.raw`\b(?:${BIND_THEME})\b`).test(src)) return false;
  return windowHasSetter(src, SET_THEME);
}

function selectorUsesSetter(src, idAlt, setterAlt) {
  const windows = windowsAround(src, controlIdRe(idAlt), 900, 900);
  if (!windows.length) return false;
  const bindOk = bindUsesSetters(src);
  return windows.some((window) => {
    if (windowHasSetter(window, setterAlt) && windowHasChange(window)) {
      return true;
    }
    if (windowHasSetter(window, setterAlt) && /value|selectedOptions|selectedIndex/i.test(window)) {
      return true;
    }
    if (windowHasBind(window) && bindOk) return true;
    return false;
  });
}

function applyThemeUpdatesSurface(src, paneId) {
  const windows = windowsAround(
    src,
    new RegExp(String.raw`getElementById\(\s*["']${paneId}["']\s*\)`, "g"),
    400,
    400,
  );
  if (!windows.length) return false;
  return windows.some(
    (window) =>
      /applyPalette\s*\(/.test(window) ||
      /setProperty\s*\(/.test(window) ||
      /style\.(?:background|color|setProperty)/.test(window) ||
      /classList\.(?:add|toggle|replace)/.test(window),
  );
}

function selectorsUpdateBothSurfaces(files) {
  const src = joinedSource(files);
  return (
    selectorUsesSetter(src, THEME_CONTROL_ID, SET_THEME) ||
    /\bsetTheme\s*\(/.test(src)
  );
}

function durationMsList(value) {
  const out = [];
  const re = /(\d*\.?\d+)\s*(ms|s)\b/gi;
  let m;
  while ((m = re.exec(value))) {
    const n = Number.parseFloat(m[1]);
    if (!Number.isFinite(n)) continue;
    out.push(m[2].toLowerCase() === "s" ? n * 1000 : n);
  }
  return out;
}

function hasNonZeroDuration(value) {
  const times = durationMsList(value);
  return times.some((ms) => ms > 0);
}

function declAnimatesThemeColors(value) {
  const v = String(value || "").trim();
  if (!v || /^none$/i.test(v)) return false;
  if (!hasNonZeroDuration(v) && !/\ball\b/i.test(v) && !new RegExp(THEME_COLOR_PROP, "i").test(v)) {
    // `transition: color` with implicit 0s is instant; still not an animation.
    return false;
  }
  if (!hasNonZeroDuration(v)) return false;
  if (/\ball\b/i.test(v)) return true;
  if (new RegExp(String.raw`(?:^|,)\s*(?:${THEME_COLOR_PROP})\b`, "i").test(v)) {
    return true;
  }
  if (new RegExp(THEME_COLOR_PROP, "i").test(v)) return true;
  // Shorthand with only a time (`transition: 0.2s`) means all properties.
  const withoutTimes = v
    .replace(/(\d*\.?\d+)\s*(ms|s)\b/gi, "")
    .replace(/\b(?:ease(?:-in)?(?:-out)?|linear|step-start|step-end|steps\([^)]*\)|cubic-bezier\([^)]*\))\b/gi, "")
    .replace(/[,/]/g, " ")
    .trim();
  if (!withoutTimes) return true;
  if (new RegExp(String.raw`^(?:${LAYOUT_PROP}\s*)+$`, "i").test(withoutTimes)) {
    return false;
  }
  return false;
}

function keyframesChangeThemeColors(src) {
  const re = /@keyframes\s+([A-Za-z_-][\w-]*)\s*\{([\s\S]*?)\}/gi;
  const names = [];
  let m;
  while ((m = re.exec(src))) {
    const body = m[2] || "";
    if (
      new RegExp(
        String.raw`(?:^|[{;])\s*(?:${THEME_COLOR_PROP})\s*:`,
        "i",
      ).test(body)
    ) {
      names.push(m[1]);
    }
  }
  return names;
}

function hasThemeColorMotion(src) {
  const css = stripComments(src);
  const transitionRe = /transition(?:-property)?\s*:\s*([^;{}]+)/gi;
  let m;
  while ((m = transitionRe.exec(css))) {
    if (declAnimatesThemeColors(m[1])) return true;
  }
  const animRe = /animation(?:-name)?\s*:\s*([^;{}]+)/gi;
  const colorKeyframes = new Set(keyframesChangeThemeColors(css).map((n) => n.toLowerCase()));
  while ((m = animRe.exec(css))) {
    const value = m[1];
    if (/^\s*none\s*$/i.test(value)) continue;
    if (!hasNonZeroDuration(value) && !colorKeyframes.size) continue;
    if (hasNonZeroDuration(value) && colorKeyframes.size) {
      const used = String(value)
        .split(/[\s,]+/)
        .filter((tok) => /^[A-Za-z_-][\w-]*$/.test(tok));
      if (used.some((tok) => colorKeyframes.has(tok.toLowerCase()))) return true;
    }
  }
  if (/\.startViewTransition\s*\(/.test(css)) return true;
  if (/\.animate\s*\(\s*\[/.test(css) && new RegExp(THEME_COLOR_PROP, "i").test(css)) {
    const animateWindows = windowsAround(css, /\.animate\s*\(/g, 80, 500);
    if (
      animateWindows.some((window) =>
        new RegExp(String.raw`(?:${THEME_COLOR_PROP})\s*:`, "i").test(window),
      )
    ) {
      return true;
    }
  }
  return false;
}

function hasDelayedThemeApply(src) {
  const delayed = windowsAround(
    src,
    /(?:setTimeout|requestAnimationFrame|queueMicrotask)\s*\(/g,
    0,
    700,
  );
  return delayed.some(
    (window) =>
      windowHasSetter(window, SET_THEME) ||
      /\bapplyTheme\s*\(/.test(window),
  ) ||
    /(?:transitionend|animationend)[\s\S]{0,500}(?:setTheme|applyTheme)\s*\(/.test(
      src,
    );
}

function firstOf(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function asThemeHook(mod) {
  if (!mod || typeof mod !== "object") return null;
  const setThemeFn = firstOf(
    typeof mod.setTheme === "function" ? mod.setTheme : undefined,
  );
  const bind = firstOf(
    typeof mod.bindThemeSelectors === "function"
      ? mod.bindThemeSelectors
      : undefined,
    typeof mod.mountThemeSelectors === "function"
      ? mod.mountThemeSelectors
      : undefined,
    typeof mod.wireThemeSelectors === "function"
      ? mod.wireThemeSelectors
      : undefined,
    typeof mod.bindThemeControls === "function"
      ? mod.bindThemeControls
      : undefined,
    typeof mod.attachThemeSelectors === "function"
      ? mod.attachThemeSelectors
      : undefined,
    typeof mod.bindThemePicker === "function" ? mod.bindThemePicker : undefined,
  );
  const controls = firstOf(mod.themeSelectors, mod.themeControls, mod.THEME_SELECTORS);
  if (!setThemeFn && !bind && !controls) return null;
  return { setTheme: setThemeFn, bind, controls, raw: mod };
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
  return mods;
}

async function loadThemeHook() {
  const mods = await importSrcModules();
  for (const mod of mods) {
    const hook = asThemeHook(mod);
    if (hook && (hook.setTheme || hook.bind || hook.controls)) {
      return hook;
    }
  }
  const src = joinedSource();
  if (new RegExp(String.raw`\b(?:${SET_THEME})\s*\(`).test(src)) {
    return { setTheme: true, bind: null, controls: null };
  }
  if (hasChromeThemeSelectors(loadSources())) {
    return { setTheme: true, bind: null, controls: "chrome" };
  }
  return null;
}

test("Settings has a theme selector", () => {
  const files = loadSources();
  assert.ok(
    hasChromeThemeSelectors(files),
    "missing Settings theme selector (select#settings-theme)",
  );
});

test("changing the theme selector uses setTheme", () => {
  const files = loadSources();
  assert.ok(
    selectorsUpdateBothSurfaces(files),
    "changing the Settings theme selector must use setTheme",
  );
});

test("theme switch is instant (no CSS transition/animation on theme colors besides the change itself)", () => {
  const files = loadSources();
  const src = joinedSource(files);
  assert.equal(
    hasThemeColorMotion(src),
    false,
    "theme switch must be instant (no CSS transition/animation on theme colors besides the change itself)",
  );
  assert.equal(
    hasDelayedThemeApply(src),
    false,
    "theme switch must be instant (no delayed setTimeout/rAF/transitionend around setTheme)",
  );
  assert.ok(
    hasChromeThemeSelectors(files) && selectorsUpdateBothSurfaces(files),
    "theme switch must be instant: changing the Settings theme selector must update immediately",
  );
});

test("Settings can share the same theme controls or a testable hook", async () => {
  const files = loadSources();
  const src = joinedSource(files);
  const hook = await loadThemeHook();
  const sharedControls = hasChromeThemeSelectors(files);
  const exportedHook =
    hook &&
    (typeof hook.setTheme === "function" ||
      hook.setTheme === true ||
      typeof hook.bind === "function" ||
      hook.controls);
  const sourceHook = new RegExp(
    String.raw`export\s+(?:function\s+)?(?:${SET_THEME}|${BIND_THEME})`,
  ).test(src);
  assert.ok(
    sharedControls || exportedHook || sourceHook,
    "missing testable Settings hook for theme selectors (export/object is enough; no full Settings page)",
  );
});
