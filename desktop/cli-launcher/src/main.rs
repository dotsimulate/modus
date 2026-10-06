use std::{
    env,
    ffi::{OsStr, OsString},
    path::{Path, PathBuf},
    process::{self, Command, Stdio},
};

const INSTALL_USER_PATH_FLAG: &str = "--modus-installer-add-user-path";
const UNINSTALL_USER_PATH_FLAG: &str = "--modus-installer-remove-user-path";

struct InstalledLayout {
    bun: PathBuf,
    cli: PathBuf,
    server: PathBuf,
    resources: PathBuf,
}

fn installed_layout(executable: &Path) -> Result<InstalledLayout, String> {
    let install_dir = executable.parent().ok_or_else(|| {
        format!(
            "cannot resolve installation directory from {}",
            executable.display()
        )
    })?;
    let resources = install_dir.join("modus");
    Ok(InstalledLayout {
        bun: install_dir.join(if cfg!(windows) { "bun.exe" } else { "bun" }),
        cli: resources.join("cli.js"),
        server: resources.join("server.js"),
        resources,
    })
}

fn validate_layout(layout: &InstalledLayout) -> Result<(), String> {
    for (label, path) in [
        ("packaged Bun runtime", &layout.bun),
        ("Modus CLI", &layout.cli),
        ("Modus backend", &layout.server),
    ] {
        if !path.is_file() {
            return Err(format!("{label} is missing: {}", path.display()));
        }
    }

    Ok(())
}

fn normalized_path_entry(entry: &[u16]) -> String {
    String::from_utf16_lossy(entry)
        .trim()
        .trim_matches('"')
        .trim_end_matches(['\\', '/'])
        .to_lowercase()
}

fn add_install_dir_to_path(current: &[u16], install_dir: &[u16]) -> Option<Vec<u16>> {
    let expected = normalized_path_entry(install_dir);
    if current
        .split(|character| *character == b';' as u16)
        .any(|entry| normalized_path_entry(entry) == expected)
    {
        return None;
    }

    let mut updated = Vec::with_capacity(current.len() + install_dir.len() + 1);
    updated.extend_from_slice(install_dir);
    if !current.is_empty() {
        updated.push(b';' as u16);
        updated.extend_from_slice(current);
    }
    Some(updated)
}

fn remove_install_dir_from_path(current: &[u16], install_dir: &[u16]) -> Option<Vec<u16>> {
    let expected = normalized_path_entry(install_dir);
    let entries = current
        .split(|character| *character == b';' as u16)
        .collect::<Vec<_>>();
    let retained = entries
        .iter()
        .copied()
        .filter(|entry| normalized_path_entry(entry) != expected)
        .collect::<Vec<_>>();
    if retained.len() == entries.len() {
        return None;
    }

    let retained_bytes = retained.iter().map(|entry| entry.len()).sum::<usize>();
    let mut updated = Vec::with_capacity(retained_bytes + retained.len().saturating_sub(1));
    for (index, entry) in retained.into_iter().enumerate() {
        if index > 0 {
            updated.push(b';' as u16);
        }
        updated.extend_from_slice(entry);
    }
    Some(updated)
}

#[cfg(windows)]
mod user_path {
    use super::{add_install_dir_to_path, remove_install_dir_from_path};
    use std::{ffi::OsStr, os::windows::ffi::OsStrExt, path::Path, ptr};
    use windows_sys::Win32::{
        Foundation::{ERROR_FILE_NOT_FOUND, ERROR_MORE_DATA, ERROR_SUCCESS},
        System::Registry::{
            RegGetValueW, RegSetKeyValueW, HKEY_CURRENT_USER, REG_EXPAND_SZ, REG_SZ,
            RRF_RT_REG_EXPAND_SZ, RRF_RT_REG_SZ,
        },
        UI::WindowsAndMessaging::{
            SendMessageTimeoutW, HWND_BROADCAST, SMTO_ABORTIFHUNG, WM_SETTINGCHANGE,
        },
    };

    const ENVIRONMENT_KEY: &str = "Environment";
    const PATH_VALUE: &str = "Path";

    fn wide_null(value: &OsStr) -> Vec<u16> {
        value.encode_wide().chain(Some(0)).collect()
    }

