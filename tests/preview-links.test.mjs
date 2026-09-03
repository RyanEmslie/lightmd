import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(root, "src");

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

function hasPreviewBody(src) {
  return (
    /\bid=["']preview-body["']/.test(src) ||
    /\.id\s*=\s*["']preview-body["']/.test(src) ||
    /getElementById\(\s*["']preview-body["']\s*\)/.test(src) ||
    /#preview-body\b/.test(src)
  );
}

function hasPreviewLinkClick(src) {
  const named =
    /\b(?:onPreviewClick|handlePreviewClick|handlePreviewLink|previewLinkClick|interceptPreviewLinks|bindPreviewLinks|openPreviewLink)\b/.test(
      src,
    );
  const onPreview =
    /(?:previewBody|#preview-body|getElementById\(\s*["']preview-body["']\s*\)|#preview(?:[^\w-]|$)|previewPane)[\s\S]{0,600}?addEventListener\(\s*["'](?:click|auxclick)["']/.test(
      src,
    ) ||
    /addEventListener\(\s*["'](?:click|auxclick)["'][\s\S]{0,600}?(?:previewBody|#preview-body|preview-body|#preview(?:[^\w-]|$))/.test(
      src,
    ) ||
    /(?:previewBody|#preview-body)\.onclick\s*=/.test(src);
  const delegatedAnchor =
    /closest\(\s*["']a(?:\[[^\]]*\])?["']/.test(src) ||
    /matches\(\s*["']a(?:\[[^\]]*\])?["']/.test(src) ||
    /tagName\s*===?\s*["']A["']/.test(src);
  return named || onPreview || (delegatedAnchor && hasPreviewBody(src));
}

function hasHttpLinkCheck(src) {
  return (
    /https?:\/\//.test(src) ||
    /["']https?:/.test(src) ||
    /startsWith\(\s*["']https?:/.test(src) ||
    /\.protocol[\s\S]{0,80}["']https?/.test(src) ||
    /\/\^https\?:/.test(src)
  );
}

function hasPreventDefaultForPreviewHttp(src) {
  if (!/\.preventDefault\s*\(/.test(src)) return false;
  return (
    /preventDefault\s*\(\)[\s\S]{0,1200}?(?:https?:|openUrl|open_url|plugin:opener|plugin:shell|shell\.open|\bopener\b)/.test(
      src,
    ) ||
    /(?:https?:|openUrl|open_url|plugin:opener|plugin:shell|shell\.open|\bopener\b)[\s\S]{0,1200}?preventDefault\s*\(/.test(
      src,
    ) ||
    /preventDefault\s*\(\)[\s\S]{0,800}?closest\(\s*["']a/.test(src) ||
    /closest\(\s*["']a[\s\S]{0,800}?preventDefault\s*\(/.test(src)
  );
}

function hasSystemBrowserOpener(src) {
  return (
    /@tauri-apps\/plugin-opener/.test(src) ||
    /@tauri-apps\/plugin-shell/.test(src) ||
    /plugin:opener\|open(?:_url)?/.test(src) ||
    /plugin:shell\|open/.test(src) ||
    /invoke\(\s*["'](?:open_url|openUrl|open_in_browser|openInBrowser|shell_open)["']/.test(
      src,
    ) ||
    /\bopenUrl\s*\(/.test(src) ||
    /\bopen_url\b/.test(src) ||
    /(?:__TAURI__|\btauri\b)[\s\S]{0,160}?(?:opener|shell)[\s\S]{0,80}\.open(?:Url)?\s*\(/.test(
      src,
    ) ||
    /\bopener\b[\s\S]{0,80}\.open(?:Url)?\s*\(/.test(src) ||
    /\bshell\s*\.\s*open\s*\(/.test(src)
  );
}

function interceptsPreviewHttpLinks(src) {
  return (
    hasPreviewBody(src) &&
    hasPreviewLinkClick(src) &&
    hasHttpLinkCheck(src) &&
    hasPreventDefaultForPreviewHttp(src)
  );
}

function navigatesWebviewInApp(src) {
  return (
    /location\.assign\s*\(/.test(src) ||
    /location\.replace\s*\(/.test(src) ||
    /(?:window\.)?location\.href\s*=/.test(src) ||
    /window\.location\s*=/.test(src) ||
    /webview\.(?:navigate|loadUrl|load_url)\s*\(/.test(src)
  );
}

test("https:// (or http://) links in #preview-body preventDefault and open in the system browser", () => {
  const src = loadSources();
  assert.ok(
    interceptsPreviewHttpLinks(src),
    "missing preventDefault for http(s) links in #preview-body",
  );
  assert.ok(
    hasSystemBrowserOpener(src),
    "missing OS/system browser (opener plugin, open_url, shell open, or similar)",
  );
});

test("http(s) preview links do not navigate the webview in-app", () => {
  const src = loadSources();
  assert.ok(
    interceptsPreviewHttpLinks(src) && hasSystemBrowserOpener(src),
    "missing preventDefault/system-browser for http(s) preview links",
  );
  assert.equal(
    navigatesWebviewInApp(src),
    false,
    "no in-app navigation (no location.assign / href on the webview for those links)",
  );
});
