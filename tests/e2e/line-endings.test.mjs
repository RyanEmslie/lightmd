import assert from "node:assert/strict";
import { test } from "node:test";
import { launchApp } from "./helpers/app.mjs";

test("editing a CRLF file with a BOM in CodeMirror saves CRLF, the BOM and the trailing newline", async () => {
  const app = await launchApp({ files: { "win.md": "﻿# Title\r\n\r\nbody\r\n" }, autosaveDelay: 100 });
  try {
    await app.openFolder();
    await app.openFile("win.md");
    assert.equal(await app.isDirty(), false, "opening a CRLF file is not an edit");
    await app.type("more\n");
    const write = await app.waitForWrite("win.md");
    assert.equal(write.contents, "﻿# Title\r\n\r\nbody\r\nmore\r\n");
    assert.deepEqual(app.errors, []);
  } finally {
    await app.close();
  }
});
