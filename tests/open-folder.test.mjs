import assert from "node:assert/strict";
import { test } from "node:test";
import { bootApp } from "./helpers/app.mjs";
import { loadHtml } from "./helpers/source.mjs";

test("the explorer's Open Folder button picks a folder and lists it", async () => {
  const rt = bootApp({ files: { "a.md": "A", "notes/b.md": "B" } });
  try {
    const button = rt.el("open-folder");
    assert.ok(button, "missing #open-folder in src/index.html");
    assert.equal(button.tagName, "BUTTON");
    assert.ok(rt.el("explorer-toolbar").contains(button), "#open-folder sits in the explorer toolbar");

    await rt.clickAndAwait(button);

    const pick = rt.dialogs.find((d) => d.kind === "open");
    assert.ok(pick, "Open Folder must show the folder picker");
    assert.equal(pick.options.directory, true, "the picker must choose a folder, not a file");
    assert.equal(rt.win.lightmdWorkspace.path, rt.folderPath, "the picked folder becomes the workspace");
    const list = rt.el("file-list");
    assert.ok(list.querySelector('li[data-path="a.md"]'), "the folder's files must be listed");
    assert.ok(list.querySelector('li[data-path="notes"][data-dir="true"]'), "sub-folders must be listed");
  } finally {
    rt.cleanup();
  }
});

test("no file rename or delete controls; New Folder is allowed", () => {
  const html = loadHtml();
  const forbidden = (verb) =>
    new RegExp(
      `<button\\b[^>]*>[^<]*\\b${verb}\\b[^<]*</button>` +
        `|\\bid=["']${verb}["']` +
        `|aria-label=["'][^"']*\\b${verb}\\b[^"']*["']`,
      "i",
    );
  for (const verb of ["rename", "delete"]) {
    assert.equal(
      forbidden(verb).test(html),
      false,
      `must not expose a ${verb} control`,
    );
  }
  assert.match(
    html,
    /\bid=["']new-folder["']/,
    "New Folder is allowed (create folder, not create/rename/delete files)",
  );
});
