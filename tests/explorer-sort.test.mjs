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
