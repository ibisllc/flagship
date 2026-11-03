//! JSON shapes of the mesh records (relay-mesh.md §§3–10) to and from chunk A's structs (`flagship_crypto::relay_mesh`).
//! Parsing only reads fields; every rule (canonical bytes, signatures, windows) stays in chunk A's checks. A parser
//! answers `None` for anything that is not the shape, and the caller drops the item and counts it.

use flagship_crypto::relay_mesh::{
    AccountMove, AttachmentItem, AttachmentKind, BoxAttachment, MeshAuth, MoveHint, PhoneItem,
    PhoneRouteGrant, RelayBlessing, RelayBlessingBody, RelayDirectory, RelayDirectoryBody,
    RelayDirectoryEntry, RelayKind, RelayLogEntry, RelayLogHead, RelayWithdraw,
};
use flagship_crypto::serving::RouteClaim;
use serde_json::{Map, Value, json};

use crate::json::write_str;

/// A bridge request id (§6.3 `query`, §8.2 phone requests) is opaque to the side that answers: it is echoed exactly as
/// it came (a string of at most 64 characters, as the TS relay sends `q<n>`, or a number). Anything else is null.
#[must_use]
pub fn qid_echo(v: &Value) -> Value {
    match v.get("qid") {
        Some(Value::String(q)) if q.len() <= 64 => Value::String(q.clone()),
        Some(Value::Number(q)) if q.is_u64() => Value::Number(q.clone()),
        _ => Value::Null,
    }
}

/// This relay's own request id on the wire: `q<n>`, a string, so a TS peer (which keys its waiters by string) echoes it.
#[must_use]
pub fn qid_wire(n: u64) -> Value {
    Value::String(format!("q{n}"))
}

/// The id of an answer to one of this relay's requests (`q<n>`, or a bare number from an older build).
#[must_use]
pub fn qid_parse(v: &Value) -> Option<u64> {
    match v.get("qid")? {
        Value::Number(q) => q.as_u64(),
        Value::String(q) => q.strip_prefix('q')?.parse().ok(),
        _ => None,
    }
}

fn s(v: &Value, k: &str) -> Option<String> {
    v.get(k)?.as_str().map(str::to_owned)
}

fn n(v: &Value, k: &str) -> Option<u64> {
    v.get(k)?.as_u64()
}

fn strings(v: &Value, k: &str) -> Option<Vec<String>> {
    v.get(k)?
        .as_array()?
        .iter()
        .map(|x| x.as_str().map(str::to_owned))
        .collect()
}

fn signatures(v: &Value) -> Option<Vec<(String, String)>> {
    v.get("signatures")?
        .as_array()?
        .iter()
        .map(|x| Some((s(x, "pubkey")?, s(x, "sig")?)))
        .collect()
}

fn signatures_json(list: &[(String, String)]) -> Value {
    Value::Array(
        list.iter()
            .map(|(p, sig)| json!({"pubkey": p, "sig": sig}))
            .collect(),
    )
}

// ── blessing (§3.2) ───────────────────────────────────────────────────────

#[must_use]
pub fn blessing_from_json(v: &Value) -> Option<RelayBlessing> {
    if s(v, "kind").as_deref() != Some("RelayBlessing") || n(v, "version") != Some(1) {
        return None;
    }
    Some(RelayBlessing {
        body: RelayBlessingBody {
            relay_id: s(v, "relayId")?,
            relay_key: s(v, "relayKey")?,
            services_apex: s(v, "servicesApex")?,
            tunnel_host: s(v, "tunnelHost")?,
            relay_kind: RelayKind::parse(&s(v, "relayKind")?).ok()?,
            nonce: s(v, "nonce")?,
            issued_at: n(v, "issuedAt")?,
            expires_at: n(v, "expiresAt")?,
        },
        signed_by: s(v, "signedBy")?,
        signatures: signatures(v)?,
    })
}

#[must_use]
pub fn blessing_to_json(b: &RelayBlessing) -> Value {
    let x = &b.body;
    json!({
        "kind": "RelayBlessing", "version": 1, "relayId": x.relay_id, "relayKey": x.relay_key,
        "servicesApex": x.services_apex, "tunnelHost": x.tunnel_host, "relayKind": x.relay_kind.as_str(),
        "nonce": x.nonce, "issuedAt": x.issued_at, "expiresAt": x.expires_at, "signedBy": b.signed_by,
        "signatures": signatures_json(&b.signatures),
    })
}

// ── directory (§3.3) ──────────────────────────────────────────────────────

