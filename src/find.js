import { SearchQuery, getSearchQuery, searchPanelOpen, setSearchQuery } from "@codemirror/search";
import { RangeSetBuilder, StateEffect, StateField, findClusterBreak } from "@codemirror/state";
import { Decoration, ViewPlugin } from "@codemirror/view";

const optionValues = { caseSensitive: false, wholeWord: false };
const optionListeners = new Set();

function setFindOption(name, on) {
  const next = !!on;
  if (optionValues[name] === next) return;
  optionValues[name] = next;
  for (const listener of optionListeners) listener(findOptions);
}

// Settings write these; onFindOptionsChange() listeners (the editor's search
// panel) follow along.
export const findOptions = {
  get caseSensitive() {
    return optionValues.caseSensitive;
  },
  set caseSensitive(on) {
    setFindOption("caseSensitive", on);
  },
  get wholeWord() {
    return optionValues.wholeWord;
  },
  set wholeWord(on) {
    setFindOption("wholeWord", on);
  },
};

export function onFindOptionsChange(listener) {
  optionListeners.add(listener);
  return () => optionListeners.delete(listener);
}

// Cmd+F opens CodeMirror's own search panel; give its query the Settings
// case and whole-word options. A closed panel is synced when it opens.
export function applyFindOptionsToSearch(view, options = findOptions) {
  if (!searchPanelOpen(view.state)) return;
  const current = getSearchQuery(view.state);
  const caseSensitive = !!options.caseSensitive;
  const wholeWord = !!options.wholeWord;
  if (current.caseSensitive === caseSensitive && current.wholeWord === wholeWord) return;
  view.dispatch({
    effects: setSearchQuery.of(
      new SearchQuery({
        search: current.search,
        replace: current.replace,
        literal: current.literal,
        regexp: current.regexp,
        caseSensitive,
        wholeWord,
      }),
    ),
  });
}

function makeQuery(needle, options = findOptions) {
  return new SearchQuery({
    search: needle == null ? "" : String(needle),
    caseSensitive: !!options.caseSensitive,
    wholeWord: !!options.wholeWord,
    literal: true,
  });
}

const BUFFER_HIT_CAP = 10_000;

export function findInBuffer(text, needle, options = findOptions) {
  const query = makeQuery(needle, options);
  if (!query.valid) return [];
  const hits = [];
  const cursor = query.getCursor(text == null ? "" : String(text));
  while (hits.length < BUFFER_HIT_CAP && !cursor.next().done) {
    hits.push({ from: cursor.value.from, to: cursor.value.to });
  }
  return hits;
}

const WORKSPACE_HIT_CAP = 500;
const WORKSPACE_FILE_CAP = 1024 * 1024;
const PREVIEW_BEFORE = 80;
const PREVIEW_AFTER = 160;
const WORD_CHAR = /[\p{Alphabetic}\p{Number}_]/u;

// CodeMirror shows (and counts offsets in) text with \n line breaks only.
function normalizeNewlines(text) {
  return text.indexOf("\r") === -1 ? text : text.replace(/\r\n?/g, "\n");
}

// Same word test as CodeMirror's whole-word search (grapheme clusters).
function isWordChar(ch) {
  return /\S/.test(ch) && WORD_CHAR.test(ch);
}

function isWholeWord(text, from, to) {
  const before = text.slice(findClusterBreak(text, from, false), from);
  const first = text.slice(from, findClusterBreak(text, from));
  const last = text.slice(findClusterBreak(text, to, false), to);
  const after = text.slice(to, findClusterBreak(text, to));
  return (
    (!isWordChar(before) || !isWordChar(first)) &&
    (!isWordChar(after) || !isWordChar(last))
  );
}

