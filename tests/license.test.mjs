import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const licensePath = join(root, "LICENSE");
const indexHtmlPath = join(root, "src", "index.html");
const tauriConfPath = join(root, "src-tauri", "tauri.conf.json");

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

function frontendDistDir() {
  assert.equal(
    existsSync(tauriConfPath),
    true,
    "src-tauri/tauri.conf.json must exist",
  );
  const conf = JSON.parse(readFileSync(tauriConfPath, "utf8"));
  const dist = conf?.build?.frontendDist;
  assert.ok(
    dist,
    "src-tauri/tauri.conf.json must set build.frontendDist",
  );
  return resolve(join(root, "src-tauri"), dist);
}

function aboutSectionFromIndexHtml(html) {
  const start = html.search(/<(?:h[1-6]|legend)[^>]*>\s*About\s*</i);
  assert.ok(start >= 0, "src/index.html must include an About section");
  const from = html.slice(start);
  const headingEnd = from.search(/>/);
  const afterHeading = headingEnd >= 0 ? from.slice(headingEnd + 1) : from;
  const nextHeading = afterHeading.search(/<(?:h[1-6]|legend)\b/i);
  const sectionClose = afterHeading.search(/<\/section>/i);
  let end = afterHeading.length;
  if (nextHeading >= 0) end = Math.min(end, nextHeading);
  if (sectionClose >= 0) end = Math.min(end, sectionClose);
  return from.slice(0, from.length - afterHeading.length + end);
}

function aboutMitHref(about) {
  const mitAnchor = about.match(
    /<a\b[^>]*\bhref\s*=\s*(["'])([^"']*)\1[^>]*>\s*MIT(?:\s+Licen[sc]e)?\s*<\/a>/i,
  );
  if (mitAnchor) return mitAnchor[2].trim();
  const licenseThenAnchor = about.match(
    /Licen[sc]e[\s\S]{0,160}<a\b[^>]*\bhref\s*=\s*(["'])([^"']*)\1/i,
  );
  if (licenseThenAnchor) return licenseThenAnchor[2].trim();
  return null;
}

function isHttpsGithubLightmdLicenseUrl(href) {
  let url;
  try {
    url = new URL(href);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase();
  const path = url.pathname.replace(/\/+$/, "");
  if (host === "github.com") {
    return /^\/clearly-bots\/lightmd\/(?:blob|raw)\/[^/]+\/LICENSE$/i.test(
      path,
    );
  }
  if (host === "raw.githubusercontent.com") {
    return /^\/clearly-bots\/lightmd\/[^/]+\/LICENSE$/i.test(path);
  }
  return false;
}

function relativeHrefResolvesUnderFrontendDist(href, frontendDist) {
  const trimmed = String(href).trim();
  if (!trimmed) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) || trimmed.startsWith("//")) {
    return false;
  }
  const pathOnly = trimmed.split(/[?#]/)[0];
  if (!pathOnly) return false;
  const target = resolve(frontendDist, pathOnly);
  const rel = relative(frontendDist, target);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return false;
  return existsSync(target);
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

test("about MIT href resolves from the running app", () => {
  assert.equal(existsSync(indexHtmlPath), true, "src/index.html must exist");
  const html = readFileSync(indexHtmlPath, "utf8");
  const about = aboutSectionFromIndexHtml(html);
  const href = aboutMitHref(about);
  assert.ok(
    href,
    "About must include an MIT <a> with an href",
  );

  const frontendDist = frontendDistDir();
  const githubLicense = isHttpsGithubLightmdLicenseUrl(href);
  const relativeResolves = relativeHrefResolvesUnderFrontendDist(
    href,
    frontendDist,
  );
  const shippedUnderFrontendDist = existsSync(join(frontendDist, "LICENSE"));

  assert.ok(
    githubLicense || relativeResolves || shippedUnderFrontendDist,
    `About MIT <a> href must resolve from the running app (frontendDist is src/; relative href=${JSON.stringify(href)} is not resolvable without src/LICENSE). Use an https URL to github.com/clearly-bots/lightmd LICENSE (blob/main/LICENSE or raw) or ship LICENSE under src/.`,
  );
});
