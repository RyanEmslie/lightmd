import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, test } from "node:test";
import { createDocument, createWindow, memoryStorage } from "./helpers/dom.mjs";
import { srcDir } from "./helpers/source.mjs";

const KEYS = ["document", "window", "localStorage"];
const saved = Object.fromEntries(KEYS.map((key) => [key, globalThis[key]]));

afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete globalThis[key];
    else globalThis[key] = saved[key];
  }
});

// A fresh settings.js bound to the real markup. Its dependencies (palettes,
// autosave, preview, find, layout) are shared across the tests in this file.
async function bootSettings({ storage = memoryStorage() } = {}) {
  const doc = createDocument();
  const win = createWindow(doc, { storage });
  globalThis.document = doc;
  globalThis.window = win;
  globalThis.localStorage = storage;
  const href = pathToFileURL(join(srcDir, "settings.js")).href;
  const mod = await import(`${href}?settings-behaviour=${Date.now()}-${Math.random()}`);
  return { mod, doc, storage };
}

function fire(el, type) {
  el.dispatchEvent(new Event(type, { bubbles: true }));
}

test("the Settings search shows the sidebar entries of matching sections and hides the rest", async () => {
  const { doc } = await bootSettings();
  const search = doc.getElementById("settings-search");
  search.value = "tab size";
  fire(search, "input");
  const shown = [...doc.querySelectorAll("[data-settings-target]")]
    .filter((item) => !item.hidden)
    .map((item) => item.getAttribute("data-settings-target"));
  assert.deepEqual(shown, ["editor"], "only the Editor entry matches 'tab size'");

  search.value = "";
  fire(search, "input");
  const all = [...doc.querySelectorAll("[data-settings-target]")].filter((item) => !item.hidden);
  assert.equal(all.length, 6, "clearing the search shows every entry again");
});

test("a legacy theme alias selects the theme it resolves to", async () => {
  const { doc } = await bootSettings();
  const { setTheme, theme } = await import(pathToFileURL(join(srcDir, "palettes.js")).href);
  setTheme("Dark");
  assert.equal(theme.name, "Codex Dark", "precondition: 'Dark' resolves to Codex Dark");
  assert.equal(doc.getElementById("settings-theme").value, "Codex Dark", "the theme dropdown must not go blank");
  const pressed = [...doc.querySelectorAll('[data-theme-name][aria-pressed="true"]')].map((card) =>
    card.getAttribute("data-theme-name"),
  );
  assert.deepEqual(pressed, ["Codex Dark"], "the matching theme card must be pressed");
  setTheme("Tokyo Night");
});
