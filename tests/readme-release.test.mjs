import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const readmePath = join(root, "README.md");

// v1 ships by clone-and-build on Linux and Mac. Optional Mac clone-and-build is not the ship path.

const CLONE_AND_BUILD = /clone[\s-]+and[\s-]+build/i;
const SHIP = /\bships?\b|\bshipped\b|\bshipping\b/i;

function loadReadme() {
  assert.equal(existsSync(readmePath), true, "README.md must exist");
  return readFileSync(readmePath, "utf8");
}

function sentences(text) {
  return String(text)
    .split(/\n+/)
    .flatMap((line) => line.split(/(?<=[.!?])\s+/))
    .map((s) => s.trim())
    .filter(Boolean);
}

function isNegatedStep(sentence) {
  return /\b(not|without|later|optional|excluded|unneeded|don't|do not|out of scope|no|none)\b/i.test(
    sentence,
  );
}

function windowsAround(text, re, radius = 220) {
  const flags = re.flags.includes("g") ? re.flags : `${re.flags}g`;
  const global = new RegExp(re.source, flags);
  const hits = [];
  let m;
  while ((m = global.exec(text))) {
    hits.push(
      text.slice(
        Math.max(0, m.index - radius),
        Math.min(text.length, m.index + m[0].length + radius),
      ),
    );
  }
  return hits;
}

function isOptionalMacCloneAndBuild(window) {
  const optionalClone =
    /optional[\s\S]{0,40}clone[\s-]+and[\s-]+build|clone[\s-]+and[\s-]+build[\s\S]{0,40}optional/i.test(
      window,
    );
  const shipsByClone =
    /\bships?\s+by\s+clone[\s-]+and[\s-]+build|clone[\s-]+and[\s-]+build[\s\S]{0,40}\bships?\b|\bv1\s+ships?\b[\s\S]{0,80}clone[\s-]+and[\s-]+build/i.test(
      window,
    );
  return optionalClone && !shipsByClone;
}

function v1ShipByCloneAndBuildWindows(text) {
  return windowsAround(text, CLONE_AND_BUILD).filter((window) => {
    if (!/\bv1\b/i.test(window)) return false;
    if (!SHIP.test(window)) return false;
    if (isOptionalMacCloneAndBuild(window)) return false;
    return /ships?\s+by\s+clone[\s-]+and[\s-]+build|clone[\s-]+and[\s-]+build[\s\S]{0,60}\bships?\b|\bships?\b[\s\S]{0,60}clone[\s-]+and[\s-]+build/i.test(
      window,
    );
  });
}

function mentionsGitHubReleases(sentence) {
  return (
    /github\s+releases?/i.test(sentence) ||
    /github\.com\/[^\s)]+\/releases\b/i.test(sentence)
  );
}

test("README states that v1 ships by clone-and-build", () => {
  const text = loadReadme();
  const hits = v1ShipByCloneAndBuildWindows(text);
  assert.ok(
    hits.length > 0,
    "README must state that v1 ships by clone-and-build, not merely that Mac clone-and-build is optional",
  );
});

test("v1 clone-and-build ship path covers Linux and Mac", () => {
  const text = loadReadme();
  const hits = v1ShipByCloneAndBuildWindows(text);
  assert.ok(
    hits.length > 0,
    "README must document a v1 clone-and-build ship path that covers Linux and Mac",
  );
  const coversBoth = hits.some(
    (window) => /\blinux\b/i.test(window) && /\bmac(?:os)?\b/i.test(window),
  );
  assert.ok(
    coversBoth,
    "the v1 clone-and-build ship path must cover Linux and Mac",
  );
});

test("README does not offer GitHub Releases as the v1 ship path", () => {
  const text = loadReadme();
  const list = sentences(text);
  const mentions = list.filter(mentionsGitHubReleases);
  const saysNone = mentions.some(isNegatedStep);
  const neverPresents = mentions.length === 0;
  assert.ok(
    saysNone || neverPresents,
    "README must say there are no GitHub Releases, or never present Releases as how to get LightMD",
  );
  for (const s of mentions) {
    assert.ok(
      isNegatedStep(s),
      `README must not offer GitHub Releases as the v1 ship path: ${s}`,
    );
  }
});

test("README does not offer installers as the v1 ship path", () => {
  const text = loadReadme();
  for (const s of sentences(text)) {
    if (!/\binstallers?\b/i.test(s)) continue;
    assert.ok(
      isNegatedStep(s),
      `README must not offer installers as the v1 ship path: ${s}`,
    );
  }
});

test("README keeps privacy and no update check in v1", () => {
  const text = loadReadme();
  assert.match(
    text,
    /^#{1,6}\s+.*privacy/im,
    "README must keep a Privacy heading",
  );
  assert.match(
    text,
    /no[-\s]telemetry/i,
    "README must keep no telemetry",
  );
  assert.match(
    text,
    /no update check in v1/i,
    "README must keep no update check in v1",
  );
});
