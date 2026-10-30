#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects,
    clippy::panic
)]
mod common;

use common::{Entry, Tmp, sha256_hex, tar_gz};
use flagship_updater::runtime::fetch::{Get, Reply, download};
use flagship_updater::runtime::{Lock, install, status, verify_archive, verify_shasums_signature};
use pgp::composed::{
    DetachedSignature, EncryptionCaps, KeyType, SecretKeyParamsBuilder, SignedPublicKey,
    SignedSecretKey,
};
use pgp::crypto::hash::HashAlgorithm;
use pgp::ser::Serialize;
use pgp::types::{KeyDetails, Password};
use serde_json::{Value, json};
use std::cell::RefCell;
use std::collections::HashMap;
use std::io::Cursor;

type Mutation = Box<dyn Fn(&mut Value)>;

const LOCK: &str = include_str!("../../../../release/runtime-lock.json");
const FIX: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/node-24.22.1/");

#[test]
fn the_committed_lock_is_consistent_with_the_pins_and_the_real_signed_checksum_list() {
    let lock = Lock::parse(LOCK).unwrap();
    let pins: Value = serde_json::from_str(include_str!(
        "../../../../tools/box-artifact/node-pins.json"
    ))
    .unwrap();
    let floor: Value =
        serde_json::from_str(include_str!("../../../../release/security-floor.json")).unwrap();
    assert_eq!(lock.version, pins["node"]["version"]);
    assert_eq!(lock.security_floor, floor["node"]["minimum"]);
    let sums = std::fs::read_to_string(format!("{FIX}SHASUMS256.txt")).unwrap();
    for t in lock.targets.values() {
        assert!(
            sums.lines()
                .any(|l| l.starts_with(&t.sha256) && l.ends_with(&t.file)),
            "{} is in the signed list at the locked digest",
            t.file
        );
        assert!(lock.archive_url(t).starts_with("https://nodejs.org/dist/v"));
    }
    // The signer key the lock carries is the one that really signed Node's list, checked with the real bytes.
    let sums = std::fs::read(format!("{FIX}SHASUMS256.txt")).unwrap();
    let sig = std::fs::read(format!("{FIX}SHASUMS256.txt.sig")).unwrap();
    assert_eq!(
        verify_shasums_signature(&lock, &sums, &sig).unwrap(),
        "5be8a3f6c8a5c01d106c0ad820b1a390b168d356"
    );
    let mut tampered = sums.clone();
    tampered[3] ^= 1;
    assert_eq!(
        verify_shasums_signature(&lock, &tampered, &sig)
            .unwrap_err()
            .code,
        "upstream-signature"
    );
    // pinned fingerprints include the signer
    let v: Value = serde_json::from_str(LOCK).unwrap();
    assert!(
        v["keyring"]["upstreamFingerprints"]
            .as_array()
            .unwrap()
            .iter()
            .any(|f| f == "5be8a3f6c8a5c01d106c0ad820b1a390b168d356")
    );
}

#[test]
fn a_lock_that_is_not_what_it_claims_is_refused() {
    let base: Value = serde_json::from_str(LOCK).unwrap();
    let cases: Vec<(&str, Mutation)> = vec![
        (
            "below its own floor",
            Box::new(|v| v["securityFloor"] = json!("99.0.0")),
        ),
        (
            "http base",
            Box::new(|v| v["upstream"]["base"] = json!("http://nodejs.org/dist/v24.22.1/")),
        ),
        (
            "host not allowed",
            Box::new(|v| v["upstream"]["allowedHosts"] = json!(["example.org"])),
        ),
        (
            "no hosts",
            Box::new(|v| v["upstream"]["allowedHosts"] = json!([])),
        ),
        (
            "signer fingerprint",
            Box::new(|v| v["keyring"]["signers"][0]["fingerprint"] = json!("XYZ")),
        ),
        (
            "no signers",
            Box::new(|v| v["keyring"]["signers"] = json!([])),
        ),
        (
            "path in file",
            Box::new(|v| v["targets"]["linux-amd64"]["file"] = json!("../node.tar.gz")),
        ),
        (
            "climbing executable",
            Box::new(|v| v["targets"]["linux-amd64"]["executable"] = json!("../../bin/node")),
        ),
        (
            "another version",
            Box::new(|v| {
                v["targets"]["linux-amd64"]["file"] = json!("node-v20.0.0-linux-x64.tar.gz")
            }),
        ),
        (
            "short digest",
            Box::new(|v| v["targets"]["linux-amd64"]["sha256"] = json!("abc")),
        ),
        ("runtime", Box::new(|v| v["runtime"] = json!("bun"))),
        ("no targets", Box::new(|v| v["targets"] = json!({}))),
    ];
    for (label, f) in cases {
        let mut v = base.clone();
        f(&mut v);
        assert_eq!(
            Lock::parse(&v.to_string()).unwrap_err().code,
            "bad-runtime-lock",
            "{label}"
        );
    }
    assert_eq!(Lock::parse("nope").unwrap_err().code, "bad-runtime-lock");
}

