/*
 * ML-DSA-65 for the webapp (docs/webapp-key-custody.md, item 4): the same vendored mldsa-native
 * v2.0.0 unit the iOS C target compiles (apps/mobile/shared/Sources/CFlagshipPQ/pq_mldsa.c),
 * built freestanding for wasm32 by build.sh. No allocator, no randomness, no imports: the caller
 * writes inputs into linear memory at the offsets below and supplies `rnd` itself.
 *
 *   [0, 32)        seed (ML-DSA KeyGen_internal seed)
 *   [32, 64)       rnd (32 bytes; all zero = deterministic)
 *   [64, 2016)     public key
 *   [2016, 6048)   expanded secret key (wiped by every call that made it)
 *   [6048, 9357)   signature
 *   [9360, 9616)   context (at most 255 bytes)
 *   [9616, ...)    message (memory grows from JS as needed)
 */
#include "pq_mldsa.c"

void *memcpy(void *d, const void *s, size_t n) {
  unsigned char *a = d;
  const unsigned char *b = s;
  while (n--) *a++ = *b++;
  return d;
}

void *memmove(void *d, const void *s, size_t n) {
  unsigned char *a = d;
  const unsigned char *b = s;
  if (a < b) {
    while (n--) *a++ = *b++;
  } else {
    while (n--) a[n] = b[n];
  }
  return d;
}

void *memset(void *d, int c, size_t n) {
  volatile unsigned char *a = d;
  while (n--) *a++ = (unsigned char)c;
  return d;
}

int memcmp(const void *a, const void *b, size_t n) {
  const unsigned char *x = a, *y = b;
  for (; n; n--, x++, y++)
    if (*x != *y) return *x - *y;
  return 0;
}

#define OFF_SEED 0
#define OFF_RND 32
#define OFF_PK 64
#define OFF_SK 2016
#define OFF_SIG 6048
#define OFF_CTX 9360
#define OFF_MSG 9616

static unsigned char arena[OFF_MSG] __attribute__((aligned(16)));

__attribute__((export_name("fl_arena"))) unsigned char *fl_arena(void) { return arena; }

__attribute__((export_name("fl_wipe"))) void fl_wipe(void) { memset(arena, 0, OFF_MSG); }

/* Public key of seed; the expanded secret is wiped. */
__attribute__((export_name("fl_pk"))) int fl_pk(void) {
  int r = fl_mldsa65_keypair(arena + OFF_PK, arena + OFF_SK, arena + OFF_SEED);
  memset(arena + OFF_SK, 0, FL_MLDSA65_SECRETKEYBYTES);
  return r;
}

/* Signs msg (at msgPtr, msgLen bytes) with context; expands the seed, signs, wipes the secret. */
__attribute__((export_name("fl_sign"))) int fl_sign(const unsigned char *msg, unsigned int msgLen, unsigned int ctxLen) {
  int r = fl_mldsa65_keypair(arena + OFF_PK, arena + OFF_SK, arena + OFF_SEED);
  if (r == 0) r = fl_mldsa65_sign(arena + OFF_SIG, msg, msgLen, arena + OFF_CTX, ctxLen, arena + OFF_RND, arena + OFF_SK);
  memset(arena + OFF_SK, 0, FL_MLDSA65_SECRETKEYBYTES);
  memset(arena + OFF_SEED, 0, 32);
  return r;
}

__attribute__((export_name("fl_verify"))) int fl_verify(const unsigned char *msg, unsigned int msgLen, unsigned int ctxLen) {
  return fl_mldsa65_verify(arena + OFF_SIG, FL_MLDSA65_BYTES, msg, msgLen, arena + OFF_CTX, ctxLen, arena + OFF_PK);
}
