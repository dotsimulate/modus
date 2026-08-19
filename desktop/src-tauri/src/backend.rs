use std::{
    collections::{HashMap, VecDeque},
    env,
    fs::{self, File, OpenOptions},
    io::{BufRead, BufReader, Read, Write},
    net::{Ipv4Addr, SocketAddr, SocketAddrV4, TcpListener, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use uuid::Uuid;

use crate::job::ProcessJob;
use crate::tailscale::{DesktopTailscaleStatus, TailscaleManager};

const STARTUP_TIMEOUT: Duration = Duration::from_secs(45);
const GRACEFUL_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(8);
#[cfg(windows)]
const BACKEND_LAUNCHER_FLAG: &str = "--modus-backend-launcher";
#[cfg(windows)]
const BACKEND_LAUNCHER_TIMEOUT: Duration = Duration::from_secs(45);
const BACKEND_STABLE_RESET: Duration = Duration::from_secs(60);
const STDERR_TAIL_LINES: usize = 12;
const STDERR_TAIL_CHARS: usize = 2_000;
const BACKEND_RESTART_BACKOFF: [Duration; 3] = [
    Duration::from_millis(250),
    Duration::from_secs(1),
    Duration::from_secs(3),
];

#[cfg(windows)]
pub fn maybe_run_backend_launcher() -> Option<i32> {
    let mut arguments = env::args_os();
    let _executable = arguments.next()?;
    if arguments.next()?.to_string_lossy() != BACKEND_LAUNCHER_FLAG {
        return None;
    }

    let gate = arguments.next().map(PathBuf::from);
    let bun = arguments.next().map(PathBuf::from);
    let server = arguments.next().map(PathBuf::from);
    if arguments.next().is_some() {
        return Some(2);
    }
    Some(match (gate, bun, server) {
        (Some(gate), Some(bun), Some(server)) => run_backend_launcher(&gate, &bun, &server),
        _ => 2,
    })
}

#[cfg(not(windows))]
pub fn maybe_run_backend_launcher() -> Option<i32> {
    None
}

#[cfg(windows)]
fn run_backend_launcher(gate: &Path, bun: &Path, server: &Path) -> i32 {
    let deadline = Instant::now() + BACKEND_LAUNCHER_TIMEOUT;
    while !gate.is_file() {
        if Instant::now() >= deadline {
            eprintln!("[desktop-launcher] timed out waiting for Job Object assignment gate");
            return 3;
        }
        thread::sleep(Duration::from_millis(25));
    }
    let _ = fs::remove_file(gate);

    let mut command = Command::new(bun);
    command.arg(server).stdin(Stdio::null());
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command.creation_flags(CREATE_NO_WINDOW);

    let mut backend = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            eprintln!("[desktop-launcher] failed to start packaged Bun backend: {error}");
            return 4;
        }
    };
    match backend.wait() {
        Ok(status) => status.code().unwrap_or(1),
        Err(error) => {
            eprintln!("[desktop-launcher] failed while waiting for packaged backend: {error}");
            5
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BootstrapRequest {
    pub mode: String,
    pub url: Option<String>,
    pub vault: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BootstrapResponse {
    pub mode: String,
    pub api_base: String,
    pub target_id: String,
    pub label: String,
    pub token: Option<String>,
    pub instance_id: Option<String>,
    pub version: String,
    pub backend_pid: Option<u32>,
    pub port: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tailscale: Option<DesktopTailscaleStatus>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReadyRecord {
    event: String,
    pid: u32,
    port: u16,
    instance_id: String,
    version: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeRecord<'a> {
    mode: &'a str,
    desktop_pid: u32,
    backend_pid: Option<u32>,
    port: Option<u16>,
    instance_id: Option<&'a str>,
    version: &'a str,
    api_base: Option<&'a str>,
    ui_connected: bool,
    tailscale: Option<&'a DesktopTailscaleStatus>,
}

#[derive(Clone)]
struct BackendPaths {
    bun: PathBuf,
    server: PathBuf,
    resources: PathBuf,
    runtime: PathBuf,
    logs: PathBuf,
}

struct OwnedBackend {
    child: Child,
    job: ProcessJob,
    response: BootstrapResponse,
}

struct SupervisorMap<T> {
    entries: Mutex<HashMap<String, Arc<T>>>,
}

impl<T> Default for SupervisorMap<T> {
    fn default() -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
        }
    }
}

impl<T> SupervisorMap<T> {
    fn get_or_try_insert_with(
        &self,
        key: String,
        create: impl FnOnce() -> Result<T, String>,
    ) -> Result<(Arc<T>, bool), String> {
        let mut entries = self
            .entries
            .lock()
            .map_err(|_| "backend supervisor map lock poisoned".to_string())?;
        if let Some(existing) = entries.get(&key) {
            return Ok((Arc::clone(existing), false));
        }
        let value = Arc::new(create()?);
        entries.insert(key, Arc::clone(&value));
        Ok((value, true))
    }

    fn values(&self) -> Result<Vec<Arc<T>>, String> {
        self.entries
            .lock()
            .map(|entries| entries.values().cloned().collect())
            .map_err(|_| "backend supervisor map lock poisoned".to_string())
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.entries
            .lock()
            .map(|entries| entries.len())
            .unwrap_or(0)
    }
}

pub struct BackendSupervisor {
    app: AppHandle,
    tailscale: Arc<TailscaleManager>,
    vaults: SupervisorMap<VaultBackendSupervisor>,
    initial_vault: Option<String>,
}

struct VaultBackendSupervisor {
    slug: Option<String>,
    paths: BackendPaths,
    tailscale: Option<Arc<TailscaleManager>>,
    owned: Mutex<Option<OwnedBackend>>,
    runtime_state: PathBuf,
    desired_managed: AtomicBool,
    restart_budget_reset: AtomicBool,
}

impl BackendSupervisor {
    pub fn new(app: &AppHandle) -> Result<Self, String> {
        let initial_vault = current_vault_slug()?;
        let tailscale = Arc::new(TailscaleManager::resolve(app)?);
        Ok(Self {
            app: app.clone(),
            tailscale,
            vaults: SupervisorMap::default(),
            initial_vault,
        })
    }

    fn vault(&self, slug: Option<String>) -> Result<Arc<VaultBackendSupervisor>, String> {
        let key = vault_key(slug.as_deref());
        let is_default = slug.is_none();
        let (vault, created) = self.vaults.get_or_try_insert_with(key, || {
            VaultBackendSupervisor::new(
                &self.app,
                slug,
                is_default.then(|| Arc::clone(&self.tailscale)),
                self.initial_vault.as_deref(),
            )
        })?;
        if created {
            vault.start_monitor(self.app.clone());
        }
        Ok(vault)
    }

    fn requested_vault(&self, value: Option<&str>) -> Result<Option<String>, String> {
        match value {
            Some(value) => normalize_vault_slug(Some(value)),
            None => Ok(self.initial_vault.clone()),
        }
    }

    pub fn bootstrap(&self, request: BootstrapRequest) -> Result<BootstrapResponse, String> {
        let slug = self.requested_vault(request.vault.as_deref())?;
        self.vault(slug)?.bootstrap(request)
    }

    pub fn ensure_vault(&self, slug: Option<&str>) -> Result<BootstrapResponse, String> {
        let slug = normalize_vault_slug(slug)?;
        let vault = self.vault(slug)?;
        vault.desired_managed.store(true, Ordering::SeqCst);
        vault.restart_budget_reset.store(true, Ordering::SeqCst);
        vault.ensure_managed()
    }

    pub fn mark_ui_connected(&self, instance_id: &str, port: u16) -> Result<(), String> {
        for vault in self.vaults.values()? {
            if vault.matches(instance_id, port)? {
                return vault.mark_ui_connected(instance_id, port);
            }
        }
        Err("the UI reported a backend other than a managed instance".into())
    }

    pub fn stop_owned(&self) -> Result<(), String> {
        let mut errors = Vec::new();
        for vault in self.vaults.values()? {
            if let Err(error) = vault.stop_owned() {
                errors.push(format!("{}: {error}", vault.display_name()));
            }
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors.join("; "))
        }
    }

    pub fn tailscale_status(&self) -> Result<DesktopTailscaleStatus, String> {
        self.vault(None)?.tailscale_status()
    }

    pub fn set_tailscale_enabled(&self, enabled: bool) -> Result<DesktopTailscaleStatus, String> {
        self.vault(None)?.set_tailscale_enabled(enabled)
    }

    pub fn clear_runtime_state(&self) {
        if let Ok(vaults) = self.vaults.values() {
            for vault in vaults {
                vault.clear_runtime_state();
            }
        }
    }

    pub fn start_monitor(&self, _app: AppHandle) {
        for slug in read_autostart_vaults(&self.app) {
            match self.vault(Some(slug.clone())) {
                Ok(vault) => {
                    vault.desired_managed.store(true, Ordering::SeqCst);
                    vault.restart_budget_reset.store(true, Ordering::SeqCst);
                    thread::spawn(move || {
                        if let Err(error) = vault.ensure_managed() {
                            eprintln!("[desktop] autostart Vault {slug} failed: {error}");
                        }
                    });
                }
                Err(error) => {
                    eprintln!("[desktop] could not prepare autostart Vault {slug}: {error}")
                }
            }
        }
    }
}

impl VaultBackendSupervisor {
    fn new(
        app: &AppHandle,
        slug: Option<String>,
        tailscale: Option<Arc<TailscaleManager>>,
        initial_vault: Option<&str>,
    ) -> Result<Self, String> {
        let paths = BackendPaths::resolve(app, slug.as_deref(), initial_vault)?;
        fs::create_dir_all(&paths.runtime)
            .map_err(display_error("create desktop runtime directory"))?;
        fs::create_dir_all(&paths.logs).map_err(display_error("create desktop logs directory"))?;
        let runtime_state = paths.runtime.join("desktop-supervisor.json");
        Ok(Self {
            slug,
            paths,
            tailscale,
            owned: Mutex::new(None),
            runtime_state,
            desired_managed: AtomicBool::new(false),
            restart_budget_reset: AtomicBool::new(false),
        })
    }

    fn bootstrap(&self, request: BootstrapRequest) -> Result<BootstrapResponse, String> {
        match request.mode.as_str() {
            "remote" => {
                self.desired_managed.store(false, Ordering::SeqCst);
                self.stop_owned()?;
                let url = validated_remote_url(request.url.as_deref())?;
                let response = BootstrapResponse {
                    mode: "remote".into(),
                    api_base: url.clone(),
                    target_id: format!("remote:{url}"),
                    label: url.clone(),
                    token: None,
                    instance_id: None,
                    version: env!("CARGO_PKG_VERSION").into(),
                    backend_pid: None,
                    port: None,
                    tailscale: None,
                };
                self.write_runtime_record(&response, false)?;
                Ok(response)
            }
            "external-local" => {
                self.desired_managed.store(false, Ordering::SeqCst);
                self.stop_owned()?;
                let response = BootstrapResponse {
                    mode: "external-local".into(),
                    api_base: request.url.unwrap_or_default(),
                    target_id: "external-local".into(),
                    label: "Development daemon".into(),
                    token: None,
                    instance_id: None,
                    version: env!("CARGO_PKG_VERSION").into(),
                    backend_pid: None,
                    port: None,
                    tailscale: None,
                };
                self.write_runtime_record(&response, false)?;
                Ok(response)
            }
            "managed-local" => {
                self.desired_managed.store(true, Ordering::SeqCst);
                self.restart_budget_reset.store(true, Ordering::SeqCst);
                self.ensure_managed()
            }
            other => Err(format!("unsupported desktop backend mode: {other}")),
        }
    }

    fn matches(&self, instance_id: &str, port: u16) -> Result<bool, String> {
        let owned = self
            .owned
            .lock()
            .map_err(|_| "backend supervisor lock poisoned".to_string())?;
        Ok(owned.as_ref().is_some_and(|backend| {
            backend.response.instance_id.as_deref() == Some(instance_id)
                && backend.response.port == Some(port)
        }))
    }

    fn display_name(&self) -> &str {
        self.slug.as_deref().unwrap_or("Main")
    }

    fn mark_ui_connected(&self, instance_id: &str, port: u16) -> Result<(), String> {
        let owned = self
            .owned
            .lock()
            .map_err(|_| "backend supervisor lock poisoned".to_string())?;
        let backend = owned
            .as_ref()
            .ok_or_else(|| "no managed backend is running".to_string())?;
        if backend.response.instance_id.as_deref() != Some(instance_id)
            || backend.response.port != Some(port)
        {
            return Err("the UI reported a backend other than the managed instance".into());
        }
        self.write_runtime_record(&backend.response, true)
    }

    fn stop_owned(&self) -> Result<(), String> {
        self.desired_managed.store(false, Ordering::SeqCst);
        let mut owned = self
            .owned
            .lock()
            .map_err(|_| "backend supervisor lock poisoned".to_string())?;
        let Some(mut backend) = owned.take() else {
            return Ok(());
        };

        let port = backend
            .response
            .port
            .expect("managed backend response has a port");
        let instance_id = backend.response.instance_id.as_deref().unwrap_or_default();
        let route_error = self
            .tailscale
            .as_ref()
            .and_then(|tailscale| tailscale.release(port, instance_id).err());
        let token = backend.response.token.as_deref().unwrap_or_default();
        let _ = request_local(port, "POST", "/api/internal/shutdown", Some(token));

        let deadline = Instant::now() + GRACEFUL_SHUTDOWN_TIMEOUT;
        let mut exited = false;
        while Instant::now() < deadline {
            match backend.child.try_wait() {
                Ok(Some(_)) => {
                    exited = true;
                    break;
                }
                Ok(None) => thread::sleep(Duration::from_millis(100)),
                Err(_) => break,
            }
        }

        if !exited {
            let _ = backend.job.terminate(1);
            let force_deadline = Instant::now() + Duration::from_secs(3);
            while Instant::now() < force_deadline {
                if matches!(backend.child.try_wait(), Ok(Some(_))) {
                    exited = true;
                    break;
                }
                thread::sleep(Duration::from_millis(50));
            }
        }
        drop(backend);

        let bind_deadline = Instant::now() + Duration::from_secs(3);
        let mut bindable = false;
        while Instant::now() < bind_deadline {
            match TcpListener::bind((Ipv4Addr::LOCALHOST, port)) {
                Ok(listener) => {
                    drop(listener);
                    bindable = true;
                    break;
                }
                Err(_) => thread::sleep(Duration::from_millis(100)),
            }
        }
        let _ = fs::remove_file(&self.runtime_state);
        if !exited {
            return Err("managed backend did not exit after Job Object termination".into());
        }
        if !bindable {
            return Err(format!(
                "managed backend port {port} was not bindable after shutdown"
            ));
        }
        if let Some(error) = route_error {
            return Err(format!(
                "managed backend stopped, but Tailnet route cleanup failed: {error}"
            ));
        }
        Ok(())
    }

    fn tailscale_status(&self) -> Result<DesktopTailscaleStatus, String> {
        let tailscale = self
            .tailscale
            .as_ref()
            .ok_or_else(|| "only Main can own Tailnet access".to_string())?;
        let owned = self
            .owned
            .lock()
            .map_err(|_| "backend supervisor lock poisoned".to_string())?;
        Ok(owned
            .as_ref()
            .and_then(|backend| backend.response.tailscale.clone())
            .unwrap_or_else(|| tailscale.configured_status()))
    }

    fn set_tailscale_enabled(&self, enabled: bool) -> Result<DesktopTailscaleStatus, String> {
        let tailscale = self
            .tailscale
            .as_ref()
            .ok_or_else(|| "only Main can own Tailnet access".to_string())?;
        let mut owned = self
            .owned
            .lock()
            .map_err(|_| "backend supervisor lock poisoned".to_string())?;
        if !enabled {
            if let Some(backend) = owned.as_ref() {
                let port = backend
                    .response
                    .port
                    .expect("managed backend response has a port");
                let instance_id = backend.response.instance_id.as_deref().unwrap_or_default();
                tailscale.release(port, instance_id)?;
            }
            tailscale.set_enabled(false)?;
            let status = tailscale.configured_status();
            if let Some(backend) = owned.as_mut() {
                backend.response.tailscale = Some(status.clone());
                self.write_runtime_record(&backend.response, true)?;
            }
            return Ok(status);
        }

        tailscale.set_enabled(true)?;
        let status = if let Some(backend) = owned.as_mut() {
            let port = backend
                .response
                .port
                .expect("managed backend response has a port");
            let instance_id = backend.response.instance_id.as_deref().unwrap_or_default();
            let status = tailscale.reconcile(port, instance_id);
            backend.response.tailscale = Some(status.clone());
            self.write_runtime_record(&backend.response, true)?;
            status
        } else {
            tailscale.configured_status()
        };
        Ok(status)
    }

    fn clear_runtime_state(&self) {
        let _ = fs::remove_file(&self.runtime_state);
    }

    fn start_monitor(self: &Arc<Self>, app: AppHandle) {
        let supervisor = Arc::downgrade(self);
        thread::spawn(move || {
            let mut restart_attempts = 0usize;
            let mut stable_since = None;

            loop {
                thread::sleep(Duration::from_millis(500));
                let Some(supervisor) = supervisor.upgrade() else {
                    return;
                };
                if supervisor
                    .restart_budget_reset
                    .swap(false, Ordering::SeqCst)
                {
                    restart_attempts = 0;
                    stable_since = None;
                }

                let crashed = {
                    let mut owned = match supervisor.owned.lock() {
                        Ok(owned) => owned,
                        Err(_) => {
                            eprintln!(
                                "[desktop] backend monitor stopped: supervisor lock poisoned"
                            );
                            return;
                        }
                    };
                    match owned.as_mut().map(|backend| backend.child.try_wait()) {
                        Some(Ok(Some(status))) => {
                            eprintln!(
                                "[desktop] managed backend process exited unexpectedly: {status}"
                            );
                            owned.take()
                        }
                        Some(Err(error)) => {
                            eprintln!(
                                "[desktop] managed backend process could not be polled: {error}"
                            );
                            owned.take()
                        }
                        Some(Ok(None)) => {
                            let since = stable_since.get_or_insert_with(Instant::now);
                            if since.elapsed() >= BACKEND_STABLE_RESET {
                                restart_attempts = 0;
                            }
                            None
                        }
                        None => None,
                    }
                };

                if let Some(mut backend) = crashed {
                    stable_since = None;
                    let port = backend.response.port.unwrap_or_default();
                    let instance_id = backend.response.instance_id.as_deref().unwrap_or_default();
                    if let Some(tailscale) = supervisor.tailscale.as_ref() {
                        if let Err(error) = tailscale.release(port, instance_id) {
                            eprintln!(
                                "[desktop] Tailnet cleanup after backend crash failed: {error}"
                            );
                        }
                    }
                    let _ = backend.job.terminate(1);
                    let _ = backend.child.wait();
                    let _ = fs::remove_file(&supervisor.runtime_state);
                }

                let needs_restart = supervisor.desired_managed.load(Ordering::SeqCst)
                    && supervisor
                        .owned
                        .lock()
                        .map(|owned| owned.is_none())
                        .unwrap_or(false);
                if !needs_restart {
                    continue;
                }

                while restart_attempts < BACKEND_RESTART_BACKOFF.len()
                    && supervisor.desired_managed.load(Ordering::SeqCst)
                {
                    let delay = BACKEND_RESTART_BACKOFF[restart_attempts];
                    restart_attempts += 1;
                    thread::sleep(delay);
                    // The desired mode can change while we back off — the last delay is
                    // three seconds, which is ample time to switch to remote or external.
                    // Without this re-check the loop would spawn a managed backend that
                    // the user has already moved away from.
                    if !supervisor.desired_managed.load(Ordering::SeqCst) {
                        break;
                    }
                    match supervisor.ensure_managed() {
                        Ok(_) => {
                            stable_since = Some(Instant::now());
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.eval("window.location.reload()");
                            }
                            break;
                        }
                        Err(error) => eprintln!(
                            "[desktop] managed backend restart {restart_attempts}/{} failed: {error}",
                            BACKEND_RESTART_BACKOFF.len()
                        ),
                    }
                }

                if restart_attempts >= BACKEND_RESTART_BACKOFF.len()
                    && supervisor
                        .owned
                        .lock()
                        .map(|owned| owned.is_none())
                        .unwrap_or(true)
                {
                    supervisor.desired_managed.store(false, Ordering::SeqCst);
                    let _ = fs::remove_file(&supervisor.runtime_state);
                    eprintln!(
                        "[desktop] managed backend recovery stopped after {} bounded attempts",
                        BACKEND_RESTART_BACKOFF.len()
                    );
                }
            }
        });
    }

    fn ensure_managed(&self) -> Result<BootstrapResponse, String> {
        let startup_deadline = Instant::now() + STARTUP_TIMEOUT;
        let mut owned = self
            .owned
            .lock()
            .map_err(|_| "backend supervisor lock poisoned".to_string())?;
        if let Some(existing) = owned.as_mut() {
            if matches!(existing.child.try_wait(), Ok(None)) {
                let port = existing
                    .response
                    .port
                    .expect("managed backend response has a port");
                let instance_id = existing.response.instance_id.as_deref().unwrap_or_default();
                existing.response.tailscale = self
                    .tailscale
                    .as_ref()
                    .map(|tailscale| tailscale.reconcile(port, instance_id));
                return Ok(existing.response.clone());
            }
            if let Some(mut stale) = owned.take() {
                let port = stale.response.port.unwrap_or_default();
                let instance_id = stale.response.instance_id.as_deref().unwrap_or_default();
                if let Some(tailscale) = self.tailscale.as_ref() {
                    if let Err(error) = tailscale.release(port, instance_id) {
                        eprintln!("[desktop] stale Tailnet route cleanup failed: {error}");
                    }
                }
                let _ = stale.job.terminate(1);
                let _ = stale.child.wait();
                let _ = fs::remove_file(&self.runtime_state);
            }
        }

        self.paths.validate()?;
        let token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
        let nonce = Uuid::new_v4().simple().to_string();
        let ready_path = self
            .paths
            .runtime
            .join(format!("desktop-ready-{}-{nonce}.json", std::process::id()));
        let gate_path = self.paths.runtime.join(format!(
            "desktop-launch-{}-{nonce}.gate",
            std::process::id()
        ));
        let _ = fs::remove_file(&ready_path);
        let _ = fs::remove_file(&gate_path);

        let job = ProcessJob::new().map_err(display_error("create backend Job Object"))?;

        #[cfg(windows)]
        let mut command = {
            let executable =
                env::current_exe().map_err(display_error("resolve desktop launcher"))?;
            let mut command = Command::new(executable);
            command
                .arg(BACKEND_LAUNCHER_FLAG)
                .arg(&gate_path)
                .arg(&self.paths.bun)
                .arg(&self.paths.server);
            command
        };
        #[cfg(not(windows))]
        let mut command = Command::new(&self.paths.bun);
        #[cfg(not(windows))]
        command.arg(&self.paths.server);
        command
            .current_dir(&self.paths.resources)
            .env("HARNESS_HOST", "127.0.0.1")
            .env("HARNESS_PORT", "0")
            .env("HARNESS_TOKEN", &token)
            .env("MODUS_DESKTOP_MANAGED", "1")
            .env("MODUS_DESKTOP_READY_FILE", &ready_path)
            .env("MODUS_DESKTOP_VERSION", env!("CARGO_PKG_VERSION"))
            .env("MODUS_RESOURCES_DIR", &self.paths.resources)
            .env("MODUS_RUNTIME_DIR", &self.paths.runtime)
            .env("MODUS_LOGS_DIR", &self.paths.logs)
            .env(
                "MODUS_ALLOWED_ORIGINS",
                "tauri://localhost,http://tauri.localhost,https://tauri.localhost",
            )
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(slug) = self.slug.as_deref() {
            command.env("MODUS_INSTANCE", slug);
        } else {
            command.env_remove("MODUS_INSTANCE");
        }

        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }

        let mut child = command
            .spawn()
            .map_err(display_error("start packaged Bun backend"))?;
        if let Err(error) = job.assign(child.id()) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!("assign backend to Job Object: {error}"));
        }
        #[cfg(windows)]
        if let Err(error) = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&gate_path)
            .and_then(|mut gate| gate.write_all(b"assigned"))
        {
            let _ = job.terminate(1);
            let _ = child.wait();
            return Err(format!("release assigned backend launcher: {error}"));
        }

        let log_path = self.paths.logs.join("desktop-backend.log");
        let stderr_tail = Arc::new(Mutex::new(VecDeque::new()));
        if let Some(stdout) = child.stdout.take() {
            spawn_log_drain(stdout, log_path.clone(), "stdout", None);
        }
        if let Some(stderr) = child.stderr.take() {
            spawn_log_drain(stderr, log_path, "stderr", Some(Arc::clone(&stderr_tail)));
        }

        let ready = match wait_for_ready(&mut child, &ready_path, startup_deadline) {
            Ok(ready) => ready,
            Err(error) => {
                let _ = job.terminate(1);
                let _ = child.wait();
                let _ = fs::remove_file(&ready_path);
                let _ = fs::remove_file(&gate_path);
                return Err(startup_error_with_stderr(error, &stderr_tail));
            }
        };
        let _ = fs::remove_file(&ready_path);
        let _ = fs::remove_file(&gate_path);

        #[cfg(not(windows))]
        if ready.pid != child.id() {
            let _ = job.terminate(1);
            let _ = child.wait();
            return Err(format!(
                "backend readiness PID {} did not match spawned PID {}",
                ready.pid,
                child.id()
            ));
        }
        #[cfg(windows)]
        match job.contains(ready.pid) {
            Ok(true) => {}
            Ok(false) => {
                let _ = job.terminate(1);
                let _ = child.wait();
                return Err(format!(
                    "backend readiness PID {} was not contained by the supervisor Job Object",
                    ready.pid
                ));
            }
            Err(error) => {
                let _ = job.terminate(1);
                let _ = child.wait();
                return Err(format!("verify backend Job Object membership: {error}"));
            }
        }
        let health_status = request_local_with_transport_retry(startup_deadline, || {
            request_local(ready.port, "GET", "/health", None)
        });
        if !matches!(health_status, Ok(200)) {
            let _ = job.terminate(1);
            let _ = child.wait();
            return Err(startup_error_with_stderr(
                format!("managed backend failed its health verification: {health_status:?}"),
                &stderr_tail,
            ));
        }
        let auth_status = request_local(ready.port, "GET", "/api/auth/check", Some(&token));
        if !matches!(auth_status, Ok(200)) {
            let _ = job.terminate(1);
            let _ = child.wait();
            return Err(startup_error_with_stderr(
                format!("managed backend rejected the supervisor token: {auth_status:?}"),
                &stderr_tail,
            ));
        }

        let tailscale = self
            .tailscale
            .as_ref()
            .map(|tailscale| tailscale.reconcile(ready.port, &ready.instance_id));
        let response = BootstrapResponse {
            mode: "managed-local".into(),
            api_base: format!("http://127.0.0.1:{}", ready.port),
            target_id: self
                .slug
                .as_ref()
                .map(|slug| format!("vault:{slug}"))
                .unwrap_or_else(|| "local".into()),
            label: self
                .slug
                .as_ref()
                .map(|slug| format!("{slug} · {}", ready.port))
                .unwrap_or_else(|| format!("Main · {}", ready.port)),
            token: Some(token),
            instance_id: Some(ready.instance_id),
            version: ready.version,
            backend_pid: Some(ready.pid),
            port: Some(ready.port),
            tailscale,
        };
        self.write_runtime_record(&response, false)?;
        *owned = Some(OwnedBackend {
            child,
            job,
            response: response.clone(),
        });
        Ok(response)
    }

    fn write_runtime_record(
        &self,
        response: &BootstrapResponse,
        ui_connected: bool,
    ) -> Result<(), String> {
        let record = RuntimeRecord {
            mode: &response.mode,
            desktop_pid: std::process::id(),
            backend_pid: response.backend_pid,
            port: response.port,
            instance_id: response.instance_id.as_deref(),
            version: &response.version,
            api_base: (!response.api_base.is_empty()).then_some(response.api_base.as_str()),
            ui_connected,
            tailscale: response.tailscale.as_ref(),
        };
        let bytes = serde_json::to_vec_pretty(&record).map_err(|error| error.to_string())?;
        let temporary = self.runtime_state.with_extension("json.tmp");
        fs::write(&temporary, bytes).map_err(display_error("write desktop runtime state"))?;
        if self.runtime_state.exists() {
            fs::remove_file(&self.runtime_state)
                .map_err(display_error("replace desktop runtime state"))?;
        }
        fs::rename(&temporary, &self.runtime_state)
            .map_err(display_error("publish desktop runtime state"))?;
        Ok(())
    }
}

