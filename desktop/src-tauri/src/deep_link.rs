//! `modus://` deep links.
//!
//! The scheme is registered with the operating system, so anything on the
//! machine — including a web page the user clicks a link on — can hand the app
//! a URL. Every incoming link is therefore untrusted input. It is parsed and
//! validated here, and the only thing a valid link can do is move the window to
//! something that already exists. A link carries no credential, grants no
//! authority, and is never evaluated as code.
//!
//! Two forms are supported today:
//!
//! ```text
//! modus://session/<sessionId>
//! modus://page/<project>/<pageId>
//! ```
//!
//! Both name something the app already has; neither creates, configures, or
//! runs anything. A page link resolves against the same page list the sidebar
//! browses, so a project's own authored pages are addressable without this
//! layer knowing they exist — which is the point. There is deliberately no
//! `modus://move/...`: opening a surface is inert, but invoking a move is not,
//! and anything on the machine can hand us a URL.
//!
//! The asymmetry between the two forms is deliberate and worth understanding
//! before adding a third. A **session id is globally unique**, so the project
//! that owns it is *derivable* — encoding one would be redundant and could
//! contradict the id. A **page id is unique only within a project**: the same
//! id names different pages in different projects, and even a built-in page
//! renders a different project's content, under that project's theme and
//! interface config. There the project is not redundant, it is the missing
//! half of the address, so it is required. A link kind should carry exactly
//! what cannot be derived from the rest of it, and no more.
//!
//! Neither form carries a *user profile* in the routing sense — the profile
//! segment of the frontend hash route is a local view preference that
//! `useHashRouter` seeds from storage when the URL omits it. Further link
//! kinds should be added as new hosts next to `session` and `page`, so the
//! grammar stays explicit rather than free-form.

use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use url::Url;

/// Event the frontend subscribes to. Payload is a [`DeepLinkTarget`].
pub const DEEP_LINK_EVENT: &str = "modus:deep-link";

/// Generous cap; a well-formed link is well under 100 bytes.
const MAX_URL_LEN: usize = 512;

/// Project and page names are free-form strings in JSON, so the link grammar
/// accepts a conservative subset rather than trying to mirror an absent rule.
const MAX_SLUG_LEN: usize = 64;

/// A validated deep-link destination. Serialized tagged, so the frontend
/// switches on `kind` rather than sniffing which field is present.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum DeepLinkTarget {
    #[serde(rename_all = "camelCase")]
    Session {
        session_id: String,
    },
    Page {
        project: String,
        slug: String,
    },
}

/// A link can arrive before the webview is listening — when the OS launches the
/// app to handle it — so the target is parked here and claimed by the frontend
/// once it mounts.
#[derive(Default)]
pub struct PendingDeepLink(Mutex<Option<DeepLinkTarget>>);

impl PendingDeepLink {
    fn store(&self, target: DeepLinkTarget) {
        if let Ok(mut slot) = self.0.lock() {
            *slot = Some(target);
        }
    }

    /// Claim the parked target. Claiming clears it, so reloading the webview
    /// does not silently re-navigate the user to an old link.
    pub fn take(&self) -> Option<DeepLinkTarget> {
        self.0.lock().ok().and_then(|mut slot| slot.take())
    }
}

/// Park the first valid target from `urls` and announce it to the frontend.
///
/// Returns whether anything was handled, so the caller can decide about
/// surfacing the window — an unparseable link should not be able to raise it.
pub fn dispatch(app: &AppHandle, urls: impl IntoIterator<Item = String>) -> bool {
    let Some(target) = urls.into_iter().find_map(|url| parse(&url)) else {
        return false;
    };
    app.state::<PendingDeepLink>().store(target.clone());
    let _ = app.emit(DEEP_LINK_EVENT, target);
    true
}

/// Parse a supported `modus://` link into a target, or `None` for anything else.
pub fn parse(url: &str) -> Option<DeepLinkTarget> {
    if url.len() > MAX_URL_LEN {
        return None;
    }
    let parsed = Url::parse(url).ok()?;
    if parsed.scheme() != "modus" {
        return None;
    }
    // `modus:` is not a "special" scheme, so the URL parser leaves the host
    // verbatim rather than lowercasing it the way it would for http/https.
    // Normalize the link *kind* here; the value keeps its case because it sits
    // in the path, which is never case-folded for any scheme — and both session
    // ids and page ids are compared case-sensitively by the frontend.
    let kind = parsed.host_str()?;
    // A second path segment leaves a `/` in the value, which every check below
    // rejects — so a trailing segment can never be smuggled past one of them.
    let value = parsed.path().trim_start_matches('/');

    if kind.eq_ignore_ascii_case("session") {
        return is_session_id(value).then(|| DeepLinkTarget::Session {
            session_id: value.to_string(),
        });
    }
    if kind.eq_ignore_ascii_case("page") {
        // Exactly two segments. A third leaves a `/` in `slug`, which
        // `is_link_slug` rejects along with everything else path-shaped.
        let (project, slug) = value.split_once('/')?;
        return (is_link_slug(project) && is_link_slug(slug)).then(|| DeepLinkTarget::Page {
            project: project.to_string(),
            slug: slug.to_string(),
        });
    }
    None
}

