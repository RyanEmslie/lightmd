import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(root, "src");

const STRIP_ID = String.raw`status[-_]?strip|status[-_]?bar|statusbar|status`;
const PATH_ID = String.raw`status[-_]?path|file[-_]?path|relative[-_]?path|open[-_]?path|status[-_]?file`;
const WORD_ID = String.raw`word[-_]?count|wordcount|status[-_]?words|status[-_]?word[-_]?count|words`;
const THEME_ID = String.raw`editor[-_]?theme|preview[-_]?theme`;

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

function taggedById(src, id) {
  const block = new RegExp(
    `<([a-zA-Z][\\w-]*)\\b[^>]*\\bid=["']${id}["'][^>]*>([\\s\\S]*?)</\\1>`,
    "i",
  );
  const m = src.match(block);
  if (m) return { id, tag: m[1], inner: m[2], full: m[0] };
  const open = src.match(
    new RegExp(`<([a-zA-Z][\\w-]*)\\b[^>]*\\bid=["']${id}["'][^>]*>`, "i"),
  );
  if (open) return { id, tag: open[1], inner: "", full: open[0] };
  return null;
}

function idsMatching(src, idAlt) {
  const ids = new Set();
  const patterns = [
    new RegExp(String.raw`\bid=["'](${idAlt})["']`, "gi"),
    new RegExp(String.raw`\.id\s*=\s*["'](${idAlt})["']`, "gi"),
    new RegExp(String.raw`getElementById\(\s*["'](${idAlt})["']\s*\)`, "gi"),
    new RegExp(
      String.raw`querySelector(?:All)?\(\s*["']#(${idAlt})["']\s*\)`,
      "gi",
    ),
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(src))) ids.add(m[1]);
  }
  return [...ids];
}

function hasClass(src, classAlt) {
  return new RegExp(
    String.raw`class=["'][^"']*\b(?:${classAlt})\b`,
    "i",
  ).test(src);
}