impl Drop for VaultBackendSupervisor {
    fn drop(&mut self) {
        if let Ok(owned) = self.owned.get_mut() {
            if let Some(backend) = owned.as_ref() {
                let _ = backend.job.terminate(1);
            }
        }
        let _ = fs::remove_file(&self.runtime_state);
    }
}

impl BackendPaths {
    fn resolve(
        app: &AppHandle,
        slug: Option<&str>,
        initial_vault: Option<&str>,
    ) -> Result<Self, String> {
        let resource_root = env::var_os("MODUS_DESKTOP_RESOURCES_DIR")
            .map(PathBuf::from)
            .unwrap_or(
                app.path()
                    .resource_dir()
                    .map_err(|error| error.to_string())?
                    .join("modus"),
            );
        let server = env::var_os("MODUS_DESKTOP_SERVER")
            .map(PathBuf::from)
            .unwrap_or_else(|| resource_root.join("server.js"));
        let bun = resolve_bun(app)?;
        let writable_root = writable_root(app, slug)?;
        let selected_at_launch = slug == initial_vault;
        let runtime = selected_at_launch
            .then(|| env::var_os("MODUS_RUNTIME_DIR").map(PathBuf::from))
            .flatten()
            .unwrap_or_else(|| writable_root.join("runtime"));
        let logs = selected_at_launch
            .then(|| env::var_os("MODUS_LOGS_DIR").map(PathBuf::from))
            .flatten()
            .unwrap_or_else(|| writable_root.join("logs"));
        Ok(Self {
            bun,
            server,
            resources: resource_root,
            runtime,
            logs,
        })
    }

