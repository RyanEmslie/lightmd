import {
  palettes,
  theme,
  setTheme,
} from "./palettes.js";
import { autosave, cancelAutosave } from "./autosave.js";
import { session, persistSession } from "./session.js";
import { htmlJs, setHtmlJsEnabled } from "./html-viewer.js";
import { preview } from "./preview.js";
import { findOptions } from "./find.js";
import { layout, persistLayout, refreshLayout } from "./layout.js";

export {
  palettes,
  theme,
  setTheme,
};

export const editorDefaults = {
  lineWrapping: true,
  lineNumbers: false,
  highlightActiveLine: false,
  tabSize: 4,
  softTabs: true,
  fontSize: 14,
  lineHeight: 1.45,
  frontmatter: true,
};

export const previewDefaults = {
  fontSize: 16,
  lineHeight: 1.55,
};

export const defaults = {
  theme: "Tokyo Night",
  wrap: true,
  lineWrapping: true,
  lineNumbers: false,
  livePreview: true,
  frontmatter: true,
  autosave: true,
  sessionRestore: true,
  htmlJs: false,
};

function doc() {
  return typeof globalThis.document !== "undefined" ? globalThis.document : null;
}

function editorApi() {
  try {
    return globalThis.lightmdEditor;
  } catch {
    return undefined;
  }
}

export function openSettings() {
  const d = doc();
  const panel = d?.getElementById("settings");
  const shell = d?.getElementById("shell");
  if (panel) panel.hidden = false;
  if (shell) {
    shell.hidden = true;
    if (shell.style) shell.style.display = "none";
  }
}

export function closeSettings() {
  const d = doc();
  const panel = d?.getElementById("settings");
  const shell = d?.getElementById("shell");
  if (panel) panel.hidden = true;
  if (shell) {
    shell.hidden = false;
    if (shell.style) shell.style.display = "";
    refreshLayout();
  }
}

export function toggleSettings() {
  const d = doc();
  const panel = d?.getElementById("settings");
  if (!panel) return;
  if (panel.hidden) openSettings();
  else closeSettings();
}

function applyPreviewFont() {
  const d = doc();
  const el = d && d.getElementById("preview-body");
  if (!el || !el.style) return;
  el.style.fontSize = `${previewDefaults.fontSize}px`;
  el.style.lineHeight = String(previewDefaults.lineHeight);
}

function paletteNames() {
  return Object.keys(palettes);
}

function fillThemeSelect(select, selected) {
  if (!select) return;
  const names = paletteNames();
  if (typeof select.replaceChildren === "function") select.replaceChildren();
  else if ("innerHTML" in select) select.innerHTML = "";
  else if (Array.isArray(select.children)) select.children.length = 0;
  for (const name of names) {
    const opt = doc().createElement("option");
    opt.value = name;
    opt.textContent = name;
    if (name === selected) opt.selected = true;
    if (typeof select.append === "function") select.append(opt);
    else if (typeof select.appendChild === "function") select.appendChild(opt);
  }
  if (typeof selected === "string") select.value = selected;
}

function applyNamedTheme(value) {
  setTheme(value);
  persistSession({ theme: value });
}

function syncThemeCards() {
  const d = doc();
  const container = d?.getElementById("theme-cards");
  if (!container || typeof d.createElement !== "function") return;
  if (typeof container.replaceChildren === "function") container.replaceChildren();
  else container.innerHTML = "";
  for (const name of paletteNames()) {
    const palette = palettes[name];
    const button = d.createElement("button");
    button.type = "button";
    button.className = "theme-swatch";
    button.dataset.themeName = name;
    button.setAttribute("aria-pressed", name === theme.name ? "true" : "false");
    button.setAttribute("aria-label", `Use ${name} theme`);
    button.style.setProperty("--theme-bg", palette["--bg"]);
    button.style.setProperty("--theme-surface", palette["--bg-elevated"]);
    button.style.setProperty("--theme-fg", palette["--fg"]);
    button.style.setProperty("--theme-fg-muted", palette["--fg-muted"]);
    button.style.setProperty("--theme-border", palette["--border"]);
    button.style.setProperty("--theme-highlight", palette["--accent"]);
    const preview = d.createElement("span");
    preview.className = "theme-swatch-preview";
    for (let index = 0; index < 3; index += 1) preview.append(d.createElement("i"));
    const label = d.createElement("span");
    label.className = "theme-swatch-label";
    label.textContent = name;
    button.append(preview, label);
    button.addEventListener("click", () => applyNamedTheme(name));
    container.append(button);
  }
}

