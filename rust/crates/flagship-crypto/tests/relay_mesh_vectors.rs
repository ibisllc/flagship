//! `relay_mesh` against the TypeScript-produced vectors in `packages/protocol/test-vectors/relay-mesh/vectors.json`
//! (tools/relay-mesh-vectors.ts): byte-identical canonical forms and signatures, the same refusals, the same log
//! state, the same routing answers.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects,
    clippy::panic,
    clippy::too_many_lines
)]

use ed25519_dalek::SigningKey;
use flagship_crypto::relay_mesh::{
    self as m, AccountMove, AttachmentHolder, AttachmentItem, AttachmentKind, BoxAttachment,
    BridgeAuth, BridgeAuthCheck, HomeAttachment, MeshAuth, MeshCheckContext, MeshItem, MoveHint,
    MoveHintCheck, MoveHintRateState, PhoneItem, PhoneRouteGrant, RebalanceRelay, RebalanceWindow,
    RelayBlessing, RelayBlessingBody, RelayBlessingRequest, RelayDirectory, RelayDirectoryBody,
    RelayDirectoryEntry, RelayKind, RelayLogApply, RelayLogEntry, RelayLogHead, RelayLogState,
    RelayWithdraw,
};
use flagship_crypto::serving::{
    Grace, OnLapse, PolicyHead, RevocationState, ServingDecision, ServingInput, ServingLease,
    ServingPolicy, SignedLease, serving_decision_at_head,
};
use serde_json::{Value, json};
use std::cmp::Ordering;
use std::collections::BTreeMap;

const VECTORS: &str =
    include_str!("../../../../packages/protocol/test-vectors/relay-mesh/vectors.json");

fn v() -> Value {
    serde_json::from_str(VECTORS).unwrap()
}
fn s(v: &Value, k: &str) -> String {
    v[k].as_str()
        .unwrap_or_else(|| panic!("{k} not a string in {v}"))
        .to_owned()
}
fn n(v: &Value, k: &str) -> u64 {
    v[k].as_u64()
        .unwrap_or_else(|| panic!("{k} not a u64 in {v}"))
}
fn on(v: &Value, k: &str) -> Option<u64> {
    v.get(k).and_then(Value::as_u64)
}
fn strs(v: &Value) -> Vec<String> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|x| x.as_str().unwrap().to_owned())
        .collect()
}
fn res(r: Result<(), &str>) -> Value {
    match r {
        Ok(()) => json!({"ok": true}),
        Err(reason) => json!({"ok": false, "reason": reason}),
    }
}
fn sign_key(v: &Value, name: &str) -> SigningKey {
    let seed: [u8; 32] = (0..32)
        .map(|i| {
            u8::from_str_radix(
                &v["keys"][name]["seed"].as_str().unwrap()[i * 2..i * 2 + 2],
                16,
            )
            .unwrap()
        })
        .collect::<Vec<u8>>()
        .try_into()
        .unwrap();
    SigningKey::from_bytes(&seed)
}