function findStripIds(src) {
  const ids = idsMatching(src, STRIP_ID);
  if (ids.length) return ids;
  if (hasClass(src, STRIP_ID) || /<footer\b/i.test(src) || /role=["']status["']/i.test(src)) {
    return ["status-strip"];
  }
  return [];
}

function hasStripIdent(src) {
  if (findStripIds(src).length) return true;
  if (hasClass(src, STRIP_ID)) return true;
  if (/role=["']status["']/.test(src) && /24px/.test(src)) return true;
  if (/<footer\b/i.test(src) && /24px/.test(src)) return true;
  return false;
}

function looksLike24pxHeight(window) {
  return (
    /(?:min-)?(?:height|line-height)\s*:\s*24px/.test(window) ||
    /(?:min-)?(?:height|lineHeight)\s*[:=]\s*["']24px["']/.test(window) ||
    /\.style\.(?:min)?[Hh]eight\s*=\s*["']24px["']/.test(window)
  );
}

function has24pxForStrip(src, ids) {
  for (const id of ids) {
    const windows = windowsAround(
      src,
      new RegExp(String.raw`#${id}\b|["']${id}["']`, "g"),
      250,
      450,
    );
    if (windows.some(looksLike24pxHeight)) return true;
  }
  if (
    hasStripIdent(src) &&
    /grid-template-rows\s*:\s*[^;{}]*24px/.test(src)
  ) {
    return true;
  }
  if (
    hasStripIdent(src) &&
    windowsAround(src, /(?:status[-_]?strip|status[-_]?bar|statusbar|<footer\b)/gi, 200, 400)
      .some(looksLike24pxHeight)
  ) {
    return true;
  }
  return false;
}

function stripIsBottom(src, ids) {
  for (const id of ids) {
    const windows = windowsAround(
      src,
      new RegExp(String.raw`#${id}\b|["']${id}["']`, "g"),
      220,
      400,
    );
    if (
      windows.some(
        (w) =>
          /bottom\s*:\s*0/.test(w) ||
          /position\s*:\s*(?:fixed|absolute|sticky)/.test(w),
      )
    ) {
      return true;
    }
  }
  if (/grid-template-rows\s*:\s*[^;{}]*24px/.test(src)) return true;
  const shellIdx = src.search(/\bid=["']shell["']/i);
  for (const id of ids) {
    const m = new RegExp(String.raw`\bid=["']${id}["']`).exec(src);
    if (m && shellIdx >= 0 && m.index > shellIdx) return true;
  }
  if (/<footer\b/i.test(src)) return true;
  if (
    windowsAround(src, /(?:status[-_]?strip|status[-_]?bar|statusbar)/gi, 200, 400)
      .some((w) => /bottom\s*:\s*0/.test(w))
  ) {
    return true;
  }
  return false;
}

function has24pxBottomStatusStrip(src) {
  const ids = findStripIds(src);
  if (!hasStripIdent(src)) return false;
  if (!has24pxForStrip(src, ids.length ? ids : ["status-strip", "status-bar", "status"])) {
    return false;
  }
  return stripIsBottom(src, ids.length ? ids : ["status-strip", "status-bar", "status"]);
}

function stripMarkup(src) {
  const ids = findStripIds(src);
  for (const id of ids) {
    const tagged = taggedById(src, id);
    if (tagged) return tagged.full;
  }
  const footer = src.match(/<footer\b[^>]*>[\s\S]*?<\/footer>/i);
  if (footer) return footer[0];
  const classed = src.match(
    /<([a-zA-Z][\w-]*)\b[^>]*class=["'][^"']*\b(?:status[-_]?strip|status[-_]?bar|statusbar)\b[^"']*["'][^>]*>[\s\S]*?<\/\1>/i,
  );
  if (classed) return classed[0];
  const created = windowsAround(
    src,
    new RegExp(
      String.raw`(?:createElement\(|\.id\s*=\s*["'](?:${STRIP_ID})["']|innerHTML\s*=)`,
      "g",
    ),
    80,
    700,
  ).filter((w) => new RegExp(STRIP_ID, "i").test(w));
  return created.join("\n") || "";
}

function hasPathId(src) {
  return idsMatching(src, PATH_ID).length > 0;
}

function writesRelativePath(src) {
  const windows = windowsAround(src, /(?:textContent|innerText)\s*=/g, 220, 220);
  return windows.some((w) => {
    if (/\bcurrentRelative\b/.test(w)) return true;
    if (/\brelative_path\b/.test(w)) return true;
    if (
      /\brelative\b/.test(w) &&
      new RegExp(PATH_ID, "i").test(w)
    ) {
      return true;
    }
    return false;
  });
}

function hasRelativePathOnStrip(src) {
  if (!hasStripIdent(src)) return false;
  if (!hasPathId(src) && !new RegExp(PATH_ID, "i").test(stripMarkup(src))) {
    return false;
  }
  return writesRelativePath(src);
}

function dirtyInMarkup(markup) {
  if (!markup) return false;
  return (
    /\bid=["'][^"']*dirty[^"']*["']/i.test(markup) ||
    /class=["'][^"']*\bdirty\b/i.test(markup) ||
    /dirty[-_ ]?dot/i.test(markup)
  );
}

function movesDirtyToStrip(src) {
  const windows = windowsAround(src, /append(?:Child)?\s*\(/g, 220, 220);
  return windows.some(
    (w) =>
      /dirty/i.test(w) &&
      new RegExp(STRIP_ID, "i").test(w),
  );
}

function hasDirtyOnStrip(src) {
  if (!hasStripIdent(src)) return false;
  if (dirtyInMarkup(stripMarkup(src))) return true;
  if (movesDirtyToStrip(src)) return true;
  const windows = windowsAround(
    src,
    /(?:getElementById\(\s*["'][^"']*dirty[^"']*["']\s*\)|#dirty\b|\.id\s*=\s*["'][^"']*dirty)/gi,
    250,
    250,
  );
  return windows.some((w) => new RegExp(STRIP_ID, "i").test(w));
}

function dirtyUsesAccent(src) {
  if (!/\bdirty\b/i.test(src) || !/--accent/.test(src)) return false;
  return (
    /#dirty[\s\S]{0,240}var\(--accent\)/.test(src) ||
    /var\(--accent\)[\s\S]{0,240}#dirty/.test(src) ||
    /dirty[\s\S]{0,200}--accent/.test(src) ||
    /--accent[\s\S]{0,200}dirty/.test(src)
  );
}

function dirtyDoubledInEditorChrome(src) {
  const chrome = taggedById(src, "editor-chrome");
  if (!chrome) return false;
  if (!dirtyInMarkup(chrome.inner) && !dirtyInMarkup(chrome.full)) return false;
  if (movesDirtyToStrip(src) && hasDirtyOnStrip(src) && !dirtyInMarkup(stripMarkup(src))) {
    return false;
  }
  if (hasDirtyOnStrip(src) && dirtyInMarkup(stripMarkup(src)) && dirtyInMarkup(chrome.inner)) {
    return true;
  }
  return true;
}

function hasWordCountId(src) {
  return idsMatching(src, WORD_ID).length > 0;
}

function countsWords(src) {
  return (
    /\.split\(\s*\/\\s\+\//.test(src) ||
    /\.match\(\s*\/(?:\\S\+|\\w\+|\[\\S\]\+)(?:\\b)?\/g\s*\)/.test(src) ||
    /\b(?:countWords|wordCount|count_words|wordsIn)\s*\(/.test(src)
  );
}

function writesWordCount(src) {
  const windows = windowsAround(src, /(?:textContent|innerText)\s*=/g, 220, 220);
  return windows.some((w) => /word/i.test(w));
}

function hasWordCountOnStrip(src) {
  if (!hasStripIdent(src)) return false;
  const markup = stripMarkup(src);
  const inStrip =
    new RegExp(WORD_ID, "i").test(markup) ||
    /\bwords?\b/i.test(markup);
  if (!hasWordCountId(src) && !inStrip) return false;
  return countsWords(src) && writesWordCount(src);
}

function extraWidgetsOnStrip(src) {
  const markup = stripMarkup(src);
  if (!markup) return false;
  if (/<(?:select|button|input|textarea|iframe)\b/i.test(markup)) return true;
  if (new RegExp(THEME_ID, "i").test(markup)) return true;
  if (/\bid=["'](?:save|find|find-query|open-folder|explorer-sort)["']/i.test(markup)) {
    return true;
  }
  return false;
}

function themeSelectorsInChrome(src) {
  const editorChrome = taggedById(src, "editor-chrome");
  const previewChrome = taggedById(src, "preview-chrome");
  const editor =
    (editorChrome && /id=["']editor[-_]?theme["']/i.test(editorChrome.full)) ||
    /id=["']editor[-_]?theme["']/i.test(src);
  const preview =
    (previewChrome && /id=["']preview[-_]?theme["']/i.test(previewChrome.full)) ||
    /id=["']preview[-_]?theme["']/i.test(src);
  return editor && preview;
}

function themeSelectorsOnStrip(src) {
  const markup = stripMarkup(src);
  if (!markup) return false;
  return new RegExp(THEME_ID, "i").test(markup) || /<select\b/i.test(markup);
}

test("24px bottom status strip exists", () => {
  const src = loadSources();
  assert.ok(
    has24pxBottomStatusStrip(src),
    "missing 24px bottom status strip",
  );
});

test("status strip shows relative path for a dirty open file", () => {
  const src = loadSources();
  assert.ok(
    hasRelativePathOnStrip(src),
    "missing relative path on the status strip",
  );
});

test("status strip shows dirty indicator using --accent, not doubled in editor-chrome", () => {
  const src = loadSources();
  assert.ok(
    hasDirtyOnStrip(src),
    "missing dirty indicator on the status strip",
  );
  assert.ok(
    dirtyUsesAccent(src),
    "dirty must use --accent",
  );
  assert.equal(
    dirtyDoubledInEditorChrome(src),
    false,
    "dirty must live on the strip, not doubled in editor-chrome",
  );
});

test("status strip shows word count", () => {
  const src = loadSources();
  assert.ok(
    hasWordCountOnStrip(src),
    "missing word count on the status strip",
  );
});

test("status strip has path, dirty, and word count, and nothing else (no extra widgets)", () => {
  const src = loadSources();
  assert.ok(
    hasStripIdent(src),
    "missing status strip (relative path, dirty, word count, and nothing else)",
  );
  assert.ok(
    hasRelativePathOnStrip(src),
    "missing relative path on the status strip",
  );
  assert.ok(
    hasDirtyOnStrip(src),
    "missing dirty indicator on the status strip",
  );
  assert.ok(
    hasWordCountOnStrip(src),
    "missing word count on the status strip",
  );
  assert.equal(
    extraWidgetsOnStrip(src),
    false,
    "status strip must not have extra widgets",
  );
});

test("theme selectors stay in chrome, not on the strip", () => {
  const src = loadSources();
  assert.ok(
    themeSelectorsInChrome(src),
    "theme selectors must stay in chrome",
  );
  assert.equal(
    themeSelectorsOnStrip(src),
    false,
    "theme selectors must not be on the status strip",
  );
});
