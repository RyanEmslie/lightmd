import assert from "node:assert/strict";
import { test } from "node:test";
import { palettes, theme, setTheme, applyTheme } from "../src/palettes.js";

const PALETTE_NAMES = Object.keys(palettes);

const TOKENS = [
  "--bg",
  "--bg-elevated",
  "--fg",
  "--fg-muted",
  "--border",
  "--accent",
  "--danger",
  "--h1",
  "--h2",
  "--h3",
  "--link",
  "--code",
];

function mockStyle() {
  const vars = Object.create(null);
  return {
    setProperty(name, value) {
      vars[name] = String(value);
    },
    getPropertyValue(name) {
      return Object.hasOwn(vars, name) ? vars[name] : "";
    },
  };
}

function mockEl(id) {
  return { id, style: mockStyle() };
}

function installDocument() {
  const byId = new Map();
  for (const id of ["explorer", "editor", "preview"]) {
    byId.set(id, mockEl(id));
  }
  const doc = {
    documentElement: mockEl("html"),
    body: mockEl("body"),
    getElementById(id) {
      return byId.get(String(id)) ?? null;
    },
  };
  globalThis.document = doc;
  return doc;
}

function cssVar(el, name) {
  return el?.style?.getPropertyValue?.(name) || "";
}

function withThemeFixture(run) {
  const prevDoc = globalThis.document;
  const prevName = theme.name;
  const doc = installDocument();
  try {
    return run(doc);
  } finally {
    theme.name = prevName;
    globalThis.document = prevDoc;
  }
}

test("shipped palettes have CSS tokens", () => {
  assert.ok(PALETTE_NAMES.includes("Tokyo Night"));
  assert.ok(PALETTE_NAMES.length >= 26);
  for (const name of PALETTE_NAMES) {
    const palette = palettes[name];
    assert.ok(palette, `missing palette ${name}`);
    for (const token of TOKENS) {
      assert.match(
        String(palette[token] || ""),
        /^#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i,
        `${name} ${token} must be a hex color`,
      );
    }
  }
});

test("default theme is Tokyo Night", () => {
  assert.equal(theme.name, "Tokyo Night");
});

test("setTheme paints CSS variables on documentElement only", () => {
  assert.equal(typeof setTheme, "function");
  withThemeFixture((doc) => {
    setTheme("Monokai");
    applyTheme();
    assert.equal(theme.name, "Monokai");
    assert.equal(cssVar(doc.documentElement, "--bg"), palettes.Monokai["--bg"]);
    assert.equal(cssVar(doc.documentElement, "--h1"), palettes.Monokai["--h1"]);
    assert.equal(cssVar(doc.documentElement, "--accent"), palettes.Monokai["--accent"]);
    assert.equal(
      cssVar(doc.body, "--bg"),
      "",
      "body must inherit from :root, not get its own inline tokens",
    );
    assert.equal(cssVar(doc.getElementById("editor"), "--bg"), "");
    assert.equal(cssVar(doc.getElementById("preview"), "--bg"), "");
    assert.equal(cssVar(doc.getElementById("explorer"), "--bg"), "");
  });
});

test("setTheme ignores unknown palette names", () => {
  withThemeFixture(() => {
    setTheme("Tokyo Night");
    setTheme("Not A Palette");
    assert.equal(theme.name, "Tokyo Night");
  });
});
