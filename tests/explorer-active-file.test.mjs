import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { bootApp } from "./helpers/app.mjs";
import { loadHtml } from "./helpers/source.mjs";

const FOLDER = "/tmp/lightmd-explorer-active";
const FILE_A = "a.md";
const FILE_B = "b.md";
const DIR_NOTES = "notes";
const FILE_NESTED = "notes/nested.md";

function styleCss(html) {
  const chunks = [];
  const re = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
  let m;
  while ((m = re.exec(html))) chunks.push(m[1]);
  return chunks.join("\n");
}

function stripComments(css) {
  return String(css || "").replace(/\/\*[\s\S]*?\*\//g, "");
}

function parseRules(css) {
  const cleaned = stripComments(css);
  const rules = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(cleaned))) {
    const selector = m[1].replace(/@[\w-]+[^{]*/g, "").trim();
    if (!selector) continue;
    rules.push({ selector, body: m[2] });
  }
  return rules;
}

function isSelectedFileRowSelector(selector) {
  return String(selector)
    .split(",")
    .some((part) => {
      const p = part.trim();
      if (!p) return false;
      const inExplorer =
        /#file-list\b/.test(p) ||
        /\[data-dir/.test(p) ||
        /#explorer\b/.test(p);
      if (!inExplorer) return false;
      return (
        /aria-selected/.test(p) ||
        /\.selected\b/.test(p) ||
        /\.active\b/.test(p)
      );
    });
}

function usesThemeTokens(body) {
  return /var\(\s*--(?:accent|bg-elevated|fg)\s*(?:,[^)]*)?\)/.test(body);
}

function descendants(root) {
  const out = [];
  const walk = (n) => {
    for (const c of n.children || []) {
      out.push(c);
      walk(c);
    }
  };
  walk(root);
  return out;
}

function isMarkedSelected(el) {
  if (!el) return false;
  const aria = el.getAttribute?.("aria-selected") ?? el.attributes?.["aria-selected"];
  if (aria === "true" || aria === true) return true;
  if (el.classList?.contains?.("selected") || el.classList?.contains?.("active")) {
    return true;
  }
  const cls = `${el.className || ""} ${el.getAttribute?.("class") || ""}`;
  return /\b(?:selected|active)\b/.test(cls);
}

function fileRows(fileList) {
  return descendants(fileList).filter(
    (el) => el.tagName === "LI" && String(el.dataset?.dir) === "false",
  );
}

function folderRows(fileList) {
  return descendants(fileList).filter(
    (el) => el.tagName === "LI" && String(el.dataset?.dir) === "true",
  );
}

function summaryRows(fileList) {
  return descendants(fileList).filter((el) => el.tagName === "SUMMARY");
}

function rowByPath(fileList, relative) {
  return fileRows(fileList).find((el) => String(el.dataset?.path) === String(relative));
}

function selectedFileRows(fileList) {
  return fileRows(fileList).filter(isMarkedSelected);
}

function boot() {
  const rt = bootApp({
    folderPath: FOLDER,
    files: {
      [FILE_A]: `# ${FILE_A}\n`,
      [FILE_B]: `# ${FILE_B}\n`,
      [FILE_NESTED]: `# ${FILE_NESTED}\n`,
    },
  });
  return Object.assign(rt, { fileList: rt.el("file-list") });
}

async function openWorkspace(rt) {
  await rt.win.lightmdOpenFolder(FOLDER);
  const files = fileRows(rt.fileList);
  const folders = folderRows(rt.fileList);
  assert.ok(
    rowByPath(rt.fileList, FILE_A),
    `precondition: explorer must render a file row for ${FILE_A} (data-dir=false data-path)`,
  );
  assert.ok(
    rowByPath(rt.fileList, FILE_B),
    `precondition: explorer must render a file row for ${FILE_B}`,
  );
  assert.ok(
    rowByPath(rt.fileList, FILE_NESTED),
    `precondition: explorer must render a nested file row for ${FILE_NESTED}`,
  );
  assert.ok(
    folders.some((row) => String(row.dataset.path) === DIR_NOTES),
    `precondition: explorer must render a folder row for ${DIR_NOTES} (data-dir=true)`,
  );
  assert.ok(files.length >= 3, "precondition: explorer must render multiple file rows");
  return rt;
}

