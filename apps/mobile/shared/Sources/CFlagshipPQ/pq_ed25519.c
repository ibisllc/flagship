/*
 * Ed25519 strict point validation (pq-suites.md §5.3): canonical encoding, not of small order,
 * torsion-free. The field and group code follows TweetNaCl (public domain): 16 limbs of 16 bits
 * in int64, so it needs no 128-bit integers (watchOS arm64_32). Variable time: it only ever
 * sees public keys and the public R half of signatures.
 */
#include "cflagship_pq.h"
#include <string.h>

typedef int64_t gf[16];

static const gf gf0 = {0};
static const gf gf1 = {1};
static const gf D = {0x78a3, 0x1359, 0x4dca, 0x75eb, 0xd8ab, 0x4141, 0x0a4d, 0x0070,
                     0xe898, 0x7779, 0x4079, 0x8cc7, 0xfe73, 0x2b6f, 0x6cee, 0x5203};
static const gf D2 = {0xf159, 0x26b2, 0x9b94, 0xebd6, 0xb156, 0x8283, 0x149a, 0x00e0,
                      0xd130, 0xeef3, 0x80f2, 0x198e, 0xfce7, 0x56df, 0xd9dc, 0x2406};
static const gf SQRTM1 = {0xa0b0, 0x4a0e, 0x1b27, 0xc4ee, 0xe478, 0xad2f, 0x1806, 0x2f43,
                          0xd7a7, 0x3dfb, 0x0099, 0x2b4d, 0xdf0b, 0x4fc1, 0x2480, 0x2b83};
/* L = 2^252 + 27742317777372353535851937790883648493, little endian. */
static const uint8_t ORDER_L[32] = {0xed, 0xd3, 0xf5, 0x5c, 0x1a, 0x63, 0x12, 0x58, 0xd6, 0x9c, 0xf7,
                                    0xa2, 0xde, 0xf9, 0xde, 0x14, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x10};
static const uint8_t EIGHT[32] = {8};

static void set25519(gf r, const gf a) {
  for (int i = 0; i < 16; i++) r[i] = a[i];
}

static void car25519(gf o) {
  for (int i = 0; i < 16; i++) {
    o[i] += (int64_t)1 << 16;
    int64_t c = o[i] >> 16;
    if (i < 15)
      o[i + 1] += c - 1;
    else
      o[0] += 38 * (c - 1);
    o[i] -= c * 65536;
  }
}

static void sel25519(gf p, gf q, int b) {
  int64_t c = ~((int64_t)b - 1);
  for (int i = 0; i < 16; i++) {
    int64_t t = c & (p[i] ^ q[i]);
    p[i] ^= t;
    q[i] ^= t;
  }
}

static void pack25519(uint8_t o[32], const gf n) {
  gf m, t;
  set25519(t, n);
  car25519(t);
  car25519(t);
  car25519(t);
  for (int j = 0; j < 2; j++) {
    m[0] = t[0] - 0xffed;
    for (int i = 1; i < 15; i++) {
      m[i] = t[i] - 0xffff - ((m[i - 1] >> 16) & 1);
      m[i - 1] &= 0xffff;
    }
    m[15] = t[15] - 0x7fff - ((m[14] >> 16) & 1);
    int b = (int)((m[15] >> 16) & 1);
    m[14] &= 0xffff;
    sel25519(t, m, 1 - b);
  }
  for (int i = 0; i < 16; i++) {
    o[2 * i] = (uint8_t)(t[i] & 0xff);
    o[2 * i + 1] = (uint8_t)((t[i] >> 8) & 0xff);
  }
}

static int neq25519(const gf a, const gf b) {
  uint8_t c[32], d[32];
  pack25519(c, a);
  pack25519(d, b);
  return memcmp(c, d, 32) != 0;
}

static int par25519(const gf a) {
  uint8_t d[32];
  pack25519(d, a);
  return d[0] & 1;
}

static void unpack25519(gf o, const uint8_t n[32]) {
  for (int i = 0; i < 16; i++) o[i] = n[2 * i] + ((int64_t)n[2 * i + 1] << 8);
  o[15] &= 0x7fff;
}

static void A(gf o, const gf a, const gf b) {
  for (int i = 0; i < 16; i++) o[i] = a[i] + b[i];
}

static void Z(gf o, const gf a, const gf b) {
  for (int i = 0; i < 16; i++) o[i] = a[i] - b[i];
}

