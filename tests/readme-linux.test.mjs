import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const readmePath = join(root, "README.md");
const packagePath = join(root, "package.json");

const DEBIAN_PACKAGES = [
  "libwebkit2gtk-4.1-dev",
  "build-essential",
  "curl",
  "wget",
  "file",
  "libxdo-dev",
  "libssl-dev",
  "libayatana-appindicator3-dev",
  "librsvg2-dev",
];

function loadReadme() {
  assert.equal(existsSync(readmePath), true, "README.md must exist");
  return readFileSync(readmePath, "utf8");
}

function loadPackage() {
  assert.equal(existsSync(packagePath), true, "package.json must exist");
  return JSON.parse(readFileSync(packagePath, "utf8"));
}

function sentences(text) {
  return String(text)
    .split(/\n+/)
    .flatMap((line) => line.split(/(?<=[.!?])\s+/))
    .map((s) => s.trim())
    .filter(Boolean);
}

function isNegatedStep(sentence) {
  return /\b(not|without|later|optional|excluded|unneeded|don't|do not|out of scope|no)\b/i.test(
    sentence,
  );
}

// v1 Linux clone-and-build only: Prerequisites (Linux), Install and run, Build.
// The optional macOS section may document xcode-select; that is not a v1 Linux step.
function linuxV1Text(text) {
  const lines = String(text).split(/\n/);
  const collected = [];
  let include = false;
  let inMac = false;
  let macLevel = 0;
  let level = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(#{1,6})\s+(.*)$/);
    if (m) {
      const heading = m[2].trim();
      const thisLevel = m[1].length;
      if (inMac && thisLevel <= macLevel) inMac = false;
      if (/\bmac(?:os)?\b/i.test(heading) && !/\blinux\b/i.test(heading)) {
        inMac = true;
        macLevel = thisLevel;
        include = false;
        continue;
      }
      if (inMac) continue;
      if (include && thisLevel <= level) include = false;
      const isLinuxV1Heading =
        /prerequisites\s*\(\s*linux\s*\)/i.test(heading) ||
        /^install and run$/i.test(heading) ||
        /^build$/i.test(heading);
      if (isLinuxV1Heading) {
        include = true;
        level = thisLevel;
      }
    }
    if (include && !inMac) collected.push(lines[i]);
  }
  return collected.join("\n");
}

test("README documents Atrium as the v1 Linux build host", () => {
  const text = loadReadme();
  assert.match(text, /atrium/i, "README must mention Atrium");
  assert.match(
    text,
    /build[-\s]host/i,
    "README must call Atrium the v1 Linux build host, not merely developed and tested on Atrium",
  );
  const together = text.match(
    /atrium[\s\S]{0,200}build[-\s]host|build[-\s]host[\s\S]{0,200}atrium/i,
  );
  assert.ok(
    together,
    "Atrium and build host must appear together as the v1 Linux host",
  );
  assert.match(
    together[0],
    /\bv1\b/i,
    "the Atrium build host must be documented for v1",
  );
});

test("README says a Mac is not required for v1", () => {
  const text = loadReadme();
  const hits = sentences(text).filter(
    (s) => /\bmac(?:os)?\b/i.test(s) && /not required/i.test(s),
  );
  assert.ok(hits.length > 0, "README must say a Mac is not required");
  const forV1 = hits.filter((s) => /\bv1\b/i.test(s) && !/\bscaffold\b/i.test(s));
  assert.ok(
    forV1.length > 0,
    "README must say a Mac is not required for v1, not merely the scaffold",
  );
});

test("README installs Rust via rustup stable not Debian rustc", () => {
  const text = loadReadme();
  assert.match(
    text,
    /rustup[\s\S]{0,80}stable|stable[\s\S]{0,80}rustup/i,
    "README must install Rust via rustup stable",
  );
  assert.match(
    text,
    /debian[^\n.]{0,80}\brustc\b|\brustc\b[^\n.]{0,80}(too old|debian)/i,
    "README must warn against Debian rustc",
  );
  assert.doesNotMatch(
    text,
    /apt(?:-get)?\s+install[^\n]*\brustc\b/i,
    "README must not apt-install Debian rustc",
  );
});

test("README lists Tauri 2 Debian packages including libwebkit2gtk-4.1-dev", () => {
  const text = loadReadme();
  for (const pkg of DEBIAN_PACKAGES) {
    const re = new RegExp(pkg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    assert.match(text, re, `README must list Linux dep ${pkg}`);
  }
});

test("README documents npm install, tauri dev, and tauri build", () => {
  const text = loadReadme();
  assert.match(text, /npm\s+install/i, "README must document npm install");
  assert.match(text, /tauri\s+dev/i, "README must document tauri dev");
  assert.match(text, /tauri\s+build/i, "README must document tauri build");
});

test("package.json scripts provide tauri / dev / build", () => {
  const pkg = loadPackage();
  const scripts = pkg.scripts || {};
  assert.equal(typeof scripts.tauri, "string", "package.json scripts.tauri must exist");
  assert.equal(typeof scripts.dev, "string", "package.json scripts.dev must exist");
  assert.equal(typeof scripts.build, "string", "package.json scripts.build must exist");
  assert.match(scripts.tauri, /\btauri\b/, "scripts.tauri must invoke tauri");
  assert.match(scripts.dev, /tauri\s+dev/, "scripts.dev must run tauri dev");
  assert.match(scripts.build, /tauri\s+build/, "scripts.build must run tauri build");
});

test("README does not require Xcode or Mac as a v1 step", () => {
  const text = linuxV1Text(loadReadme());
  assert.match(
    text,
    /prerequisites\s*\(\s*linux\s*\)/i,
    "Linux coverage: Prerequisites (Linux) must remain",
  );
  assert.match(
    text,
    /install and run/i,
    "Linux coverage: Install and run must remain",
  );
  assert.match(
    text,
    /^#{1,6}\s+build\b/im,
    "Linux coverage: Build must remain",
  );
  for (const s of sentences(text)) {
    const hasXcodeOrBrew = /\bxcode\b|\bhomebrew\b|\bbrew install\b/i.test(s);
    assert.equal(
      hasXcodeOrBrew && !isNegatedStep(s),
      false,
      `README must not require Xcode or Homebrew as a v1 step: ${s}`,
    );
    const macAsRequired =
      /\bmac(?:os)?\b/i.test(s) &&
      /\b(required|prerequisite|must install|need a mac|requires a mac)\b/i.test(s) &&
      !/not required|without a mac|no mac/i.test(s);
    assert.equal(
      macAsRequired,
      false,
      `README must not require a Mac as a v1 step: ${s}`,
    );
  }
});

test("README does not list publish, installer, or auto-update as v1 steps", () => {
  const text = loadReadme();
  for (const s of sentences(text)) {
    if (!/\bpublish\b|\binstallers?\b|\bauto-?updates?\b/i.test(s)) continue;
    assert.ok(
      isNegatedStep(s),
      `README must not list publish, installer, or auto-update as a v1 step: ${s}`,
    );
  }
});
