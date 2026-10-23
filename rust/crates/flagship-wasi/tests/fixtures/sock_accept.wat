;; WASI p1's only socket call works on preopened sockets; there are none.
;; Exits with the errno sock_accept returns for stdin (fd 0).
(module
  (import "wasi_snapshot_preview1" "sock_accept"
    (func $sock_accept (param i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "proc_exit" (func $proc_exit (param i32)))
  (memory (export "memory") 1)
  (func (export "_start")
    (call $proc_exit (call $sock_accept (i32.const 0) (i32.const 0) (i32.const 64)))))
