use std::fs;
use std::io::{self, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

#[derive(Clone, Debug, serde::Serialize)]
pub struct Entry {
    pub relative_path: String,
    pub is_dir: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
pub struct FileStat {
    pub modified_ms: u64,
    pub size: u64,
}

pub fn list(root: &Path) -> io::Result<Vec<Entry>> {
    let mut entries = Vec::new();
    collect(root, fs::read_dir(root)?, &mut entries);
    Ok(entries)
}

pub fn sort_by_name(root: &Path) -> io::Result<Vec<Entry>> {
    let mut entries = list(root)?;
    entries.sort_by(|a, b| {
        a.relative_path
            .to_ascii_lowercase()
            .cmp(&b.relative_path.to_ascii_lowercase())
    });
    Ok(entries)
}

pub fn sort_by_modified(root: &Path) -> io::Result<Vec<Entry>> {
    let mut entries = list(root)?;
    entries.sort_by(|a, b| {
        modified_time(root, &b.relative_path)
            .cmp(&modified_time(root, &a.relative_path))
            .then_with(|| {
                a.relative_path
                    .to_ascii_lowercase()
                    .cmp(&b.relative_path.to_ascii_lowercase())
            })
    });
    Ok(entries)
}

fn modified_time(root: &Path, relative: &str) -> std::time::SystemTime {
    root.join(relative)
        .metadata()
        .and_then(|m| m.modified())
        .unwrap_or(std::time::UNIX_EPOCH)
}

// Entries that cannot be read are skipped so one locked folder does not hide
// the rest of the workspace.
fn collect(root: &Path, children: fs::ReadDir, entries: &mut Vec<Entry>) {
    for child in children.flatten() {
        let path = child.path();
        let Ok(file_type) = child.file_type() else {
            continue;
        };
        let relative_path = path
            .strip_prefix(root)
            .unwrap_or(path.as_path())
            .to_string_lossy()
            .replace('\\', "/");

        if file_type.is_dir() {
            if child.file_name() == ".git" {
                continue;
            }
            entries.push(Entry {
                relative_path,
                is_dir: true,
            });
            if let Ok(grandchildren) = fs::read_dir(&path) {
                collect(root, grandchildren, entries);
            }
        } else if file_type.is_file() && listed_file(&path) {
            entries.push(Entry {
                relative_path,
                is_dir: false,
            });
        }
    }
}

fn listed_file(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| ext.to_ascii_lowercase())
            .as_deref(),
        Some("md" | "html" | "htm")
    )
}

fn outside_workspace() -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidInput,
        "path is outside workspace root",
    )
}

fn dangling_symlink() -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidInput,
        "path is a symlink whose target does not exist",
    )
}

fn confined_path(root: &Path, relative: impl AsRef<Path>) -> io::Result<PathBuf> {
    let root = root.canonicalize()?;

    // Resolve `.` and `..` lexically. The result may not climb above the root,
    // be absolute, or name the root itself (which also rejects "").
    let mut names = Vec::new();
    for component in relative.as_ref().components() {
        match component {
            Component::CurDir => {}
            Component::Normal(name) => names.push(name),
            Component::ParentDir => {
                if names.pop().is_none() {
                    return Err(outside_workspace());
                }
            }
            Component::Prefix(_) | Component::RootDir => {
                return Err(outside_workspace());
            }
        }
    }
    if names.is_empty() {
        return Err(outside_workspace());
    }

    // Walk the components that exist. Every symlink among them, including the
    // last, must resolve to a real path inside the root; a dangling link would
    // let a write create its target wherever it points. Save As may name
    // folders and a file that do not exist yet, so the rest is appended as-is.
    let mut path = root.clone();
    let mut names = names.into_iter();
    while let Some(name) = names.next() {
        let next = path.join(name);
        match fs::symlink_metadata(&next) {
            Ok(meta) if meta.file_type().is_symlink() => {
                let target = next.canonicalize().map_err(|e| {
                    if e.kind() == io::ErrorKind::NotFound {
                        dangling_symlink()
                    } else {
                        e
                    }
                })?;
                if !target.starts_with(&root) {
                    return Err(outside_workspace());
                }
                path = target;
            }
            Ok(_) => path = next,
            Err(e) if e.kind() == io::ErrorKind::NotFound => {
                path = next;
                path.extend(names);
                break;
            }
            Err(e) => return Err(e),
        }
    }
    if path == root {
        return Err(outside_workspace());
    }
    Ok(path)
}