fn kind(v: &Value) -> RelayKind {
    RelayKind::parse(v.as_str().unwrap()).unwrap()
}
fn sigs(v: &Value) -> Vec<(String, String)> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|e| (s(e, "pubkey"), s(e, "sig")))
        .collect()
}
fn blessing(v: &Value) -> RelayBlessing {
    RelayBlessing {
        body: RelayBlessingBody {
            relay_id: s(v, "relayId"),
            relay_key: s(v, "relayKey"),
            services_apex: s(v, "servicesApex"),
            tunnel_host: s(v, "tunnelHost"),
            relay_kind: kind(&v["relayKind"]),
            nonce: s(v, "nonce"),
            issued_at: n(v, "issuedAt"),
            expires_at: n(v, "expiresAt"),
        },
        signed_by: s(v, "signedBy"),
        signatures: sigs(&v["signatures"]),
    }
}
fn blessing_body_loose(v: &Value) -> Option<RelayBlessingBody> {
    Some(RelayBlessingBody {
        relay_id: s(v, "relayId"),
        relay_key: s(v, "relayKey"),
        services_apex: s(v, "servicesApex"),
        tunnel_host: s(v, "tunnelHost"),
        relay_kind: RelayKind::parse(v["relayKind"].as_str()?).ok()?,
        nonce: s(v, "nonce"),
        issued_at: n(v, "issuedAt"),
        expires_at: n(v, "expiresAt"),
    })
}
fn dir_entry(v: &Value) -> RelayDirectoryEntry {
    RelayDirectoryEntry {
        relay_id: s(v, "relayId"),
        relay_key: s(v, "relayKey"),
        tunnel_host: s(v, "tunnelHost"),
        relay_kind: kind(&v["relayKind"]),
        region: s(v, "region"),
        ipv4: strs(&v["ipv4"]),
        ipv6: strs(&v["ipv6"]),
    }
}
fn dir_body(v: &Value) -> RelayDirectoryBody {
    RelayDirectoryBody {
        services_apex: s(v, "servicesApex"),
        directory_version: n(v, "directoryVersion"),
        issued_at: n(v, "issuedAt"),
        expires_at: n(v, "expiresAt"),
        relays: v["relays"]
            .as_array()
            .unwrap()
            .iter()
            .map(dir_entry)
            .collect(),
    }
}
fn directory(v: &Value) -> RelayDirectory {
    RelayDirectory {
        body: dir_body(v),
        signed_by: s(v, "signedBy"),
        signatures: sigs(&v["signatures"]),
    }
}
fn log_entry(v: &Value) -> RelayLogEntry {
    RelayLogEntry {
        sequence: n(v, "sequence"),
        kind: s(v, "kind"),
        at: n(v, "at"),
        f1: s(v, "f1"),
        f2: s(v, "f2"),
        f3: s(v, "f3"),
        f4: s(v, "f4"),
    }
}
fn head(v: &Value) -> RelayLogHead {
    RelayLogHead {
        services_apex: s(v, "servicesApex"),
        sequence: n(v, "sequence"),
        tip_sha256: s(v, "tipSha256"),
        directory_version: n(v, "directoryVersion"),
        issued_at: n(v, "issuedAt"),
    }
}
fn attachment(v: &Value) -> BoxAttachment {
    BoxAttachment {
        server_fqdn: s(v, "serverFqdn"),
        box_pub: s(v, "boxPub"),
        reg_gen: n(v, "regGen"),
        relay_id: s(v, "relayId"),
        attached_at: n(v, "attachedAt"),
        issued_at: n(v, "issuedAt"),
        not_after: n(v, "notAfter"),
    }
}
fn attachment_item(v: &Value) -> AttachmentItem {
    AttachmentItem {
        kind: if v["kind"] == "box" {
            AttachmentKind::Box
        } else {
            AttachmentKind::Legacy
        },
        attachment: attachment(&v["attachment"]),
        signature: s(v, "signature"),
    }
}
fn withdraw(v: &Value) -> RelayWithdraw {
    RelayWithdraw {
        subject_kind: s(v, "subjectKind"),
        subject: s(v, "subject"),
        relay_id: s(v, "relayId"),
        withdrawn_issued_at: n(v, "withdrawnIssuedAt"),
        at: n(v, "at"),
    }
}
fn bridge_auth(v: &Value) -> BridgeAuth {
    BridgeAuth {
        role: s(v, "role"),
        signer_relay_id: s(v, "signerRelayId"),
        peer_relay_id: s(v, "peerRelayId"),
        server_nonce: s(v, "serverNonce"),
        client_nonce: s(v, "clientNonce"),
        at: n(v, "at"),
    }
}
fn move_hint(v: &Value) -> MoveHint {
    MoveHint {
        server_fqdn: s(v, "serverFqdn"),
        box_pub: s(v, "boxPub"),
        from_relay_id: s(v, "fromRelayId"),
        to_relay_id: s(v, "toRelayId"),
        reason: s(v, "reason"),
        issued_at: n(v, "issuedAt"),
        not_after: n(v, "notAfter"),
    }
}
fn account_move(v: &Value) -> AccountMove {
    AccountMove {
        account_hash: s(v, "accountHash"),
        from_relay_id: s(v, "fromRelayId"),
        to_relay_id: s(v, "toRelayId"),
        issued_at: n(v, "issuedAt"),
        not_after: n(v, "notAfter"),
    }
}
fn grant(v: &Value) -> PhoneRouteGrant {
    PhoneRouteGrant {
        hostname: s(v, "hostname"),
        phone_route_pub: s(v, "phoneRoutePub"),
        generation: n(v, "generation"),
        holder_relay_id: s(v, "holderRelayId"),
        ledger_relay_id: s(v, "ledgerRelayId"),
        issued_at: n(v, "issuedAt"),
        not_after: n(v, "notAfter"),
    }
}
fn phone_item(v: &Value) -> PhoneItem {
    PhoneItem {
        grant: grant(&v["grant"]),
        signature: s(v, "signature"),
    }
}
fn mesh_item(v: &Value) -> MeshItem {
    if v["kind"] == "phone" {
        MeshItem::Phone(phone_item(v))
    } else {
        MeshItem::Attachment(attachment_item(v))
    }
}
fn rate(v: &Value) -> MoveHintRateState {
    MoveHintRateState {
        last_locality_at: on(v, "lastLocalityAt"),
        co_locate_at: v["coLocateAt"]
            .as_array()
            .unwrap()
            .iter()
            .map(|x| x.as_u64().unwrap())
            .collect(),
        failed_targets: v["failedTargets"]
            .as_object()
            .unwrap()
            .iter()
            .map(|(k, t)| (k.clone(), t.as_u64().unwrap()))
            .collect(),
    }
}
fn rate_json(r: &MoveHintRateState) -> Value {
    json!({"lastLocalityAt": r.last_locality_at, "coLocateAt": r.co_locate_at, "failedTargets": r.failed_targets})
}
fn summary(st: &RelayLogState) -> Value {
    json!({
        "sequence": st.sequence,
        "tipSha256": st.tip_sha256,
        "boxesByName": st.boxes_by_name.iter().map(|(k, b)| (k.clone(), json!({"boxPub": b.box_pub, "regGen": b.reg_gen, "sequence": b.sequence}))).collect::<serde_json::Map<_, _>>(),
        "boxNames": st.box_names,
        "revokedBoxes": st.revoked_boxes,
        "authorities": st.authorities.iter().map(|(k, a)| (k.clone(), json!({"adminRootPub": a.admin_root_pub, "irkPub": a.irk_pub, "authorityGen": a.authority_gen, "sequence": a.sequence}))).collect::<serde_json::Map<_, _>>(),
        "policyHeads": st.policy_heads.iter().map(|(k, h)| (k.clone(), json!({"policyGen": h.policy_gen, "policySha256": h.policy_sha256, "sequence": h.sequence}))).collect::<serde_json::Map<_, _>>(),
        "revokedRenewalKeys": st.revoked_renewal_keys,
        "revokedGrants": st.revoked_grants,
        "revokedCerts": st.revoked_certs,
        "revokedRelays": st.revoked_relays,
    })
}
fn apply_json(r: &RelayLogApply) -> Value {
    match r {
        RelayLogApply::Applied { state, applied } => {
            json!({"ok": true, "applied": applied, "state": summary(state)})
        }
        RelayLogApply::Failed {
            reason,
            at,
            state,
            applied,
        } => {
            json!({"ok": false, "reason": reason, "at": at, "applied": applied, "state": summary(state)})
        }
    }
}

