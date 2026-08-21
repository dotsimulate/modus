//! Handing a link from the app to the operating system.
//!
//! Links rendered in a transcript are model-authored text, so every argument
//! that arrives here is untrusted. Two boundaries follow from that.
//!
//! **Schemes are allowlisted.** The OS launches whatever handler is registered
//! for a scheme, so forwarding an arbitrary one would let a message body pick the
//! program. Only `http` and `https` reach [`open_external_url`]; everything else
//! is refused by name. The frontend classifier declines them too, and this is the
//! half that holds if a different caller appears.
//!
//! **Paths must be absolute.** A relative path would resolve against the desktop
//! process's own working directory — the install directory — which is never what
//! the link meant. The frontend additionally hides these actions unless the
//! window and the backend share a machine; that is a usability decision, while
//! this is the one that cannot be bypassed.
//!
//! Note what is deliberately *not* defended: opening an executable path with its
//! default handler runs it. That is the same authority the user already has by
//! clicking the file in Explorer, it is reachable only from an explicit menu
//! action on a path the user can read, and Modus does not claim to sandbox local
//! content. Do not add a scheme or drop the absolute-path rule without revisiting
//! that reasoning.
//!
//! `tauri-plugin-opener` is taken as a dependency for its cross-platform reveal
//! and open implementations, but its *plugin* is deliberately not registered.
//! Its JS command surface reads `HTMLAnchorElement.href` — the resolved URL,
//! which is precisely the `tauri.localhost/C:/...` defect this work exists to
//! fix — and it would add an ACL scope surface to maintain for commands nothing
//! calls. Modus exposes its own commands instead and keeps
//! `capabilities/default.json` unchanged.

use std::path::Path;

use url::Url;

const ALLOWED_URL_SCHEMES: [&str; 2] = ["http", "https"];

/// Normalize a URL for the system browser, or explain why it was refused.
pub fn validate_external_url(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("refusing to open an empty url".into());
    }
    let parsed = Url::parse(trimmed).map_err(|err| format!("unparsable url: {err}"))?;
    let scheme = parsed.scheme();
    if !ALLOWED_URL_SCHEMES.contains(&scheme) {
        return Err(format!("refusing to open url scheme: {scheme}"));
    }
    if parsed.host_str().unwrap_or_default().is_empty() {
        return Err("refusing to open a url with no host".into());
    }
    Ok(parsed.to_string())
}

/// Accept a path the OS may act on, or explain why it was refused.
pub fn validate_local_path(raw: &str) -> Result<&Path, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("refusing to open an empty path".into());
    }
    let path = Path::new(trimmed);
    if !path.is_absolute() {
        return Err(format!("refusing to open a relative path: {trimmed}"));
    }
    Ok(path)
}

pub fn open_external_url(raw: &str) -> Result<(), String> {
    let url = validate_external_url(raw)?;
    tauri_plugin_opener::open_url(url, None::<&str>).map_err(|err| err.to_string())
}

pub fn reveal_local_path(raw: &str) -> Result<(), String> {
    let path = validate_local_path(raw)?;
    tauri_plugin_opener::reveal_item_in_dir(path).map_err(|err| err.to_string())
}

pub fn open_local_path(raw: &str) -> Result<(), String> {
    let path = validate_local_path(raw)?;
    tauri_plugin_opener::open_path(path, None::<&str>).map_err(|err| err.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_http_and_https() {
        assert_eq!(
            validate_external_url("https://example.com/a?b=1#c").unwrap(),
            "https://example.com/a?b=1#c"
        );
        assert!(validate_external_url("http://127.0.0.1:4200/health").is_ok());
        assert!(validate_external_url("  https://example.com  ").is_ok());
    }

    /// Every one of these names a real host, so only the scheme allowlist can
    /// refuse them. Schemes such as `file:` and `mailto:` are *also* caught by
    /// the host check below, which would let this test pass even with the
    /// allowlist widened — proven by widening it and watching this stay green.
    #[test]
    fn refuses_hosted_schemes_outside_the_allowlist() {
        for url in [
            "ftp://example.com/pub",
            "smb://fileserver/share",
            "modus://session/abc",
            "vscode://file/C:/x",
            "ws://127.0.0.1:4200",
        ] {
            assert!(
                validate_external_url(url).is_err(),
                "expected {url} to be refused by the scheme allowlist"
            );
        }
    }

    /// Schemes that carry a payload rather than a host. Refused twice over, and
    /// that redundancy is deliberate: either check alone would stop them.
    #[test]
    fn refuses_hostless_and_payload_schemes() {
        for url in [
            "file:///C:/Windows/System32/cmd.exe",
            "javascript:alert(1)",
            "data:text/html,<script>",
            "mailto:someone@example.com",
            "ms-msdt:/id",
        ] {
            assert!(
                validate_external_url(url).is_err(),
                "expected {url} to be refused"
            );
        }
    }

    #[test]
    fn refuses_empty_and_hostless_urls() {
        assert!(validate_external_url("").is_err());
        assert!(validate_external_url("   ").is_err());
        assert!(validate_external_url("not a url").is_err());
        // Parses, allowlisted scheme, but names no host to reach.
        assert!(validate_external_url("http://").is_err());
    }

    #[test]
    fn refuses_relative_and_empty_paths() {
        assert!(validate_local_path("").is_err());
        assert!(validate_local_path("   ").is_err());
        assert!(validate_local_path("src/main.rs").is_err());
        assert!(validate_local_path("./src/main.rs").is_err());
        assert!(validate_local_path("../secrets.env").is_err());
    }

    #[cfg(windows)]
    #[test]
    fn accepts_absolute_windows_paths() {
        assert!(validate_local_path("C:\\Users\\x\\file.txt").is_ok());
        assert!(validate_local_path("D:/TOOLSHELF/modus").is_ok());
        assert!(validate_local_path("\\\\server\\share\\file.txt").is_ok());
        // A drive-relative path names a location only in the context of the
        // process's current drive, so it is not accepted.
        assert!(validate_local_path("\\Windows\\System32").is_err());
    }

    #[cfg(not(windows))]
    #[test]
    fn accepts_absolute_posix_paths() {
        assert!(validate_local_path("/home/x/file.txt").is_ok());
        assert!(validate_local_path("/tmp").is_ok());
    }

    #[test]
    fn trims_before_deciding() {
        let path = validate_local_path(if cfg!(windows) {
            "  C:\\Users\\x  "
        } else {
            "  /home/x  "
        })
        .unwrap();
        assert!(!path.to_string_lossy().starts_with(' '));
    }
}
