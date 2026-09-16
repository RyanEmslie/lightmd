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

async function dispatchChange(el) {
  el.dispatchEvent({
    type: "change",
    target: el,
    preventDefault() {},
    stopPropagation() {},
  });
  const results = el._lastDispatch || [];
  await Promise.all(results.filter((r) => r && typeof r.then === "function"));
}

function bootSorted() {
  return bootApp({
    files: new Map([
      ["a.md", "A"],
      ["b.md", "B"],
    ]),
    modifiedOrder: ["b.md", "a.md"],
  });
}

test("explorer has a sort control (name vs modified)", async () => {
  const rt = bootSorted();
  try {
    const sort = rt.el("explorer-sort");
    assert.equal(sort.tagName, "SELECT");
    await rt.win.lightmdOpenFolder(rt.folderPath);
    assert.deepEqual(rowPaths(rt), ["a.md", "b.md"]);
    sort.value = "modified";
    await dispatchChange(sort);
    assert.deepEqual(
      rowPaths(rt),
      ["b.md", "a.md"],
      "sort=modified must list newer b.md first",
    );
    const listed = rt.invokes.filter((i) => i.cmd === "list_workspace");
    assert.ok(
      listed.some((i) => i.args.sort === "modified"),
      "list_workspace must be invoked with sort=modified",
    );
  } finally {
    rt.cleanup();
  }
});

test("Settings has a show extensions toggle", () => {
  const rt = bootSorted();
  try {
    assert.equal(rt.el("show-extensions").tagName, "INPUT");
    assert.equal(rt.el("show-extensions").checked, true);
  } finally {
    rt.cleanup();
  }
});

test("hiding extensions changes displayed names but data-path/open path still includes the extension", async () => {
  const rt = bootSorted();
  try {
    await rt.win.lightmdOpenFolder(rt.folderPath);
    assert.deepEqual(rowLabels(rt), ["a.md", "b.md"]);
    const toggle = rt.el("show-extensions");
    toggle.checked = false;
    await dispatchChange(toggle);
    assert.deepEqual(rowLabels(rt), ["a", "b"]);
    assert.deepEqual(rowPaths(rt), ["a.md", "b.md"]);
    await rt.win.lightmdOpenFile("a.md");
    assert.equal(rt.win.lightmdWorkspace.relative, "a.md");
  } finally {
    rt.cleanup();
  }
});
