//! The access writes behind the socket (release plan R4): the account people, entry application, the store's
//! other changes and the access journal, each read from and (when authoritative) written to the box's own files.
//!
//! Two ways to ask:
//! - authoritative (`dryRun` absent or false): the state is the file; the change is written durably (temporary
//!   file, fsync, rename, directory fsync), keeping the file's owner and mode, and the new state is returned so
//!   the daemon's read copy follows. One writer at a time per file.
//! - shadow (`dryRun: true` with the daemon's own `state`/`journal` text): nothing is written; the result and the
//!   state after it are returned for the daemon to compare with its own.
//!
//! The anchors come from the caller (its boot resolution of config, rotation chain and re-home); the people are
//! always read here from the device book, the revocations and the share list.

use crate::access_journal::{AccessJournal, parse_entry};
use crate::apply::{EntryResult, Facts, admissible, apply_entry};
use crate::people::{Anchors, People};
use crate::store::{CoManagerRecord, RoleTarget, Store};
use serde_json::{Number, Value, json};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// Where the box keeps what the writes read and write.
#[derive(Debug)]
pub struct WritePaths {
    pub state: PathBuf,
    pub journal: PathBuf,
    pub book: PathBuf,
    pub revocations: PathBuf,
    pub shares: PathBuf,
    /// One writer at a time for the state file and the journal.
    pub lock: Mutex<()>,
    /// The people last verified, keyed by the anchors and the three files' size and time: a decision per request
    /// re-verifies the book and the shares only when one of them changed.
    people_cache: Mutex<Option<(String, People)>>,
}

impl WritePaths {
    #[must_use]
    pub fn new(
        state: PathBuf,
        journal: PathBuf,
        book: PathBuf,
        revocations: PathBuf,
        shares: PathBuf,
    ) -> Self {
        Self {
            state,
            journal,
            book,
            revocations,
            shares,
            lock: Mutex::new(()),
            people_cache: Mutex::new(None),
        }
    }
}

fn read_optional(p: &Path) -> Result<Option<String>, String> {
    match fs::read_to_string(p) {
        Ok(t) => Ok(Some(t)),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("{}: {e}", p.display())),
    }
}

/// Write `text` to `path` durably, keeping an existing file's owner and mode (0600 for a new one).
///
/// # Errors
/// Any I/O failure; the old file is then untouched.
pub fn write_durable(path: &Path, text: &str) -> io::Result<()> {
    let dir = path.parent().unwrap_or(Path::new("."));
    let meta = fs::metadata(path).ok();
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("state");
    let tmp = dir.join(format!(".{name}.{}.tmp", std::process::id()));
    let mode = meta.as_ref().map_or(0o600, |m| m.mode() & 0o777);
    {
        let mut f = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(mode)
            .open(&tmp)?;
        f.write_all(text.as_bytes())?;
        f.sync_all()?;
        // Root writes for the daemon's account: the daemon must still read (and, under TypeScript, write) it. A new
        // file takes its folder's owner (the daemon's), as the old one's would.
        let owner = meta.or_else(|| fs::metadata(dir).ok());
        if let Some(m) = &owner {
            let _ = std::os::unix::fs::fchown(&f, Some(m.uid()), Some(m.gid()));
        }
    }
    fs::rename(&tmp, path).inspect_err(|_| {
        let _ = fs::remove_file(&tmp);
    })?;
    File::open(dir)?.sync_all()
}

fn now_ms() -> u64 {
    crate::now_ms()
}

/// The people from the box's files.
///
/// # Errors
/// The anchors are missing or malformed.
pub fn people(p: &WritePaths, a: &Value) -> Result<People, String> {
    let raw = a.get("anchors").unwrap_or(&Value::Null);
    let anchors = Anchors::from_json(raw).ok_or("anchors are required")?;
    let stamp = |f: &Path| {
        fs::metadata(f).map_or_else(
            |_| "-".to_owned(),
            |m| format!("{}.{}.{}", m.len(), m.mtime(), m.mtime_nsec()),
        )
    };
    let key = format!(
        "{raw}|{}|{}|{}",
        stamp(&p.book),
        stamp(&p.revocations),
        stamp(&p.shares)
    );
    if let Ok(c) = p.people_cache.lock()
        && let Some((k, people)) = c.as_ref()
        && *k == key
    {
        return Ok(people.clone());
    }
    let people = People::from_files(
        anchors,
        read_optional(&p.book).ok().flatten().as_deref(),
        read_optional(&p.revocations).ok().flatten().as_deref(),
        read_optional(&p.shares).ok().flatten().as_deref(),
        true,
    );
    if let Ok(mut c) = p.people_cache.lock() {
        *c = Some((key, people.clone()));
    }
    Ok(people)
}

