import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(root, "src");
const fixturePath = join(root, "tests", "fixtures", "find.md");
const NEEDLE = "zxq9-lightmd-unique-find-needle";

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

function loadFixture() {
  assert.equal(existsSync(fixturePath), true, "tests/fixtures/find.md must exist");
  const text = readFileSync(fixturePath, "utf8");
  assert.match(
    text,
    new RegExp(NEEDLE),
    "fixture must contain the unique needle",
  );
  const matches = text.split(NEEDLE).length - 1;
  assert.equal(matches, 1, "fixture needle must be unique in the current file");
  return text;
}

function firstOf(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function asFindConfig(value) {
  if (!value || typeof value !== "object") return null;
  if (value.find && typeof value.find === "object") {
    const nested = asFindConfig(value.find);
    if (nested) return nested;
  }
  if (value.search && typeof value.search === "object") {
    const nested = asFindConfig(value.search);
    if (nested) return nested;
  }
  const caseSensitive = firstOf(
    value.caseSensitive,
    value.case,
    value.matchCase,
    typeof value.ignoreCase === "boolean" ? !value.ignoreCase : undefined,
  );
  const wholeWord = firstOf(
    value.wholeWord,
    value.whole,
    value.wholeWords,
    value.matchWholeWord,
  );
  const similar = firstOf(value.regexp, value.regex, value.literal);
  if (
    typeof caseSensitive === "boolean" ||
    typeof wholeWord === "boolean" ||
    typeof similar === "boolean"
  ) {
    return {
      caseSensitive: typeof caseSensitive === "boolean" ? caseSensitive : false,
      wholeWord: typeof wholeWord === "boolean" ? wholeWord : false,
    };
  }
  return null;
}

function pickFindConfig(mod) {
  if (!mod || typeof mod !== "object") return null;
  const names = [
    "find",
    "search",
    "findConfig",
    "searchConfig",
    "findOptions",
    "searchOptions",
    "config",
    "settings",
    "defaults",
    "default",
  ];
  for (const name of names) {
    const cfg = asFindConfig(mod[name]);
    if (cfg) return cfg;
  }
  const caseSensitive = firstOf(
    mod.FIND_CASE_SENSITIVE,
    mod.findCaseSensitive,
    mod.caseSensitive,
  );
  const wholeWord = firstOf(
    mod.FIND_WHOLE_WORD,
    mod.findWholeWord,
    mod.wholeWord,
  );
  if (typeof caseSensitive === "boolean" || typeof wholeWord === "boolean") {
    return {
      caseSensitive: typeof caseSensitive === "boolean" ? caseSensitive : false,
      wholeWord: typeof wholeWord === "boolean" ? wholeWord : false,
    };
  }
  return asFindConfig(mod);
}

function configFromSource(src) {
  if (!/\b(?:find|search|SearchQuery)\b/i.test(src)) return null;

  const caseMatch =
    src.match(
      /\b(?:caseSensitive|matchCase|case)\s*:\s*(true|false)\b/,
    ) ||
    src.match(/\bignoreCase\s*:\s*(true|false)\b/) ||
    src.match(
      /(?:find|search)[-_]?case(?:[-_]?sensitive)?["'][^>]*\bchecked\b/i,
    );
  const wholeMatch =
    src.match(/\b(?:wholeWord|wholeWords|whole)\s*:\s*(true|false)\b/) ||
    src.match(/find[-_]?whole[-_]?word["'][^>]*\bchecked\b/i);
  const similarMatch = src.match(/\b(?:regexp|regex|literal)\s*:\s*(true|false)\b/);

  const hasCaseControl =
    /id=["'][^"']*(?:find[-_]?case|case[-_]?sensitive|match[-_]?case)[^"']*["']/i.test(
      src,
    );
  const hasWholeControl =
    /id=["'][^"']*(?:find[-_]?whole[-_]?word|whole[-_]?word)[^"']*["']/i.test(
      src,
    );

  if (
    !caseMatch &&
    !wholeMatch &&
    !similarMatch &&
    !hasCaseControl &&
    !hasWholeControl
  ) {
    return null;
  }

  let caseSensitive = false;
  if (caseMatch) {
    if (/\bignoreCase\b/.test(String(caseMatch[0]))) {
      caseSensitive = caseMatch[1] !== "true";
    } else if (caseMatch[1] === "true" || caseMatch[1] === "false") {
      caseSensitive = caseMatch[1] === "true";
    }
  }

  return {
    caseSensitive,
    wholeWord: wholeMatch ? wholeMatch[1] === "true" : false,
  };
}

async function loadFindConfig() {
  const names = [
    "config.js",
    "config.mjs",
    "settings.js",
    "settings.mjs",
    "find.js",
    "find.mjs",
    "search.js",
    "search.mjs",
    "editor.js",
  ];
  for (const name of names) {
    const p = join(srcDir, name);
    if (!existsSync(p)) continue;
    try {
      const mod = await import(pathToFileURL(p).href);
      const cfg = pickFindConfig(mod);
      if (cfg) return cfg;
    } catch {
      // Missing export or unusable in Node: keep looking, then scan source.
    }
  }
  return configFromSource(loadSources());
}

function hasFindAction(src) {
  if (
    /\bid=["']find(?:[-_](?:in[-_]?file|button|action|query|panel|bar|input|field))?["']/i.test(
      src,
    )
  ) {
    return true;
  }
  if (
    /\.id\s*=\s*["']find(?:[-_](?:in[-_]?file|button|action|query|panel|bar|input|field))?["']/i.test(
      src,
    )
  ) {
    return true;
  }
  if (
    /getElementById\(\s*["']find(?:[-_](?:in[-_]?file|button|action|query|panel|bar|input|field))?["']\s*\)/.test(
      src,
    )
  ) {
    return true;
  }
  if (/<button\b[^>]*>[\s\S]{0,80}?\bfind\b[\s\S]{0,80}?<\/button>/i.test(src)) {
    return true;
  }
  if (
    /createElement\(\s*["']button["']\)[\s\S]{0,200}?(?:textContent|innerText|innerHTML)\s*=\s*["'][^"']*\bfind\b/i.test(
      src,
    )
  ) {
    return true;
  }
  return false;
}

function hasEditorHighlight(src) {
  if (/\bSearchQuery\b/.test(src)) return true;
  if (/\b(?:set|get)SearchQuery\b/.test(src)) return true;
  if (/\bhighlight(?:Selection)?Matches\b/.test(src)) return true;
  if (/\bopenSearchPanel\b/.test(src)) return true;
  if (/from\s+["']@codemirror\/search["']/.test(src)) return true;
  if (/\bcm-searchMatch/.test(src)) return true;
  if (/\bDecoration\.mark\b/.test(src) && /\b(?:find|search)\b/i.test(src)) {
    return true;
  }
  if (/<mark\b/i.test(src) && /\b(?:find|search)\b/i.test(src)) return true;
  return false;
}

function extractFunction(src, name) {
  const re = new RegExp(
    String.raw`(?:export\s+)?(?:async\s+)?function\s+${name}\s*\(`,
  );
  const m = re.exec(src);
  if (!m) return "";
  const brace = src.indexOf("{", m.index);
  if (brace < 0) return "";
  let depth = 0;
  for (let i = brace; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return src.slice(m.index, i + 1);
    }
  }
  return src.slice(m.index, m.index + 800);
}

function findSearchesWorkspace(src) {
  // Find in file (#find / #find-query / findInBuffer / runFind) stays buffer-local.
  // Workspace search is a separate API (findInWorkspace).
  const bodies = ["findInBuffer", "runFind", "applyFind"]
    .map((name) => extractFunction(src, name))
    .join("\n");
  if (
    /invoke\(\s*["'](?:search_workspace|search_files|find_in_files|grep_workspace|list_workspace)["']/.test(
      bodies,
    )
  ) {
    return true;
  }
  if (
    /\b(?:searchWorkspace|findInWorkspace|findInFiles|workspaceSearch|search_workspace)\b/.test(
      bodies,
    )
  ) {
    return true;
  }
  return false;
}

function pickFind(mod) {
  const names = [
    "findInBuffer",
    "find_in_buffer",
    "findInDoc",
    "findInFile",
    "highlightFind",
    "runFind",
    "searchBuffer",
    "searchDoc",
  ];
  for (const name of names) {
    if (typeof mod[name] === "function") return mod[name];
  }
  if (typeof mod.default === "function") return mod.default;
  if (mod.default && typeof mod.default === "object") {
    for (const name of names) {
      if (typeof mod.default[name] === "function") return mod.default[name];
    }
  }
  return null;
}

async function loadFind() {
  const names = [
    "find.js",
    "find.mjs",
    "search.js",
    "search.mjs",
    "editor.js",
  ];
  for (const name of names) {
    const p = join(srcDir, name);
    if (!existsSync(p)) continue;
    try {
      const mod = await import(pathToFileURL(p).href);
      const fn = pickFind(mod);
      if (fn) return fn;
    } catch {
      // Missing or unusable module: keep looking.
    }
  }
  return null;
}

function normalizeHits(result, text, needle) {
  if (result == null || result === false) return [];
  if (result === true) {
    const from = text.indexOf(needle);
    return from >= 0 ? [{ from, to: from + needle.length }] : [];
  }
  if (typeof result === "number") {
    return result >= 0 ? [{ from: result, to: result + needle.length }] : [];
  }
  if (typeof result === "string") {
    return result.includes(needle) ? [{ search: result }] : [];
  }
  if (Array.isArray(result)) return result;
  if (typeof result.next === "function") {
    const hits = [];
    for (let step = result.next(); step; step = result.next()) {
      if (step.done) break;
      hits.push(step.value ?? step);
      if (hits.length > 32) break;
    }
    return hits;
  }
  if (Array.isArray(result.matches)) return result.matches;
  if (Array.isArray(result.hits)) return result.hits;
  if (Array.isArray(result.ranges)) return result.ranges;
  return [];
}

function hitCoversNeedle(hit, text, needle) {
  if (hit == null) return false;
  if (typeof hit === "string") return hit.includes(needle);
  if (typeof hit === "number") {
    return text.slice(hit, hit + needle.length) === needle;
  }
  const from = hit.from ?? hit.start ?? hit.index ?? hit[0];
  const to =
    hit.to ??
    hit.end ??
    (typeof from === "number" ? from + needle.length : undefined);
  if (typeof from === "number" && typeof to === "number") {
    return (
      text.slice(from, to).includes(needle) ||
      text.slice(from, from + needle.length) === needle
    );
  }
  if (typeof hit.search === "string") {
    return hit.search === needle || hit.search.includes(needle);
  }
  return false;
}

test("chrome has a Find action (button#find or similar)", () => {
  const src = loadSources();
  assert.ok(
    hasFindAction(src),
    "missing Find action (button#find or similar)",
  );
});

test("default find options exist (testable config: case, whole word, or similar)", async () => {
  const config = await loadFindConfig();
  assert.ok(
    config,
    "missing find options (testable config: case, whole word, or similar)",
  );
  assert.equal(
    typeof config.caseSensitive === "boolean" ||
      typeof config.wholeWord === "boolean",
    true,
    "find options must include case, whole word, or similar",
  );
});

test("Find highlights a unique string in the current buffer only", async () => {
  const text = loadFixture();
  const src = loadSources();
  assert.ok(
    hasEditorHighlight(src),
    "Find must highlight the unique string in the current buffer (SearchQuery / highlight / mark in the editor, not list_workspace)",
  );
  assert.equal(
    findSearchesWorkspace(src),
    false,
    "Find must highlight in the current buffer only, not the whole workspace",
  );

  const finder = await loadFind();
  if (finder) {
    const hits = normalizeHits(finder(text, NEEDLE), text, NEEDLE);
    assert.ok(
      hits.some((hit) => hitCoversNeedle(hit, text, NEEDLE)),
      "Find must highlight the unique needle in the current buffer",
    );
  }
});

test("Find does not search the whole workspace", () => {
  const src = loadSources();
  assert.ok(
    hasFindAction(src) || hasEditorHighlight(src),
    "missing Find in the current file (not workspace search)",
  );
  assert.equal(
    findSearchesWorkspace(src),
    false,
    "Find must not search the whole workspace (not list_workspace)",
  );
});
