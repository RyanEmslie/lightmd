import assert from "node:assert/strict";
import { test } from "node:test";
import { EditorState } from "@codemirror/state";
import { findInBuffer, findInWorkspace, openWorkspaceHit, searchWorkspace } from "../src/find.js";
import { createInvoke } from "./helpers/tauri.mjs";

const ROOT = "/tmp/ws-search";

function backendWith(files, extra = {}) {
  return createInvoke({ root: ROOT, files, ...extra });
}

function reads(backend) {
  return backend.invokes.filter((c) => c.cmd === "read_workspace_file").map((c) => c.args.relative);
}

test("findInBuffer stops at 10,000 hits, not 10,001", () => {
  assert.equal(findInBuffer("x".repeat(20_000), "x").length, 10_000);
});

test("CRLF files: line, preview and offsets match the LF text CodeMirror shows", async () => {
  const lines = Array.from({ length: 500 }, (_, i) => `Paragraph number ${i} of the note.`);
  lines[400] = "The TARGET phrase lives here.";
  const crlf = lines.join("\r\n");
  const lf = lines.join("\n");

  const [hit] = findInWorkspace([{ relative: "win.md", text: crlf }], "TARGET");
  assert.equal(hit.line, 400, "a CRLF line must count once");
  assert.equal(hit.preview, "The TARGET phrase lives here.");
  assert.equal(lf.slice(hit.from, hit.to), "TARGET", "offsets index the LF-normalized text");

  const backend = backendWith({ "win.md": crlf });
  const [viaDisk] = await searchWorkspace({ root: ROOT, needle: "TARGET", invoke: backend.invoke });
  assert.deepEqual(
    { line: viaDisk.line, from: viaDisk.from, to: viaDisk.to, preview: viaDisk.preview },
    { line: hit.line, from: hit.from, to: hit.to, preview: hit.preview },
  );
  const cr = findInWorkspace([{ relative: "mac.md", text: lines.join("\r") }], "TARGET")[0];
  assert.equal(cr.line, 400, "a lone CR is a line break too");
});

test("the literal matcher agrees with findInBuffer on case and whole word", () => {
  const texts = [
    "cat concat cat_ cat. Cat CAT caT",
    "Foo foo FOO fOo foobar",
    "aaaa aa a",
    "a😀b😀 😀",
    "İİİ x i İ",
    "ΣΑΣ σας Σ",
    "x_y x-y y_x xy",
    "the end",
  ];
  const needles = ["cat", "foo", "aa", "😀", "x", "i", "σ", "y", "end"];
  const optionSets = [
    { caseSensitive: false, wholeWord: false },
    { caseSensitive: true, wholeWord: false },
    { caseSensitive: false, wholeWord: true },
    { caseSensitive: true, wholeWord: true },
  ];
  for (const text of texts) {
    for (const needle of needles) {
      for (const options of optionSets) {
        const expected = findInBuffer(text, needle, options).map(({ from, to }) => [from, to]);
        const got = findInWorkspace([{ relative: "t.md", text }], needle, options).map((h) => [h.from, h.to]);
        assert.deepEqual(got, expected, `${JSON.stringify(needle)} in ${JSON.stringify(text)} ${JSON.stringify(options)}`);
      }
    }
  }
});

test("line numbers come from one forward pass: 500 hits at the end of a 1 MB file stay fast", () => {
  const filler = "lorem ipsum dolor sit amet\n".repeat(38_000);
  const text = filler + "needle here\n".repeat(500);
  const start = performance.now();
  const hits = findInWorkspace([{ relative: "a.md", text }], "needle");
  const ms = performance.now() - start;
  assert.equal(hits.length, 500);
  assert.equal(hits[0].line, 38_000);
  assert.equal(hits[499].line, 38_499);
  assert.equal(hits[499].preview, "needle here");
  // Rescanning from the start for every hit took about a second here.
  assert.ok(ms < 300, `findInWorkspace took ${ms.toFixed(0)} ms`);
});

test("a hit preview on a huge single line is a window around the match, not the whole line", () => {
  const text = `${"word ".repeat(100_000)}NEEDLE${" tail".repeat(100_000)}`;
  const [hit] = findInWorkspace([{ relative: "long.md", text }], "NEEDLE");
  assert.ok(hit.preview.includes("NEEDLE"));
  assert.ok(hit.preview.length < 400, `preview has ${hit.preview.length} chars`);
});

