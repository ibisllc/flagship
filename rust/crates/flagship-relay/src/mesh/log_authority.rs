//! The relay log as the HELLO authority and the serving gate's record source (relay-mesh.md §4.1, §4.4): a mesh relay
//! never calls `.com`'s internal or per-name routes. The account's keys come from `account-authority`, the registered
//! STK from the newest `box-register` for the name (a newer key evicts the older one), revoked certificates from
//! `cert-revoke`, and the gate's inputs from the log plus what the box itself presented in its HELLO (its policy and
//! leases, §9.5), checked against the log's `policy-head`.

use std::collections::HashSet;

use flagship_crypto::relay_mesh::{
    account_hash, relay_log_admin_key, relay_log_box, relay_log_policy_head,
};
use flagship_crypto::serving::PolicyHead;

use super::Mesh;
use crate::authority::{AccountKeys, BoxFut, Directory};
use crate::serving::{ComServingRecord, ServingFetch, ServingFetched};

/// [`Directory`] over the applied relay log.
#[derive(Debug, Clone)]
pub struct LogDirectory(pub Mesh);

impl Directory for LogDirectory {
    fn account<'a>(&'a self, username: &'a str) -> BoxFut<'a, Option<AccountKeys>> {
        Box::pin(async move {
            let h = account_hash(&username.to_ascii_lowercase()).ok()?;
            self.0
                .with_state(|s| {
                    s.log.authorities.get(&h).map(|a| AccountKeys {
                        irk_pub_hex: a.irk_pub.clone(),
                        admin_root_pub_hex: a.admin_root_pub.clone(),
                    })
                })
                .flatten()
        })
    }

    fn revoked<'a>(&'a self, username: &'a str) -> BoxFut<'a, Option<HashSet<String>>> {
        Box::pin(async move {
            let h = account_hash(&username.to_ascii_lowercase()).ok()?;
            let prefix = format!("{h}|");
            self.0.with_state(|s| {
                s.log
                    .revoked_certs
                    .iter()
                    .filter_map(|k| k.strip_prefix(&prefix).map(str::to_owned))
                    .collect()
            })
        })
    }

    /// The name's newest registered key when unrevoked. A different (unrevoked) key presented for a registered name
    /// passes here and is then told `replaced` by [`Self::retired`] (§15.4.1: the log's newest `box-register` evicts the
    /// older keys); the HELLO's own signatures still have to verify under it.
    fn stk<'a>(&'a self, server_id: &'a str, presented: &'a str) -> BoxFut<'a, Option<String>> {
        Box::pin(async move {
            let name = server_id.to_ascii_lowercase();
            let presented = presented.to_ascii_lowercase();
            self.0
                .with_state(|s| {
                    let b = relay_log_box(&s.log, &name)?;
                    let revoked =
                        s.log.revoked_boxes.get(&b.box_pub).copied().unwrap_or(0) >= b.reg_gen;
                    if revoked {
                        return None;
                    }
                    Some(if s.log.revoked_boxes.contains_key(&presented) {
                        b.box_pub.clone()
                    } else {
                        presented
                    })
                })
                .flatten()
        })
    }

    fn retired<'a>(&'a self, pod: &'a str, stk: &'a str) -> BoxFut<'a, bool> {
        Box::pin(async move {
            let name = pod.to_ascii_lowercase();
            let stk = stk.to_ascii_lowercase();
            self.0
                .with_state(|s| relay_log_box(&s.log, &name).is_some_and(|b| b.box_pub != stk))
                .unwrap_or(false)
        })
    }
}

/// The serving gate's record in mesh mode: the admin key, regGen and revocation from the log; the policy and leases
/// come from the box's HELLO, and only a policy whose hash is the log's head for (box, regGen) counts.
#[derive(Debug, Clone)]
pub struct MeshServingFetch(pub Mesh);

impl ServingFetch for MeshServingFetch {
    fn record<'a>(
        &'a self,
        username: &'a str,
        box_pub: &'a str,
    ) -> BoxFut<'a, Option<ServingFetched>> {
        Box::pin(async move {
            let user = username.to_ascii_lowercase();
            let box_pub = box_pub.to_ascii_lowercase();
            self.0
                .with_state(|s| {
                    s.applied_head.as_ref()?;
                    let Some(name_hash) = s.log.box_names.get(&box_pub) else {
                        return Some(ServingFetched::UnknownBox);
                    };
                    let Some(reg) = s
                        .log
                        .boxes_by_name
                        .get(name_hash)
                        .filter(|b| b.box_pub == box_pub)
                    else {
                        return Some(ServingFetched::UnknownBox);
                    };
                    let head =
                        relay_log_policy_head(&s.log, &box_pub, reg.reg_gen).map(|h| PolicyHead {
                            policy_sha256: h.policy_sha256.clone(),
                        });
                    Some(ServingFetched::Record(ComServingRecord {
                        admin_key: relay_log_admin_key(&s.log, &user).map(str::to_owned),
                        reg_gen: reg.reg_gen,
                        revoked: s.log.revoked_boxes.get(&box_pub).copied().unwrap_or(0)
                            >= reg.reg_gen,
                        policy: None,
                        leases: Vec::new(),
                        mesh: Some(crate::serving::MeshRecord { policy_head: head }),
                    }))
                })
                .flatten()
        })
    }

    fn admin_key<'a>(&'a self, username: &'a str) -> BoxFut<'a, Option<String>> {
        Box::pin(async move {
            let user = username.to_ascii_lowercase();
            self.0
                .with_state(|s| relay_log_admin_key(&s.log, &user).map(str::to_owned))
                .flatten()
        })
    }
}