pub fn read_file(root: &Path, relative: impl AsRef<Path>) -> io::Result<String> {
    fs::read_to_string(confined_path(root, relative)?)
}

pub fn read_image(root: &Path, relative: impl AsRef<Path>) -> io::Result<Vec<u8>> {
    fs::read(confined_path(root, relative)?)
}

fn modified_ms(meta: &fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |since| since.as_millis() as u64)
}

pub fn stat_file(root: &Path, relative: impl AsRef<Path>) -> io::Result<FileStat> {
    let meta = fs::metadata(confined_path(root, relative)?)?;
    if !meta.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "path is not a file",
        ));
    }
    Ok(FileStat {
        modified_ms: modified_ms(&meta),
        size: meta.len(),
    })
}

/// Ok(false) when nothing exists at the path; Err when it escapes the workspace.
pub fn file_exists(root: &Path, relative: impl AsRef<Path>) -> io::Result<bool> {
    confined_path(root, relative)?.try_exists()
}

/// Writes `contents` and returns the file's new `modified_ms`.
pub fn write_file(
    root: &Path,
    relative: impl AsRef<Path>,
    contents: impl AsRef<[u8]>,
) -> io::Result<u64> {
    write_confined(&confined_path(root, relative)?, contents.as_ref(), None)
}

/// Like `write_file`, but if `expected_modified_ms` is set and the file exists
/// with a different mtime, nothing is written and the error starts "conflict:".
pub fn write_file_if_unchanged(
    root: &Path,
    relative: impl AsRef<Path>,
    contents: impl AsRef<[u8]>,
    expected_modified_ms: Option<u64>,
) -> io::Result<u64> {
    write_confined(
        &confined_path(root, relative)?,
        contents.as_ref(),
        expected_modified_ms,
    )
}

