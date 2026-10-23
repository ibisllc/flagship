;; Imports from a non-WASI module.
(module
  (import "env" "connect" (func $connect (param i32) (result i32)))
  (memory (export "memory") 1)
  (func (export "_start") (drop (call $connect (i32.const 0)))))
