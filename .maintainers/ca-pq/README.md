# `.maintainers/ca-pq/`

The PQ half of the CA endorsement leases in `../ca-endorsements/`
(`packages/protocol/src/caLeasePq.ts`, `docs/architecture-v2/pq-suites.md` §16).

- `bindings/*.json`: the ca-track holder key's `flagship/pq-key-binding/v1`
  (role `release-key`, subject `flagship-ca-track`).
- `endorsements/*.json`: one `CaEndorsementPq` companion per lease, signed with the hybrid suite.
- `bundle.json`: `{ bindings, endorsements }` for the `.com` Worker, the same files in one.

While the code pin `CA_LEASE_PQ_PIN` names no key these files change nothing. Once it names
one, every consumer (box, Worker, the relay-trust check) drops a lease without a verified
companion, except the leases the pin lists as signed before the cut-over.