struct World {
    v: Value,
    apex: String,
    t0: u64,
    ca: Vec<String>,
    dir: RelayDirectoryBody,
    log: RelayLogState,
    entries: Vec<(RelayLogEntry, String)>,
}

impl World {
    fn new() -> Self {
        let v = v();
        let apex = s(&v, "servicesApex");
        let entries: Vec<(RelayLogEntry, String)> = v["log"]["entries"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| (log_entry(&e["entry"]), s(e, "signature")))
            .collect();
        let RelayLogApply::Applied { state, .. } = m::apply_relay_log(
            &RelayLogState::new(&apex).unwrap(),
            &entries,
            &s(&v, "logKey"),
        ) else {
            panic!("the vector log must apply")
        };
        World {
            t0: n(&v, "t0"),
            ca: strs(&v["caKeys"]),
            dir: dir_body(&v["directory"]["directory"]),
            log: state,
            entries,
            apex,
            v,
        }
    }
    fn ctx(&self, now: u64) -> MeshCheckContext<'_> {
        MeshCheckContext {
            services_apex: &self.apex,
            log: &self.log,
            directory: Some(&self.dir),
            now,
        }
    }
    fn checks(&self, k: &str) -> &Vec<Value> {
        self.v["checks"][k].as_array().unwrap()
    }
}

#[test]
fn constants_match() {
    let w = World::new();
    let ours: BTreeMap<&str, u64> = BTreeMap::from([
        (
            "ACCOUNT_MOVE_HINT_SPACING_MS",
            m::ACCOUNT_MOVE_HINT_SPACING_MS,
        ),
        (
            "ACCOUNT_MOVE_MIN_INTERVAL_MS",
            m::ACCOUNT_MOVE_MIN_INTERVAL_MS,
        ),
        ("ACCOUNT_MOVE_TTL_MS", m::ACCOUNT_MOVE_TTL_MS),
        ("ATTACH_RENEW_MS", m::ATTACH_RENEW_MS),
        ("ATTACH_TTL_MS", m::ATTACH_TTL_MS),
        ("BOX_DIRECTORY_MAX_AGE_MS", m::BOX_DIRECTORY_MAX_AGE_MS),
        ("BOX_RELAY_CHECK_MS", m::BOX_RELAY_CHECK_MS),
        (
            "DIRECTORY_EXPIRED_UNHEALTHY_MS",
            m::DIRECTORY_EXPIRED_UNHEALTHY_MS,
        ),
        ("DIRECTORY_REMINT_MS", m::DIRECTORY_REMINT_MS),
        ("DIRECTORY_TTL_MS", m::DIRECTORY_TTL_MS),
        ("FEED_HEAD_MINT_MS", m::FEED_HEAD_MINT_MS),
        ("FEED_PAGE_ENTRIES", m::FEED_PAGE_ENTRIES),
        ("FEED_POLL_MS", m::FEED_POLL_MS),
        ("HEAD_CLOSE_ALL_MS", m::HEAD_CLOSE_ALL_MS),
        ("HEAD_FRESH_MS", m::HEAD_FRESH_MS),
        ("HEAD_REFUSE_NEW_MS", m::HEAD_REFUSE_NEW_MS),
        ("LEGACY_ATTACH_WAIT_MS", m::LEGACY_ATTACH_WAIT_MS),
        ("LEGACY_RENEW_MS", m::LEGACY_RENEW_MS),
        ("LEGACY_TTL_MS", m::LEGACY_TTL_MS),
        ("MESH_ANNOUNCE_BATCH_MAX", m::MESH_ANNOUNCE_BATCH_MAX as u64),
        ("MESH_ANNOUNCE_DELAY_MS", m::MESH_ANNOUNCE_DELAY_MS),
        ("MESH_BACKOFF_MAX_MS", m::MESH_BACKOFF_MAX_MS),
        ("MESH_BACKOFF_MIN_MS", m::MESH_BACKOFF_MIN_MS),
        ("MESH_CLOCK_SKEW_MS", m::MESH_CLOCK_SKEW_MS),
        ("MESH_CONTROL_MAX_BYTES", m::MESH_CONTROL_MAX_BYTES as u64),
        ("MESH_DIAL_TIMEOUT_MS", m::MESH_DIAL_TIMEOUT_MS),
        ("MESH_HANDSHAKE_STEP_MS", m::MESH_HANDSHAKE_STEP_MS),
        ("MESH_LOAD_FRESH_MS", m::MESH_LOAD_FRESH_MS),
        ("MESH_LOAD_INTERVAL_MS", m::MESH_LOAD_INTERVAL_MS),
        ("MESH_LOG_PUSH_MAX", m::MESH_LOG_PUSH_MAX as u64),
        ("MESH_LOG_SINCE_MAX", m::MESH_LOG_SINCE_MAX as u64),
        ("MESH_NEG_CACHE_MAX", m::MESH_NEG_CACHE_MAX as u64),
        ("MESH_NEG_CACHE_MS", m::MESH_NEG_CACHE_MS),
        ("MESH_PEER_CUT_MS", m::MESH_PEER_CUT_MS),
        ("MESH_PEER_DOWN_MS", m::MESH_PEER_DOWN_MS),
        (
            "MESH_PEER_MAX_QUEUED_BYTES",
            m::MESH_PEER_MAX_QUEUED_BYTES as u64,
        ),
        ("MESH_PEER_MAX_STREAMS", m::MESH_PEER_MAX_STREAMS as u64),
        ("MESH_PEER_OPEN_BURST", u64::from(m::MESH_PEER_OPEN_BURST)),
        ("MESH_PEER_OPEN_RATE", u64::from(m::MESH_PEER_OPEN_RATE)),
        ("MESH_PEER_OVER_LIMIT_MS", m::MESH_PEER_OVER_LIMIT_MS),
        ("MESH_PEER_QUERY_BURST", u64::from(m::MESH_PEER_QUERY_BURST)),
        ("MESH_PEER_QUERY_RATE", u64::from(m::MESH_PEER_QUERY_RATE)),
        ("MESH_PING_MS", m::MESH_PING_MS),
        ("MESH_QUERY_TIMEOUT_MS", m::MESH_QUERY_TIMEOUT_MS),
        (
            "MESH_STORE_MAX_BOX_ITEMS",
            m::MESH_STORE_MAX_BOX_ITEMS as u64,
        ),
        (
            "MESH_STORE_MAX_PER_RELAY",
            m::MESH_STORE_MAX_PER_RELAY as u64,
        ),
        (
            "MESH_STORE_MAX_PHONE_ITEMS",
            m::MESH_STORE_MAX_PHONE_ITEMS as u64,
        ),
        (
            "MESH_STREAM_INITIAL_WINDOW",
            u64::from(m::MESH_STREAM_INITIAL_WINDOW),
        ),
        (
            "MOVE_COLOCATE_MAX_PER_DAY",
            m::MOVE_COLOCATE_MAX_PER_DAY as u64,
        ),
        ("MOVE_COLOCATE_MIN_MS", m::MOVE_COLOCATE_MIN_MS),
        ("MOVE_DIAL_TIMEOUT_MS", m::MOVE_DIAL_TIMEOUT_MS),
        ("MOVE_FAILED_TARGET_MS", m::MOVE_FAILED_TARGET_MS),
        ("MOVE_HINT_TTL_MS", m::MOVE_HINT_TTL_MS),
        ("MOVE_LOCALITY_MIN_MS", m::MOVE_LOCALITY_MIN_MS),
        ("MOVE_OLD_TUNNEL_GRACE_MS", m::MOVE_OLD_TUNNEL_GRACE_MS),
        ("PHONE_ROUTE_GRANT_TTL_MS", m::PHONE_ROUTE_GRANT_TTL_MS),
        ("REBALANCE_BUCKET_MS", m::REBALANCE_BUCKET_MS),
        ("REBALANCE_INTERVAL_MS", m::REBALANCE_INTERVAL_MS),
        ("REBALANCE_JITTER_MS", m::REBALANCE_JITTER_MS),
        ("REBALANCE_MAX_LOAD_TENTHS", m::REBALANCE_MAX_LOAD_TENTHS),
        ("REBALANCE_MIN_BYTES", m::REBALANCE_MIN_BYTES),
        ("REBALANCE_MIN_LEAD_TENTHS", m::REBALANCE_MIN_LEAD_TENTHS),
        ("REBALANCE_MIN_SHARE_TENTHS", m::REBALANCE_MIN_SHARE_TENTHS),
        ("REBALANCE_MIN_STREAMS", m::REBALANCE_MIN_STREAMS),
        ("REBALANCE_WINDOW_MS", m::REBALANCE_WINDOW_MS),
        ("RELAY_BLESSING_REFRESH_MS", m::RELAY_BLESSING_REFRESH_MS),
        ("RELAY_BLESSING_TTL_MS", m::RELAY_BLESSING_TTL_MS),
        ("RELAY_LOG_TIP_HISTORY", m::RELAY_LOG_TIP_HISTORY),
    ]);
    let theirs = w.v["constants"].as_object().unwrap();
    assert_eq!(theirs.len(), ours.len(), "the constant sets differ");
    for (k, val) in theirs {
        assert_eq!(ours.get(k.as_str()).copied(), val.as_u64(), "{k}");
    }
    assert_eq!(m::RELAY_LOG_ZERO_TIP, "0".repeat(64));
}

