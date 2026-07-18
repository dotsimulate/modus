#[cfg(windows)]
mod platform {
    use std::{io, mem::size_of};

    use windows_sys::Win32::{
        Foundation::{CloseHandle, HANDLE},
        System::{
            JobObjects::{
                AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
                SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
                JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            },
            Threading::{
                OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SET_QUOTA,
                PROCESS_TERMINATE,
            },
        },
    };

    pub struct ProcessJob {
        handle: HANDLE,
    }

    unsafe impl Send for ProcessJob {}

    impl ProcessJob {
        pub fn new() -> io::Result<Self> {
            let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
            if handle.is_null() {
                return Err(io::Error::last_os_error());
            }

            let mut information: JOBOBJECT_EXTENDED_LIMIT_INFORMATION =
                unsafe { std::mem::zeroed() };
            information.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let configured = unsafe {
                SetInformationJobObject(
                    handle,
                    JobObjectExtendedLimitInformation,
                    &information as *const _ as *const _,
                    size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                )
            };
            if configured == 0 {
                let error = io::Error::last_os_error();
                unsafe { CloseHandle(handle) };
                return Err(error);
            }
            Ok(Self { handle })
        }

        pub fn assign(&self, pid: u32) -> io::Result<()> {
            let process = unsafe {
                OpenProcess(
                    PROCESS_SET_QUOTA | PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION,
                    0,
                    pid,
                )
            };
            if process.is_null() {
                return Err(io::Error::last_os_error());
            }
            let assigned = unsafe { AssignProcessToJobObject(self.handle, process) };
            let error = if assigned == 0 {
                Some(io::Error::last_os_error())
            } else {
                None
            };
            unsafe { CloseHandle(process) };
            match error {
                Some(error) => Err(error),
                None => Ok(()),
            }
        }

        pub fn terminate(&self, exit_code: u32) -> io::Result<()> {
            let terminated = unsafe { TerminateJobObject(self.handle, exit_code) };
            if terminated == 0 {
                Err(io::Error::last_os_error())
            } else {
                Ok(())
            }
        }
    }

    impl Drop for ProcessJob {
        fn drop(&mut self) {
            if !self.handle.is_null() {
                unsafe { CloseHandle(self.handle) };
                self.handle = std::ptr::null_mut();
            }
        }
    }
}

#[cfg(not(windows))]
mod platform {
    use std::io;

    pub struct ProcessJob;

    impl ProcessJob {
        pub fn new() -> io::Result<Self> {
            Ok(Self)
        }

        pub fn assign(&self, _pid: u32) -> io::Result<()> {
            Ok(())
        }

        pub fn terminate(&self, _exit_code: u32) -> io::Result<()> {
            Ok(())
        }
    }
}

pub use platform::ProcessJob;

#[cfg(all(test, windows))]
mod tests {
    use std::{
        fs,
        process::{Command, Stdio},
        thread,
        time::{Duration, Instant},
    };

    use windows_sys::Win32::{
        Foundation::{CloseHandle, STILL_ACTIVE},
        System::Threading::{GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION},
    };

    use super::ProcessJob;

    fn process_is_running(pid: u32) -> bool {
        let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
        if process.is_null() {
            return false;
        }
        let mut exit_code = 0u32;
        let ok = unsafe { GetExitCodeProcess(process, &mut exit_code) } != 0;
        unsafe { CloseHandle(process) };
        ok && exit_code == STILL_ACTIVE as u32
    }

    #[test]
    fn kill_on_close_job_terminates_inherited_descendants() {
        let marker = std::env::temp_dir().join(format!(
            "modus-job-descendant-{}.pid",
            uuid::Uuid::new_v4().simple()
        ));
        let escaped_marker = marker.to_string_lossy().replace("'", "''");
        let script = format!(
            "Start-Sleep -Milliseconds 500; \
             $child = Start-Process -FilePath $env:ComSpec -ArgumentList @('/d','/c','ping -n 120 127.0.0.1 >NUL') -WindowStyle Hidden -PassThru; \
             [System.IO.File]::WriteAllText('{escaped_marker}', [string]$child.Id); \
             Wait-Process -Id $child.Id"
        );
        let mut parent = Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn test process tree");
        let job = ProcessJob::new().expect("create test Job Object");
        job.assign(parent.id())
            .expect("assign test parent to Job Object");

        let deadline = Instant::now() + Duration::from_secs(10);
        while !marker.is_file() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(50));
        }
        let descendant_pid: u32 = fs::read_to_string(&marker)
            .expect("descendant marker")
            .trim()
            .parse()
            .expect("descendant PID");
        assert!(process_is_running(parent.id()));
        assert!(process_is_running(descendant_pid));

        job.terminate(77).expect("terminate test Job Object");
        let _ = parent.wait();
        let deadline = Instant::now() + Duration::from_secs(5);
        while process_is_running(descendant_pid) && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(50));
        }
        assert!(!process_is_running(descendant_pid));
        let _ = fs::remove_file(marker);
    }
}
