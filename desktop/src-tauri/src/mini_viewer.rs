//! The mini viewer: a second, compact webview onto the same app, meant to sit
//! beside (and optionally above) whatever else the user is working in.
//!
//! It loads the ordinary bundled UI with `modusView=mini` in the query, so it
//! bootstraps like the main window — for a managed backend that returns the
//! instance already running rather than starting another. Only the chrome
//! differs, and that is decided entirely in the frontend.
//!
//! One window at most. Opening it again re-points the existing window at the
//! requested session instead of stacking copies.

use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};

use serde::Deserialize;
use tauri::{
    menu::CheckMenuItem, AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder, Wry,
};

pub const LABEL: &str = "mini";

/// Must match the listener in `harness/ui/src/miniViewer.ts`.
const RETARGET_EVENT: &str = "modus:mini-viewer-retarget";

/// What the tray opens: the main window's own startup query, flagged mini.
/// With no session in the hash the UI restores the last one it had open.
const DEFAULT_QUERY: &str = "?modusDesktop=1&modusDiscover=local&modusView=mini";

/// Generous for a query carrying a backend URL, vault, and label; anything
/// longer did not come from the UI.
const MAX_LOCATION_LEN: usize = 2048;

pub struct MiniViewer {
    on_top: AtomicBool,
    tray_pin: Mutex<Option<CheckMenuItem<Wry>>>,
}

impl Default for MiniViewer {
    fn default() -> Self {
        // Pinned by default: the reason to open it is to keep a conversation
        // visible while another app has focus.
        Self {
            on_top: AtomicBool::new(true),
            tray_pin: Mutex::new(None),
        }
    }
}

impl MiniViewer {
    pub fn on_top(&self) -> bool {
        self.on_top.load(Ordering::SeqCst)
    }

