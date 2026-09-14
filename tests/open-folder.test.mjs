import assert from "node:assert/strict";
import { test } from "node:test";
import { bootApp } from "./helpers/app.mjs";
import { loadHtml } from "./helpers/source.mjs";

test("explorer has an Open Folder control (button or id)", () => {
  const rt = bootApp();
  try {
    assert.equal(rt.el("open-folder").tagName, "BUTTON");
  } finally {
    rt.cleanup();
  }
});

test("no file rename or delete controls; New Folder is allowed", () => {
  const html = loadHtml();
  const forbidden = (verb) =>
    new RegExp(
      `<button\\b[^>]*>[^<]*\\b${verb}\\b[^<]*</button>` +
        `|\\bid=["']${verb}["']` +
        `|aria-label=["'][^"']*\\b${verb}\\b[^"']*["']`,
      "i",
    );
  for (const verb of ["rename", "delete"]) {
    assert.equal(
      forbidden(verb).test(html),
      false,
      `must not expose a ${verb} control`,
    );
  }
  assert.match(
    html,
    /\bid=["']new-folder["']/,
    "New Folder is allowed (create folder, not create/rename/delete files)",
  );
});