struct Key {
    secret: SignedSecretKey,
}

impl Key {
    fn new(name: &str) -> Self {
        let mut p = SecretKeyParamsBuilder::default();
        p.key_type(KeyType::Ed25519Legacy)
            .can_certify(true)
            .can_sign(true)
            .can_encrypt(EncryptionCaps::None)
            .primary_user_id(format!("{name} <{name}@example.org>"));
        Self {
            secret: p.build().unwrap().generate(rand::thread_rng()).unwrap(),
        }
    }
    fn public(&self) -> SignedPublicKey {
        SignedPublicKey::from(self.secret.clone())
    }
    fn fingerprint(&self) -> String {
        self.secret.fingerprint().to_string().to_ascii_lowercase()
    }
    fn armored(&self) -> String {
        self.public().to_armored_string(Default::default()).unwrap()
    }
    fn sign(&self, data: &[u8]) -> Vec<u8> {
        let s = DetachedSignature::sign_binary_data(
            rand::thread_rng(),
            &self.secret.primary_key,
            &Password::empty(),
            HashAlgorithm::Sha256,
            data,
        )
        .unwrap();
        s.to_bytes().unwrap()
    }
}

struct Fx {
    dir: Tmp,
    lock: Lock,
    key: Key,
    archive: std::path::PathBuf,
    shasums: Vec<u8>,
    sig: Vec<u8>,
    exe: Vec<u8>,
}

fn node_entries(exe: &[u8]) -> Vec<Entry> {
    vec![
        Entry::Dir("node-v24.22.1-linux-x64/"),
        Entry::Dir("node-v24.22.1-linux-x64/bin/"),
        Entry::File("node-v24.22.1-linux-x64/bin/node", exe.to_vec(), 0o755),
        Entry::File("node-v24.22.1-linux-x64/LICENSE", b"MIT".to_vec(), 0o644),
    ]
}

fn fixture_with(mutate: impl Fn(&mut Value)) -> Fx {
    let dir = Tmp::new("rt");
    let exe = b"\x7fELF pretend node".to_vec();
    let gz = tar_gz(&node_entries(&exe));
    let archive = dir.path().join("node-v24.22.1-linux-x64.tar.gz");
    std::fs::write(&archive, &gz).unwrap();
    let digest = sha256_hex(&gz);
    let shasums = format!(
        "{digest}  node-v24.22.1-linux-x64.tar.gz\n{}  node-v24.22.1-linux-arm64.tar.gz\n",
        "9".repeat(64)
    )
    .into_bytes();
    let key = Key::new("signer");
    let sig = key.sign(&shasums);
    let mut v = json!({
        "schema": 1, "runtime": "node", "version": "24.22.1", "securityFloor": "24.22.1",
        "upstream": {"base": "https://nodejs.org/dist/v24.22.1/", "shasums": "SHASUMS256.txt", "shasumsSignature": "SHASUMS256.txt.sig", "allowedHosts": ["nodejs.org"]},
        "keyring": {"signers": [{"fingerprint": key.fingerprint(), "armored": key.armored()}]},
        "targets": {"linux-amd64": {"file": "node-v24.22.1-linux-x64.tar.gz", "bytes": gz.len(), "sha256": digest, "executable": "bin/node", "executableBytes": exe.len(), "executableSha256": sha256_hex(&exe)}}
    });
    mutate(&mut v);
    let lock = Lock::parse(&v.to_string()).unwrap();
    Fx {
        dir,
        lock,
        key,
        archive,
        shasums,
        sig,
        exe,
    }
}

