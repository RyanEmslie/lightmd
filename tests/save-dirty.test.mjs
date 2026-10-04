import assert from "node:assert/strict";
import { test } from "node:test";
import { bootApp } from "./helpers/app.mjs";

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

test("an edit shows the dirty dot in the status strip and Save hides it", async () => {
  const rt = bootApp({ files: { [FILE]: BODY } });
  try {
    const dot = rt.el("dirty");
    assert.ok(dot, "missing #dirty in src/index.html");
    assert.ok(rt.el("status-strip").contains(dot), "#dirty must sit in the status strip");
    await rt.win.lightmdOpenFolder(rt.folderPath);
    await rt.win.lightmdOpenFile(FILE);
    assert.equal(dot.hidden, true, "a freshly opened file is clean");

    const buffer = rt.el("editor-buffer");
    buffer.value = "edited buffer\n";
    buffer.dispatchEvent({ type: "input", bubbles: true });
    assert.equal(dot.hidden, false, "an edit must show the dirty dot");
    assert.ok(rt.state.scheduleCalls > 0, "an edit must schedule autosave");

    await rt.win.lightmdSave();
    assert.equal(dot.hidden, true, "Save must hide the dirty dot");
    assert.equal(rt.files.get(FILE), "edited buffer\n", "Save must write the edit to the file");
  } finally {
    rt.cleanup();
  }
});

test("Save writes the editor buffer and clears dirty", async () => {
  const rt = bootApp({ files: { [FILE]: BODY } });
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
