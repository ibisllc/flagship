//! The release directories, the one atomic switch and the state files around it: the Rust twin of
//! `installer/install-box-artifact.sh` and `installer/rollback-box-artifact.sh`.
//!
//! A release lives in `<releases>/<commit>/` (`app/` is the tree, `INSTALLED.json` the record) and
//! is immutable: an install of the same commit replaces it only with identical bytes. The running
//! tree is the symlink `<current>` (`/opt/flagship`); it is flipped with one `rename`. Only the
//! release now running and the one before it are kept: a rollback needs exactly those two.

use crate::extract::{Limits, extract_tar_gz};
use crate::fsutil::{read_regular, switch_symlink, sync_dir, write_durable};
use crate::journal::{Intent, Phase};
use crate::manifest;
use crate::refusal::Refusal;
use crate::verify::{Expect, Trust, Verified, verify};
use serde_json::{Map, Value};
use std::fs::{self, File};
use std::io::Read;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Clone, Debug)]
pub struct Paths {
    pub releases: PathBuf,
    pub current: PathBuf,
    pub state: PathBuf,
    pub bin: PathBuf,
}

impl Default for Paths {
    fn default() -> Self {
        Self {
            releases: "/opt/flagship-releases".into(),
            current: "/opt/flagship".into(),
            state: "/var/flagship".into(),
            bin: "/usr/local/bin".into(),
        }
    }
}

/// A failed install or restore: the exit code the shell scripts used (1 refused by the verifier,
/// 3 the unpacked tree or the switch failed) and why.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Failure {
    pub exit: u8,
    pub refusal: Refusal,
}

fn verifier_refused(r: Refusal) -> Failure {
    Failure {
        exit: 1,
        refusal: r,
    }
}

fn tree_failed(code: &'static str, detail: impl Into<String>) -> Failure {
    Failure {
        exit: 3,
        refusal: Refusal::with(code, detail),
    }
}

fn io_failed(what: &str, e: &std::io::Error) -> Failure {
    tree_failed("install-failed", format!("{what}: {e}"))
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|d| u64::try_from(d.as_millis()).ok())
        .unwrap_or(0)
}