#[test]
fn hashes() {
    let w = World::new();
    for (k, f) in [
        ("nameHash", m::name_hash as fn(&str) -> _),
        ("accountHash", m::account_hash),
    ] {
        for c in w.v["hashes"][k].as_array().unwrap() {
            let input = s(c, "input");
            match (f(&input), c.get("output")) {
                (Ok(h), Some(o)) => assert_eq!(h, o.as_str().unwrap(), "{k}({input})"),
                (Err(_), None) => {}
                (got, _) => panic!("{k}({input}): {got:?}"),
            }
        }
    }
}

#[test]
fn records_are_byte_identical() {
    let w = World::new();
    for r in w.v["records"].as_array().unwrap() {
        let rec = &r["record"];
        let canonical = match r["kind"].as_str().unwrap() {
            "relay-blessing-request" => {
                m::relay_blessing_request_canonical(&RelayBlessingRequest {
                    relay_id: s(rec, "relayId"),
                    relay_key: s(rec, "relayKey"),
                    services_apex: s(rec, "servicesApex"),
                    issued_at: n(rec, "issuedAt"),
                })
            }
            "relay-log-head" => m::relay_log_head_canonical(&head(rec)),
            "relay-attachment" => m::box_attachment_canonical(&attachment(rec)),
            "relay-legacy-attachment" => m::legacy_attachment_canonical(&attachment(rec)),
            "relay-withdraw" => m::relay_withdraw_canonical(&withdraw(rec)),
            "relay-bridge-auth" => m::bridge_auth_canonical(&bridge_auth(rec)),
            "relay-move-hint" => m::move_hint_canonical(&move_hint(rec)),
            "relay-account-move" => m::account_move_canonical(&account_move(rec)),
            "phone-route-grant" => m::phone_route_grant_canonical(&grant(rec)),
            other => panic!("unknown record kind {other}"),
        }
        .unwrap();
        assert_eq!(canonical, s(r, "canonical"), "{}", r["kind"]);
        let key = sign_key(&w.v, r["signer"].as_str().unwrap());
        assert_eq!(
            m::sign_canonical(&key, &canonical),
            s(r, "signature"),
            "{}",
            r["kind"]
        );
    }
    for b in w.v["blessings"].as_array().unwrap() {
        let bl = blessing(&b["blessing"]);
        let canonical = m::relay_blessing_canonical(&bl.body).unwrap();
        assert_eq!(canonical, s(b, "canonical"));
        assert_eq!(
            m::sign_canonical(&sign_key(&w.v, "ca"), &canonical),
            bl.signatures[0].1
        );
    }
    let d = &w.v["directory"];
    let lines: Vec<String> = w
        .dir
        .relays
        .iter()
        .map(|r| m::relay_directory_entry_line(r, &w.apex).unwrap())
        .collect();
    assert_eq!(lines, strs(&d["lines"]));
    assert_eq!(
        m::relay_directory_entries_sha256(&w.dir.relays, &w.apex).unwrap(),
        s(d, "entriesSha256")
    );
    assert_eq!(
        m::relay_directory_canonical(&w.dir).unwrap(),
        s(d, "canonical")
    );
}

