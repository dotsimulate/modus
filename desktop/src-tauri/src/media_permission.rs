//! Native media-permission requests from the desktop webview.
//!
//! On Linux the webview is WebKitGTK, which does not decide `getUserMedia`
//! itself: it emits `WebKitWebView::permission-request` and denies anything the
//! embedder leaves unanswered. wry installs no handler for it, so a microphone
//! request inside the packaged app was refused before it ever reached a device
//! and the composer reported "mic blocked" — while the same harness, opened in
//! a browser on the same machine, recorded fine. Windows (WebView2) and macOS
//! (WKWebView) resolve capture against the operating system's own permission
//! for the app process and never reach this module.
//!
//! What is granted here is deliberately narrow. Three conditions have to hold
//! at once, and each one covers a different way the grant could be wrong:
//!
//! 1. **Audio only.** A request that also names a video device is denied
//!    outright rather than quietly downgraded to its audio half. Nothing in
//!    Modus captures video, so a request that asks for it is not ours.
//! 2. **The bundled UI's own origin.** Checked against the webview's live URI
//!    at request time rather than once at startup, so a webview that has been
//!    navigated somewhere else cannot inherit the grant.
//! 3. **A recent mic press.** The composer arms this from its own click
//!    handler, at most [`ARM_WINDOW`] before the request arrives. Script in the
//!    webview that nobody asked to record — a model-authored HTML preview runs
//!    in a frame of this same webview — then gets exactly the denial it would
//!    get in a browser that was never granted the microphone.
//!
//! Every other permission WebKit can ask about (camera, geolocation,
//! notifications, pointer lock, device enumeration) is left to WebKit's own
//! default handler, which denies it. Adding a case here is adding an authority
//! the app did not have before; the origin check is a boundary, not a
//! formality.

// Only the Linux build calls the decision below, but it is compiled and tested
// on every platform on purpose: the boundary then gets checked on the Windows
// machine this crate is usually built on, instead of only where it runs.
#![cfg_attr(not(target_os = "linux"), allow(dead_code))]

use std::{
    sync::Mutex,
    time::{Duration, Instant},
};

use url::Url;

/// How long one mic press authorizes capture for.
///
/// A single press can produce more than one native request: resolving a saved
/// mic by label takes a throwaway probe stream before the real capture, and an
/// unsupported constraint set is retried bare. The window has to cover that
/// burst while staying far too short to still be open when unrelated page
/// script asks later.
pub const ARM_WINDOW: Duration = Duration::from_secs(15);

/// The last time the user asked to record.
///
/// Managed application state, written by `desktop_arm_microphone` and read by
/// the Linux permission handler. It is a timestamp rather than a flag so a
/// press that never produced a request cannot leave capture authorized
/// indefinitely.
#[derive(Default)]
pub struct MicrophoneArm(Mutex<Option<Instant>>);

impl MicrophoneArm {
    /// Record a mic press. A press that lands while an earlier one is still
    /// live simply extends the window.
    pub fn arm(&self) {
        self.arm_at(Instant::now());
    }

    fn arm_at(&self, now: Instant) {
        if let Ok(mut slot) = self.0.lock() {
            *slot = Some(now);
        }
    }

    /// Whether a press is recent enough to authorize capture right now.
    pub fn is_armed(&self) -> bool {
        self.is_armed_at(Instant::now())
    }

    fn is_armed_at(&self, now: Instant) -> bool {
        self.0.lock().is_ok_and(|slot| {
            slot.is_some_and(|armed| now.saturating_duration_since(armed) <= ARM_WINDOW)
        })
    }
}

/// Whether `uri` is the bundled Modus UI this shell shipped with.
///
/// The production origin is the custom protocol Tauri serves `frontendDist`
/// from — `tauri://localhost` on Linux and macOS, `http(s)://tauri.localhost`
/// on Windows. `devUrl` is a plain loopback origin and is only trusted in a
/// development build, which is never what a user installs.
pub fn is_trusted_app_uri(uri: Option<&str>, allow_dev_server: bool) -> bool {
    let Some(parsed) = uri.and_then(|value| Url::parse(value).ok()) else {
        return false;
    };
    let host = parsed.host_str().unwrap_or_default();
    match parsed.scheme() {
        "tauri" => host == "localhost",
        "http" | "https" if host == "tauri.localhost" => true,
        "http" if allow_dev_server => host == "localhost" || host == "127.0.0.1",
        _ => false,
    }
}

/// Whether a WebKitGTK user-media request should be granted.
///
/// Split out from the signal handler so the decision is testable on every
/// platform, including the Windows machine this crate is usually built on.
pub fn allow_user_media(
    uri: Option<&str>,
    for_audio: bool,
    for_video: bool,
    armed: bool,
    allow_dev_server: bool,
) -> bool {
    for_audio && !for_video && armed && is_trusted_app_uri(uri, allow_dev_server)
}

