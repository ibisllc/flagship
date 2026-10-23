;; Grows linear memory 16 MiB at a time until the host says no.
(module
  (memory (export "memory") 1)
  (func (export "_start")
    (loop $l
      (br_if $l (i32.ne (memory.grow (i32.const 256)) (i32.const -1))))))
