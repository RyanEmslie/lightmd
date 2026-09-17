import assert from "node:assert/strict";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { findInBuffer, findOptions, runFind } from "../src/find.js";
import { loadSourceText } from "./helpers/source.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(root, "src");
const htmlPath = join(srcDir, "index.html");
const fixtureDir = join(root, "tests", "fixtures", "find-workspace");
const findFixturePath = join(root, "tests", "fixtures", "find.md");

const NEEDLE = "zxq9-lightmd-unique-workspace-hit";
const FILE_NEEDLE = "zxq9-lightmd-unique-find-needle";
const OPTIONS_WORD = "alpha";
const NESTED_HIT = "nested/deep/hit.md";

const SEARCH_NAMES = [
  "findInWorkspace",
  "find_in_workspace",
  "searchWorkspace",
  "search_workspace",
  "findInFiles",
  "workspaceSearch",
  "searchWorkspaceFiles",
];

const OPEN_HIT_NAMES = [
  "openWorkspaceHit",
  "open_workspace_hit",
  "activateWorkspaceHit",
  "activate_workspace_hit",
  "openFindHit",
  "revealWorkspaceHit",
  "goToWorkspaceHit",
];

function loadSources() {
  return loadSourceText();
}

function loadHtml() {
  assert.equal(existsSync(htmlPath), true, "src/index.html must exist");
  return readFileSync(htmlPath, "utf8");
}

function listedExt(name) {
  return /\.(md|html|htm)$/i.test(name);
}

function collectListedFiles(dir, base = dir, acc = []) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) {
      collectListedFiles(p, base, acc);
      continue;
    }
    if (listedExt(ent.name)) {
      acc.push({
        relative: relative(base, p).replaceAll("\\", "/"),
        text: readFileSync(p, "utf8"),
      });
    }
  }
  return acc;
}

function pickFn(mod, names) {
  if (!mod || typeof mod !== "object") return null;
  for (const name of names) {
    if (typeof mod[name] === "function") return mod[name];
  }
  if (typeof mod.default === "function" && names.includes("default")) {
    return mod.default;
  }
  if (mod.default && typeof mod.default === "object") {
    for (const name of names) {
      if (typeof mod.default[name] === "function") return mod.default[name];
    }
  }
  return null;
}

async function loadModule(name) {
  const p = join(srcDir, name);
  if (!existsSync(p)) return null;
  try {
    return await import(pathToFileURL(p).href);
  } catch {
    return null;
  }
}

const MODULE_CANDIDATES = [
  "find.js",
  "find.mjs",
  "find-workspace.js",
  "find-workspace.mjs",
  "workspace-find.js",
  "search.js",
  "search.mjs",
  "editor.js",
];

async function loadNamedFn(names) {
  for (const name of MODULE_CANDIDATES) {
    const mod = await loadModule(name);
    const fn = pickFn(mod, names);
    if (fn) return fn;
  }
  return null;
}

async function loadWorkspaceFind() {
  return loadNamedFn(SEARCH_NAMES);
}

async function loadOpenHit() {
  return loadNamedFn(OPEN_HIT_NAMES);
}

function unwrapHits(result) {
  if (result == null || result === false) return [];
  if (Array.isArray(result)) return result;
  if (typeof result.next === "function") {
    const hits = [];
    for (let step = result.next(); step; step = result.next()) {
      if (step.done) break;
      hits.push(step.value ?? step);
      if (hits.length > 10_000) break;
    }
    return hits;
  }
  if (Array.isArray(result.matches)) return result.matches;
  if (Array.isArray(result.hits)) return result.hits;
  if (Array.isArray(result.results)) return result.results;
  if (Array.isArray(result.ranges)) return result.ranges;
  return [];
}

