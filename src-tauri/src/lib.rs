#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::list;
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
