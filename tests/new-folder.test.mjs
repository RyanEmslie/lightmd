import assert from "node:assert/strict";
import { test } from "node:test";
import { bootApp } from "./helpers/app.mjs";

test("New Folder control exists", () => {
  const rt = bootApp();
  try {
    assert.equal(rt.el("new-folder").tagName, "BUTTON");
    assert.equal(typeof rt.win.lightmdNewFolder, "function");
  } finally {
    rt.cleanup();
  }
});

test("newFolder invokes create_workspace_folder with the prompted name", async () => {
  const rt = bootApp({
    files: new Map([["a.md", "A"]]),
    promptResult: "notes",
  });
  try {
    await rt.win.lightmdOpenFolder(rt.folderPath);
    await rt.win.lightmdNewFolder();
    const create = rt.invokes.find((i) => i.cmd === "create_workspace_folder");
    assert.ok(create, "newFolder must invoke create_workspace_folder");
    assert.equal(create.args.path, rt.folderPath);
    assert.equal(create.args.relative, "notes");
    assert.ok(rt.folders.includes("notes"));
  } finally {
    rt.cleanup();
  }
});

test("newFolder does not invoke create for empty, slash, or parent-relative names", async () => {
  for (const name of ["", "../escape", "a/b", "C:\\\\windows"]) {
    const rt = bootApp({
      files: new Map([["a.md", "A"]]),
      promptResult: name,
    });
    try {
      await rt.win.lightmdOpenFolder(rt.folderPath);
      rt.invokes.length = 0;
      await rt.win.lightmdNewFolder();
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
