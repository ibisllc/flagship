// Imported first by the Worker entry. @noble/ed25519 builds a precomputation
// table for the base point the first time anything signs, verifies or derives a
// key: about 20 ms of CPU. Done here, in the module's global scope, it is paid
// while the isolate starts (the runtime bills startup separately, with its own
// one-second limit) instead of inside the first request, which on the Free plan
// has 10 ms in total. Derives a throwaway public key; no secret is involved.
import { ed } from "@flagship/protocol";

ed.getPublicKey(new Uint8Array(32).fill(1));