/// Mirrors the shapes the frontend accepts in `harness/ui/src/sessionIds.ts`:
/// a UUID, or a legacy `session-`/`ses-` id. Both are case-insensitive there.
fn is_session_id(value: &str) -> bool {
    is_uuid(value) || is_legacy_session_id(value)
}

fn is_uuid(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 36
        && bytes.iter().enumerate().all(|(index, byte)| match index {
            8 | 13 | 18 | 23 => *byte == b'-',
            _ => byte.is_ascii_hexdigit(),
        })
}

/// Project names and page ids are both any string in some JSON file, and
/// nothing in the harness constrains their shape — so rather than mirroring a
/// rule that does not exist, the link grammar accepts a conservative subset and
/// leaves exotic names unlinkable. Notably absent: separators of any kind, so a
/// segment can neither be read as a path nor forge a different route once the
/// frontend turns it into a `page:` / `move-page:` view string.
fn is_link_slug(value: &str) -> bool {
    if value.len() > MAX_SLUG_LEN {
        return false;
    }
    let mut bytes = value.bytes();
    // Requiring an alphanumeric lead also rules out `.` and `..`.
    bytes
        .next()
        .is_some_and(|byte| byte.is_ascii_alphanumeric())
        && bytes.all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

fn is_legacy_session_id(value: &str) -> bool {
    let Some(rest) = value
        .strip_prefix("session-")
        .or_else(|| value.strip_prefix("ses-"))
    else {
        return false;
    };
    let Some((digits, suffix)) = rest.split_once('-') else {
        return false;
    };
    !digits.is_empty()
        && digits.bytes().all(|byte| byte.is_ascii_digit())
        && !suffix.is_empty()
        && suffix.bytes().all(|byte| byte.is_ascii_alphanumeric())
}

#[cfg(test)]
mod tests {
    use super::*;

    const UUID: &str = "2f3c9a10-4b7e-4c81-9d55-0e1a2b3c4d5e";

    fn session_id_of(url: &str) -> Option<String> {
        match parse(url) {
            Some(DeepLinkTarget::Session { session_id }) => Some(session_id),
            _ => None,
        }
    }

    fn page_of(url: &str) -> Option<(String, String)> {
        match parse(url) {
            Some(DeepLinkTarget::Page { project, slug }) => Some((project, slug)),
            _ => None,
        }
    }

    #[test]
    fn accepts_a_uuid_session_link() {
        assert_eq!(
            session_id_of(&format!("modus://session/{UUID}")),
            Some(UUID.to_string())
        );
    }

    #[test]
    fn accepts_legacy_session_ids() {
        assert_eq!(
            session_id_of("modus://session/session-1731020000-a1b2c3"),
            Some("session-1731020000-a1b2c3".to_string())
        );
        assert_eq!(
            session_id_of("modus://session/ses-42-xyz9"),
            Some("ses-42-xyz9".to_string())
        );
    }

    #[test]
    fn preserves_id_case_because_it_lives_in_the_path() {
        let upper = UUID.to_uppercase();
        assert_eq!(
            session_id_of(&format!("modus://session/{upper}")),
            Some(upper)
        );
    }

    /// The URL parser does not case-fold the host of a non-special scheme like
    /// `modus:`, so the kind is normalized in `parse` rather than by the parser.
    #[test]
    fn accepts_the_link_kind_in_any_case() {
        assert!(parse(&format!("modus://SESSION/{UUID}")).is_some());
        assert!(parse(&format!("modus://Session/{UUID}")).is_some());
    }

    /// Ids of pages that actually ship — built-in, project-authored, and a bare
    /// move page — so the accepted subset is pinned to real content.
    #[test]
    fn accepts_page_links_for_real_page_ids() {
        for id in [
            "actions",
            "chat-mobile",
            "terminals-2x2",
            "modus-brain",
            "nano-banana",
        ] {
            assert_eq!(
                page_of(&format!("modus://page/modus/{id}")),
                Some(("modus".to_string(), id.to_string())),
                "{id}"
            );
        }
    }

    #[test]
    fn preserves_page_segment_case() {
        assert_eq!(
            page_of("modus://PAGE/MyProject/Cockpit"),
            Some(("MyProject".to_string(), "Cockpit".to_string()))
        );
    }

    /// The project is the missing half of a page's address, not decoration —
    /// the same id names a different page under a different project.
    #[test]
    fn rejects_a_page_link_without_a_project() {
        assert!(parse("modus://page/cockpit").is_none());
        assert!(parse("modus://page/").is_none());
        assert!(parse("modus://page/cockpit/").is_none());
    }

    #[test]
    fn rejects_page_segments_that_could_be_read_as_a_path_or_a_route() {
        assert!(parse("modus://page/modus/.").is_none());
        assert!(parse("modus://page/./cockpit").is_none());
        assert!(parse("modus://page/modus/etc/passwd").is_none());
        // Would forge a different view once the frontend builds `page:<slug>`.
        assert!(parse("modus://page/modus/git:move-page:board").is_none());
        assert!(parse("modus://page/modus/-leading-dash").is_none());
        assert!(parse(&format!(
            "modus://page/modus/{}",
            "a".repeat(MAX_SLUG_LEN + 1)
        ))
        .is_none());
        assert!(parse(&format!(
            "modus://page/{}/cockpit",
            "a".repeat(MAX_SLUG_LEN + 1)
        ))
        .is_none());
    }

    /// The URL parser removes dot segments before we ever see the path, so a
    /// link has more than one spelling and the one that survives is always a
    /// single normalized segment. Worth pinning: the traversal-shaped rejections
    /// above pass because the *normalized* value fails validation, not because
    /// the raw text was inspected.
    #[test]
    fn dot_segments_are_normalized_away_before_validation() {
        assert_eq!(
            page_of("modus://page/modus/git/../chat"),
            Some(("modus".to_string(), "chat".to_string()))
        );
        assert_eq!(
            session_id_of(&format!("modus://session/whatever/../{UUID}")),
            Some(UUID.to_string())
        );
    }

    /// A move can be opened only where it already exists as a page. There is no
    /// `modus://move/...`, because running one is not an inert act.
    #[test]
    fn rejects_move_links() {
        assert!(parse("modus://move/board").is_none());
        assert!(parse("modus://move/board?input=x").is_none());
    }

    #[test]
    fn tags_the_serialized_payload_by_kind() {
        let session = serde_json::to_value(DeepLinkTarget::Session {
            session_id: UUID.to_string(),
        })
        .unwrap();
        assert_eq!(session["kind"], "session");
        assert_eq!(session["sessionId"], UUID);

        let page = serde_json::to_value(DeepLinkTarget::Page {
            project: "modus".to_string(),
            slug: "cockpit".to_string(),
        })
        .unwrap();
        assert_eq!(page["kind"], "page");
        assert_eq!(page["project"], "modus");
        assert_eq!(page["slug"], "cockpit");
    }

    #[test]
    fn rejects_other_schemes() {
        assert!(parse(&format!("https://session/{UUID}")).is_none());
        assert!(parse(&format!("modus-evil://session/{UUID}")).is_none());
    }

    #[test]
    fn rejects_unknown_link_kinds() {
        assert!(parse(&format!("modus://open/{UUID}")).is_none());
        assert!(parse(&format!("modus://quit/{UUID}")).is_none());
    }

    #[test]
    fn rejects_ids_that_are_not_session_ids() {
        assert!(parse("modus://session/").is_none());
        assert!(parse("modus://session/not-a-session").is_none());
        assert!(parse("modus://session/../../etc/passwd").is_none());
        // A trailing segment must not be smuggled past the id check.
        assert!(parse(&format!("modus://session/{UUID}/extra")).is_none());
    }

    #[test]
    fn rejects_script_bearing_payloads() {
        assert!(parse("modus://session/<script>alert(1)</script>").is_none());
        assert!(parse("modus://session/javascript:alert(1)").is_none());
    }

    #[test]
    fn rejects_absurdly_long_urls() {
        let long = format!("modus://session/{}", "a".repeat(MAX_URL_LEN));
        assert!(parse(&long).is_none());
    }

    #[test]
    fn rejects_a_uuid_with_a_non_hex_character() {
        assert!(parse("modus://session/2f3c9a10-4b7e-4c81-9d55-0e1a2b3c4d5g").is_none());
    }

    #[test]
    fn pending_target_is_claimed_exactly_once() {
        let pending = PendingDeepLink::default();
        let target = DeepLinkTarget::Session {
            session_id: UUID.to_string(),
        };
        assert_eq!(pending.take(), None);
        pending.store(target.clone());
        assert_eq!(pending.take(), Some(target));
        assert_eq!(pending.take(), None);
    }
}