fn fixture() -> Fx {
    fixture_with(|_| {})
}

#[test]
fn a_runtime_that_all_three_statements_agree_on_installs_and_reports_itself() {
    let f = fixture();
    let t = f.lock.target("linux-amd64").unwrap();
    let runtimes = f.dir.path().join("runtimes");
    let i = install(&f.lock, t, &f.archive, &f.shasums, &f.sig, &runtimes).unwrap();
    assert!(i.new);
    assert_eq!(i.evidence.signer, f.key.fingerprint());
    assert_eq!(
        (
            &i.evidence.shasums_digest,
            &i.evidence.local_digest,
            &i.evidence.lock_digest
        ),
        (&t.sha256, &t.sha256, &t.sha256)
    );
    assert_eq!(std::fs::read(&i.executable).unwrap(), f.exe);
    assert!(
        runtimes
            .join(i.dir.file_name().unwrap())
            .join("RUNTIME.json")
            .exists()
    );
    let st = status(&f.lock, "linux-amd64", &runtimes).unwrap();
    assert!(st.installed && st.matches_lock);
    assert_eq!(
        st.local_executable_sha256.as_deref(),
        Some(t.executable_sha256.as_str())
    );
    assert_eq!(st.upstream_signer, Some(f.key.fingerprint()));
    assert_eq!(
        st.official_url,
        "https://nodejs.org/dist/v24.22.1/node-v24.22.1-linux-x64.tar.gz"
    );
    // again: nothing is replaced
    assert!(
        !install(&f.lock, t, &f.archive, &f.shasums, &f.sig, &runtimes)
            .unwrap()
            .new
    );
    // tampering with the installed executable shows in the status
    std::fs::write(&i.executable, b"swapped").unwrap();
    assert!(
        !status(&f.lock, "linux-amd64", &runtimes)
            .unwrap()
            .matches_lock
    );
    assert_eq!(
        install(&f.lock, t, &f.archive, &f.shasums, &f.sig, &runtimes)
            .unwrap_err()
            .code,
        "bad-runtime"
    );
}

#[test]
fn nothing_not_installed_reports_not_installed() {
    let f = fixture();
    let st = status(&f.lock, "linux-amd64", &f.dir.path().join("none")).unwrap();
    assert!(!st.installed && !st.matches_lock && st.local_executable_sha256.is_none());
    assert_eq!(
        status(&f.lock, "linux-riscv", f.dir.path())
            .unwrap_err()
            .code,
        "bad-runtime-lock"
    );
}

fn refused(f: &Fx, shasums: &[u8], sig: &[u8]) -> String {
    let t = f.lock.target("linux-amd64").unwrap();
    let runtimes = f.dir.path().join("runtimes");
    let e = install(&f.lock, t, &f.archive, shasums, sig, &runtimes).unwrap_err();
    assert!(
        !runtimes.exists() || std::fs::read_dir(&runtimes).unwrap().next().is_none(),
        "nothing is left behind after {}",
        e.code
    );
    e.code.to_owned()
}

#[test]
fn a_bad_signature_blocks_the_install() {
    let f = fixture();
    let other = Key::new("other");
    assert_eq!(
        refused(&f, &f.shasums, &other.sign(&f.shasums)),
        "upstream-signature"
    );
    let mut tampered = f.shasums.clone();
    tampered[0] ^= 1;
    assert_eq!(refused(&f, &tampered, &f.sig), "upstream-signature");
    assert_eq!(
        refused(&f, &f.shasums, b"not a signature"),
        "upstream-signature"
    );
    assert_eq!(refused(&f, &f.shasums, &[]), "upstream-signature");
}

#[test]
fn a_key_that_is_not_the_one_its_fingerprint_names_is_refused() {
    let other = Key::new("imposter");
    let f = fixture_with(|v| v["keyring"]["signers"][0]["armored"] = json!(other.armored()));
    assert_eq!(refused(&f, &f.shasums, &f.sig), "upstream-key-mismatch");
}

