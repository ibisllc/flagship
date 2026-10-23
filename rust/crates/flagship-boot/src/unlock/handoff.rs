//! Passing the LUKS key to cryptsetup through a pipe only: never argv, the
//! environment or a file. The shell flow writes the key's hex to
//! `/run/unlock-key` (tmpfs) and runs `xxd -r -p | cryptsetup luksOpen
//! --key-file -`; this writes the raw bytes straight into cryptsetup's stdin.

use std::io::{IsTerminal, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};

/// Where the key goes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Handoff {
    /// Run `<program> luksOpen --key-file - <device> <name>` and feed stdin.
    Cryptsetup {
        /// cryptsetup binary.
        program: PathBuf,
        /// LUKS block device.
        device: PathBuf,
        /// Mapper name (the crypttab target on Debian).
        name: String,
    },
    /// Write the raw key to stdout, which must be a pipe (`| cryptsetup ...`).
    Stdout,
}

/// A failed hand-off and the exit code to report.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HandoffError {
    /// What went wrong (no key material).
    pub message: String,
    /// Process exit code.
    pub code: i32,
}

/// Deliver `key`.
pub fn hand_off(key: &[u8], how: &Handoff) -> Result<(), HandoffError> {
    match how {
        Handoff::Stdout => {
            let mut out = std::io::stdout().lock();
            if out.is_terminal() {
                return Err(HandoffError {
                    message: "refusing to write the disk key to a terminal".into(),
                    code: 1,
                });
            }
            out.write_all(key)
                .and_then(|()| out.flush())
                .map_err(|e| HandoffError {
                    message: format!("writing the key to stdout: {e}"),
                    code: 1,
                })
        }
        Handoff::Cryptsetup {
            program,
            device,
            name,
        } => {
            let mut child = Command::new(program)
                .arg("luksOpen")
                .arg("--key-file")
                .arg("-")
                .arg(device)
                .arg(name)
                .stdin(Stdio::piped())
                .spawn()
                .map_err(|e| HandoffError {
                    message: format!("starting {}: {e}", program.display()),
                    code: 1,
                })?;
            let wrote = match child.stdin.take() {
                Some(mut stdin) => stdin.write_all(key).and_then(|()| stdin.flush()),
                None => Ok(()),
            };
            let status = child.wait().map_err(|e| HandoffError {
                message: format!("waiting for cryptsetup: {e}"),
                code: 1,
            })?;
            if status.success() {
                if let Err(e) = wrote {
                    return Err(HandoffError {
                        message: format!("cryptsetup did not take the key: {e}"),
                        code: 1,
                    });
                }
                return Ok(());
            }
            let code = status.code().filter(|c| *c != 0).unwrap_or(1);
            Err(HandoffError {
                message: format!("cryptsetup luksOpen failed ({status})"),
                code,
            })
        }
    }
}