#[must_use]
pub fn directory_from_json(v: &Value) -> Option<RelayDirectory> {
    if s(v, "kind").as_deref() != Some("RelayDirectory") || n(v, "version") != Some(1) {
        return None;
    }
    let relays = v
        .get("relays")?
        .as_array()?
        .iter()
        .map(|r| {
            Some(RelayDirectoryEntry {
                relay_id: s(r, "relayId")?,
                relay_key: s(r, "relayKey")?,
                tunnel_host: s(r, "tunnelHost")?,
                relay_kind: RelayKind::parse(&s(r, "relayKind")?).ok()?,
                region: s(r, "region")?,
                ipv4: strings(r, "ipv4")?,
                ipv6: strings(r, "ipv6")?,
            })
        })
        .collect::<Option<Vec<_>>>()?;
    Some(RelayDirectory {
        body: RelayDirectoryBody {
            services_apex: s(v, "servicesApex")?,
            directory_version: n(v, "directoryVersion")?,
            issued_at: n(v, "issuedAt")?,
            expires_at: n(v, "expiresAt")?,
            relays,
        },
        signed_by: s(v, "signedBy")?,
        signatures: signatures(v)?,
    })
}

#[must_use]
pub fn directory_to_json(d: &RelayDirectory) -> Value {
    let x = &d.body;
    json!({
        "kind": "RelayDirectory", "version": 1, "servicesApex": x.services_apex,
        "directoryVersion": x.directory_version, "issuedAt": x.issued_at, "expiresAt": x.expires_at,
        "relays": x.relays.iter().map(|r| json!({
            "relayId": r.relay_id, "relayKey": r.relay_key, "tunnelHost": r.tunnel_host,
            "relayKind": r.relay_kind.as_str(), "region": r.region, "ipv4": r.ipv4, "ipv6": r.ipv6,
        })).collect::<Vec<_>>(),
        "signedBy": d.signed_by, "signatures": signatures_json(&d.signatures),
    })
}

// ── log entries and heads (§4.2, §4.3) ────────────────────────────────────

/// `{entry:{sequence, kind, at, f1, f2, f3, f4}, signature}`.
#[must_use]
pub fn log_entry_from_json(v: &Value) -> Option<(RelayLogEntry, String)> {
    let e = v.get("entry")?;
    Some((
        RelayLogEntry {
            sequence: n(e, "sequence")?,
            kind: s(e, "kind")?,
            at: n(e, "at")?,
            f1: s(e, "f1")?,
            f2: s(e, "f2")?,
            f3: s(e, "f3")?,
            f4: s(e, "f4")?,
        },
        s(v, "signature")?,
    ))
}

#[must_use]
pub fn log_entry_to_json(e: &RelayLogEntry, signature: &str) -> Value {
    json!({"entry": {"sequence": e.sequence, "kind": e.kind, "at": e.at, "f1": e.f1, "f2": e.f2, "f3": e.f3, "f4": e.f4},
        "signature": signature})
}

/// `{head:{servicesApex, sequence, tipSha256, directoryVersion, issuedAt}, signature}`.
#[must_use]
pub fn head_from_json(v: &Value) -> Option<(RelayLogHead, String)> {
    let h = v.get("head")?;
    Some((
        RelayLogHead {
            services_apex: s(h, "servicesApex")?,
            sequence: n(h, "sequence")?,
            tip_sha256: s(h, "tipSha256")?,
            directory_version: n(h, "directoryVersion")?,
            issued_at: n(h, "issuedAt")?,
        },
        s(v, "signature")?,
    ))
}

#[must_use]
pub fn head_to_json(h: &RelayLogHead, signature: &str) -> Value {
    json!({"head": {"servicesApex": h.services_apex, "sequence": h.sequence, "tipSha256": h.tip_sha256,
        "directoryVersion": h.directory_version, "issuedAt": h.issued_at}, "signature": signature})
}

// ── attachments (§5) ──────────────────────────────────────────────────────

/// The `attachment` object of a box or legacy item, or of the ATTACHMENT frame.
#[must_use]
pub fn attachment_from_json(a: &Value) -> Option<BoxAttachment> {
    Some(BoxAttachment {
        server_fqdn: s(a, "serverFqdn")?,
        box_pub: s(a, "boxPub")?,
        reg_gen: n(a, "regGen")?,
        relay_id: s(a, "relayId")?,
        attached_at: n(a, "attachedAt")?,
        issued_at: n(a, "issuedAt")?,
        not_after: n(a, "notAfter")?,
    })
}

#[must_use]
pub fn attachment_to_json(a: &BoxAttachment) -> Value {
    json!({"serverFqdn": a.server_fqdn, "boxPub": a.box_pub, "regGen": a.reg_gen, "relayId": a.relay_id,
        "attachedAt": a.attached_at, "issuedAt": a.issued_at, "notAfter": a.not_after})
}