#[test]
fn the_signed_list_the_lock_and_the_archive_must_all_agree() {
    let f = fixture();
    // the signed list names another digest than the lock
    let wrong = format!("{}  node-v24.22.1-linux-x64.tar.gz\n", "8".repeat(64)).into_bytes();
    assert_eq!(
        refused(&f, &wrong, &f.key.sign(&wrong)),
        "checksum-mismatch"
    );
    // the file is not in the signed list
    let missing = format!("{}  something-else.tar.gz\n", "8".repeat(64)).into_bytes();
    assert_eq!(
        refused(&f, &missing, &f.key.sign(&missing)),
        "checksum-missing"
    );
    // a list that names the file twice with different digests is ambiguous
    let twice = format!(
        "{0}  node-v24.22.1-linux-x64.tar.gz\n{1}  node-v24.22.1-linux-x64.tar.gz\n",
        f.lock.targets["linux-amd64"].sha256,
        "7".repeat(64)
    )
    .into_bytes();
    assert_eq!(refused(&f, &twice, &f.key.sign(&twice)), "checksum-missing");
    // the archive's bytes changed (same size): its own digest no longer matches
    let mut b = std::fs::read(&f.archive).unwrap();
    let n = b.len();
    b[n - 1] ^= 1;
    std::fs::write(&f.archive, b).unwrap();
    assert_eq!(refused(&f, &f.shasums, &f.sig), "checksum-mismatch");
    // a different size is caught first
    std::fs::write(&f.archive, b"short").unwrap();
    assert_eq!(refused(&f, &f.shasums, &f.sig), "size-mismatch");
}

#[test]
fn a_digest_in_the_lock_that_the_signed_list_does_not_back_is_refused() {
    let f = fixture_with(|v| v["targets"]["linux-amd64"]["sha256"] = json!("5".repeat(64)));
    assert_eq!(refused(&f, &f.shasums, &f.sig), "checksum-mismatch");
}

#[test]
fn an_executable_that_differs_from_the_lock_is_refused_and_leaves_nothing() {
    let f =
        fixture_with(|v| v["targets"]["linux-amd64"]["executableSha256"] = json!("6".repeat(64)));
    assert_eq!(refused(&f, &f.shasums, &f.sig), "bad-runtime");
    let g = fixture_with(|v| v["targets"]["linux-amd64"]["executableBytes"] = json!(5));
    assert_eq!(refused(&g, &g.shasums, &g.sig), "bad-runtime");
    let h = fixture_with(|v| v["targets"]["linux-amd64"]["executable"] = json!("bin/missing"));
    assert_eq!(refused(&h, &h.shasums, &h.sig), "bad-runtime");
}

#[test]
fn an_archive_that_tries_to_escape_is_refused_even_when_everything_is_signed() {
    let dir = Tmp::new("rt-evil");
    let gz = tar_gz(&[
        Entry::Dir("node-v24.22.1-linux-x64/"),
        Entry::Symlink("node-v24.22.1-linux-x64/bin", "/etc"),
        Entry::File("node-v24.22.1-linux-x64/bin/node", b"x".to_vec(), 0o755),
    ]);
    let archive = dir.path().join("node.tar.gz");
    std::fs::write(&archive, &gz).unwrap();
    let digest = sha256_hex(&gz);
    let shasums = format!("{digest}  node-v24.22.1-linux-x64.tar.gz\n").into_bytes();
    let key = Key::new("signer");
    let v = json!({
        "schema": 1, "runtime": "node", "version": "24.22.1", "securityFloor": "24.22.1",
        "upstream": {"base": "https://nodejs.org/dist/v24.22.1/", "shasums": "SHASUMS256.txt", "shasumsSignature": "SHASUMS256.txt.sig", "allowedHosts": ["nodejs.org"]},
        "keyring": {"signers": [{"fingerprint": key.fingerprint(), "armored": key.armored()}]},
        "targets": {"linux-amd64": {"file": "node-v24.22.1-linux-x64.tar.gz", "bytes": gz.len(), "sha256": digest, "executable": "bin/node", "executableBytes": 1, "executableSha256": sha256_hex(b"x")}}
    });
    let lock = Lock::parse(&v.to_string()).unwrap();
    let t = lock.target("linux-amd64").unwrap();
    verify_archive(&lock, t, &archive, &shasums, &key.sign(&shasums)).unwrap();
    let e = install(
        &lock,
        t,
        &archive,
        &shasums,
        &key.sign(&shasums),
        &dir.path().join("rt"),
    )
    .unwrap_err();
    assert_eq!(e.code, "unsafe-artifact");
}