    fn validate(&self) -> Result<(), String> {
        for (label, path) in [
            ("packaged Bun runtime", &self.bun),
            ("packaged backend", &self.server),
            ("packaged resources", &self.resources),
        ] {
            if !path.exists() {
                return Err(format!("{label} is missing: {}", path.display()));
            }
        }
        Ok(())
    }
}

fn writable_root(app: &AppHandle, slug: Option<&str>) -> Result<PathBuf, String> {
    let home = modus_home(app)?;
    Ok(match slug {
        Some(slug) => home.join(slug),
        None => home,
    })
}

fn modus_home(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(env::var_os("MODUS_HOME").map(PathBuf::from).unwrap_or(
        app.path()
            .home_dir()
            .map_err(|error| error.to_string())?
            .join(".modus"),
    ))
}

fn read_autostart_vaults(app: &AppHandle) -> Vec<String> {
    let Ok(home) = modus_home(app) else {
        return Vec::new();
    };
    let path = home.join("vaults.json");
    let Ok(bytes) = fs::read(&path) else {
        return Vec::new();
    };
    match autostart_vaults_from_json(&bytes) {
        Ok(slugs) => slugs,
        Err(error) => {
            eprintln!(
                "[desktop] could not read Vault autostart registry {}: {error}",
                path.display()
            );
            Vec::new()
        }
    }
}

