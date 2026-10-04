import assert from "node:assert/strict";
import { test } from "node:test";
import { launchApp } from "./helpers/app.mjs";

// Short paragraphs, so a wider preview does not reflow and change its height.
const NOTE = Array.from({ length: 300 }, (_, i) => `line ${i}`).join("\n\n");

// Rendered widths of the three panes (0 when hidden).
function paneWidths(page) {
  return page.evaluate(() =>
    Object.fromEntries(
      ["explorer", "editor", "preview"].map((id) => {
        const el = document.getElementById(id);
        return [id, el.hidden ? 0 : el.getBoundingClientRect().width];
      }),
    ),
  );
}

function storedLayout(page) {
  return page.evaluate(() => JSON.parse(localStorage.getItem("lightmd.layout") || "null"));
}

async function splitterPoint(page, paneId) {
  const box = await page.locator(`#${paneId} > .splitter`).boundingBox();
  assert.ok(box, `#${paneId} must have a visible splitter`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

function near(actual, expected, tolerance = 2) {
  return Math.abs(actual - expected) <= tolerance;
}

// Poll until a pane reaches a width; fail with the last width seen.
async function waitForWidth(app, id, want, what) {
  let last = null;
  try {
    await app.waitFor(
      async () => {
        last = (await paneWidths(app.page))[id];
        return near(last, want);
      },
      { timeout: 1000, message: what },
    );
  } catch {
    assert.fail(`${what}: wanted #${id} at ${want}px, got ${last}px`);
  }
}

// Wait out the 120ms grid-template-columns transition before measuring.
async function settleLayout(app) {
  await app.settle();
  await app.page.waitForTimeout(250);
}

async function openNote(app, files = { "note.md": NOTE, "other.md": "# Other\n" }) {
  for (const [name, text] of Object.entries(files)) app.files.set(name, text);
  await app.openFolder();
  await app.openFile("note.md");
  await settleLayout(app);
}

test("a multi-step splitter drag tracks the pointer and ends at the expected width", async () => {
  const app = await launchApp();
  try {
    await openNote(app);
    const start = await paneWidths(app.page);
    const sp = await splitterPoint(app.page, "editor");
    await app.page.mouse.move(sp.x, sp.y);
    await app.page.mouse.down();
    for (let i = 1; i <= 4; i++) {
      await app.page.mouse.move(sp.x - 40 * i, sp.y);
      await waitForWidth(app, "editor", start.editor - 40 * i, `the editor follows the pointer on move ${i}`);
    }
    await app.page.mouse.up();
    await app.settle();
    const end = await paneWidths(app.page);
    assert.ok(near(end.editor, start.editor - 160), `editor ends at ${start.editor - 160}px, got ${end.editor}px`);
    assert.ok(near(end.preview, start.preview + 160), `preview ends at ${start.preview + 160}px, got ${end.preview}px`);
    assert.ok(near(end.explorer, start.explorer), "the explorer must not move");
    assert.deepEqual(app.errors, []);
  } finally {
    await app.close();
  }
});

// The editor reports its top visible line: CodeMirror may nudge scrollTop by a
// few pixels as it re-measures lines, but a reset jumps back to line 1.
function scrollState(page) {
  return page.evaluate(() => {
    const view = window.lightmdEditor.view;
    const block = view.lineBlockAtHeight(view.scrollDOM.scrollTop);
    return {
      fileList: document.getElementById("file-list").scrollTop,
      editorLine: view.state.doc.lineAt(block.from).number,
      editor: view.scrollDOM.scrollTop,
      preview: document.getElementById("preview-body").scrollTop,
    };
  });
}

test("opening a file and toggling a pane keep every pane's scroll position", async () => {
  const app = await launchApp({ viewport: { width: 1200, height: 500 } });
  try {
    const files = { "note.md": NOTE };
    for (let i = 0; i < 120; i++) files[`file-${String(i).padStart(3, "0")}.md`] = `# File ${i}\n`;
    await openNote(app, files);
    await app.page.evaluate(() => {
      document.getElementById("file-list").scrollTop = 600;
      window.lightmdEditor.view.scrollDOM.scrollTop = 1500;
      document.getElementById("preview-body").scrollTop = 1200;
    });
    await settleLayout(app);
    const before = await scrollState(app.page);
    assert.ok(before.fileList > 0 && before.editor > 0 && before.preview > 0, "precondition: every pane is scrolled");

    // Clicking a visible row in the scrolled explorer must not jump it to the top.
    const row = await app.page.evaluate(() => {
      const list = document.getElementById("file-list");
      const top = list.getBoundingClientRect().top;
      const li = [...list.querySelectorAll('li[data-dir="false"]')].find(
        (el) => el.getBoundingClientRect().top > top + 40,
      );
      return li.dataset.path;
    });
    await app.openFile(row);
    assert.equal((await scrollState(app.page)).fileList, before.fileList, "the explorer keeps its scroll on file open");

    await app.openFile("note.md");
    await app.page.evaluate(() => {
      window.lightmdEditor.view.scrollDOM.scrollTop = 1500;
      document.getElementById("preview-body").scrollTop = 1200;
    });
    await settleLayout(app);
    const scrolled = await scrollState(app.page);
    assert.ok(scrolled.editorLine > 20, "precondition: the editor is scrolled well past the top");
    await app.page.click("#sidebar-toggle");
    await settleLayout(app);
    const after = await scrollState(app.page);
    assert.ok(
      Math.abs(after.editorLine - scrolled.editorLine) <= 2,
      `the editor keeps its scroll when the explorer is hidden (top line ${scrolled.editorLine} -> ${after.editorLine})`,
    );
    assert.equal(after.preview, scrolled.preview, "the preview keeps its scroll when the explorer is hidden");
    assert.deepEqual(app.errors, []);
  } finally {
    await app.close();
  }
});

test("toggling the preview with the keyboard keeps focus in the editor", async () => {
  const app = await launchApp();
  try {
    await openNote(app, { "note.md": "start" });
    await app.type("A");
    await app.page.keyboard.press("ControlOrMeta+3");
    await app.settle();
    assert.equal(
      await app.page.evaluate(() => document.getElementById("preview").hidden),
      true,
      "precondition: the shortcut hid the preview",
    );
    assert.equal(
      await app.page.evaluate(() => window.lightmdEditor.view.hasFocus),
      true,
      "the editor must keep focus after the layout changes",
    );
    await app.page.keyboard.type("B");
    assert.equal(await app.editorText(), "startAB");
    assert.deepEqual(app.errors, []);
  } finally {
    await app.close();
  }
});
