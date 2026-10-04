import assert from "node:assert/strict";
import { test } from "node:test";
import { EditorState } from "@codemirror/state";
import { getSearchQuery, openSearchPanel, searchPanelOpen } from "@codemirror/search";
import * as find from "../src/find.js";

const { findExtension, findOptions, runFind } = find;

const LINE = "the quick brown fox jumps over the lazy dog\n";

// A view-shaped object: CodeMirror state transitions without the DOM.
function fakeView(doc, visibleRanges) {
  const view = {
    state: EditorState.create({ doc, extensions: [findExtension] }),
    visibleRanges: visibleRanges ?? [{ from: 0, to: doc.length }],
    dispatches: 0,
    dispatch(spec) {
      view.dispatches += 1;
      view.state = view.state.update(spec).state;
    },
  };
  return view;
}

function marks(decorations) {
  const out = [];
  decorations.between(0, Number.MAX_SAFE_INTEGER, (from, to) => {
    out.push([from, to]);
  });
  return out;
}

function occurrences(text, needle, from, to) {
  const out = [];
  for (let i = text.indexOf(needle, from); i !== -1 && i + needle.length <= to; i = text.indexOf(needle, i + needle.length)) {
    out.push([i, i + needle.length]);
  }
  return out;
}

test("workspace-search highlights cover only the visible ranges", () => {
  assert.equal(typeof find.findDecorations, "function", "find.js must export findDecorations(view)");
  const doc = LINE.repeat(Math.ceil(1048576 / LINE.length));
  const view = fakeView(doc, [
    { from: 0, to: 2000 },
    { from: 500_000, to: 501_000 },
  ]);
  runFind(view, "fox");
  const got = marks(find.findDecorations(view));
  const expected = [...occurrences(doc, "fox", 0, 2003), ...occurrences(doc, "fox", 499_997, 501_003)];
  assert.deepEqual(got, expected, "only matches in (or straddling) the visible ranges are marked");
});

test("a match straddling the edge of the visible range is still marked", () => {
  const doc = `${"x".repeat(98)}needle${"x".repeat(100)}`;
  const view = fakeView(doc, [{ from: 0, to: 100 }]);
  runFind(view, "needle");
  assert.deepEqual(marks(find.findDecorations(view)), [[98, 104]]);
});

test("the number of highlight marks is capped", () => {
  assert.ok(Number.isInteger(find.FIND_MARK_CAP) && find.FIND_MARK_CAP > 0, "find.js must export FIND_MARK_CAP");
  const doc = "a ".repeat(find.FIND_MARK_CAP * 3);
  const view = fakeView(doc);
  runFind(view, "a");
  assert.equal(marks(find.findDecorations(view)).length, find.FIND_MARK_CAP);
});

test("clearFindHighlight removes the highlight, and does nothing when there is none", () => {
  assert.equal(typeof find.clearFindHighlight, "function", "find.js must export clearFindHighlight(view)");
  const view = fakeView(LINE.repeat(10));
  runFind(view, "fox");
  assert.ok(marks(find.findDecorations(view)).length > 0);
  find.clearFindHighlight(view);
  assert.deepEqual(marks(find.findDecorations(view)), []);
  const before = view.dispatches;
  find.clearFindHighlight(view);
  assert.equal(view.dispatches, before, "no transaction when nothing is highlighted");
});

test("changing findOptions notifies subscribers, so the editor can follow Settings", () => {
  assert.equal(typeof find.onFindOptionsChange, "function", "find.js must export onFindOptionsChange(fn)");
  const seen = [];
  const off = find.onFindOptionsChange((options) => {
    seen.push({ caseSensitive: options.caseSensitive, wholeWord: options.wholeWord });
  });
  try {
    findOptions.caseSensitive = true;
    findOptions.caseSensitive = true; // unchanged: no second call
    findOptions.wholeWord = true;
    assert.deepEqual(seen, [
      { caseSensitive: true, wholeWord: false },
      { caseSensitive: true, wholeWord: true },
    ]);
    off();
    findOptions.wholeWord = false;
    assert.equal(seen.length, 2, "an unsubscribed listener is not called");
  } finally {
    off();
    findOptions.caseSensitive = false;
    findOptions.wholeWord = false;
  }
  assert.deepEqual({ ...findOptions }, { caseSensitive: false, wholeWord: false }, "findOptions still spreads like plain data");
});

test("applyFindOptionsToSearch puts the Settings options on CodeMirror's open search panel", () => {
  assert.equal(typeof find.applyFindOptionsToSearch, "function", "find.js must export applyFindOptionsToSearch(view)");
  const view = fakeView("Foo foo FOO");
  find.applyFindOptionsToSearch(view, { caseSensitive: true, wholeWord: true });
  assert.equal(searchPanelOpen(view.state), false, "a closed panel is left alone");

  openSearchPanel(view);
  assert.equal(searchPanelOpen(view.state), true);
  assert.equal(getSearchQuery(view.state).caseSensitive, false, "precondition: CodeMirror's default");
  find.applyFindOptionsToSearch(view, { caseSensitive: true, wholeWord: true });
  const query = getSearchQuery(view.state);
  assert.equal(query.caseSensitive, true);
  assert.equal(query.wholeWord, true);
  assert.equal(query.literal, false, "other query fields are kept");

  const before = view.dispatches;
  find.applyFindOptionsToSearch(view, { caseSensitive: true, wholeWord: true });
  assert.equal(view.dispatches, before, "no transaction when the query already matches");
});
