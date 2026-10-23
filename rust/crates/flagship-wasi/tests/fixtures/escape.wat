;; Tries to open ../secret.txt through the first preopen; exits with the errno.
(module
  (import "wasi_snapshot_preview1" "path_open"
    (func $path_open (param i32 i32 i32 i32 i32 i64 i64 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "proc_exit" (func $proc_exit (param i32)))
  (memory (export "memory") 1)
  (data (i32.const 128) "../secret.txt")
  (func (export "_start")
    (call $proc_exit (call $path_open (i32.const 3) (i32.const 0) (i32.const 128) (i32.const 13)
      (i32.const 0) (i64.const 0x2) (i64.const 0) (i32.const 0) (i32.const 204)))))
