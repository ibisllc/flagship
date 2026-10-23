;; Blocks in a host call: poll_oneoff on a 60 s relative clock.
(module
  (import "wasi_snapshot_preview1" "poll_oneoff"
    (func $poll_oneoff (param i32 i32 i32 i32) (result i32)))
  (memory (export "memory") 1)
  (func (export "_start")
    ;; subscription at 0: userdata 0, tag 0 (clock), clock id 1 (monotonic),
    ;; timeout 60 s, precision 0, flags 0 (relative)
    (i64.store (i32.const 0) (i64.const 0))
    (i32.store8 (i32.const 8) (i32.const 0))
    (i32.store (i32.const 16) (i32.const 1))
    (i64.store (i32.const 24) (i64.const 60000000000))
    (i64.store (i32.const 32) (i64.const 0))
    (i32.store16 (i32.const 40) (i32.const 0))
    (drop (call $poll_oneoff (i32.const 0) (i32.const 64) (i32.const 1) (i32.const 128)))))
