import assert from "node:assert/strict";
import { test } from "node:test";
import { launchApp } from "./helpers/app.mjs";

// Preview rendering and find wiring in editor.js, driven in the real bundle.
// Typing is done with CodeMirror transactions where a test counts renders,
// so the count doesn't depend on keystroke timing; window.lightmdEditor
// .flushPreview() runs a debounced render now instead of sleeping for it.

const NO_AUTOSAVE = 600000;

// Counts markdown renders into #preview-body.
async function countRenders(app) {
  await app.page.evaluate(() => {
    const body = document.getElementById("preview-body");
    const insert = Element.prototype.insertAdjacentHTML;
    window.__renders = 0;
    body.insertAdjacentHTML = function (...args) {
      window.__renders += 1;
      return insert.apply(this, args);
    };
  });
}

function renders(app) {
  return app.page.evaluate(() => window.__renders);
}

// Appends text one transaction per character, like keystrokes, and returns
// the render count right after the last one (same task, no timers run).
function typeTransactions(app, text) {
  return app.page.evaluate((chars) => {
    const view = window.lightmdEditor.view;
    for (const ch of chars) {
      view.dispatch({ changes: { from: view.state.doc.length, insert: ch }, userEvent: "input.type" });
    }
    return window.__renders;
  }, text);
}

function flushPreview(app) {
  return app.page.evaluate(() => window.lightmdEditor.flushPreview());
}

function previewText(app) {
  return app.page.evaluate(() => document.getElementById("preview-body").textContent);
}

async function openNote(files, relative, options = {}) {
  const app = await launchApp({ files, autosaveDelay: NO_AUTOSAVE, ...options });
  await app.openFolder();
  await app.openFile(relative);
  return app;
}

test("typing coalesces preview renders into one, after the edits", async () => {
  const app = await openNote({ "note.md": "# Title\n\nstart\n" }, "note.md");
  try {
    await countRenders(app);
    assert.equal(await typeTransactions(app, " abcde"), 0, "no render may run synchronously per keystroke");
    assert.doesNotMatch(await previewText(app), /abcde/, "the preview waits for the edits to settle");
    await flushPreview(app);
    assert.equal(await renders(app), 1, "five keystrokes make one render");
    assert.match(await previewText(app), /start abcde/);
    await flushPreview(app);
    assert.equal(await renders(app), 1, "nothing is left pending after the render");

    // Real keystrokes: the debounce fires on its own once typing stops.
    await app.type("XYZ");
    await app.waitFor(async () => /XYZ/.test(await previewText(app)), {
      message: "the debounced render after real typing",
    });
    assert.deepEqual(app.errors, []);
  } finally {
    await app.close();
  }
});

test("opening a file renders its preview at once, and only once", async () => {
  const app = await openNote(
    { "a.md": "# A\n", "b.md": "# Bee\n\ntext\n", "crlf.md": "# Crlf\r\n\r\nline one\r\nline two\r\n" },
    "a.md",
  );
  try {
    await countRenders(app);
    for (const [relative, heading] of [
      ["b.md", "Bee"],
      ["crlf.md", "Crlf"],
    ]) {
      const seen = await app.page.evaluate(async (rel) => {
        const before = window.__renders;
        await window.lightmdOpenFile(rel);
        return {
          heading: document.querySelector("#preview-body h1")?.textContent,
          renders: window.__renders - before,
        };
      }, relative);
      assert.equal(seen.heading, heading, `${relative} must be in the preview as soon as it opens`);
      assert.equal(seen.renders, 1, `${relative}: the load and the editor change must render once, not twice`);
      const before = await renders(app);
      await flushPreview(app);
      assert.equal(await renders(app), before, `${relative}: no second render may be left pending`);
    }
    assert.deepEqual(app.errors, []);
  } finally {
    await app.close();
  }
});

test("a hidden preview is not rendered while typing, and catches up when shown", async () => {
  const app = await openNote({ "note.md": "# Title\n" }, "note.md");
  try {
    await countRenders(app);
    await app.page.click("#toggle-preview");
    assert.equal(await app.page.evaluate(() => document.getElementById("preview").hidden), true);
    await typeTransactions(app, " hidden-edit");
    await flushPreview(app);
    assert.equal(await renders(app), 0, "a hidden preview must not be rendered");

    await app.page.click("#toggle-preview");
    await app.waitFor(async () => /hidden-edit/.test(await previewText(app)), {
      message: "the preview to catch up when shown",
    });
    assert.equal(await renders(app), 1);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.close();
  }
});

