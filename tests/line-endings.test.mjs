import assert from "node:assert/strict";
import { test } from "node:test";
import { bootApp } from "./helpers/app.mjs";

// CodeMirror hands the app "\n" line breaks whatever the file used. Saving
// writes the file's own (dominant) line ending back, and keeps a BOM and the
// trailing newline.

const FOLDER = "/tmp/lightmd-eol";

function boot(files, options = {}) {
  const rt = bootApp({ folderPath: FOLDER, files, ...options });
  const enabled = rt.autosave.enabled;
  rt.autosave.enabled = false;
  const cleanup = rt.cleanup;
  rt.cleanup = () => {
    rt.autosave.enabled = enabled;
    cleanup();
  };
  return rt;
}

// What CodeMirror's doc.toString() gives the app after an edit.
function typeLikeCodeMirror(rt, text) {
  const buffer = rt.el("editor-buffer");
  buffer.value = text.replace(/\r\n?/g, "\n");
  buffer.dispatchEvent({ type: "input", bubbles: true });
}

async function editAndSave(rt, relative, text) {
  await rt.win.lightmdOpenFolder(FOLDER);
  await rt.win.lightmdOpenFile(relative);
  typeLikeCodeMirror(rt, text);
  await rt.win.lightmdSave();
  return rt.files.get(relative);
}

test("a CRLF file is saved with CRLF", async () => {
  const rt = boot({ "win.md": "# Title\r\n\r\nbody\r\n" });
  try {
    assert.equal(await editAndSave(rt, "win.md", "# Title\n\nbody\nmore\n"), "# Title\r\n\r\nbody\r\nmore\r\n");
  } finally {
    rt.cleanup();
  }
});

test("an LF file stays LF", async () => {
  const rt = boot({ "unix.md": "a\nb\n" });
  try {
    assert.equal(await editAndSave(rt, "unix.md", "a\nb\nc\n"), "a\nb\nc\n");
  } finally {
    rt.cleanup();
  }
});

test("a mixed file is saved with its dominant ending", async () => {
  const rt = boot({ "mixed.md": "1\r\n2\r\n3\n4\r\n" });
  try {
    assert.equal(await editAndSave(rt, "mixed.md", "1\n2\n3\n4\n5\n"), "1\r\n2\r\n3\r\n4\r\n5\r\n");
  } finally {
    rt.cleanup();
  }
});

test("a BOM and a missing or present trailing newline survive", async () => {
  const rt = boot({ "bom.md": "﻿first\r\nlast", "tail.md": "﻿x\r\n" });
  try {
    assert.equal(await editAndSave(rt, "bom.md", "﻿first\nlast!"), "﻿first\r\nlast!");
    assert.equal(await editAndSave(rt, "tail.md", "﻿x\ny\n"), "﻿x\r\ny\r\n");
  } finally {
    rt.cleanup();
  }
});

test("autosave and flush-on-switch keep CRLF too", async () => {
  const rt = boot({ "win.md": "a\r\n", "other.md": "o\n" });
  try {
    rt.autosave.enabled = true;
    await rt.win.lightmdOpenFolder(FOLDER);
    await rt.win.lightmdOpenFile("win.md");
    typeLikeCodeMirror(rt, "a\nb\n");
    await rt.win.lightmdOpenFile("other.md");
    assert.equal(rt.files.get("win.md"), "a\r\nb\r\n");
  } finally {
    rt.cleanup();
  }
});

test("Save As of a CRLF file keeps CRLF", async () => {
  const rt = boot({ "win.md": "a\r\n" }, { dialog: { save: `${FOLDER}/copy.md` } });
  try {
    await rt.win.lightmdOpenFolder(FOLDER);
    await rt.win.lightmdOpenFile("win.md");
    typeLikeCodeMirror(rt, "a\nb\n");
    assert.equal(await rt.win.lightmdSaveAs(), true);
    assert.equal(rt.files.get("copy.md"), "a\r\nb\r\n");
  } finally {
    rt.cleanup();
  }
});
