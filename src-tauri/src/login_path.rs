//! The `PATH` the user's own shell would have.
//!
//! An app launched from Finder inherits launchd's minimal `PATH`
//! (`/usr/bin:/bin:/usr/sbin:/sbin`), with no Homebrew, mise or Bun on it. The
//! sidecar runs `gh` and workspace setup scripts that expect the tools the user
//! has in a terminal, so a packaged build hands it this `PATH` instead.

use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

/// Long enough for a shell with a heavy rc file; short enough that a prompt
/// waiting on input can't hold up the sidecar's start.
const SHELL_TIMEOUT: Duration = Duration::from_secs(5);

/// Wraps the printed value, so whatever the rc files print around it is ignored.
const MARKER: &str = "__YARVIS_PATH__";

/// Pulls the marked value out of the shell's output.
fn extract_path(output: &str) -> Option<String> {
    let start = output.find(MARKER)? + MARKER.len();
    let len = output[start..].find(MARKER)?;
    let path = output[start..start + len].trim();
    (!path.is_empty()).then(|| path.to_string())
}

/// Runs the user's shell as an interactive login shell, so both its profile and
/// its rc file (where tools like mise are usually activated) are read.
fn read_from_shell() -> Option<String> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let script = format!("printf '{MARKER}%s{MARKER}' \"$PATH\"");
    let mut child = Command::new(&shell)
        .args(["-ilc", &script])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .inspect_err(|e| eprintln!("[login_path] could not run {shell}: {e}"))
        .ok()?;

    let deadline = Instant::now() + SHELL_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(50)),
            Ok(None) => {
                eprintln!(
                    "[login_path] {shell} did not answer within {}s",
                    SHELL_TIMEOUT.as_secs()
                );
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
            Err(e) => {
                eprintln!("[login_path] waiting on {shell} failed: {e}");
                return None;
            }
        }
    }

    let mut output = String::new();
    child.stdout.take()?.read_to_string(&mut output).ok()?;
    extract_path(&output)
}

/// The login shell's `PATH`, read once per run. `None` when the shell couldn't
/// be read, in which case the caller keeps the inherited one.
pub fn get() -> Option<&'static str> {
    static PATH: OnceLock<Option<String>> = OnceLock::new();
    PATH.get_or_init(read_from_shell).as_deref()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_marked_value_past_rc_file_noise() {
        let output = format!("Welcome!\n{MARKER}/opt/homebrew/bin:/usr/bin{MARKER}\nbye");
        assert_eq!(
            extract_path(&output).as_deref(),
            Some("/opt/homebrew/bin:/usr/bin")
        );
    }

    #[test]
    fn missing_or_empty_markers_read_as_nothing() {
        assert_eq!(extract_path("no markers here"), None);
        assert_eq!(extract_path(&format!("{MARKER}/usr/bin")), None);
        assert_eq!(extract_path(&format!("{MARKER}{MARKER}")), None);
    }
}