test("typing in an HTML file reloads the viewer once per pause, not per keystroke", async () => {
  const app = await openNote({ "page.html": "<h1>Page</h1>\n" }, "page.html");
  try {
    await app.page.evaluate(() => {
      const frame = document.getElementById("html-viewer");
      const proto = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, "srcdoc");
      window.__srcdocWrites = 0;
      Object.defineProperty(frame, "srcdoc", {
        configurable: true,
        get() {
          return proto.get.call(this);
        },
        set(value) {
          window.__srcdocWrites += 1;
          proto.set.call(this, value);
        },
      });
    });
    await typeTransactions(app, "<p>abcde</p>");
    await flushPreview(app);
    assert.equal(await app.page.evaluate(() => window.__srcdocWrites), 1, "one iframe reload for the burst");
    assert.match(await app.page.evaluate(() => document.getElementById("html-viewer").srcdoc), /abcde/);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.close();
  }
});

test("turning live preview back on refreshes the stale preview", async () => {
  const app = await openNote({ "note.md": "# Title\n" }, "note.md");
  try {
    const setLive = (on) =>
      app.page.evaluate((value) => {
        const box = document.getElementById("settings-live-preview");
        box.checked = value;
        box.dispatchEvent(new Event("change", { bubbles: true }));
      }, on);
    await setLive(false);
    await typeTransactions(app, " offline-edit");
    await flushPreview(app);
    assert.doesNotMatch(await previewText(app), /offline-edit/, "live preview off: the preview waits");
    await setLive(true);
    assert.match(await previewText(app), /offline-edit/, "turning it on must show the current text at once");
    assert.deepEqual(app.errors, []);
  } finally {
    await app.close();
  }
});

test("frontmatter shows in the metadata block, an empty block shows nothing", async () => {
  const app = await openNote({ "fm.md": "﻿---\ntitle: Hello\n---\n# Body\n", "empty.md": "---\n---\n# E\n" }, "fm.md");
  try {
    const block = () =>
      app.page.evaluate(() => {
        const el = document.getElementById("frontmatter");
        return { hidden: el.hidden, text: el.textContent };
      });
    assert.deepEqual(await block(), { hidden: false, text: "titleHello" });
    assert.equal(await app.page.locator("#preview-body h1").textContent(), "Body");
    await app.openFile("empty.md");
    assert.equal((await block()).hidden, true, "an empty frontmatter block has nothing to show");
    assert.equal(await app.page.locator("#preview-body h1").textContent(), "E");
    assert.deepEqual(app.errors, []);
  } finally {
    await app.close();
  }
});

async function runWorkspaceSearch(app, needle) {
  await app.page.fill("#find-workspace-query", needle);
  await app.page.press("#find-workspace-query", "Enter");
  await app.waitFor(
    () => app.page.evaluate(() => /results$/.test(document.getElementById("find-workspace-status").textContent)),
    { message: "the workspace search to finish" },
  );
  return app.page.$$eval("#find-workspace-results li", (items) =>
    items.map((li) => ({ relative: li.dataset.relative, from: Number(li.dataset.from), to: Number(li.dataset.to) })),
  );
}

function searchMarks(app) {
  return app.page.locator(".cm-content .cm-searchMatch").count();
}

test("workspace-search highlights clear when another document loads or the find UI closes", async () => {
  const app = await openNote(
    { "a.md": "alpha needle one\nneedle two\n", "b.md": "other\n" },
    "b.md",
  );
  try {
    const hits = await runWorkspaceSearch(app, "needle");
    assert.equal(hits.length, 2);
    await app.page.click("#find-workspace-results li");
    await app.settle();
    assert.ok((await searchMarks(app)) > 0, "precondition: opening a hit highlights the needle");

    await app.page.evaluate((root) => {
      window.dispatchEvent(new CustomEvent("lightmd:document-loaded", { detail: { root, relative: "a.md" } }));
    }, app.root);
    await app.settle();
    assert.equal(await searchMarks(app), 0, "lightmd:document-loaded must clear the highlight");

    await app.page.click("#find-workspace-results li");
    await app.settle();
    assert.ok((await searchMarks(app)) > 0);
    await app.page.fill("#find-workspace-query", "");
    await app.settle();
    assert.equal(await searchMarks(app), 0, "clearing the workspace query must clear the highlight");

    await runWorkspaceSearch(app, "needle");
    await app.page.click("#find-workspace-results li");
    await app.settle();
    assert.ok((await searchMarks(app)) > 0);
    await app.page.evaluate(() => window.lightmdFind());
    await app.page.locator(".cm-search").waitFor();
    await app.page.press(".cm-search input[name=search]", "Escape");
    await app.settle();
    assert.equal(await app.page.locator(".cm-search").count(), 0, "precondition: Escape closes the panel");
    assert.equal(await searchMarks(app), 0, "closing the search panel must clear the workspace highlight");
    assert.deepEqual(app.errors, []);
  } finally {
    await app.close();
  }
});

