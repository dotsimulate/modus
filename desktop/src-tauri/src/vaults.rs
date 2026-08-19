use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    fs,
    fs::OpenOptions,
    io::Write,
    path::{Component, Path, PathBuf},
    thread,
    time::{Duration, SystemTime},
};
use uuid::Uuid;

const MANIFEST_FILE: &str = "vault-manifest.json";
const MANIFEST_VERSION: u32 = 1;
const LOCK_RETRY: Duration = Duration::from_millis(10);
const LOCK_TIMEOUT: Duration = Duration::from_secs(5);
const LOCK_STALE: Duration = Duration::from_secs(30);

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VaultRegistryEntry {
    pub slug: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub root: Option<String>,
    #[serde(default, skip_serializing, skip_deserializing)]
    pub requires_repair: bool,
    pub created_at: u64,
    #[serde(default, skip_serializing_if = "is_false")]
    pub autostart: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_opened_at: Option<u64>,
}

#[derive(Debug, Deserialize, Serialize)]
struct VaultRegistryFile {
    vaults: Vec<VaultRegistryEntry>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct VaultManifest {
    version: u32,
    slug: String,
    created_at: u64,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum VaultRootMode {
    Initialize,
    Register,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultRegistrationRequest {
    pub slug: String,
    pub root: String,
    pub name: Option<String>,
    pub mode: VaultRootMode,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultUpdateRequest {
    pub name: Option<String>,
    pub autostart: Option<bool>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultListItem {
    pub slug: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub root: Option<String>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub requires_repair: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<u64>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub autostart: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_opened_at: Option<u64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultListResponse {
    pub current: Option<String>,
    pub vaults: Vec<VaultListItem>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "mode", rename_all = "kebab-case")]
pub enum VaultPolicyRule {
    AllowAll,
    Deny { allow: Vec<String> },
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VaultPolicy {
    pub plugins: VaultPolicyRule,
    pub project_automation: VaultPolicyRule,
    pub channels: VaultPolicyRule,
}

#[derive(Clone)]
pub struct VaultRegistry {
    main_home: PathBuf,
}

struct RegistryLock {
    path: PathBuf,
    token: String,
}

impl Drop for RegistryLock {
    fn drop(&mut self) {
        if fs::read_to_string(&self.path).is_ok_and(|value| value.trim() == self.token) {
            let _ = fs::remove_file(&self.path);
        }
    }
}

impl RegistryLock {
    fn assert_owned(&self) -> Result<(), String> {
        if fs::read_to_string(&self.path).is_ok_and(|value| value.trim() == self.token) {
            Ok(())
        } else {
            Err(format!(
                "Vault registry lock ownership was lost: {}",
                self.path.display()
            ))
        }
    }
}

fn is_false(value: &bool) -> bool {
    !*value
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

pub fn normalize_vault_slug(value: Option<&str>) -> Result<Option<String>, String> {
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

fn strip_extended_prefix(path: PathBuf) -> PathBuf {
    #[cfg(windows)]
    {
        let value = path.to_string_lossy();
        if let Some(rest) = value.strip_prefix(r"\\?\UNC\") {
            return PathBuf::from(format!(r"\\{rest}"));
        }
        if let Some(rest) = value.strip_prefix(r"\\?\") {
            return PathBuf::from(rest);
        }
    }
    path
}

pub fn canonical_vault_root(path: &Path) -> Result<PathBuf, String> {
    if !path.is_absolute() {
        return Err("Vault root must be an absolute path".into());
    }
    let mut absolute = PathBuf::new();
    let mut normal_depth = 0usize;
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => absolute.push(prefix.as_os_str()),
            Component::RootDir => absolute.push(component.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => {
                if normal_depth > 0 {
                    absolute.pop();
                    normal_depth -= 1;
                }
            }
            Component::Normal(name) => {
                absolute.push(name);
                normal_depth += 1;
            }
        }
    }
    let mut existing = absolute.clone();
    let mut missing = Vec::new();
    while !existing.exists() {
        let name = existing
            .file_name()
            .ok_or_else(|| format!("Could not resolve Vault root {}", absolute.display()))?;
        missing.push(name.to_os_string());
        if !existing.pop() {
            return Err(format!(
                "Could not resolve Vault root {}",
                absolute.display()
            ));
        }
    }
    let mut canonical = strip_extended_prefix(fs::canonicalize(&existing).map_err(|error| {
        format!(
            "Could not resolve Vault root {}: {error}",
            absolute.display()
        )
    })?);
    for name in missing.iter().rev() {
        canonical.push(name);
    }
    Ok(canonical)
}

fn path_key(path: &Path) -> String {
    let value = path.to_string_lossy().to_string();
    if cfg!(windows) {
        value.to_ascii_lowercase()
    } else {
        value
    }
}

fn path_is_within(root: &Path, candidate: &Path) -> bool {
    let root = path_key(root);
    let candidate = path_key(candidate);
    if candidate == root {
        return true;
    }
    let separator = std::path::MAIN_SEPARATOR;
    candidate.starts_with(&format!("{root}{separator}"))
}

impl VaultRegistry {
    pub fn new(main_home: PathBuf) -> Result<Self, String> {
        fs::create_dir_all(&main_home)
            .map_err(|error| format!("create Main Modus home {}: {error}", main_home.display()))?;
        Ok(Self {
            main_home: canonical_vault_root(&main_home)?,
        })
    }

    pub fn main_home(&self) -> &Path {
        &self.main_home
    }

    fn path(&self) -> PathBuf {
        self.main_home.join("vaults.json")
    }

    fn lock_path(&self) -> PathBuf {
        self.main_home.join("vaults.json.lock")
    }

    fn assert_outside_main(&self, root: &Path) -> Result<(), String> {
        if path_is_within(&self.main_home, root) {
            Err("Named Vault roots must be outside Main's Modus home".into())
        } else {
            Ok(())
        }
    }

    fn read(&self) -> Result<Vec<VaultRegistryEntry>, String> {
        let path = self.path();
        if !path.exists() {
            return Ok(Vec::new());
        }
        let bytes = fs::read(&path)
            .map_err(|error| format!("read Vault registry {}: {error}", path.display()))?;
        let mut file: VaultRegistryFile = serde_json::from_slice(&bytes)
            .map_err(|error| format!("parse Vault registry {}: {error}", path.display()))?;
        let mut slugs = HashSet::new();
        let mut roots = HashSet::new();
        for entry in &mut file.vaults {
            let slug = normalize_vault_slug(Some(&entry.slug))?
                .ok_or_else(|| "registry cannot contain the default Vault".to_string())?;
            if !slugs.insert(slug.clone()) {
                return Err(format!("registry contains duplicate Vault {slug}"));
            }
            entry.slug = slug;
            match entry.root.as_deref() {
                Some(root) => {
                    let root = canonical_vault_root(Path::new(root))?;
                    self.assert_outside_main(&root)?;
                    if !roots.insert(path_key(&root)) {
                        return Err("registry contains duplicate canonical Vault roots".into());
                    }
                    entry.root = Some(root.display().to_string());
                    entry.requires_repair = false;
                }
                None => {
                    entry.requires_repair = true;
                    entry.autostart = false;
                }
            }
        }
        Ok(file.vaults)
    }

    fn acquire_lock(&self) -> Result<RegistryLock, String> {
        let path = self.lock_path();
        let token = format!("{}:{}", std::process::id(), Uuid::new_v4());
        let started = SystemTime::now();
        loop {
            match OpenOptions::new().write(true).create_new(true).open(&path) {
                Ok(mut file) => {
                    writeln!(file, "{token}")
                        .map_err(|error| format!("write Vault registry lock: {error}"))?;
                    return Ok(RegistryLock { path, token });
                }
                Err(error)
                    if error.kind() == std::io::ErrorKind::AlreadyExists
                        || (cfg!(windows)
                            && error.kind() == std::io::ErrorKind::PermissionDenied) => {}
                Err(error) => {
                    return Err(format!(
                        "create Vault registry lock {}: {error}",
                        path.display()
                    ))
                }
            }

            let lock_text = fs::read_to_string(&path).unwrap_or_default();
            let owner = lock_text
                .split(':')
                .next()
                .and_then(|value| value.trim().parse::<u32>().ok());
            let stale = fs::metadata(&path)
                .and_then(|metadata| metadata.modified())
                .ok()
                .and_then(|modified| modified.elapsed().ok())
                .is_some_and(|age| age >= LOCK_STALE);
            if owner.is_some_and(|pid| !process_is_alive(pid)) || (owner.is_none() && stale) {
                match fs::remove_file(&path) {
                    Ok(()) => continue,
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                    Err(error) => return Err(format!("remove stale Vault registry lock: {error}")),
                }
            }
            if started.elapsed().unwrap_or_default() >= LOCK_TIMEOUT {
                return Err(format!(
                    "Timed out waiting for Vault registry lock: {}",
                    path.display()
                ));
            }
            thread::sleep(LOCK_RETRY);
        }
    }

    fn write(&self, entries: &[VaultRegistryEntry], lock: &RegistryLock) -> Result<(), String> {
        lock.assert_owned()?;
        let path = self.path();
        let temporary = self.main_home.join(format!(
            "vaults.json.{}.{}.tmp",
            std::process::id(),
            Uuid::new_v4().simple()
        ));
        let value = VaultRegistryFile {
            vaults: entries.to_vec(),
        };
        let bytes = serde_json::to_vec_pretty(&value)
            .map_err(|error| format!("serialize Vault registry: {error}"))?;
        OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .and_then(|mut file| {
                file.write_all(&bytes)?;
                file.write_all(b"\n")?;
                file.sync_all()
            })
            .map_err(|error| format!("write Vault registry {}: {error}", temporary.display()))?;
        let result = replace_file(&temporary, &path);
        if result.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        result
    }

    fn mutate<T>(
        &self,
        change: impl FnOnce(&mut Vec<VaultRegistryEntry>) -> Result<T, String>,
    ) -> Result<T, String> {
        let lock = self.acquire_lock()?;
        let mut entries = self.read()?;
        let result = change(&mut entries)?;
        self.write(&entries, &lock)?;
        Ok(result)
    }

    pub fn list(&self, current: Option<String>) -> Result<VaultListResponse, String> {
        let mut vaults = vec![VaultListItem {
            slug: None,
            name: Some("Main".into()),
            root: Some(self.main_home.display().to_string()),
            requires_repair: false,
            created_at: None,
            autostart: false,
            last_opened_at: None,
        }];
        vaults.extend(self.read()?.into_iter().map(|entry| VaultListItem {
            slug: Some(entry.slug),
            name: entry.name,
            root: entry.root,
            requires_repair: entry.requires_repair,
            created_at: Some(entry.created_at),
            autostart: entry.autostart,
            last_opened_at: entry.last_opened_at,
        }));
        Ok(VaultListResponse { current, vaults })
    }

    pub fn resolve(&self, slug: &str) -> Result<PathBuf, String> {
        let slug = normalize_vault_slug(Some(slug))?
            .ok_or_else(|| "the implicit Main Vault has no registry row".to_string())?;
        let entry = self
            .read()?
            .into_iter()
            .find(|entry| entry.slug == slug)
            .ok_or_else(|| {
                format!("Vault \"{slug}\" is not registered; register it in Modus first")
            })?;
        if entry.requires_repair || entry.root.is_none() {
            return Err(format!(
                "Vault \"{slug}\" has a legacy registration; choose a folder in Modus to repair it"
            ));
        }
        let root = PathBuf::from(entry.root.expect("checked above"));
        self.validate_manifest(&root, &slug)?;
        Ok(root)
    }

    pub fn autostart(&self) -> Result<Vec<(String, PathBuf)>, String> {
        let mut result = Vec::new();
        for entry in self.read()? {
            if entry.autostart && !entry.requires_repair {
                let root = PathBuf::from(entry.root.expect("rooted entry"));
                self.validate_manifest(&root, &entry.slug)?;
                result.push((entry.slug, root));
            }
        }
        Ok(result)
    }

    pub fn create(&self, request: VaultRegistrationRequest) -> Result<VaultRegistryEntry, String> {
        self.claim(request, false)
    }

    pub fn repair(&self, request: VaultRegistrationRequest) -> Result<VaultRegistryEntry, String> {
        self.claim(request, true)
    }

    fn claim(
        &self,
        request: VaultRegistrationRequest,
        repair: bool,
    ) -> Result<VaultRegistryEntry, String> {
        let slug = normalize_vault_slug(Some(&request.slug))?
            .ok_or_else(|| format!("Invalid or reserved Vault slug \"{}\"", request.slug))?;
        let root = canonical_vault_root(Path::new(&request.root))?;
        self.assert_outside_main(&root)?;
        self.mutate(|entries| {
            let index = entries.iter().position(|entry| entry.slug == slug);
            if repair {
                let current = index.ok_or_else(|| format!("Vault \"{slug}\" not found"))?;
                if !entries[current].requires_repair {
                    return Err(format!("Vault \"{slug}\" already exists"));
                }
            } else if index.is_some() {
                return Err(format!("Vault \"{slug}\" already exists"));
            }
            let key = path_key(&root);
            if let Some(existing) = entries.iter().find(|entry| {
                entry.slug != slug
                    && entry
                        .root
                        .as_deref()
                        .is_some_and(|candidate| path_key(Path::new(candidate)) == key)
            }) {
                return Err(format!(
                    "Vault root is already registered to \"{}\"",
                    existing.slug
                ));
            }
            let manifest = self.prepare_root(&root, &slug, request.mode)?;
            let current = index.map(|index| entries[index].clone());
            let entry = VaultRegistryEntry {
                slug,
                name: request
                    .name
                    .or_else(|| current.as_ref().and_then(|entry| entry.name.clone())),
                root: Some(root.display().to_string()),
                requires_repair: false,
                created_at: current
                    .as_ref()
                    .map_or(manifest.created_at, |entry| entry.created_at),
                autostart: false,
                last_opened_at: current.and_then(|entry| entry.last_opened_at),
            };
            if let Some(index) = index {
                entries[index] = entry.clone();
            } else {
                entries.push(entry.clone());
            }
            Ok(entry)
        })
    }

    pub fn update(
        &self,
        slug: &str,
        request: VaultUpdateRequest,
    ) -> Result<VaultRegistryEntry, String> {
        let slug = normalize_vault_slug(Some(slug))?
            .ok_or_else(|| format!("Invalid or reserved Vault slug \"{slug}\""))?;
        self.mutate(|entries| {
            let entry = entries
                .iter_mut()
                .find(|entry| entry.slug == slug)
                .ok_or_else(|| format!("Vault \"{slug}\" not found"))?;
            if entry.requires_repair && request.autostart == Some(true) {
                return Err(format!(
                    "Vault \"{slug}\" must be repaired before autostart can be enabled"
                ));
            }
            if let Some(name) = request.name {
                entry.name = Some(name);
            }
            if let Some(autostart) = request.autostart {
                entry.autostart = autostart;
            }
            Ok(entry.clone())
        })
    }

    pub fn policy(&self, slug: Option<&str>) -> Result<VaultPolicy, String> {
        let (path, fallback) = match normalize_vault_slug(slug)? {
            None => (self.main_home.join("vault.json"), allow_all_policy()),
            Some(slug) => (self.resolve(&slug)?.join("vault.json"), deny_all_policy()),
        };
        if !path.exists() {
            return Ok(fallback);
        }
        let bytes = fs::read(&path)
            .map_err(|error| format!("read Vault policy {}: {error}", path.display()))?;
        Ok(serde_json::from_slice(&bytes).unwrap_or_else(|_| deny_all_policy()))
    }

    fn prepare_root(
        &self,
        root: &Path,
        slug: &str,
        mode: VaultRootMode,
    ) -> Result<VaultManifest, String> {
        match mode {
            VaultRootMode::Register => self.validate_manifest(root, slug),
            VaultRootMode::Initialize => {
                if root.exists() {
                    if !root.is_dir() {
                        return Err("Vault root must be a directory".into());
                    }
                    if fs::read_dir(root)
                        .map_err(|error| format!("read Vault folder {}: {error}", root.display()))?
                        .next()
                        .is_some()
                    {
                        return Err(
                            "Choose an empty folder, or register an existing marked Vault".into(),
                        );
                    }
                } else {
                    fs::create_dir_all(root).map_err(|error| {
                        format!("create Vault folder {}: {error}", root.display())
                    })?;
                }
                let manifest = VaultManifest {
                    version: MANIFEST_VERSION,
                    slug: slug.into(),
                    created_at: now_ms(),
                };
                write_new_json(&root.join(MANIFEST_FILE), &manifest)?;
                write_json(&root.join("vault.json"), &deny_all_policy())?;
                Ok(manifest)
            }
        }
    }

    fn validate_manifest(&self, root: &Path, slug: &str) -> Result<VaultManifest, String> {
        if !root.is_dir() {
            return Err(format!(
                "Existing Vault folder does not exist or is not a directory: {}",
                root.display()
            ));
        }
        let path = root.join(MANIFEST_FILE);
        let bytes = fs::read(&path)
            .map_err(|_| format!("Folder is not a marked Vault: {}", path.display()))?;
        let mut manifest: VaultManifest = serde_json::from_slice(&bytes)
            .map_err(|_| format!("Invalid Vault manifest: {}", path.display()))?;
        let manifest_slug = normalize_vault_slug(Some(&manifest.slug))?
            .ok_or_else(|| format!("Invalid Vault manifest: {}", path.display()))?;
        if manifest.version != MANIFEST_VERSION {
            return Err(format!(
                "Invalid or unsupported Vault manifest: {}",
                path.display()
            ));
        }
        if manifest_slug != slug {
            return Err(format!(
                "Vault manifest belongs to \"{manifest_slug}\", not \"{slug}\""
            ));
        }
        manifest.slug = manifest_slug;
        Ok(manifest)
    }
}

fn deny_all_policy() -> VaultPolicy {
    VaultPolicy {
        plugins: VaultPolicyRule::Deny { allow: Vec::new() },
        project_automation: VaultPolicyRule::Deny { allow: Vec::new() },
        channels: VaultPolicyRule::Deny { allow: Vec::new() },
    }
}

fn allow_all_policy() -> VaultPolicy {
    VaultPolicy {
        plugins: VaultPolicyRule::AllowAll,
        project_automation: VaultPolicyRule::AllowAll,
        channels: VaultPolicyRule::AllowAll,
    }
}

fn write_new_json(path: &Path, value: &impl Serialize) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(value).map_err(|error| error.to_string())?;
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .and_then(|mut file| {
            file.write_all(&bytes)?;
            file.write_all(b"\n")
        })
        .map_err(|error| format!("write {}: {error}", path.display()))
}

fn write_json(path: &Path, value: &impl Serialize) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(value).map_err(|error| error.to_string())?;
    fs::write(path, [bytes, b"\n".to_vec()].concat())
        .map_err(|error| format!("write {}: {error}", path.display()))
}

#[cfg(windows)]
fn replace_file(source: &Path, destination: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };
    let source_wide: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination_wide: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    let result = unsafe {
        MoveFileExW(
            source_wide.as_ptr(),
            destination_wide.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if result == 0 {
        Err(format!(
            "publish Vault registry {}: {}",
            destination.display(),
            std::io::Error::last_os_error()
        ))
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn replace_file(source: &Path, destination: &Path) -> Result<(), String> {
    fs::rename(source, destination)
        .map_err(|error| format!("publish Vault registry {}: {error}", destination.display()))
}

#[cfg(windows)]
fn process_is_alive(pid: u32) -> bool {
    use windows_sys::Win32::{
        Foundation::{CloseHandle, WAIT_TIMEOUT},
        Storage::FileSystem::SYNCHRONIZE,
        System::Threading::{OpenProcess, WaitForSingleObject},
    };
    let handle = unsafe { OpenProcess(SYNCHRONIZE, 0, pid) };
    if handle.is_null() {
        return std::io::Error::last_os_error().raw_os_error() == Some(5);
    }
    let status = unsafe { WaitForSingleObject(handle, 0) };
    unsafe { CloseHandle(handle) };
    status == WAIT_TIMEOUT
}

#[cfg(not(windows))]
fn process_is_alive(pid: u32) -> bool {
    unsafe extern "C" {
        fn kill(pid: i32, signal: i32) -> i32;
    }
    let result = unsafe { kill(pid as i32, 0) };
    result == 0 || std::io::Error::last_os_error().raw_os_error() == Some(1)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (PathBuf, VaultRegistry) {
        let root = std::env::temp_dir().join(format!("modus-vaults-test-{}", Uuid::new_v4()));
        let registry = VaultRegistry::new(root.join("main")).unwrap();
        (root, registry)
    }

    fn request(root: &Path, slug: &str, mode: VaultRootMode) -> VaultRegistrationRequest {
        VaultRegistrationRequest {
            slug: slug.into(),
            root: root.display().to_string(),
            name: None,
            mode,
        }
    }

    #[test]
    fn initializes_and_reattaches_a_marked_folder() {
        let (fixture, registry) = fixture();
        let root = fixture.join("vaults").join("private");
        fs::create_dir_all(&root).unwrap();
        let created = registry
            .create(request(&root, "Private", VaultRootMode::Initialize))
            .unwrap();
        assert_eq!(created.slug, "private");
        assert_eq!(
            created.root.as_deref(),
            Some(
                canonical_vault_root(&root)
                    .unwrap()
                    .to_string_lossy()
                    .as_ref()
            )
        );
        assert_eq!(registry.policy(Some("private")).unwrap(), deny_all_policy());

        registry
            .mutate(|entries| {
                entries.clear();
                Ok(())
            })
            .unwrap();
        fs::write(root.join("keep.txt"), "keep").unwrap();
        let registered = registry
            .create(request(&root, "private", VaultRootMode::Register))
            .unwrap();
        assert_eq!(registered.created_at, created.created_at);
        assert_eq!(fs::read_to_string(root.join("keep.txt")).unwrap(), "keep");
        fs::remove_dir_all(fixture).unwrap();
    }

    #[test]
    fn preserves_legacy_rows_but_never_autostarts_them() {
        let (fixture, registry) = fixture();
        fs::write(
            registry.path(),
            r#"{"vaults":[{"slug":"Private","createdAt":1,"autostart":true}]}"#,
        )
        .unwrap();
        let entries = registry.read().unwrap();
        assert!(entries[0].requires_repair);
        assert!(!entries[0].autostart);
        assert!(registry.autostart().unwrap().is_empty());
        assert!(registry.resolve("private").unwrap_err().contains("repair"));
        fs::remove_dir_all(fixture).unwrap();
    }

    #[test]
    fn parses_the_shared_rooted_schema_and_rejects_corrupt_registry_roots() {
        let (fixture, registry) = fixture();
        let root = fixture.join("vaults").join("portable");
        fs::create_dir_all(&root).unwrap();
        write_json(
            &root.join(MANIFEST_FILE),
            &VaultManifest {
                version: MANIFEST_VERSION,
                slug: "portable".into(),
                created_at: 42,
            },
        )
        .unwrap();
        fs::write(
            registry.path(),
            format!(
                "{{\"vaults\":[{{\"slug\":\"Portable\",\"name\":\"Portable\",\"root\":{},\"createdAt\":42,\"autostart\":true}}]}}",
                serde_json::to_string(&root.display().to_string()).unwrap()
            ),
        )
        .unwrap();
        assert_eq!(
            registry.resolve("portable").unwrap(),
            canonical_vault_root(&root).unwrap()
        );
        assert_eq!(registry.autostart().unwrap().len(), 1);

        let duplicate = root.join("missing").join("..");
        fs::write(
            registry.path(),
            format!(
                "{{\"vaults\":[{{\"slug\":\"one\",\"root\":{},\"createdAt\":1}},{{\"slug\":\"two\",\"root\":{},\"createdAt\":2}}]}}",
                serde_json::to_string(&root.display().to_string()).unwrap(),
                serde_json::to_string(&duplicate.display().to_string()).unwrap()
            ),
        )
        .unwrap();
        assert!(registry.read().unwrap_err().contains("duplicate canonical"));

        fs::write(
            registry.path(),
            r#"{"vaults":[{"slug":"relative","root":"relative/path","createdAt":1}]}"#,
        )
        .unwrap();
        assert!(registry.read().unwrap_err().contains("absolute path"));
        fs::remove_dir_all(fixture).unwrap();
    }

    #[test]
    fn rejects_inside_main_duplicate_and_unmarked_roots() {
        let (fixture, registry) = fixture();
        let inside = registry.main_home().join("private");
        fs::create_dir_all(&inside).unwrap();
        assert!(registry
            .create(request(&inside, "private", VaultRootMode::Initialize))
            .unwrap_err()
            .contains("outside Main"));
        let disguised_inside = registry
            .main_home()
            .join("missing")
            .join("..")
            .join("also-private");
        assert!(registry
            .create(request(
                &disguised_inside,
                "also-private",
                VaultRootMode::Initialize
            ))
            .unwrap_err()
            .contains("outside Main"));

        let root = fixture.join("vaults").join("one");
        fs::create_dir_all(&root).unwrap();
        registry
            .create(request(&root, "one", VaultRootMode::Initialize))
            .unwrap();
        assert!(registry
            .create(request(&root, "two", VaultRootMode::Register))
            .unwrap_err()
            .contains("already registered"));

        let unmarked = fixture.join("vaults").join("unmarked");
        fs::create_dir_all(&unmarked).unwrap();
        fs::write(unmarked.join("notes.txt"), "not a Vault").unwrap();
        assert!(registry
            .create(request(&unmarked, "unmarked", VaultRootMode::Initialize))
            .unwrap_err()
            .contains("empty folder"));
        fs::remove_dir_all(fixture).unwrap();
    }

    #[test]
    fn repairs_a_legacy_row_without_touching_the_old_nested_folder() {
        let (fixture, registry) = fixture();
        let sentinel = registry.main_home().join("private").join("keep.txt");
        fs::create_dir_all(sentinel.parent().unwrap()).unwrap();
        fs::write(&sentinel, "keep").unwrap();
        fs::write(
            registry.path(),
            r#"{"vaults":[{"slug":"private","name":"Old","createdAt":1,"autostart":true}]}"#,
        )
        .unwrap();
        let root = fixture.join("vaults").join("repaired");
        fs::create_dir_all(&root).unwrap();
        let repaired = registry
            .repair(request(&root, "private", VaultRootMode::Initialize))
            .unwrap();
        assert_eq!(repaired.created_at, 1);
        assert!(!repaired.autostart);
        assert_eq!(fs::read_to_string(sentinel).unwrap(), "keep");
        fs::remove_dir_all(fixture).unwrap();
    }
}