    fn read() -> Result<(Vec<u16>, u32), String> {
        let key = wide_null(OsStr::new(ENVIRONMENT_KEY));
        let value = wide_null(OsStr::new(PATH_VALUE));
        let flags = RRF_RT_REG_SZ | RRF_RT_REG_EXPAND_SZ;
        let mut value_type = 0;
        let mut bytes = 0;
        let size_result = unsafe {
            RegGetValueW(
                HKEY_CURRENT_USER,
                key.as_ptr(),
                value.as_ptr(),
                flags,
                &mut value_type,
                ptr::null_mut(),
                &mut bytes,
            )
        };
        if size_result == ERROR_FILE_NOT_FOUND {
            return Ok((Vec::new(), REG_EXPAND_SZ));
        }
        if size_result != ERROR_SUCCESS && size_result != ERROR_MORE_DATA {
            return Err(format!(
                "cannot read the user PATH size (Windows error {size_result})"
            ));
        }

        loop {
            let mut contents = vec![0u16; (bytes as usize).div_ceil(2).max(1)];
            let mut requested_bytes = bytes;
            let result = unsafe {
                RegGetValueW(
                    HKEY_CURRENT_USER,
                    key.as_ptr(),
                    value.as_ptr(),
                    flags,
                    &mut value_type,
                    contents.as_mut_ptr().cast(),
                    &mut requested_bytes,
                )
            };
            if result == ERROR_MORE_DATA {
                bytes = requested_bytes;
                continue;
            }
            if result != ERROR_SUCCESS {
                return Err(format!(
                    "cannot read the user PATH (Windows error {result})"
                ));
            }
            let units = requested_bytes as usize / 2;
            contents.truncate(units);
            while contents.last() == Some(&0) {
                contents.pop();
            }
            return Ok((contents, value_type));
        }
    }

    fn write(contents: &[u16], value_type: u32) -> Result<(), String> {
        let key = wide_null(OsStr::new(ENVIRONMENT_KEY));
        let value = wide_null(OsStr::new(PATH_VALUE));
        let mut terminated = Vec::with_capacity(contents.len() + 1);
        terminated.extend_from_slice(contents);
        terminated.push(0);
        let result = unsafe {
            RegSetKeyValueW(
                HKEY_CURRENT_USER,
                key.as_ptr(),
                value.as_ptr(),
                if value_type == REG_SZ {
                    REG_SZ
                } else {
                    REG_EXPAND_SZ
                },
                terminated.as_ptr().cast(),
                (terminated.len() * size_of::<u16>()) as u32,
            )
        };
        if result != ERROR_SUCCESS {
            return Err(format!(
                "cannot write the user PATH (Windows error {result})"
            ));
        }

        let environment = wide_null(OsStr::new(ENVIRONMENT_KEY));
        let mut message_result = 0;
        unsafe {
            SendMessageTimeoutW(
                HWND_BROADCAST,
                WM_SETTINGCHANGE,
                0,
                environment.as_ptr() as isize,
                SMTO_ABORTIFHUNG,
                5_000,
                &mut message_result,
            );
        }
        Ok(())
    }

    pub fn add(install_dir: &Path) -> Result<(), String> {
        let install_dir = install_dir.as_os_str().encode_wide().collect::<Vec<_>>();
        let (current, value_type) = read()?;
        if let Some(updated) = add_install_dir_to_path(&current, &install_dir) {
            write(&updated, value_type)?;
        }
        Ok(())
    }

    pub fn remove(install_dir: &Path) -> Result<(), String> {
        let install_dir = install_dir.as_os_str().encode_wide().collect::<Vec<_>>();
        let (current, value_type) = read()?;
        if let Some(updated) = remove_install_dir_from_path(&current, &install_dir) {
            write(&updated, value_type)?;
        }
        Ok(())
    }
}

#[cfg(windows)]
fn run_installer_path_command(command: &OsStr, executable: &Path) -> Option<Result<(), String>> {
    let install_dir = match executable.parent() {
        Some(path) => path,
        None => {
            return Some(Err(
                "cannot resolve the Modus installation directory".to_string()
            ))
        }
    };
    if command == OsStr::new(INSTALL_USER_PATH_FLAG) {
        return Some(user_path::add(install_dir));
    }
    if command == OsStr::new(UNINSTALL_USER_PATH_FLAG) {
        return Some(user_path::remove(install_dir));
    }
    None
}

