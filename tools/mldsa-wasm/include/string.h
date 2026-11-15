/* The four libc calls mldsa-native makes, for a freestanding wasm32 build (mldsa_wasm.c defines them). */
#ifndef FL_WASM_STRING_H
#define FL_WASM_STRING_H
#include <stddef.h>
void *memcpy(void *d, const void *s, size_t n);
void *memmove(void *d, const void *s, size_t n);
void *memset(void *d, int c, size_t n);
int memcmp(const void *a, const void *b, size_t n);
#endif