struct Canned {
    replies: HashMap<String, (u16, Option<String>, Vec<u8>)>,
    seen: RefCell<Vec<String>>,
}

impl Get for Canned {
    fn get(&self, url: &str) -> Result<Reply, String> {
        self.seen.borrow_mut().push(url.to_owned());
        let (status, location, body) = self
            .replies
            .get(url)
            .cloned()
            .ok_or_else(|| format!("no route {url}"))?;
        Ok(Reply {
            status,
            location,
            body: Box::new(Cursor::new(body)),
        })
    }
}

fn canned(routes: &[(&str, u16, Option<&str>, &[u8])]) -> Canned {
    Canned {
        replies: routes
            .iter()
            .map(|(u, s, l, b)| ((*u).to_owned(), (*s, l.map(str::to_owned), b.to_vec())))
            .collect(),
        seen: RefCell::new(vec![]),
    }
}

#[test]
fn downloads_follow_only_https_redirects_to_allowed_hosts() {
    let t = Tmp::new("dl");
    let dest = t.path().join("f");
    let hosts = vec!["nodejs.org".to_owned()];
    let ok = canned(&[
        ("https://nodejs.org/a", 302, Some("/b"), b""),
        ("https://nodejs.org/b", 200, None, b"hello"),
    ]);
    let (n, digest) = download(&ok, "https://nodejs.org/a", &hosts, 100, &dest).unwrap();
    assert_eq!((n, digest.as_str()), (5, sha256_hex(b"hello").as_str()));
    assert_eq!(std::fs::read(&dest).unwrap(), b"hello");

    for (label, routes, url, code) in [
        (
            "redirect to another host",
            vec![(
                "https://nodejs.org/a",
                302,
                Some("https://evil.example/x"),
                &b""[..],
            )],
            "https://nodejs.org/a",
            "download-refused",
        ),
        (
            "redirect to http",
            vec![(
                "https://nodejs.org/a",
                302,
                Some("http://nodejs.org/x"),
                &b""[..],
            )],
            "https://nodejs.org/a",
            "download-refused",
        ),
        (
            "redirect without a target",
            vec![("https://nodejs.org/a", 302, None, &b""[..])],
            "https://nodejs.org/a",
            "download-refused",
        ),
        (
            "a redirect loop",
            vec![("https://nodejs.org/a", 302, Some("/a"), &b""[..])],
            "https://nodejs.org/a",
            "download-refused",
        ),
        (
            "plain http",
            vec![],
            "http://nodejs.org/a",
            "download-refused",
        ),
        (
            "a host that is not allowed",
            vec![],
            "https://other.example/a",
            "download-refused",
        ),
        (
            "userinfo smuggling",
            vec![],
            "https://nodejs.org@evil.example/a",
            "download-refused",
        ),
        (
            "not found",
            vec![("https://nodejs.org/a", 404, None, &b""[..])],
            "https://nodejs.org/a",
            "download-failed",
        ),
        (
            "transport error",
            vec![],
            "https://nodejs.org/a",
            "download-failed",
        ),
    ] {
        let c = canned(&routes);
        let e = download(&c, url, &hosts, 100, &dest).unwrap_err();
        assert_eq!(e.code, code, "{label}");
        assert!(!dest.exists(), "{label}: no file is left");
    }
    let big = canned(&[("https://nodejs.org/a", 200, None, &[7u8; 200][..])]);
    assert_eq!(
        download(&big, "https://nodejs.org/a", &hosts, 100, &dest)
            .unwrap_err()
            .code,
        "download-failed"
    );
    assert!(!dest.exists());
}

