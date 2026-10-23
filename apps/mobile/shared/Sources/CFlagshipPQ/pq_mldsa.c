/* One compilation unit: the vendored mldsa-native monolithic build, ML-DSA-65 only. */
#define MLD_CONFIG_PARAMETER_SET 65
#define MLD_CONFIG_NAMESPACE_PREFIX fl_mldsa_impl
#define MLD_CONFIG_NO_RANDOMIZED_API
#define MLD_CONFIG_INTERNAL_API_QUALIFIER static
#define MLD_CONFIG_EXTERNAL_API_QUALIFIER static
#include "vendor/mldsa/mldsa_native.c"
#include "vendor/mldsa/mldsa_native.h"
#include "cflagship_pq.h"
#include <string.h>

int fl_mldsa65_keypair(uint8_t pk[FL_MLDSA65_PUBLICKEYBYTES], uint8_t sk[FL_MLDSA65_SECRETKEYBYTES], const uint8_t seed[32]) {
  return fl_mldsa_impl_keypair_internal(pk, sk, seed);
}

int fl_mldsa65_sign(uint8_t sig[FL_MLDSA65_BYTES], const uint8_t *m, size_t mlen, const uint8_t *ctx, size_t ctxlen,
                    const uint8_t rnd[32], const uint8_t sk[FL_MLDSA65_SECRETKEYBYTES]) {
  uint8_t pre[257];
  if (ctxlen > 255) return -1;
  pre[0] = 0;
  pre[1] = (uint8_t)ctxlen;
  if (ctxlen) memcpy(pre + 2, ctx, ctxlen);
  return fl_mldsa_impl_signature_internal(sig, m, mlen, pre, ctxlen + 2, rnd, sk, 0);
}

int fl_mldsa65_verify(const uint8_t *sig, size_t siglen, const uint8_t *m, size_t mlen, const uint8_t *ctx, size_t ctxlen,
                      const uint8_t pk[FL_MLDSA65_PUBLICKEYBYTES]) {
  if (siglen != FL_MLDSA65_BYTES) return -1;
  return fl_mldsa_impl_verify(sig, m, mlen, ctx, ctxlen, pk);
}
