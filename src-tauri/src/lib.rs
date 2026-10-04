use std::fs;
use std::io::{self, Read, Write};
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

/// Largest file read_image returns, so one huge file cannot stall the preview.
pub const MAX_IMAGE_BYTES: u64 = 20 * 1024 * 1024;

fn image_file(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| ext.to_ascii_lowercase())
            .as_deref(),
        Some("png" | "jpg" | "jpeg" | "gif" | "webp" | "svg" | "bmp" | "ico" | "avif")
    )
}

fn image_too_large() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, "image is larger than 20 MB")
}

pub fn read_image(root: &Path, relative: impl AsRef<Path>) -> io::Result<Vec<u8>> {
    let path = confined_path(root, relative)?;
    if !image_file(&path) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "not an image file",
        ));
    }
    let meta = fs::metadata(&path)?;
    if !meta.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "path is not a file",
        ));
    }
    if meta.len() > MAX_IMAGE_BYTES {
        return Err(image_too_large());
    }
    // The file may grow after the metadata check, so cap the read as well.
    let mut bytes = Vec::with_capacity(meta.len() as usize);
    fs::File::open(&path)?
        .take(MAX_IMAGE_BYTES + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_IMAGE_BYTES {
        return Err(image_too_large());
    }
    Ok(bytes)
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

/// Runs blocking file I/O on Tauri's blocking pool and maps errors to strings.
async fn run_blocking<T, F>(task: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> io::Result<T> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

// The commands are async so Tauri runs them off the main (UI) thread.

#[tauri::command]
async fn list_workspace(path: String, sort: Option<String>) -> Result<Vec<Entry>, String> {
    run_blocking(move || {
        let root = Path::new(&path);
        match sort.as_deref() {
            Some("modified") => sort_by_modified(root),
            _ => sort_by_name(root),
        }
    })
    .await
}

#[tauri::command]
async fn read_workspace_file(path: String, relative: String) -> Result<String, String> {
    run_blocking(move || read_file(Path::new(&path), &relative)).await
}

#[tauri::command]
async fn write_workspace_file(
    path: String,
    relative: String,
    contents: String,
    expected_modified_ms: Option<u64>,
) -> Result<u64, String> {
    run_blocking(move || {
        write_file_if_unchanged(Path::new(&path), &relative, contents, expected_modified_ms)
    })
    .await
}

#[tauri::command]
async fn stat_workspace_file(path: String, relative: String) -> Result<FileStat, String> {
    run_blocking(move || stat_file(Path::new(&path), &relative)).await
}

#[tauri::command]
async fn workspace_file_exists(path: String, relative: String) -> Result<bool, String> {
    run_blocking(move || file_exists(Path::new(&path), &relative)).await
}

#[tauri::command]
async fn create_workspace_folder(path: String, relative: String) -> Result<(), String> {
    run_blocking(move || create_folder(Path::new(&path), &relative)).await
}

#[tauri::command]
async fn read_workspace_image(
    path: String,
    relative: String,
) -> Result<tauri::ipc::Response, String> {
    // Raw bytes reach JS as an ArrayBuffer instead of a JSON array of numbers.
    run_blocking(move || read_image(Path::new(&path), &relative))
        .await
        .map(tauri::ipc::Response::new)
}

fn invoke_handler<R: tauri::Runtime>(
) -> impl Fn(tauri::ipc::Invoke<R>) -> bool + Send + Sync + 'static {
    tauri::generate_handler![
        list_workspace,
        read_workspace_file,
        write_workspace_file,
        stat_workspace_file,
        workspace_file_exists,
        read_workspace_image,
        create_workspace_folder
    ]
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(invoke_handler())
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
        assert!(
            got.contains("ok.md"),
            "readable files must still be listed: {got:?}"
        );
        assert!(
            got.contains("locked"),
            "the unreadable folder itself is still listed: {got:?}"
        );
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

        let err =
            super::write_file_if_unchanged(&root, "note.md", "mine\n", Some(1_600_000_000_000))
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
        assert_eq!(
            std::fs::read_to_string(&path).expect("read note.md"),
            "mine\n"
        );
        assert_eq!(
            modified,
            super::stat_file(&root, "note.md")
                .expect("stat note.md")
                .modified_ms,
            "write_file_if_unchanged must return the new modified_ms"
        );

        super::write_file_if_unchanged(&root, "note.md", "forced\n", None)
            .expect("no expected mtime writes unconditionally");
        assert_eq!(
            std::fs::read_to_string(&path).expect("read note.md"),
            "forced\n"
        );

        super::write_file_if_unchanged(&root, "gone.md", "recreated\n", Some(1))
            .expect("a missing file is not a conflict");
        assert_eq!(
            std::fs::read_to_string(root.join("gone.md")).expect("read gone.md"),
            "recreated\n"
        );
    }

    #[test]
    fn read_image_reads_only_image_extensions() {
        let (root, _cleanup) = temp_workspace("image-ext");
        for name in [
            "a.png", "b.jpg", "c.jpeg", "d.gif", "e.webp", "f.svg", "g.bmp", "h.ico", "i.avif",
            "J.PNG",
        ] {
            std::fs::write(root.join(name), name.as_bytes()).expect("seed image");
            assert_eq!(
                read_image(&root, name).unwrap_or_else(|e| panic!("read_image({name}): {e}")),
                name.as_bytes(),
                "read_image must read {name}"
            );
        }
        for name in ["note.md", "page.html", "secret.txt", "no-extension"] {
            std::fs::write(root.join(name), "not an image").expect("seed file");
            assert!(
                read_image(&root, name).is_err(),
                "read_image({name}) must be Err for a non-image file"
            );
        }
    }

    #[test]
    fn read_image_rejects_files_over_20_mb() {
        const LIMIT: u64 = 20 * 1024 * 1024;
        let (root, _cleanup) = temp_workspace("image-size");
        let at_limit = std::fs::File::create(root.join("limit.png")).expect("create limit.png");
        at_limit.set_len(LIMIT).expect("size limit.png");
        let too_big = std::fs::File::create(root.join("big.png")).expect("create big.png");
        too_big.set_len(LIMIT + 1).expect("size big.png");

        let bytes = read_image(&root, "limit.png").expect("an image of exactly 20 MB is allowed");
        assert_eq!(bytes.len() as u64, LIMIT);
        assert!(
            read_image(&root, "big.png").is_err(),
            "read_image must be Err for an image over 20 MB"
        );
    }

    type MockWebview = tauri::WebviewWindow<tauri::test::MockRuntime>;

    /// Sends one IPC call the way the webview's `invoke(cmd, args)` would.
    fn ipc(
        webview: &MockWebview,
        cmd: &str,
        args: serde_json::Value,
    ) -> Result<tauri::ipc::InvokeResponseBody, serde_json::Value> {
        tauri::test::get_ipc_response(
            webview,
            tauri::webview::InvokeRequest {
                cmd: cmd.into(),
                callback: tauri::ipc::CallbackFn(0),
                error: tauri::ipc::CallbackFn(1),
                url: if cfg!(windows) {
                    "http://tauri.localhost"
                } else {
                    "tauri://localhost"
                }
                .parse()
                .expect("app url"),
                body: tauri::ipc::InvokeBody::Json(args),
                headers: Default::default(),
                invoke_key: tauri::test::INVOKE_KEY.to_string(),
            },
        )
    }

    fn ipc_json(webview: &MockWebview, cmd: &str, args: serde_json::Value) -> serde_json::Value {
        ipc(webview, cmd, args)
            .unwrap_or_else(|e| panic!("{cmd} must succeed, got Err({e})"))
            .deserialize()
            .expect("JSON response")
    }

    #[test]
    fn ipc_exposes_the_workspace_commands_with_their_js_argument_names() {
        use serde_json::json;
        let (root, _cleanup) = temp_workspace("ipc");
        let png = std::fs::read(workspace_fixture().join("pic.png")).expect("fixture pic.png");
        std::fs::write(root.join("pic.png"), &png).expect("seed pic.png");
        let path = root.to_string_lossy().into_owned();

        let app = tauri::test::mock_builder()
            .invoke_handler(super::invoke_handler())
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app");
        let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .expect("mock window");

        let modified = ipc_json(
            &webview,
            "write_workspace_file",
            json!({ "path": path, "relative": "note.md", "contents": "one\n" }),
        );
        assert!(
            modified.is_u64(),
            "write_workspace_file must return modified_ms, got {modified}"
        );

        let stat = ipc_json(
            &webview,
            "stat_workspace_file",
            json!({ "path": path, "relative": "note.md" }),
        );
        assert_eq!(stat, json!({ "modified_ms": modified, "size": 4 }));

        let conflict = ipc(
            &webview,
            "write_workspace_file",
            json!({
                "path": path,
                "relative": "note.md",
                "contents": "two\n",
                "expectedModifiedMs": modified.as_u64().unwrap() + 1,
            }),
        )
        .expect_err("a stale expectedModifiedMs must be refused");
        assert!(
            conflict
                .as_str()
                .is_some_and(|e| e.starts_with("conflict:")),
            "the rejection must start with \"conflict:\", got {conflict}"
        );
        let same = ipc_json(
            &webview,
            "write_workspace_file",
            json!({
                "path": path,
                "relative": "note.md",
                "contents": "three\n",
                "expectedModifiedMs": modified,
            }),
        );
        assert!(same.is_u64(), "a matching expectedModifiedMs must write");
        assert_eq!(
            ipc_json(
                &webview,
                "read_workspace_file",
                json!({ "path": path, "relative": "note.md" }),
            ),
            json!("three\n")
        );

        assert_eq!(
            ipc_json(
                &webview,
                "workspace_file_exists",
                json!({ "path": path, "relative": "note.md" }),
            ),
            json!(true)
        );
        assert_eq!(
            ipc_json(
                &webview,
                "workspace_file_exists",
                json!({ "path": path, "relative": "missing.md" }),
            ),
            json!(false)
        );
        assert!(
            ipc(
                &webview,
                "workspace_file_exists",
                json!({ "path": path, "relative": "../escape.md" }),
            )
            .is_err(),
            "workspace_file_exists must reject an escape"
        );

        match ipc(
            &webview,
            "read_workspace_image",
            json!({ "path": path, "relative": "pic.png" }),
        ) {
            Ok(tauri::ipc::InvokeResponseBody::Raw(bytes)) => assert_eq!(bytes, png),
            other => panic!("read_workspace_image must return raw bytes, got {other:?}"),
        }

        ipc_json(
            &webview,
            "create_workspace_folder",
            json!({ "path": path, "relative": "notes" }),
        );
        let entries = ipc_json(
            &webview,
            "list_workspace",
            json!({ "path": path, "sort": "name" }),
        );
        assert_eq!(
            entries,
            json!([
                { "relative_path": "note.md", "is_dir": false },
                { "relative_path": "notes", "is_dir": true },
            ])
        );
    }

    #[test]
    fn capabilities_grant_only_what_the_app_uses() {
        use serde_json::json;
        let capability: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/default.json"))
                .expect("capabilities/default.json must be JSON");
        assert_eq!(capability["windows"], json!(["main"]));
        let permissions = capability["permissions"]
            .as_array()
            .expect("permissions must be a list");
        // layout.js restores the window size with setSize, and dialog confirm()
        // and ask() both invoke plugin:dialog|message.
        for required in [
            "core:default",
            "core:window:allow-set-size",
            "dialog:allow-open",
            "dialog:allow-save",
            "dialog:allow-message",
        ] {
            assert!(
                permissions.contains(&json!(required)),
                "capabilities must grant {required}: {permissions:?}"
            );
        }
        for broad in ["dialog:default", "opener:default"] {
            assert!(
                !permissions.contains(&json!(broad)),
                "capabilities must not grant {broad}"
            );
        }
        // The opener may open web links only: no reveal_item_in_dir, open_path,
        // mailto: or tel:.
        let opener: Vec<_> = permissions
            .iter()
            .filter(|p| {
                p.as_str()
                    .or_else(|| p["identifier"].as_str())
                    .is_some_and(|id| id.starts_with("opener:"))
            })
            .collect();
        assert_eq!(
            opener,
            [&json!({
                "identifier": "opener:allow-open-url",
                "allow": [{ "url": "http://*" }, { "url": "https://*" }]
            })],
            "the opener must be limited to http(s) URLs"
        );
    }

    fn url(s: &str) -> tauri::Url {
        s.parse().unwrap_or_else(|e| panic!("{s} must parse: {e}"))
    }

    #[test]
    fn navigation_allows_the_app_and_frame_documents() {
        use super::{classify_navigation, Navigation};
        for allowed in [
            "tauri://localhost",
            "tauri://localhost/index.html#settings",
            "http://tauri.localhost/",
            "https://tauri.localhost/index.html",
            // srcdoc and blank iframes (the HTML preview) navigate the subframe.
            "about:blank",
            "about:srcdoc",
            "data:text/html,<p>hi</p>",
            "blob:tauri://localhost/0c6c0f4e-2b5e-4c47-9f5b-1d1e3a5b8c2a",
        ] {
            assert_eq!(
                classify_navigation(&url(allowed), None),
                Navigation::Allow,
                "{allowed} must stay in the webview"
            );
        }
    }

    #[test]
    fn navigation_sends_web_links_to_the_system_browser() {
        use super::{classify_navigation, Navigation};
        for external in [
            "https://github.com/clearly-bots/lightmd",
            "https://github.com/clearly-bots/lightmd/blob/main/LICENSE",
            "http://example.com/",
            "http://localhost:1420/",
        ] {
            assert_eq!(
                classify_navigation(&url(external), None),
                Navigation::OpenExternal,
                "{external} must open in the system browser, not replace the app"
            );
        }
    }

    #[test]
    fn navigation_allows_only_the_configured_dev_server_origin() {
        use super::{classify_navigation, Navigation};
        let dev = url("http://localhost:1420");
        assert_eq!(
            classify_navigation(&url("http://localhost:1420/index.html"), Some(&dev)),
            Navigation::Allow
        );
        for other in ["http://localhost:1421/", "https://localhost:1420/"] {
            assert_eq!(
                classify_navigation(&url(other), Some(&dev)),
                Navigation::OpenExternal,
                "{other} is not the dev server origin"
            );
        }
    }

    #[test]
    fn navigation_blocks_everything_else() {
        use super::{classify_navigation, Navigation};
        for blocked in [
            "file:///etc/passwd",
            "mailto:someone@example.com",
            "tel:+15555550100",
            "javascript:alert(1)",
            "tauri://elsewhere/",
            "asset://localhost/etc/passwd",
            "ftp://example.com/",
        ] {
            assert_eq!(
                classify_navigation(&url(blocked), None),
                Navigation::Block,
                "{blocked} must be cancelled"
            );
        }
    }

    #[test]
    fn external_opens_are_throttled() {
        use super::external_open_allowed;
        let start = std::time::Instant::now();
        assert!(
            external_open_allowed(None, start),
            "the first open is allowed"
        );
        assert!(
            !external_open_allowed(Some(start), start + Duration::from_millis(300)),
            "a second open within a second is dropped, so a page cannot flood the browser"
        );
        assert!(external_open_allowed(
            Some(start),
            start + Duration::from_secs(1)
        ));
    }
}
