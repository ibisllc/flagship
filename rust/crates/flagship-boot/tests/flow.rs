//! The unlock flow against an in-process worker: lease, relay, heartbeat,
//! backoff, and the refusals (replayed reply, wrong server, failed announce,
//! window end, console fallback).
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects,
    clippy::panic
)]

mod common;

use common::*;
use flagship_boot::identity::BoxIdentity;
use flagship_boot::seal::{self, SealError};
use flagship_boot::unlock::flow::{Mode, RelayTiming, UnlockError, Unlocker};
use flagship_boot::unlock::policy::EndpointPolicy;
use flagship_boot::unlock::transport::Method;
use std::cell::{Cell, RefCell};
use std::rc::Rc;

struct Run {
    worker: MockTransport,
    clock: FakeClock,
    log: Vec<u8>,
}

impl Run {
    fn new(setup: impl FnOnce(&mut Worker)) -> Self {
        let now = Rc::new(Cell::new(T0));
        let mut w = Worker::new(now.clone());
        setup(&mut w);
        Self {
            worker: MockTransport(RefCell::new(w)),
            clock: FakeClock::new(now),
            log: Vec::new(),
        }
    }

    fn unlock(&mut self, mode: Mode, timing: RelayTiming) -> Result<Vec<u8>, UnlockError> {
        let id = BoxIdentity::from_seed(&SEED_A);
        let endpoint = EndpointPolicy::default()
            .resolve("https://boot.flagshipserver.com")
            .unwrap();
        let random = CountingRandom(Cell::new(0));
        let mut u = Unlocker {
            server_domain: DOMAIN,
            identity: &id,
            endpoint: &endpoint,
            transport: &self.worker,
            clock: &self.clock,
            random: &random,
            timing,
            console_hint: false,
            log: &mut self.log,
        };
        u.unlock(mode).map(|k| k.to_vec())
    }

    fn calls(&self) -> Vec<(Method, String)> {
        self.worker.0.borrow().calls.clone()
    }

    fn log(&self) -> String {
        String::from_utf8_lossy(&self.log).into_owned()
    }
}

fn reply_for(seed: [u8; 32], purpose: &'static str, nonce_override: Option<&'static str>) -> Reply {
    Reply::After {
        after: 2,
        build: Rc::new(move |nonce: &str| {
            seal::build_sealed_secret_response_with(
                &luks_key(),
                &xpub(&seed),
                nonce_override.unwrap_or(nonce),
                purpose,
                [9; 32],
                [8; 12],
            )
        }),
    }
}

const QUICK: RelayTiming = RelayTiming {
    window_secs: 600,
    heartbeat_secs: 120,
};
const LEASE_PATH: &str = "/api/boot/lease/home.alice.flagship.services";

#[test]
fn auto_opens_the_lease_without_asking_the_phone() {
    let mut r = Run::new(|w| {
        w.lease = Some(seal::seal_for_recipient_with(
            &luks_key(),
            &xpub(&SEED_A),
            [1; 32],
            [2; 12],
        ))
    });
    assert_eq!(r.unlock(Mode::Auto, QUICK).unwrap(), luks_key());
    assert_eq!(r.calls(), vec![(Method::Get, LEASE_PATH.to_owned())]);
    assert!(r.log().contains("self-unlocked from the box-sealed lease"));
    assert!(
        !r.log().contains(
            &common::luks_key()
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect::<String>()
        )
    );
}

#[test]
fn auto_falls_back_to_the_relay_on_404_and_423() {
    for suspended in [false, true] {
        let mut r = Run::new(|w| {
            w.suspended = suspended;
            w.lease = suspended.then(|| vec![0; 80]);
            w.reply = reply_for(SEED_A, "unlock-key", None);
        });
        assert_eq!(r.unlock(Mode::Auto, QUICK).unwrap(), luks_key());
        let calls = r.calls();
        assert_eq!(calls[0], (Method::Get, LEASE_PATH.to_owned()));
        assert_eq!(calls[1], (Method::Post, "/api/boot/request".to_owned()));
        assert_eq!(calls.len(), 2 + 3);
        assert!(
            r.log()
                .contains(if suspended { "HTTP 423" } else { "HTTP 404" })
        );
    }
}

#[test]
fn a_lease_for_another_box_falls_back_to_the_relay() {
    let mut r = Run::new(|w| {
        w.lease = Some(seal::seal_for_recipient_with(
            &luks_key(),
            &xpub(&SEED_B),
            [1; 32],
            [2; 12],
        ));
        w.reply = reply_for(SEED_A, "unlock-key", None);
    });
    assert_eq!(r.unlock(Mode::Auto, QUICK).unwrap(), luks_key());
    assert!(r.log().contains("unseal failed on box-lease"));
}

#[test]
fn approve_never_reads_a_lease() {
    let mut r = Run::new(|w| {
        w.lease = Some(seal::seal_for_recipient_with(
            &luks_key(),
            &xpub(&SEED_A),
            [1; 32],
            [2; 12],
        ));
        w.reply = reply_for(SEED_A, "unlock-key", None);
    });
    assert_eq!(r.unlock(Mode::Approve, QUICK).unwrap(), luks_key());
    assert!(
        r.calls()
            .iter()
            .all(|(_, p)| !p.starts_with("/api/boot/lease"))
    );
}

