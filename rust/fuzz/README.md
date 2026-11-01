# flagship-fuzz

libFuzzer targets for the box's parsers (plan G10): the ingress HTTP/1 head, response head and
chunked decoder (`flagship-ingress/src/http.rs`), the broker's archive check
(`flagship-broker/src/tarcheck.rs`) and the access path/origin normalisers
(`flagship-access/src/path.rs`, `origin.rs`). The relay's own targets are in
`crates/flagship-relay/fuzz`.

Run one target for a bounded time from `rust/fuzz` (needs a nightly toolchain and `cargo install cargo-fuzz`):

    cargo +nightly fuzz run <target> corpus/<target> -- -max_total_time=N

Targets: `ingress_request_head`, `ingress_response_head`, `ingress_chunked`, `broker_tarcheck`,
`access_path`, `access_origin`. Each asserts invariants beyond "no panic" (see the comments in
`fuzz_targets/`). Seeds are in `corpus/<target>/`; a crash lands in `artifacts/<target>/`.
