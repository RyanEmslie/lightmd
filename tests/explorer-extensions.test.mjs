import assert from "node:assert/strict";
import { test } from "node:test";
import { bootApp } from "./helpers/app.mjs";

function fileRows(rt) {
  return rt.el("file-list").children.filter((li) => li.dataset.dir !== "true");
}

function rowPaths(rt) {
  return fileRows(rt).map((li) => li.dataset.path);
}

function rowLabels(rt) {
  return fileRows(rt).map((li) => {
    const span = (li.children || []).find((c) => c.tagName === "SPAN");
    return span ? String(span.textContent || "") : "";
  });
}

function bootWithFiles() {
  return bootApp({ files: { "a.md": "A", "b.md": "B" } });
}

test("Settings > Workspace has a show-extensions checkbox, on by default", () => {
  const rt = bootWithFiles();
  try {
    const toggle = rt.el("show-extensions");
    assert.ok(toggle, "missing #show-extensions in src/index.html");
    assert.equal(toggle.tagName, "INPUT");
    assert.equal(toggle.type, "checkbox");
    assert.equal(toggle.checked, true, "extensions show by default");
    assert.ok(
      rt.el("settings-workspace").contains(toggle),
      "the toggle must live in Settings > Workspace",
    );
  } finally {
    rt.cleanup();
  }
});

test("hiding extensions changes displayed names but data-path/open path still includes the extension", async () => {
  const rt = bootWithFiles();
  try {
    await rt.win.lightmdOpenFolder(rt.folderPath);
    assert.deepEqual(rowLabels(rt), ["a.md", "b.md"]);
    rt.el("show-extensions").click();
    assert.deepEqual(rowLabels(rt), ["a", "b"]);
    assert.deepEqual(rowPaths(rt), ["a.md", "b.md"]);
    const label = fileRows(rt)[0].querySelector("span");
    await rt.clickAndAwait(label);
    assert.equal(rt.win.lightmdWorkspace.relative, "a.md", "clicking the row opens the real path");
    assert.equal(rt.el("editor-buffer").value, "A");
  } finally {
    rt.cleanup();
  }
});
