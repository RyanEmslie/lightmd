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
    fs::read_to_string(root.join(relative))
}

#[tauri::command]
fn list_workspace(path: String) -> Result<Vec<Entry>, String> {
    list(Path::new(&path)).map_err(|e| e.to_string())
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
    use std::collections::HashSet;
    use std::path::PathBuf;

    fn workspace_fixture() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("tests")
            .join("fixtures")
            .join("workspace")
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
}
