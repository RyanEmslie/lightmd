import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, test } from "node:test";
import { createDocument, createWindow, memoryStorage } from "./helpers/dom.mjs";
import { srcDir } from "./helpers/source.mjs";

const PANES = ["explorer", "editor", "preview"];
const saved = {
  document: globalThis.document,
  window: globalThis.window,
  localStorage: globalThis.localStorage,
};

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete globalThis[key];
    else globalThis[key] = value;
  }
});

// A fresh layout.js against the real markup, with `stored` as lightmd.layout.
async function importLayout(stored) {
  const storage = memoryStorage();
  if (stored !== undefined) storage.setItem("lightmd.layout", JSON.stringify(stored));
  const doc = createDocument();
  const win = createWindow(doc, { storage });
  win.innerWidth = 1200;
  globalThis.document = doc;
  globalThis.window = win;
  globalThis.localStorage = storage;
  const href = pathToFileURL(join(srcDir, "layout.js")).href;
  const mod = await import(`${href}?layout-panes=${Date.now()}-${Math.random()}`);
  return { mod, doc, storage };
}

function shownPanes(doc) {
  return PANES.filter((id) => !doc.getElementById(id).hidden);
}

test("collapsing the last open pane is refused, so the window is never blank", async () => {
  const { mod, doc, storage } = await importLayout();
  mod.collapsePane("explorer", true);
  mod.collapsePane("editor", true);
  mod.collapsePane("preview", true);
  assert.equal(mod.getLayout().open.preview, true, "the last open pane stays open");
  assert.deepEqual(shownPanes(doc), ["preview"]);
  const open = JSON.parse(storage.getItem("lightmd.layout")).open;
  assert.ok(PANES.some((id) => open[id]), `a saved layout must keep a pane open (got ${JSON.stringify(open)})`);
});

test("setLayout cannot close every pane", async () => {
  const { mod, doc } = await importLayout();
  mod.setLayout({ explorer: false, editor: false, preview: false });
  assert.ok(shownPanes(doc).length >= 1, "at least one pane must stay visible");
});

for (const [name, stored] of [
  ["open flags", { open: { explorer: false, editor: false, preview: false }, remember: true }],
  ["a legacy collapsed list", { collapsed: ["explorer", "editor", "preview"], remember: true }],
]) {
  test(`a saved layout with every pane closed (${name}) restores visible panes`, async () => {
    const { mod, doc } = await importLayout(stored);
    assert.ok(PANES.some((id) => mod.getLayout().open[id]), "restore must open a pane");
    assert.ok(shownPanes(doc).length >= 1, "restore must show a pane");
  });
}

test("hiding the explorer shows a reopen control that brings it back", async () => {
  const { mod, doc } = await importLayout();
  const reopen = doc.getElementById("explorer-reopen");
  assert.ok(reopen, "#explorer-reopen must exist in src/index.html");
  assert.equal(reopen.hidden, true, "the reopen control is hidden while the explorer is open");
  mod.collapsePane("explorer", true);
  assert.equal(reopen.hidden, false, "the reopen control shows while the explorer is hidden");
  doc.getElementById("explorer-reopen-toggle").click();
  assert.equal(mod.getLayout().open.explorer, true, "the reopen control's sidebar button reopens the explorer");
  assert.equal(doc.getElementById("explorer").hidden, false);
  assert.equal(reopen.hidden, true, "the reopen control hides again once the explorer is back");
});