describe("explorer active file highlight", { concurrency: false }, () => {
  test("opening a file marks only the matching file row as selected", async () => {
    const rt = boot();
    try {
      await openWorkspace(rt);
      await rt.win.lightmdOpenFile(FILE_A);

      const active = rowByPath(rt.fileList, FILE_A);
      assert.ok(
        isMarkedSelected(active),
        `after applyFile/open, the matching li[data-dir="false"][data-path="${FILE_A}"] must have aria-selected="true" and/or a selected/active class`,
      );

      const others = fileRows(rt.fileList).filter(
        (row) => String(row.dataset.path) !== FILE_A,
      );
      for (const row of others) {
        assert.equal(
          isMarkedSelected(row),
          false,
          `other file row data-path=${JSON.stringify(row.dataset.path)} must not be selected`,
        );
      }
      assert.equal(
        selectedFileRows(rt.fileList).length,
        1,
        "exactly one file row must be selected after opening a file",
      );
    } finally {
      rt.cleanup();
    }
  });

  test("opening a second file moves the highlight to the new row only", async () => {
    const rt = boot();
    try {
      await openWorkspace(rt);
      await rt.win.lightmdOpenFile(FILE_A);
      await rt.win.lightmdOpenFile(FILE_B);

      const first = rowByPath(rt.fileList, FILE_A);
      const second = rowByPath(rt.fileList, FILE_B);
      assert.equal(
        isMarkedSelected(first),
        false,
        "previous file row must not stay selected after opening another file",
      );
      assert.ok(
        isMarkedSelected(second),
        `only the newly opened row (${FILE_B}) must be selected`,
      );
      assert.equal(
        selectedFileRows(rt.fileList).length,
        1,
        "opening a second file must leave exactly one selected file row",
      );
    } finally {
      rt.cleanup();
    }
  });

  test("folder rows and summaries are never the active file selection", async () => {
    const rt = boot();
    try {
      await openWorkspace(rt);
      await rt.win.lightmdOpenFile(FILE_NESTED);

      const nested = rowByPath(rt.fileList, FILE_NESTED);
      assert.ok(
        isMarkedSelected(nested),
        `opening ${FILE_NESTED} must select the nested file row, not its folder`,
      );

      for (const row of folderRows(rt.fileList)) {
        assert.equal(
          isMarkedSelected(row),
          false,
          `folder row data-dir=true data-path=${JSON.stringify(row.dataset.path)} must never be marked as the active file`,
        );
      }
      for (const summary of summaryRows(rt.fileList)) {
        assert.equal(
          isMarkedSelected(summary),
          false,
          "folder <summary> must never be marked as the active file selection",
        );
      }
    } finally {
      rt.cleanup();
    }
  });

  test("#status-path tracks the open relative path and clears when the file is cleared", async () => {
    const rt = boot();
    try {
      await openWorkspace(rt);
      const status = rt.el("status-path");
      assert.equal(
        String(status.textContent || ""),
        "",
        "#status-path must be empty when no file is open",
      );

      await rt.win.lightmdOpenFile(FILE_A);
      assert.equal(
        status.textContent,
        FILE_A,
        "#status-path textContent must equal the open relative path while a file is open",
      );
      assert.equal(
        rt.win.lightmdWorkspace.relative,
        FILE_A,
        "precondition: currentRelative / lightmdWorkspace.relative must be the open file",
      );

      await rt.win.lightmdOpenFile(FILE_B);
      assert.equal(
        status.textContent,
        FILE_B,
        "#status-path must update to the newly opened relative path",
      );

      await rt.win.lightmdOpenFolder(FOLDER);
      const relative = rt.win.lightmdWorkspace?.relative;
      const cleared = relative == null || relative === "" || relative === false;
      assert.ok(cleared, "Open Folder must clear currentRelative");
      assert.equal(
        String(status.textContent || ""),
        "",
        "#status-path must be empty/cleared when currentRelative is cleared (Open Folder / no file)",
      );
    } finally {
      rt.cleanup();
    }
  });

  test("selected file row CSS uses theme tokens, not a fixed hex", () => {
    const css = styleCss(loadHtml());
    assert.ok(css.trim(), "src/index.html must contain a <style> block");
    const rules = parseRules(css).filter((r) => isSelectedFileRowSelector(r.selector));
    assert.ok(
      rules.length > 0,
      "missing CSS rule for the selected/active explorer file row (#file-list … aria-selected, .selected, or .active)",
    );
    const themed = rules.filter((r) => usesThemeTokens(r.body));
    assert.ok(
      themed.length > 0,
      "selected file row CSS must use theme tokens (--accent and/or --bg-elevated / --fg), not a fixed hex that ignores themes",
    );
    const blob = themed.map((r) => r.body).join("\n");
    assert.equal(
      /outline\s*:\s*1px\s+solid/i.test(blob),
      false,
      "selected file row must not use a 1px solid outline (use fill + accent, not a focus-ring box)",
    );
    assert.match(
      blob,
      /background(?:-color)?\s*:\s*var\(\s*--bg-elevated/,
      "selected file row must fill with --bg-elevated",
    );
    assert.match(
      blob,
      /var\(\s*--accent/,
      "selected file row must mark the active file with --accent",
    );
  });
});
