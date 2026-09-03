import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const htmlPath = join(root, "src", "index.html");

function loadHtml() {
  assert.equal(existsSync(htmlPath), true, "src/index.html must exist");
  return readFileSync(htmlPath, "utf8");
}

function explorerHtml(html) {
  const tagged = html.match(
    /<(aside|div|nav|section)\b[^>]*\bid=["']explorer["'][^>]*>[\s\S]*?<\/\1>/i,
  );
  if (tagged) {
    return tagged[0];
  }
  const start = html.search(/\bid=["']explorer["']/i);
  assert.ok(start >= 0, "missing #explorer");
  return html.slice(start);
}

function hasSortControl(html) {
  const explorer = explorerHtml(html);
  const hasSortId =
    /\bid=["'][^"']*sort[^"']*["']/i.test(html) ||
    /\.id\s*=\s*["'][^"']*sort[^"']*["']/i.test(html);
  const hasName =
    /<(?:option|button|input|label)\b[^>]*(?:value|id|name|aria-label)=["'][^"']*\bname\b[^"']*["']/i.test(
      html,
    ) ||
    /<(?:option|button|label)\b[^>]*>[\s\S]{0,40}?\bname\b/i.test(html) ||
    /\.value\s*=\s*["']name["']/i.test(html);
  const hasModified =
    /<(?:option|button|input|label)\b[^>]*(?:value|id|name|aria-label)=["'][^"']*\bmodified\b[^"']*["']/i.test(
      html,
    ) ||
    /<(?:option|button|label)\b[^>]*>[\s\S]{0,40}?\bmodified\b/i.test(html) ||
    /\.value\s*=\s*["']modified["']/i.test(html) ||
    /\bmodified\b/i.test(html);
  const hasSelect = /<select\b/i.test(html) || /createElement\(\s*["']select["']/i.test(html);
  return (
    (hasSortId || hasSelect || /\bsort\b/i.test(explorer) || /\bsort\b/i.test(html)) &&
    hasName &&
    hasModified
  );
}

function hasExtensionsToggle(html) {
  const explorer = explorerHtml(html);
  const haystack = `${explorer}\n${html}`;
  if (/\bid=["'][^"']*ext(?:ension)?s?[^"']*["']/i.test(haystack)) return true;
  if (/\.id\s*=\s*["'][^"']*ext(?:ension)?s?[^"']*["']/i.test(haystack)) return true;
  if (
    /<(?:input|button|label)\b[^>]*(?:id|name|aria-label|for)=["'][^"']*ext(?:ension)?s?[^"']*["']/i.test(
      haystack,
    )
  ) {
    return true;
  }
  if (
    /<(?:button|label)\b[^>]*>[\s\S]{0,80}?ext(?:ension)?s?[\s\S]{0,80}?<\/(?:button|label)>/i.test(
      haystack,
    )
  ) {
    return true;
  }
  if (/(?:show|hide|toggle)[-_ ]?ext(?:ension)?s?/i.test(haystack)) return true;
  return false;
}

function hidesExtensionInDisplay(html) {
  if (/(?:show|hide|toggle)[-_ ]?ext(?:ension)?s?/i.test(html)) return true;
  if (/\bshowExtensions\b|\bhideExtensions\b|\bshow_ext(?:ension)?s?\b/i.test(html)) {
    return true;
  }
  if (
    /(?:textContent|innerText|innerHTML|displayName|label)\s*=[\s\S]{0,120}?(?:replace\s*\(|lastIndexOf\(\s*["']\.["']|split\(\s*["']\.["']|stripExt|withoutExt|hideExt|fileStem)/i.test(
      html,
    )
  ) {
    return true;
  }
  if (/replace\s*\(\s*\/\\?\.\w+/i.test(html)) return true;
  return false;
}

function dataPathKeepsExtension(html) {
  return (
    /dataset\.path\s*=\s*(?:node\.)?(?:path|relative_path)/.test(html) ||
    /setAttribute\(\s*["']data-path["']\s*,\s*(?:node\.)?(?:path|relative_path)/.test(html) ||
    /data-path=["'][^"']*\.\w+/.test(html)
  );
}

function openPathKeepsExtension(html) {
  return (
    /relative\s*:\s*(?:item\.)?dataset\.path/.test(html) ||
    /invoke\(\s*["']read_workspace_file["'][\s\S]{0,240}?(?:dataset\.path|relative)/.test(
      html,
    )
  );
}

test("explorer has a sort control (name vs modified)", () => {
  const html = loadHtml();
  assert.ok(
    hasSortControl(html),
    "explorer must have a sort control (name vs modified)",
  );
});

test("explorer has an extensions toggle", () => {
  const html = loadHtml();
  assert.ok(
    hasExtensionsToggle(html),
    "explorer must have an extensions toggle",
  );
});

test("hiding extensions changes displayed names but data-path/open path still includes the extension", () => {
  const html = loadHtml();
  assert.ok(
    hidesExtensionInDisplay(html),
    "hiding extensions must change displayed names",
  );
  assert.ok(
    dataPathKeepsExtension(html),
    "data-path must still include the extension",
  );
  assert.ok(
    openPathKeepsExtension(html),
    "open path must still include the extension",
  );
});