fn autostart_vaults_from_json(bytes: &[u8]) -> Result<Vec<String>, String> {
    let value: serde_json::Value =
        serde_json::from_slice(bytes).map_err(|error| error.to_string())?;
    let entries = value
        .get("vaults")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| "registry must contain a vaults array".to_string())?;
    let mut slugs = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for entry in entries {
        let object = entry
            .as_object()
            .ok_or_else(|| "registry contains a non-object Vault entry".to_string())?;
        let raw_slug = object
            .get("slug")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| "registry Vault entry is missing a slug".to_string())?;
        let slug = normalize_vault_slug(Some(raw_slug))?
            .ok_or_else(|| "registry cannot contain the default Vault".to_string())?;
        if !seen.insert(slug.clone()) {
            return Err(format!("registry contains duplicate Vault {slug}"));
        }
        if object.get("autostart").and_then(serde_json::Value::as_bool) == Some(true) {
            slugs.push(slug);
        }
    }
    Ok(slugs)
}

fn current_vault_slug() -> Result<Option<String>, String> {
    match env::var("MODUS_INSTANCE") {
        Ok(value) => normalize_vault_slug(Some(&value)),
        Err(env::VarError::NotPresent) => Ok(None),
        Err(env::VarError::NotUnicode(_)) => Err("MODUS_INSTANCE must be valid Unicode".into()),
    }
}