#[test]
fn refuses_every_malformed_record() {
    let w = World::new();
    for c in w.v["canonicalErrors"].as_array().unwrap() {
        let r = &c["record"];
        let name = format!("{}: {}", c["kind"], c["name"]);
        let refused = match c["kind"].as_str().unwrap() {
            "relay-blessing" => {
                blessing_body_loose(r).is_none_or(|b| m::relay_blessing_canonical(&b).is_err())
            }
            "relay-blessing-request" => {
                m::relay_blessing_request_canonical(&RelayBlessingRequest {
                    relay_id: s(r, "relayId"),
                    relay_key: s(r, "relayKey"),
                    services_apex: s(r, "servicesApex"),
                    issued_at: n(r, "issuedAt"),
                })
                .is_err()
            }
            "relay-directory" => m::relay_directory_canonical(&dir_body(r)).is_err(),
            "relay-log" => {
                let apex = c.get("apex").and_then(Value::as_str).unwrap_or(&w.apex);
                m::relay_log_entry_canonical(apex, &log_entry(r)).is_err()
            }
            "relay-log-head" => m::relay_log_head_canonical(&head(r)).is_err(),
            "relay-attachment" => m::box_attachment_canonical(&attachment(r)).is_err(),
            "relay-legacy-attachment" => m::legacy_attachment_canonical(&attachment(r)).is_err(),
            "relay-withdraw" => m::relay_withdraw_canonical(&withdraw(r)).is_err(),
            "relay-bridge-auth" => m::bridge_auth_canonical(&bridge_auth(r)).is_err(),
            "relay-move-hint" => m::move_hint_canonical(&move_hint(r)).is_err(),
            "relay-account-move" => m::account_move_canonical(&account_move(r)).is_err(),
            "phone-route-grant" => m::phone_route_grant_canonical(&grant(r)).is_err(),
            other => panic!("unknown kind {other}"),
        };
        assert!(refused, "{name} must be refused");
    }
}

#[test]
fn applies_the_log_like_ts() {
    let w = World::new();
    let log = &w.v["log"];
    for e in log["entries"].as_array().unwrap() {
        let entry = log_entry(&e["entry"]);
        assert_eq!(
            m::relay_log_entry_canonical(&w.apex, &entry).unwrap(),
            s(e, "canonical")
        );
        assert_eq!(
            m::relay_log_entry_hash(&w.apex, &entry).unwrap(),
            s(e, "hash")
        );
        let body = m::parse_relay_log_entry(&entry).unwrap();
        assert_eq!(
            m::make_relay_log_entry(entry.sequence, entry.at, &body).unwrap(),
            entry
        );
        let canonical = m::relay_log_entry_canonical(&w.apex, &entry).unwrap();
        assert_eq!(
            m::sign_canonical(&sign_key(&w.v, "log"), &canonical),
            s(e, "signature")
        );
    }
    let empty = RelayLogState::new(&w.apex).unwrap();
    let RelayLogApply::Applied { state: five, .. } =
        m::apply_relay_log(&empty, &w.entries[..5], &s(&w.v, "logKey"))
    else {
        panic!("five")
    };
    for c in log["cases"].as_array().unwrap() {
        let from = if n(c, "from") == 0 { &empty } else { &five };
        let list: Vec<(RelayLogEntry, String)> = c["entries"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| match e.as_u64() {
                Some(i) => w.entries[(i - 1) as usize].clone(),
                None => (log_entry(&e["entry"]), s(e, "signature")),
            })
            .collect();
        let got = apply_json(&m::apply_relay_log(from, &list, &s(c, "logKey")));
        assert_eq!(got, c["expected"], "{}", c["name"]);
    }
    assert_eq!(summary(&w.log), log["finalState"]);
    for (account, want) in log["adminKeys"].as_object().unwrap() {
        assert_eq!(
            m::relay_log_admin_key(&w.log, account).map(str::to_owned),
            want.as_str().map(str::to_owned),
            "{account}"
        );
    }
}