function syncThemeSelects() {
  const d = doc();
  if (!d) return;
  const settingsTheme = d.getElementById("settings-theme");
  fillThemeSelect(settingsTheme, theme.name);
  syncThemeCards();
}

function syncWorkspaceControls() {}

function syncHtmlJsControl() {
  const d = doc();
  const el = d && d.getElementById("settings-html-js");
  if (el) el.checked = !!htmlJs.enabled;
}

function syncFromState() {
  const d = doc();
  if (!d || typeof d.getElementById !== "function") return;
  const editorSize = d.getElementById("editor-font-size");
  if (editorSize) editorSize.value = String(editorDefaults.fontSize);
  const editorLh = d.getElementById("editor-line-height");
  if (editorLh) editorLh.value = String(editorDefaults.lineHeight);
  const previewSize = d.getElementById("preview-font-size");
  if (previewSize) previewSize.value = String(previewDefaults.fontSize);
  const previewLh = d.getElementById("preview-line-height");
  if (previewLh) previewLh.value = String(previewDefaults.lineHeight);
  const activeLine = d.getElementById("highlight-active-line");
  if (activeLine) activeLine.checked = !!editorDefaults.highlightActiveLine;
  const lineNumbers = d.getElementById("show-line-numbers");
  if (lineNumbers) lineNumbers.checked = !!editorDefaults.lineNumbers;
  const wrap = d.getElementById("settings-word-wrap");
  if (wrap) wrap.checked = !!editorDefaults.lineWrapping;
  const tabSize = d.getElementById("settings-tab-size");
  if (tabSize) tabSize.value = String(editorDefaults.tabSize);
  const softTabs = d.getElementById("settings-soft-tabs");
  if (softTabs) softTabs.checked = !!editorDefaults.softTabs;
  const autosaveMode = d.getElementById("settings-autosave");
  if (autosaveMode) autosaveMode.value = autosave.enabled ? "delayed" : "off";
  const autosaveDelay = d.getElementById("settings-autosave-delay");
  if (autosaveDelay) autosaveDelay.value = String(autosave.delay);
  const restore = d.getElementById("settings-session-restore");
  if (restore) restore.checked = !!session.restore;
  const findCase = d.getElementById("settings-find-case");
  if (findCase) findCase.checked = !!findOptions.caseSensitive;
  const findWhole = d.getElementById("settings-find-whole-word");
  if (findWhole) findWhole.checked = !!findOptions.wholeWord;
  const live = d.getElementById("settings-live-preview");
  if (live) live.checked = !!preview.live;
  const frontmatter = d.getElementById("settings-frontmatter");
  if (frontmatter) frontmatter.checked = !!editorDefaults.frontmatter;
  const gfm = d.getElementById("settings-gfm");
  if (gfm) gfm.checked = true;
  const folder = d.getElementById("settings-default-folder");
  if (folder) folder.value = session.defaultFolder == null ? "" : String(session.defaultFolder);
  const remember = d.getElementById("settings-remember-layout");
  if (remember) remember.checked = layout.remember !== false;
  syncThemeSelects();
  syncWorkspaceControls();
  syncHtmlJsControl();
}

function on(el, type, fn) {
  if (el && typeof el.addEventListener === "function") el.addEventListener(type, fn);
}

let bound = false;

