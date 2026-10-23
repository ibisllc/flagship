;; Imports a socket-open call that is not part of WASI p1 (a WasmEdge-style
;; extension). The worker must refuse to link it.
(module
  (import "wasi_snapshot_preview1" "sock_open"
    (func $sock_open (param i32 i32 i32) (result i32)))
  (memory (export "memory") 1)
  (func (export "_start")
    (drop (call $sock_open (i32.const 1) (i32.const 1) (i32.const 64)))))
