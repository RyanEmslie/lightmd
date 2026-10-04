import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, test } from "node:test";
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

const { autosave } = await import(pathToFileURL(join(srcDir, "autosave.js")).href);
const { preview } = await import(pathToFileURL(join(srcDir, "preview.js")).href);
const { findOptions } = await import(pathToFileURL(join(srcDir, "find.js")).href);

// These live in shared modules, so put them back to their defaults.
beforeEach(() => {
  Object.assign(autosave, { enabled: true, delay: 1000 });
  preview.live = true;
  Object.assign(findOptions, { caseSensitive: false, wholeWord: false });
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

const SETTINGS_KEY = "lightmd.settings";

function change(doc, id, value) {
  const el = doc.getElementById(id);
  if (typeof value === "boolean") el.checked = value;
  else el.value = String(value);
  fire(el, "change");
}

test("changing a setting saves it to lightmd.settings", async () => {
  const { doc, storage } = await bootSettings();
  change(doc, "editor-font-size", 18);
  change(doc, "editor-line-height", 1.6);
  change(doc, "preview-font-size", 20);
  change(doc, "preview-line-height", 1.8);
  change(doc, "settings-autosave", "off");
  change(doc, "settings-autosave-delay", 2500);
  change(doc, "settings-find-case", true);
  change(doc, "settings-find-whole-word", true);
  change(doc, "settings-live-preview", false);
  change(doc, "show-extensions", false);
  const stored = JSON.parse(storage.getItem(SETTINGS_KEY));
  assert.ok(stored, "a change must write lightmd.settings");
  assert.equal(stored.editorFontSize, 18);
  assert.equal(stored.editorLineHeight, 1.6);
  assert.equal(stored.previewFontSize, 20);
  assert.equal(stored.previewLineHeight, 1.8);
  assert.equal(stored.autosave, false);
  assert.equal(stored.autosaveDelay, 2500);
  assert.equal(stored.findCaseSensitive, true);
  assert.equal(stored.findWholeWord, true);
  assert.equal(stored.livePreview, false);
  assert.equal(stored.showExtensions, false);
});

const SAVED = {
  editorFontSize: 17,
  editorLineHeight: 1.7,
  previewFontSize: 19,
  previewLineHeight: 1.9,
  tabSize: 2,
  wrap: false,
  lineNumbers: true,
  activeLine: true,
  softTabs: false,
  frontmatter: false,
  livePreview: false,
  syncScroll: false,
  autosave: false,
  autosaveDelay: 3000,
  findCaseSensitive: true,
  findWholeWord: true,
  showExtensions: false,
};

function seeded(value) {
  const storage = memoryStorage();
  storage.setItem(SETTINGS_KEY, typeof value === "string" ? value : JSON.stringify(value));
  return storage;
}

test("saved settings are applied when settings.js loads, before the editor mounts", async () => {
  const { mod, doc } = await bootSettings({ storage: seeded(SAVED) });
  assert.deepEqual(
    {
      fontSize: mod.editorDefaults.fontSize,
      lineHeight: mod.editorDefaults.lineHeight,
      tabSize: mod.editorDefaults.tabSize,
      lineWrapping: mod.editorDefaults.lineWrapping,
      lineNumbers: mod.editorDefaults.lineNumbers,
      highlightActiveLine: mod.editorDefaults.highlightActiveLine,
      softTabs: mod.editorDefaults.softTabs,
      frontmatter: mod.editorDefaults.frontmatter,
    },
    {
      fontSize: 17,
      lineHeight: 1.7,
      tabSize: 2,
      lineWrapping: false,
      lineNumbers: true,
      highlightActiveLine: true,
      softTabs: false,
      frontmatter: false,
    },
    "editorDefaults feed the editor's initial extensions",
  );
  assert.deepEqual({ ...mod.previewDefaults }, { fontSize: 19, lineHeight: 1.9, syncScroll: false });
  assert.deepEqual({ ...autosave }, { enabled: false, delay: 3000 });
  assert.equal(preview.live, false);
  assert.deepEqual({ ...findOptions }, { caseSensitive: true, wholeWord: true });

  assert.equal(doc.getElementById("editor-font-size").value, "17", "controls show the restored values");
  assert.equal(doc.getElementById("settings-tab-size").value, "2");
  assert.equal(doc.getElementById("show-line-numbers").checked, true);
  assert.equal(doc.getElementById("settings-autosave").value, "off");
  assert.equal(doc.getElementById("settings-autosave-delay").value, "3000");
  assert.equal(doc.getElementById("settings-live-preview").checked, false);
  assert.equal(doc.getElementById("show-extensions").checked, false, "the explorer reads this checkbox");
  assert.equal(doc.getElementById("preview-body").style.fontSize, "19px", "the preview font applies");
});

for (const [name, value] of [
  [
    "out-of-range and mistyped values",
    {
      editorFontSize: 400,
      editorLineHeight: -1,
      previewFontSize: "big",
      previewLineHeight: null,
      tabSize: 2.5,
      wrap: "no",
      lineNumbers: 1,
      autosave: "off",
      autosaveDelay: 0,
      findCaseSensitive: "true",
      showExtensions: {},
    },
  ],
  ["text that is not JSON", "{oops"],
  ["a JSON array", [1, 2, 3]],
]) {
  test(`saved settings with ${name} fall back to the defaults`, async () => {
    const { mod, doc } = await bootSettings({ storage: seeded(value) });
    assert.equal(mod.editorDefaults.fontSize, 14);
    assert.equal(mod.editorDefaults.lineHeight, 1.45);
    assert.equal(mod.editorDefaults.tabSize, 4);
    assert.equal(mod.editorDefaults.lineWrapping, true);
    assert.equal(mod.editorDefaults.lineNumbers, false);
    assert.deepEqual({ ...mod.previewDefaults }, { fontSize: 16, lineHeight: 1.55, syncScroll: true });
    assert.deepEqual({ ...autosave }, { enabled: true, delay: 1000 });
    assert.equal(findOptions.caseSensitive, false);
    assert.equal(doc.getElementById("show-extensions").checked, true);
  });
}