fn is_commit(s: &str) -> bool {
    s.len() == 40 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// A state file this account wrote itself: the unprivileged daemon may add files to the state
/// directory, so one it owns is never trusted as history.
fn own_file(path: &Path) -> Option<String> {
    let meta = fs::symlink_metadata(path).ok()?;
    if !meta.file_type().is_file() || meta.uid() != rustix::process::geteuid().as_raw() {
        return None;
    }
    read_regular(path)
}

fn is_executable_file(path: &Path) -> bool {
    fs::metadata(path).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
}

#[derive(Clone, Debug)]
pub struct InstallArgs {
    pub manifest: PathBuf,
    pub artifact: PathBuf,
    pub trust: Trust,
    pub expect_sha256: String,
    pub expect_commit: String,
    pub arch: String,
    pub node_floor: String,
    /// "Sequence N or higher" on a box with no history.
    pub min_sequence: Option<u64>,
    pub paths: Paths,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Installed {
    pub commit: String,
    pub arch: String,
    pub sequence: u64,
}

const REQUIRED: [&str; 5] = [
    "package.json",
    "package-lock.json",
    "installer/flagship-unseal",
    "scripts/install-helper.ts",
    "node_modules/tsx/dist/cli.mjs",
];

const TSX_WRAPPER: &str = "#!/bin/sh\n# Run a TypeScript file with the box's own Node and tsx. No npm, no npx, no network.\nexec /opt/flagship/.runtime/node/bin/node /opt/flagship/node_modules/tsx/dist/cli.mjs \"$@\"\n";

fn read_sequence(paths: &Paths) -> Option<u64> {
    own_file(&paths.state.join("artifact-sequence"))?
        .trim()
        .parse()
        .ok()
}

fn check_tree(staging: &Path, v: &Verified) -> Result<(), Failure> {
    let app = staging.join("app");
    if !is_executable_file(&app.join("installer/flagship-unseal")) {
        return Err(tree_failed("bad-tree", "no unseal helper in the artifact"));
    }
    if !is_executable_file(&app.join(".runtime/node/bin/node")) {
        return Err(tree_failed("bad-tree", "no Node runtime in the artifact"));
    }
    let info: Value = read_regular(&staging.join("BUILD-INFO.json"))
        .and_then(|t| serde_json::from_str(&t).ok())
        .ok_or_else(|| tree_failed("bad-tree", "no BUILD-INFO.json"))?;
    if info.get("commit").and_then(Value::as_str) != Some(v.commit.as_str()) {
        return Err(tree_failed(
            "bad-tree",
            "BUILD-INFO commit differs from the manifest",
        ));
    }
    if info.get("arch").and_then(Value::as_str) != Some(v.arch.as_str()) {
        return Err(tree_failed("bad-tree", "BUILD-INFO arch differs"));
    }
    for f in REQUIRED {
        if fs::symlink_metadata(app.join(f)).is_err() {
            return Err(tree_failed("bad-tree", format!("the artifact lacks {f}")));
        }
    }
    Ok(())
}

fn same_file(a: &Path, b: &Path) -> std::io::Result<bool> {
    let (mut fa, mut fb) = (File::open(a)?, File::open(b)?);
    if fa.metadata()?.len() != fb.metadata()?.len() {
        return Ok(false);
    }
    let (mut ba, mut bb) = (vec![0u8; 1 << 16], vec![0u8; 1 << 16]);
    loop {
        let n = fa.read(&mut ba)?;
        if n == 0 {
            return Ok(true);
        }
        fb.read_exact(bb.get_mut(..n).unwrap_or(&mut []))?;
        if ba.get(..n) != bb.get(..n) {
            return Ok(false);
        }
    }
}

/// True when the two trees hold the same names, kinds, link targets and file bytes.
fn same_tree(a: &Path, b: &Path) -> std::io::Result<bool> {
    let mut names_a: Vec<_> = fs::read_dir(a)?
        .map(|e| e.map(|e| e.file_name()))
        .collect::<Result<_, _>>()?;
    let mut names_b: Vec<_> = fs::read_dir(b)?
        .map(|e| e.map(|e| e.file_name()))
        .collect::<Result<_, _>>()?;
    names_a.sort();
    names_b.sort();
    if names_a != names_b {
        return Ok(false);
    }
    for n in names_a {
        let (pa, pb) = (a.join(&n), b.join(&n));
        let (ma, mb) = (fs::symlink_metadata(&pa)?, fs::symlink_metadata(&pb)?);
        let (ta, tb) = (ma.file_type(), mb.file_type());
        let same = if ta.is_symlink() && tb.is_symlink() {
            fs::read_link(&pa)? == fs::read_link(&pb)?
        } else if ta.is_dir() && tb.is_dir() {
            same_tree(&pa, &pb)?
        } else if ta.is_file() && tb.is_file() {
            same_file(&pa, &pb)?
        } else {
            false
        };
        if !same {
            return Ok(false);
        }
    }
    Ok(true)
}

fn installed_record(commit: &str, arch: &str, sequence: u64, sha256: &str) -> String {
    let mut m = Map::new();
    m.insert("commit".into(), Value::from(commit));
    m.insert("arch".into(), Value::from(arch));
    m.insert("sequence".into(), Value::from(sequence));
    m.insert("artifactSha256".into(), Value::from(sha256));
    Value::Object(m).to_string()
}

fn release_commit_of(link_target: &Path) -> Option<String> {
    let c = link_target.parent()?.file_name()?.to_str()?;
    is_commit(c).then(|| c.to_owned())
}

fn link_node(paths: &Paths) -> std::io::Result<()> {
    switch_symlink(
        &paths.bin.join("node"),
        &paths.current.join(".runtime/node/bin/node"),
    )
}

fn prune(paths: &Paths, keep: &[&str]) {
    let Ok(rd) = fs::read_dir(&paths.releases) else {
        return;
    };
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        if name.starts_with(".incoming-") || keep.contains(&name.as_str()) {
            continue;
        }
        let _ = fs::remove_dir_all(e.path());
    }
}

/// Verifies, unpacks and switches to a release (`install-box-artifact.sh`).
///
/// # Errors
/// [`Failure`] with exit 1 when the verifier refused (nothing changed) and exit 3 when the unpacked
/// tree failed its own checks or the switch failed (the link is untouched until the very last step).
pub fn install(a: &InstallArgs) -> Result<Installed, Failure> {
    let p = &a.paths;
    let last_sequence = read_sequence(p).or_else(|| {
        a.min_sequence
            .filter(|n| *n > 0)
            .map(|n| n.saturating_sub(1))
    });
    let text = fs::read_to_string(&a.manifest)
        .map_err(|e| verifier_refused(Refusal::with("bad-manifest", e.to_string())))?;
    let file = manifest::parse(&text).map_err(verifier_refused)?;
    let expect = Expect {
        sha256: a.expect_sha256.clone(),
        commit: a.expect_commit.clone(),
        arch: a.arch.clone(),
        last_sequence,
        node_floor: Some(a.node_floor.clone()),
        now_ms: now_ms(),
    };
    let v = verify(&file, &a.artifact, &a.trust, &expect).map_err(verifier_refused)?;
    let commit = v.commit.to_ascii_lowercase();
    for d in [&p.releases, &p.state, &p.bin] {
        fs::create_dir_all(d).map_err(|e| io_failed("create directories", &e))?;
    }
    let dest = p.releases.join(&commit);
    let staging = p
        .releases
        .join(format!(".incoming-{commit}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&staging);
    fs::create_dir(&staging).map_err(|e| io_failed("create staging", &e))?;
    let outcome = stage_and_switch(a, &v, &commit, &dest, &staging);
    let _ = fs::remove_dir_all(&staging);
    outcome
}

fn stage_and_switch(
    a: &InstallArgs,
    v: &Verified,
    commit: &str,
    dest: &Path,
    staging: &Path,
) -> Result<Installed, Failure> {
    let p = &a.paths;
    extract_tar_gz(&a.artifact, staging, 1, &Limits::default()).map_err(|r| Failure {
        exit: 3,
        refusal: r,
    })?;
    check_tree(staging, v)?;
    if dest.exists() {
        let same = same_tree(&staging.join("app"), &dest.join("app")).unwrap_or(false);
        if !same {
            return Err(tree_failed(
                "release-exists",
                format!("{} already exists with different contents", dest.display()),
            ));
        }
    } else {
        fs::rename(staging, dest).map_err(|e| io_failed("move the release into place", &e))?;
        sync_dir(&p.releases).map_err(|e| io_failed("sync releases", &e))?;
    }
    write_durable(
        &dest.join("INSTALLED.json"),
        installed_record(
            commit,
            &v.arch,
            v.sequence,
            &a.expect_sha256.to_ascii_lowercase(),
        )
        .as_bytes(),
        0o644,
    )
    .map_err(|e| io_failed("write INSTALLED.json", &e))?;
    write_durable(&p.bin.join("flagship-tsx"), TSX_WRAPPER.as_bytes(), 0o755)
        .map_err(|e| io_failed("write flagship-tsx", &e))?;
    let previous_target = match fs::symlink_metadata(&p.current) {
        Ok(m) if m.file_type().is_symlink() => fs::read_link(&p.current).ok(),
        Ok(_) => {
            return Err(tree_failed(
                "legacy-install",
                format!(
                    "{} is a real directory (a legacy install); migrate it with the update path",
                    p.current.display()
                ),
            ));
        }
        Err(_) => None,
    };
    let previous = previous_target.as_deref().and_then(release_commit_of);
    let mut intent = Intent {
        phase: Phase::Staged,
        commit: commit.to_owned(),
        previous: previous.clone(),
        sequence: v.sequence,
        at_ms: now_ms(),
    };
    intent
        .write(&p.state)
        .map_err(|e| io_failed("write intent", &e))?;
    if let Some(t) = &previous_target {
        write_durable(
            &p.state.join("artifact-previous"),
            format!("{}\n", t.display()).as_bytes(),
            0o644,
        )
        .map_err(|e| io_failed("write artifact-previous", &e))?;
    }
    intent.phase = Phase::Switching;
    intent
        .write(&p.state)
        .map_err(|e| io_failed("write intent", &e))?;
    switch_symlink(&p.current, &dest.join("app"))
        .map_err(|e| io_failed("switch the release", &e))?;
    link_node(p).map_err(|e| io_failed("link node", &e))?;
    write_durable(
        &p.state.join("artifact-sequence"),
        format!("{}\n", v.sequence).as_bytes(),
        0o644,
    )
    .map_err(|e| io_failed("write artifact-sequence", &e))?;
    write_durable(
        &p.state.join("artifact-current.json"),
        installed_record(
            commit,
            &v.arch,
            v.sequence,
            &a.expect_sha256.to_ascii_lowercase(),
        )
        .as_bytes(),
        0o644,
    )
    .map_err(|e| io_failed("write artifact-current.json", &e))?;
    intent.phase = Phase::Switched;
    intent
        .write(&p.state)
        .map_err(|e| io_failed("write intent", &e))?;
    let mut keep = vec![commit];
    if let Some(prev) = previous.as_deref() {
        keep.push(prev);
    }
    prune(p, &keep);
    Ok(Installed {
        commit: commit.to_owned(),
        arch: v.arch.clone(),
        sequence: v.sequence,
    })
}

/// Flips back to a release that is already installed (`rollback-box-artifact.sh`).
///
/// # Errors
/// Exit 2 for a malformed commit, exit 3 when the release is not installed or the flip failed.
pub fn restore(paths: &Paths, commit: &str) -> Result<(), Failure> {
    if !is_commit(commit) {
        return Err(Failure {
            exit: 2,
            refusal: Refusal::with("bad-commit", "not a full commit"),
        });
    }
    let dest = paths.releases.join(commit);
    if !dest.join("app").is_dir() || !is_executable_file(&dest.join("app/.runtime/node/bin/node")) {
        return Err(tree_failed(
            "not-installed",
            format!("release {commit} is not installed on this box"),
        ));
    }
    let record = read_regular(&dest.join("INSTALLED.json"))
        .ok_or_else(|| tree_failed("not-installed", format!("release {commit} has no record")))?;
    let parsed: Value = serde_json::from_str(&record)
        .map_err(|_| tree_failed("not-installed", "the release record is not JSON"))?;
    if parsed.get("commit").and_then(Value::as_str) != Some(commit) {
        return Err(tree_failed(
            "not-installed",
            "the release record names another commit",
        ));
    }
    match fs::symlink_metadata(&paths.current) {
        Ok(m) if !m.file_type().is_symlink() => {
            return Err(tree_failed(
                "legacy-install",
                format!("{} is not a release link", paths.current.display()),
            ));
        }
        _ => {}
    }
    let previous = fs::read_link(&paths.current)
        .ok()
        .as_deref()
        .and_then(release_commit_of);
    let intent = Intent {
        phase: Phase::Switching,
        commit: commit.to_owned(),
        previous,
        sequence: parsed.get("sequence").and_then(Value::as_u64).unwrap_or(0),
        at_ms: now_ms(),
    };
    intent
        .write(&paths.state)
        .map_err(|e| io_failed("write intent", &e))?;
    switch_symlink(&paths.current, &dest.join("app"))
        .map_err(|e| io_failed("switch the release", &e))?;
    link_node(paths).map_err(|e| io_failed("link node", &e))?;
    write_durable(
        &paths.state.join("artifact-current.json"),
        record.as_bytes(),
        0o644,
    )
    .map_err(|e| io_failed("write artifact-current.json", &e))?;
    Intent::clear(&paths.state).map_err(|e| io_failed("clear intent", &e))?;
    Ok(())
}

/// The commit the release link names now.
#[must_use]
pub fn current_commit(paths: &Paths) -> Option<String> {
    release_commit_of(&fs::read_link(&paths.current).ok()?)
}
