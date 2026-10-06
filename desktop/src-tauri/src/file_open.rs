//! OS file opens are queued until the main webview can read them. Events are
//! wakeups, not copies of the paths, so startup and live delivery cannot race
//! into duplicate opens. No file is executed and no agent session is started.

use std::{ffi::OsString, path::Path, sync::Mutex};

use tauri::{AppHandle, Emitter, Manager};

pub const FILE_OPEN_EVENT: &str = "modus:open-files";
const MAX_PENDING_FILES: usize = 128;

#[derive(Default)]
pub struct PendingFiles(Mutex<Vec<String>>);

impl PendingFiles {
    pub fn has_pending(&self) -> bool {
        self.0
            .lock()
            .map(|pending| !pending.is_empty())
            .unwrap_or(false)
    }

    pub fn store(&self, paths: impl IntoIterator<Item = String>) -> bool {
        let Ok(mut pending) = self.0.lock() else {
            return false;
        };
        let mut added = false;
        for path in paths {
            if pending.len() < MAX_PENDING_FILES && !pending.contains(&path) {
                pending.push(path);
                added = true;
            }
        }
        added
    }

    pub fn take(&self) -> Vec<String> {
        self.0
            .lock()
            .map(|mut pending| std::mem::take(&mut *pending))
            .unwrap_or_default()
    }
}

/// Canonicalize an existing regular text file. Relative launch arguments are
/// resolved against the launching process's cwd, never the install directory.
pub fn validate(path: &Path, cwd: &Path) -> Option<String> {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        cwd.join(path)
    };
    let canonical = absolute.canonicalize().ok()?;
    if !canonical.is_file() {
        return None;
    }
    let extension = canonical.extension()?.to_str()?;
    if !["md", "markdown", "txt"]
        .iter()
        .any(|allowed| extension.eq_ignore_ascii_case(allowed))
    {
        return None;
    }
    // Win32 extended paths work for I/O but do not match the project's normal
    // drive paths in the UI. Return their ordinary spelling, including UNC.
    let path = canonical.to_str()?;
    #[cfg(windows)]
    let path = if let Some(unc) = path.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{unc}")
    } else {
        path.strip_prefix(r"\\?\").unwrap_or(path).to_string()
    };
    #[cfg(not(windows))]
    let path = path.to_string();
    Some(path)
}

pub fn dispatch(app: &AppHandle, paths: impl IntoIterator<Item = String>) -> bool {
    if !app.state::<PendingFiles>().store(paths) {
        return false;
    }
    let _ = app.emit_to("main", FILE_OPEN_EVENT, ());
    true
}

pub fn dispatch_arguments(
    app: &AppHandle,
    arguments: impl IntoIterator<Item = OsString>,
    cwd: &Path,
) -> bool {
    dispatch(
        app,
        arguments
            .into_iter()
            .filter(|argument| !argument.to_string_lossy().starts_with('-'))
            .filter_map(|argument| validate(Path::new(&argument), cwd)),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn queues_multiple_files_once_and_claims_them_once() {
        let pending = PendingFiles::default();
        assert!(pending.store(["a.md".into(), "b.markdown".into(), "a.md".into()]));
        assert!(!pending.store(["a.md".into()]));
        assert_eq!(pending.take(), ["a.md", "b.markdown"]);
        assert!(pending.take().is_empty());
        assert!(pending.store(["a.md".into()]));
    }

    #[test]
    fn bounds_the_startup_queue() {
        let pending = PendingFiles::default();
        pending.store((0..256).map(|index| format!("{index}.md")));
        assert_eq!(pending.take().len(), MAX_PENDING_FILES);
    }

    #[test]
    fn accepts_real_text_files_and_rejects_directories_missing_files_and_binaries() {
        let root = std::env::temp_dir().join(format!("modus-file-open-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        for name in [
            "notes with spaces.MD",
            "guide.markdown",
            "plain.txt",
            "program.exe",
        ] {
            std::fs::write(root.join(name), "hello").unwrap();
        }
        for name in ["notes with spaces.MD", "guide.markdown", "plain.txt"] {
            let path = validate(Path::new(name), &root).unwrap();
            assert!(Path::new(&path).is_absolute());
            assert!(path.ends_with(name));
            assert_eq!(validate(&root.join(name), Path::new("unused")), Some(path));
        }
        assert!(validate(Path::new("missing.md"), &root).is_none());
        assert!(validate(Path::new("program.exe"), &root).is_none());
        std::fs::create_dir(root.join("directory.md")).unwrap();
        assert!(validate(Path::new("directory.md"), &root).is_none());
        std::fs::remove_dir_all(&root).unwrap();
    }
}
