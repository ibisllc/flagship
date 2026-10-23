;; Grows a table by a million elements.
(module
  (memory (export "memory") 1)
  (table $t 1 funcref)
  (func (export "_start")
    (drop (table.grow $t (ref.null func) (i32.const 1000000)))))