// Literal search with indexOf: findInBuffer's matches for case and whole
// word without its per-character cost. Text whose lowercase changes length
// (İ) or depends on context (final Σ) goes through findInBuffer instead.
function findLiteral(text, needle, options, limit) {
  let hay = text;
  let pin = needle;
  if (!options.caseSensitive) {
    hay = text.toLowerCase();
    if (hay.length !== text.length || text.includes("\u03a3")) {
      return findInBuffer(text, needle, options).slice(0, limit);
    }
    pin = needle.toLowerCase();
  }
  const hits = [];
  if (!pin) return hits;
  for (let pos = 0; hits.length < limit; ) {
    const from = hay.indexOf(pin, pos);
    if (from === -1) break;
    const to = from + pin.length;
    if (options.wholeWord && !isWholeWord(text, from, to)) {
      pos = from + 1;
      continue;
    }
    hits.push({ from, to });
    pos = to;
  }
  return hits;
}

// Matches one file's text and appends workspace hits, counting lines in a
// single forward pass.
function collectFileHits(relative, source, needle, options, hits) {
  const text = normalizeNewlines(source);
  const ranges = findLiteral(text, needle, options, WORKSPACE_HIT_CAP - hits.length);
  let line = 0;
  let lineStart = 0;
  let lineEnd = text.indexOf("\n");
  for (const { from, to } of ranges) {
    while (lineEnd !== -1 && lineEnd < from) {
      line += 1;
      lineStart = lineEnd + 1;
      lineEnd = text.indexOf("\n", lineStart);
    }
    const end = lineEnd === -1 ? text.length : lineEnd;
    hits.push({
      relative,
      line,
      from,
      to,
      preview: text
        .slice(Math.max(lineStart, from - PREVIEW_BEFORE), Math.min(end, to + PREVIEW_AFTER))
        .trim(),
    });
  }
}

function listedWorkspaceName(name) {
  return /\.(md|html|htm)$/i.test(String(name || ""));
}

function workspaceRelative(file) {
  if (file == null) return "";
  if (typeof file === "string") return String(file).replaceAll("\\", "/");
  const p =
    file.relative ??
    file.relative_path ??
    file.path ??
    file.file ??
    file.filename;
  return String(p ?? "").replaceAll("\\", "/");
}

function listedWorkspaceFiles(entries) {
  if (typeof entries === "string") return null;
  if (entries == null) return [];
  if (!Array.isArray(entries)) return null;
  const files = [];
  for (const entry of entries) {
    if (!entry || entry.is_dir === true) continue;
    const relative = workspaceRelative(entry);
    if (!relative || !listedWorkspaceName(relative)) continue;
    const text = entry.text ?? entry.contents ?? entry.body;
    if (typeof text !== "string") continue;
    if (text.length > WORKSPACE_FILE_CAP) continue;
    if (text.includes("\0")) continue;
    files.push({ relative, text });
  }
  return files;
}

function workspaceArgs(entriesOrRoot, needle, options) {
  let filesArg = entriesOrRoot;
  let query = needle;
  let opts = options == null ? findOptions : options;
  if (
    entriesOrRoot &&
    typeof entriesOrRoot === "object" &&
    !Array.isArray(entriesOrRoot)
  ) {
    if (entriesOrRoot.needle != null || entriesOrRoot.query != null) {
      query = entriesOrRoot.needle ?? entriesOrRoot.query;
    }
    if (entriesOrRoot.options && typeof entriesOrRoot.options === "object") {
      opts = entriesOrRoot.options;
    } else if (
      typeof entriesOrRoot.caseSensitive === "boolean" ||
      typeof entriesOrRoot.wholeWord === "boolean"
    ) {
      opts = entriesOrRoot;
    }
    if (Array.isArray(entriesOrRoot.files)) filesArg = entriesOrRoot.files;
    else if (Array.isArray(entriesOrRoot.entries)) {
      filesArg = entriesOrRoot.entries;
    } else if (
      typeof entriesOrRoot.root === "string" ||
      typeof entriesOrRoot.path === "string"
    ) {
      filesArg = entriesOrRoot.root ?? entriesOrRoot.path;
    }
  }
  return { filesArg, query, opts };
}

