// flagship/gpu-vector-add/v1: a[i] = i*0.5, b[i] = (n-i)*0.25, c = a + b on the device; every sum
// is exact in f32 for n = 2^20, so the report must match numerics.rs bit for bit.
#include <cstdio>
#include <cuda_runtime.h>

__global__ void add(const float* a, const float* b, float* c, unsigned n) {
  unsigned i = blockIdx.x * blockDim.x + threadIdx.x;
  if (i < n) c[i] = a[i] + b[i];
}

int main() {
  const unsigned n = 1u << 20;
  float *a, *b, *c;
  if (cudaMallocManaged(&a, n * sizeof(float)) || cudaMallocManaged(&b, n * sizeof(float)) || cudaMallocManaged(&c, n * sizeof(float))) {
    fprintf(stderr, "allocation failed\n");
    return 1;
  }
  for (unsigned i = 0; i < n; i++) { a[i] = i * 0.5f; b[i] = (n - i) * 0.25f; c[i] = -1.0f; }
  add<<<(n + 255) / 256, 256>>>(a, b, c, n);
  if (cudaDeviceSynchronize() != cudaSuccess) { fprintf(stderr, "kernel failed\n"); return 1; }
  double sum = 0;
  for (unsigned i = 0; i < n; i++) sum += c[i];
  unsigned idx[6] = {0, 1, n / 3, n / 2, n - 2, n - 1};
  printf("{\"schema\":\"flagship/gpu-vector-add/v1\",\"api\":\"cuda\",\"n\":%u,\"checksum\":%.17g,\"samples\":[", n, sum);
  for (int k = 0; k < 6; k++) printf("%s[%u,%.17g]", k ? "," : "", idx[k], (double)c[idx[k]]);
  printf("]}\n");
  return 0;
}
