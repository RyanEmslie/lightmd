import assert from "node:assert/strict";
import { test } from "node:test";
import { launchApp } from "./helpers/app.mjs";

// Each open file has its own CodeMirror state: loading a file is not an
// undoable edit, and undo never reaches into another file's history.

const A = "# A\n\nalpha\n";
const B = "# B\n\nbravo\n";
const QUIET_MS = 400; // well past the 100ms autosave delay
// CodeMirror joins edits made within 500ms into one undo step; pause like a
// person would between steps so each one is its own step.
const BETWEEN_STEPS_MS = 600;

function writesOf(app, relative) {
  return app.writes.filter((w) => w.relative === relative);
}

test("undo after opening a second file leaves that file alone, on screen and on disk", async () => {
  const app = await launchApp({ files: { "a.md": A, "b.md": B }, autosaveDelay: 100 });
  try {
    await app.openFolder();
    await app.openFile("a.md");
    await app.page.waitForTimeout(BETWEEN_STEPS_MS);
    await app.openFile("b.md");
    await app.page.waitForTimeout(BETWEEN_STEPS_MS);
    await app.undo();
    await app.undo();
    await app.page.waitForTimeout(QUIET_MS);
    assert.equal(await app.editorText(), B, "Cmd+Z must not bring back a.md's text in b.md");
    assert.equal(app.files.get("b.md"), B, "b.md on disk must be unchanged");
    assert.deepEqual(writesOf(app, "b.md"), [], "nothing may be autosaved into b.md");
    assert.equal(await app.isDirty(), false, "b.md must stay clean");
    assert.deepEqual(app.errors, []);
  } finally {
    await app.close();
  }
});

test("undo in the only open file does not empty it", async () => {
  const app = await launchApp({ files: { "a.md": A }, autosaveDelay: 100 });
  try {
    await app.openFolder();
    await app.openFile("a.md");
    await app.undo();
    await app.page.waitForTimeout(QUIET_MS);
    assert.equal(await app.editorText(), A);
    assert.equal(app.files.get("a.md"), A);
    assert.deepEqual(app.writes, []);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.close();
  }
});

test("each tab keeps its own undo history across tab switches", async () => {
  const app = await launchApp({ files: { "a.md": A, "b.md": B }, autosaveDelay: 100 });
  try {
    await app.openFolder();
    await app.openFile("a.md");
    await app.page.waitForTimeout(BETWEEN_STEPS_MS);
    await app.type("typed in a");
    await app.page.waitForTimeout(BETWEEN_STEPS_MS);
    await app.openFile("b.md");
    await app.page.waitForTimeout(BETWEEN_STEPS_MS);
    await app.clickTab("a.md");
    await app.page.waitForTimeout(BETWEEN_STEPS_MS);
    assert.equal(await app.editorText(), `${A}typed in a`, "a.md keeps its edit");
    await app.undo();
    assert.equal(await app.editorText(), A, "Cmd+Z undoes a.md's own typing");
    await app.waitForWrite("a.md", { contents: A });
    assert.equal(app.files.get("b.md"), B);
    assert.deepEqual(writesOf(app, "b.md"), []);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.close();
  }
});

test("a setting changed while a tab is in the background applies when it comes back", async () => {
  const app = await launchApp({ files: { "a.md": A, "b.md": B } });
  try {
    await app.openFolder();
    await app.openFile("a.md");
    await app.openFile("b.md");
    await app.page.evaluate(() => {
      const box = document.getElementById("show-line-numbers");
      box.checked = true;
      box.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await app.clickTab("a.md");
    assert.equal(await app.editorText(), A);
    assert.equal(
      await app.page.locator("#editor-view .cm-lineNumbers").count(),
      1,
      "line numbers turned on while b.md was active must show for a.md",
    );
    assert.deepEqual(app.errors, []);
  } finally {
    await app.close();
  }
});
