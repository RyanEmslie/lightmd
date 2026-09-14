export function normalizeRel(value) {
  return String(value ?? "").replace(/\\/g, "/");
}

export function isEscapingRelative(relative) {
  const n = normalizeRel(relative);
  if (!n) return false;
  if (n.startsWith("/") || /^[A-Za-z]:/.test(n)) return true;
  let depth = 0;
  for (const part of n.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      depth -= 1;
      if (depth < 0) return true;
      continue;
    }
    depth += 1;
  }
  return false;
}

function fileContents(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "object" && typeof value.contents === "string") {
    return value.contents;
  }
  return String(value);
}

function isDir(value) {
  return Boolean(value && typeof value === "object" && value.is_dir);
}

export function createInvoke({
  files = new Map(),
  folders = [],
  modifiedOrder = null,
  onInvoke = null,
} = {}) {
  const invokes = [];
  const writes = [];
  const attemptedWrites = [];

  async function invoke(cmd, args = {}) {
    invokes.push({ cmd, args });
    if (typeof onInvoke === "function") {
      const override = await onInvoke(cmd, args, { files, folders });
      if (override !== undefined) return override;
    }
    if (cmd === "list_workspace") {
      const entries = [];
      for (const name of folders) {
        entries.push({ relative_path: normalizeRel(name), is_dir: true });
      }
      for (const [relative_path, value] of files) {
        entries.push({
          relative_path: normalizeRel(relative_path),
          is_dir: isDir(value),
        });
      }
      if (args.sort === "modified" && Array.isArray(modifiedOrder)) {
        const rank = new Map(modifiedOrder.map((p, i) => [normalizeRel(p), i]));
        entries.sort((a, b) => {
          const ia = rank.has(a.relative_path) ? rank.get(a.relative_path) : 999;
          const ib = rank.has(b.relative_path) ? rank.get(b.relative_path) : 999;
          return ia - ib || a.relative_path.localeCompare(b.relative_path);
        });
      } else {
        entries.sort((a, b) =>
          a.relative_path.localeCompare(b.relative_path, undefined, {
            sensitivity: "base",
          }),
        );
      }
      return entries;
    }
    if (cmd === "read_workspace_file") {
      const rel = normalizeRel(args.relative);
      if (isEscapingRelative(rel) || !files.has(rel) || isDir(files.get(rel))) {
        throw new Error(`read_workspace_file: missing ${rel}`);
      }
      return fileContents(files.get(rel));
    }
    if (
      cmd === "write_workspace_file" ||
      cmd === "write_file" ||
      cmd === "write"
    ) {
      const record = {
        cmd,
        path: args.path,
        relative: args.relative,
        contents: args.contents,
      };
      attemptedWrites.push(record);
      const rel = normalizeRel(args.relative);
      if (isEscapingRelative(rel)) {
        throw new Error("path is outside workspace root");
      }
      files.set(rel, String(args.contents ?? ""));
      writes.push(record);
      return;
    }
    if (cmd === "create_workspace_folder") {
      const rel = normalizeRel(args.relative);
      if (isEscapingRelative(rel) || rel.includes("/") || rel.includes("\\")) {
        throw new Error("path is outside workspace root");
      }
      folders.push(rel);
      return;
    }
    if (cmd === "read_workspace_image") {
      const rel = normalizeRel(args.relative);
      if (isEscapingRelative(rel) || !files.has(rel)) {
        throw new Error(`read_workspace_image: missing ${rel}`);
      }
      const value = files.get(rel);
      if (value && typeof value === "object" && value.bytes) return value.bytes;
      throw new Error(`read_workspace_image: not bytes ${rel}`);
    }
    if (
      cmd === "workspace_file_exists" ||
      cmd === "file_exists" ||
      cmd === "exists"
    ) {
      return files.has(normalizeRel(args.relative ?? args.path ?? ""));
    }
    return null;
  }

  return { invoke, invokes, writes, attemptedWrites, files, folders };
}
