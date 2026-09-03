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