async function callSearch(fn, workspace, needle, options) {
  const files = collectListedFiles(workspace);
  const attempts = [
    () => fn(workspace, needle, options),
    () => fn({ root: workspace, needle, options }),
    () => fn({ path: workspace, query: needle, ...options }),
    () => fn({ root: workspace, query: needle, options }),
    () => fn(files, needle, options),
    () => fn({ files, needle, options }),
  ];
  let lastErr;
  for (const attempt of attempts) {
    try {
      const result = await attempt();
      if (result !== undefined) return result;
    } catch (err) {
      lastErr = err;
    }
  }
  if (lastErr) throw lastErr;
  return [];
}

function hitPath(hit) {
  if (hit == null) return "";
  if (typeof hit === "string") return String(hit).replaceAll("\\", "/");
  const p =
    hit.relative ??
    hit.relative_path ??
    hit.path ??
    hit.file ??
    hit.filename ??
    hit[0];
  return String(p ?? "").replaceAll("\\", "/");
}

function hitLocation(hit) {
  if (hit == null || typeof hit !== "object") return {};
  const from = hit.from ?? hit.start ?? hit.index ?? hit.offset;
  const to = hit.to ?? hit.end;
  const line = hit.line ?? hit.lineNumber ?? hit.row;
  return {
    from: typeof from === "number" ? from : undefined,
    to: typeof to === "number" ? to : undefined,
    line: typeof line === "number" ? line : undefined,
  };
}

function assertHitLocatesNeedle(hit, workspace, needle) {
  const rel = hitPath(hit);
  assert.ok(rel, "workspace hit must include a relative path");
  assert.match(
    rel,
    /\.(md|html|htm)$/i,
    `workspace hit path must be a file LightMD opens (.md/.html/.htm), got ${rel}`,
  );
  assert.ok(
    rel.includes("/"),
    `hit path must be nested (relative path under a subdir), got ${rel}`,
  );
  const abs = join(workspace, rel);
  assert.equal(existsSync(abs), true, `hit path ${rel} must exist under the workspace`);
  const text = readFileSync(abs, "utf8");
  assert.ok(
    text.includes(needle),
    `hit file ${rel} must contain the needle`,
  );
  const loc = hitLocation(hit);
  const to =
    loc.to ??
    (typeof loc.from === "number" ? loc.from + needle.length : undefined);
  const hasRange = typeof loc.from === "number" && typeof to === "number";
  const hasLine = typeof loc.line === "number";
  assert.ok(
    hasRange || hasLine,
    "workspace hit must include line or from/to (or equivalent location)",
  );
  if (hasRange) {
    const slice = text.slice(loc.from, to);
    assert.ok(
      slice.includes(needle) || text.slice(loc.from, loc.from + needle.length) === needle,
      `hit from/to must cover the needle in ${rel}`,
    );
  }
  if (hasLine) {
    const lines = text.split(/\n/);
    const at =
      lines[loc.line] ??
      lines[loc.line - 1];
    assert.ok(
      typeof at === "string" && at.includes(needle),
      `hit line ${loc.line} must contain the needle in ${rel}`,
    );
  }
}

function makeWorkspace() {
  assert.equal(
    existsSync(join(fixtureDir, NESTED_HIT)),
    true,
    "tests/fixtures/find-workspace must contain nested/deep/hit.md",
  );
  const dir = mkdtempSync(join(tmpdir(), "lightmd-find-workspace-"));
  cpSync(fixtureDir, dir, { recursive: true });
  const huge = Buffer.alloc(2 * 1024 * 1024, 0x00);
  Buffer.from(NEEDLE).copy(huge, 123_456);
  writeFileSync(join(dir, "huge.bin"), huge);
  const blob = join(dir, "blob.png");
  if (!existsSync(blob)) {
    writeFileSync(
      blob,
      Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.from(NEEDLE),
        Buffer.alloc(32, 0xff),
      ]),
    );
  }
  return dir;
}