fn vault_key(slug: Option<&str>) -> String {
    slug.unwrap_or("default").to_string()
}

fn normalize_vault_slug(value: Option<&str>) -> Result<Option<String>, String> {
    let value = value.unwrap_or_default().trim();
    if value.is_empty() || value.eq_ignore_ascii_case("default") {
        return Ok(None);
    }
    if value == "."
        || value == ".."
        || !value.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-')
        })
    {
        return Err("MODUS_INSTANCE must be a single name containing only letters, numbers, dots, underscores, and hyphens".into());
    }
    Ok(Some(value.to_ascii_lowercase()))
}

fn resolve_bun(app: &AppHandle) -> Result<PathBuf, String> {
    if let Some(configured) = env::var_os("MODUS_DESKTOP_BUN") {
        return Ok(PathBuf::from(configured));
    }
    let current = env::current_exe().map_err(display_error("resolve desktop executable"))?;
    let executable_dir = current.parent().unwrap_or(Path::new("."));
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|error| error.to_string())?;
    let names: &[&str] = if cfg!(windows) {
        &["bun.exe", "bun"]
    } else {
        &["bun"]
    };
    for directory in [executable_dir, resource_dir.as_path()] {
        for name in names {
            let candidate = directory.join(name);
            if candidate.is_file() {
                return Ok(candidate);
            }
        }
    }
    Err("packaged Bun sidecar was not found beside the desktop executable".into())
}

