import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const licensePath = join(root, "LICENSE");

function hasSpdxMit(text) {
  return /SPDX-License-Identifier:\s*MIT\b/i.test(text);
}

function hasStandardMitTitleAndGrant(text) {
  const title = /\bMIT License\b/i.test(text);
  const grant =
    /Permission is hereby granted, free of charge/i.test(text) &&
    /without restriction/i.test(text);
  return title && grant;
}

function namesClearlyBotsAsCopyrightHolder(text) {
  return String(text)
    .split(/\r?\n/)
    .some((line) => /copyright/i.test(line) && /clearly-bots/i.test(line));
}

test("LICENSE exists at repo root with SPDX MIT and Copyright (c) 2026 Ryan Emslie", () => {
  assert.equal(
    existsSync(licensePath),
    true,
    "LICENSE must exist at repo root",
  );
  const text = readFileSync(licensePath, "utf8");
  assert.ok(
    hasSpdxMit(text) || hasStandardMitTitleAndGrant(text),
    "LICENSE must contain SPDX-License-Identifier: MIT or the standard MIT title and permission grant",
  );
  assert.match(
    text,
    /Copyright\s*\(c\)\s*2026\s+Ryan Emslie/,
    "LICENSE must contain Copyright (c) 2026 Ryan Emslie",
  );
  assert.equal(
    namesClearlyBotsAsCopyrightHolder(text),
    false,
    "LICENSE must not name clearly-bots as copyright holder",
  );
});
