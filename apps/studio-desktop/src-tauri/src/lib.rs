//! KP Studio desktop (phase 3, WP5): a Tauri 2 window over the KP Studio web build, with
//! the KernelPAI kernel server (`kpai studio`) started as a sidecar process.
//!
//! The shell never talks to the kernel itself. It starts `kpai studio --port 0`, reads the
//! one line the server prints (`KP Studio: http://127.0.0.1:PORT/#token=…`), and hands the
//! WebSocket URL and token to the web build through the URL fragment, exactly like a
//! browser tab opened from the terminal. The server keeps every rule (loopback only, token,
//! Origin allow-list, confirmations). The sidecar is killed when the window closes.

mod sidecar;

use std::sync::Mutex;
use tauri::{Manager, RunEvent};

struct Kernel(Mutex<Option<std::process::Child>>);

pub fn run() {
    let app = tauri::Builder::default()
        .manage(Kernel(Mutex::new(None)))
        .setup(|app| {
            let handle = app.handle().clone();
            std::thread::spawn(move || sidecar::start(handle));
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("KP Studio desktop could not start");
    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            if let Some(mut child) = handle.state::<Kernel>().0.lock().unwrap().take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    });
}

pub(crate) fn keep_child(handle: &tauri::AppHandle, child: std::process::Child) {
    *handle.state::<Kernel>().0.lock().unwrap() = Some(child);
}
