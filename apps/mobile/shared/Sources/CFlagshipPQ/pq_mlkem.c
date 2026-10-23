/* One compilation unit: the vendored mlkem-native monolithic build, ML-KEM-768 only, plus its
 * FIPS 202 code for X-Wing's SHAKE256 and SHA3-256. */
#define MLK_CONFIG_PARAMETER_SET 768
#define MLK_CONFIG_NAMESPACE_PREFIX fl_mlkem_impl
#define MLK_CONFIG_NO_RANDOMIZED_API
#define MLK_CONFIG_INTERNAL_API_QUALIFIER static
#define MLK_CONFIG_EXTERNAL_API_QUALIFIER static
#include "vendor/mlkem/mlkem_native.c"
#include "vendor/mlkem/mlkem_native.h"
#include "cflagship_pq.h"

int fl_mlkem768_keypair_derand(uint8_t pk[FL_MLKEM768_PUBLICKEYBYTES], uint8_t sk[FL_MLKEM768_SECRETKEYBYTES], const uint8_t coins[64]) {
  return fl_mlkem_impl_keypair_derand(pk, sk, coins);
}

int fl_mlkem768_enc_derand(uint8_t ct[FL_MLKEM768_CIPHERTEXTBYTES], uint8_t ss[32], const uint8_t pk[FL_MLKEM768_PUBLICKEYBYTES], const uint8_t coins[32]) {
  return fl_mlkem_impl_enc_derand(ct, ss, pk, coins);
}

int fl_mlkem768_dec(uint8_t ss[32], const uint8_t ct[FL_MLKEM768_CIPHERTEXTBYTES], const uint8_t sk[FL_MLKEM768_SECRETKEYBYTES]) {
  return fl_mlkem_impl_dec(ss, ct, sk);
}

void fl_sha3_256(uint8_t out[32], const uint8_t *in, size_t inlen) { fl_mlkem_impl_sha3_256(out, in, inlen); }

void fl_shake256(uint8_t *out, size_t outlen, const uint8_t *in, size_t inlen) { fl_mlkem_impl_shake256(out, outlen, in, inlen); }