#[test]
fn heads_like_ts() {
    let w = World::new();
    let h = &w.v["heads"];
    for c in h["verify"].as_array().unwrap() {
        let got = res(m::verify_relay_log_head(
            &head(&c["signed"]["head"]),
            &s(&c["signed"], "signature"),
            &s(&w.v, "logKey"),
            &s(c, "apex"),
        ));
        assert_eq!(got, c["expected"], "{}", c["name"]);
    }
    for c in h["status"].as_array().unwrap() {
        assert_eq!(
            m::relay_log_head_status(&w.log, &head(&c["head"])),
            c["expected"],
            "{}",
            c["name"]
        );
    }
    let mut short = w.log.clone();
    short.recent_tips = BTreeMap::from([(w.log.sequence, w.log.tip_sha256.clone())]);
    let u = &h["unknownWithShortHistory"];
    assert_eq!(
        m::relay_log_head_status(&short, &head(&u["head"])),
        u["expected"]
    );
    for c in h["fresh"].as_array().unwrap() {
        let hd = (!c["head"].is_null()).then(|| head(&c["head"]));
        assert_eq!(
            m::relay_log_fresh(&w.log, hd.as_ref(), n(c, "now")),
            c["expected"],
            "{}",
            c["name"]
        );
    }
    for c in h["newer"].as_array().unwrap() {
        let cur = (!c["current"].is_null()).then(|| head(&c["current"]));
        assert_eq!(
            m::newer_relay_log_head(cur.as_ref(), &head(&c["candidate"])),
            c["expected"],
            "{}",
            c["name"]
        );
    }
}

#[test]
fn blessings_requests_directories() {
    let w = World::new();
    for c in w.checks("blessing") {
        let got = res(m::verify_relay_blessing(
            &blessing(&c["blessing"]),
            &strs(&c["caKeys"]),
            n(c, "now"),
            &s(c, "apex"),
        ));
        assert_eq!(got, c["expected"], "{}", c["name"]);
    }
    for c in w.checks("blessingRequest") {
        let r = &c["request"];
        let req = RelayBlessingRequest {
            relay_id: s(r, "relayId"),
            relay_key: s(r, "relayKey"),
            services_apex: s(r, "servicesApex"),
            issued_at: n(r, "issuedAt"),
        };
        let got = res(m::check_relay_blessing_request(
            &req,
            &s(c, "signature"),
            &s(c, "apex"),
            n(c, "now"),
        ));
        assert_eq!(got, c["expected"], "{}", c["name"]);
    }
    for c in w.checks("directory") {
        let got = match m::verify_relay_directory(
            &directory(&c["directory"]),
            &strs(&c["caKeys"]),
            n(c, "now"),
            &s(c, "apex"),
        ) {
            Ok(expired) => json!({"ok": true, "expired": expired}),
            Err(reason) => json!({"ok": false, "reason": reason}),
        };
        assert_eq!(got, c["expected"], "{}", c["name"]);
    }
    for c in w.checks("newerDirectory") {
        let cur = (!c["current"].is_null()).then(|| dir_body(&c["current"]));
        assert_eq!(
            m::newer_relay_directory(cur.as_ref(), &dir_body(&c["candidate"])),
            c["expected"],
            "{}",
            c["name"]
        );
    }
}

fn sign_of(o: Ordering) -> i64 {
    match o {
        Ordering::Greater => 1,
        Ordering::Less => -1,
        Ordering::Equal => 0,
    }
}

#[test]
fn attachments_withdrawals_precedence() {
    let w = World::new();
    for c in w.checks("boxAttachment") {
        let holder_v = c.get("holder");
        let holder_s = holder_v.map(|h| (s(h, "relayId"), s(h, "boxPub"), s(h, "serverFqdn")));
        let holder = holder_s.as_ref().map(|(r, b, f)| AttachmentHolder {
            relay_id: r,
            box_pub: b,
            server_fqdn: f,
        });
        let got = res(m::check_box_attachment(
            &attachment(&c["attachment"]),
            &s(c, "signature"),
            &w.ctx(n(c, "now")),
            holder.as_ref(),
        ));
        assert_eq!(got, c["expected"], "{}", c["name"]);
    }
    for c in w.checks("legacyAttachment") {
        let got = res(m::check_legacy_attachment(
            &attachment(&c["attachment"]),
            &s(c, "signature"),
            &w.ctx(n(c, "now")),
            None,
        ));
        assert_eq!(got, c["expected"], "{}", c["name"]);
    }
    for c in w.checks("compareAttachments") {
        let got = sign_of(m::compare_attachments(
            &attachment_item(&c["a"]),
            &attachment_item(&c["b"]),
        ));
        assert_eq!(got, c["expected"].as_i64().unwrap(), "{}", c["name"]);
    }
    for c in w.checks("withdraw") {
        let got = res(m::check_withdraw(
            &withdraw(&c["withdraw"]),
            &s(c, "signature"),
            &w.ctx(n(c, "now")),
        ));
        assert_eq!(got, c["expected"], "{}", c["name"]);
    }
    for c in w.checks("withdrawCovers") {
        assert_eq!(
            m::withdraw_covers(&withdraw(&c["withdraw"]), &mesh_item(&c["item"])),
            c["expected"],
            "{}",
            c["name"]
        );
    }
    // the dispatch over item kinds
    let first = &w.checks("legacyAttachment")[0];
    let item = AttachmentItem {
        kind: AttachmentKind::Legacy,
        attachment: attachment(&first["attachment"]),
        signature: s(first, "signature"),
    };
    assert_eq!(m::check_attachment_item(&item, &w.ctx(w.t0), None), Ok(()));
    assert_eq!(m::attachment_refusal_code("expired"), "clock");
    assert_eq!(m::attachment_refusal_code("bad-signature"), "mismatch");
}

fn auth(v: &Value) -> MeshAuth {
    MeshAuth {
        relay_id: s(v, "relayId"),
        peer: s(v, "peer"),
        nonce: s(v, "nonce"),
        at: n(v, "at"),
        blessing: (!v["blessing"].is_null()).then(|| blessing(&v["blessing"])),
        sig: s(v, "sig"),
    }
}

