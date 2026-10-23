;; Writes "hello\n" to out.txt in the first preopen (fd 3) and to stdout.
(module
  (import "wasi_snapshot_preview1" "path_open"
    (func $path_open (param i32 i32 i32 i32 i32 i64 i64 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_write"
    (func $fd_write (param i32 i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_close" (func $fd_close (param i32) (result i32)))
  (import "wasi_snapshot_preview1" "proc_exit" (func $proc_exit (param i32)))
  (memory (export "memory") 1)
  (data (i32.const 64) "hello\n")
  (data (i32.const 128) "out.txt")
  (func (export "_start") (local $err i32)
    ;; iovec { ptr = 64, len = 6 } at 0
    (i32.store (i32.const 0) (i32.const 64))
    (i32.store (i32.const 4) (i32.const 6))
    ;; O_CREAT | O_TRUNC, rights fd_write
    (local.set $err (call $path_open (i32.const 3) (i32.const 0) (i32.const 128) (i32.const 7)
      (i32.const 9) (i64.const 0x40) (i64.const 0) (i32.const 0) (i32.const 204)))
    (if (local.get $err) (then (call $proc_exit (i32.add (i32.const 100) (local.get $err)))))
    (local.set $err (call $fd_write (i32.load (i32.const 204)) (i32.const 0) (i32.const 1) (i32.const 200)))
    (if (local.get $err) (then (call $proc_exit (i32.add (i32.const 200) (local.get $err)))))
    (drop (call $fd_close (i32.load (i32.const 204))))
    (local.set $err (call $fd_write (i32.const 1) (i32.const 0) (i32.const 1) (i32.const 200)))
    (if (local.get $err) (then (call $proc_exit (i32.add (i32.const 300) (local.get $err)))))))
