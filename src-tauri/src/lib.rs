use std::fs;
use std::io;
use std::path::Path;

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

pub fn read_file(root: &Path, relative: impl AsRef<Path>) -> io::Result<String> {
    let root = root.canonicalize()?;
    let path = root.join(relative).canonicalize()?;
    path.strip_prefix(&root).map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "path is outside workspace root",
        )
    })?;
    fs::read_to_string(path)
}

#[tauri::command]
fn list_workspace(path: String, sort: Option<String>) -> Result<Vec<Entry>, String> {
    let root = Path::new(&path);
    match sort.as_deref() {
        Some("modified") => sort_by_modified(root),
        Some("name") => sort_by_name(root),
        _ => list(root),
    }
    .map_err(|e| e.to_string())
}

#[tauri::command]
fn read_workspace_file(path: String, relative: String) -> Result<String, String> {
    read_file(Path::new(&path), &relative).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            list_workspace,
            read_workspace_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::list;
    use super::read_file;
    use super::sort_by_modified;
    use super::sort_by_name;
    use super::write_file;
    use std::collections::HashSet;
    use std::path::PathBuf;

    fn workspace_fixture() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("tests")
            .join("fixtures")
            .join("workspace")
    }

    struct RestoreOnDrop {
        path: PathBuf,
        original: String,
    }

    impl Drop for RestoreOnDrop {
        fn drop(&mut self) {
            let _ = std::fs::write(&self.path, &self.original);
        }
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
        let root = workspace_fixture();
        let relative = "note.md";
        let path = root.join(relative);
        let original =
            std::fs::read_to_string(&path).expect("fixture note.md must exist");
        let _restore = RestoreOnDrop {
            path,
            original,
        };
        let contents = "written by write_file test\n";
        write_file(&root, relative, contents)
            .expect("write_file should write the buffer");
        let body = read_file(&root, relative)
            .expect("read_file should read back the written buffer");
        assert_eq!(
            body.replace('\r', ""),
            contents,
            "write_file(root, relative, contents) must persist so a later read_file returns that text"
        );
    }

    #[test]
    fn write_file_rejects_parent_relative_path() {
        let root = workspace_fixture();
        let outside = root.join("..").join("outside.md");
        let original =
            std::fs::read_to_string(&outside).expect("fixture outside.md must exist");
        let _restore = RestoreOnDrop {
            path: outside.clone(),
            original: original.clone(),
        };
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
        let after = std::fs::read_to_string(&outside)
            .expect("outside.md should still be readable");
        assert_eq!(
            after, original,
            "write_file must not mutate a path outside the workspace root"
        );
    }

    #[test]
    fn does_not_expose_create_rename_or_delete() {
        let src = include_str!("lib.rs");
        for op in ["create", "rename", "delete"] {
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
    }

    fn listed_ab(entries: &[super::Entry]) -> Vec<String> {
        entries
            .iter()
            .map(|e| e.relative_path.replace('\\', "/"))
            .filter(|p| p == "a.md" || p == "b.md")
            .collect()
    }

    fn ensure_a_md_older_than_b_md() {
        use std::time::{Duration, SystemTime};

        let root = workspace_fixture();
        let a_path = root.join("a.md");
        let b_path = root.join("b.md");
        assert!(a_path.is_file(), "fixture a.md must exist");
        assert!(b_path.is_file(), "fixture b.md must exist");
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
    }

    #[test]
    fn sort_by_name_orders_a_md_before_b_md() {
        ensure_a_md_older_than_b_md();
        let entries =
            sort_by_name(&workspace_fixture()).expect("sort_by_name should list the workspace");
        assert_eq!(
            listed_ab(&entries),
            ["a.md", "b.md"],
            "sort-by-name must order a.md before b.md"
        );
    }

    #[test]
    fn sort_by_modified_orders_newer_b_md_first() {
        ensure_a_md_older_than_b_md();
        let entries = sort_by_modified(&workspace_fixture())
            .expect("sort_by_modified should list the workspace");
        assert_eq!(
            listed_ab(&entries),
            ["b.md", "a.md"],
            "sort-by-modified must order b.md first (newer)"
        );
    }
}
