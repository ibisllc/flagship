// flagship/gpu-scrub-report/v1. Default mode: take as much device memory as the driver will give
// (in 64 MiB chunks), count residue canaries left by an earlier tenant, overwrite everything with
// a pattern, read it back, zero it, and count canaries again (must be 0). `canary` mode is the
// qualification tenant: it fills memory with canaries and exits without clearing them.
#include <cstdio>
#include <cstring>
#include <vector>
#include <cuda_runtime.h>

static const unsigned long long CANARY = 0x464C41475245534Bull;  // "FLAGRESK"
static const size_t CHUNK = 64ull << 20;

__global__ void fill(unsigned long long* p, size_t n, unsigned long long v) {
  size_t i = blockIdx.x * (size_t)blockDim.x + threadIdx.x;
  for (; i < n; i += (size_t)gridDim.x * blockDim.x) p[i] = v;
}
__global__ void count(const unsigned long long* p, size_t n, unsigned long long v, unsigned long long* hits) {
  size_t i = blockIdx.x * (size_t)blockDim.x + threadIdx.x;
  unsigned long long local = 0;
  for (; i < n; i += (size_t)gridDim.x * blockDim.x) local += (p[i] == v);
  if (local) atomicAdd(hits, local);
}

int main(int argc, char** argv) {
  bool canary_mode = argc > 1 && strcmp(argv[1], "canary") == 0;
  size_t free_b = 0, total_b = 0;
  cudaMemGetInfo(&free_b, &total_b);
  std::vector<unsigned long long*> chunks;
  for (;;) {
    void* p = nullptr;
    if (cudaMalloc(&p, CHUNK) != cudaSuccess) break;
    chunks.push_back((unsigned long long*)p);
  }
  cudaGetLastError();
  size_t words = CHUNK / 8;
  unsigned long long* hits;
  cudaMallocManaged(&hits, sizeof(unsigned long long));
  if (canary_mode) {
    for (auto* c : chunks) fill<<<1024, 256>>>(c, words, CANARY);
    cudaDeviceSynchronize();
    printf("{\"schema\":\"flagship/gpu-residue-canary/v1\",\"bytes\":%zu}\n", chunks.size() * CHUNK);
    return 0;
  }
  *hits = 0;
  for (auto* c : chunks) count<<<1024, 256>>>(c, words, CANARY, hits);
  cudaDeviceSynchronize();
  unsigned long long before = *hits;
  const unsigned long long PATTERN = 0xA5A5A5A5A5A5A5A5ull;
  for (auto* c : chunks) fill<<<1024, 256>>>(c, words, PATTERN);
  *hits = 0;
  for (auto* c : chunks) count<<<1024, 256>>>(c, words, PATTERN, hits);
  cudaDeviceSynchronize();
  bool verified = *hits == (unsigned long long)chunks.size() * words;
  for (auto* c : chunks) fill<<<1024, 256>>>(c, words, 0ull);
  *hits = 0;
  for (auto* c : chunks) count<<<1024, 256>>>(c, words, CANARY, hits);
  cudaDeviceSynchronize();
  printf("{\"schema\":\"flagship/gpu-scrub-report/v1\",\"bytesTotal\":%zu,\"bytesScrubbed\":%zu,\"patternVerified\":%s,\"canariesBefore\":%llu,\"canariesAfter\":%llu}\n",
         total_b, chunks.size() * CHUNK, verified ? "true" : "false", before, *hits);
  return 0;
}
