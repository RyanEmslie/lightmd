import assert from "node:assert/strict";
import { test } from "node:test";
import { bootApp } from "./helpers/app.mjs";
import { loadSourceText } from "./helpers/source.mjs";

const FILE = "note.md";
const BODY = "# Note\n\noriginal\n";

test("Save is available as lightmdSave", () => {
  const rt = bootApp();
  try {
    assert.equal(typeof rt.win.lightmdSave, "function");
  } finally {
    rt.cleanup();
  }
});

test("dirty indicator is an accent dirty dot using --accent, not decoration", () => {
  const src = loadSourceText();
  assert.match(src, /#dirty\b|\bid=["']dirty["']/);
  assert.match(src, /--accent/);
});

test("Save writes the editor buffer and clears dirty", async () => {
  const rt = bootApp({ files: new Map([[FILE, BODY]]) });
  try {
    await rt.win.lightmdOpenFolder(rt.folderPath);
    await rt.win.lightmdOpenFile(FILE);
    rt.el("editor-buffer").value = "edited buffer\n";
    rt.win.lightmdSetDirty(true);
    assert.equal(rt.el("dirty").hidden, false, "precondition: file is dirty");

    await rt.win.lightmdSave();

    const write = rt.writes.find(
      (w) => w.cmd === "write_workspace_file" && w.relative === FILE,
    );
    assert.ok(write, "Save must invoke write_workspace_file");
    assert.equal(write.contents, "edited buffer\n");
    assert.equal(rt.el("dirty").hidden, true, "Save must clear the dirty indicator");
  } finally {
    rt.cleanup();
  }
});