#[test]
fn bridges_hints_moves_phones() {
    let w = World::new();
    for c in w.checks("bridgeAuth") {
        let a = auth(&c["auth"]);
        let held = (!c["heldBlessing"].is_null()).then(|| blessing(&c["heldBlessing"]));
        let role = s(c, "role");
        let self_id = s(c, "selfRelayId");
        let self_nonce = s(c, "selfNonce");
        let got = match m::check_bridge_auth(&BridgeAuthCheck {
            auth: &a,
            role: &role,
            self_relay_id: &self_id,
            self_nonce: &self_nonce,
            held_blessing: held.as_ref(),
            ca_keys: &w.ca,
            ctx: w.ctx(n(c, "now")),
        }) {
            Ok(b) => json!({"ok": true, "blessingRelayId": b.body.relay_id}),
            Err(reason) => json!({"ok": false, "reason": reason}),
        };
        assert_eq!(got, c["expected"], "{}", c["name"]);
    }
    let home = format!("home.alice.{}", w.apex);
    let box_pub = w.v["keys"]["boxHome"]["pub"].as_str().unwrap().to_owned();
    let iad1 = w.v["keys"]["iad1"]["pub"].as_str().unwrap().to_owned();
    for c in w.checks("moveHint") {
        let h = move_hint(&c["hint"]);
        let target = blessing(&c["target"]);
        let r = rate(&c["rate"]);
        let sig = s(c, "signature");
        let got = res(m::check_move_hint(&MoveHintCheck {
            hint: &h,
            signature: &sig,
            target: &target,
            box_server_fqdn: &home,
            box_pub: &box_pub,
            services_apex: &w.apex,
            current_relay_id: "iad1",
            current_relay_key: &iad1,
            directory: Some(&w.dir),
            directory_fetched_at: on(c, "directoryFetchedAt"),
            ca_keys: &w.ca,
            rate: &r,
            now: n(c, "now"),
        }));
        assert_eq!(got, c["expected"], "{}", c["name"]);
    }
    for c in w.checks("recordMoveHint") {
        let got = m::record_move_hint(&rate(&c["rate"]), &s(c, "reason"), n(c, "now"));
        assert_eq!(rate_json(&got), c["expected"], "{}", c["name"]);
    }
    for c in w.checks("recordMoveTargetFailed") {
        let got = m::record_move_target_failed(&rate(&c["rate"]), &s(c, "relayId"), n(c, "now"));
        assert_eq!(rate_json(&got), c["expected"], "{}", c["name"]);
    }
    for c in w.checks("accountMove") {
        let home = c["expectedHome"].as_str();
        let got = res(m::check_account_move(
            &account_move(&c["move"]),
            &s(c, "signature"),
            home,
            on(c, "lastAcceptedAt"),
            &w.ctx(n(c, "now")),
        ));
        assert_eq!(got, c["expected"], "{}", c["name"]);
    }
    for c in w.checks("phoneItem") {
        let got = res(m::check_phone_item(
            &phone_item(&c["item"]),
            &s(c, "announcer"),
            &w.ctx(n(c, "now")),
        ));
        assert_eq!(got, c["expected"], "{}", c["name"]);
    }
    for c in w.checks("comparePhoneItems") {
        let got = sign_of(m::compare_phone_items(
            &phone_item(&c["a"]),
            &phone_item(&c["b"]),
        ));
        assert_eq!(got, c["expected"].as_i64().unwrap(), "{}", c["name"]);
    }
}

#[test]
fn routing_like_ts() {
    let w = World::new();
    for c in w.checks("accountHome") {
        let atts: Vec<HomeAttachment> = c["attachments"]
            .as_array()
            .unwrap()
            .iter()
            .map(|a| HomeAttachment {
                relay_id: s(a, "relayId"),
                attached_at: n(a, "attachedAt"),
            })
            .collect();
        let mv =
            (!c["move"].is_null()).then(|| (s(&c["move"], "toRelayId"), n(&c["move"], "notAfter")));
        let got = m::account_home(
            &atts,
            Some(&w.dir),
            mv.as_ref().map(|(t, a)| (t.as_str(), *a)),
            n(c, "now"),
        );
        assert_eq!(got.as_deref(), c["expected"].as_str(), "{}", c["name"]);
    }
    for c in w.checks("phoneLedgerRanking") {
        let log = c["withLog"].as_bool().unwrap().then_some(&w.log);
        let got = m::phone_ledger_ranking(&s(c, "account"), Some(&w.dir), log).unwrap();
        assert_eq!(got, strs(&c["expected"]), "{}", c["account"]);
    }
    for c in w.checks("rebalance") {
        let window: Vec<RebalanceWindow> = c["window"]
            .as_array()
            .unwrap()
            .iter()
            .map(|x| RebalanceWindow {
                relay_id: s(x, "relayId"),
                bytes: n(x, "bytes"),
                streams: n(x, "streams"),
            })
            .collect();
        let relays: Vec<RebalanceRelay> = c["relays"]
            .as_array()
            .unwrap()
            .iter()
            .map(|x| RebalanceRelay {
                relay_id: s(x, "relayId"),
                relay_kind: kind(&x["relayKind"]),
                last_load_at: on(x, "lastLoadAt"),
                draining: x["draining"].as_bool().unwrap(),
                tunnels: n(x, "tunnels"),
                capacity: n(x, "capacity"),
            })
            .collect();
        let got = match m::rebalance_decision(
            &s(c, "home"),
            &window,
            &relays,
            on(c, "lastMoveAt"),
            c["hasLegacyBox"].as_bool().unwrap(),
            n(c, "now"),
        ) {
            Ok(to) => json!({"move": true, "to": to}),
            Err(reason) => json!({"move": false, "reason": reason}),
        };
        assert_eq!(got, c["expected"], "{}", c["name"]);
    }
}

