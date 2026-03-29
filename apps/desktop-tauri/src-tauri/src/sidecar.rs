use std::{
    collections::HashMap,
    fs::{self, OpenOptions},
    net::TcpListener,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Mutex,
    },
    thread,
    time::Duration,
};

use tauri::{AppHandle, Manager};
use uuid::Uuid;

#[derive(Clone)]
pub struct DesktopRuntimeState {
    inner: Arc<InnerState>,
}

struct InnerState {
    ws_url: String,
    launch_spec: LaunchSpec,
    child: Mutex<Option<Child>>,
    shutting_down: AtomicBool,
    restart_attempt: AtomicUsize,
}

struct LaunchSpec {
    executable: PathBuf,
    args: Vec<String>,
    cwd: PathBuf,
    env_overrides: HashMap<String, String>,
    log_dir: PathBuf,
}

impl DesktopRuntimeState {
    pub fn initialize(app: &AppHandle) -> Result<Self, String> {
        let listener =
            TcpListener::bind("127.0.0.1:0").map_err(|error| format!("bind port: {error}"))?;
        let port = listener
            .local_addr()
            .map_err(|error| format!("resolve port: {error}"))?
            .port();
        drop(listener);

        let auth_token = Uuid::new_v4().simple().to_string();
        let ws_url = format!("ws://127.0.0.1:{port}/?token={auth_token}");

        let app_local_data_dir = app
            .path()
            .app_local_data_dir()
            .map_err(|error| format!("resolve app data dir: {error}"))?
            .join("server-home");
        let log_dir = app_local_data_dir.join("logs");
        fs::create_dir_all(&log_dir).map_err(|error| format!("create log dir: {error}"))?;

        let launch_spec = build_launch_spec(app, port, &auth_token, app_local_data_dir, log_dir)?;
        let state = Self {
            inner: Arc::new(InnerState {
                ws_url,
                launch_spec,
                child: Mutex::new(None),
                shutting_down: AtomicBool::new(false),
                restart_attempt: AtomicUsize::new(0),
            }),
        };

        state.spawn_child()?;
        state.spawn_monitor_thread();
        Ok(state)
    }

    pub fn ws_url(&self) -> String {
        self.inner.ws_url.clone()
    }

    pub fn shutdown(&self) {
        self.inner.shutting_down.store(true, Ordering::SeqCst);
        if let Ok(mut guard) = self.inner.child.lock() {
            if let Some(mut child) = guard.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }

    fn spawn_monitor_thread(&self) {
        let state = self.clone();
        thread::spawn(move || loop {
            if state.inner.shutting_down.load(Ordering::SeqCst) {
                break;
            }

            let exited = {
                let mut child_guard = match state.inner.child.lock() {
                    Ok(guard) => guard,
                    Err(_) => break,
                };

                match child_guard.as_mut() {
                    Some(child) => match child.try_wait() {
                        Ok(Some(_)) => {
                            child_guard.take();
                            true
                        }
                        Ok(None) => false,
                        Err(_) => {
                            child_guard.take();
                            true
                        }
                    },
                    None => false,
                }
            };

            if exited && !state.inner.shutting_down.load(Ordering::SeqCst) {
                let attempt = state.inner.restart_attempt.fetch_add(1, Ordering::SeqCst);
                let delay_ms = (500u64.saturating_mul(1u64 << attempt.min(4))).min(10_000);
                thread::sleep(Duration::from_millis(delay_ms));

                if state.inner.shutting_down.load(Ordering::SeqCst) {
                    break;
                }

                let _ = state.spawn_child();
            } else {
                thread::sleep(Duration::from_millis(500));
            }
        });
    }

    fn spawn_child(&self) -> Result<(), String> {
        let stdout_path = self.inner.launch_spec.log_dir.join("server-sidecar.stdout.log");
        let stderr_path = self.inner.launch_spec.log_dir.join("server-sidecar.stderr.log");

        let stdout = OpenOptions::new()
            .create(true)
            .append(true)
            .open(stdout_path)
            .map_err(|error| format!("open sidecar stdout log: {error}"))?;
        let stderr = OpenOptions::new()
            .create(true)
            .append(true)
            .open(stderr_path)
            .map_err(|error| format!("open sidecar stderr log: {error}"))?;

        let mut command = Command::new(&self.inner.launch_spec.executable);
        command
            .args(&self.inner.launch_spec.args)
            .current_dir(&self.inner.launch_spec.cwd)
            .stdin(Stdio::null())
            .stdout(Stdio::from(stdout))
            .stderr(Stdio::from(stderr));

        for (key, value) in &self.inner.launch_spec.env_overrides {
            command.env(key, value);
        }

        let child = command
            .spawn()
            .map_err(|error| format!("spawn node sidecar: {error}"))?;

        self.inner.restart_attempt.store(0, Ordering::SeqCst);

        let mut child_guard = self
            .inner
            .child
            .lock()
            .map_err(|_| "lock sidecar child".to_string())?;
        *child_guard = Some(child);

        Ok(())
    }
}

fn build_launch_spec(
    app: &AppHandle,
    port: u16,
    auth_token: &str,
    app_local_data_dir: PathBuf,
    log_dir: PathBuf,
) -> Result<LaunchSpec, String> {
    let mut env_overrides = HashMap::new();
    env_overrides.insert("T3CODE_MODE".to_string(), "desktop".to_string());
    env_overrides.insert("T3CODE_NO_BROWSER".to_string(), "1".to_string());
    env_overrides.insert("T3CODE_HOST".to_string(), "127.0.0.1".to_string());
    env_overrides.insert("T3CODE_PORT".to_string(), port.to_string());
    env_overrides.insert("T3CODE_AUTH_TOKEN".to_string(), auth_token.to_string());
    env_overrides.insert(
        "T3CODE_HOME".to_string(),
        app_local_data_dir.to_string_lossy().to_string(),
    );
    env_overrides.insert("T3CODE_LOG_WS_EVENTS".to_string(), "0".to_string());

    if cfg!(debug_assertions) {
        let repo_root = repo_root()?;
        let server_entry = repo_root.join("apps/server/dist/index.mjs");
        if !server_entry.exists() {
            return Err(format!(
                "server entry missing at {}. Run `bun run --cwd apps/server build` first.",
                server_entry.display()
            ));
        }

        return Ok(LaunchSpec {
            executable: PathBuf::from("node"),
            args: vec![server_entry.to_string_lossy().to_string()],
            cwd: repo_root,
            env_overrides,
            log_dir,
        });
    }

    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|error| format!("resolve resource dir: {error}"))?;
    let node_path = resource_dir.join("node-runtime/bin/node");
    let launcher_path = resource_dir.join("server-runtime/server-launcher.mjs");
    let cwd = resource_dir.join("server-runtime");

    if !node_path.exists() {
        return Err(format!("packaged Node runtime missing at {}", node_path.display()));
    }
    if !launcher_path.exists() {
        return Err(format!(
            "packaged server launcher missing at {}",
            launcher_path.display()
        ));
    }

    Ok(LaunchSpec {
        executable: node_path,
        args: vec![launcher_path.to_string_lossy().to_string()],
        cwd,
        env_overrides,
        log_dir,
    })
}

fn repo_root() -> Result<PathBuf, String> {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    manifest_dir
        .parent()
        .and_then(Path::parent)
        .and_then(Path::parent)
        .map(Path::to_path_buf)
        .ok_or_else(|| "resolve repository root".to_string())
}
