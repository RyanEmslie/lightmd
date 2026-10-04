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

async function dragSplitter(app, paneId, dx, { steps = 3, pause = 50, settle = true } = {}) {
  const sp = await splitterPoint(app.page, paneId);
  await app.page.mouse.move(sp.x, sp.y);
  await app.page.mouse.down();
  for (let i = 1; i <= steps; i++) {
    await app.page.mouse.move(sp.x + (dx * i) / steps, sp.y);
    await app.page.waitForTimeout(pause);
  }
  await app.page.mouse.up();
  if (settle) await settleLayout(app);
}

function assertWidthsNear(actual, expected, what) {
  for (const id of ["explorer", "editor", "preview"]) {
    assert.ok(
      near(actual[id], expected[id]),
      `${what}: #${id} should stay ${expected[id]}px, got ${actual[id]}px (${JSON.stringify(actual)})`,
    );
  }
}

test("a quick splitter flick saves the widths it ends at, so they survive a file open and a relaunch", async () => {
  const app = await launchApp();
  try {
    await openNote(app);
    await dragSplitter(app, "editor", -210, { steps: 3, pause: 16, settle: false });
    await app.page.waitForTimeout(400);
    const dragged = await paneWidths(app.page);
    const stored = (await storedLayout(app.page)).widths;
    assert.ok(near(stored.editor, dragged.editor), `saved editor width ${stored.editor} must match ${dragged.editor}`);
    assert.ok(near(stored.preview, dragged.preview), `saved preview width ${stored.preview} must match ${dragged.preview}`);

    await app.openFile("other.md");
    await settleLayout(app);
    assertWidthsNear(await paneWidths(app.page), dragged, "after opening another file");

    await app.reload();
    await settleLayout(app);
    assertWidthsNear(await paneWidths(app.page), dragged, "after a relaunch");
    assert.deepEqual(app.errors, []);
  } finally {
    await app.close();
  }
});

async function assertFitsWindow(app, what) {
  const fit = await app.page.evaluate(() => ({
    innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    panes: ["explorer", "editor", "preview"]
      .filter((id) => !document.getElementById(id).hidden)
      .map((id) => {
        const r = document.getElementById(id).getBoundingClientRect();
        return { id, left: r.left, right: r.right, width: r.width };
      }),
  }));
  for (const p of fit.panes) {
    assert.ok(p.right <= fit.innerWidth + 1, `${what}: #${p.id} ends at ${p.right}px, past the ${fit.innerWidth}px window`);
    assert.ok(p.width >= 159, `${what}: #${p.id} is ${p.width}px, under the 160px minimum`);
  }
  assert.ok(fit.scrollWidth <= fit.innerWidth, `${what}: the page scrolls sideways (${fit.scrollWidth}px)`);
}

test("after a drag, a smaller window still shows every pane, including after a relaunch", async () => {
  const app = await launchApp({ viewport: { width: 1600, height: 800 } });
  try {
    await openNote(app);
    await dragSplitter(app, "editor", 150, { pause: 150 });
    await app.page.setViewportSize({ width: 900, height: 800 });
    await settleLayout(app);
    await assertFitsWindow(app, "after shrinking the window");
    await app.reload();
    await settleLayout(app);
    await assertFitsWindow(app, "after a relaunch at the smaller size");
    assert.deepEqual(app.errors, []);
  } finally {
    await app.close();
  }
});

test("the explorer keeps its width when the window grows and shrinks", async () => {
  const app = await launchApp();
  try {
    await openNote(app);
    const start = (await paneWidths(app.page)).explorer;
    assert.ok(near(start, 240), `the explorer starts at 240px, got ${start}px`);
    await app.page.setViewportSize({ width: 2400, height: 800 });
    await app.openFile("other.md");
    await settleLayout(app);
    assert.ok(near((await paneWidths(app.page)).explorer, start), "a wide window must not widen the explorer");
    await app.page.setViewportSize({ width: 1200, height: 800 });
    await app.openFile("note.md");
    await settleLayout(app);
    assert.ok(near((await paneWidths(app.page)).explorer, start), "the explorer must not keep a width it was stretched to");
    await app.reload();
    await settleLayout(app);
    assert.ok(near((await paneWidths(app.page)).explorer, start), "a relaunch must not restore a stretched explorer");
    assert.deepEqual(app.errors, []);
  } finally {
    await app.close();
  }
});

