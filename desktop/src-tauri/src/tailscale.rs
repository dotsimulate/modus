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

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
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

/// A route change that has been recorded but not yet verified.
///
/// Serve is mutated only after this is on disk, and it names both routes the
/// change can leave behind. Whichever of the two Serve later shows is Modus's,
/// so a crash or failure on either side of the mutation stays recoverable
/// instead of leaving a live route that the record calls foreign.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PendingOwnership {
    transition_version: u8,
    previous: Option<TailscaleOwnership>,
    intended: TailscaleOwnership,
}

impl PendingOwnership {
    fn owner(&self, state: TransitionState) -> Option<&TailscaleOwnership> {
        match state {
            TransitionState::Intended => Some(&self.intended),
            TransitionState::Previous => self.previous.as_ref(),
            TransitionState::Absent | TransitionState::Foreign => None,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(untagged)]
enum OwnershipRecord {
    Pending(PendingOwnership),
    Committed(TailscaleOwnership),
}

/// What Serve shows for a pending transition.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TransitionState {
    Intended,
    Previous,
    Absent,
    Foreign,
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
    #[cfg(test)]
    test_cli: Option<TestCli>,
}

/// Stands in for the Tailscale CLI so recovery can be driven without it.
#[cfg(test)]
type TestCli = Box<dyn Fn(&[&str]) -> Result<CliOutput, String> + Send + Sync>;

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
            #[cfg(test)]
            test_cli: None,
        })
    }

    pub fn configured_status(&self) -> DesktopTailscaleStatus {
        let pin_configured = self.pin_configured();
        if !self.enabled() {
            return DesktopTailscaleStatus::disabled(pin_configured);
        }
        let url = self
            .read_record()
            .map(|record| match record {
                OwnershipRecord::Pending(pending) => pending.intended.dns_name,
                OwnershipRecord::Committed(owner) => owner.dns_name,
            })
            .map(|dns_name| format!("https://{}", dns_name.trim_end_matches('.')));
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
        // A pending record is an earlier attempt that never verified its result.
        // Nothing of ours is in flight now, so Serve's current state settles it.
        // A route matching neither side stays untouched with its record kept,
        // and falls through to the foreign check below.
        let current_owner = match self.read_record() {
            Some(OwnershipRecord::Pending(pending)) => {
                match self.settle_transition(&serve_config, &pending) {
                    Ok(state) => pending.owner(state).cloned(),
                    Err(message) => return active_error(url, pin_configured, message),
                }
            }
            Some(OwnershipRecord::Committed(owner)) => Some(owner),
            None => None,
        };
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
        let expected = TailscaleOwnership::desktop(&dns_name, target_port, instance_id);
        if endpoint_matches(&serve_config, &expected) {
            if let Err(error) = self.write_ownership(&expected) {
                return active_error(url, pin_configured, error);
            }
            return self.active_status(url, pin_configured, target_port);
        }
        let previous = if ownership_class == ServeOwnershipClass::Modus {
            current_owner.or_else(|| {
                parse_https_443(&serve_config).ok().flatten().map(|route| {
                    let mut owner =
                        TailscaleOwnership::desktop(&dns_name, route.target_port, instance_id);
                    owner.endpoint = route.endpoint;
                    owner.proxy = route.proxy;
                    owner
                })
            })
        } else {
            None
        };
        let pending = PendingOwnership {
            transition_version: 1,
            previous,
            intended: expected,
        };

        // Record the transition BEFORE mutating the route.
        //
        // Writing a record for the new route alone was not enough: a crash
        // between that write and the Serve command left the old route live
        // under a record naming the new one, and the next start classified
        // Modus's own rule as foreign and refused to touch it. The pending
        // record names both, so either outcome of the mutation is recognised.
        if let Err(error) = self.write_record(&OwnershipRecord::Pending(pending.clone())) {
            return active_error(url, pin_configured, error);
        }

        let failure = match self.run_cli(&["serve", "--bg", "--yes", &target_port.to_string()]) {
            Ok(output) if output.code == 0 => None,
            Ok(output) => Some(command_error("tailscale serve", &output)),
            Err(message) => Some(message),
        };

        // Commit only what Serve now verifiably shows. Absence is not final
        // here — a timed-out command can still land — so anything short of a
        // verified route keeps the pending record for the next reconcile.
        let state = match self
            .serve_config()
            .and_then(|raw| self.record_verified(&raw, &pending))
        {
            Ok(state) => state,
            Err(message) => {
                let message = match failure {
                    Some(failure) => format!("{failure}; {message}"),
                    None => message,
                };
                return active_error(url, pin_configured, message);
            }
        };
        let failure = failure.unwrap_or_else(|| {
            "Tailscale accepted the Serve command but did not publish the expected Modus route"
                .into()
        });
        match state {
            TransitionState::Intended => self.active_status(url, pin_configured, target_port),
            TransitionState::Previous => active_error(url, pin_configured, failure),
            TransitionState::Absent => {
                let Some(previous) = pending.previous.as_ref() else {
                    return active_error(url, pin_configured, failure);
                };
                let detail = match self.restore_previous(previous, &pending) {
                    Ok(TransitionState::Intended) => {
                        return self.active_status(url, pin_configured, target_port);
                    }
                    Ok(TransitionState::Previous) => {
                        format!("{failure}; restored the previous Modus route")
                    }
                    Ok(_) => format!("{failure}; the previous Modus route could not be restored"),
                    Err(error) => format!("{failure}; {error}"),
                };
                active_error(url, pin_configured, detail)
            }
            TransitionState::Foreign => active_error(
                url,
                pin_configured,
                format!(
                    "{failure}; HTTPS :443 now matches neither recorded Modus route, so Modus left it untouched"
                ),
            ),
        }
    }

    fn active_status(
        &self,
        url: String,
        pin_configured: bool,
        target_port: u16,
    ) -> DesktopTailscaleStatus {
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
        let owner = match self.read_record() {
            None => return Ok(()),
            Some(OwnershipRecord::Committed(owner)) => {
                if !owner.is_current_desktop(target_port, instance_id) {
                    return Ok(());
                }
                owner
            }
            // A transition this backend started owns whichever of its two
            // routes is live, including a previous route it failed to replace.
            // Neither live means nothing to remove; a foreign route stays put.
            Some(OwnershipRecord::Pending(pending)) => {
                if !pending
                    .intended
                    .is_current_desktop(target_port, instance_id)
                {
                    return Ok(());
                }
                let state = self.settle_transition(&self.serve_config()?, &pending)?;
                match pending.owner(state) {
                    Some(owner) => owner.clone(),
                    None => return Ok(()),
                }
            }
        };

        let serve_config = self.serve_config()?;
        match classify_https_443(&serve_config, Some(&owner)) {
            ServeOwnershipClass::None => {
                self.remove_ownership(&owner)?;
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
        self.remove_ownership(&owner)
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

    fn read_record(&self) -> Option<OwnershipRecord> {
        let bytes = fs::read(&self.ownership_file).ok()?;
        let record: OwnershipRecord = serde_json::from_slice(&bytes).ok()?;
        let valid = |owner: &TailscaleOwnership| {
            owner.version == 1 && !owner.dns_name.is_empty() && !owner.endpoint.is_empty()
        };
        let accepted = match &record {
            OwnershipRecord::Committed(owner) => valid(owner),
            OwnershipRecord::Pending(pending) => {
                pending.transition_version == 1
                    && valid(&pending.intended)
                    && pending.previous.iter().all(valid)
            }
        };
        accepted.then_some(record)
    }

    fn write_ownership(&self, owner: &TailscaleOwnership) -> Result<(), String> {
        self.write_record(&OwnershipRecord::Committed(owner.clone()))
    }

    fn write_record(&self, record: &OwnershipRecord) -> Result<(), String> {
        fs::create_dir_all(&self.config_dir)
            .map_err(display_error("create Modus configuration directory"))?;
        let bytes = serde_json::to_vec_pretty(record).map_err(|error| error.to_string())?;
        atomic_write(&self.ownership_file, &bytes)
            .map_err(display_error("record Tailscale route ownership"))
    }

    /// Commit a verified side of a transition and keep the pending record
    /// otherwise. Used after this process mutated the route, when an absent
    /// route may still be a mutation that has not landed yet.
    fn record_verified(
        &self,
        raw: &str,
        pending: &PendingOwnership,
    ) -> Result<TransitionState, String> {
        let state = transition_state(raw, pending);
        if let Some(owner) = pending.owner(state) {
            self.write_ownership(owner)?;
        }
        Ok(state)
    }

    /// Resolve a transition left by an earlier attempt. Only valid when no
    /// mutation of ours is in flight, so an absent route is final and the
    /// record can go. A foreign route keeps the record and stays untouched.
    fn settle_transition(
        &self,
        raw: &str,
        pending: &PendingOwnership,
    ) -> Result<TransitionState, String> {
        let state = self.record_verified(raw, pending)?;
        if state == TransitionState::Absent {
            match fs::remove_file(&self.ownership_file) {
                Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
                    return Err(display_error("remove settled Tailscale transition")(error));
                }
                _ => {}
            }
        }
        Ok(state)
    }

    /// Put back the previous Modus route after a transition removed it
    /// without publishing the new one, and report what Serve then shows.
    fn restore_previous(
        &self,
        previous: &TailscaleOwnership,
        pending: &PendingOwnership,
    ) -> Result<TransitionState, String> {
        let output =
            self.run_cli(&["serve", "--bg", "--yes", &previous.target_port.to_string()])?;
        if output.code != 0 {
            return Err(command_error("Tailscale rollback", &output));
        }
        self.record_verified(&self.serve_config()?, pending)
    }

    fn remove_ownership(&self, owner: &TailscaleOwnership) -> Result<(), String> {
        if matches!(self.read_record(), Some(OwnershipRecord::Committed(current)) if current == *owner)
        {
            fs::remove_file(&self.ownership_file)
                .map_err(display_error("remove Tailscale route ownership"))?;
        }
        Ok(())
    }

    fn run_cli(&self, args: &[&str]) -> Result<CliOutput, String> {
        #[cfg(test)]
        if let Some(fake) = &self.test_cli {
            return fake(args);
        }
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

fn transition_state(raw: &str, pending: &PendingOwnership) -> TransitionState {
    if classify_https_443(raw, Some(&pending.intended)) == ServeOwnershipClass::Modus {
        TransitionState::Intended
    } else if pending.previous.as_ref().is_some_and(|previous| {
        classify_https_443(raw, Some(previous)) == ServeOwnershipClass::Modus
    }) {
        TransitionState::Previous
    } else if classify_https_443(raw, None) == ServeOwnershipClass::None {
        TransitionState::Absent
    } else {
        TransitionState::Foreign
    }
}

fn can_adopt_legacy_rule(raw: &str, dns_name: &str) -> bool {
    matches!(
        parse_https_443(raw),
        Ok(Some(ServeEndpoint { endpoint, target_port, .. }))
            if endpoint == format!("{}:443", dns_name.trim_end_matches('.'))
                && (LEGACY_BASE_PORT..LEGACY_BASE_PORT + LEGACY_PORT_RANGE)
                    .contains(&target_port)
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
    // Write beside the target, then replace it in a single rename. Unlinking the
    // existing file first left a window in which neither the old record nor the
    // new one was at the canonical path, so a crash there lost the record
    // outright — which is the opposite of what this function is named for.
    // std::fs::rename replaces the destination on both platforms (Windows goes
    // through MoveFileEx with MOVEFILE_REPLACE_EXISTING), so the unlink bought
    // nothing.
    let temporary = path.with_extension(format!("{}.tmp", std::process::id()));
    fs::write(&temporary, bytes)?;
    fs::rename(temporary, path)
}

fn display_error(context: &'static str) -> impl FnOnce(std::io::Error) -> String {
    move |error| format!("{context}: {error}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        collections::VecDeque,
        sync::{Arc, Mutex},
    };

    const DNS: &str = "desktop.example.ts.net";
    const INSTANCE: &str = "instance-under-test";

    /// How the fake answers one `serve --bg` call.
    #[derive(Clone, Copy)]
    enum Serve {
        Apply,
        FailBeforeMutation,
        FailAfterMutation,
        /// Times out with nothing applied yet; the test may land it later.
        Timeout,
        AcceptWithoutPublishing,
        /// Snapshot the record, then die without mutating or with mutating.
        CrashBeforeMutation,
        CrashAfterMutation,
    }

    #[derive(Default)]
    struct FakeState {
        https_443: Option<String>,
        funnel: bool,
        serve_script: VecDeque<Serve>,
        status_failures: VecDeque<bool>,
        off_fails: bool,
        log: Vec<String>,
        record_at_mutation: Vec<Option<String>>,
    }

    /// Stands in for the Tailscale CLI: a :443 root route plus an unrelated
    /// :8443 rule that every test expects to survive untouched.
    struct Fake {
        dir: PathBuf,
        state: Arc<Mutex<FakeState>>,
    }

    impl Fake {
        fn new() -> Self {
            let dir = std::env::temp_dir()
                .join(format!("modus-tailscale-{}", uuid::Uuid::new_v4().simple()));
            fs::create_dir_all(&dir).expect("create test directory");
            fs::write(dir.join("remote"), "tailscale\n").expect("enable Tailnet access");
            Self {
                dir,
                state: Arc::default(),
            }
        }

        fn with_route(self, port: u16) -> Self {
            self.set_route(Some(port));
            self
        }

        fn set_route(&self, port: Option<u16>) {
            self.state().https_443 = port.map(|port| format!("http://127.0.0.1:{port}"));
        }

        fn state(&self) -> std::sync::MutexGuard<'_, FakeState> {
            self.state.lock().expect("fake state")
        }

        fn script(&self, steps: &[Serve]) {
            self.state().serve_script.extend(steps.iter().copied());
        }

        fn route(&self) -> Option<String> {
            self.state().https_443.clone()
        }

        fn ownership_file(&self) -> PathBuf {
            self.dir.join("tailscale-serve-owner.json")
        }

        fn record(&self) -> Option<Value> {
            let bytes = fs::read(self.ownership_file()).ok()?;
            Some(serde_json::from_slice(&bytes).expect("ownership record is JSON"))
        }

        fn committed_port(&self) -> Option<u64> {
            let record = self.record()?;
            if record.get("transitionVersion").is_some() {
                return None;
            }
            record["targetPort"].as_u64()
        }

        fn pending_ports(&self) -> Option<(Option<u64>, u64)> {
            let record = self.record()?;
            record.get("transitionVersion")?;
            Some((
                record["previous"]["targetPort"].as_u64(),
                record["intended"]["targetPort"].as_u64()?,
            ))
        }

        fn serve_calls(&self) -> usize {
            self.state()
                .log
                .iter()
                .filter(|call| call.starts_with("serve --bg"))
                .count()
        }

        /// A fresh manager over the same fake and directory, as after a restart.
        fn manager(&self) -> TailscaleManager {
            let state = Arc::clone(&self.state);
            let ownership = self.ownership_file();
            TailscaleManager {
                remote_file: self.dir.join("remote"),
                ownership_file: self.ownership_file(),
                config_dir: self.dir.clone(),
                cli: OsString::from("unused-in-tests"),
                command_timeout: Duration::from_millis(10),
                status_attempts: 1,
                status_delay: Duration::ZERO,
                test_cli: Some(Box::new(move |args: &[&str]| {
                    let ok = |stdout: String| {
                        Ok(CliOutput {
                            code: 0,
                            stdout,
                            stderr: String::new(),
                        })
                    };
                    let failed = |stderr: &str| {
                        Ok(CliOutput {
                            code: 1,
                            stdout: String::new(),
                            stderr: stderr.into(),
                        })
                    };
                    let mut guard = state.lock().expect("fake state");
                    guard.log.push(args.join(" "));
                    match args {
                        ["status", "--json"] => ok(format!(r#"{{"Self":{{"DNSName":"{DNS}."}}}}"#)),
                        ["serve", "status", "--json"] => {
                            if guard.status_failures.pop_front().unwrap_or(false) {
                                return failed("status unavailable");
                            }
                            ok(render_serve_config(&guard))
                        }
                        ["serve", "--bg", "--yes", port] => {
                            let proxy = format!("http://127.0.0.1:{port}");
                            let step = guard.serve_script.pop_front().unwrap_or(Serve::Apply);
                            if matches!(
                                step,
                                Serve::CrashBeforeMutation | Serve::CrashAfterMutation
                            ) {
                                guard
                                    .record_at_mutation
                                    .push(fs::read_to_string(&ownership).ok());
                            }
                            match step {
                                Serve::Apply => {
                                    guard.https_443 = Some(proxy);
                                    ok(String::new())
                                }
                                Serve::FailBeforeMutation => failed("serve refused"),
                                Serve::FailAfterMutation => {
                                    guard.https_443 = Some(proxy);
                                    failed("serve reported failure")
                                }
                                Serve::Timeout => {
                                    Err("Tailscale command timed out after 10 ms".into())
                                }
                                Serve::AcceptWithoutPublishing => {
                                    guard.https_443 = None;
                                    ok(String::new())
                                }
                                Serve::CrashBeforeMutation => Err("simulated crash".into()),
                                Serve::CrashAfterMutation => {
                                    guard.https_443 = Some(proxy);
                                    Err("simulated crash".into())
                                }
                            }
                        }
                        ["serve", "--https=443", "off"] => {
                            if guard.off_fails {
                                return failed("off refused");
                            }
                            guard.https_443 = None;
                            ok(String::new())
                        }
                        other => panic!("unexpected Tailscale command {other:?}"),
                    }
                })),
            }
        }

        /// Put the record back exactly as it was when the process "died" at
        /// the mutation boundary, discarding whatever the failure path wrote.
        fn restore_crash_snapshot(&self) {
            let snapshot = self
                .state()
                .record_at_mutation
                .last()
                .cloned()
                .flatten()
                .expect("record existed at mutation");
            fs::write(self.ownership_file(), snapshot).expect("restore crash snapshot");
        }

        fn commit(&self, port: u16) {
            let manager = self.manager();
            manager
                .write_ownership(&TailscaleOwnership::desktop(DNS, port, INSTANCE))
                .expect("seed ownership");
        }
    }

    impl Drop for Fake {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.dir);
        }
    }

    /// A :443 root route when one is set, beside an unrelated :8443 rule that
    /// the fake CLI offers no command to remove: anything but status, publish
    /// and `--https=443 off` panics, so no test can pass by resetting Serve.
    fn render_serve_config(state: &FakeState) -> String {
        let handler = |proxy: &str| serde_json::json!({ "Handlers": { "/": { "Proxy": proxy } } });
        let mut web = serde_json::Map::new();
        let mut tcp = serde_json::Map::new();
        web.insert(
            format!("{DNS}:8443"),
            handler("https+insecure://localhost:8443"),
        );
        tcp.insert("8443".into(), serde_json::json!({ "HTTPS": true }));
        if let Some(proxy) = &state.https_443 {
            web.insert(format!("{DNS}:443"), handler(proxy));
            tcp.insert("443".into(), serde_json::json!({ "HTTPS": true }));
        }
        let mut value = serde_json::json!({ "TCP": tcp, "Web": web });
        if state.funnel {
            let mut funnel = serde_json::Map::new();
            funnel.insert(format!("{DNS}:443"), Value::Bool(true));
            value["AllowFunnel"] = Value::Object(funnel);
        }
        value.to_string()
    }

    fn proxy(port: u16) -> Option<String> {
        Some(format!("http://127.0.0.1:{port}"))
    }

    #[test]
    fn records_both_routes_before_moving_an_owned_route() {
        let fake = Fake::new().with_route(4001);
        fake.commit(4001);
        fake.script(&[Serve::CrashBeforeMutation]);
        fake.manager().reconcile(4002, INSTANCE);
        let at_mutation: Value = serde_json::from_str(
            fake.state().record_at_mutation[0]
                .as_deref()
                .expect("record present at mutation"),
        )
        .expect("record is JSON");
        assert_eq!(at_mutation["previous"]["targetPort"], 4001);
        assert_eq!(at_mutation["intended"]["targetPort"], 4002);
    }

    #[test]
    fn publishes_and_then_moves_an_owned_route() {
        let fake = Fake::new();
        let status = fake.manager().reconcile(4001, INSTANCE);
        assert_eq!(status.state, "active");
        assert_eq!(fake.route(), proxy(4001));
        assert_eq!(fake.committed_port(), Some(4001));

        let status = fake.manager().reconcile(4002, INSTANCE);
        assert_eq!(status.state, "active", "{:?}", status.message);
        assert_eq!(status.target_port, Some(4002));
        assert_eq!(fake.route(), proxy(4002));
        assert_eq!(fake.committed_port(), Some(4002));
    }

    /// The TAIL-01 window: the record was written, the process died before
    /// Serve changed. Serve still shows A; the next start must recognise it.
    #[test]
    fn recovers_a_move_interrupted_before_the_mutation() {
        let fake = Fake::new().with_route(4001);
        fake.commit(4001);
        fake.script(&[Serve::CrashBeforeMutation]);
        fake.manager().reconcile(4002, INSTANCE);
        fake.restore_crash_snapshot();
        assert_eq!(fake.route(), proxy(4001));
        assert_eq!(fake.pending_ports(), Some((Some(4001), 4002)));

        let status = fake.manager().reconcile(4003, "restarted-instance");
        assert_eq!(status.state, "active", "{:?}", status.message);
        assert_eq!(fake.route(), proxy(4003));
        assert_eq!(fake.committed_port(), Some(4003));
    }

    #[test]
    fn recovers_a_move_interrupted_after_the_mutation() {
        let fake = Fake::new().with_route(4001);
        fake.commit(4001);
        fake.script(&[Serve::CrashAfterMutation]);
        fake.manager().reconcile(4002, INSTANCE);
        fake.restore_crash_snapshot();
        assert_eq!(fake.route(), proxy(4002));

        let status = fake.manager().reconcile(4002, INSTANCE);
        assert_eq!(status.state, "active", "{:?}", status.message);
        assert_eq!(fake.committed_port(), Some(4002));
        assert_eq!(
            fake.serve_calls(),
            1,
            "an already-live route is adopted, not re-served"
        );
    }

    #[test]
    fn command_failure_before_the_mutation_keeps_the_previous_owner() {
        let fake = Fake::new().with_route(4001);
        fake.commit(4001);
        fake.script(&[Serve::FailBeforeMutation]);
        let status = fake.manager().reconcile(4002, INSTANCE);
        assert_eq!(status.state, "error");
        assert!(status.message.unwrap().contains("serve refused"));
        assert_eq!(fake.route(), proxy(4001));
        assert_eq!(fake.committed_port(), Some(4001));

        let status = fake.manager().reconcile(4002, INSTANCE);
        assert_eq!(status.state, "active", "{:?}", status.message);
        assert_eq!(fake.committed_port(), Some(4002));
    }

    #[test]
    fn command_failure_after_the_mutation_commits_the_verified_route() {
        let fake = Fake::new().with_route(4001);
        fake.commit(4001);
        fake.script(&[Serve::FailAfterMutation]);
        let status = fake.manager().reconcile(4002, INSTANCE);
        assert_eq!(status.state, "active", "{:?}", status.message);
        assert_eq!(fake.route(), proxy(4002));
        assert_eq!(fake.committed_port(), Some(4002));
    }

    /// A timed-out command can still land after Modus has given up on it, so
    /// an absent route must not discard the record that would recognise it.
    #[test]
    fn timeout_keeps_the_transition_for_a_mutation_that_lands_late() {
        let fake = Fake::new();
        fake.script(&[Serve::Timeout]);
        let status = fake.manager().reconcile(4001, INSTANCE);
        assert_eq!(status.state, "error");
        assert!(status.message.unwrap().contains("timed out"));
        assert_eq!(fake.route(), None);
        assert_eq!(fake.pending_ports(), Some((None, 4001)));

        fake.set_route(Some(4001));

        let status = fake.manager().reconcile(4005, "restarted-instance");
        assert_eq!(status.state, "active", "{:?}", status.message);
        assert_eq!(fake.route(), proxy(4005));
        assert_eq!(fake.committed_port(), Some(4005));
    }

    #[test]
    fn unpublished_route_restores_the_previous_one() {
        let fake = Fake::new().with_route(4001);
        fake.commit(4001);
        fake.script(&[Serve::AcceptWithoutPublishing, Serve::Apply]);
        let status = fake.manager().reconcile(4002, INSTANCE);
        assert_eq!(status.state, "error");
        assert!(status
            .message
            .unwrap()
            .contains("restored the previous Modus route"));
        assert_eq!(fake.route(), proxy(4001));
        assert_eq!(fake.committed_port(), Some(4001));
    }

    #[test]
    fn failed_rollback_keeps_the_pending_transition() {
        let fake = Fake::new().with_route(4001);
        fake.commit(4001);
        fake.script(&[Serve::AcceptWithoutPublishing, Serve::FailBeforeMutation]);
        let status = fake.manager().reconcile(4002, INSTANCE);
        assert_eq!(status.state, "error");
        assert!(status
            .message
            .unwrap()
            .contains("Tailscale rollback failed"));
        assert_eq!(fake.route(), None);
        assert_eq!(fake.pending_ports(), Some((Some(4001), 4002)));

        let status = fake.manager().reconcile(4002, INSTANCE);
        assert_eq!(status.state, "active", "{:?}", status.message);
        assert_eq!(fake.committed_port(), Some(4002));
    }

    #[test]
    fn status_failure_after_the_mutation_keeps_the_pending_transition() {
        let fake = Fake::new().with_route(4001);
        fake.commit(4001);
        fake.state().status_failures.extend([false, true]);
        let status = fake.manager().reconcile(4002, INSTANCE);
        assert_eq!(status.state, "error");
        assert!(status.message.unwrap().contains("status unavailable"));
        assert_eq!(fake.route(), proxy(4002));
        assert_eq!(fake.pending_ports(), Some((Some(4001), 4002)));

        let status = fake.manager().reconcile(4002, INSTANCE);
        assert_eq!(status.state, "active", "{:?}", status.message);
        assert_eq!(fake.committed_port(), Some(4002));
    }

    #[test]
    fn foreign_routes_are_never_touched() {
        let fake = Fake::new().with_route(9000);
        let status = fake.manager().reconcile(4001, INSTANCE);
        assert_eq!(status.state, "blocked");
        assert_eq!(fake.route(), proxy(9000));
        assert_eq!(fake.record(), None);

        // An owned port with Funnel switched on is no longer Modus's plain route.
        let fake = Fake::new().with_route(4001);
        fake.commit(4001);
        fake.state().funnel = true;
        assert_eq!(fake.manager().reconcile(4002, INSTANCE).state, "blocked");
        assert_eq!(fake.route(), proxy(4001));

        // A transition whose routes were both replaced by someone else.
        let fake = Fake::new().with_route(4001);
        fake.commit(4001);
        fake.script(&[Serve::CrashBeforeMutation]);
        fake.manager().reconcile(4002, INSTANCE);
        fake.restore_crash_snapshot();
        fake.set_route(Some(9000));
        assert_eq!(fake.manager().reconcile(4003, INSTANCE).state, "blocked");
        assert_eq!(fake.route(), proxy(9000));
        assert_eq!(fake.pending_ports(), Some((Some(4001), 4002)));
        assert_eq!(fake.manager().release(4002, INSTANCE), Ok(()));
        assert_eq!(fake.route(), proxy(9000));

        assert_eq!(
            fake.serve_calls(),
            1,
            "only the interrupted move reached Serve"
        );
    }

    #[test]
    fn adopts_a_legacy_cli_route_through_a_recorded_transition() {
        let fake = Fake::new();
        fake.state().https_443 = Some("http://localhost:3779".into());
        let status = fake.manager().reconcile(4001, INSTANCE);
        assert_eq!(status.state, "active", "{:?}", status.message);
        assert_eq!(fake.route(), proxy(4001));
        assert_eq!(fake.committed_port(), Some(4001));
    }

    #[test]
    fn release_removes_only_its_own_route() {
        let fake = Fake::new();
        assert_eq!(fake.manager().reconcile(4001, INSTANCE).state, "active");

        fake.manager()
            .release(4001, "another-instance")
            .expect("no-op");
        fake.manager().release(4002, INSTANCE).expect("no-op");
        assert_eq!(fake.route(), proxy(4001));
        assert_eq!(fake.committed_port(), Some(4001));

        fake.manager().release(4001, INSTANCE).expect("release");
        assert_eq!(fake.route(), None);
        assert_eq!(fake.record(), None);
    }

    #[test]
    fn failed_release_keeps_route_and_record() {
        let fake = Fake::new();
        assert_eq!(fake.manager().reconcile(4001, INSTANCE).state, "active");
        fake.state().off_fails = true;
        assert!(fake.manager().release(4001, INSTANCE).is_err());
        assert_eq!(fake.route(), proxy(4001));
        assert_eq!(fake.committed_port(), Some(4001));
    }

    /// Quit after a failed move still removes the route that move left live.
    #[test]
    fn release_settles_an_interrupted_transition() {
        let fake = Fake::new().with_route(4001);
        fake.commit(4001);
        fake.script(&[Serve::CrashBeforeMutation]);
        fake.manager().reconcile(4002, INSTANCE);
        fake.restore_crash_snapshot();

        fake.manager().release(4002, INSTANCE).expect("release");
        assert_eq!(fake.route(), None);
        assert_eq!(fake.record(), None);

        let fake = Fake::new();
        fake.script(&[Serve::CrashBeforeMutation]);
        fake.manager().reconcile(4002, INSTANCE);
        fake.restore_crash_snapshot();
        fake.manager().release(4002, INSTANCE).expect("release");
        assert_eq!(
            fake.record(),
            None,
            "a transition that never landed is settled"
        );
    }

    #[test]
    fn disabled_access_never_calls_tailscale() {
        let fake = Fake::new().with_route(4001);
        fs::remove_file(fake.dir.join("remote")).expect("disable");
        assert_eq!(fake.manager().reconcile(4002, INSTANCE).state, "disabled");
        assert!(fake.state().log.is_empty());
        assert_eq!(fake.route(), proxy(4001));
    }

    /// Replacement has to work without unlinking first, or removing the unlink
    /// would trade a crash window for a broken write. This does not reproduce the
    /// window itself — that needs a crash between two syscalls — it proves the
    /// single-rename form is sufficient on this platform, which is the actual
    /// risk of the change.
    #[test]
    fn atomic_write_replaces_an_existing_record_without_unlinking_it() {
        let dir = std::env::temp_dir().join(format!(
            "modus-atomic-write-{}",
            uuid::Uuid::new_v4().simple()
        ));
        fs::create_dir_all(&dir).expect("create test directory");
        let path = dir.join("ownership.json");

        atomic_write(&path, b"first").expect("initial write");
        atomic_write(&path, b"second").expect("replace existing record");
        assert_eq!(fs::read(&path).expect("read record"), b"second");

        let strays: Vec<String> = fs::read_dir(&dir)
            .expect("list directory")
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.contains(".tmp"))
            .collect();
        assert!(strays.is_empty(), "left temporary files behind: {strays:?}");

        let _ = fs::remove_dir_all(&dir);
    }

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
