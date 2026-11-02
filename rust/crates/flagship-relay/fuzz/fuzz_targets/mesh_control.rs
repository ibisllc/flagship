//! The relay mesh's untrusted inputs (relay-mesh.md §6.3, §9.1) on arbitrary bytes: a bridge's control JSON (every
//! item, withdrawal, head, log entry, directory, blessing and auth shape), the box's ATTACHMENT frame, a bridged OPEN,
//! and the attachment store fed with whatever parsed. No panic, no unbounded work.
#![no_main]

use flagship_relay::mesh::attachments::{Caps, Store};
use flagship_relay::mesh::wire;
use flagship_relay::payload;
use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    let _ = wire::parse_attachment_frame(data);
    let _ = payload::parse_bridge_open(data);
    let Ok(v) = serde_json::from_slice::<serde_json::Value>(data) else {
        return;
    };
    let _ = wire::mesh_auth_from_json(&v);
    let _ = wire::head_from_json(&v);
    let _ = wire::log_entry_from_json(&v);
    let _ = wire::directory_from_json(&v);
    let _ = wire::blessing_from_json(&v);
    let _ = wire::account_move_from_json(&v);
    let mut store = Store::new(
        "iad1",
        "flagship.services",
        Caps {
            box_items: 8,
            per_relay: 4,
            phone_items: 4,
        },
    );
    let lists = [v.get("items"), v.get("entries")];
    for list in lists.into_iter().flatten().filter_map(serde_json::Value::as_array) {
        for item in list.iter().take(64) {
            match wire::item_from_json(item) {
                Some(wire::WireItem::Attachment(a)) => {
                    let name = a.attachment.server_fqdn.clone();
                    let _ = store.insert_box(a);
                    let _ = store.winner(&name, 0);
                }
                Some(wire::WireItem::Phone(p)) => {
                    let host = p.grant.hostname.clone();
                    let _ = store.insert_phone(p);
                    let _ = store.phone_winner(&host, 0);
                }
                _ => {}
            }
            if let Some((w, _)) = wire::withdraw_from_json(item) {
                let _ = store.withdraw(&w);
            }
            let _ = wire::log_entry_from_json(item);
        }
    }
    let _ = store.account_attachments("alice", 0);
    store.sweep(u64::MAX);
});
