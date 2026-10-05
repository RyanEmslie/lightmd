import assert from "node:assert/strict";
import { test } from "node:test";
import { bootApp } from "./helpers/app.mjs";

test("New Folder control exists in the explorer toolbar and opens the name dialog", async () => {
  const rt = bootApp({ files: { "a.md": "A" } });
  try {
    const button = rt.el("new-folder");
    assert.ok(button, "missing #new-folder in src/index.html");
    assert.equal(button.tagName, "BUTTON");
    assert.ok(rt.el("explorer-toolbar").contains(button), "#new-folder sits in the explorer toolbar");
    assert.equal(typeof rt.win.lightmdNewFolder, "function");

    await rt.win.lightmdOpenFolder(rt.folderPath);
    assert.equal(rt.el("name-dialog").hidden, true, "precondition: name dialog starts hidden");
    button.click();
    assert.equal(rt.el("name-dialog").hidden, false, "clicking New Folder opens the name dialog");
    await rt.answerNameDialog(null);
    assert.equal(rt.el("name-dialog").hidden, true, "Cancel closes the name dialog");
  } finally {
    rt.cleanup();
  }
});

test("newFolder invokes create_workspace_folder with the name typed in the dialog", async () => {
  const rt = bootApp({ files: { "a.md": "A" } });
  try {
    await rt.win.lightmdOpenFolder(rt.folderPath);
    const done = rt.win.lightmdNewFolder();
    await rt.answerNameDialog("notes");
    await done;
    const create = rt.invokes.find((i) => i.cmd === "create_workspace_folder");
    assert.ok(create, "newFolder must invoke create_workspace_folder");
    assert.equal(create.args.path, rt.folderPath);
    assert.equal(create.args.relative, "notes");
    assert.ok(rt.folders.includes("notes"), "the folder must exist in the workspace");
    const row = rt.el("file-list").querySelector('li[data-path="notes"]');
    assert.ok(row, "the explorer must reload and list the new folder");
    assert.equal(row.dataset.dir, "true");
  } finally {
    rt.cleanup();
  }
});

test("newFolder does not invoke create for empty, slash, or parent-relative names", async () => {
  for (const name of ["", "../escape", "a/b", "C:\\\\windows"]) {
    const rt = bootApp({ files: { "a.md": "A" } });
    try {
      await rt.win.lightmdOpenFolder(rt.folderPath);
      rt.invokes.length = 0;
      const done = rt.win.lightmdNewFolder();
      await rt.answerNameDialog(name);
      await done;
      assert.equal(
        rt.invokes.some((i) => i.cmd === "create_workspace_folder"),
        false,
        `must not create a folder named ${JSON.stringify(name)}`,
      );
    } finally {
      rt.cleanup();
    }
  }
});