fn wait_for_ready(
    child: &mut Child,
    ready_path: &Path,
    deadline: Instant,
) -> Result<ReadyRecord, String> {
    let mut last_parse_error = None;
    while Instant::now() < deadline {
        if let Some(status) = child
            .try_wait()
            .map_err(display_error("poll managed backend"))?
        {
            return Err(format!(
                "packaged backend exited before readiness ({status})"
            ));
        }
        if ready_path.is_file() {
            match fs::read(ready_path)
                .map_err(|error| error.to_string())
                .and_then(|bytes| {
                    serde_json::from_slice::<ReadyRecord>(&bytes).map_err(|error| error.to_string())
                }) {
                Ok(record)
                    if record.event == "ready"
                        && record.port > 0
                        && !record.instance_id.is_empty() =>
                {
                    return Ok(record);
                }
                Ok(_) => last_parse_error = Some("readiness record had invalid fields".into()),
                Err(error) => last_parse_error = Some(error),
            }
        }
        thread::sleep(Duration::from_millis(50));
    }
    Err(format!(
        "timed out waiting for packaged backend readiness{}",
        last_parse_error
            .map(|error| format!(": {error}"))
            .unwrap_or_default()
    ))
}

fn request_local(port: u16, method: &str, path: &str, token: Option<&str>) -> Result<u16, String> {
    let address = SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::LOCALHOST, port));
    let mut stream = TcpStream::connect_timeout(&address, Duration::from_secs(2))
        .map_err(display_error("connect to managed backend"))?;
    stream
        .set_read_timeout(Some(Duration::from_secs(3)))
        .map_err(|error| error.to_string())?;
    stream
        .set_write_timeout(Some(Duration::from_secs(3)))
        .map_err(|error| error.to_string())?;
    let authorization = token
        .filter(|value| !value.is_empty())
        .map(|value| format!("Authorization: Bearer {value}\r\n"))
        .unwrap_or_default();
    let request = format!(
        "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n{authorization}Content-Length: 0\r\nConnection: close\r\n\r\n"
    );
    stream
        .write_all(request.as_bytes())
        .map_err(display_error("write managed backend request"))?;
    let mut response = String::new();
    stream
        .read_to_string(&mut response)
        .map_err(display_error("read managed backend response"))?;
    let status = response
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|value| value.parse::<u16>().ok())
        .ok_or_else(|| "managed backend returned an invalid HTTP response".to_string())?;
    Ok(status)
}

