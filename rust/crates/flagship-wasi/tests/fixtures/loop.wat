;; Never returns and never calls the host.
(module
  (memory (export "memory") 1)
  (func (export "_start") (loop $l (br $l))))