#[test]
fn serving_decision_at_a_policy_head() {
    let w = World::new();
    for c in w.checks("servingAtHead") {
        let i = &c["input"];
        let policies: Vec<(ServingPolicy, String)> = i["policies"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| {
                let r = &p["record"];
                (
                    ServingPolicy {
                        account: s(r, "account"),
                        box_pub: s(r, "box"),
                        reg_gen: n(r, "regGen"),
                        policy_gen: n(r, "policyGen"),
                        grace: Grace::parse(&s(r, "grace")).unwrap(),
                        on_lapse: OnLapse::parse(&s(r, "onLapse")).unwrap(),
                        scope_sha256: s(r, "scopeSha256"),
                        issued_at: n(r, "issuedAt"),
                    },
                    s(p, "signature"),
                )
            })
            .collect();
        let leases: Vec<SignedLease> = i["leases"]
            .as_array()
            .unwrap()
            .iter()
            .map(|l| {
                let r = &l["record"];
                SignedLease {
                    lease: ServingLease {
                        account: s(r, "account"),
                        box_pub: s(r, "box"),
                        reg_gen: n(r, "regGen"),
                        policy_gen: n(r, "policyGen"),
                        lease_id: s(r, "leaseId"),
                        issued_at: n(r, "issuedAt"),
                        not_after: n(r, "notAfter"),
                    },
                    signature: s(l, "signature"),
                    delegation: None,
                }
            })
            .collect();
        let revocations = RevocationState {
            sequence: 0,
            boxes: i["revokedBoxes"]
                .as_object()
                .unwrap()
                .iter()
                .map(|(k, g)| (k.clone(), g.as_u64().unwrap()))
                .collect(),
            renewal_keys: Default::default(),
        };
        let head = (!i["policyHead"].is_null()).then(|| PolicyHead {
            policy_sha256: s(&i["policyHead"], "policySha256"),
        });
        let input = ServingInput {
            account: i["account"].as_str().unwrap(),
            box_pub: i["box"].as_str().unwrap(),
            reg_gen: n(i, "regGen"),
            admin_key_from_com: i["adminKeyFromCom"].as_str().unwrap(),
            admin_key_from_box: i["adminKeyFromBox"].as_str().unwrap(),
            policies: &policies,
            leases: &leases,
            revocations: &revocations,
            now: n(i, "now"),
        };
        let got = match serving_decision_at_head(&input, head.as_ref()) {
            ServingDecision::Serve {
                until,
                policy_gen,
                on_lapse,
            } => {
                json!({"control": true, "apps": true, "until": until, "policyGen": policy_gen, "onLapse": on_lapse.as_str()})
            }
            ServingDecision::Refuse {
                control,
                reason,
                lock,
            } => {
                json!({"control": control, "apps": false, "reason": reason, "lock": lock})
            }
        };
        assert_eq!(got, c["expected"], "{}", c["name"]);
    }
    let rev = m::relay_log_revocations(&w.log);
    let old = w.v["keys"]["boxOld"]["pub"].as_str().unwrap();
    assert!(flagship_crypto::serving::box_key_revoked(&rev, old, 1));
    assert!(flagship_crypto::serving::box_revoked(
        &rev, "anyone", old, 1
    ));
    assert!(!flagship_crypto::serving::box_key_revoked(&rev, old, 2));
}

#[test]
fn shape_helpers() {
    let apex = "flagship.services";
    assert!(m::is_pod_name("home.alice.flagship.services", apex));
    assert!(!m::is_pod_name("x.home.alice.flagship.services", apex));
    assert!(!m::is_pod_name("home.aliceflagship.services", apex));
    assert_eq!(
        m::account_of_pod_name("home.alice.flagship.services", apex),
        Some("alice")
    );
    assert!(m::is_bare_phone_name("alice.flagship.services", apex));
    assert!(!m::is_bare_phone_name("home.alice.flagship.services", apex));
    assert!(
        m::is_relay_id("iad1")
            && !m::is_relay_id("i")
            && !m::is_relay_id(&"a".repeat(32))
            && !m::is_relay_id("1ad")
    );
    assert_eq!(
        m::relay_tunnel_host("iad1", apex),
        "iad1.tunnel.flagship.services"
    );
}

/// The apps choose device grant ids (UUIDs), so a `device-grant-revoke` carries any lowercased id of hex digits and
/// dashes up to 64 characters (migration 0126; gym run 28: no UUID grant's revocation reached a mesh relay).
#[test]
fn device_grant_revoke_takes_the_apps_grant_ids() {
    use flagship_crypto::relay_mesh::{
        RelayLogBody, RelayLogEntry, parse_relay_log_entry, relay_log_grant_id,
    };
    let dev = "43".repeat(32);
    let entry = |f1: &str| RelayLogEntry {
        sequence: 1,
        kind: "device-grant-revoke".into(),
        at: 1,
        f1: f1.into(),
        f2: dev.clone(),
        f3: String::new(),
        f4: String::new(),
    };
    let uuid = relay_log_grant_id("0F8FAD5B-D9CB-469F-A165-70867728950E");
    assert_eq!(uuid, "0f8fad5b-d9cb-469f-a165-70867728950e");
    for ok in [uuid.as_str(), &"ab".repeat(16), &"cd".repeat(32)] {
        assert_eq!(
            parse_relay_log_entry(&entry(ok)).unwrap(),
            RelayLogBody::DeviceGrantRevoke {
                grant_id: ok.to_string(),
                device_pub: dev.clone()
            }
        );
    }
    for bad in [
        "",
        "-abc",
        "0F8FAD5B-D9CB-469F-A165-70867728950E",
        "not|an id",
        &"a".repeat(65),
    ] {
        assert!(
            parse_relay_log_entry(&entry(bad)).is_err(),
            "{bad} accepted"
        );
    }
}