test("a workspace change clears stale search results", async () => {
  const app = await openNote({ "a.md": "needle\n" }, "a.md");
  try {
    assert.equal((await runWorkspaceSearch(app, "needle")).length, 1);
    await app.page.evaluate(() => {
      window.dispatchEvent(new CustomEvent("lightmd:workspace-changed", { detail: { root: "/somewhere/else" } }));
    });
    assert.equal(await app.page.locator("#find-workspace-results li").count(), 0);
    assert.equal(await app.page.locator("#find-workspace-status").textContent(), "");
    assert.deepEqual(app.errors, []);
  } finally {
    await app.close();
  }
});

test("workspace search sees unsaved edits and jumps to them", async () => {
  const app = await openNote({ "a.md": "first line\n", "b.md": "nothing\n" }, "a.md");
  try {
    await app.type("typed ZZTOP here");
    const hits = await runWorkspaceSearch(app, "ZZTOP");
    assert.deepEqual(
      hits.map((h) => h.relative),
      ["a.md"],
      "the unsaved buffer must be searched, not the file on disk",
    );
    await app.page.click("#find-workspace-results li");
    await app.settle();
    const selected = await app.page.evaluate(() => {
      const { state } = window.lightmdEditor.view;
      return state.sliceDoc(state.selection.main.from, state.selection.main.to);
    });
    assert.equal(selected, "ZZTOP");
    assert.deepEqual(app.errors, []);
  } finally {
    await app.close();
  }
});

test("Settings case-sensitive and whole-word apply to Cmd+F", async () => {
  const app = await openNote({ "a.md": "Foo foo\n" }, "a.md");
  try {
    const setOption = (id, on) =>
      app.page.evaluate(
        ([elId, value]) => {
          const box = document.getElementById(elId);
          box.checked = value;
          box.dispatchEvent(new Event("change", { bubbles: true }));
        },
        [id, on],
      );
    const panelOptions = () =>
      app.page.evaluate(() => ({
        caseSensitive: document.querySelector(".cm-search input[name=case]").checked,
        wholeWord: document.querySelector(".cm-search input[name=word]").checked,
      }));
    await setOption("settings-find-case", true);
    await setOption("settings-find-whole-word", true);
    await app.page.click(".cm-content");
    await app.page.keyboard.press("ControlOrMeta+f");
    await app.page.locator(".cm-search").waitFor();
    assert.deepEqual(await panelOptions(), { caseSensitive: true, wholeWord: true });

    await setOption("settings-find-case", false);
    assert.deepEqual(await panelOptions(), { caseSensitive: false, wholeWord: true }, "an open panel follows Settings");
    assert.deepEqual(app.errors, []);
  } finally {
    await app.close();
  }
});

test("images load as data: URLs, and re-read from disk when a document loads", async () => {
  const red = [0x89, 0x50, 0x4e, 0x47, 1];
  const blue = [0x89, 0x50, 0x4e, 0x47, 2];
  const app = await openNote({ "docs/note.md": "![pic](<my pic.png>)\n", "docs/my pic.png": { bytes: red } }, "docs/note.md");
  try {
    const src = () => app.page.evaluate(() => document.querySelector("#preview-body img").getAttribute("src"));
    const dataUrl = (bytes) => `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`;
    await app.waitFor(async () => (await src()) === dataUrl(red), { message: "the image to load" });

    app.backend.write(app.root, "docs/my pic.png", { bytes: blue });
    await app.page.evaluate((root) => {
      window.dispatchEvent(new CustomEvent("lightmd:document-loaded", { detail: { root, relative: "docs/note.md" } }));
    }, app.root);
    await app.waitFor(async () => (await src()) === dataUrl(blue), { message: "the changed image to be re-read" });
    assert.deepEqual(app.errors, []);
  } finally {
    await app.close();
  }
});