    pub fn attach_tray_pin(&self, item: CheckMenuItem<Wry>) {
        if let Ok(mut slot) = self.tray_pin.lock() {
            *slot = Some(item);
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenRequest {
    query: Option<String>,
    hash: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OnTopRequest {
    on_top: bool,
}

/// Printable ASCII only, minus the characters that could end the URL, start a
/// second component, or matter to a path. The UI percent-encodes everything else.
fn is_location_char(c: char) -> bool {
    c.is_ascii_graphic() && !matches!(c, '\\' | '"' | '\'' | '<' | '>' | '`')
}

fn validated_query(query: Option<&str>) -> Result<&str, String> {
    let Some(query) = query.filter(|query| !query.is_empty()) else {
        return Ok(DEFAULT_QUERY);
    };
    let Some(pairs) = query.strip_prefix('?') else {
        return Err("mini viewer query must start with '?'".into());
    };
    if query.len() > MAX_LOCATION_LEN || query.contains('#') || !query.chars().all(is_location_char)
    {
        return Err("mini viewer query is malformed".into());
    }
    // Without the flag the window would load the full app at a phone size.
    if !pairs.split('&').any(|pair| pair == "modusView=mini") {
        return Err("mini viewer query must select modusView=mini".into());
    }
    Ok(query)
}

fn validated_hash(hash: Option<&str>) -> Result<&str, String> {
    let hash = hash.unwrap_or_default();
    if hash.is_empty() {
        return Ok(hash);
    }
    if !hash.starts_with('#')
        || hash.len() > MAX_LOCATION_LEN
        || hash[1..].contains('#')
        || !hash.chars().all(is_location_char)
    {
        return Err("mini viewer hash is malformed".into());
    }
    Ok(hash)
}

/// Show the mini viewer, creating it on first use.
///
/// Must not run on a synchronous command: building a webview window from one
/// deadlocks on Windows. The tray handler runs on the event loop, which is fine.
pub fn open(app: &AppHandle, query: Option<&str>, hash: Option<&str>) -> Result<(), String> {
    let query = validated_query(query)?;
    let hash = validated_hash(hash)?;

    if let Some(window) = app.get_webview_window(LABEL) {
        if !hash.is_empty() {
            app.emit_to(LABEL, RETARGET_EVENT, hash)
                .map_err(|error| format!("could not re-point the mini viewer: {error}"))?;
        }
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        return Ok(());
    }

    let on_top = app.state::<MiniViewer>().on_top();
    WebviewWindowBuilder::new(
        app,
        LABEL,
        WebviewUrl::App(format!("index.html{query}{hash}").into()),
    )
    .title("Modus mini")
    .inner_size(440.0, 760.0)
    .min_inner_size(320.0, 420.0)
    .always_on_top(on_top)
    .build()
    .map_err(|error| format!("could not open the mini viewer: {error}"))?;
    Ok(())
}

/// Pin or unpin the mini viewer above other apps. Remembered for the next time
/// it opens, and mirrored into the tray check item.
pub fn set_on_top(app: &AppHandle, on_top: bool) -> bool {
    let state = app.state::<MiniViewer>();
    state.on_top.store(on_top, Ordering::SeqCst);
    if let Some(window) = app.get_webview_window(LABEL) {
        let _ = window.set_always_on_top(on_top);
    }
    if let Ok(slot) = state.tray_pin.lock() {
        if let Some(item) = slot.as_ref() {
            let _ = item.set_checked(on_top);
        }
    }
    on_top
}

#[tauri::command]
pub async fn desktop_open_mini_viewer(app: AppHandle, request: OpenRequest) -> Result<(), String> {
    open(&app, request.query.as_deref(), request.hash.as_deref())
}

#[tauri::command]
pub fn desktop_set_mini_viewer_on_top(app: AppHandle, request: OnTopRequest) -> bool {
    set_on_top(&app, request.on_top)
}

#[tauri::command]
pub fn desktop_mini_viewer_on_top(state: State<'_, MiniViewer>) -> bool {
    state.on_top()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_query_falls_back_to_the_startup_query() {
        assert_eq!(validated_query(None), Ok(DEFAULT_QUERY));
        assert_eq!(validated_query(Some("")), Ok(DEFAULT_QUERY));
        assert!(validated_query(Some(DEFAULT_QUERY)).is_ok());
    }

    #[test]
    fn query_must_select_the_mini_view() {
        let query = "?modusDesktop=1&modusTarget=http%3A%2F%2F127.0.0.1%3A3777&modusView=mini";
        assert_eq!(validated_query(Some(query)), Ok(query));
        assert!(validated_query(Some("?modusDesktop=1")).is_err());
        assert!(validated_query(Some("?modusView=minimal")).is_err());
        assert!(validated_query(Some("?xmodusView=mini")).is_err());
    }

    #[test]
    fn query_cannot_escape_its_component() {
        assert!(validated_query(Some("modusView=mini")).is_err());
        assert!(validated_query(Some("?modusView=mini#other")).is_err());
        assert!(validated_query(Some("?modusView=mini&a=b c")).is_err());
        assert!(validated_query(Some("?modusView=mini&a=\"x\"")).is_err());
        assert!(validated_query(Some("?modusView=mini&a=\\x")).is_err());
        let long = format!("?modusView=mini&pad={}", "a".repeat(MAX_LOCATION_LEN));
        assert!(validated_query(Some(&long)).is_err());
    }

    #[test]
    fn hash_is_optional_and_single() {
        assert_eq!(validated_hash(None), Ok(""));
        assert_eq!(validated_hash(Some("")), Ok(""));
        let hash = "#dot/2f6c2b1e-6a51-4c1c-9d61-b0b2d5b3e2a4";
        assert_eq!(validated_hash(Some(hash)), Ok(hash));
        assert!(validated_hash(Some("dot/chat")).is_err());
        assert!(validated_hash(Some("#a#b")).is_err());
        assert!(validated_hash(Some("#a b")).is_err());
        assert!(validated_hash(Some("#<script>")).is_err());
    }
}
