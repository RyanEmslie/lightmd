import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { test } from "node:test";
import { bootApp } from "./helpers/app.mjs";
import { srcDir } from "./helpers/source.mjs";

// The Rust navigation guard cancels any web URL in the main window (it never
// opens a browser), so Settings > About must open its links itself.

const rt = bootApp();
await import(pathToFileURL(join(srcDir, "settings.js")).href);

test("Settings > About links open in the system browser, not in the app window", async (t) => {
  t.after(() => rt.cleanup());
  const links = [...rt.el("settings-about").querySelectorAll("a[href]")];
  const hrefs = links.map((a) => a.getAttribute("href"));
  assert.deepEqual(hrefs, [
    "https://github.com/RyanEmslie/lightmd",
    "https://github.com/RyanEmslie/lightmd/blob/main/LICENSE",
  ]);
  for (const link of links) {
    const navigated = link.click();
    assert.equal(navigated, false, `${link.getAttribute("href")} must not navigate the webview`);
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(rt.backend.opened, hrefs, "each link goes to opener.openUrl");
});