#[test]
fn the_runtime_commands_verify_install_and_report_with_exit_codes() {
    use flagship_updater::cli::run;
    let f = fixture();
    let d = f.dir.path();
    let lock_path = d.join("lock.json");
    // The lock the fixture parsed, as the text it was parsed from.
    let t = f.lock.target("linux-amd64").unwrap();
    let key_armored = f.key.armored();
    let lock_json = json!({
        "schema": 1, "runtime": "node", "version": "24.22.1", "securityFloor": "24.22.1",
        "upstream": {"base": "https://nodejs.org/dist/v24.22.1/", "shasums": "SHASUMS256.txt", "shasumsSignature": "SHASUMS256.txt.sig", "allowedHosts": ["nodejs.org"]},
        "keyring": {"signers": [{"fingerprint": f.key.fingerprint(), "armored": key_armored}]},
        "targets": {"linux-amd64": {"file": t.file, "bytes": t.bytes, "sha256": t.sha256, "executable": "bin/node", "executableBytes": t.executable_bytes, "executableSha256": t.executable_sha256}}
    });
    std::fs::write(&lock_path, lock_json.to_string()).unwrap();
    let (sums, sig) = (d.join("SHASUMS256.txt"), d.join("SHASUMS256.txt.sig"));
    std::fs::write(&sums, &f.shasums).unwrap();
    std::fs::write(&sig, &f.sig).unwrap();
    let rt = d.join("rt");
    let s = |v: &[&str]| v.iter().map(|x| (*x).to_owned()).collect::<Vec<_>>();
    let call = |a: Vec<String>| {
        let (mut o, mut e) = (Vec::new(), Vec::new());
        let c = run(&a, &mut o, &mut e);
        (
            c,
            String::from_utf8(o).unwrap(),
            String::from_utf8(e).unwrap(),
        )
    };
    let base = |sub: &str| {
        s(&[
            "runtime",
            sub,
            "--lock",
            lock_path.to_str().unwrap(),
            "--target",
            "linux-amd64",
            "--runtimes",
            rt.to_str().unwrap(),
        ])
    };
    let with_files = |sub: &str| {
        let mut a = base(sub);
        a.extend(s(&[
            "--archive",
            f.archive.to_str().unwrap(),
            "--shasums",
            sums.to_str().unwrap(),
            "--shasums-sig",
            sig.to_str().unwrap(),
        ]));
        a
    };
    let (c, out, _) = call(with_files("verify"));
    assert_eq!(c, 0);
    assert!(out.starts_with("verified: node 24.22.1 linux-amd64 signed by "));
    let (c, out, _) = call(with_files("install"));
    assert_eq!((c, out.starts_with("installed: ")), (0, true));
    let (c, out, _) = call(base("status"));
    assert_eq!(c, 0);
    let v: Value = serde_json::from_str(out.trim()).unwrap();
    assert_eq!(
        (v["installed"].as_bool(), v["matchesLock"].as_bool()),
        (Some(true), Some(true))
    );
    // a tampered list is refused with exit 1 and the refusal on stderr
    std::fs::write(&sums, b"tampered").unwrap();
    let (c, _, e) = call(with_files("verify"));
    assert_eq!(
        (c, e.trim()),
        (
            1,
            "refused: upstream-signature (no signer in the lock verified it)"
        )
    );
    // usage errors
    assert_eq!(call(s(&["runtime"])).0, 2);
    assert_eq!(call(s(&["runtime", "verify"])).0, 2);
    assert_eq!(call(base("frobnicate")).0, 2);
}

fn serving(f: &Fx) -> Canned {
    let t = f.lock.target("linux-amd64").unwrap();
    let gz = std::fs::read(&f.archive).unwrap();
    canned(&[
        (&f.lock.archive_url(t), 200, None, &gz),
        (&f.lock.shasums_url(), 200, None, &f.shasums),
        (&f.lock.signature_url(), 200, None, &f.sig),
    ])
}

