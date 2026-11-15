use std::fs;
use std::os::unix::fs::PermissionsExt;

use flagship_keyd::files::{read_key_file, reset_state};

#[test]
fn reset_leaves_only_a_fresh_identity() {
    let dir = std::env::temp_dir().join(format!("keyd-reset-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(dir.join("tls")).unwrap();
    for f in ["identity.key", "identity-mldsa.key", "swk.key", "cgk.key"] {
        fs::write(dir.join(f), format!("{}\n", "11".repeat(32))).unwrap();
        fs::set_permissions(dir.join(f), fs::Permissions::from_mode(0o400)).unwrap();
    }
    for f in [
        "policy.json",
        "owner.json",
        "audit.log",
        "revocations.json",
        "acme-account.key",
    ] {
        fs::write(dir.join(f), "{\"previous\":\"owner\"}").unwrap();
    }
    fs::write(dir.join("tls").join("old.key"), "old").unwrap();

    reset_state(&dir).unwrap();
    let mut names: Vec<String> = fs::read_dir(&dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().into_string().unwrap())
        .collect();
    names.sort();
    assert_eq!(names, vec!["identity-mldsa.key", "identity.key"]);
    let id = read_key_file(&dir.join("identity.key")).unwrap().unwrap();
    let pq = read_key_file(&dir.join("identity-mldsa.key"))
        .unwrap()
        .unwrap();
    assert_ne!(*id, [0x11u8; 32]);
    assert_ne!(*id, *pq);
    for f in ["identity.key", "identity-mldsa.key"] {
        let mode = fs::metadata(dir.join(f)).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o400);
    }

    reset_state(&dir).unwrap();
    let again = read_key_file(&dir.join("identity.key")).unwrap().unwrap();
    assert_ne!(*again, *id);
    fs::remove_dir_all(&dir).unwrap();
}