fn strings(v: Option<&Value>) -> Vec<String> {
    v.and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

fn dry(a: &Value) -> bool {
    a.get("dryRun").and_then(Value::as_bool) == Some(true)
}

/// The state to change: the daemon's text in a dry run, else the file.
fn load_store(p: &WritePaths, a: &Value) -> Result<Store, String> {
    let text = if dry(a) {
        a.get("state").and_then(Value::as_str).map(str::to_owned)
    } else {
        read_optional(&p.state)?
    };
    Store::parse(text.as_deref())
        .map_err(|_| "the access state is unreadable: nothing is changed".to_owned())
}

fn finish_store(
    p: &WritePaths,
    a: &Value,
    before: &Store,
    after: &Store,
    result: Value,
) -> Result<Value, String> {
    let state = after.to_json();
    if !dry(a) && before != after {
        write_durable(&p.state, &state.to_string())
            .map_err(|e| format!("{}: {e}", p.state.display()))?;
    }
    Ok(json!({ "result": result, "state": state }))
}

/// `apply-entry`: verify and apply one handed-over entry.
///
/// # Errors
/// Missing arguments, unreadable state, or a failed write.
pub fn handle_apply_entry(p: &WritePaths, a: &Value) -> Result<Value, String> {
    let people = people(p, a)?;
    let r = a
        .get("serviceRef")
        .and_then(Value::as_str)
        .ok_or("serviceRef is required")?;
    let catching = strings(a.get("catchingUp"));
    let f = Facts {
        installed: a.get("installed").and_then(Value::as_bool) == Some(true),
        catching_up: &catching,
        now_ms: a.get("now").and_then(Value::as_u64).unwrap_or_else(now_ms),
    };
    let _g = p.lock.lock().map_err(|_| "lock poisoned")?;
    let before = load_store(p, a)?;
    let mut store = before.clone();
    let result = match a.get("entry").and_then(parse_entry) {
        Some(e) => apply_entry(&mut store, &people, &f, r, &e),
        None => EntryResult::Refused,
    };
    finish_store(p, a, &before, &store, json!(result.as_str()))
}

fn text<'a>(a: &'a Value, k: &str) -> Result<&'a str, String> {
    a.get(k)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("{k} is required"))
}

fn int(a: &Value, k: &str) -> Result<u64, String> {
    a.get(k)
        .and_then(Value::as_u64)
        .ok_or_else(|| format!("{k} is required"))
}

/// `store-mutate`: one of the store's own changes, as the daemon's handlers make them after their own checks.
///
/// # Errors
/// An unknown method, missing arguments, unreadable state, or a failed write.
pub fn handle_store_mutate(p: &WritePaths, a: &Value) -> Result<Value, String> {
    let m = text(a, "method")?;
    let x = a.get("args").cloned().unwrap_or(Value::Null);
    let _g = p.lock.lock().map_err(|_| "lock poisoned")?;
    let before = load_store(p, a)?;
    let mut s = before.clone();
    let r = || text(&x, "serviceRef");
    let result: Value = match m {
        "forget" => json!(s.forget(r()?)),
        "setMode" => {
            s.set_mode(r()?, text(&x, "mode")? == "restricted");
            Value::Null
        }
        "applyModeOrder" => json!(s.apply_mode_order(
            r()?,
            text(&x, "mode")? == "restricted",
            int(&x, "issuedAt")?
        )),
        "applyRemoveOrder" => {
            json!(s.apply_remove_order(r()?, text(&x, "aid")?, int(&x, "issuedAt")?))
        }
        "addAllowed" => json!(s.add_allowed(
            r()?,
            text(&x, "aid")?,
            x.get("inviteId").and_then(Value::as_str)
        )),
        "removeAllowed" => json!(s.remove_allowed(r()?, text(&x, "aid")?)),
        "removeIfUngranted" => json!(s.remove_if_ungranted(r()?, text(&x, "aid")?)),
        "revokeGroup" => json!(s.revoke_group(
            text(&x, "inviteId")?,
            x.get("serviceRef").and_then(Value::as_str)
        )),
        "noteWithdrawn" => {
            s.note_withdrawn(
                r()?,
                text(&x, "inviteId")?,
                int(&x, "issuedAt")?,
                text(&x, "signature")?,
            );
            Value::Null
        }
        "setInviteTier" => {
            s.set_invite_tier(r()?, text(&x, "inviteId")?, text(&x, "tier")?);
            Value::Null
        }
        "setInviteCreator" => {
            s.set_invite_creator(r()?, text(&x, "inviteId")?, text(&x, "pub")?);
            Value::Null
        }
        "setRole" => {
            let t = x.get("target").ok_or("target is required")?;
            let target = match t.get("kind").and_then(Value::as_str) {
                Some("aid") => RoleTarget::Aid(text(t, "aid")?.to_owned()),
                Some("invite") => RoleTarget::Invite(text(t, "inviteId")?.to_owned()),
                Some("grant") => {
                    RoleTarget::Grant(text(t, "inviteId")?.to_owned(), text(t, "aid")?.to_owned())
                }
                _ => return Err("target kind".into()),
            };
            json!(s.set_role(
                r()?,
                &target,
                text(&x, "targetKey")?,
                text(&x, "role")?,
                int(&x, "issuedAt")?,
                x.get("evidence").and_then(Value::as_str)
            ))
        }
        "setAccountRank" => json!(s.set_account_rank(
            r()?,
            text(&x, "targetKey")?,
            text(&x, "rank")?,
            int(&x, "issuedAt")?,
            x.get("evidence").and_then(Value::as_str)
        )),
        "noteCoManager" => {
            let rec = x.get("rec").ok_or("rec is required")?;
            let issued = match rec.get("issuedAt") {
                Some(Value::Number(n)) => n.clone(),
                _ => Number::from(0u8),
            };
            json!(
                s.note_co_manager(
                    r()?,
                    text(&x, "shareId")?,
                    CoManagerRecord {
                        pub_hex: text(rec, "pub")?.to_owned(),
                        level: text(rec, "level")?.to_owned(),
                        label: rec
                            .get("label")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_owned(),
                        server_domain: text(rec, "serverDomain")?.to_owned(),
                        issued_at: issued,
                        ended: rec.get("ended").and_then(Value::as_bool) == Some(true),
                    }
                )
            )
        }
        "importEntry" => {
            s.import_entry(r()?, x.get("entry").ok_or("entry is required")?);
            Value::Null
        }
        _ => return Err(format!("unknown store method {m}")),
    };
    finish_store(p, a, &before, &s, result)
}

