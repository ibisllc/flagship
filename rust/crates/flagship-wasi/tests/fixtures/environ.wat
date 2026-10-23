;; Exits with (env count * 100 + argc), so a test can see exactly what was granted.
(module
  (import "wasi_snapshot_preview1" "environ_sizes_get"
    (func $environ_sizes_get (param i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "args_sizes_get"
    (func $args_sizes_get (param i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "proc_exit" (func $proc_exit (param i32)))
  (memory (export "memory") 1)
  (func (export "_start")
    (drop (call $environ_sizes_get (i32.const 0) (i32.const 4)))
    (drop (call $args_sizes_get (i32.const 8) (i32.const 12)))
    (call $proc_exit (i32.add (i32.mul (i32.load (i32.const 0)) (i32.const 100))
                              (i32.load (i32.const 8))))))