/// A phone route grant object.
#[must_use]
pub fn grant_from_json(g: &Value) -> Option<PhoneRouteGrant> {
    Some(PhoneRouteGrant {
        hostname: s(g, "hostname")?,
        phone_route_pub: s(g, "phoneRoutePub")?,
        generation: n(g, "generation")?,
        holder_relay_id: s(g, "holderRelayId")?,
        ledger_relay_id: s(g, "ledgerRelayId")?,
        issued_at: n(g, "issuedAt")?,
        not_after: n(g, "notAfter")?,
    })
}

#[must_use]
pub fn grant_to_json(g: &PhoneRouteGrant) -> Value {
    json!({"hostname": g.hostname, "phoneRoutePub": g.phone_route_pub, "generation": g.generation,
        "holderRelayId": g.holder_relay_id, "ledgerRelayId": g.ledger_relay_id, "issuedAt": g.issued_at,
        "notAfter": g.not_after})
}

/// The phone's `route-claim/v1` as JSON (§8.3): `{account, phoneRoutePub, hostname, generation, sessionNonce, issuedAt}`.
#[must_use]
pub fn claim_from_json(v: &Value) -> Option<RouteClaim> {
    Some(RouteClaim {
        account: s(v, "account")?,
        phone_route_pub: s(v, "phoneRoutePub")?,
        hostname: s(v, "hostname")?,
        generation: n(v, "generation")?,
        session_nonce: s(v, "sessionNonce")?,
        issued_at: n(v, "issuedAt")?,
    })
}

#[must_use]
pub fn claim_to_json(c: &RouteClaim) -> Value {
    json!({"account": c.account, "phoneRoutePub": c.phone_route_pub, "hostname": c.hostname,
        "generation": c.generation, "sessionNonce": c.session_nonce, "issuedAt": c.issued_at})
}

/// One item of an `announce` or `answer` list (§6.3).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WireItem {
    Attachment(AttachmentItem),
    Phone(PhoneItem),
    /// `{kind:"mailbox", announce:{pikPubHex, epoch}, signature, relayId}` (§7.6, §15.4.1): self-authenticating under
    /// the PIK; kept only from the peer it names.
    Mailbox {
        pik_pub_hex: String,
        epoch: u64,
        sig_hex: String,
        relay_id: String,
    },
}

/// `{kind:"box"|"legacy", attachment, signature}`, `{kind:"phone", grant, signature, claim, claimSignature}` or
/// `{kind:"mailbox", announce}`. A phone item without the phone's claim is not one (§8.3).
#[must_use]
pub fn item_from_json(v: &Value) -> Option<WireItem> {
    let kind = s(v, "kind")?;
    match kind.as_str() {
        "box" | "legacy" => Some(WireItem::Attachment(AttachmentItem {
            kind: if kind == "box" {
                AttachmentKind::Box
            } else {
                AttachmentKind::Legacy
            },
            attachment: attachment_from_json(v.get("attachment")?)?,
            signature: s(v, "signature")?,
        })),
        "phone" => Some(WireItem::Phone(PhoneItem {
            grant: grant_from_json(v.get("grant")?)?,
            signature: s(v, "signature")?,
            claim: claim_from_json(v.get("claim")?)?,
            claim_signature: s(v, "claimSignature")?,
        })),
        "mailbox" => {
            let a = v.get("announce")?;
            Some(WireItem::Mailbox {
                pik_pub_hex: s(a, "pikPubHex")?,
                epoch: n(a, "epoch")?,
                sig_hex: s(v, "signature")?,
                relay_id: s(v, "relayId")?,
            })
        }
        _ => None,
    }
}

#[must_use]
pub fn item_to_json(item: &WireItem) -> Value {
    match item {
        WireItem::Attachment(a) => json!({
            "kind": if a.kind == AttachmentKind::Box { "box" } else { "legacy" },
            "attachment": attachment_to_json(&a.attachment), "signature": a.signature,
        }),
        WireItem::Phone(p) => {
            json!({"kind": "phone", "grant": grant_to_json(&p.grant), "signature": p.signature,
                "claim": claim_to_json(&p.claim), "claimSignature": p.claim_signature})
        }
        WireItem::Mailbox {
            pik_pub_hex,
            epoch,
            sig_hex,
            relay_id,
        } => json!({"kind": "mailbox", "announce": {"pikPubHex": pik_pub_hex, "epoch": epoch},
            "signature": sig_hex, "relayId": relay_id}),
    }
}