#[cfg(not(windows))]
fn run_installer_path_command(_command: &OsStr, _executable: &Path) -> Option<Result<(), String>> {
    None
}

fn run(arguments: impl Iterator<Item = OsString>) -> Result<i32, String> {
    let executable = env::current_exe()
        .map_err(|error| format!("cannot resolve the installed Modus CLI: {error}"))?;
    let layout = installed_layout(&executable)?;
    validate_layout(&layout)?;
    // The install ships no node_modules; without this Bun fetches any
    // unresolved import from npm at runtime.
    let status = Command::new(&layout.bun)
        .arg("run")
        .arg("--no-install")
        .arg(&layout.cli)
        .args(arguments)
        .env("MODUS_PACKAGED_CLI", "1")
        .env("MODUS_CLI_SERVER", &layout.server)
        .env("MODUS_RESOURCES_DIR", &layout.resources)
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .status()
        .map_err(|error| format!("cannot start the packaged Modus CLI: {error}"))?;

    Ok(status.code().unwrap_or(1))
}

fn main() {
    let executable = match env::current_exe() {
        Ok(path) => path,
        Err(error) => {
            eprintln!("Modus CLI installation error: cannot resolve executable: {error}");
            process::exit(1);
        }
    };
    let mut arguments = env::args_os().skip(1);
    let first = arguments.next();
    if let Some(result) = first
        .as_deref()
        .and_then(|command| run_installer_path_command(command, &executable))
    {
        if let Err(error) = result {
            eprintln!("Modus CLI installer error: {error}");
            process::exit(1);
        }
        process::exit(0);
    }

    let forwarded = first.into_iter().chain(arguments);
    match run(forwarded) {
        Ok(code) => process::exit(code),
        Err(error) => {
            eprintln!("Modus CLI installation error: {error}");
            eprintln!("Repair or reinstall Modus.");
            process::exit(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{add_install_dir_to_path, installed_layout, remove_install_dir_from_path};
    use std::path::{Path, PathBuf};

    #[test]
    fn resolves_every_runtime_file_relative_to_the_launcher() {
        let install_dir = PathBuf::from("install-root");
        let layout = installed_layout(&install_dir.join("modus.exe")).expect("resolve layout");
        assert_eq!(
            layout.bun,
            install_dir.join(if cfg!(windows) { "bun.exe" } else { "bun" })
        );
        assert_eq!(layout.cli, install_dir.join(Path::new("modus/cli.js")));
        assert_eq!(
            layout.server,
            install_dir.join(Path::new("modus/server.js"))
        );
        assert_eq!(layout.resources, install_dir.join("modus"));
    }

    #[test]
    fn path_update_preserves_values_longer_than_the_nsis_string_limit() {
        let current = (0..180)
            .map(|index| format!(r"C:\Tools\Package-{index:03}"))
            .collect::<Vec<_>>()
            .join(";");
        assert!(current.len() > 1_024);
        let install = r"C:\Users\tester\AppData\Local\Modus";
        let updated = add_install_dir_to_path(
            &current.encode_utf16().collect::<Vec<_>>(),
            &install.encode_utf16().collect::<Vec<_>>(),
        )
        .expect("add install directory");
        let updated = String::from_utf16(&updated).expect("valid UTF-16");
        assert_eq!(updated, format!("{install};{current}"));
    }

    #[test]
    fn path_removal_is_case_insensitive_exact_and_preserves_other_entries() {
        let current = r"C:\Tools\Modus-Helper;C:\MODUS\;C:\Tools\Other;;";
        let install = r"c:\modus";
        let updated = remove_install_dir_from_path(
            &current.encode_utf16().collect::<Vec<_>>(),
            &install.encode_utf16().collect::<Vec<_>>(),
        )
        .expect("remove install directory");
        assert_eq!(
            String::from_utf16(&updated).expect("valid UTF-16"),
            r"C:\Tools\Modus-Helper;C:\Tools\Other;;",
        );
    }
}
