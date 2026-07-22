use std::{
    env,
    fs::{self, File, OpenOptions},
    io::{BufRead, BufReader, Read, Write},
    net::{Ipv4Addr, SocketAddr, SocketAddrV4, TcpListener, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::Mutex,
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

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BootstrapRequest {
    pub mode: String,
    pub url: Option<String>,
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

pub struct BackendSupervisor {
    paths: BackendPaths,
    tailscale: TailscaleManager,
    owned: Mutex<Option<OwnedBackend>>,
    runtime_state: PathBuf,
}

impl BackendSupervisor {
    pub fn new(app: &AppHandle) -> Result<Self, String> {
        let paths = BackendPaths::resolve(app)?;
        let tailscale = TailscaleManager::resolve(app)?;
        fs::create_dir_all(&paths.runtime)
            .map_err(display_error("create desktop runtime directory"))?;
        fs::create_dir_all(&paths.logs).map_err(display_error("create desktop logs directory"))?;
        let runtime_state = paths.runtime.join("desktop-supervisor.json");
        Ok(Self {
            paths,
            tailscale,
            owned: Mutex::new(None),
            runtime_state,
        })
    }

    pub fn bootstrap(&self, request: BootstrapRequest) -> Result<BootstrapResponse, String> {
        match request.mode.as_str() {
            "remote" => {
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
            "managed-local" => self.ensure_managed(),
            other => Err(format!("unsupported desktop backend mode: {other}")),
        }
    }

    pub fn mark_ui_connected(&self, instance_id: &str, port: u16) -> Result<(), String> {
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

    pub fn stop_owned(&self) -> Result<(), String> {
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
        let route_error = self.tailscale.release(port, instance_id).err();
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

    pub fn tailscale_status(&self) -> Result<DesktopTailscaleStatus, String> {
        let owned = self
            .owned
            .lock()
            .map_err(|_| "backend supervisor lock poisoned".to_string())?;
        Ok(owned
            .as_ref()
            .and_then(|backend| backend.response.tailscale.clone())
            .unwrap_or_else(|| self.tailscale.configured_status()))
    }

    pub fn set_tailscale_enabled(&self, enabled: bool) -> Result<DesktopTailscaleStatus, String> {
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
                self.tailscale.release(port, instance_id)?;
            }
            self.tailscale.set_enabled(false)?;
            let status = self.tailscale.configured_status();
            if let Some(backend) = owned.as_mut() {
                backend.response.tailscale = Some(status.clone());
                self.write_runtime_record(&backend.response, true)?;
            }
            return Ok(status);
        }

        self.tailscale.set_enabled(true)?;
        let status = if let Some(backend) = owned.as_mut() {
            let port = backend
                .response
                .port
                .expect("managed backend response has a port");
            let instance_id = backend.response.instance_id.as_deref().unwrap_or_default();
            let status = self.tailscale.reconcile(port, instance_id);
            backend.response.tailscale = Some(status.clone());
            self.write_runtime_record(&backend.response, true)?;
            status
        } else {
            self.tailscale.configured_status()
        };
        Ok(status)
    }

    pub fn clear_runtime_state(&self) {
        let _ = fs::remove_file(&self.runtime_state);
    }

    fn ensure_managed(&self) -> Result<BootstrapResponse, String> {
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
                existing.response.tailscale = Some(self.tailscale.reconcile(port, instance_id));
                return Ok(existing.response.clone());
            }
            owned.take();
        }

        self.paths.validate()?;
        let token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
        let nonce = Uuid::new_v4().simple().to_string();
        let ready_path = self
            .paths
            .runtime
            .join(format!("desktop-ready-{}-{nonce}.json", std::process::id()));
        let _ = fs::remove_file(&ready_path);

        let mut command = Command::new(&self.paths.bun);
        command
            .arg(&self.paths.server)
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

        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }

        let mut child = command
            .spawn()
            .map_err(display_error("start packaged Bun backend"))?;
        let job = ProcessJob::new().map_err(display_error("create backend Job Object"))?;
        if let Err(error) = job.assign(child.id()) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!("assign backend to Job Object: {error}"));
        }

        let log_path = self.paths.logs.join("desktop-backend.log");
        if let Some(stdout) = child.stdout.take() {
            spawn_log_drain(stdout, log_path.clone(), "stdout");
        }
        if let Some(stderr) = child.stderr.take() {
            spawn_log_drain(stderr, log_path, "stderr");
        }

        let ready = match wait_for_ready(&mut child, &ready_path) {
            Ok(ready) => ready,
            Err(error) => {
                let _ = job.terminate(1);
                let _ = child.wait();
                let _ = fs::remove_file(&ready_path);
                return Err(error);
            }
        };
        let _ = fs::remove_file(&ready_path);

        if ready.pid != child.id() {
            let _ = job.terminate(1);
            let _ = child.wait();
            return Err(format!(
                "backend readiness PID {} did not match spawned PID {}",
                ready.pid,
                child.id()
            ));
        }
        if request_local(ready.port, "GET", "/health", None)? != 200 {
            let _ = job.terminate(1);
            let _ = child.wait();
            return Err("managed backend failed its health verification".into());
        }
        if request_local(ready.port, "GET", "/api/auth/check", Some(&token))? != 200 {
            let _ = job.terminate(1);
            let _ = child.wait();
            return Err("managed backend rejected the supervisor token".into());
        }

        let tailscale = self.tailscale.reconcile(ready.port, &ready.instance_id);
        let response = BootstrapResponse {
            mode: "managed-local".into(),
            api_base: format!("http://127.0.0.1:{}", ready.port),
            target_id: "local".into(),
            label: format!("Local Modus · {}", ready.port),
            token: Some(token),
            instance_id: Some(ready.instance_id),
            version: ready.version,
            backend_pid: Some(ready.pid),
            port: Some(ready.port),
            tailscale: Some(tailscale),
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

impl Drop for BackendSupervisor {
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
    fn resolve(app: &AppHandle) -> Result<Self, String> {
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
        let writable_root = writable_root(app)?;
        let runtime = env::var_os("MODUS_RUNTIME_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| writable_root.join("runtime"));
        let logs = env::var_os("MODUS_LOGS_DIR")
            .map(PathBuf::from)
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

fn writable_root(app: &AppHandle) -> Result<PathBuf, String> {
    let home = env::var_os("MODUS_HOME").map(PathBuf::from).unwrap_or(
        app.path()
            .home_dir()
            .map_err(|error| error.to_string())?
            .join(".modus"),
    );
    let instance = env::var("MODUS_INSTANCE").unwrap_or_default();
    if !instance.is_empty() && instance != "default" {
        Ok(home.join(instance))
    } else {
        Ok(home)
    }
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

fn wait_for_ready(child: &mut Child, ready_path: &Path) -> Result<ReadyRecord, String> {
    let deadline = Instant::now() + STARTUP_TIMEOUT;
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

fn spawn_log_drain(reader: impl Read + Send + 'static, path: PathBuf, stream_name: &'static str) {
    thread::spawn(move || {
        let reader = BufReader::new(reader);
        for line in reader.lines().map_while(Result::ok) {
            if let Ok(mut file) = append_log(&path) {
                let _ = writeln!(file, "[{stream_name}] {line}");
            }
        }
    });
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
    use super::validated_remote_url;

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
}