test("closing Settings and toggling the explorer keep a dragged editor/preview split", async () => {
  const app = await launchApp();
  try {
    await openNote(app);
    await dragSplitter(app, "editor", 180, { pause: 150 });
    const dragged = await paneWidths(app.page);
    await app.page.click("#settings-open");
    await app.page.click("#settings-close");
    await settleLayout(app);
    assertWidthsNear(await paneWidths(app.page), dragged, "after closing Settings");

    await app.page.click("#sidebar-toggle");
    await settleLayout(app);
    await app.page.keyboard.press("ControlOrMeta+1");
    await settleLayout(app);
    assertWidthsNear(await paneWidths(app.page), dragged, "after hiding and showing the explorer");
    assert.deepEqual(app.errors, []);
  } finally {
    await app.close();
  }
});

test("with the explorer hidden, visible controls reopen it and open Settings", async () => {
  const app = await launchApp();
  try {
    await openNote(app);
    await app.page.click("#sidebar-toggle");
    await settleLayout(app);
    assert.equal(await app.page.locator("#explorer").isHidden(), true, "precondition: the explorer is hidden");
    const toggle = app.page.locator("#explorer-reopen-toggle");
    const settings = app.page.locator("#explorer-reopen-settings");
    assert.equal(await toggle.isVisible(), true, "a sidebar button must stay visible");
    assert.equal(await settings.isVisible(), true, "a Settings button must stay visible");

    // The controls must not sit on top of the first pane's content.
    const rail = await app.page.locator("#explorer-reopen").boundingBox();
    const editor = await app.page.locator("#editor").boundingBox();
    assert.ok(editor.x >= rail.x + rail.width - 1, `the editor (x=${editor.x}) must start right of the controls (to ${rail.x + rail.width})`);
    await assertFitsWindow(app, "with the reopen controls showing");

    await settings.click();
    assert.equal(await app.page.locator("#settings").isVisible(), true, "the Settings button opens Settings");
    await app.page.click("#settings-close");
    await toggle.click();
    await settleLayout(app);
    assert.equal(await app.page.locator("#explorer").isVisible(), true, "the sidebar button reopens the explorer");
    assert.equal(await app.page.locator("#explorer-reopen").isHidden(), true, "the controls hide again");
    assert.deepEqual(app.errors, []);
  } finally {
    await app.close();
  }
});

test("the pane shortcuts cannot hide every pane, so a relaunch is never blank", async () => {
  const app = await launchApp();
  try {
    await openNote(app);
    await app.page.click(".cm-content");
    for (const key of ["3", "2", "1"]) await app.page.keyboard.press(`ControlOrMeta+${key}`);
    await settleLayout(app);
    const shown = async () => Object.values(await paneWidths(app.page)).filter((w) => w > 0).length;
    assert.ok((await shown()) >= 1, "a pane must stay visible");
    await app.reload();
    await settleLayout(app);
    assert.ok((await shown()) >= 1, "a relaunch must show a pane");
    assert.deepEqual(app.errors, []);
  } finally {
    await app.close();
  }
});

test("Settings changes survive a relaunch and apply before the editor mounts", async () => {
  const app = await launchApp();
  try {
    await openNote(app, { "note.md": "# Note\n" });
    await app.page.click("#settings-open");
    await app.page.check("#show-line-numbers");
    await app.page.uncheck("#settings-word-wrap");
    await app.page.fill("#editor-font-size", "18");
    await app.page.locator("#editor-font-size").dispatchEvent("change");
    await app.page.uncheck("#show-extensions");
    await app.page.click("#settings-close");

    await app.reload();
    const state = await app.page.evaluate(() => ({
      gutter: !!document.querySelector("#editor-view .cm-lineNumbers"),
      wrapping: document.querySelector("#editor-view .cm-content").classList.contains("cm-lineWrapping"),
      fontSize: getComputedStyle(document.querySelector("#editor-view .cm-content")).fontSize,
      lineNumbersBox: document.getElementById("show-line-numbers").checked,
      fontBox: document.getElementById("editor-font-size").value,
    }));
    assert.deepEqual(state, {
      gutter: true,
      wrapping: false,
      fontSize: "18px",
      lineNumbersBox: true,
      fontBox: "18",
    });
    await app.openFolder();
    assert.equal(
      (await app.page.locator('#file-list li[data-path="note.md"]').innerText()).trim(),
      "note",
      "file extensions stay hidden after a relaunch",
    );
    assert.deepEqual(app.errors, []);
  } finally {
    await app.close();
  }
});