/// Attach the Linux permission handler to the main window's webview.
///
/// Called from the app's setup hook, where the window declared in
/// `tauri.conf.json` already exists. `with_webview` is Tauri's supported hook
/// onto the platform webview; nothing here patches a vendored crate.
#[cfg(target_os = "linux")]
pub fn install(app: &tauri::AppHandle, arm: std::sync::Arc<MicrophoneArm>) {
    use tauri::Manager;

    let Some(window) = app.get_webview_window("main") else {
        eprintln!("[desktop] no main window to attach the media permission handler to");
        return;
    };
    let result = window.with_webview(move |webview| {
        use webkit2gtk::{
            glib::prelude::*, PermissionRequestExt, SettingsExt, UserMediaPermissionRequest,
            UserMediaPermissionRequestExt, WebViewExt,
        };

        let view = webview.inner();
        // WebKitGTK compiles MediaStream in but leaves it off, and wry does not
        // turn it on, so without this `navigator.mediaDevices` is absent and no
        // permission request is ever emitted to answer.
        if let Some(settings) = WebViewExt::settings(&view) {
            settings.set_enable_media_stream(true);
        }
        view.connect_permission_request(move |view, request| {
            let Some(media) = request.dynamic_cast_ref::<UserMediaPermissionRequest>() else {
                // Not a capture request. Returning false hands it back to
                // WebKit's default handler, which denies it.
                return false;
            };
            let uri = view.uri();
            let allowed = allow_user_media(
                uri.as_deref(),
                media.is_for_audio_device(),
                media.is_for_video_device(),
                arm.is_armed(),
                cfg!(debug_assertions),
            );
            if allowed {
                media.allow();
            } else {
                // Denied explicitly rather than by falling through, so the page
                // gets its NotAllowedError immediately and the composer can say
                // why instead of hanging on a request nobody answered.
                media.deny();
                eprintln!(
                    "[desktop] denied a user-media request (audio={}, video={}, armed={})",
                    media.is_for_audio_device(),
                    media.is_for_video_device(),
                    arm.is_armed()
                );
            }
            true
        });
    });
    if let Err(error) = result {
        eprintln!("[desktop] could not install the media permission handler: {error}");
    }
}

/// No-op off Linux: WebView2 and WKWebView never ask the embedder.
#[cfg(not(target_os = "linux"))]
pub fn install(_app: &tauri::AppHandle, _arm: std::sync::Arc<MicrophoneArm>) {}

#[cfg(test)]
mod tests {
    use super::*;

    const APP_URI: &str = "tauri://localhost/index.html?modusDesktop=1&modusDiscover=local";

    #[test]
    fn trusts_the_bundled_app_origin() {
        assert!(is_trusted_app_uri(Some(APP_URI), false));
        assert!(is_trusted_app_uri(Some("tauri://localhost"), false));
        // The Windows and Android spelling of the same origin.
        assert!(is_trusted_app_uri(Some("http://tauri.localhost/"), false));
        assert!(is_trusted_app_uri(Some("https://tauri.localhost/"), false));
    }

    #[test]
    fn rejects_anything_the_shell_did_not_ship() {
        assert!(!is_trusted_app_uri(Some("https://example.com/"), false));
        assert!(!is_trusted_app_uri(Some("https://machine.ts.net/"), false));
        // A lookalike host under a scheme we do trust elsewhere.
        assert!(!is_trusted_app_uri(
            Some("https://tauri.localhost.evil.com/"),
            false
        ));
        assert!(!is_trusted_app_uri(Some("tauri://evil.com/"), false));
        assert!(!is_trusted_app_uri(Some("file:///etc/passwd"), false));
        assert!(!is_trusted_app_uri(Some("not a url"), false));
        assert!(!is_trusted_app_uri(None, false));
    }

    #[test]
    fn trusts_the_dev_server_only_in_a_development_build() {
        assert!(!is_trusted_app_uri(Some("http://localhost:5180/"), false));
        assert!(is_trusted_app_uri(Some("http://localhost:5180/"), true));
        assert!(is_trusted_app_uri(Some("http://127.0.0.1:5180/"), true));
        // Still not a licence for the loopback backend over https, or for a
        // tailnet origin that merely reaches the same harness.
        assert!(!is_trusted_app_uri(Some("https://machine.ts.net/"), true));
    }

    #[test]
    fn grants_armed_audio_capture_from_the_app() {
        assert!(allow_user_media(Some(APP_URI), true, false, true, false));
    }

    #[test]
    fn refuses_capture_nobody_asked_for() {
        assert!(!allow_user_media(Some(APP_URI), true, false, false, false));
    }

    #[test]
    fn refuses_video_even_alongside_audio() {
        assert!(!allow_user_media(Some(APP_URI), true, true, true, false));
        assert!(!allow_user_media(Some(APP_URI), false, true, true, false));
    }

    #[test]
    fn refuses_capture_from_a_navigated_webview() {
        assert!(!allow_user_media(
            Some("https://example.com/"),
            true,
            false,
            true,
            false
        ));
        assert!(!allow_user_media(None, true, false, true, false));
    }

    #[test]
    fn an_arm_expires() {
        let arm = MicrophoneArm::default();
        let now = Instant::now();
        assert!(!arm.is_armed_at(now), "nothing is armed before a press");

        arm.arm_at(now);
        assert!(arm.is_armed_at(now));
        assert!(arm.is_armed_at(now + ARM_WINDOW));
        assert!(!arm.is_armed_at(now + ARM_WINDOW + Duration::from_millis(1)));

        // A second press extends the window rather than being ignored.
        arm.arm_at(now + ARM_WINDOW);
        assert!(arm.is_armed_at(now + ARM_WINDOW + Duration::from_millis(1)));
    }
}