fn request_local_with_transport_retry(
    deadline: Instant,
    mut request: impl FnMut() -> Result<u16, String>,
) -> Result<u16, String> {
    let mut attempts = 0usize;
    loop {
        attempts += 1;
        match request() {
            Ok(status) => return Ok(status),
            Err(error) if Instant::now() < deadline => {
                thread::sleep(Duration::from_millis(100));
                if Instant::now() >= deadline {
                    return Err(format!(
                        "{error} (after {attempts} transport attempts within the startup budget)"
                    ));
                }
            }
            Err(error) => {
                return Err(format!(
                    "{error} (after {attempts} transport attempts within the startup budget)"
                ));
            }
        }
    }
}

fn spawn_log_drain(
    reader: impl Read + Send + 'static,
    path: PathBuf,
    stream_name: &'static str,
    captured: Option<Arc<Mutex<VecDeque<String>>>>,
) {
    thread::spawn(move || {
        let reader = BufReader::new(reader);
        for line in reader.lines().map_while(Result::ok) {
            if let Some(captured) = captured.as_ref() {
                if let Ok(mut lines) = captured.lock() {
                    lines.push_back(line.clone());
                    while lines.len() > STDERR_TAIL_LINES {
                        lines.pop_front();
                    }
                }
            }
            if let Ok(mut file) = append_log(&path) {
                let _ = writeln!(file, "[{stream_name}] {line}");
            }
        }
    });
}

fn startup_error_with_stderr(error: String, captured: &Arc<Mutex<VecDeque<String>>>) -> String {
    let excerpt = captured
        .lock()
        .ok()
        .map(|lines| lines.iter().cloned().collect::<Vec<_>>().join("\n"))
        .unwrap_or_default();
    if excerpt.is_empty() {
        return error;
    }
    let excerpt = if excerpt.chars().count() > STDERR_TAIL_CHARS {
        excerpt
            .chars()
            .skip(excerpt.chars().count() - STDERR_TAIL_CHARS)
            .collect::<String>()
    } else {
        excerpt
    };
    format!("{error}\nRecent backend stderr:\n{excerpt}")
}

fn append_log(path: &Path) -> std::io::Result<File> {
    OpenOptions::new().create(true).append(true).open(path)
}

fn validated_remote_url(value: Option<&str>) -> Result<String, String> {
    let value = value.unwrap_or_default().trim();
    let parsed = url::Url::parse(value)
        .map_err(|_| "remote desktop mode requires a valid Tailscale HTTPS origin")?;
    if parsed.scheme() != "https"
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.path() != "/"
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err("remote desktop mode requires a Tailscale HTTPS origin without credentials, path, query, or fragment".into());
    }
    Ok(parsed.origin().ascii_serialization())
}

fn display_error(context: &'static str) -> impl FnOnce(std::io::Error) -> String {
    move |error| format!("{context}: {error}")
}

#[cfg(test)]
mod tests {
    use std::{
        collections::VecDeque,
        sync::{Arc, Mutex},
        time::{Duration, Instant},
    };

    use super::{
        autostart_vaults_from_json, normalize_vault_slug, request_local_with_transport_retry,
        startup_error_with_stderr, validated_remote_url, SupervisorMap,
    };

    #[cfg(windows)]
    use std::{fs, path::PathBuf, thread};

    #[cfg(windows)]
    use super::run_backend_launcher;

    #[test]
    fn restart_backoff_rechecks_desired_mode_after_sleeping() {
        // The supervisor loop owns a thread and a Tauri app handle, so it cannot be
        // driven from a unit test. Pin the invariant at the source level instead, the
        // way the harness pins its shutdown contract: once the backoff delay has
        // elapsed the loop must re-read desired_managed before spawning, or switching
        // to remote/external during the delay still gets a managed backend.
        let source = include_str!("backend.rs");
        let sleep_at = source
            .find("thread::sleep(delay);")
            .expect("restart backoff sleep");
        let spawn_offset = source[sleep_at..]
            .find("supervisor.ensure_managed()")
            .expect("restart spawn call");
        let between = &source[sleep_at..sleep_at + spawn_offset];
        assert!(
            between.contains("desired_managed.load("),
            "restart backoff must re-check desired_managed after sleeping; found: {between}"
        );
    }