export function findInWorkspace(entriesOrRoot, needle, options = findOptions) {
  const args = workspaceArgs(entriesOrRoot, needle, options);
  if (args.query == null || String(args.query) === "") return [];
  const files = listedWorkspaceFiles(args.filesArg);
  if (files == null) return undefined;
  const hits = [];
  for (const file of files) {
    if (hits.length >= WORKSPACE_HIT_CAP) break;
    collectFileHits(file.relative, file.text, String(args.query), args.opts, hits);
  }
  return hits;
}

// Reads a listed file for searching, or null to skip it. stat_workspace_file
// skips files over the cap without reading them.
async function readForSearch(invoke, root, relative, fileCap) {
  try {
    const stat = await invoke("stat_workspace_file", { path: root, relative });
    if (stat && Number(stat.size) > fileCap) return null;
  } catch {
    // No stat: the length check after reading still applies.
  }
  try {
    return await invoke("read_workspace_file", { path: root, relative });
  } catch {
    return null;
  }
}

function openBufferTexts(root, openBuffers) {
  const texts = new Map();
  for (const buffer of Array.isArray(openBuffers) ? openBuffers : []) {
    if (!buffer || buffer.root !== root || typeof buffer.contents !== "string") continue;
    const relative = workspaceRelative(buffer.relative);
    if (relative) texts.set(relative, buffer.contents);
  }
  return texts;
}

// Files are matched one at a time as they are read, with a yield before
// each, so the UI stays responsive and the hit cap stops further reads.
// openBuffers ([{ root, relative, contents }]) replace those files' disk text.
export async function searchWorkspace({
  root,
  needle,
  options = findOptions,
  invoke,
  fileCap = WORKSPACE_FILE_CAP,
  yieldToUi,
  shouldAbort,
  openBuffers = [],
} = {}) {
  if (needle == null || String(needle) === "") return [];
  if (typeof invoke !== "function" || !root) return [];
  let entries = [];
  try {
    entries = await invoke("list_workspace", { path: root });
  } catch {
    return [];
  }
  if (!Array.isArray(entries)) return [];
  const buffers = openBufferTexts(root, openBuffers);
  const query = String(needle);
  const hits = [];
  for (const entry of entries) {
    if (hits.length >= WORKSPACE_HIT_CAP) break;
    if (shouldAbort?.()) return [];
    if (!entry || entry.is_dir) continue;
    const relative = workspaceRelative(entry);
    if (!relative || !listedWorkspaceName(relative)) continue;
    if (typeof yieldToUi === "function") await yieldToUi();
    if (shouldAbort?.()) return [];
    const text = buffers.has(relative)
      ? buffers.get(relative)
      : await readForSearch(invoke, root, relative, fileCap);
    if (shouldAbort?.()) return [];
    if (typeof text !== "string" || text.length > fileCap || text.includes("\0")) continue;
    collectFileHits(relative, text, query, options, hits);
  }
  return hits;
}

function workspaceHitFrom(hitOrOpts) {
  if (!hitOrOpts || typeof hitOrOpts !== "object") return null;
  if (hitOrOpts.hit && typeof hitOrOpts.hit === "object") return hitOrOpts.hit;
  return hitOrOpts;
}

function workspaceOpenCtx(hitOrOpts, mocks) {
  if (
    hitOrOpts &&
    typeof hitOrOpts === "object" &&
    hitOrOpts.hit &&
    typeof hitOrOpts.hit === "object"
  ) {
    return hitOrOpts;
  }
  return mocks && typeof mocks === "object" ? mocks : {};
}