fn write_confined(
    path: &Path,
    contents: &[u8],
    expected_modified_ms: Option<u64>,
) -> io::Result<u64> {
    if let Some(expected) = expected_modified_ms {
        match fs::metadata(path) {
            Ok(meta) if modified_ms(&meta) != expected => {
                return Err(io::Error::other("conflict: file changed on disk"));
            }
            Ok(_) => {}
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(e) => return Err(e),
        }
    }
    if let Some(parent) = path.parent() {
        if !parent.exists() {
            fs::create_dir_all(parent)?;
        }
    }
    atomic_write(path, contents)?;
    fs::metadata(path).map(|meta| modified_ms(&meta))
}

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Writes `contents` to a temp file beside `path`, syncs it, then renames it over
/// `path`, so a crash or full disk never leaves a truncated file behind.
fn atomic_write(path: &Path, contents: &[u8]) -> io::Result<()> {
    let parent = path.parent().ok_or_else(outside_workspace)?;
    let name = path.file_name().ok_or_else(outside_workspace)?;
    let existing = match fs::metadata(path) {
        Ok(meta) => {
            // Renaming over the file would bypass its own write permission.
            fs::OpenOptions::new().write(true).open(path)?;
            Some(meta.permissions())
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => None,
        Err(e) => return Err(e),
    };

    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    if existing.is_some() {
        use std::os::unix::fs::OpenOptionsExt;
        // Keep the copy private until the original permissions are applied.
        options.mode(0o600);
    }
    let (temp, file) = loop {
        let temp = parent.join(format!(
            ".{}.{}-{}.tmp",
            name.to_string_lossy(),
            std::process::id(),
            TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        match options.open(&temp) {
            Ok(file) => break (temp, file),
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e),
        }
    };

    let result = replace_with_temp(file, &temp, path, contents, existing);
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

fn replace_with_temp(
    mut file: fs::File,
    temp: &Path,
    path: &Path,
    contents: &[u8],
    permissions: Option<fs::Permissions>,
) -> io::Result<()> {
    file.write_all(contents)?;
    if let Some(permissions) = permissions {
        file.set_permissions(permissions)?;
    }
    file.sync_all()?;
    drop(file);
    fs::rename(temp, path)
}

pub fn create_folder(root: &Path, relative: impl AsRef<Path>) -> io::Result<()> {
    let path = confined_path(root, relative)?;
    fs::create_dir_all(path)
}

#[tauri::command]
fn list_workspace(path: String, sort: Option<String>) -> Result<Vec<Entry>, String> {
    let root = Path::new(&path);
    match sort.as_deref() {
        Some("modified") => sort_by_modified(root),
        _ => sort_by_name(root),
    }
    .map_err(|e| e.to_string())
}

#[tauri::command]
fn read_workspace_file(path: String, relative: String) -> Result<String, String> {
    read_file(Path::new(&path), &relative).map_err(|e| e.to_string())
}

#[tauri::command]
fn write_workspace_file(path: String, relative: String, contents: String) -> Result<(), String> {
    write_file(Path::new(&path), &relative, contents)
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn create_workspace_folder(path: String, relative: String) -> Result<(), String> {
    create_folder(Path::new(&path), &relative).map_err(|e| e.to_string())
}

#[tauri::command]
fn read_workspace_image(path: String, relative: String) -> Result<Vec<u8>, String> {
    read_image(Path::new(&path), &relative).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            list_workspace,
            read_workspace_file,
            write_workspace_file,
            read_workspace_image,
            create_workspace_folder
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::list;
    use super::read_file;
    use super::read_image;
    use super::sort_by_modified;
    use super::sort_by_name;
    use super::write_file;
    use std::collections::HashSet;
    use std::path::PathBuf;
    use std::time::{Duration, SystemTime};

    fn workspace_fixture() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("tests")
            .join("fixtures")
            .join("workspace")
    }

    struct RemoveDirOnDrop(PathBuf);
    impl Drop for RemoveDirOnDrop {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn temp_workspace(label: &str) -> (PathBuf, RemoveDirOnDrop) {
        let root = std::env::temp_dir().join(format!(
            "lightmd-{}-{}-{}",
            label,
            std::process::id(),
            SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&root).expect("temp workspace");
        (root.clone(), RemoveDirOnDrop(root))
    }

    fn has_fn(src: &str, name: &str) -> bool {
        src.lines().any(|line| {
            let t = line.trim_start();
            let def = t.starts_with("fn ")
                || t.starts_with("pub fn ")
                || t.starts_with("pub(crate) fn ");
            if !def {
                return false;
            }
            let Some(after_fn) = t.find("fn ").map(|i| t[i + 3..].trim_start()) else {
                return false;
            };
            after_fn.starts_with(name)
                && after_fn[name.len()..]
                    .chars()
                    .next()
                    .map(|c| !c.is_ascii_alphanumeric() && c != '_')
                    .unwrap_or(false)
        })
    }

    #[test]
    fn list_returns_md_html_htm_and_nested_dirs_ignores_txt() {
        let entries = list(&workspace_fixture()).expect("list should read the workspace fixture");
        let got: HashSet<(String, bool)> = entries
            .iter()
            .map(|e| (e.relative_path.replace('\\', "/"), e.is_dir))
            .collect();
        let expected: HashSet<(String, bool)> = [
            ("a.md".into(), false),
            ("b.html".into(), false),
            ("b.md".into(), false),
            ("c.htm".into(), false),
            ("note.md".into(), false),
            ("nested".into(), true),
            ("nested/d.md".into(), false),
        ]
        .into_iter()
        .collect();
        assert_eq!(
            got, expected,
            "list must return md/html/htm files plus nested dirs and ignore txt"
        );
    }

    #[test]
    fn read_file_returns_note_md_body() {
        let body =
            read_file(&workspace_fixture(), "note.md").expect("read_file should read note.md");
        assert_eq!(
            body.replace('\r', ""),
            "# Note\n\nKnown body for open-file.\n",
            "read_file(root, relative) must return the known body of note.md"
        );
    }

    #[test]
    fn read_file_rejects_parent_relative_path() {
        let result = read_file(&workspace_fixture(), "../outside.md");
        assert!(
            result.is_err(),
            "read_file(workspace_root, \"../outside.md\") must be Err, got Ok({:?})",
            result.ok()
        );
    }

    #[test]
    fn write_file_persists_so_read_file_returns_the_buffer() {
        let (root, _cleanup) = temp_workspace("write-persist");
        std::fs::write(root.join("note.md"), "original\n").expect("seed note.md");
        let contents = "written by write_file test\n";
        write_file(&root, "note.md", contents).expect("write_file should write the buffer");
        let body = read_file(&root, "note.md")
            .expect("read_file should read back the written buffer");
        assert_eq!(
            body.replace('\r', ""),
            contents,
            "write_file(root, relative, contents) must persist so a later read_file returns that text"
        );
    }

    #[test]
    fn write_file_rejects_parent_relative_path() {
        let parent = std::env::temp_dir().join(format!(
            "lightmd-write-escape-parent-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let root = parent.join("workspace");
        std::fs::create_dir_all(&root).expect("temp workspace");
        let outside = parent.join("outside.md");
        std::fs::write(&outside, "outside original\n").expect("seed outside.md");
        struct RemoveDirOnDrop(PathBuf);
        impl Drop for RemoveDirOnDrop {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
        let _cleanup = RemoveDirOnDrop(parent.clone());
        let original = std::fs::read_to_string(&outside).expect("outside.md readable");
        let result = write_file(
            &root,
            "../outside.md",
            "should not write outside workspace\n",
        );
        assert!(
            result.is_err(),
            "write_file(workspace_root, \"../outside.md\", ...) must be Err, got Ok({:?})",
            result.ok()
        );
        let after = std::fs::read_to_string(&outside).expect("outside.md should still be readable");
        assert_eq!(
            after, original,
            "write_file must not mutate a path outside the workspace root"
        );
    }

    #[test]
    fn create_folder_nested_and_rejects_escape() {
        let (root, _cleanup) = temp_workspace("create-folder");

        super::create_folder(&root, "notes/trip").expect("create nested folder");
        assert!(
            root.join("notes").join("trip").is_dir(),
            "create_folder must create notes/trip under the workspace"
        );

        let escape = super::create_folder(&root, "../escape");
        assert!(
            escape.is_err(),
            "create_folder(workspace_root, \"../escape\") must be Err, got Ok({:?})",
            escape.ok()
        );
    }

    #[test]
    fn write_file_creates_new_file_under_workspace() {
        let (root, _cleanup) = temp_workspace("save-as-new");
        write_file(&root, "save-as-new.md", "created by save as\n")
            .expect("write_file should create a new file for Save As");
        let body = read_file(&root, "save-as-new.md").expect("new file should be readable");
        assert_eq!(
            body.replace('\r', ""),
            "created by save as\n",
            "write_file must persist a newly created workspace file"
        );
    }

    #[test]
    fn does_not_expose_create_rename_or_delete() {
        let src = include_str!("lib.rs");
        // Save As creates files through write_file / write_workspace_file.
        // Dedicated rename/delete commands stay forbidden.
        for op in ["rename", "delete"] {
            let needle = format!("fn {op}");
            assert!(
                !src.lines().any(|line| {
                    let t = line.trim_start();
                    (t.starts_with("fn ")
                        || t.starts_with("pub fn ")
                        || t.starts_with("pub(crate) fn "))
                        && t.contains(&needle)
                }),
                "must not expose {op}"
            );
        }
        assert!(
            has_fn(src, "write_file") || has_fn(src, "write_workspace_file"),
            "create-via-write must remain available for Save As"
        );
    }

    fn listed_ab(entries: &[super::Entry]) -> Vec<String> {
        entries
            .iter()
            .map(|e| e.relative_path.replace('\\', "/"))
            .filter(|p| p == "a.md" || p == "b.md")
            .collect()
    }

    fn sorted_temp_workspace() -> (PathBuf, RemoveDirOnDrop) {
        let (root, cleanup) = temp_workspace("sort");
        let a_path = root.join("a.md");
        let b_path = root.join("b.md");
        std::fs::write(&a_path, "a\n").expect("seed a.md");
        std::fs::write(&b_path, "b\n").expect("seed b.md");
        let now = SystemTime::now();
        std::fs::OpenOptions::new()
            .write(true)
            .open(&a_path)
            .expect("open a.md")
            .set_modified(now - Duration::from_secs(120))
            .expect("a.md must be older than b.md");
        std::fs::OpenOptions::new()
            .write(true)
            .open(&b_path)
            .expect("open b.md")
            .set_modified(now)
            .expect("b.md must be newer than a.md");
        (root, cleanup)
    }

    #[test]
    fn sort_by_name_orders_a_md_before_b_md() {
        let (root, _cleanup) = sorted_temp_workspace();
        let entries = sort_by_name(&root).expect("sort_by_name should list the workspace");
        assert_eq!(
            listed_ab(&entries),
            ["a.md", "b.md"],
            "sort-by-name must order a.md before b.md"
        );
    }

    #[test]
    fn sort_by_modified_orders_newer_b_md_first() {
        let (root, _cleanup) = sorted_temp_workspace();
        let entries = sort_by_modified(&root).expect("sort_by_modified should list the workspace");
        assert_eq!(
            listed_ab(&entries),
            ["b.md", "a.md"],
            "sort-by-modified must order b.md first (newer)"
        );
    }

    #[test]
    fn read_image_returns_pic_png_bytes() {
        let root = workspace_fixture();
        let original = std::fs::read(root.join("pic.png")).expect("fixture pic.png must exist");
        assert!(
            original.starts_with(b"\x89PNG\r\n\x1a\n"),
            "fixture pic.png must be a PNG"
        );
        let bytes = read_image(&root, "pic.png").expect("read_image should return pic.png bytes");
        assert_eq!(bytes, original, "read_image(root, \"pic.png\") must return the PNG bytes");
        let after = std::fs::read(root.join("pic.png")).expect("pic.png should still be readable");
        assert_eq!(after, original, "read_image must not mutate pic.png");
    }

    #[test]
    fn read_image_rejects_parent_relative_path() {
        let root = workspace_fixture();
        let outside = root.join("..").join("outside.png");
        let original = std::fs::read(&outside).expect("fixture outside.png must exist");
        let result = read_image(&root, "../outside.png");
        assert!(
            result.is_err(),
            "read_image(workspace_root, \"../outside.png\") must be Err, got Ok({:?})",
            result.ok().map(|b| b.len())
        );
        let after = std::fs::read(&outside).expect("outside.png should still be readable");
        assert_eq!(
            after, original,
            "read_image must not mutate a path outside the workspace root"
        );
    }

    fn dir_names(dir: &std::path::Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(dir)
            .expect("folder should be readable")
            .map(|entry| {
                entry
                    .expect("folder entry")
                    .file_name()
                    .to_string_lossy()
                    .into_owned()
            })
            .collect();
        names.sort();
        names
    }

    #[test]
    fn write_file_leaves_no_temp_files_behind() {
        let (root, _cleanup) = temp_workspace("atomic-clean");
        std::fs::write(root.join("note.md"), "original\n").expect("seed note.md");
        write_file(&root, "note.md", "replaced\n").expect("save over an existing file");
        write_file(&root, "fresh.md", "created\n").expect("save a new file");
        assert_eq!(
            read_file(&root, "note.md").expect("read note.md"),
            "replaced\n",
            "write_file must persist the new contents"
        );
        assert_eq!(
            dir_names(&root),
            ["fresh.md", "note.md"],
            "a save must not leave temp files in the folder"
        );
    }

    #[cfg(unix)]
    #[test]
    fn write_file_replaces_the_file_instead_of_truncating_it() {
        use std::io::Read;
        let (root, _cleanup) = temp_workspace("atomic-replace");
        let path = root.join("note.md");
        std::fs::write(&path, "complete original\n").expect("seed note.md");
        // An in-place write truncates the file first, which is what a crash or full
        // disk leaves behind. A reader holding the old file must still see all of it.
        let mut before = std::fs::File::open(&path).expect("open note.md before saving");
        write_file(&root, "note.md", "new\n").expect("save note.md");
        let mut old = String::new();
        before
            .read_to_string(&mut old)
            .expect("read through the handle opened before the save");
        assert_eq!(
            old, "complete original\n",
            "write_file must replace the file via rename, never truncate it in place"
        );
        assert_eq!(
            std::fs::read_to_string(&path).expect("read note.md"),
            "new\n",
            "the saved file must hold the new contents"
        );
    }

    #[cfg(unix)]
    #[test]
    fn write_file_keeps_existing_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let (root, _cleanup) = temp_workspace("atomic-perms");
        let path = root.join("note.md");
        std::fs::write(&path, "original\n").expect("seed note.md");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o640))
            .expect("chmod note.md");
        write_file(&root, "note.md", "replaced\n").expect("save note.md");
        let mode = std::fs::metadata(&path)
            .expect("stat note.md")
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o640, "write_file must keep the file's permissions");
    }

    #[cfg(unix)]
    #[test]
    fn write_file_refuses_read_only_files() {
        use std::os::unix::fs::PermissionsExt;
        let (root, _cleanup) = temp_workspace("atomic-readonly");
        let path = root.join("locked.md");
        std::fs::write(&path, "keep me\n").expect("seed locked.md");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o444))
            .expect("chmod locked.md");
        if std::fs::OpenOptions::new().write(true).open(&path).is_ok() {
            // Running as root: file modes are not enforced, so there is nothing to check.
            return;
        }
        let result = write_file(&root, "locked.md", "overwritten\n");
        assert!(
            result.is_err(),
            "write_file must not replace a read-only file, got Ok({:?})",
            result.ok()
        );
        assert_eq!(
            std::fs::read_to_string(&path).expect("read locked.md"),
            "keep me\n",
            "a refused save must leave the file untouched"
        );
        assert_eq!(
            dir_names(&root),
            ["locked.md"],
            "a refused save must not leave temp files behind"
        );
    }

    /// A workspace folder plus a sibling folder outside it, removed together on drop.
    fn workspace_with_outside(label: &str) -> (PathBuf, PathBuf, RemoveDirOnDrop) {
        let (parent, cleanup) = temp_workspace(label);
        let root = parent.join("workspace");
        let outside = parent.join("outside");
        std::fs::create_dir_all(&root).expect("workspace folder");
        std::fs::create_dir_all(&outside).expect("outside folder");
        (root, outside, cleanup)
    }

    #[cfg(unix)]
    #[test]
    fn write_file_rejects_dangling_symlink_to_outside() {
        use std::os::unix::fs::symlink;
        let (root, outside, _cleanup) = workspace_with_outside("dangling");
        symlink(outside.join("x.md"), root.join("link.md")).expect("dangling file link");
        let result = write_file(&root, "link.md", "escaped\n");
        assert!(
            result.is_err(),
            "write_file through a dangling symlink must be Err, got Ok({:?})",
            result.ok()
        );
        assert!(
            !outside.join("x.md").exists(),
            "write_file must not create a symlink target outside the workspace"
        );

        symlink(outside.join("gone"), root.join("gone")).expect("dangling folder link");
        assert!(
            write_file(&root, "gone/x.md", "escaped\n").is_err(),
            "write_file under a dangling folder symlink must be Err"
        );
        assert!(
            super::create_folder(&root, "gone/sub").is_err(),
            "create_folder under a dangling folder symlink must be Err"
        );
        assert!(
            !outside.join("gone").exists(),
            "nothing may be created outside the workspace"
        );
    }

    #[cfg(unix)]
    #[test]
    fn symlink_to_outside_file_is_rejected() {
        use std::os::unix::fs::symlink;
        let (root, outside, _cleanup) = workspace_with_outside("link-file");
        std::fs::write(outside.join("secret.md"), "secret\n").expect("seed outside file");
        symlink(outside.join("secret.md"), root.join("secret.md")).expect("file link");
        assert!(
            read_file(&root, "secret.md").is_err(),
            "read_file through a symlink to an outside file must be Err"
        );
        assert!(
            write_file(&root, "secret.md", "overwritten\n").is_err(),
            "write_file through a symlink to an outside file must be Err"
        );
        assert_eq!(
            std::fs::read_to_string(outside.join("secret.md")).expect("read outside file"),
            "secret\n",
            "the outside file must be untouched"
        );
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_folder_pointing_outside_is_rejected() {
        use std::os::unix::fs::symlink;
        let (root, outside, _cleanup) = workspace_with_outside("link-dir");
        std::fs::write(outside.join("a.md"), "outside a\n").expect("seed outside file");
        symlink(&outside, root.join("linked")).expect("folder link");
        assert!(
            read_file(&root, "linked/a.md").is_err(),
            "read_file through a folder symlink pointing outside must be Err"
        );
        assert!(
            write_file(&root, "linked/new.md", "escaped\n").is_err(),
            "write_file through a folder symlink pointing outside must be Err"
        );
        assert!(
            super::create_folder(&root, "linked/sub").is_err(),
            "create_folder through a folder symlink pointing outside must be Err"
        );
        assert_eq!(
            dir_names(&outside),
            ["a.md"],
            "nothing may be created outside the workspace"
        );
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_inside_the_workspace_still_work() {
        use std::os::unix::fs::symlink;
        let (root, _cleanup) = temp_workspace("link-inside");
        std::fs::write(root.join("real.md"), "real\n").expect("seed real.md");
        symlink(root.join("real.md"), root.join("alias.md")).expect("inside link");
        assert_eq!(
            read_file(&root, "alias.md").expect("read through an inside symlink"),
            "real\n"
        );
        write_file(&root, "alias.md", "updated\n").expect("save through an inside symlink");
        assert_eq!(
            std::fs::read_to_string(root.join("real.md")).expect("read real.md"),
            "updated\n",
            "saving through a symlink must update its target"
        );
        assert!(
            std::fs::symlink_metadata(root.join("alias.md"))
                .expect("stat alias.md")
                .file_type()
                .is_symlink(),
            "saving through a symlink must keep the link"
        );
    }

    #[test]
    fn confined_path_rejects_absolute_parent_escape_and_empty() {
        let (root, outside, _cleanup) = workspace_with_outside("confine-lexical");
        let absolute = outside.join("abs.md");
        assert!(
            write_file(&root, &absolute, "escaped\n").is_err(),
            "an absolute relative path must be Err"
        );
        assert!(!absolute.exists(), "an absolute path must not be written");
        for relative in ["a/../../x.md", "", ".", "a/.."] {
            assert!(
                super::confined_path(&root, relative).is_err(),
                "confined_path(root, {relative:?}) must be Err"
            );
        }
        assert!(
            super::create_folder(&root, "").is_err(),
            "create_folder(root, \"\") must be Err"
        );
    }

    #[cfg(unix)]
    #[test]
    fn list_skips_unreadable_folders_and_git() {
        use std::os::unix::fs::PermissionsExt;
        struct RestoreMode(PathBuf);
        impl Drop for RestoreMode {
            fn drop(&mut self) {
                let _ = std::fs::set_permissions(&self.0, std::fs::Permissions::from_mode(0o755));
            }
        }

        let (root, _cleanup) = temp_workspace("list-unreadable");
        std::fs::write(root.join("ok.md"), "ok\n").expect("seed ok.md");
        std::fs::create_dir_all(root.join("locked")).expect("locked folder");
        std::fs::write(root.join("locked").join("hidden.md"), "hidden\n").expect("seed hidden.md");
        std::fs::create_dir_all(root.join(".git").join("refs")).expect(".git folder");
        std::fs::write(root.join(".git").join("notes.md"), "git\n").expect("seed .git/notes.md");
        std::fs::set_permissions(root.join("locked"), std::fs::Permissions::from_mode(0o000))
            .expect("chmod locked");
        let _restore = RestoreMode(root.join("locked"));

        let entries = list(&root).expect("one unreadable folder must not fail the whole listing");
        let got: HashSet<String> = entries
            .iter()
            .map(|e| e.relative_path.replace('\\', "/"))
            .collect();
        assert!(got.contains("ok.md"), "readable files must still be listed: {got:?}");
        assert!(got.contains("locked"), "the unreadable folder itself is still listed: {got:?}");
        assert!(
            !got.iter().any(|p| p == ".git" || p.starts_with(".git/")),
            "list must skip .git folders: {got:?}"
        );
    }

    fn set_modified_ms(path: &std::path::Path, ms: u64) {
        std::fs::OpenOptions::new()
            .write(true)
            .open(path)
            .expect("open file to set its mtime")
            .set_modified(std::time::UNIX_EPOCH + Duration::from_millis(ms))
            .expect("set mtime");
    }

    #[test]
    fn stat_file_reports_size_and_modified_ms() {
        let (root, _cleanup) = temp_workspace("stat");
        let path = root.join("note.md");
        std::fs::write(&path, "12345").expect("seed note.md");
        set_modified_ms(&path, 1_700_000_000_123);
        let stat = super::stat_file(&root, "note.md").expect("stat an existing file");
        assert_eq!(stat.size, 5, "stat_file must report the size in bytes");
        assert_eq!(
            stat.modified_ms, 1_700_000_000_123,
            "stat_file must report the mtime in ms since the epoch"
        );
        assert!(
            super::stat_file(&root, "missing.md").is_err(),
            "stat_file must be Err for a missing file"
        );
        assert!(
            super::stat_file(&root, "../note.md").is_err(),
            "stat_file must be Err for a path outside the workspace"
        );
    }

    #[test]
    fn file_exists_is_false_when_missing_and_err_on_escape() {
        let (root, _cleanup) = temp_workspace("exists");
        std::fs::write(root.join("note.md"), "note\n").expect("seed note.md");
        assert!(
            super::file_exists(&root, "note.md").expect("existing file"),
            "file_exists must be true for an existing file"
        );
        assert!(
            !super::file_exists(&root, "missing.md").expect("missing file"),
            "file_exists must be false for a missing file"
        );
        assert!(
            !super::file_exists(&root, "new/folder/missing.md").expect("missing folder"),
            "file_exists must be false under a missing folder"
        );
        assert!(
            super::file_exists(&root, "../note.md").is_err(),
            "file_exists must be Err for a path outside the workspace"
        );
    }

    #[test]
    fn write_file_returns_the_new_modified_ms() {
        let (root, _cleanup) = temp_workspace("write-mtime");
        let modified: u64 = write_file(&root, "note.md", "hello\n").expect("save note.md");
        let stat = super::stat_file(&root, "note.md").expect("stat note.md");
        assert_eq!(
            modified, stat.modified_ms,
            "write_file must return the file's modified_ms after the write"
        );
    }

    #[test]
    fn write_file_if_unchanged_refuses_when_the_file_changed_on_disk() {
        let (root, _cleanup) = temp_workspace("write-conflict");
        let path = root.join("note.md");
        std::fs::write(&path, "disk\n").expect("seed note.md");
        set_modified_ms(&path, 1_700_000_000_000);

        let err = super::write_file_if_unchanged(&root, "note.md", "mine\n", Some(1_600_000_000_000))
            .expect_err("a stale expected mtime must be refused");
        assert_eq!(err.to_string(), "conflict: file changed on disk");
        assert_eq!(
            std::fs::read_to_string(&path).expect("read note.md"),
            "disk\n",
            "a conflicting write must not touch the file"
        );

        let modified =
            super::write_file_if_unchanged(&root, "note.md", "mine\n", Some(1_700_000_000_000))
                .expect("a matching expected mtime must write");
        assert_eq!(std::fs::read_to_string(&path).expect("read note.md"), "mine\n");
        assert_eq!(
            modified,
            super::stat_file(&root, "note.md").expect("stat note.md").modified_ms,
            "write_file_if_unchanged must return the new modified_ms"
        );

        super::write_file_if_unchanged(&root, "note.md", "forced\n", None)
            .expect("no expected mtime writes unconditionally");
        assert_eq!(std::fs::read_to_string(&path).expect("read note.md"), "forced\n");

        super::write_file_if_unchanged(&root, "gone.md", "recreated\n", Some(1))
            .expect("a missing file is not a conflict");
        assert_eq!(
            std::fs::read_to_string(root.join("gone.md")).expect("read gone.md"),
            "recreated\n"
        );
    }
}
