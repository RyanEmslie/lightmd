import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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

function opensHtmlOrHtm(src) {
  const htmlQuestion = /\.html\?/i.test(src);
  const bothExt =
    /["']\.html["']/.test(src) && /["']\.htm["']/.test(src);
  const alternation = /html\|htm|htm\|html|\.html?\$/i.test(src);
  const named =
    /\b(?:isHtmlFile|isHtml|openHtml|showHtml|renderHtml|loadHtml|htmlViewer|viewHtml)\b/.test(
      src,
    );
  const viewerId =
    /\bid=["']html-viewer["']/.test(src) || /#html-viewer\b/.test(src);
  return htmlQuestion || bothExt || alternation || named || viewerId;
}

function hasSandboxedHtmlViewer(src) {
  return (
    hasIframe(src) &&
    hasSandboxAttr(src) &&
    !defaultAllowsScripts(src) &&
    opensHtmlOrHtm(src)
  );
}

function hasBrowsingChrome(src) {
  return (
    /\bid=["'][^"']*(?:address-bar|url-bar|omnibox|location-bar)[^"']*["']/i.test(
      src,
    ) ||
    /\b(?:addressBar|urlBar|omnibox|locationBar)\b/.test(src) ||
    /placeholder=["']https?:\/\//i.test(src) ||
    /<input\b[^>]*(?:type=["']url["']|name=["'](?:url|address)["'])/i.test(
      src,
    )
  );
}

function injectsTauriOrInvokeIntoDocument(src) {
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

test("fixture page.html (or .htm) has a script that would write to the page if it ran", () => {
  loadPageFixture();
});

test("opening .html/.htm uses a sandboxed viewer with JS off by default", () => {
  loadPageFixture();
  const src = loadSources();
  assert.ok(
    hasIframe(src) && hasSandboxAttr(src) && opensHtmlOrHtm(src),
    "missing sandboxed HTML viewer (iframe sandbox, no allow-scripts by default)",
  );
  assert.equal(
    defaultAllowsScripts(src),
    false,
    "JS default off (iframe sandbox must not include allow-scripts)",
  );
  assert.ok(
    hasSandboxedHtmlViewer(src),
    "missing sandboxed HTML viewer (iframe sandbox, no allow-scripts by default)",
  );
});

test("HTML viewer is not a general-purpose browser", () => {
  loadPageFixture();
  const src = loadSources();
  assert.ok(
    hasSandboxedHtmlViewer(src),
    "missing sandboxed HTML viewer (iframe sandbox, no allow-scripts by default)",
  );
  assert.equal(
    hasBrowsingChrome(src),
    false,
    "no address bar / in-app browsing chrome for the HTML viewer",
  );
});

test("document scripts do not get app file or Node access", () => {
  loadPageFixture();
  const src = loadSources();
  assert.ok(
    hasSandboxedHtmlViewer(src),
    "missing sandboxed HTML viewer (iframe sandbox, no allow-scripts by default)",
  );
  assert.equal(
    injectsTauriOrInvokeIntoDocument(src),
    false,
    "document scripts must not get __TAURI__ / invoke",
  );
});
