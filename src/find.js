import { SearchQuery } from "@codemirror/search";
import { RangeSetBuilder, StateEffect, StateField } from "@codemirror/state";
import { Decoration, ViewPlugin } from "@codemirror/view";

export const findOptions = {
  caseSensitive: false,
  wholeWord: false,
};

function makeQuery(needle, options = findOptions) {
  return new SearchQuery({
    search: needle == null ? "" : String(needle),
    caseSensitive: !!options.caseSensitive,
    wholeWord: !!options.wholeWord,
    literal: true,
  });
}

export function findInBuffer(text, needle, options = findOptions) {
  const query = makeQuery(needle, options);
  if (!query.valid) return [];
  const hits = [];
  const cursor = query.getCursor(text == null ? "" : String(text));
  while (!cursor.next().done) {
    hits.push({ from: cursor.value.from, to: cursor.value.to });
    if (hits.length > 10_000) break;
  }
  return hits;
}

const WORKSPACE_HIT_CAP = 500;
const WORKSPACE_FILE_CAP = 1024 * 1024;

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

function lineAt(text, from) {
  let line = 0;
  const end = Math.max(0, Math.min(from, text.length));
  for (let i = 0; i < end; i++) {
    if (text.charCodeAt(i) === 10) line++;
  }
  return line;
}

function previewAt(text, from, to) {
  let start = Math.max(0, from);
  while (start > 0 && text.charCodeAt(start - 1) !== 10) start--;
  let end = Math.max(start, to);
  while (end < text.length && text.charCodeAt(end) !== 10) end++;
  return text.slice(start, end).trim();
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
    const ranges = findInBuffer(file.text, args.query, args.opts);
    for (const range of ranges) {
      if (hits.length >= WORKSPACE_HIT_CAP) break;
      hits.push({
        relative: file.relative,
        line: lineAt(file.text, range.from),
        from: range.from,
        to: range.to,
        preview: previewAt(file.text, range.from, range.to),
      });
    }
  }
  return hits;
}

export async function searchWorkspace({
  root,
  needle,
  options = findOptions,
  invoke,
  fileCap = WORKSPACE_FILE_CAP,
  yieldToUi,
  shouldAbort,
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
  const files = [];
  for (const entry of entries) {
    if (shouldAbort?.()) return [];
    if (!entry || entry.is_dir) continue;
    const relative = workspaceRelative(entry);
    if (!relative || !listedWorkspaceName(relative)) continue;
    if (typeof yieldToUi === "function") await yieldToUi();
    if (shouldAbort?.()) return [];
    try {
      const text = await invoke("read_workspace_file", { path: root, relative });
      if (
        typeof text === "string" &&
        text.length <= fileCap &&
        !text.includes("\0")
      ) {
        files.push({ relative, text });
      }
    } catch {
      // skip unreadable files
    }
  }
  return findInWorkspace(files, needle, options) || [];
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
  const from = hit.from ?? hit.start ?? hit.index;
  const to = hit.to ?? hit.end;
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

function highlight(query, state, add) {
  if (!query.valid) return;
  const cursor = query.getCursor(state);
  while (!cursor.next().done) {
    add(cursor.value.from, cursor.value.to);
  }
}

function decorationsFor(view) {
  const query = view.state.field(findQueryField);
  if (!query.valid) return Decoration.none;
  const builder = new RangeSetBuilder();
  highlight(query, view.state, (from, to) => {
    builder.add(from, to, findMark);
  });
  return builder.finish();
}

const findHighlighter = ViewPlugin.fromClass(
  class {
    constructor(view) {
      this.decorations = decorationsFor(view);
    }
    update(update) {
      if (
        update.docChanged ||
        update.state.field(findQueryField) !==
          update.startState.field(findQueryField)
      ) {
        this.decorations = decorationsFor(update.view);
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