#[test]
fn relay_backs_off_and_heartbeats_with_the_same_signed_request() {
    let mut r = Run::new(|w| {
        w.reply = Reply::After {
            after: 12,
            build: Rc::new(|n: &str| {
                seal::build_sealed_secret_response_with(
                    &luks_key(),
                    &xpub(&SEED_A),
                    n,
                    "unlock-key",
                    [9; 32],
                    [8; 12],
                )
            }),
        }
    });
    assert_eq!(
        r.unlock(
            Mode::Approve,
            RelayTiming {
                window_secs: 10_000,
                heartbeat_secs: 60
            }
        )
        .unwrap(),
        luks_key()
    );
    assert_eq!(
        *r.clock.waits.borrow(),
        vec![3, 6, 9, 12, 15, 15, 15, 15, 15, 15, 15, 15]
    );
    let w = r.worker.0.borrow();
    assert!(
        w.bodies.len() >= 3,
        "heartbeats re-announce: {}",
        w.bodies.len()
    );
    assert!(
        w.bodies.iter().all(|b| b == &w.bodies[0]),
        "every announce is the same signed request"
    );
    assert!(
        w.refusals.is_empty(),
        "the worker refused: {:?}",
        w.refusals
    );
    let polls = w
        .calls
        .iter()
        .filter(|(_, p)| p.starts_with("/api/boot/response/"))
        .count();
    assert_eq!(polls, 13);
}

#[test]
fn a_replayed_reply_is_refused_and_ends_the_relay() {
    let mut r = Run::new(|w| {
        w.reply = reply_for(
            SEED_A,
            "unlock-key",
            Some("2323232323232323232323232323232323232323232323232323232323232323"),
        )
    });
    assert_eq!(
        r.unlock(Mode::Approve, QUICK),
        Err(UnlockError::Unseal(SealError::ContextMismatch))
    );
}

#[test]
fn a_repurposed_reply_is_refused() {
    let mut r = Run::new(|w| w.reply = reply_for(SEED_A, "entitlement", None));
    assert_eq!(
        r.unlock(Mode::Approve, QUICK),
        Err(UnlockError::Unseal(SealError::ContextMismatch))
    );
}

#[test]
fn a_reply_for_another_box_is_refused() {
    let mut r = Run::new(|w| w.reply = reply_for(SEED_B, "unlock-key", None));
    assert_eq!(
        r.unlock(Mode::Approve, QUICK),
        Err(UnlockError::Unseal(SealError::Authentication))
    );
}

#[test]
fn a_reply_without_a_sealed_payload_ends_the_relay() {
    let mut r = Run::new(|w| w.reply = Reply::Empty { after: 0 });
    assert_eq!(
        r.unlock(Mode::Approve, QUICK),
        Err(UnlockError::NoSealedPayload)
    );
}

#[test]
fn a_refused_first_announce_is_fatal() {
    let mut r = Run::new(|w| w.post_status = 403);
    assert!(matches!(
        r.unlock(Mode::Approve, QUICK),
        Err(UnlockError::Announce(_))
    ));
    assert_eq!(r.calls().len(), 1);
}

#[test]
fn transport_errors_while_polling_are_retried() {
    let mut r = Run::new(|w| {
        w.fail_transport_on_poll = vec![1, 2];
        w.reply = reply_for(SEED_A, "unlock-key", None);
    });
    assert_eq!(r.unlock(Mode::Approve, QUICK).unwrap(), luks_key());
    assert!(r.log().contains("HTTP 000"));
}

#[test]
fn the_window_bounds_the_wait() {
    let mut r = Run::new(|_| {});
    assert_eq!(
        r.unlock(
            Mode::Approve,
            RelayTiming {
                window_secs: 60,
                heartbeat_secs: 120
            }
        ),
        Err(UnlockError::WindowElapsed(60))
    );
    assert_eq!(
        r.clock.waits.borrow().iter().sum::<u64>(),
        3 + 6 + 9 + 12 + 15 + 15
    );
}

#[test]
fn manual_on_the_console_stops_the_relay() {
    let mut r = Run::new(|_| {});
    r.clock.manual_on_wait = Some(2);
    assert_eq!(
        r.unlock(Mode::Approve, QUICK),
        Err(UnlockError::ManualSelected)
    );
}

#[test]
fn a_stale_clock_is_refused_by_the_worker() {
    let mut r = Run::new(|w| w.reply = reply_for(SEED_A, "unlock-key", None));
    // Box clock 10 minutes behind the worker: the lease GET and the announce are stale.
    let now = r.clock.now.clone();
    let worker_now = Rc::new(Cell::new(T0 + 10 * 60_000));
    r.worker.0.borrow_mut().now = worker_now;
    let _ = now;
    assert!(matches!(
        r.unlock(Mode::Auto, QUICK),
        Err(UnlockError::Announce(_))
    ));
    assert_eq!(
        r.worker.0.borrow().refusals,
        vec!["stale request", "stale request"]
    );
}