/// `{withdraw:{subjectKind, subject, relayId, withdrawnIssuedAt, at}, signature}`.
#[must_use]
pub fn withdraw_from_json(v: &Value) -> Option<(RelayWithdraw, String)> {
    let w = v.get("withdraw")?;
    Some((
        RelayWithdraw {
            subject_kind: s(w, "subjectKind")?,
            subject: s(w, "subject")?,
            relay_id: s(w, "relayId")?,
            withdrawn_issued_at: n(w, "withdrawnIssuedAt")?,
            at: n(w, "at")?,
        },
        s(v, "signature")?,
    ))
}

#[must_use]
pub fn withdraw_to_json(w: &RelayWithdraw, signature: &str) -> Value {
    json!({"withdraw": {"subjectKind": w.subject_kind, "subject": w.subject, "relayId": w.relay_id,
        "withdrawnIssuedAt": w.withdrawn_issued_at, "at": w.at}, "signature": signature})
}

/// `{type:"account-move", move:{accountHash, fromRelayId, toRelayId, issuedAt, notAfter}, signature}`.
#[must_use]
pub fn account_move_from_json(v: &Value) -> Option<(AccountMove, String)> {
    let m = v.get("move")?;
    Some((
        AccountMove {
            account_hash: s(m, "accountHash")?,
            from_relay_id: s(m, "fromRelayId")?,
            to_relay_id: s(m, "toRelayId")?,
            issued_at: n(m, "issuedAt")?,
            not_after: n(m, "notAfter")?,
        },
        s(v, "signature")?,
    ))
}

#[must_use]
pub fn account_move_to_json(m: &AccountMove, signature: &str) -> Value {
    json!({"type": "account-move", "move": {"accountHash": m.account_hash, "fromRelayId": m.from_relay_id,
        "toRelayId": m.to_relay_id, "issuedAt": m.issued_at, "notAfter": m.not_after}, "signature": signature})
}

/// `{type:"mesh-auth", v:1, relayId, peer, nonce, at, blessing, sig}`.
#[must_use]
pub fn mesh_auth_from_json(v: &Value) -> Option<MeshAuth> {
    if s(v, "type").as_deref() != Some("mesh-auth") || n(v, "v") != Some(1) {
        return None;
    }
    let blessing = match v.get("blessing") {
        None | Some(Value::Null) => None,
        Some(b) => Some(blessing_from_json(b)?),
    };
    Some(MeshAuth {
        relay_id: s(v, "relayId")?,
        peer: s(v, "peer")?,
        nonce: s(v, "nonce")?,
        at: n(v, "at")?,
        blessing,
        sig: s(v, "sig")?,
    })
}

// ── frame payloads toward the box (byte-exact with frames.ts) ─────────────

fn push_kv_str(out: &mut String, k: &str, v: &str) {
    write_str(out, k);
    out.push(':');
    write_str(out, v);
}

fn push_kv_num(out: &mut String, k: &str, v: u64) {
    write_str(out, k);
    out.push(':');
    out.push_str(&v.to_string());
}

/// `attachmentResultFrame`'s payload: `{"ok":true}` or `{"ok":false,"code":…}`.
#[must_use]
pub fn attachment_result_payload(code: Option<&str>) -> Vec<u8> {
    match code {
        None => b"{\"ok\":true}".to_vec(),
        Some(c) => {
            let mut s = String::from("{\"ok\":false,");
            push_kv_str(&mut s, "code", c);
            s.push('}');
            s.into_bytes()
        }
    }
}

/// `moveHintFrame`'s payload: `{hint, signature, target}` in `JSON.stringify` order, `target` written verbatim.
#[must_use]
pub fn move_hint_payload(h: &MoveHint, signature: &str, target_json: &str) -> Vec<u8> {
    let mut s = String::from("{\"hint\":{");
    push_kv_str(&mut s, "serverFqdn", &h.server_fqdn);
    s.push(',');
    push_kv_str(&mut s, "boxPub", &h.box_pub);
    s.push(',');
    push_kv_str(&mut s, "fromRelayId", &h.from_relay_id);
    s.push(',');
    push_kv_str(&mut s, "toRelayId", &h.to_relay_id);
    s.push(',');
    push_kv_str(&mut s, "reason", &h.reason);
    s.push(',');
    push_kv_num(&mut s, "issuedAt", h.issued_at);
    s.push(',');
    push_kv_num(&mut s, "notAfter", h.not_after);
    s.push_str("},");
    push_kv_str(&mut s, "signature", signature);
    s.push_str(",\"target\":");
    s.push_str(target_json);
    s.push('}');
    s.into_bytes()
}

