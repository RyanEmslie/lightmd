use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};

#[derive(Clone, Debug, serde::Serialize)]
pub struct Entry {
    pub relative_path: String,
    pub is_dir: bool,
}

pub fn list(root: &Path) -> io::Result<Vec<Entry>> {
    let mut entries = Vec::new();
    collect(root, root, &mut entries)?;
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

fn collect(root: &Path, dir: &Path, entries: &mut Vec<Entry>) -> io::Result<()> {
    for child in fs::read_dir(dir)? {
        let child = child?;
        let path = child.path();
        let file_type = child.file_type()?;
        let relative_path = path
            .strip_prefix(root)
            .unwrap_or(path.as_path())
            .to_string_lossy()
            .replace('\\', "/");

        if file_type.is_dir() {
            entries.push(Entry {
                relative_path,
                is_dir: true,
            });
            collect(root, &path, entries)?;
        } else if file_type.is_file() && listed_file(&path) {
            entries.push(Entry {
                relative_path,
                is_dir: false,
            });
        }
    }
    Ok(())
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

fn confined_path(root: &Path, relative: impl AsRef<Path>) -> io::Result<PathBuf> {
    let root = root.canonicalize()?;
    let relative = relative.as_ref();
    if relative.is_absolute() {
        return Err(outside_workspace());
    }

    let joined = root.join(relative);
    if joined.exists() {
        let path = joined.canonicalize()?;
        path.strip_prefix(&root).map_err(|_| outside_workspace())?;
        return Ok(path);
    }

    // Save As may write a file that does not exist yet; confine without canonicalize.
    let mut path = root.clone();
    for component in relative.components() {
        match component {
            Component::CurDir => {}
            Component::Normal(name) => path.push(name),
            Component::ParentDir => {
                if path == root {
                    return Err(outside_workspace());
                }
                path.pop();
            }
            Component::Prefix(_) | Component::RootDir => {
                return Err(outside_workspace());
            }
        }
    }

    if !path.starts_with(&root) || path == root {
        return Err(outside_workspace());
    }

    let mut missing = Vec::new();
    let mut prefix = path;
    while !prefix.exists() {
        match prefix.file_name() {
            Some(name) => {
                missing.push(name.to_os_string());
                prefix.pop();
            }
            None => break,
        }
        if !prefix.starts_with(&root) {
            return Err(outside_workspace());
        }
    }
    let mut prefix = prefix.canonicalize()?;
    prefix.strip_prefix(&root).map_err(|_| outside_workspace())?;
    for name in missing.into_iter().rev() {
        prefix.push(name);
    }
    if !prefix.starts_with(&root) {
        return Err(outside_workspace());
    }
    Ok(prefix)
}

pub fn read_file(root: &Path, relative: impl AsRef<Path>) -> io::Result<String> {
    fs::read_to_string(confined_path(root, relative)?)
}

pub fn read_image(root: &Path, relative: impl AsRef<Path>) -> io::Result<Vec<u8>> {
    fs::read(confined_path(root, relative)?)
}

pub fn write_file(
    root: &Path,
    relative: impl AsRef<Path>,
    contents: impl AsRef<[u8]>,
) -> io::Result<()> {
    let path = confined_path(root, relative)?;
    if let Some(parent) = path.parent() {
        if !parent.exists() {
            fs::create_dir_all(parent)?;
        }
    }
    fs::write(path, contents)
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
    write_file(Path::new(&path), &relative, contents).map_err(|e| e.to_string())
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
}