#[test]
fn a_cold_fetch_fills_the_cache_and_an_offline_box_installs_from_it() {
    use flagship_updater::runtime::fetch::fetch_into_cache;
    let f = fixture();
    let t = f.lock.target("linux-amd64").unwrap();
    let cache = f.dir.path().join("cache");
    let online = serving(&f);
    let c = fetch_into_cache(&online, &f.lock, t, &cache).unwrap();
    assert_eq!(
        c.archive.file_name().unwrap().to_str().unwrap(),
        format!("{}.tar.gz", t.sha256)
    );
    assert_eq!(online.seen.borrow().len(), 3);
    // offline: nothing answers, the cache serves
    let offline = canned(&[]);
    let again = fetch_into_cache(&offline, &f.lock, t, &cache).unwrap();
    assert_eq!(std::fs::read(&again.shasums).unwrap(), f.shasums);
    let i = install(
        &f.lock,
        t,
        &again.archive,
        &std::fs::read(&again.shasums).unwrap(),
        &std::fs::read(&again.signature).unwrap(),
        &f.dir.path().join("rt"),
    )
    .unwrap();
    assert!(i.new);
    // the archive is not downloaded again while it is cached and matches
    let counting = serving(&f);
    fetch_into_cache(&counting, &f.lock, t, &cache).unwrap();
    assert!(
        !counting
            .seen
            .borrow()
            .iter()
            .any(|u| u.ends_with(".tar.gz"))
    );
}

#[test]
fn offline_with_an_empty_cache_fails_without_touching_anything() {
    use flagship_updater::runtime::fetch::fetch_into_cache;
    let f = fixture();
    let t = f.lock.target("linux-amd64").unwrap();
    let e = fetch_into_cache(&canned(&[]), &f.lock, t, &f.dir.path().join("cache")).unwrap_err();
    assert_eq!(e.code, "download-failed");
}

#[test]
fn a_poisoned_cache_entry_is_replaced_and_a_wrong_download_is_refused() {
    use flagship_updater::runtime::fetch::fetch_into_cache;
    let f = fixture();
    let t = f.lock.target("linux-amd64").unwrap();
    let cache = f.dir.path().join("cache");
    std::fs::create_dir_all(&cache).unwrap();
    std::fs::write(cache.join(format!("{}.tar.gz", t.sha256)), b"poison").unwrap();
    let c = fetch_into_cache(&serving(&f), &f.lock, t, &cache).unwrap();
    assert_eq!(
        std::fs::read(&c.archive).unwrap(),
        std::fs::read(&f.archive).unwrap()
    );
    // a mirror that serves other bytes under the right name
    let evil = Tmp::new("rt-evil-cache");
    let bad = canned(&[
        (&f.lock.archive_url(t), 200, None, b"not node"),
        (&f.lock.shasums_url(), 200, None, &f.shasums),
        (&f.lock.signature_url(), 200, None, &f.sig),
    ]);
    let e = fetch_into_cache(&bad, &f.lock, t, evil.path()).unwrap_err();
    assert_eq!(e.code, "checksum-mismatch");
    assert!(!evil.path().join(format!("{}.tar.gz", t.sha256)).exists());
}

#[test]
fn replayed_metadata_from_another_release_cannot_be_used_for_this_one() {
    use flagship_updater::runtime::fetch::fetch_into_cache;
    let f = fixture();
    let t = f.lock.target("linux-amd64").unwrap();
    // an old, validly signed list that names other files
    let old = format!("{}  node-v20.0.0-linux-x64.tar.gz\n", "4".repeat(64)).into_bytes();
    let gz = std::fs::read(&f.archive).unwrap();
    let replay = canned(&[
        (&f.lock.archive_url(t), 200, None, &gz),
        (&f.lock.shasums_url(), 200, None, &old),
        (&f.lock.signature_url(), 200, None, &f.key.sign(&old)),
    ]);
    let c = fetch_into_cache(&replay, &f.lock, t, &f.dir.path().join("cache")).unwrap();
    let e = install(
        &f.lock,
        t,
        &c.archive,
        &std::fs::read(&c.shasums).unwrap(),
        &std::fs::read(&c.signature).unwrap(),
        &f.dir.path().join("rt"),
    )
    .unwrap_err();
    assert_eq!(e.code, "checksum-missing");
}
