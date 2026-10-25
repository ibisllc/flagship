// The ROCm/HIP twin of vector_add.cu (api "hip").
#include <cstdio>
#include <hip/hip_runtime.h>

__global__ void add(const float* a, const float* b, float* c, unsigned n) {
  unsigned i = blockIdx.x * blockDim.x + threadIdx.x;
  if (i < n) c[i] = a[i] + b[i];
}

int main() {
  const unsigned n = 1u << 20;
  float *a, *b, *c;
  if (hipMallocManaged(&a, n * sizeof(float)) || hipMallocManaged(&b, n * sizeof(float)) || hipMallocManaged(&c, n * sizeof(float))) return 1;
  for (unsigned i = 0; i < n; i++) { a[i] = i * 0.5f; b[i] = (n - i) * 0.25f; c[i] = -1.0f; }
  hipLaunchKernelGGL(add, dim3((n + 255) / 256), dim3(256), 0, 0, a, b, c, n);
  if (hipDeviceSynchronize() != hipSuccess) return 1;
  double sum = 0;
  for (unsigned i = 0; i < n; i++) sum += c[i];
  unsigned idx[6] = {0, 1, n / 3, n / 2, n - 2, n - 1};
  printf("{\"schema\":\"flagship/gpu-vector-add/v1\",\"api\":\"hip\",\"n\":%u,\"checksum\":%.17g,\"samples\":[", n, sum);
  for (int k = 0; k < 6; k++) printf("%s[%u,%.17g]", k ? "," : "", idx[k], (double)c[idx[k]]);
  printf("]}\n");
  return 0;
}
