//! The lease key sealed to a TPM 2.0 (`packages/server-daemon/src/bootPqTpm.ts` writes it;
//! `docs/architecture-v2/pq-suites.md` §19.4). DRAFT: the PCR policy is not reviewed (plan §7,
//! N10).
//!
//! `/boot/flagship-lease-kem.tpm/` holds `seal.pub` and `seal.priv` (a sealed data object under
//! the owner hierarchy's ECC P-256 primary, which is re-created from the TPM's seed each time),
//! and `pcrs` (`sha256:<i>,<j>,...`, the PCRs the object's policy covers). The object's only
//! authorization is that PCR policy, so it unseals only on this TPM with the boot chain it was
//! sealed under. The TPM is classical; it binds the seed to this machine and boot chain, the PQ
//! protection of the disk key is the hybrid seal to the lease key.
//!
//! The tpm2-tools binaries run from `PATH` (the initramfs hook copies them); the TCTI is
//! `TPM2TOOLS_TCTI` (default `device:/dev/tpmrm0`). The seed only crosses a pipe.

use std::path::Path;
use std::process::{Command, Stdio};
use zeroize::Zeroizing;

/// The primary key template both sides use (deterministic from the owner hierarchy's seed).
pub const PRIMARY_ARGS: &[&str] = &["-C", "o", "-g", "sha256", "-G", "ecc256:aes128cfb"];

/// Reads `pcrs`: `sha256:` and 1 to 24 ascending PCR indices below 24.
///
/// # Errors
/// A message when the file is missing or malformed.
pub fn read_pcr_selection(dir: &Path) -> Result<String, String> {
    let raw =
        std::fs::read_to_string(dir.join("pcrs")).map_err(|e| format!("no pcrs file: {e}"))?;
    let t = raw.strip_suffix('\n').unwrap_or(&raw);
    let list = t
        .strip_prefix("sha256:")
        .ok_or("pcrs must start with sha256:")?;
    let mut last: Option<u8> = None;
    for p in list.split(',') {
        let n: u8 = p.parse().map_err(|_| "pcrs lists a bad index")?;
        if n > 23
            || last.is_some_and(|l| n <= l)
            || p.len() > 2
            || (p.len() == 2 && p.starts_with('0'))
        {
            return Err("pcrs lists a bad index".into());
        }
        last = Some(n);
    }
    if last.is_none() {
        return Err("pcrs lists no index".into());
    }
    Ok(t.to_owned())
}

fn run(cmd: &mut Command, what: &str) -> Result<(), String> {
    let out = cmd
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| format!("{what}: {e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        let msg = String::from_utf8_lossy(&out.stderr);
        Err(format!(
            "{what} failed: {}",
            msg.lines().last().unwrap_or("").trim()
        ))
    }
}

/// Unseals the lease key's seed. A changed boot chain, another TPM or a missing tool is an error
/// (the caller then asks the phone).
///
/// # Errors
/// A message naming the step that failed.
pub fn unseal_seed(dir: &Path) -> Result<Zeroizing<[u8; 32]>, String> {
    let pcrs = read_pcr_selection(dir)?;
    let work = std::env::temp_dir().join(format!("flagship-tpm-{}", std::process::id()));
    std::fs::create_dir_all(&work).map_err(|e| format!("work dir: {e}"))?;
    let result = (|| {
        let primary = work.join("primary.ctx");
        let object = work.join("seal.ctx");
        run(
            Command::new("tpm2_createprimary")
                .args(PRIMARY_ARGS)
                .arg("-c")
                .arg(&primary),
            "tpm2_createprimary",
        )?;
        run(
            Command::new("tpm2_load")
                .arg("-C")
                .arg(&primary)
                .arg("-u")
                .arg(dir.join("seal.pub"))
                .arg("-r")
                .arg(dir.join("seal.priv"))
                .arg("-c")
                .arg(&object),
            "tpm2_load",
        )?;
        let out = Command::new("tpm2_unseal")
            .arg("-c")
            .arg(&object)
            .arg("-p")
            .arg(format!("pcr:{pcrs}"))
            .stdin(Stdio::null())
            .stderr(Stdio::piped())
            .output()
            .map_err(|e| format!("tpm2_unseal: {e}"))?;
        let stdout = Zeroizing::new(out.stdout);
        if !out.status.success() {
            let msg = String::from_utf8_lossy(&out.stderr);
            return Err(format!(
                "tpm2_unseal failed: {}",
                msg.lines().last().unwrap_or("").trim()
            ));
        }
        let t = stdout.strip_suffix(b"\n").unwrap_or(&stdout);
        let b = Zeroizing::new(crate::gohex::decode(t).map_err(|_| "the sealed seed is not hex")?);
        <[u8; 32]>::try_from(b.as_slice())
            .map(Zeroizing::new)
            .map_err(|_| "the sealed seed is not 32 bytes".to_owned())
    })();
    let _ = std::fs::remove_dir_all(&work);
    result
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::read_pcr_selection;

    #[test]
    fn pcr_selection_is_strict() {
        let dir = std::env::temp_dir().join(format!("flagship-pcrs-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        for (text, ok) in [
            ("sha256:0,2,4,7,9\n", true),
            ("sha256:7", true),
            ("sha1:0,7", false),
            ("sha256:7,4", false),
            ("sha256:0,24", false),
            ("sha256:", false),
            ("sha256:07", false),
            ("sha256:0,,7", false),
        ] {
            std::fs::write(dir.join("pcrs"), text).unwrap();
            assert_eq!(read_pcr_selection(&dir).is_ok(), ok, "{text}");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
