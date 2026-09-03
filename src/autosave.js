export const autosave = {
  enabled: true,
  delay: 1000,
};

let autosaveTimer = null;
let autosaveSeq = 0;

export function cancelAutosave() {
  if (autosaveTimer != null) {
    clearTimeout(autosaveTimer);
    autosaveTimer = null;
  }
  autosaveSeq += 1;
}

export function scheduleAutoSave() {
  cancelAutosave();
  if (!autosave.enabled) return;
  const seq = ++autosaveSeq;
  autosaveTimer = setTimeout(async () => {
    autosaveTimer = null;
    const tauri = typeof window !== "undefined" ? window.__TAURI__ : null;
    const ctx = typeof window !== "undefined" ? window.lightmdWorkspace : null;
    if (!tauri || !ctx || !ctx.path || !ctx.relative) return;
    const path = ctx.path;
    const relative = ctx.relative;
    const contents = ctx.contents;
    await tauri.core.invoke("write_workspace_file", {
      path,
      relative,
      contents,
    });
    if (seq !== autosaveSeq) return;
    const setDirty = window.lightmdSetDirty;
    if (typeof setDirty === "function") {
      setDirty(false);
    }
  }, autosave.delay);
}
