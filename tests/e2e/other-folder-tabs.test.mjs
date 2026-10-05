// After a Save As into another folder the explorer shows that folder, while
// older tabs still belong to the first one. Everything a tab shows or opens
// must use the tab's own folder.
import { test } from "node:test";
import assert from "node:assert/strict";
import { launchApp } from "./helpers/app.mjs";

const A = "/tmp/lightmd-e2e";
const B = "/tmp/other-folder";

// Opens A/a.md, then saves a new note into B, which switches the explorer to B.
async function tabFromFirstFolder(extraB = {}) {
  const app = await launchApp({
    files: {
      "a.md": "# A\n\n![pic](img.png)\n\n[other](notes/other.md)\n\nalpha\n",
      "img.png": "PNGDATA",
      "notes/other.md": "# Other in A\n",
    },
    workspaces: { [B]: { files: extraB } },
    dialog: { save: `${B}/new.md` },
  });
  await app.openFolder();
  await app.openFile("a.md");
  await app.page.click("#new-note");
  await app.type("draft");
  await app.page.evaluate(() => window.lightmdSaveAs());
  await app.waitFor(() => app.page.evaluate((b) => window.lightmdWorkspace.path === b, B));
  await app.clickTab("a.md");
  await app.page.evaluate(() => window.lightmdEditor.flushPreview());
  await app.settle();
  return app;
}

test("an older tab's preview loads images from its own folder", async () => {
  const app = await tabFromFirstFolder();
  try {
    await app.waitFor(() =>
      app.page.evaluate(() => (document.querySelector("#preview-body img")?.getAttribute("src") || "").startsWith("data:image/png")),
    );
    assert.deepEqual(app.errors, []);
  } finally {
    await app.close();
  }
});

test("a relative link in an older tab opens the file in that tab's folder", async () => {
  const app = await tabFromFirstFolder();
  try {
    await app.page.click('#preview-body a[href="notes/other.md"]');
    await app.waitFor(async () => (await app.editorText()).includes("Other in A"));
    assert.deepEqual(app.errors, []);
  } finally {
    await app.close();
  }
});

test("workspace search doesn't put an older tab's text into the shown folder", async () => {
  const app = await tabFromFirstFolder({ "a.md": "beta only\n" });
  try {
    await app.page.fill("#find-workspace-query", "alpha");
    await app.page.press("#find-workspace-query", "Enter");
    await app.waitFor(() =>
      app.page.evaluate(() => /results$/.test(document.getElementById("find-workspace-status").textContent)),
    );
    const hits = await app.page.$$eval("#find-workspace-results li", (items) => items.length);
    assert.equal(hits, 0, `${B}/a.md doesn't contain "alpha"`);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.close();
  }
});

test("a folder that can't be opened isn't saved as the last folder", async () => {
  const app = await launchApp({
    files: { "a.md": "# A\n" },
    storage: {
      "lightmd.recentFolders": ["/tmp/gone", A],
      "lightmd.session": { restore: false },
    },
  });
  try {
    await app.waitFor(() => app.page.isVisible("#recent-empty"));
    await app.page.click('#recent-empty button[data-folder="/tmp/gone"]');
    await app.waitFor(() =>
      app.page.evaluate(() => !JSON.parse(localStorage.getItem("lightmd.recentFolders")).includes("/tmp/gone")),
    );
    const state = await app.page.evaluate(() => ({
      last: (JSON.parse(localStorage.getItem("lightmd.session") || "{}").lastFolder) || null,
      explorer: window.lightmdWorkspace.path || null,
    }));
    assert.deepEqual(state, { last: null, explorer: null });
    assert.equal(await app.page.isVisible("#recent-empty"), true, "no folder is open, so Recent stays offered");
  } finally {
    await app.close();
  }
});
