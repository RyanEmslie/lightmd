// The logo inside the app: welcome screen, explorer header, About panel and
// the empty-preview watermark.
import { test } from "node:test";
import assert from "node:assert/strict";
import { launchApp } from "./helpers/app.mjs";

const visible = (app, sel) => app.page.isVisible(sel);

test("with nothing open, the editor shows the welcome screen with the logo", async () => {
  const app = await launchApp({ files: { "a.md": "# A\n" }, storage: { "lightmd.session": { restore: false } } });
  try {
    await app.waitFor(() => visible(app, "#welcome"));
    assert.ok(await visible(app, "#welcome svg use[href='#lightmd-glow']"));
    assert.match(await app.page.textContent("#welcome"), /LightMD/);
    await app.page.click("#welcome-open");
    await app.waitFor(() => visible(app, '#file-list li[data-path="a.md"]'));
    assert.match(await app.page.textContent("#welcome-hint"), /pick a file/i, "with a folder open it suggests a file");
    await app.openFile("a.md");
    assert.equal(await visible(app, "#welcome"), false, "an open file replaces the welcome screen");
    assert.deepEqual(app.errors, []);
  } finally {
    await app.close();
  }
});

test("the explorer header shows the logo and name", async () => {
  const app = await launchApp();
  try {
    assert.ok(await visible(app, "#brand svg"));
    assert.equal((await app.page.textContent("#brand")).trim(), "LightMD");
  } finally {
    await app.close();
  }
});

test("Settings > About shows the app icon and a changelog link", async () => {
  const app = await launchApp();
  try {
    await app.page.click("#settings-open");
    await app.page.click('[data-settings-target="about"]');
    assert.ok(await visible(app, "#settings-about svg use[href='#lightmd-mark']"));
    const href = await app.page.getAttribute("#settings-about a:text-is('Changelog')", "href");
    assert.equal(href, "https://github.com/RyanEmslie/lightmd/blob/main/CHANGELOG.md");
  } finally {
    await app.close();
  }
});

test("an empty preview shows a faint logo until there's something to show", async () => {
  const app = await launchApp({ files: { "a.md": "" } });
  try {
    await app.openFolder();
    await app.openFile("a.md");
    await app.page.evaluate(() => window.lightmdEditor.flushPreview());
    await app.waitFor(() => visible(app, "#preview-empty"));
    await app.type("# Hello");
    await app.page.evaluate(() => window.lightmdEditor.flushPreview());
    await app.waitFor(async () => !(await visible(app, "#preview-empty")));
    assert.deepEqual(app.errors, []);
  } finally {
    await app.close();
  }
});