/// `parseAttachmentFrame`: `{attachment: object, signature: 128 lowercase hex}`; the record itself is checked later.
#[must_use]
pub fn parse_attachment_frame(payload: &[u8]) -> Option<(Value, String)> {
    let v = crate::json::parse(payload)?;
    let o: &Map<String, Value> = v.as_object()?;
    let a = o.get("attachment").filter(|a| a.is_object())?;
    let sig = o.get("signature")?.as_str()?;
    let ok = sig.len() == 128
        && sig
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
    ok.then(|| (a.clone(), sig.to_owned()))
}

#[cfg(test)]
#[allow(
    clippy::unwrap_used,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects
)]
mod tests {
    use super::*;

    const FRAMES: &str =
        include_str!("../../../../../packages/tunnel-protocol/test-vectors/frames.json");
    const MESH: &str =
        include_str!("../../../../../packages/protocol/test-vectors/relay-mesh/vectors.json");

    fn unhex(s: &str) -> Vec<u8> {
        (0..s.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
            .collect()
    }

    #[test]
    fn phone_items_carry_the_phones_claim_both_ways() {
        let v: Value = serde_json::from_str(MESH).unwrap();
        let ok = v["checks"]["phoneItem"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["name"] == "ok")
            .unwrap();
        let item = &ok["item"];
        let p = match item_from_json(item) {
            Some(WireItem::Phone(p)) => p,
            other => unreachable!("a vector phone item parses: {other:?}"),
        };
        assert_eq!(p.claim.generation, p.grant.generation);
        assert_eq!(&item_to_json(&WireItem::Phone(p)), item);
        let mut bare = item.clone();
        bare.as_object_mut().unwrap().remove("claim");
        assert!(
            item_from_json(&bare).is_none(),
            "no claim: not a phone item"
        );
        let mut nosig = item.clone();
        nosig.as_object_mut().unwrap().remove("claimSignature");
        assert!(item_from_json(&nosig).is_none());
    }

    #[test]
    fn frame_payloads_match_the_typescript_builders() {
        let v: Value = serde_json::from_str(FRAMES).unwrap();
        for c in v["mesh"]["encoded"].as_array().unwrap() {
            let payload = unhex(c["payloadHex"].as_str().unwrap());
            match c["name"].as_str().unwrap() {
                "attachment ok" => assert_eq!(attachment_result_payload(None), payload),
                "attachment refused" => {
                    assert_eq!(attachment_result_payload(Some("clock")), payload);
                }
                "move hint" => {
                    let p: Value = serde_json::from_slice(&payload).unwrap();
                    let h = &p["hint"];
                    let hint = MoveHint {
                        server_fqdn: s(h, "serverFqdn").unwrap(),
                        box_pub: s(h, "boxPub").unwrap(),
                        from_relay_id: s(h, "fromRelayId").unwrap(),
                        to_relay_id: s(h, "toRelayId").unwrap(),
                        reason: s(h, "reason").unwrap(),
                        issued_at: n(h, "issuedAt").unwrap(),
                        not_after: n(h, "notAfter").unwrap(),
                    };
                    let target = "{\"kind\":\"RelayBlessing\",\"version\":1}";
                    assert_eq!(
                        move_hint_payload(&hint, p["signature"].as_str().unwrap(), target),
                        payload
                    );
                }
                _ => {}
            }
        }
        for c in v["mesh"]["parsers"]["attachment"].as_array().unwrap() {
            let got = parse_attachment_frame(&unhex(c["payloadHex"].as_str().unwrap()));
            let want = &c["result"];
            match got {
                None => assert!(want.is_null(), "{}", c["name"]),
                Some((a, sig)) => {
                    assert_eq!(a, want["attachment"], "{}", c["name"]);
                    assert_eq!(sig, want["signature"].as_str().unwrap());
                }
            }
        }
    }

    #[test]
    fn records_round_trip_through_json() {
        let v: Value = serde_json::from_str(MESH).unwrap();
        let b = &v["blessings"][0]["blessing"];
        let parsed = blessing_from_json(b).unwrap();
        assert_eq!(&blessing_to_json(&parsed), b);
        let d = &v["directory"]["directory"];
        let parsed = directory_from_json(d).unwrap();
        assert_eq!(&directory_to_json(&parsed), d);
        for e in v["log"]["entries"].as_array().unwrap() {
            let (entry, sig) = log_entry_from_json(e).unwrap();
            let back = log_entry_to_json(&entry, &sig);
            assert_eq!(back["entry"], e["entry"]);
        }
        assert!(blessing_from_json(&json!({"kind": "Other"})).is_none());
        assert!(item_from_json(&json!({"kind": "teapot"})).is_none());
    }
}
