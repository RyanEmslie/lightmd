// Recent folders: every folder the explorer opens is remembered (newest
// first) and offered from the toolbar's Recent menu, and in the explorer
// while no folder is open.

export const RECENT_KEY = "lightmd.recentFolders";
export const RECENT_MAX = 8;

function storage() {
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
}

export function recentFolders() {
  const ls = storage();
  try {
    const list = JSON.parse((ls && ls.getItem(RECENT_KEY)) || "[]");
    return Array.isArray(list) ? list.filter((p) => typeof p === "string" && p) : [];
  } catch {
    return [];
  }
}

function saveRecent(list) {
  const ls = storage();
  try {
    if (ls) ls.setItem(RECENT_KEY, JSON.stringify(list.slice(0, RECENT_MAX)));
  } catch (err) {
    console.error("LightMD: could not save recent folders", err);
  }
}

export function rememberFolder(path) {
  if (typeof path !== "string" || !path) return;
  saveRecent([path, ...recentFolders().filter((p) => p !== path)]);
}

export function forgetFolder(path) {
  saveRecent(recentFolders().filter((p) => p !== path));
}

function doc() {
  return typeof globalThis.document !== "undefined" ? globalThis.document : null;
}

function folderName(path) {
  const parts = String(path).replace(/[/\\]+$/, "").split(/[/\\]/);
  return parts[parts.length - 1] || path;
}

function fillList(list) {
  const d = doc();
  list.replaceChildren(
    ...recentFolders().map((path) => {
      const li = d.createElement("li");
      const button = d.createElement("button");
      button.type = "button";
      button.dataset.folder = path;
      button.title = path;
      const name = d.createElement("strong");
      name.textContent = folderName(path);
      const full = d.createElement("small");
      full.textContent = path;
      button.append(name, full);
      li.append(button);
      return li;
    }),
  );
}

function workspaceOpen() {
  const ws = globalThis.lightmdWorkspace;
  return !!(ws && ws.path);
}

export function refreshEmptyState() {
  const d = doc();
  const box = d && d.getElementById("recent-empty");
  const list = d && d.getElementById("recent-empty-list");
  if (!box || !list) return;
  const show = !workspaceOpen() && recentFolders().length > 0;
  if (show) fillList(list);
  box.hidden = !show;
}

async function openRecent(path) {
  if (typeof globalThis.lightmdOpenFolder !== "function") return;
  try {
    await globalThis.lightmdOpenFolder(path);
  } catch (err) {
    // Moved or deleted since: drop it so the list stays useful.
    console.error("LightMD: could not open recent folder", path, err);
    forgetFolder(path);
    refreshEmptyState();
  }
}

export function bindRecentFolders() {
  const d = doc();
  if (!d || typeof d.getElementById !== "function") return;
  const button = d.getElementById("recent-folders");
  const menu = d.getElementById("recent-menu");

  const closeMenu = () => {
    if (menu) menu.hidden = true;
    if (button) button.setAttribute("aria-expanded", "false");
  };

  if (button && menu) {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      if (!menu.hidden) {
        closeMenu();
        return;
      }
      fillList(menu);
      if (!menu.firstChild) {
        const li = d.createElement("li");
        li.className = "recent-none";
        li.textContent = "No recent folders";
        menu.append(li);
      }
      menu.hidden = false;
      button.setAttribute("aria-expanded", "true");
    });
    d.addEventListener("click", (event) => {
      if (!menu.hidden && !menu.contains(event.target)) closeMenu();
    });
    d.addEventListener("keydown", (event) => {
      if (event.key === "Escape") closeMenu();
    });
  }

  for (const list of [menu, d.getElementById("recent-empty-list")]) {
    if (!list) continue;
    list.addEventListener("click", (event) => {
      const item = event.target && event.target.closest && event.target.closest("button[data-folder]");
      if (!item) return;
      closeMenu();
      void openRecent(item.dataset.folder);
    });
  }

  globalThis.addEventListener("lightmd:workspace-changed", (event) => {
    const root = event.detail && event.detail.root;
    if (root) rememberFolder(root);
    refreshEmptyState();
  });
  // editor.js calls refreshEmptyState() once session restore has settled, so
  // the empty state doesn't flash before the last folder reopens.
}