export async function openWorkspaceHit(hitOrOpts, mocks = {}) {
  const hit = workspaceHitFrom(hitOrOpts);
  const ctx = workspaceOpenCtx(hitOrOpts, mocks);
  if (!hit) return;
  const relative = workspaceRelative(hit);
  const open =
    ctx.applyFile ||
    ctx.openFile ||
    ctx.open ||
    (typeof globalThis.lightmdOpenFile === "function"
      ? globalThis.lightmdOpenFile
      : null);
  if (typeof open === "function" && relative) {
    await open(relative);
  }
  const view =
    ctx.view ||
    (globalThis.lightmdEditor && globalThis.lightmdEditor.view);
  if (!view) return;
  // A hit can be stale (the file changed since the search), so clamp it.
  const docLength = view.state?.doc?.length;
  const clamp = (n) =>
    typeof n === "number" && typeof docLength === "number"
      ? Math.max(0, Math.min(n, docLength))
      : n;
  const from = clamp(hit.from ?? hit.start ?? hit.index);
  const to = clamp(hit.to ?? hit.end);
  let needle = ctx.needle;
  if (
    (needle == null || needle === "") &&
    typeof from === "number" &&
    view.state &&
    view.state.doc &&
    typeof view.state.doc.toString === "function"
  ) {
    const text = view.state.doc.toString();
    const end = typeof to === "number" ? to : from;
    needle = text.slice(from, end);
  }
  const canHighlight =
    view.state &&
    (typeof view.state.field === "function" ||
      (view.state.doc && typeof view.state.doc.iterRange === "function"));
  if (canHighlight && needle) {
    const run = typeof ctx.runFind === "function" ? ctx.runFind : runFind;
    if (typeof run === "function") run(view, needle);
  }
  if (typeof from === "number" && typeof view.dispatch === "function") {
    view.dispatch({
      selection: {
        anchor: from,
        head: typeof to === "number" ? to : from,
      },
      scrollIntoView: true,
    });
  }
}

const findMark = Decoration.mark({ class: "cm-searchMatch" });

export const setFindQuery = StateEffect.define();

const findQueryField = StateField.define({
  create() {
    return makeQuery("");
  },
  update(query, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setFindQuery)) return effect.value;
    }
    return query;
  },
});

export const FIND_MARK_CAP = 1000;

// Workspace-search highlights, built over the visible ranges only and capped,
// so typing in a big document doesn't rescan all of it.
export function findDecorations(view) {
  const query = view.state.field(findQueryField, false);
  if (!query || !query.valid) return Decoration.none;
  const { state } = view;
  const margin = query.search.length;
  const builder = new RangeSetBuilder();
  let count = 0;
  let last = 0;
  for (const range of view.visibleRanges) {
    const from = Math.max(last, range.from - margin);
    const to = Math.min(state.doc.length, range.to + margin);
    if (from >= to) continue;
    const cursor = query.getCursor(state, from, to);
    while (count < FIND_MARK_CAP && !cursor.next().done) {
      builder.add(cursor.value.from, cursor.value.to, findMark);
      last = cursor.value.to;
      count += 1;
    }
    if (count >= FIND_MARK_CAP) break;
  }
  return builder.finish();
}

export function clearFindHighlight(view) {
  const query = view.state.field(findQueryField, false);
  if (!query || !query.valid) return;
  view.dispatch({ effects: setFindQuery.of(makeQuery("")) });
}

const findHighlighter = ViewPlugin.fromClass(
  class {
    constructor(view) {
      this.decorations = findDecorations(view);
    }
    update(update) {
      const query = update.state.field(findQueryField);
      if (
        query !== update.startState.field(findQueryField) ||
        (query.valid && (update.docChanged || update.viewportChanged))
      ) {
        this.decorations = findDecorations(update.view);
      }
    }
  },
  {
    decorations: (plugin) => plugin.decorations,
  },
);

export const findExtension = [findQueryField, findHighlighter];

export function runFind(view, needle, options = findOptions) {
  const query = makeQuery(needle, options);
  const spec = { effects: setFindQuery.of(query) };
  if (query.valid) {
    const cursor = query.getCursor(view.state);
    if (!cursor.next().done) {
      spec.selection = {
        anchor: cursor.value.from,
        head: cursor.value.to,
      };
      spec.scrollIntoView = true;
    }
  }
  view.dispatch(spec);
}
