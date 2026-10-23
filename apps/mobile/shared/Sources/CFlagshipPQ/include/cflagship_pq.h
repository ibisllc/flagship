#ifndef CFLAGSHIP_PQ_H
#define CFLAGSHIP_PQ_H
/*
 * Software ML-DSA-65, ML-KEM-768, SHA3/SHAKE and the Ed25519 strict-point check behind the
 * Swift ports of packages/protocol/src/pqHybrid.ts. ML-DSA and ML-KEM are the vendored
 * mldsa-native / mlkem-native monolithic builds (vendor/VENDORED.md); randomness is always
 * supplied by the caller (no randombytes()). Every function returns 0 on success.
 */
#include <stddef.h>
#include <stdint.h>

#define FL_MLDSA65_PUBLICKEYBYTES 1952
#define FL_MLDSA65_SECRETKEYBYTES 4032
#define FL_MLDSA65_BYTES 3309
#define FL_MLKEM768_PUBLICKEYBYTES 1184
#define FL_MLKEM768_SECRETKEYBYTES 2400
#define FL_MLKEM768_CIPHERTEXTBYTES 1088

int fl_mldsa65_keypair(uint8_t pk[FL_MLDSA65_PUBLICKEYBYTES], uint8_t sk[FL_MLDSA65_SECRETKEYBYTES], const uint8_t seed[32]);
/* FIPS 204 ML-DSA.Sign (pure, with context): rnd = 32 caller bytes (all zero = deterministic). */
int fl_mldsa65_sign(uint8_t sig[FL_MLDSA65_BYTES], const uint8_t *m, size_t mlen, const uint8_t *ctx, size_t ctxlen,
                    const uint8_t rnd[32], const uint8_t sk[FL_MLDSA65_SECRETKEYBYTES]);
int fl_mldsa65_verify(const uint8_t *sig, size_t siglen, const uint8_t *m, size_t mlen, const uint8_t *ctx, size_t ctxlen,
                      const uint8_t pk[FL_MLDSA65_PUBLICKEYBYTES]);

int fl_mlkem768_keypair_derand(uint8_t pk[FL_MLKEM768_PUBLICKEYBYTES], uint8_t sk[FL_MLKEM768_SECRETKEYBYTES], const uint8_t coins[64]);
int fl_mlkem768_enc_derand(uint8_t ct[FL_MLKEM768_CIPHERTEXTBYTES], uint8_t ss[32], const uint8_t pk[FL_MLKEM768_PUBLICKEYBYTES], const uint8_t coins[32]);
int fl_mlkem768_dec(uint8_t ss[32], const uint8_t ct[FL_MLKEM768_CIPHERTEXTBYTES], const uint8_t sk[FL_MLKEM768_SECRETKEYBYTES]);

void fl_sha3_256(uint8_t out[32], const uint8_t *in, size_t inlen);
void fl_shake256(uint8_t *out, size_t outlen, const uint8_t *in, size_t inlen);

/* 1 when the 32 bytes are a canonical Ed25519 point encoding that is not of small order and
 * is torsion-free ([L]P = identity); 0 otherwise. Variable time (public data only). */
int fl_ed25519_point_strict(const uint8_t p[32]);

#endif