test("files over the cap are skipped by stat_workspace_file before they are read", async () => {
  const backend = backendWith({ "big.md": `${"x".repeat(200)} NEEDLE`, "small.md": "NEEDLE" });
  const hits = await searchWorkspace({ root: ROOT, needle: "NEEDLE", invoke: backend.invoke, fileCap: 100 });
  assert.deepEqual(hits.map((h) => h.relative), ["small.md"]);
  assert.ok(
    backend.invokes.some((c) => c.cmd === "stat_workspace_file" && c.args.relative === "big.md"),
    "big.md must be stat'ed",
  );
  assert.deepEqual(reads(backend), ["small.md"], "big.md must not be read at all");
});

test("a failed stat still lets the file be read and searched", async () => {
  const backend = backendWith(
    { "a.md": "NEEDLE" },
    {
      onInvoke(cmd) {
        if (cmd === "stat_workspace_file") throw "stat failed";
        return undefined;
      },
    },
  );
  const hits = await searchWorkspace({ root: ROOT, needle: "NEEDLE", invoke: backend.invoke });
  assert.deepEqual(hits.map((h) => h.relative), ["a.md"]);
});

test("each file is matched as it is read: reaching the hit cap stops reading", async () => {
  const backend = backendWith({ "a.md": "hit ".repeat(600), "b.md": "hit", "c.md": "hit" });
  const yields = [];
  const hits = await searchWorkspace({
    root: ROOT,
    needle: "hit",
    invoke: backend.invoke,
    yieldToUi: async () => {
      yields.push(reads(backend).length);
    },
  });
  assert.equal(hits.length, 500, "workspace hits are capped at 500");
  assert.deepEqual(reads(backend), ["a.md"], "b.md and c.md must not be read once the cap is reached");
  assert.deepEqual(yields, [0], "the UI gets a turn before each file");
});

test("the search yields between files and an abort stops further reads", async () => {
  const backend = backendWith({ "a.md": "x", "b.md": "x", "c.md": "x" });
  const yields = [];
  await searchWorkspace({
    root: ROOT,
    needle: "x",
    invoke: backend.invoke,
    yieldToUi: async () => {
      yields.push(reads(backend).length);
    },
  });
  assert.deepEqual(yields, [0, 1, 2], "one yield before each file is read");

  const aborting = backendWith({ "a.md": "x", "b.md": "x", "c.md": "x" });
  const hits = await searchWorkspace({
    root: ROOT,
    needle: "x",
    invoke: aborting.invoke,
    shouldAbort: () => reads(aborting).length >= 1,
  });
  assert.deepEqual(hits, []);
  assert.deepEqual(reads(aborting), ["a.md"]);
});

test("open buffers are searched instead of their stale files on disk", async () => {
  const backend = backendWith({ "a.md": "old text", "b.md": "NEEDLE on disk" });
  const contents = "first line\nnew NEEDLE typed but unsaved";
  const hits = await searchWorkspace({
    root: ROOT,
    needle: "NEEDLE",
    invoke: backend.invoke,
    openBuffers: [
      { root: ROOT, relative: "a.md", contents, dirty: true },
      { root: "/elsewhere", relative: "b.md", contents: "nothing here", dirty: true },
    ],
  });
  assert.deepEqual(hits.map((h) => h.relative), ["a.md", "b.md"]);
  const [a] = hits;
  assert.equal(contents.slice(a.from, a.to), "NEEDLE", "offsets index the unsaved buffer");
  assert.equal(a.line, 1);
  assert.deepEqual(reads(backend), ["b.md"], "a.md comes from its buffer; another root's buffer is ignored");
});

test("binary files are still skipped", async () => {
  const backend = backendWith({ "bin.md": "NEEDLE\0\0", "ok.md": "NEEDLE" });
  const hits = await searchWorkspace({ root: ROOT, needle: "NEEDLE", invoke: backend.invoke });
  assert.deepEqual(hits.map((h) => h.relative), ["ok.md"]);
});

test("openWorkspaceHit clamps a hit beyond the end of the document instead of throwing", async () => {
  let state = EditorState.create({ doc: "short" });
  const view = {
    get state() {
      return state;
    },
    dispatch(spec) {
      state = state.update(spec).state;
    },
  };
  await openWorkspaceHit(
    { relative: "a.md", from: 50, to: 56 },
    { view, applyFile: async () => {}, runFind: () => {}, needle: "x" },
  );
  assert.deepEqual(
    { anchor: state.selection.main.anchor, head: state.selection.main.head },
    { anchor: 5, head: 5 },
  );
});
