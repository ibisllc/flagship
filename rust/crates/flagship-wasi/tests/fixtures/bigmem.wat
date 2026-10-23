;; Declares 256 MiB of initial memory.
(module
  (memory (export "memory") 4096)
  (func (export "_start")))
