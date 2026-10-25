// The Level Zero / oneAPI (SYCL) twin of vector_add.cu (api "sycl"); run with
// ONEAPI_DEVICE_SELECTOR=level_zero:gpu so it can't fall back to a CPU device.
#include <cstdio>
#include <sycl/sycl.hpp>

int main() {
  const unsigned n = 1u << 20;
  sycl::queue q{sycl::gpu_selector_v};
  float* a = sycl::malloc_shared<float>(n, q);
  float* b = sycl::malloc_shared<float>(n, q);
  float* c = sycl::malloc_shared<float>(n, q);
  for (unsigned i = 0; i < n; i++) { a[i] = i * 0.5f; b[i] = (n - i) * 0.25f; c[i] = -1.0f; }
  q.parallel_for(sycl::range<1>(n), [=](sycl::id<1> i) { c[i] = a[i] + b[i]; }).wait();
  double sum = 0;
  for (unsigned i = 0; i < n; i++) sum += c[i];
  unsigned idx[6] = {0, 1, n / 3, n / 2, n - 2, n - 1};
  printf("{\"schema\":\"flagship/gpu-vector-add/v1\",\"api\":\"sycl\",\"n\":%u,\"checksum\":%.17g,\"samples\":[", n, sum);
  for (int k = 0; k < 6; k++) printf("%s[%u,%.17g]", k ? "," : "", idx[k], (double)c[idx[k]]);
  printf("]}\n");
  return 0;
}
