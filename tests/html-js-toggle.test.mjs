import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(root, "src");
const fixturesDir = join(root, "tests", "fixtures");

function collectSource(dir) {
  const chunks = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) {
      chunks.push(...collectSource(p));
      continue;
    }
    if (ent.name === "editor.bundle.js") continue;
    if (/\.(html|js|mjs|cjs|ts|css)$/i.test(ent.name)) {
      chunks.push(readFileSync(p, "utf8"));
    }
  }
  return chunks;
}

function loadSources() {
  assert.equal(existsSync(srcDir), true, "src/ must exist");
  const files = collectSource(srcDir);
  assert.ok(files.length > 0, "src/ must contain editor source");
  return files.join("\n");
}

function findPageFixture() {
  const names = ["page.html", "page.htm"];
  const dirs = [fixturesDir, join(fixturesDir, "workspace")];
  for (const dir of dirs) {
    for (const name of names) {
      const p = join(dir, name);
      if (existsSync(p)) return p;
    }
  }
  return null;
}

function scriptWouldWriteToPage(html) {
  if (!/<script\b/i.test(html)) return false;
  return (
    /document\.write(?:ln)?\s*\(/.test(html) ||
    /\.innerHTML\s*=/.test(html) ||
    /\.outerHTML\s*=/.test(html) ||
    /\.textContent\s*=/.test(html) ||
    /\.innerText\s*=/.test(html) ||
    /\.append(?:Child)?\s*\(/.test(html) ||
    /insertAdjacentHTML\s*\(/.test(html)
  );
}

function loadPageFixture() {
  const path = findPageFixture();
  assert.ok(
    path,
    "missing fixture page.html (and/or .htm) with a script that would write to the page if it ran",
  );
  const html = readFileSync(path, "utf8");
  assert.ok(
    scriptWouldWriteToPage(html),
    "fixture page.html (and/or .htm) must include a script that would write to the page if it ran",
  );
  return html;
}

function hasIframe(src) {
  return (
    /<iframe\b/i.test(src) || /createElement\(\s*["']iframe["']\s*\)/.test(src)
  );
}

function hasSandboxAttr(src) {
  return (
    /<iframe\b[^>]*\bsandbox\b/i.test(src) ||
    /setAttribute\(\s*["']sandbox["']/.test(src) ||
    /\.sandbox(?:Attr)?\s*=/.test(src) ||
    /\bsandbox\s*:/.test(src)
  );
}

function sandboxLiteralValues(src) {
  const values = [];
  const htmlRe = /<iframe\b[^>]*\bsandbox\s*=\s*(["'])([^"']*)\1/gi;
  let m;
  while ((m = htmlRe.exec(src))) values.push(m[2]);
  const setRe =
    /setAttribute\(\s*["']sandbox["']\s*,\s*(["'`])([^"'`]*)\1/g;
  while ((m = setRe.exec(src))) values.push(m[2]);
  const assignRe = /\.sandbox(?:Attr)?\s*=\s*(["'`])([^"'`]*)\1/g;
  while ((m = assignRe.exec(src))) values.push(m[2]);
  return values;
}

function defaultAllowsScripts(src) {
  return sandboxLiteralValues(src).some((value) =>
    /\ballow-scripts\b/i.test(value),
  );
}

function sandboxMayAllowScripts(src) {
  return (
    /\ballow-scripts\b/i.test(src) ||
    /\.sandbox\.add\(\s*["']allow-scripts["']\s*\)/.test(src)
  );
}

function hasAllowSameOrigin(src) {
  const inLiteral = sandboxLiteralValues(src).some((value) =>
    /\ballow-same-origin\b/i.test(value),
  );
  const quoted = /["'`][^"'`]*\ballow-same-origin\b[^"'`]*["'`]/.test(src);
  const add = /\.sandbox\.add\(\s*["']allow-same-origin["']\s*\)/.test(src);
  return inLiteral || quoted || add;
}

function injectsTauriOrInvokeIntoIframe(src) {
  const intoFrame =
    /(?:contentWindow|contentDocument)[\s\S]{0,200}__TAURI__/.test(src) ||
    /__TAURI__[\s\S]{0,200}(?:contentWindow|contentDocument)/.test(src) ||
    /(?:contentWindow|contentDocument)[\s\S]{0,200}\.invoke\b/.test(src);
  const navigatesApp =
    /(?:location\.(?:assign|replace)\s*\(|(?:window\.)?location\.href\s*=|window\.location\s*=)[\s\S]{0,120}(?:\.html|\.htm|convertFileSrc|srcdoc)/.test(
      src,
    ) || /webview\.(?:navigate|loadUrl|load_url)\s*\(/.test(src);
  return intoFrame || navigatesApp;
}

function hasViewerJsToggle(src) {
  const namedFn =
    /\b(?:toggleHtmlJs|enableHtmlJs|setHtmlJs(?:Enabled)?|toggleHtmlJavaScript|setHtmlJavaScript|toggleAllowScripts|enableHtmlJavaScript)\s*\(/.test(
      src,
    );
  const controlId =
    /\bid=["'][^"']*(?:html-?js|enable-?js|js-?toggle|allow-?scripts|javascript)[^"']*["']/i.test(
      src,
    ) ||
    /getElementById\(\s*["'][^"']*(?:html-?js|enable-?js|js-?toggle|allow-?scripts|javascript)[^"']*["']\s*\)/.test(
      src,
    ) ||
    /\.id\s*=\s*["'][^"']*(?:html-?js|enable-?js|js-?toggle|javascript)[^"']*["']/.test(
      src,
    );
  const labeled =
    /<(?:button|label)\b[^>]*>[\s\S]{0,100}?(?:enable\s+java\s*script|java\s*script|run\s+scripts|html\s*js)[\s\S]{0,80}?<\/(?:button|label)>/i.test(
      src,
    ) ||
    /<(?:input|button)\b[^>]*(?:aria-label|title|name|for)=["'][^"']*(?:java\s*script|enable\s*js|html\s*js)[^"']*["']/i.test(
      src,
    );
  return namedFn || controlId || labeled;
}

function hasJsOnWarning(src) {
  const named =
    /\b(?:htmlJsWarning|jsWarning|javascriptWarning|showJsWarning|htmlJavaScriptWarning|jsOnWarning)\b/.test(
      src,
    );
  const id =
    /\bid=["'][^"']*(?:html-?js[-_]?warn|js[-_]?warn|javascript[-_]?warn|html-?js[-_]?alert)[^"']*["']/i.test(
      src,
    ) ||
    /getElementById\(\s*["'][^"']*(?:html-?js[-_]?warn|js[-_]?warn|javascript[-_]?warn|html-?js[-_]?alert)[^"']*["']\s*\)/.test(
      src,
    ) ||
    /\.id\s*=\s*["'][^"']*(?:html-?js[-_]?warn|js[-_]?warn|javascript[-_]?warn)[^"']*["']/.test(
      src,
    );
  const roleOrClass =
    /(?:javascript|html-?js|allow-scripts)[\s\S]{0,400}?(?:role=["']alert["']|aria-live|class=["'][^"']*warn)/i.test(
      src,
    ) ||
    /(?:role=["']alert["']|aria-live|class=["'][^"']*warn)[\s\S]{0,400}?(?:javascript|html-?js|allow-scripts)/i.test(
      src,
    );
  const copy =
    /(?:warning|caution|danger|alert)[\s\S]{0,220}?(?:javascript|scripts?\s+(?:are|is)\s+(?:enabled|on)|js\s+is\s+on)/i.test(
      src,
    ) ||
    /(?:javascript|js\s+is\s+on|scripts?\s+(?:are|is)\s+enabled)[\s\S]{0,220}?(?:warning|caution|danger|alert)/i.test(
      src,
    );
  return named || id || roleOrClass || copy;
}

function firstOf(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function asBool(value) {
  return typeof value === "boolean" ? value : undefined;
}

function asHtmlJsConfig(value) {
  if (typeof value === "boolean") return { enabled: value };
  if (!value || typeof value !== "object") return null;
  for (const nestedName of [
    "htmlJs",
    "htmlJS",
    "htmlJavaScript",
    "htmlJavascript",
    "htmlJsEnabled",
  ]) {
    if (value[nestedName] != null) {
      const nested = asHtmlJsConfig(value[nestedName]);
      if (nested) return nested;
    }
  }
  const enabled = firstOf(
    asBool(value.enabled),
    asBool(value.on),
    asBool(value.javascript),
    asBool(value.js),
    asBool(value.allowScripts),
  );
  if (typeof enabled === "boolean") return { enabled };
  return null;
}

const HTML_JS_NAMES = [
  "htmlJs",
  "htmlJS",
  "htmlJavaScript",
  "htmlJavascript",
  "htmlJsEnabled",
  "htmlJavaScriptEnabled",
  "enableHtmlJs",
  "allowHtmlJs",
  "HTML_JS",
  "html_js",
];

function pickHtmlJsPref(mod, seenDefault = false) {
  if (!mod || typeof mod !== "object") return null;
  for (const name of HTML_JS_NAMES) {
    if (name in mod) {
      const cfg = asHtmlJsConfig(mod[name]);
      if (cfg) return cfg;
    }
  }
  for (const wrap of [
    "settings",
    "config",
    "defaults",
    "default",
    "prefs",
    "preferences",
    "htmlViewer",
    "html",
  ]) {
    if (wrap === "default" && seenDefault) continue;
    const obj = mod[wrap];
    if (!obj || typeof obj !== "object") continue;
    for (const name of HTML_JS_NAMES) {
      if (name in obj) {
        const cfg = asHtmlJsConfig(obj[name]);
        if (cfg) return cfg;
      }
    }
    if (wrap === "html" || wrap === "htmlViewer") {
      const js = firstOf(
        asBool(obj.javascript),
        asBool(obj.js),
        asBool(obj.allowScripts),
        asBool(obj.enabled),
      );
      if (typeof js === "boolean") return { enabled: js };
    }
  }
  if (!seenDefault && mod.default && typeof mod.default === "object") {
    const cfg = pickHtmlJsPref(mod.default, true);
    if (cfg) return cfg;
  }
  return null;
}

function configFromSource(src) {
  const match =
    src.match(/\bhtml[-_]?js(?:Enabled|On)?\s*[:=]\s*(false|true)/i) ||
    src.match(/\bhtmlJavaScript(?:Enabled)?\s*[:=]\s*(false|true)/i) ||
    src.match(
      /\bhtml[-_]?js[\s\S]{0,400}?\b(?:enabled|on|javascript|allowScripts)\s*:\s*(false|true)/i,
    ) ||
    src.match(
      /\b(?:enabled|on|javascript|allowScripts)\s*:\s*(false|true)[\s\S]{0,400}?\bhtml[-_]?js/i,
    );
  if (!match) return null;
  return { enabled: match[1] === "true" };
}

async function loadHtmlJsPref() {
  const names = [
    "settings.js",
    "settings.mjs",
    "config.js",
    "config.mjs",
    "prefs.js",
    "prefs.mjs",
    "preferences.js",
    "html-js.js",
    "htmlJs.js",
    "html-viewer.js",
    "html-viewer.mjs",
    "editor.js",
    "preview.js",
  ];
  for (const name of names) {
    const p = join(srcDir, name);
    if (!existsSync(p)) continue;
    try {
      const mod = await import(pathToFileURL(p).href);
      const cfg = pickHtmlJsPref(mod);
      if (cfg) return cfg;
    } catch {
      // Missing export or unusable in Node: keep looking, then scan source.
    }
  }
  return configFromSource(loadSources());
}

test("JS default off: page.html script is inert (iframe sandbox has no allow-scripts)", () => {
  loadPageFixture();
  const src = loadSources();
  assert.ok(
    hasIframe(src) && hasSandboxAttr(src),
    "missing sandboxed HTML viewer (iframe sandbox, no allow-scripts by default)",
  );
  assert.equal(
    defaultAllowsScripts(src),
    false,
    "JS default off (iframe sandbox must not include allow-scripts)",
  );
});

test("viewer has a control that can enable JS", () => {
  loadPageFixture();
  const src = loadSources();
  assert.ok(hasViewerJsToggle(src), "missing viewer JS toggle");
});

test("testable Settings pref for HTML JS exists and defaults off", async () => {
  loadPageFixture();
  const pref = await loadHtmlJsPref();
  assert.ok(
    pref,
    "missing testable Settings pref (export/object is enough)",
  );
  assert.equal(pref.enabled, false, "HTML JS pref must default off");
});

test("when JS is on, a warning is shown and sandbox may include allow-scripts", () => {
  loadPageFixture();
  const src = loadSources();
  assert.ok(hasJsOnWarning(src), "missing warning while JS is on");
  assert.ok(
    sandboxMayAllowScripts(src),
    "when JS is on, sandbox may include allow-scripts",
  );
});

test("HTML JS never uses allow-same-origin", () => {
  loadPageFixture();
  const src = loadSources();
  assert.equal(hasAllowSameOrigin(src), false, "never allow-same-origin");
});

test("document scripts do not get __TAURI__ / invoke in the iframe", () => {
  loadPageFixture();
  const src = loadSources();
  assert.equal(
    injectsTauriOrInvokeIntoIframe(src),
    false,
    "never inject __TAURI__ / invoke into the iframe",
  );
});