fn load_journal(p: &WritePaths, a: &Value) -> Result<AccessJournal, String> {
    let mut j = AccessJournal::new();
    if dry(a) {
        j.load(a.get("journal").and_then(Value::as_str));
        return Ok(j);
    }
    let text = read_optional(&p.journal)?;
    j.load(text.as_deref());
    if j.was_lost() {
        return Err(
            "the access journal is unreadable: nothing is kept until the daemon set it aside"
                .into(),
        );
    }
    Ok(j)
}

fn app_json(j: &AccessJournal, r: &str) -> Value {
    json!({
        "entries": Value::Object(j.keys(r).into_iter().zip(j.entries(r)).map(|(k, e)| (k.to_owned(), e.as_json().clone())).collect()),
        "peers": j.peers(r),
        "digest": j.digest(r),
    })
}

fn finish_journal(
    p: &WritePaths,
    a: &Value,
    changed: bool,
    j: &AccessJournal,
    r: &str,
    result: Value,
) -> Result<Value, String> {
    if changed && !dry(a) {
        write_durable(&p.journal, &j.to_json())
            .map_err(|e| format!("{}: {e}", p.journal.display()))?;
    }
    Ok(json!({ "result": result, "app": app_json(j, r) }))
}

/// `journal-add`: keep an entry whose proof verifies here (one per key, the newer order wins).
///
/// # Errors
/// Missing arguments, an unreadable journal or state, or a failed write.
pub fn handle_journal_add(p: &WritePaths, a: &Value) -> Result<Value, String> {
    let people = people(p, a)?;
    let r = text(a, "serviceRef")?;
    let catching = strings(a.get("catchingUp"));
    let f = Facts {
        installed: a.get("installed").and_then(Value::as_bool) == Some(true),
        catching_up: &catching,
        now_ms: a.get("now").and_then(Value::as_u64).unwrap_or_else(now_ms),
    };
    let _g = p.lock.lock().map_err(|_| "lock poisoned")?;
    let mut j = load_journal(p, a)?;
    let store = if dry(a) {
        Store::parse(a.get("state").and_then(Value::as_str)).unwrap_or_default()
    } else {
        Store::parse(read_optional(&p.state)?.as_deref())
            .map_err(|_| "the access state is unreadable".to_owned())?
    };
    let Some(e) = a.get("entry").and_then(parse_entry) else {
        return finish_journal(p, a, false, &j, r, json!("malformed"));
    };
    if !admissible(&store, &people, &f, r, &e) {
        return finish_journal(p, a, false, &j, r, json!("unverified"));
    }
    let kept = j.add(r, e);
    finish_journal(p, a, kept, &j, r, json!(if kept { "kept" } else { "held" }))
}

/// `journal-note-peers`: remember the other servers running an app.
///
/// # Errors
/// Missing arguments, an unreadable journal, or a failed write.
pub fn handle_journal_peers(p: &WritePaths, a: &Value) -> Result<Value, String> {
    let r = text(a, "serviceRef")?;
    let fqdns = strings(a.get("fqdns"));
    let _g = p.lock.lock().map_err(|_| "lock poisoned")?;
    let mut j = load_journal(p, a)?;
    let refs: Vec<&str> = fqdns.iter().map(String::as_str).collect();
    let changed = j.note_peers(r, &refs);
    finish_journal(p, a, changed, &j, r, json!(changed))
}

/// `journal-forget`: drop an uninstalled app's entries.
///
/// # Errors
/// Missing arguments, an unreadable journal, or a failed write.
pub fn handle_journal_forget(p: &WritePaths, a: &Value) -> Result<Value, String> {
    let r = text(a, "serviceRef")?;
    let _g = p.lock.lock().map_err(|_| "lock poisoned")?;
    let mut j = load_journal(p, a)?;
    let changed = j.forget(r);
    finish_journal(p, a, changed, &j, r, json!(changed))
}

/// `people`: the account people as this side verified them.
///
/// # Errors
/// The anchors are missing.
pub fn handle_people(p: &WritePaths, a: &Value) -> Result<Value, String> {
    Ok(people(p, a)?.to_json())
}