function hasWorkspaceFindControl(html) {
  if (
    /\bid=["'](?:find-(?:in-)?workspace(?:-query)?|workspace-find(?:-query)?)["']/i.test(
      html,
    )
  ) {
    return true;
  }
  if (
    /\.id\s*=\s*["'](?:find-(?:in-)?workspace(?:-query)?|workspace-find(?:-query)?)["']/i.test(
      html,
    )
  ) {
    return true;
  }
  if (
    /placeholder=["'][^"']*find in workspace[^"']*["']/i.test(html)
  ) {
    return true;
  }
  if (
    /<button\b[^>]*>[\s\S]{0,80}?find in workspace[\s\S]{0,80}?<\/button>/i.test(
      html,
    )
  ) {
    return true;
  }
  if (/aria-label=["'][^"']*find in workspace[^"']*["']/i.test(html)) {
    return true;
  }
  return false;
}

function hasWorkspaceFindResults(html) {
  if (
    /\bid=["'](?:find-(?:in-)?workspace-results|workspace-find-results|workspace-search-results)["']/i.test(
      html,
    )
  ) {
    return true;
  }
  if (
    /\.id\s*=\s*["'](?:find-(?:in-)?workspace-results|workspace-find-results|workspace-search-results)["']/i.test(
      html,
    )
  ) {
    return true;
  }
  if (
    /data-find-workspace-results|data-workspace-find-results/.test(html)
  ) {
    return true;
  }
  return false;
}

function documentsOpenHitApi(src) {
  const markers = [
    /openWorkspaceHit/,
    /activateWorkspaceHit/,
    /openFindHit/,
    /revealWorkspaceHit/,
    /goToWorkspaceHit/,
    /find-workspace-results/,
    /workspace-find-results/,
    /workspace-search-results/,
  ];
  for (const re of markers) {
    const copy = new RegExp(re.source, "gi");
    let m;
    while ((m = copy.exec(src))) {
      const window = src.slice(
        Math.max(0, m.index - 400),
        m.index + m[0].length + 900,
      );
      const opens =
        /lightmdOpenFile|applyFile|openFile|read_workspace_file|setDoc/.test(
          window,
        );
      const focuses =
        /runFind|setSelection|scrollIntoView|selection\s*:|\.dispatch\(/.test(
          window,
        );
      if (opens && focuses) return true;
    }
  }
  return false;
}

test("findInWorkspace finds a unique needle in a nested workspace file", async () => {
  const workspace = makeWorkspace();
  try {
    const finder = await loadWorkspaceFind();
    assert.ok(
      finder,
      "missing findInWorkspace (or search_workspace) — search nested workspace files, not only the current buffer",
    );
    const result = await callSearch(finder, workspace, NEEDLE, findOptions);
    const hits = unwrapHits(result);
    assert.ok(
      hits.length >= 1,
      "findInWorkspace must return ≥1 hit for a unique needle in a nested file",
    );
    const nested = hits.filter((hit) =>
      hitPath(hit).replaceAll("\\", "/").endsWith(NESTED_HIT),
    );
    assert.ok(
      nested.length >= 1,
      `expected a hit in ${NESTED_HIT}, got ${hits.map(hitPath).join(", ") || "(none)"}`,
    );
    for (const hit of nested) {
      assertHitLocatesNeedle(hit, workspace, NEEDLE);
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("empty needle yields empty results and does not throw", async () => {
  const workspace = makeWorkspace();
  try {
    const finder = await loadWorkspaceFind();
    assert.ok(
      finder,
      "missing findInWorkspace (or search_workspace)",
    );
    let empty;
    try {
      empty = unwrapHits(await callSearch(finder, workspace, "", findOptions));
    } catch (err) {
      assert.fail(`empty needle must not throw: ${err}`);
    }
    assert.equal(empty.length, 0, "empty needle must yield empty results");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("openWorkspaceHit opens the relative file and selects the match", async () => {
  const opener = await loadOpenHit();
  const documented = documentsOpenHitApi(loadSources());
  assert.ok(
    typeof opener === "function" || documented,
    "missing openWorkspaceHit (or documented API: open file + runFind/set selection)",
  );
  if (typeof opener !== "function") return;

  const workspace = makeWorkspace();
  try {
    const finder = await loadWorkspaceFind();
    assert.ok(
      finder,
      "missing findInWorkspace (or search_workspace)",
    );
    const hits = unwrapHits(
      await callSearch(finder, workspace, NEEDLE, findOptions),
    );
    assert.ok(hits.length >= 1, "need a workspace hit to open");
    const hit = hits.find((h) =>
      hitPath(h).replaceAll("\\", "/").endsWith(NESTED_HIT),
    ) ?? hits[0];
    const rel = hitPath(hit);

    const opened = [];
    const selections = [];
    const openFile = async (path) => {
      opened.push(String(path).replaceAll("\\", "/"));
    };
    const view = {
      state: {
        doc: {
          toString() {
            return readFileSync(join(workspace, rel), "utf8");
          },
        },
      },
      dispatch(spec) {
        if (spec?.selection) selections.push(spec.selection);
      },
    };
    const mocks = {
      openFile,
      open: openFile,
      applyFile: openFile,
      runFind: (v, needle) => {
        runFind(v ?? view, needle ?? NEEDLE);
      },
      view,
      workspace,
      root: workspace,
    };
    globalThis.lightmdOpenFile = openFile;
    try {
      await opener(hit, mocks);
    } catch {
      await opener({ hit, ...mocks });
    }
    const openedRel = opened.some(
      (p) => p === rel || p.endsWith(rel) || rel.endsWith(p),
    );
    assert.ok(
      openedRel,
      "openWorkspaceHit must open the hit's relative file",
    );
    assert.ok(
      selections.length > 0,
      "openWorkspaceHit must focus/select the match range (runFind or set selection)",
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("findInWorkspace respects findOptions caseSensitive and wholeWord like findInBuffer", async () => {
  const workspace = makeWorkspace();
  try {
    const finder = await loadWorkspaceFind();
    assert.ok(
      finder,
      "missing findInWorkspace (or search_workspace)",
    );
    const files = collectListedFiles(workspace);
    const optionSets = [
      { caseSensitive: false, wholeWord: false },
      { caseSensitive: true, wholeWord: false },
      { caseSensitive: false, wholeWord: true },
      { caseSensitive: true, wholeWord: true },
    ];
    for (const options of optionSets) {
      const expected = [];
      for (const file of files) {
        for (const range of findInBuffer(file.text, OPTIONS_WORD, options)) {
          expected.push({ relative: file.relative, from: range.from, to: range.to });
        }
      }
      const got = unwrapHits(
        await callSearch(finder, workspace, OPTIONS_WORD, options),
      ).map((hit) => ({
        relative: hitPath(hit).replaceAll("\\", "/"),
        from: hitLocation(hit).from,
        to:
          hitLocation(hit).to ??
          (typeof hitLocation(hit).from === "number"
            ? hitLocation(hit).from + OPTIONS_WORD.length
            : undefined),
      }));
      assert.ok(
        expected.length > 0,
        "options fixture must contain alpha/Alpha/ALPHA/alphabet so findInBuffer can oracle",
      );
      const key = (h) => `${h.relative}:${h.from}:${h.to}`;
      const gotKeys = new Set(got.map(key));
      for (const exp of expected) {
        assert.ok(
          gotKeys.has(key(exp)) ||
            got.some(
              (h) =>
                h.relative === exp.relative &&
                (h.from === exp.from ||
                  (typeof h.from !== "number" && h.relative === exp.relative)),
            ),
          `findInWorkspace must match findInBuffer for ${JSON.stringify(options)} at ${key(exp)}`,
        );
      }
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("findInWorkspace skips binary and non-text; only md/html/htm", async () => {
  const workspace = makeWorkspace();
  try {
    const finder = await loadWorkspaceFind();
    assert.ok(
      finder,
      "missing findInWorkspace (or search_workspace)",
    );
    const hits = unwrapHits(
      await callSearch(finder, workspace, NEEDLE, findOptions),
    );
    assert.ok(
      hits.length >= 1,
      "needle is in nested/deep/hit.md; skipping binaries must not drop that hit",
    );
    for (const hit of hits) {
      const rel = hitPath(hit).replaceAll("\\", "/");
      assert.match(
        rel,
        /\.(md|html|htm)$/i,
        `must not return hits from binary/non-text files (got ${rel})`,
      );
      assert.equal(
        /\.(png|bin|txt)$/i.test(rel),
        false,
        `must skip .png / huge binary / .txt (got ${rel})`,
      );
    }
    const forbidden = hits.filter((hit) => {
      const rel = hitPath(hit).replaceAll("\\", "/");
      return (
        rel.endsWith("blob.png") ||
        rel.endsWith("huge.bin") ||
        rel.endsWith("ignore.txt")
      );
    });
    assert.equal(
      forbidden.length,
      0,
      "must not return hits from .png, huge binary, or .txt even when they contain the needle",
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("index.html has a Find in workspace control and a results list", () => {
  const html = loadHtml();
  assert.ok(
    hasWorkspaceFindControl(html),
    "missing Find in workspace control (distinct from #find-query Find in file)",
  );
  assert.ok(
    hasWorkspaceFindResults(html),
    "missing Find in workspace results list container",
  );
});

test("Find in file (findInBuffer) is unchanged", async () => {
  assert.equal(
    existsSync(findFixturePath),
    true,
    "tests/fixtures/find.md must exist",
  );
  const text = readFileSync(findFixturePath, "utf8");
  const hits = findInBuffer(text, FILE_NEEDLE, findOptions);
  assert.ok(
    hits.some(
      (hit) => text.slice(hit.from, hit.to) === FILE_NEEDLE,
    ),
    "findInBuffer must still highlight the unique needle in the current buffer",
  );
  assert.deepEqual(
    findInBuffer(text, ""),
    [],
    "findInBuffer empty needle must still return []",
  );
});

test("searchWorkspace lists and reads via invoke, then returns nested hits", async () => {
  const { searchWorkspace } = await import("../src/find.js");
  assert.equal(typeof searchWorkspace, "function");
  const files = {
    "ignore.txt": `txt ${NEEDLE}`,
    "nested/deep/hit.md": `md ${NEEDLE} here`,
    "nested/page.html": "nope",
  };
  const invokes = [];
  async function invoke(cmd, args = {}) {
    invokes.push({ cmd, args });
    if (cmd === "list_workspace") {
      return Object.keys(files).map((relative_path) => ({
        relative_path,
        is_dir: false,
      }));
    }
    if (cmd === "read_workspace_file") {
      if (!(args.relative in files)) throw new Error("missing");
      return files[args.relative];
    }
    throw new Error(cmd);
  }
  const hits = await searchWorkspace({
    root: "/tmp/ws",
    needle: NEEDLE,
    invoke,
  });
  assert.ok(
    invokes.some((i) => i.cmd === "list_workspace" && i.args.path === "/tmp/ws"),
  );
  assert.ok(
    invokes.some(
      (i) =>
        i.cmd === "read_workspace_file" && i.args.relative === "nested/deep/hit.md",
    ),
  );
  assert.ok(hits.some((h) => h.relative === "nested/deep/hit.md"));
  assert.equal(
    hits.some((h) => h.relative === "ignore.txt"),
    false,
    "must skip non-md/html/htm even if invoke listed them",
  );
});

test("searchWorkspace empty needle or missing invoke yields []", async () => {
  const { searchWorkspace } = await import("../src/find.js");
  assert.deepEqual(await searchWorkspace({ root: "/tmp/ws", needle: "", invoke: async () => [] }), []);
  assert.deepEqual(await searchWorkspace({ root: "/tmp/ws", needle: NEEDLE }), []);
});
