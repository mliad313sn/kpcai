//! Starts `kpai studio` and points the window at it.
//!
//! Which program runs: `KPAI_BIN` if set (a path to `kpai`, or to `apps/cli/dist/bin.js`,
//! run with `node`), otherwise `kpai` from PATH. Packaging a Node runtime with the app is
//! phase 6 (installers); signing is reserved to the Sponsor.

use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};
use tauri::{AppHandle, Manager};

/// Origins of the Tauri webview (macOS/Linux, then Windows), allowed by the kernel server.
const WEBVIEW_ORIGINS: &str = "tauri://localhost,http://tauri.localhost";

fn command() -> Command {
    let bin = std::env::var("KPAI_BIN").unwrap_or_else(|_| "kpai".to_string());
    let mut cmd = if bin.ends_with(".js") || bin.ends_with(".mjs") {
        let mut c = Command::new("node");
        c.arg(bin);
        c
    } else {
        Command::new(bin)
    };
    cmd.args(["studio", "--port", "0"])
        .env("KPAI_STUDIO_ORIGINS", WEBVIEW_ORIGINS)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());
    cmd
}

/// `KP Studio: http://127.0.0.1:PORT/#token=TOKEN` → (`ws://127.0.0.1:PORT/rpc`, TOKEN),
/// only for a loopback URL and a token of safe characters (it is put into a script).
pub fn parse_line(line: &str) -> Option<(String, String)> {
    let url = line.trim().strip_prefix("KP Studio: ")?;
    let (base, token) = url.split_once("/#token=")?;
    let port = base.strip_prefix("http://127.0.0.1:")?;
    let token_ok = (8..=512).contains(&token.len())
        && token.chars().all(|c| c.is_ascii_alphanumeric() || "._~-".contains(c));
    if !port.chars().all(|c| c.is_ascii_digit()) || port.is_empty() || !token_ok {
        return None;
    }
    Some((format!("ws://127.0.0.1:{port}/rpc"), token.to_string()))
}

pub fn start(handle: AppHandle) {
    let mut child = match command().spawn() {
        Ok(c) => c,
        Err(e) => return show_error(&handle, &format!("could not start kpai studio: {e}")),
    };
    let stdout = child.stdout.take();
    crate::keep_child(&handle, child);
    let Some(stdout) = stdout else { return };
    for line in BufReader::new(stdout).lines().map_while(Result::ok) {
        if let Some((ws, token)) = parse_line(&line) {
            let script = format!(
                "window.location.hash = 'token={token}&ws={ws}'; window.location.reload();"
            );
            if let Some(window) = handle.get_webview_window("main") {
                let _ = window.eval(&script);
            }
            return;
        }
    }
    show_error(&handle, "kpai studio stopped before printing its URL");
}

fn show_error(handle: &AppHandle, message: &str) {
    eprintln!("KP Studio desktop: {message}");
    if let Some(window) = handle.get_webview_window("main") {
        let _ = window.set_title(&format!("KP Studio — {message}"));
    }
}

#[cfg(test)]
mod tests {
    use super::parse_line;

    #[test]
    fn reads_the_server_line() {
        let line = "KP Studio: http://127.0.0.1:43123/#token=abcDEF012_-.~xyz\n";
        assert_eq!(
            parse_line(line),
            Some(("ws://127.0.0.1:43123/rpc".into(), "abcDEF012_-.~xyz".into()))
        );
    }

    #[test]
    fn refuses_other_hosts_and_unsafe_tokens() {
        assert_eq!(parse_line("KP Studio: http://evil.example:1/#token=abcdefghij"), None);
        assert_eq!(parse_line("KP Studio: http://127.0.0.1:1/#token=abc'defghij"), None);
        assert_eq!(parse_line("KP Studio: http://127.0.0.1:1/#token=short"), None);
        assert_eq!(parse_line("kernel server on http://127.0.0.1:1"), None);
    }
}