    #[test]
    fn remote_mode_requires_https() {
        assert!(validated_remote_url(Some("http://machine.ts.net")).is_err());
        assert_eq!(
            validated_remote_url(Some("https://machine.ts.net/")).unwrap(),
            "https://machine.ts.net"
        );
        assert!(validated_remote_url(Some("https://user:secret@machine.ts.net")).is_err());
        assert!(validated_remote_url(Some("https://machine.ts.net/api")).is_err());
        assert!(validated_remote_url(Some("https://machine.ts.net?target=other")).is_err());
        assert!(validated_remote_url(Some("https://machine.ts.net/#fragment")).is_err());
        assert!(validated_remote_url(Some("https://")).is_err());
    }

    #[test]
    fn vault_slug_validation_matches_the_backend_path_contract() {
        assert_eq!(normalize_vault_slug(None).unwrap(), None);
        assert_eq!(normalize_vault_slug(Some(" default ")).unwrap(), None);
        assert_eq!(normalize_vault_slug(Some("DEFAULT")).unwrap(), None);
        assert_eq!(
            normalize_vault_slug(Some(" Private-1.FOO_bar ")).unwrap(),
            Some("private-1.foo_bar".into())
        );
        for invalid in [".", "..", "../escape", "two words", "private/child"] {
            assert!(
                normalize_vault_slug(Some(invalid)).is_err(),
                "accepted {invalid}"
            );
        }
    }

    #[test]
    fn supervisor_map_is_lazy_and_reuses_one_slot_per_canonical_key() {
        let map = SupervisorMap::<String>::default();
        assert_eq!(map.len(), 0, "lazy map must not pre-create a backend");
        let (first, created) = map
            .get_or_try_insert_with("private".into(), || Ok("first".into()))
            .unwrap();
        assert!(created);
        let (second, created) = map
            .get_or_try_insert_with("private".into(), || Ok("second".into()))
            .unwrap();
        assert!(!created);
        assert!(Arc::ptr_eq(&first, &second));
        assert_eq!(map.len(), 1);
        assert_eq!(second.as_str(), "first");
    }

    #[test]
    fn autostart_registry_selects_only_valid_enabled_named_vaults() {
        let slugs = autostart_vaults_from_json(
            br#"{"vaults":[
              {"slug":"Private","createdAt":1,"autostart":true},
              {"slug":"cold","createdAt":2,"autostart":false},
              {"slug":"plain","createdAt":3}
            ]}"#,
        )
        .unwrap();
        assert_eq!(slugs, vec!["private"]);
        assert!(autostart_vaults_from_json(
            br#"{"vaults":[{"slug":"Private","createdAt":1},{"slug":"private","createdAt":2}]}"#
        )
        .is_err());
        assert!(
            autostart_vaults_from_json(br#"{"vaults":[{"slug":"..","createdAt":1}]}"#).is_err()
        );
    }

    #[test]
    fn health_verification_retries_transport_errors_only() {
        let mut transport_calls = 0;
        let recovered =
            request_local_with_transport_retry(Instant::now() + Duration::from_secs(1), || {
                transport_calls += 1;
                if transport_calls < 3 {
                    Err("connect to managed backend: 10060".into())
                } else {
                    Ok(200)
                }
            });
        assert_eq!(recovered.unwrap(), 200);
        assert_eq!(transport_calls, 3);

        let mut http_calls = 0;
        let rejected =
            request_local_with_transport_retry(Instant::now() + Duration::from_secs(1), || {
                http_calls += 1;
                Ok(401)
            });
        assert_eq!(rejected.unwrap(), 401);
        assert_eq!(http_calls, 1, "a real HTTP rejection must not be retried");
    }

    #[test]
    fn startup_errors_include_the_bounded_stderr_tail() {
        let captured = Arc::new(Mutex::new(VecDeque::from([
            "first diagnostic".to_string(),
            "SQLITE_READONLY in pruneSessionEvents".to_string(),
        ])));
        let message =
            startup_error_with_stderr("packaged backend exited before readiness".into(), &captured);
        assert!(message.contains("Recent backend stderr"));
        assert!(message.contains("SQLITE_READONLY in pruneSessionEvents"));
    }

    #[cfg(windows)]
    #[test]
    fn backend_launcher_waits_for_assignment_gate() {
        let directory = std::env::temp_dir().join(format!(
            "modus-launch-gate-{}",
            uuid::Uuid::new_v4().simple()
        ));
        fs::create_dir_all(&directory).expect("create launcher test directory");
        let gate = directory.join("assigned.gate");
        let marker = directory.join("backend-started.txt");
        let script = directory.join("backend.ps1");
        let escaped_marker = marker.to_string_lossy().replace('\'', "''");
        fs::write(
            &script,
            format!("[IO.File]::WriteAllText('{escaped_marker}', 'started')"),
        )
        .expect("write launcher test script");
        let powershell = PathBuf::from(std::env::var_os("SystemRoot").expect("SystemRoot"))
            .join("System32/WindowsPowerShell/v1.0/powershell.exe");

        let launcher_gate = gate.clone();
        let launcher =
            thread::spawn(move || run_backend_launcher(&launcher_gate, &powershell, &script));
        thread::sleep(Duration::from_millis(200));
        assert!(
            !marker.exists(),
            "backend started before the assignment gate"
        );

        fs::write(&gate, b"assigned").expect("release launcher gate");
        assert_eq!(launcher.join().expect("join launcher"), 0);
        assert_eq!(
            fs::read_to_string(&marker).expect("read backend marker"),
            "started"
        );
        let _ = fs::remove_dir_all(directory);
    }
}
