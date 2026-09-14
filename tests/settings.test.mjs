import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { loadSourceFiles, collectFiles } from "./helpers/source.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(root, "src");
const pkgPath = join(root, "package.json");

const GROUPS = [
  { name: "Appearance", re: /\bAppearance\b/ },
  { name: "Editor", re: /(?:^|[\n>"'`])Editor(?:[\n<"'`]|$)/m },
  { name: "Preview and HTML", re: /Preview\s+(?:and|&)\s+HTML/i },
  { name: "Workspace", re: /\bWorkspace\b/ },
  { name: "Keyboard", re: /\bKeyboard\b/ },
  { name: "About", re: /\bAbout\b/ },
];

const PANEL_TAGS = String.raw`dialog|aside|section|div|form|article|nav|template`;
const PANEL_ID = String.raw`settings(?:[-_](?:panel|dialog|overlay|window|view|page|modal))?`;
const PANEL_CLASS = String.raw`settings(?:[-_](?:panel|dialog|overlay|window|view|page|modal))?`;
const OPENER_ID =
  String.raw`(?:open|show|toggle)[-_]?settings|settings[-_]?(?:open|btn|button|toggle|trigger|control|menu)`;
const OPEN_FN = String.raw`openSettings|showSettings|toggleSettings|openSettingsPanel`;

const REPO_RE = /https?:\/\/github\.com\/clearly-bots\/lightmd\b/i;


function loadSources() {
  return loadSourceFiles();
}

function joinedSource(files = loadSources()) {
  return files.map((f) => f.text).join("\n");
}

function isSettingsPath(p) {
  return /settings/i.test(p);
}

function stripComments(src) {
  return String(src || "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function withoutStyles(src) {
  return String(src || "").replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "");
}

function cssFromFiles(files) {
  const chunks = [];
  for (const f of files) {
    if (/\.css$/i.test(f.path)) {
      chunks.push(f.text);
      continue;
    }
    const re = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
    let m;
    while ((m = re.exec(f.text))) chunks.push(m[1]);
  }
  return chunks.join("\n");
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

function windowsAround(src, re, before, after) {
  const out = [];
  const copy = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
  let m;
  while ((m = copy.exec(src))) {
    const start = Math.max(0, m.index - before);
    const end = Math.min(src.length, m.index + m[0].length + after);
    out.push(src.slice(start, end));
  }
  return out;
}

function firstOf(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function asBool(value) {
  return typeof value === "boolean" ? value : undefined;
}

function controlIdRe(idAlt) {
  const id = `(?:${idAlt})`;
  return new RegExp(
    String.raw`(?:\bid=["']${id}["']|\bfor=["']${id}["']|\bname=["']${id}["']|getElementById\(\s*["']${id}["']\s*\)|querySelector(?:All)?\(\s*["']#${id}["']\s*\)|\.id\s*=\s*["']${id}["'])`,
    "i",
  );
}

function hasControlId(src, idAlt) {
  return controlIdRe(idAlt).test(src);
}

function hasSelectOrControlMarkup(src, idAlt) {
  const id = `(?:${idAlt})`;
  const tag = new RegExp(
    String.raw`<(?:select|input|button|a)\b[^>]*(?:\bid=["']${id}["']|\bname=["']${id}["'])`,
    "i",
  );
  const role = new RegExp(
    String.raw`<(?:div|span|button|input|select|a)\b[^>]*(?:\bid=["']${id}["'][^>]*role=["'](?:combobox|listbox|button)["']|role=["'](?:combobox|listbox|button)["'][^>]*\bid=["']${id}["'])`,
    "i",
  );
  const created = new RegExp(
    String.raw`createElement\(\s*["'](?:select|input|button|a)["']\s*\)[\s\S]{0,400}\.id\s*=\s*["']${id}["']`,
    "i",
  );
  const createdFlip = new RegExp(
    String.raw`\.id\s*=\s*["']${id}["'][\s\S]{0,400}createElement\(\s*["'](?:select|input|button|a)["']\s*\)`,
    "i",
  );
  return (
    tag.test(src) ||
    role.test(src) ||
    created.test(src) ||
    createdFlip.test(src) ||
    hasControlId(src, idAlt)
  );
}

function extractElement(src, openMatch) {
  const tag = openMatch[1];
  const start = openMatch.index;
  const openTag = openMatch[0];
  if (/\/>\s*$/.test(openTag)) return openTag;
  const lower = String(tag).toLowerCase();
  const openRe = new RegExp(String.raw`<${lower}\b`, "gi");
  const closeRe = new RegExp(String.raw`</${lower}\s*>`, "gi");
  let depth = 1;
  let i = start + openTag.length;
  while (i < src.length && depth > 0) {
    openRe.lastIndex = i;
    closeRe.lastIndex = i;
    const nextOpen = openRe.exec(src);
    const nextClose = closeRe.exec(src);
    if (!nextClose) break;
    if (nextOpen && nextOpen.index < nextClose.index) {
      depth += 1;
      i = nextOpen.index + nextOpen[0].length;
    } else {
      depth -= 1;
      i = nextClose.index + nextClose[0].length;
    }
  }
  return src.slice(start, i || Math.min(src.length, start + 12000));
}

function panelOpenRe() {
  return new RegExp(
    String.raw`<(${PANEL_TAGS})\b[^>]*(?:\bid=["']${PANEL_ID}["']|\bclass=["'][^"']*\b${PANEL_CLASS}\b)[^>]*>`,
    "i",
  );
}

function findSettingsPanelMarkup(src) {
  const html = withoutStyles(src);
  const re = panelOpenRe();
  const m = html.match(re);
  if (!m) return "";
  return extractElement(html, m);
}

function jsCreatedPanel(src) {
  const html = withoutStyles(src);
  const created = new RegExp(
    String.raw`createElement\(\s*["'](?:${PANEL_TAGS})["']\s*\)[\s\S]{0,500}(?:\.id\s*=\s*["']${PANEL_ID}["']|classList\.add\(\s*["']${PANEL_CLASS}["']|className\s*=\s*["'][^"']*\b${PANEL_CLASS}\b)`,
    "i",
  );
  const createdFlip = new RegExp(
    String.raw`(?:\.id\s*=\s*["']${PANEL_ID}["']|classList\.add\(\s*["']${PANEL_CLASS}["']|className\s*=\s*["'][^"']*\b${PANEL_CLASS}\b)[\s\S]{0,500}createElement\(\s*["'](?:${PANEL_TAGS})["']\s*\)`,
    "i",
  );
  return created.test(html) || createdFlip.test(html);
}

function jsSettingsMarkup(src) {
  const chunks = [];
  const re =
    /(?:innerHTML|insertAdjacentHTML|outerHTML)\s*[+]?=\s*(?:[^,;]*?,\s*)?([`'"])([\s\S]*?)\1/g;
  let m;
  while ((m = re.exec(src))) {
    if (panelOpenRe().test(m[2]) || /<(?:h[1-6]|legend)[^>]*>\s*Appearance\s*</i.test(m[2])) {
      chunks.push(m[2]);
    }
  }
  return chunks.join("\n");
}

function fnBodies(src, namesAlt) {
  const cleaned = stripComments(src);
  const bodies = [];
  const patterns = [
    new RegExp(
      String.raw`(?:export\s+)?function\s+(?:${namesAlt})\s*\([^)]*\)\s*\{`,
      "gi",
    ),
    new RegExp(
      String.raw`(?:export\s+)?(?:const|let|var)\s+(?:${namesAlt})\s*=\s*(?:async\s*)?(?:function\s*)?\([^)]*\)\s*(?:=>\s*)?\{`,
      "gi",
    ),
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(cleaned))) {
      const brace = cleaned.indexOf("{", m.index);
      if (brace < 0) continue;
      let depth = 0;
      for (let i = brace; i < cleaned.length; i++) {
        if (cleaned[i] === "{") depth += 1;
        else if (cleaned[i] === "}") {
          depth -= 1;
          if (depth === 0) {
            bodies.push(cleaned.slice(brace, i + 1));
            break;
          }
        }
      }
    }
  }
  return bodies;
}

function hasSettingsPanel(src) {
  if (findSettingsPanelMarkup(src)) return true;
  if (jsCreatedPanel(src)) return true;
  if (jsSettingsMarkup(src)) return true;
  return false;
}

function hasSettingsOpener(src) {
  const markup = withoutStyles(src);
  if (hasSelectOrControlMarkup(markup, OPENER_ID)) return true;
  if (/<(?:button|a|summary)\b[^>]*>\s*Settings\s*</i.test(markup)) return true;
  if (
    /<(?:button|a|input|summary)\b[^>]*(?:aria-label|title)=["']Settings["']/i.test(
      markup,
    )
  ) {
    return true;
  }
  if (
    /<(?:button|a|input)\b[^>]*(?:aria-controls|popovertarget)=["']settings["']/i.test(
      markup,
    )
  ) {
    return true;
  }
  const namedFn = new RegExp(String.raw`\b(?:${OPEN_FN})\s*\(`).test(markup);
  const clickOpens =
    /addEventListener\(\s*["']click["'][\s\S]{0,400}(?:settings|\.hidden\s*=\s*false|showModal|classList\.remove)/i.test(
      markup,
    ) ||
    /(?:openSettings|showSettings|toggleSettings)[\s\S]{0,200}addEventListener\(\s*["']click["']/i.test(
      markup,
    );
  if (namedFn && (clickOpens || hasSelectOrControlMarkup(markup, OPENER_ID))) {
    return true;
  }
  if (
    clickOpens &&
    /getElementById\(\s*["']settings["']\s*\)|querySelector\(\s*["'](?:#settings|\.settings)["']\s*\)/.test(
      markup,
    )
  ) {
    return /<(?:button|a|summary)\b/i.test(markup) || hasControlId(markup, OPENER_ID);
  }
  return false;
}

function settingsBlob(files) {
  const chunks = [];
  for (const f of files) {
    const cleaned = stripComments(f.text);
    if (isSettingsPath(f.path)) chunks.push(cleaned);
    const panel = findSettingsPanelMarkup(cleaned);
    if (panel) chunks.push(panel);
    const generated = jsSettingsMarkup(cleaned);
    if (generated) chunks.push(generated);
    if (jsCreatedPanel(cleaned)) {
      chunks.push(
        ...windowsAround(
          cleaned,
          /settings/gi,
          200,
          800,
        ),
      );
    }
    chunks.push(
      ...fnBodies(
        cleaned,
        String.raw`openSettings|showSettings|toggleSettings|renderSettings|mountSettings|createSettings|buildSettings|settingsPanel`,
      ),
    );
  }
  return chunks.join("\n");
}

function openingSettings() {
  const files = loadSources();
  const src = stripComments(joinedSource(files));
  return {
    files,
    src,
    panel: hasSettingsPanel(src),
    opener: hasSettingsOpener(src),
    blob: settingsBlob(files),
    css: cssFromFiles(files),
  };
}

function assertOpensSettings(opened) {
  assert.ok(
    opened.panel,
    "opening Settings requires a #settings or .settings panel",
  );
  assert.ok(
    opened.opener,
    "opening Settings requires a control that opens it",
  );
}

function hasGroup(blob, group) {
  const heading = new RegExp(
    String.raw`<(?:h[1-6]|legend|summary|dt|header|label|span|div|button|section)[^>]*>\s*${group.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\s*<`,
    "i",
  );
  const attr = new RegExp(
    String.raw`(?:aria-label|data-(?:group|section|title)|title)=["']${group.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']`,
    "i",
  );
  const assigned = new RegExp(
    String.raw`(?:textContent|innerText|innerHTML)\s*=\s*["'\`](?:<[^>]+>)?\s*${group.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\s*(?:<[^>]+>)?["'\`]`,
    "i",
  );
  if (heading.test(blob) || attr.test(blob) || assigned.test(blob)) return true;
  if (group.name === "Editor") {
    return /<(?:h[1-6]|legend|summary|dt)[^>]*>\s*Editor\s*</i.test(blob);
  }
  return group.re.test(blob);
}

function missingGroups(blob) {
  return GROUPS.filter((g) => !hasGroup(blob, g)).map((g) => g.name);
}

function sectionFrom(blob, name, restNames) {
  const startRe = new RegExp(String.raw`\b${name}\b`);
  const start = blob.search(startRe);
  if (start < 0) return "";
  const rest = blob.slice(start);
  const next = new RegExp(String.raw`\b(?:${restNames.join("|")})\b`);
  const skip = rest.slice(name.length);
  const idx = skip.search(next);
  if (idx < 0) return rest;
  return rest.slice(0, name.length + idx);
}

function appearanceSection(blob) {
  return sectionFrom(blob, "Appearance", [
    "Editor",
    "Preview",
    "Workspace",
    "Keyboard",
    "About",
  ]);
}

function keyboardSection(blob) {
  return sectionFrom(blob, "Keyboard", [
    "Appearance",
    "Editor",
    "Preview",
    "Workspace",
    "About",
  ]);
}

function aboutSection(blob) {
  return sectionFrom(blob, "About", [
    "Appearance",
    "Editor",
    "Preview",
    "Workspace",
    "Keyboard",
  ]);
}

function looksLike36pxHeight(text) {
  return (
    /(?:min-)?(?:height|line-height)\s*:\s*36px/.test(text) ||
    /(?:min-)?(?:height|lineHeight)\s*[:=]\s*["']36px["']/.test(text) ||
    /\.style\.(?:min)?[Hh]eight\s*=\s*["']36px["']/.test(text)
  );
}

function isSettingsRowSelector(selector) {
  return String(selector || "")
    .split(",")
    .some((part) => {
      const p = part.trim();
      if (!/#settings\b|\.settings\b|settings[-_]row|settings[-_]item/i.test(p)) {
        return false;
      }
      return /row|item|field|entry|setting\b|label|\bli\b/i.test(p);
    });
}

function hasSettingsRow36(opened) {
  const rules = parseRules(opened.css);
  if (rules.some((r) => isSettingsRowSelector(r.selector) && looksLike36pxHeight(r.body))) {
    return true;
  }
  const windows = windowsAround(
    `${opened.css}\n${opened.blob}`,
    /#settings\b|\.settings\b|settings[-_]row|settings[-_]item/gi,
    80,
    400,
  );
  if (windows.some((w) => /row|item|field|entry|label/i.test(w) && looksLike36pxHeight(w))) {
    return true;
  }
  if (
    /--(?:settings-)?row(?:-height)?\s*:\s*36px/.test(opened.css) &&
    /#settings\b|\.settings\b|settings[-_]row/i.test(opened.css)
  ) {
    return true;
  }
  return false;
}

function hasAccountSection(blob) {
  if (
    /<(?:h[1-6]|legend|summary|dt)[^>]*>\s*(?:account|sign\s*in|log\s*in|log\s*on|sign\s*up|profile)\s*</i.test(
      blob,
    )
  ) {
    return true;
  }
  if (
    /(?:aria-label|data-(?:group|section|title)|title)=["'](?:account|sign\s*in|log\s*in|sign\s*up|profile)["']/i.test(
      blob,
    )
  ) {
    return true;
  }
  return false;
}

function hasCustomThemeAuthoring(blob) {
  if (
    /custom\s+theme|create\s+(?:a\s+)?(?:new\s+)?(?:theme|palette)|theme\s+editor|author(?:ing)?\s+(?:a\s+)?theme|new\s+palette/i.test(
      blob,
    )
  ) {
    return true;
  }
  if (
    /<(?:input)\b[^>]*type=["']color["']/i.test(blob) &&
    /theme|palette/i.test(blob)
  ) {
    return true;
  }
  return false;
}

function hasControlFor(blob, idAlt) {
  return hasSelectOrControlMarkup(blob, idAlt);
}

function hasChromeModeControls(blob) {
  const scope = appearanceSection(blob) || blob;
  const follow =
    /follow(?:s)?\s+editor|chrome[-_]?follows[-_]?editor|chromeFollowsEditor/i.test(
      scope,
    );
  const light =
    /fixed\s+light|light\s+shell|chrome[-_]?light|value=["']light["']/i.test(scope);
  const dark =
    /fixed\s+dark|dark\s+shell|chrome[-_]?dark|value=["']dark["']/i.test(scope);
  const modeControl = hasControlFor(
    scope,
    String.raw`chrome[-_]?(?:mode|theme|shell|follow)|shell[-_]?theme|chromeFollowsEditor`,
  );
  return Boolean(follow && light && dark && modeControl);
}

function hasFontSizeAndLineHeightControls(blob) {
  const scope = appearanceSection(blob) || blob;
  const editorSize = hasControlFor(
    scope,
    String.raw`editor[-_]?(?:font[-_]?size|type[-_]?size|size)|editor(?:FontSize|Size)`,
  );
  const editorLh = hasControlFor(
    scope,
    String.raw`editor[-_]?(?:line[-_]?height|leading)|editor(?:LineHeight|Leading)`,
  );
  const previewSize = hasControlFor(
    scope,
    String.raw`preview[-_]?(?:font[-_]?size|type[-_]?size|size)|preview(?:FontSize|Size)`,
  );
  const previewLh = hasControlFor(
    scope,
    String.raw`preview[-_]?(?:line[-_]?height|leading)|preview(?:LineHeight|Leading)`,
  );
  return editorSize && editorLh && previewSize && previewLh;
}

function keyboardCovers(section) {
  const openFolder = /open\s+folder/i.test(section);
  const save = /\bsave\b/i.test(section);
  const panes = /toggle\s+panes?|show\/hide\s+panes?|hide\s+panes?|pane\s+toggle/i.test(
    section,
  );
  const find = /\bfind\b/i.test(section);
  return openFolder && save && panes && find;
}

function hasRemapInputs(section) {
  if (/<(?:input|textarea|select)\b/i.test(section)) return true;
  if (/\bcontenteditable\b/i.test(section)) return true;
  if (/\b(?:remap|rebind|keybinding-input|shortcut-input)\b/i.test(section)) {
    return true;
  }
  if (/press\s+(?:a\s+)?(?:new\s+)?key|custom(?:ize)?\s+shortcut/i.test(section)) {
    return true;
  }
  return false;
}

function pkgVersion() {
  if (!existsSync(pkgPath)) return "0.0.0";
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    return typeof pkg.version === "string" && pkg.version ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function aboutHasVersion(section) {
  const version = pkgVersion().replace(/\./g, "\\.");
  if (new RegExp(String.raw`\b${version}\b`).test(section)) return true;
  if (/\bversion\b/i.test(section) && /\b\d+\.\d+\.\d+\b/.test(section)) return true;
  if (hasControlId(section, String.raw`(?:app[-_]?|settings[-_]?)?version`)) {
    return /\b\d+\.\d+\.\d+\b/.test(section) || /\bversion\b/i.test(section);
  }
  return false;
}

function aboutNamesMit(section) {
  if (/\bMIT\s+Licen[sc]e\b/i.test(section)) return true;
  if (/Licen[sc]e\s*(?:is|:|-)?\s*MIT\b/i.test(section)) return true;
  if (/Licen[sc]e[\s\S]{0,80}\bMIT\b/i.test(section)) return true;
  if (/\bMIT\b[\s\S]{0,80}Licen[sc]e/i.test(section)) return true;
  return false;
}

function aboutLinksLicense(section) {
  if (
    /<a\b[^>]*\bhref=["'](?:(?:\.\.?\/)*)LICENSE(?:[?#][^"']*)?["']/i.test(
      section,
    )
  ) {
    return true;
  }
  if (
    /<a\b[^>]*\bhref=["'][^"']*\/LICENSE(?:[?#][^"']*)?["']/i.test(section)
  ) {
    return true;
  }
  if (/\.href\s*=\s*["'](?:(?:\.\.?\/)*)LICENSE["']/i.test(section)) return true;
  if (
    /setAttribute\(\s*["']href["']\s*,\s*["'](?:(?:\.\.?\/)*)LICENSE["']/i.test(
      section,
    )
  ) {
    return true;
  }
  return false;
}

function aboutHasMitLicense(section) {
  if (
    /licen[sc]e\s*(?:is\s*)?TBD/i.test(section) ||
    /TBD[\s\S]{0,40}licen[sc]e/i.test(section)
  ) {
    return false;
  }
  return aboutNamesMit(section) && aboutLinksLicense(section);
}

function aboutHasRepoLink(section) {
  if (REPO_RE.test(section)) return true;
  if (
    /<a\b[^>]*href=["'][^"']*github\.com\/clearly-bots\/lightmd[^"']*["']/i.test(
      section,
    )
  ) {
    return true;
  }
  return false;
}

function labeledCheckbox(blob, labelRe) {
  const windows = windowsAround(blob, labelRe, 220, 220);
  for (const w of windows) {
    const input = w.match(/<input\b[^>]*>/i);
    if (input) return /\bchecked\b/i.test(input[0]);
  }
  return undefined;
}

function selectedTheme(blob, which) {
  const idAlt =
    which === "editor"
      ? String.raw`(?:settings[-_]?)?editor[-_]?(?:theme|palette)`
      : String.raw`(?:settings[-_]?)?preview[-_]?(?:theme|palette)`;
  const windows = windowsAround(
    blob,
    new RegExp(String.raw`id=["']${idAlt}["']|for=["']${idAlt}["']|name=["']${idAlt}["']`, "gi"),
    80,
    900,
  );
  for (const w of windows) {
    const selected =
      w.match(/<option\b[^>]*\bselected\b[^>]*>([^<]+)/i) ||
      w.match(/<option\b[^>]*>([^<]+)[\s\S]*?\bselected\b/i) ||
      w.match(/<option\b[^>]*\bselected\b[^>]*value=["']([^"']+)["']/i) ||
      w.match(/<option\b[^>]*value=["']([^"']+)["'][^>]*\bselected\b/i);
    if (selected) return selected[1].trim();
  }
  const assign = blob.match(
    new RegExp(
      String.raw`\b${which}(?:Theme|Palette)?\s*[:=]\s*["'\`]([^"'\`]+)["'\`]`,
      "i",
    ),
  );
  return assign ? assign[1] : undefined;
}

function boolFrom(blob, patterns, fallback) {
  for (const re of patterns) {
    const m = blob.match(re);
    if (m && (m[1] === "true" || m[1] === "false")) return m[1] === "true";
  }
  return fallback;
}

function defaultsFromBlob(blob) {
  const wrapBox = labeledCheckbox(
    blob,
    /wrap(?:\s+lines)?|line[-_ ]?wrapp?ing/i,
  );
  const lineBox = labeledCheckbox(blob, /line\s*numbers/i);
  const liveBox = labeledCheckbox(blob, /live\s+preview/i);
  const fmBox = labeledCheckbox(blob, /frontmatter/i);
  const autoBox = labeledCheckbox(blob, /autosave|auto[-_ ]save/i);
  const sessionBox = labeledCheckbox(blob, /session\s+restore/i);
  const htmlBox = labeledCheckbox(blob, /html\s*js|java\s*script/i);
  return {
    editorTheme: selectedTheme(blob, "editor"),
    previewTheme: selectedTheme(blob, "preview"),
    wrap: firstOf(
      wrapBox,
      boolFrom(blob, [
        /\b(?:lineWrapping|line[-_]?wrap|wrap)\s*[:=]\s*(true|false)/i,
      ]),
    ),
    lineNumbers: firstOf(
      lineBox,
      boolFrom(blob, [/\blineNumbers\s*[:=]\s*(true|false)/i]),
    ),
    livePreview: firstOf(
      liveBox,
      boolFrom(blob, [
        /\b(?:livePreview|live)\s*[:=]\s*(true|false)/i,
      ]),
    ),
    frontmatter: firstOf(
      fmBox,
      boolFrom(blob, [
        /\b(?:frontmatter|showFrontmatter(?:Block)?)\s*[:=]\s*(true|false)/i,
      ]),
    ),
    autosave: firstOf(
      autoBox,
      boolFrom(blob, [/\b(?:autosave|autoSave)\s*[:=]\s*(true|false)/i]),
    ),
    sessionRestore: firstOf(
      sessionBox,
      boolFrom(blob, [
        /\b(?:sessionRestore|session[-_]?restore)\s*[:=]\s*(true|false)/i,
      ]),
    ),
    htmlJs: firstOf(
      htmlBox,
      boolFrom(blob, [
        /\b(?:htmlJs|htmlJS|htmlJavaScript)\s*[:=]\s*(true|false)/i,
      ]),
    ),
  };
}

function pickFromObject(value, keys) {
  if (!value || typeof value !== "object") return undefined;
  for (const key of keys) {
    if (value[key] !== undefined && value[key] !== null) return value[key];
  }
  return undefined;
}

function flattenSettingsDefaults(mod) {
  if (!mod || typeof mod !== "object") return null;
  const roots = [
    mod,
    mod.defaults,
    mod.default,
    mod.settings,
    mod.SETTINGS,
    mod.prefs,
    mod.preferences,
    mod.config,
  ].filter((v) => v && typeof v === "object");
  for (const rootObj of roots) {
    const editor = firstOf(
      pickFromObject(rootObj, ["editorTheme", "editorPalette", "EDITOR_THEME"]),
      pickFromObject(rootObj.editor, ["theme", "palette", "editorTheme"]),
      pickFromObject(rootObj.appearance, ["editorTheme", "editor"]),
    );
    const preview = firstOf(
      pickFromObject(rootObj, ["previewTheme", "previewPalette", "PREVIEW_THEME"]),
      pickFromObject(rootObj.preview, ["theme", "palette", "previewTheme"]),
      pickFromObject(rootObj.appearance, ["previewTheme", "preview"]),
    );
    const wrap = firstOf(
      asBool(rootObj.wrap),
      asBool(rootObj.lineWrapping),
      asBool(rootObj.lineWrap),
      asBool(rootObj.editor?.wrap),
      asBool(rootObj.editor?.lineWrapping),
    );
    const lineNumbers = firstOf(
      asBool(rootObj.lineNumbers),
      asBool(rootObj.editor?.lineNumbers),
    );
    const livePreview = firstOf(
      asBool(rootObj.livePreview),
      asBool(rootObj.live),
      asBool(rootObj.preview?.live),
      asBool(rootObj.preview?.livePreview),
    );
    const frontmatter = firstOf(
      asBool(rootObj.frontmatter),
      asBool(rootObj.showFrontmatter),
      asBool(rootObj.showFrontmatterBlock),
      asBool(rootObj.editor?.frontmatter),
    );
    const autosave = firstOf(
      asBool(rootObj.autosave),
      asBool(rootObj.autoSave),
      asBool(rootObj.workspace?.autosave),
      asBool(rootObj.autosave?.enabled),
    );
    const sessionRestore = firstOf(
      asBool(rootObj.sessionRestore),
      asBool(rootObj.session_restore),
      asBool(rootObj.workspace?.sessionRestore),
      asBool(rootObj.session?.restore),
    );
    const htmlJs = firstOf(
      asBool(rootObj.htmlJs),
      asBool(rootObj.htmlJS),
      asBool(rootObj.htmlJavaScript),
      asBool(rootObj.preview?.htmlJs),
      asBool(rootObj.html?.js),
      asBool(rootObj.htmlJs?.enabled),
    );
    const found = {
      editorTheme: editor,
      previewTheme: preview,
      wrap,
      lineNumbers,
      livePreview,
      frontmatter,
      autosave,
      sessionRestore,
      htmlJs,
    };
    if (Object.values(found).some((v) => v !== undefined)) return found;
  }
  return null;
}

function mergeDefaults(...parts) {
  const out = {};
  for (const part of parts) {
    if (!part) continue;
    for (const [key, value] of Object.entries(part)) {
      if (out[key] === undefined && value !== undefined) out[key] = value;
    }
  }
  return out;
}

async function loadSettingsModuleDefaults() {
  const files = collectFiles(srcDir);
  const preferred = ["settings.js", "settings.mjs", "settings.ts"].map((n) =>
    join(srcDir, n),
  );
  const candidates = [
    ...preferred.filter((p) => existsSync(p)),
    ...files.filter(
      (p) =>
        isSettingsPath(p) &&
        /\.(js|mjs|cjs)$/i.test(p) &&
        !/editor\.bundle\.js$/i.test(p) &&
        !preferred.includes(p),
    ),
  ];
  for (const p of candidates) {
    try {
      const mod = await import(pathToFileURL(p).href);
      const found = flattenSettingsDefaults(mod);
      if (found) return found;
    } catch {
      // DOM or otherwise unusable in Node: keep looking, then scan source.
    }
  }
  return null;
}

test("opening Settings shows Appearance, Editor, Preview and HTML, Workspace, Keyboard, and About", () => {
  const opened = openingSettings();
  assertOpensSettings(opened);
  const missing = missingGroups(opened.blob);
  assert.equal(
    missing.length,
    0,
    `opening Settings must show groups: Appearance; Editor; Preview and HTML; Workspace; Keyboard; About (missing: ${missing.join(", ") || "none"})`,
  );
  assert.equal(
    hasCustomThemeAuthoring(opened.blob),
    false,
    "no custom theme authoring UI",
  );
});

test("settings rows are 36px", () => {
  const opened = openingSettings();
  assertOpensSettings(opened);
  assert.ok(hasSettingsRow36(opened), "settings rows must be 36px");
});

test("defaults match PRD section 11", async () => {
  const opened = openingSettings();
  assertOpensSettings(opened);
  const fromMod = await loadSettingsModuleDefaults();
  const fromBlob = defaultsFromBlob(opened.blob);
  const defaults = mergeDefaults(fromMod, fromBlob);
  assert.equal(
    defaults.editorTheme,
    "Dark+",
    "default editor theme must be Dark+",
  );
  assert.equal(
    defaults.previewTheme,
    "Dark",
    "default preview theme must be Dark",
  );
  assert.equal(defaults.wrap, true, "wrap must default on");
  assert.equal(defaults.lineNumbers, false, "line numbers must default off");
  assert.equal(defaults.livePreview, true, "live preview must default on");
  assert.equal(defaults.frontmatter, true, "frontmatter block must default on");
  assert.equal(defaults.autosave, true, "autosave must default on");
  assert.equal(defaults.sessionRestore, true, "session restore must default on");
  assert.equal(defaults.htmlJs, false, "HTML JS must default off");
});

test("no account section", () => {
  const opened = openingSettings();
  assertOpensSettings(opened);
  assert.equal(
    hasAccountSection(opened.blob),
    false,
    "Settings must not include an account section",
  );
});

test("chrome follows editor or fixed light/dark shell, plus editor and preview font size and line height controls", () => {
  const opened = openingSettings();
  assertOpensSettings(opened);
  assert.ok(
    hasGroup(opened.blob, GROUPS[0]),
    "Appearance group is required for chrome and font controls",
  );
  assert.ok(
    hasChromeModeControls(opened.blob),
    "Appearance must include chrome-follows-editor vs fixed light/dark shell",
  );
  assert.ok(
    hasFontSizeAndLineHeightControls(opened.blob),
    "Appearance must include font size and line height controls for editor and preview",
  );
  assert.equal(
    hasCustomThemeAuthoring(opened.blob),
    false,
    "no custom theme authoring UI",
  );
});

test("keyboard list is read-only", () => {
  const opened = openingSettings();
  assertOpensSettings(opened);
  const section = keyboardSection(opened.blob);
  assert.ok(section, "Settings must include a Keyboard group");
  assert.ok(
    keyboardCovers(section),
    "Keyboard list must cover open folder, save, toggle panes, and find",
  );
  assert.equal(
    hasRemapInputs(section),
    false,
    "Keyboard list is read-only (no remapping inputs)",
  );
});

test("about has version, MIT license, and repo link", () => {
  const opened = openingSettings();
  assertOpensSettings(opened);
  const section = aboutSection(opened.blob);
  assert.ok(section, "Settings must include an About group");
  assert.ok(aboutHasVersion(section), "About must include the app version");
  assert.ok(
    aboutHasMitLicense(section),
    "About must name MIT (not TBD) and link LICENSE",
  );
  assert.ok(
    aboutHasRepoLink(section),
    "About must include a repo link (github.com/clearly-bots/lightmd)",
  );
});