static void M(gf o, const gf a, const gf b) {
  int64_t t[31] = {0};
  for (int i = 0; i < 16; i++)
    for (int j = 0; j < 16; j++) t[i + j] += a[i] * b[j];
  for (int i = 0; i < 15; i++) t[i] += 38 * t[i + 16];
  for (int i = 0; i < 16; i++) o[i] = t[i];
  car25519(o);
  car25519(o);
}

static void S(gf o, const gf a) { M(o, a, a); }

static void pow2523(gf o, const gf i) {
  gf c;
  set25519(c, i);
  for (int a = 250; a >= 0; a--) {
    S(c, c);
    if (a != 1) M(c, c, i);
  }
  set25519(o, c);
}

static void add(gf p[4], gf q[4]) {
  gf a, b, c, d, t, e, f, g, h;
  Z(a, p[1], p[0]);
  Z(t, q[1], q[0]);
  M(a, a, t);
  A(b, p[0], p[1]);
  A(t, q[0], q[1]);
  M(b, b, t);
  M(c, p[3], q[3]);
  M(c, c, D2);
  M(d, p[2], q[2]);
  A(d, d, d);
  Z(e, b, a);
  Z(f, d, c);
  A(g, d, c);
  A(h, b, a);
  M(p[0], e, f);
  M(p[1], h, g);
  M(p[2], g, f);
  M(p[3], e, h);
}

static void cswap(gf p[4], gf q[4], int b) {
  for (int i = 0; i < 4; i++) sel25519(p[i], q[i], b);
}

/* p = [s]q; q is consumed. */
static void scalarmult(gf p[4], gf q[4], const uint8_t s[32]) {
  set25519(p[0], gf0);
  set25519(p[1], gf1);
  set25519(p[2], gf1);
  set25519(p[3], gf0);
  for (int i = 255; i >= 0; --i) {
    int b = (s[i / 8] >> (i & 7)) & 1;
    cswap(p, q, b);
    add(q, p);
    add(p, p);
    cswap(p, q, b);
  }
}

static int is_identity(gf p[4]) {
  /* X = 0 and Y = Z (projective). */
  return !neq25519(p[0], gf0) && !neq25519(p[1], p[2]);
}

/* Decodes P (not negated). Returns -1 when y is not a valid field element or no x exists. */
static int unpack_point(gf r[4], const uint8_t p[32]) {
  gf t, chk, num, den, den2, den4, den6;
  set25519(r[2], gf1);
  unpack25519(r[1], p);
  S(num, r[1]);
  M(den, num, D);
  Z(num, num, r[2]);
  A(den, r[2], den);
  S(den2, den);
  S(den4, den2);
  M(den6, den4, den2);
  M(t, den6, num);
  M(t, t, den);
  pow2523(t, t);
  M(t, t, num);
  M(t, t, den);
  M(t, t, den);
  M(r[0], t, den);
  S(chk, r[0]);
  M(chk, chk, den);
  if (neq25519(chk, num)) M(r[0], r[0], SQRTM1);
  S(chk, r[0]);
  M(chk, chk, den);
  if (neq25519(chk, num)) return -1;
  if (par25519(r[0]) != (p[31] >> 7)) Z(r[0], gf0, r[0]);
  M(r[3], r[0], r[1]);
  return 0;
}

static int y_canonical(const uint8_t p[32]) {
  /* y (the low 255 bits) < 2^255 - 19. */
  if ((p[31] & 0x7f) != 0x7f) return 1;
  for (int i = 30; i >= 1; i--)
    if (p[i] != 0xff) return 1;
  return p[0] < 0xed;
}

int fl_ed25519_point_strict(const uint8_t p[32]) {
  gf P[4], Q[4], R[4];
  if (!y_canonical(p)) return 0;
  if (unpack_point(P, p) != 0) return 0;
  uint8_t x[32];
  pack25519(x, P[0]);
  int xzero = 1;
  for (int i = 0; i < 32; i++)
    if (x[i]) xzero = 0;
  if (xzero && (p[31] & 0x80)) return 0;
  for (int i = 0; i < 4; i++) set25519(Q[i], P[i]);
  scalarmult(R, Q, EIGHT);
  if (is_identity(R)) return 0;
  for (int i = 0; i < 4; i++) set25519(Q[i], P[i]);
  scalarmult(R, Q, ORDER_L);
  return is_identity(R);
}
