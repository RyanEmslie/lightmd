import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(root, "src");
const fixturePath = join(root, "tests", "fixtures", "frontmatter.md");

function loadFixture() {
  assert.equal(existsSync(fixturePath), true, "tests/fixtures/frontmatter.md must exist");
  const source = readFileSync(fixturePath, "utf8");
  assert.match(source, /^---\r?\n/, "fixture must start with ---");
  assert.match(source, /^title:\s*Test\s*$/m, "fixture must include title: Test");
  return source;
}

function collectSource(dir) {
  const chunks = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) {
      chunks.push(...collectSource(p));
      continue;
    }
    if (ent.name === "editor.bundle.js") continue;
    if (/\.(html|js|mjs|cjs|ts|css)$/i.test(ent.name)) {
      chunks.push(readFileSync(p, "utf8"));
    }
  }
  return chunks;
}

function loadSources() {
  assert.equal(existsSync(srcDir), true, "src/ must exist");
  const files = collectSource(srcDir);
  assert.ok(files.length > 0, "src/ must contain editor source");
  return files.join("\n");
}

function pickParse(mod) {
  const names = [
    "parseFrontmatter",
    "parse_frontmatter",
    "splitFrontmatter",
    "split_frontmatter",
    "parse",
  ];
  for (const name of names) {
    if (typeof mod[name] === "function") return mod[name];
  }
  if (typeof mod.default === "function") return mod.default;
  if (mod.default && typeof mod.default === "object") {
    for (const name of names) {
      if (typeof mod.default[name] === "function") return mod.default[name];
    }
  }
  return null;
}

async function loadParse() {
  const names = [
    "frontmatter.js",
    "frontmatter.mjs",
    "frontmatter.ts",
    "parse-frontmatter.js",
    "parseFrontmatter.js",
    "parse.js",
    "markdown.js",
    "preview.js",
  ];
  for (const name of names) {
    const p = join(srcDir, name);
    try {
      const mod = await import(pathToFileURL(p).href);
      const fn = pickParse(mod);
      if (fn) return fn;
    } catch {
      // Missing or unusable module: keep looking, then fail as missing parse.
    }
  }
  return null;
}

function splitResult(result) {
  if (Array.isArray(result) && result.length >= 2) {
    return { meta: result[0], body: result[1] };
  }
  if (!result || typeof result !== "object") return null;
  const meta =
    result.frontmatter ??
    result.data ??
    result.meta ??
    result.yaml ??
    result.matter ??
    result.attributes;
  const body = result.body ?? result.content ?? result.markdown ?? result.rest;
  if (meta === undefined || body === undefined) return null;
  return { meta, body };
}

function titleOf(meta) {
  if (meta == null) return undefined;
  if (typeof meta === "string") {
    const m = meta.match(/^\s*title:\s*(.*)$/m);
    return m ? m[1].trim().replace(/^["']|["']$/g, "") : undefined;
  }
  if (typeof meta === "object") return meta.title;
  return undefined;
}

function hasCompactFrontmatterBlock(src) {
  if (/\bid=["'](?:frontmatter|front-matter|metadata|yaml-block|matter)["']/i.test(src)) {
    return true;
  }
  if (/\.id\s*=\s*["'](?:frontmatter|front-matter|metadata|yaml-block|matter)["']/i.test(src)) {
    return true;
  }
  if (
    /getElementById\(\s*["'](?:frontmatter|front-matter|metadata|yaml-block|matter)["']\s*\)/.test(
      src,
    )
  ) {
    return true;
  }
  if (/#frontmatter\b/.test(src)) return true;
  if (/createElement\([\s\S]{0,120}?frontmatter/i.test(src)) return true;
  return false;
}

function showsBlockWhenFileStartsWithFence(src) {
  const detectsFence =
    /\.startsWith\(\s*["']---["']/.test(src) ||
    /\/\^---/.test(src) ||
    /\bparseFrontmatter\b|\bparse_frontmatter\b|\bsplitFrontmatter\b|\bsplit_frontmatter\b/.test(
      src,
    );
  return hasCompactFrontmatterBlock(src) && detectsFence;
}

function previewOmitsYamlAsMarkdown(src) {
  if (
    /(?:preview|markdown(?:It)?|render(?:Markdown|Preview)?|setPreview)\s*[\s\S]{0,220}?(?:parsed\.)?(?:body|content)\b/.test(
      src,
    )
  ) {
    return true;
  }
  if (
    /(?:parsed\.)?(?:body|content)\b[\s\S]{0,220}?(?:preview|markdown(?:It)?|render(?:Markdown|Preview)?|setPreview)/.test(
      src,
    )
  ) {
    return true;
  }
  if (/replace\(\s*\/\\?\^---[\s\S]{0,80}?---/.test(src)) return true;
  return false;
}

test("parse splits YAML frontmatter from body", async () => {
  const source = loadFixture();
  const parse = await loadParse();
  assert.ok(parse, "missing parse that splits frontmatter from body");
  const split = splitResult(parse(source));
  assert.ok(split, "parse must split frontmatter from body");
  assert.equal(String(titleOf(split.meta)), "Test", "frontmatter title must be Test");
  const body = String(split.body);
  assert.equal(
    /^\s*---/.test(body),
    false,
    "body must not include the YAML frontmatter fence",
  );
  assert.equal(
    /^\s*title:\s*Test/m.test(body),
    false,
    "body must not include the YAML as markdown",
  );
  assert.match(
    body,
    /Known body for frontmatter/,
    "body must keep the markdown after the frontmatter",
  );
});

test("chrome has a compact metadata block (#frontmatter or similar)", () => {
  const src = loadSources();
  assert.ok(
    hasCompactFrontmatterBlock(src),
    "missing compact metadata block (#frontmatter or similar)",
  );
});

test("metadata block is shown when a file starts with ---; body/preview must not include the YAML as markdown", () => {
  const src = loadSources();
  assert.ok(
    showsBlockWhenFileStartsWithFence(src),
    "compact metadata block must be shown when a file starts with ---",
  );
  assert.ok(
    previewOmitsYamlAsMarkdown(src),
    "body/preview must not include the YAML as markdown",
  );
});
