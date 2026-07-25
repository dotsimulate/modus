use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_updater::{Update, UpdaterExt};
use url::Url;

use crate::backend::BackendSupervisor;

#[derive(Default)]
pub struct PendingUpdate(pub Mutex<Option<Update>>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopUpdateCheck {
    configured: bool,
    available: bool,
    version: Option<String>,
    current_version: String,
    notes: Option<String>,
    date: Option<String>,
}

fn release_configuration() -> Result<Option<(Url, &'static str)>, String> {
    let endpoint = option_env!("MODUS_UPDATER_ENDPOINT")
        .map(str::trim)
        .unwrap_or_default();
    let public_key = option_env!("MODUS_UPDATER_PUBKEY")
        .map(str::trim)
        .unwrap_or_default();
    if endpoint.is_empty() && public_key.is_empty() {
        return Ok(None);
    }
    if endpoint.is_empty() || public_key.is_empty() {
        return Err("the updater endpoint and public key must be configured together".into());
    }
    let endpoint =
        Url::parse(endpoint).map_err(|error| format!("invalid updater endpoint: {error}"))?;
    if endpoint.scheme() != "https" {
        return Err("the production updater endpoint must use HTTPS".into());
    }
    Ok(Some((endpoint, public_key)))
}

#[tauri::command]
pub async fn desktop_check_for_update(
    app: AppHandle,
    pending: State<'_, PendingUpdate>,
) -> Result<DesktopUpdateCheck, String> {
    let current_version = app.package_info().version.to_string();
    let Some((endpoint, public_key)) = release_configuration()? else {
        return Ok(DesktopUpdateCheck {
            configured: false,
            available: false,
            version: None,
            current_version,
            notes: None,
            date: None,
        });
    };

    let supervisor = Arc::clone(app.state::<Arc<BackendSupervisor>>().inner());
    let update = app
        .updater_builder()
        .endpoints(vec![endpoint])
        .map_err(|error| error.to_string())?
        .pubkey(public_key)
        .on_before_exit(move || {
            if let Err(error) = supervisor.stop_owned() {
                eprintln!("[desktop] pre-update backend shutdown warning: {error}");
            }
            supervisor.clear_runtime_state();
        })
        .build()
        .map_err(|error| error.to_string())?
        .check()
        .await
        .map_err(|error| error.to_string())?;

    let result = DesktopUpdateCheck {
        configured: true,
        available: update.is_some(),
        version: update.as_ref().map(|candidate| candidate.version.clone()),
        current_version,
        notes: update.as_ref().and_then(|candidate| candidate.body.clone()),
        date: update
            .as_ref()
            .and_then(|candidate| candidate.date.map(|date| date.to_string())),
    };
    *pending
        .0
        .lock()
        .map_err(|_| "pending updater lock poisoned".to_string())? = update;
    Ok(result)
}

#[tauri::command]
pub async fn desktop_install_pending_update(
    app: AppHandle,
    pending: State<'_, PendingUpdate>,
) -> Result<(), String> {
    let update = pending
        .0
        .lock()
        .map_err(|_| "pending updater lock poisoned".to_string())?
        .take()
        .ok_or_else(|| "no checked update is pending".to_string())?;
    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|error| error.to_string())?;
    app.restart();
}

#[cfg(test)]
mod tests {
    use super::release_configuration;

    #[test]
    fn updater_is_explicitly_unconfigured_without_release_inputs() {
        if option_env!("MODUS_UPDATER_ENDPOINT").is_none()
            && option_env!("MODUS_UPDATER_PUBKEY").is_none()
        {
            assert!(release_configuration()
                .expect("read updater configuration")
                .is_none());
        }
    }
}
