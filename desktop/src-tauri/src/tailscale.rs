use std::{
    env,
    ffi::OsString,
    fs,
    io::Read,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager};

const DEFAULT_COMMAND_TIMEOUT: Duration = Duration::from_secs(10);
const DEFAULT_STATUS_ATTEMPTS: u32 = 6;
const DEFAULT_STATUS_DELAY: Duration = Duration::from_secs(1);
const LEGACY_BASE_PORT: u16 = 3777;
const LEGACY_PORT_RANGE: u16 = 5;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopTailscaleStatus {
    pub enabled: bool,
    pub state: String,
    pub url: Option<String>,
    pub message: Option<String>,
    pub target_port: Option<u16>,
    pub pin_configured: bool,
}

impl DesktopTailscaleStatus {
    fn disabled(pin_configured: bool) -> Self {
        Self {
            enabled: false,
            state: "disabled".into(),
            url: None,
            message: Some("Tailnet access is off".into()),
            target_port: None,
            pin_configured,
        }
    }

    fn enabled_waiting(
        url: Option<String>,
        pin_configured: bool,
        message: impl Into<String>,
    ) -> Self {
        Self {
            enabled: true,
            state: "enabled".into(),
            url,
            message: Some(message.into()),
            target_port: None,
            pin_configured,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct TailscaleOwnership {
    version: u8,
    dns_name: String,
    endpoint: String,
    proxy: String,
    target_port: u16,
    #[serde(default)]
    created_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    managed_by: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    desktop_pid: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    instance_id: Option<String>,
}

impl TailscaleOwnership {
    fn desktop(dns_name: &str, target_port: u16, instance_id: &str) -> Self {
        let dns_name = dns_name.trim_end_matches('.').to_string();
        let created_at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs()
            .to_string();
        Self {
            version: 1,
            endpoint: format!("{dns_name}:443"),
            proxy: format!("http://127.0.0.1:{target_port}"),
            dns_name,
            target_port,
            created_at,
            managed_by: Some("desktop".into()),
            desktop_pid: Some(std::process::id()),
            instance_id: Some(instance_id.into()),
        }
    }

    fn is_current_desktop(&self, target_port: u16, instance_id: &str) -> bool {
        self.version == 1
            && self.managed_by.as_deref() == Some("desktop")
            && self.desktop_pid == Some(std::process::id())
            && self.instance_id.as_deref() == Some(instance_id)
            && self.target_port == target_port
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct ServeEndpoint {
    endpoint: String,
    proxy: String,
    target_port: u16,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ServeOwnershipClass {
    None,
    Modus,
    Foreign,
}

struct CliOutput {
    code: i32,
    stdout: String,
    stderr: String,
}

pub struct TailscaleManager {
    config_dir: PathBuf,
    remote_file: PathBuf,
    ownership_file: PathBuf,
    cli: OsString,
    command_timeout: Duration,
    status_attempts: u32,
    status_delay: Duration,
}

impl TailscaleManager {
    pub fn resolve(app: &AppHandle) -> Result<Self, String> {
        let config_dir = env::var_os("MODUS_CONFIG_DIR")
            .map(PathBuf::from)
            .unwrap_or(
                app.path()
                    .home_dir()
                    .map_err(|error| error.to_string())?
                    .join(".config")
                    .join("agent-dev-zone"),
            );
        let cli = resolve_tailscale_cli();
        let command_timeout = duration_from_env(
            "MODUS_TAILSCALE_COMMAND_TIMEOUT_MS",
            DEFAULT_COMMAND_TIMEOUT,
        );
        let status_attempts = env::var("MODUS_TAILSCALE_STATUS_ATTEMPTS")
            .ok()
            .and_then(|value| value.parse::<u32>().ok())
            .filter(|value| *value > 0)
            .unwrap_or(DEFAULT_STATUS_ATTEMPTS);
        let status_delay =
            duration_from_env("MODUS_TAILSCALE_STATUS_DELAY_MS", DEFAULT_STATUS_DELAY);
        Ok(Self {
            remote_file: config_dir.join("remote"),
            ownership_file: config_dir.join("tailscale-serve-owner.json"),
            config_dir,
            cli,
            command_timeout,
            status_attempts,
            status_delay,
        })
    }

    pub fn configured_status(&self) -> DesktopTailscaleStatus {
        let pin_configured = self.pin_configured();
        if !self.enabled() {
            return DesktopTailscaleStatus::disabled(pin_configured);
        }
        let url = self
            .read_ownership()
            .map(|owner| format!("https://{}", owner.dns_name.trim_end_matches('.')));
        DesktopTailscaleStatus::enabled_waiting(
            url,
            pin_configured,
            "Tailnet access is enabled and will bind when the managed backend starts",
        )
    }

    pub fn set_enabled(&self, enabled: bool) -> Result<(), String> {
        if enabled {
            fs::create_dir_all(&self.config_dir)
                .map_err(display_error("create Modus configuration directory"))?;
            atomic_write(&self.remote_file, b"tailscale\n")
                .map_err(display_error("persist Tailnet access setting"))?;
        } else if self.remote_file.exists() {
            fs::remove_file(&self.remote_file)
                .map_err(display_error("disable Tailnet access setting"))?;
        }
        Ok(())
    }

    pub fn reconcile(&self, target_port: u16, instance_id: &str) -> DesktopTailscaleStatus {
        let pin_configured = self.pin_configured();
        if !self.enabled() {
            return DesktopTailscaleStatus::disabled(pin_configured);
        }

        let status = match self.wait_for_status() {
            Ok(status) => status,
            Err(message) => {
                return DesktopTailscaleStatus {
                    enabled: true,
                    state: "unavailable".into(),
                    url: None,
                    message: Some(message),
                    target_port: None,
                    pin_configured,
                };
            }
        };
        let dns_name = match parse_dns_name(&status.stdout) {
            Ok(dns_name) => dns_name,
            Err(message) => {
                return DesktopTailscaleStatus {
                    enabled: true,
                    state: "error".into(),
                    url: None,
                    message: Some(message),
                    target_port: None,
                    pin_configured,
                };
            }
        };
        let url = format!("https://{dns_name}");

        let serve_config = match self.serve_config() {
            Ok(config) => config,
            Err(message) => {
                return DesktopTailscaleStatus {
                    enabled: true,
                    state: "unavailable".into(),
                    url: Some(url),
                    message: Some(message),
                    target_port: None,
                    pin_configured,
                };
            }
        };
        let current_owner = self.read_ownership();
        let mut ownership_class = classify_https_443(&serve_config, current_owner.as_ref());
        if ownership_class == ServeOwnershipClass::Foreign
            && current_owner.is_none()
            && can_adopt_legacy_rule(&serve_config, &dns_name)
        {
            ownership_class = ServeOwnershipClass::Modus;
        }
        if ownership_class == ServeOwnershipClass::Foreign {
            return DesktopTailscaleStatus {
                enabled: true,
                state: "blocked".into(),
                url: Some(url),
                message: Some(
                    "HTTPS :443 is owned by another Tailscale Serve configuration; Modus left it untouched"
                        .into(),
                ),
                target_port: None,
                pin_configured,
            };
        }
        let previous_endpoint = parse_https_443(&serve_config).ok().flatten();

        let serve = match self.run_cli(&["serve", "--bg", "--yes", &target_port.to_string()]) {
            Ok(output) => output,
            Err(message) => return active_error(url, pin_configured, message),
        };
        if serve.code != 0 {
            return active_error(
                url,
                pin_configured,
                command_error("tailscale serve", &serve),
            );
        }

        let expected = TailscaleOwnership::desktop(&dns_name, target_port, instance_id);
        let verified = match self.serve_config() {
            Ok(raw) => endpoint_matches(&raw, &expected),
            Err(_) => false,
        };
        if !verified {
            self.rollback_route(previous_endpoint.as_ref());
            return active_error(
                url,
                pin_configured,
                "Tailscale accepted the Serve command but did not publish the expected Modus route"
                    .into(),
            );
        }
        if let Err(error) = self.write_ownership(&expected) {
            self.rollback_route(previous_endpoint.as_ref());
            return active_error(url, pin_configured, error);
        }

        DesktopTailscaleStatus {
            enabled: true,
            state: "active".into(),
            url: Some(url),
            message: Some(if pin_configured {
                "Tailnet access is active; Close keeps it available and Quit removes the route"
                    .into()
            } else {
                "Tailnet access is active without a browser PIN; anyone on this tailnet can open Modus".into()
            }),
            target_port: Some(target_port),
            pin_configured,
        }
    }

    pub fn release(&self, target_port: u16, instance_id: &str) -> Result<(), String> {
        let Some(owner) = self.read_ownership() else {
            return Ok(());
        };
        if !owner.is_current_desktop(target_port, instance_id) {
            return Ok(());
        }

        let serve_config = self.serve_config()?;
        match classify_https_443(&serve_config, Some(&owner)) {
            ServeOwnershipClass::None => {
                self.remove_ownership_if_current(target_port, instance_id)?;
                return Ok(());
            }
            ServeOwnershipClass::Foreign => return Ok(()),
            ServeOwnershipClass::Modus => {}
        }

        let output = self.run_cli(&["serve", "--https=443", "off"])?;
        if output.code != 0 {
            return Err(command_error("tailscale serve off", &output));
        }
        let after = self.serve_config()?;
        if classify_https_443(&after, Some(&owner)) != ServeOwnershipClass::None {
            return Err("Tailscale did not remove the Modus-owned HTTPS :443 route".into());
        }
        self.remove_ownership_if_current(target_port, instance_id)
    }

    fn enabled(&self) -> bool {
        fs::read_to_string(&self.remote_file)
            .map(|value| value.trim() == "tailscale")
            .unwrap_or(false)
    }

    fn pin_configured(&self) -> bool {
        if env::var("HARNESS_PIN").is_ok_and(|value| !value.trim().is_empty()) {
            return true;
        }
        let path = env::var_os("HARNESS_SECRETS_FILE")
            .map(PathBuf::from)
            .unwrap_or_else(|| self.config_dir.join("secrets.env"));
        fs::read_to_string(path)
            .map(|contents| {
                contents.lines().any(|line| {
                    let line = line.trim();
                    let Some((key, value)) = line.split_once('=') else {
                        return false;
                    };
                    key.trim() == "HARNESS_PIN" && !value.trim().is_empty()
                })
            })
            .unwrap_or(false)
    }

    fn wait_for_status(&self) -> Result<CliOutput, String> {
        let mut last_error = "Tailscale is not running".to_string();
        for attempt in 0..self.status_attempts {
            match self.run_cli(&["status", "--json"]) {
                Ok(output) if output.code == 0 => return Ok(output),
                Ok(output) => last_error = command_error("tailscale status", &output),
                Err(error) => last_error = error,
            }
            if attempt + 1 < self.status_attempts && !self.status_delay.is_zero() {
                thread::sleep(self.status_delay);
            }
        }
        Err(format!(
            "{last_error}; start Tailscale and retry Tailnet access"
        ))
    }

    fn serve_config(&self) -> Result<String, String> {
        let output = self.run_cli(&["serve", "status", "--json"])?;
        if output.code == 0 {
            return Ok(if output.stdout.trim().is_empty() {
                "{}".into()
            } else {
                output.stdout
            });
        }
        if output
            .stderr
            .to_ascii_lowercase()
            .contains("no serve config")
        {
            return Ok("{}".into());
        }
        Err(command_error("tailscale serve status", &output))
    }

    fn read_ownership(&self) -> Option<TailscaleOwnership> {
        let bytes = fs::read(&self.ownership_file).ok()?;
        let owner: TailscaleOwnership = serde_json::from_slice(&bytes).ok()?;
        (owner.version == 1 && !owner.dns_name.is_empty() && !owner.endpoint.is_empty())
            .then_some(owner)
    }

    fn write_ownership(&self, owner: &TailscaleOwnership) -> Result<(), String> {
        fs::create_dir_all(&self.config_dir)
            .map_err(display_error("create Modus configuration directory"))?;
        let bytes = serde_json::to_vec_pretty(owner).map_err(|error| error.to_string())?;
        atomic_write(&self.ownership_file, &bytes)
            .map_err(display_error("record Tailscale route ownership"))
    }

    fn remove_ownership_if_current(
        &self,
        target_port: u16,
        instance_id: &str,
    ) -> Result<(), String> {
        if self
            .read_ownership()
            .is_some_and(|owner| owner.is_current_desktop(target_port, instance_id))
            && self.ownership_file.exists()
        {
            fs::remove_file(&self.ownership_file)
                .map_err(display_error("remove Tailscale route ownership"))?;
        }
        Ok(())
    }

    fn run_cli(&self, args: &[&str]) -> Result<CliOutput, String> {
        let mut command = Command::new(&self.cli);
        command
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }
        let mut child = command.spawn().map_err(|error| {
            format!(
                "could not run Tailscale CLI {}: {error}",
                PathBuf::from(&self.cli).display()
            )
        })?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "could not capture Tailscale stdout".to_string())?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "could not capture Tailscale stderr".to_string())?;
        let stdout_reader = thread::spawn(move || read_pipe(stdout));
        let stderr_reader = thread::spawn(move || read_pipe(stderr));
        let deadline = Instant::now() + self.command_timeout;
        let exit_status = loop {
            match child.try_wait().map_err(|error| error.to_string())? {
                Some(status) => break status,
                None if Instant::now() < deadline => thread::sleep(Duration::from_millis(25)),
                None => {
                    let _ = child.kill();
                    let _ = child.wait();
                    let _ = stdout_reader.join();
                    let _ = stderr_reader.join();
                    return Err(format!(
                        "Tailscale command timed out after {} ms",
                        self.command_timeout.as_millis()
                    ));
                }
            }
        };
        let stdout = stdout_reader.join().unwrap_or_default();
        let stderr = stderr_reader.join().unwrap_or_default();
        Ok(CliOutput {
            code: exit_status.code().unwrap_or(-1),
            stdout: String::from_utf8_lossy(&stdout).trim().to_string(),
            stderr: String::from_utf8_lossy(&stderr).trim().to_string(),
        })
    }

    fn rollback_route(&self, previous: Option<&ServeEndpoint>) {
        if let Some(previous) = previous {
            let port = previous.target_port.to_string();
            let _ = self.run_cli(&["serve", "--bg", "--yes", &port]);
        } else {
            let _ = self.run_cli(&["serve", "--https=443", "off"]);
        }
    }
}

fn resolve_tailscale_cli() -> OsString {
    if let Some(configured) = env::var_os("MODUS_TAILSCALE_CLI") {
        return configured;
    }
    #[cfg(windows)]
    {
        for root in [
            env::var_os("ProgramFiles"),
            env::var_os("ProgramW6432"),
            env::var_os("LOCALAPPDATA"),
        ]
        .into_iter()
        .flatten()
        {
            let candidate = PathBuf::from(root).join("Tailscale").join("tailscale.exe");
            if candidate.is_file() {
                return candidate.into_os_string();
            }
        }
    }
    OsString::from("tailscale")
}

fn duration_from_env(name: &str, fallback: Duration) -> Duration {
    env::var(name)
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .map(Duration::from_millis)
        .unwrap_or(fallback)
}

fn read_pipe(mut pipe: impl Read) -> Vec<u8> {
    let mut bytes = Vec::new();
    let _ = pipe.read_to_end(&mut bytes);
    bytes
}

fn parse_dns_name(raw: &str) -> Result<String, String> {
    let value: Value = serde_json::from_str(raw)
        .map_err(|error| format!("could not parse Tailscale status: {error}"))?;
    value
        .get("Self")
        .and_then(|value| value.get("DNSName"))
        .and_then(Value::as_str)
        .map(|value| value.trim_end_matches('.').to_string())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Tailscale status did not contain this machine's DNS name".into())
}

fn parse_https_443(raw: &str) -> Result<Option<ServeEndpoint>, ()> {
    if raw.trim().is_empty() || matches!(raw.trim(), "{}" | "null") {
        return Ok(None);
    }
    let value: Value = serde_json::from_str(raw).map_err(|_| ())?;
    let tcp_443_exists = value
        .get("TCP")
        .and_then(Value::as_object)
        .is_some_and(|tcp| tcp.contains_key("443"));
    let Some(web) = value.get("Web").and_then(Value::as_object) else {
        return if tcp_443_exists { Err(()) } else { Ok(None) };
    };
    let endpoints: Vec<_> = web
        .iter()
        .filter(|(key, _)| key.ends_with(":443"))
        .collect();
    if endpoints.is_empty() {
        return if tcp_443_exists { Err(()) } else { Ok(None) };
    }
    if endpoints.len() != 1 {
        return Err(());
    }
    let (endpoint, route) = endpoints[0];
    if value
        .get("AllowFunnel")
        .and_then(Value::as_object)
        .and_then(|funnel| funnel.get(endpoint))
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return Err(());
    }
    let handlers = route.get("Handlers").and_then(Value::as_object).ok_or(())?;
    if handlers.len() != 1 || !handlers.contains_key("/") {
        return Err(());
    }
    let proxy = handlers
        .get("/")
        .and_then(|value| value.get("Proxy"))
        .and_then(Value::as_str)
        .ok_or(())?;
    let target_port = loopback_proxy_port(proxy).ok_or(())?;
    Ok(Some(ServeEndpoint {
        endpoint: endpoint.to_string(),
        proxy: proxy.to_string(),
        target_port,
    }))
}

fn loopback_proxy_port(proxy: &str) -> Option<u16> {
    let address = proxy
        .strip_prefix("http://")
        .or_else(|| proxy.strip_prefix("https://"))?;
    let (host, port) = address.rsplit_once(':')?;
    if !matches!(host, "127.0.0.1" | "localhost") {
        return None;
    }
    port.parse().ok()
}

fn classify_https_443(raw: &str, ownership: Option<&TailscaleOwnership>) -> ServeOwnershipClass {
    let endpoint = match parse_https_443(raw) {
        Ok(None) => return ServeOwnershipClass::None,
        Ok(Some(endpoint)) => endpoint,
        Err(()) => return ServeOwnershipClass::Foreign,
    };
    let Some(owner) = ownership else {
        return ServeOwnershipClass::Foreign;
    };
    if owner.version == 1
        && endpoint.endpoint == owner.endpoint
        && endpoint.proxy == owner.proxy
        && endpoint.target_port == owner.target_port
    {
        ServeOwnershipClass::Modus
    } else {
        ServeOwnershipClass::Foreign
    }
}

fn can_adopt_legacy_rule(raw: &str, dns_name: &str) -> bool {
    matches!(
        parse_https_443(raw),
        Ok(Some(ServeEndpoint { endpoint, target_port, .. }))
            if endpoint == format!("{}:443", dns_name.trim_end_matches('.'))
                && target_port >= LEGACY_BASE_PORT
                && target_port < LEGACY_BASE_PORT + LEGACY_PORT_RANGE
    )
}

fn endpoint_matches(raw: &str, expected: &TailscaleOwnership) -> bool {
    matches!(
        parse_https_443(raw),
        Ok(Some(endpoint))
            if endpoint.endpoint == expected.endpoint
                && endpoint.proxy == expected.proxy
                && endpoint.target_port == expected.target_port
    )
}

fn active_error(url: String, pin_configured: bool, message: String) -> DesktopTailscaleStatus {
    DesktopTailscaleStatus {
        enabled: true,
        state: "error".into(),
        url: Some(url),
        message: Some(message),
        target_port: None,
        pin_configured,
    }
}

fn command_error(label: &str, output: &CliOutput) -> String {
    let detail = if !output.stderr.is_empty() {
        &output.stderr
    } else {
        &output.stdout
    };
    let detail = detail.chars().take(600).collect::<String>();
    if detail.is_empty() {
        format!("{label} failed with exit code {}", output.code)
    } else {
        format!("{label} failed: {detail}")
    }
}

fn atomic_write(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let temporary = path.with_extension(format!("{}.tmp", std::process::id()));
    fs::write(&temporary, bytes)?;
    if path.exists() {
        fs::remove_file(path)?;
    }
    fs::rename(temporary, path)
}

fn display_error(context: &'static str) -> impl FnOnce(std::io::Error) -> String {
    move |error| format!("{context}: {error}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn owner(port: u16) -> TailscaleOwnership {
        TailscaleOwnership {
            version: 1,
            dns_name: "desktop.example.ts.net".into(),
            endpoint: "desktop.example.ts.net:443".into(),
            proxy: format!("http://127.0.0.1:{port}"),
            target_port: port,
            created_at: "test".into(),
            managed_by: None,
            desktop_pid: None,
            instance_id: None,
        }
    }

    #[test]
    fn classifies_only_the_exact_owned_https_root() {
        let raw = r#"{
          "Web": {
            "desktop.example.ts.net:443": {"Handlers": {"/": {"Proxy": "http://127.0.0.1:3778"}}},
            "desktop.example.ts.net:8443": {"Handlers": {"/": {"Proxy": "https+insecure://localhost:8443"}}}
          }
        }"#;
        assert_eq!(
            classify_https_443(raw, Some(&owner(3778))),
            ServeOwnershipClass::Modus
        );
        assert_eq!(
            classify_https_443(raw, Some(&owner(3779))),
            ServeOwnershipClass::Foreign
        );
    }

    #[test]
    fn protects_foreign_paths_and_funnel_rules() {
        let foreign_path = r#"{"Web":{"desktop.example.ts.net:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:3778"},"/other":{"Proxy":"http://127.0.0.1:9000"}}}}}"#;
        let funnel = r#"{"Web":{"desktop.example.ts.net:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:3778"}}}},"AllowFunnel":{"desktop.example.ts.net:443":true}}"#;
        let foreign_tcp = r#"{"TCP":{"443":{"TCPForward":"127.0.0.1:9000"}}}"#;
        assert_eq!(
            classify_https_443(foreign_path, Some(&owner(3778))),
            ServeOwnershipClass::Foreign
        );
        assert_eq!(
            classify_https_443(funnel, Some(&owner(3778))),
            ServeOwnershipClass::Foreign
        );
        assert_eq!(
            classify_https_443(foreign_tcp, None),
            ServeOwnershipClass::Foreign
        );
    }

    #[test]
    fn legacy_adoption_is_limited_to_the_cli_rotation_range() {
        let legacy = r#"{"Web":{"desktop.example.ts.net:443":{"Handlers":{"/":{"Proxy":"http://localhost:3779"}}}}}"#;
        let unrelated = r#"{"Web":{"desktop.example.ts.net:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:9000"}}}}}"#;
        assert!(can_adopt_legacy_rule(legacy, "desktop.example.ts.net"));
        assert!(!can_adopt_legacy_rule(unrelated, "desktop.example.ts.net"));
    }
}