export function bindSettings() {
  const d = doc();
  if (!d || typeof d.getElementById !== "function") return;
  if (bound) {
    syncFromState();
    return;
  }
  bound = true;

  on(d.getElementById("settings-open"), "click", () => {
    toggleSettings();
  });
  on(d.getElementById("explorer-reopen-settings"), "click", () => {
    openSettings();
  });
  on(d.getElementById("settings-close"), "click", () => {
    closeSettings();
  });

  function applySelectedTheme(value) {
    applyNamedTheme(value);
    const settingsTheme = d.getElementById("settings-theme");
    if (settingsTheme) settingsTheme.value = value;
    syncThemeCards();
  }
  on(d.getElementById("settings-theme"), "change", (event) => {
    applySelectedTheme(event.target.value);
  });

  for (const item of d.querySelectorAll?.("[data-settings-target]") || []) {
    on(item, "click", () => {
      const target = d.getElementById(`settings-${item.getAttribute("data-settings-target")}`);
      if (target?.scrollIntoView) target.scrollIntoView({ behavior: "smooth", block: "start" });
      for (const nav of d.querySelectorAll?.("[data-settings-target]") || []) {
        nav.classList?.toggle("is-active", nav === item);
      }
    });
  }
  on(d.getElementById("settings-search"), "input", (event) => {
    const query = String(event.target.value || "").trim().toLowerCase();
    const sections = [...(d.querySelectorAll?.("[data-settings-section]") || [])];
    let matches = 0;
    for (const section of sections) {
      const match = !query || String(section.textContent || "").toLowerCase().includes(query);
      section.hidden = !match;
      if (match) matches += 1;
    }
    for (const item of d.querySelectorAll?.("[data-settings-target]") || []) {
      const target = d.getElementById(`settings-${item.getAttribute("data-settings-target")}`);
      item.hidden = !!query && !target?.hidden;
    }
    const noResults = d.getElementById("settings-no-results");
    if (noResults) noResults.hidden = matches !== 0;
  });

  on(d.getElementById("editor-font-size"), "change", (event) => {
    const n = Number(event.target.value);
    if (!Number.isFinite(n) || n <= 0) return;
    editorDefaults.fontSize = n;
    editorApi()?.setEditorFont?.(editorDefaults.fontSize, editorDefaults.lineHeight);
  });
  on(d.getElementById("editor-line-height"), "change", (event) => {
    const n = Number(event.target.value);
    if (!Number.isFinite(n) || n <= 0) return;
    editorDefaults.lineHeight = n;
    editorApi()?.setEditorFont?.(editorDefaults.fontSize, editorDefaults.lineHeight);
  });
  on(d.getElementById("preview-font-size"), "change", (event) => {
    const n = Number(event.target.value);
    if (!Number.isFinite(n) || n <= 0) return;
    previewDefaults.fontSize = n;
    applyPreviewFont();
  });
  on(d.getElementById("preview-line-height"), "change", (event) => {
    const n = Number(event.target.value);
    if (!Number.isFinite(n) || n <= 0) return;
    previewDefaults.lineHeight = n;
    applyPreviewFont();
  });
  on(d.getElementById("highlight-active-line"), "change", (event) => {
    editorApi()?.setHighlightActiveLine?.(!!event.target.checked);
  });
  on(d.getElementById("show-line-numbers"), "change", (event) => {
    editorApi()?.setLineNumbers?.(!!event.target.checked);
  });
  on(d.getElementById("settings-word-wrap"), "change", (event) => {
    editorApi()?.setLineWrapping?.(!!event.target.checked);
  });
  on(d.getElementById("settings-tab-size"), "change", (event) => {
    const n = Number(event.target.value);
    if (!Number.isFinite(n) || n <= 0) return;
    editorApi()?.setTabSize?.(n);
  });
  on(d.getElementById("settings-soft-tabs"), "change", (event) => {
    editorApi()?.setSoftTabs?.(!!event.target.checked);
  });

  function applyAutosaveFromControls() {
    const mode = d.getElementById("settings-autosave");
    const delayEl = d.getElementById("settings-autosave-delay");
    autosave.enabled = mode ? mode.value !== "off" : true;
    const delay = delayEl ? Number(delayEl.value) : autosave.delay;
    if (Number.isFinite(delay) && delay > 0) autosave.delay = delay;
    if (!autosave.enabled) cancelAutosave();
  }
  on(d.getElementById("settings-autosave"), "change", applyAutosaveFromControls);
  on(d.getElementById("settings-autosave-delay"), "change", applyAutosaveFromControls);

  on(d.getElementById("settings-session-restore"), "change", (event) => {
    session.restore = !!event.target.checked;
    persistSession({ restore: session.restore });
  });
  on(d.getElementById("settings-find-case"), "change", (event) => {
    findOptions.caseSensitive = !!event.target.checked;
  });
  on(d.getElementById("settings-find-whole-word"), "change", (event) => {
    findOptions.wholeWord = !!event.target.checked;
  });
  on(d.getElementById("settings-live-preview"), "change", (event) => {
    preview.live = !!event.target.checked;
  });
  on(d.getElementById("settings-frontmatter"), "change", (event) => {
    editorApi()?.setShowFrontmatter?.(!!event.target.checked);
  });
  on(d.getElementById("settings-html-js"), "change", (event) => {
    setHtmlJsEnabled(!!event.target.checked);
    persistSession({ htmlJs: !!event.target.checked });
  });
  on(d.getElementById("html-js"), "change", () => {
    syncHtmlJsControl();
  });

  on(d.getElementById("settings-default-folder"), "change", (event) => {
    persistSession({ defaultFolder: event.target.value });
  });
  on(d.getElementById("settings-remember-layout"), "change", (event) => {
    layout.remember = !!event.target.checked;
    persistLayout();
  });

  syncFromState();
}

export function mountSettings() {
  bindSettings();
}

if (doc() && typeof doc().getElementById === "function") {
  try {
    bindSettings();
  } catch (err) {
    console.error("LightMD: could not bind Settings", err);
  }
}
