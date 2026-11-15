/* C interface of flagship-turn-ffi (rust/crates/flagship-turn-ffi). One handle = one TURN connection of one call.
 *
 * Config: UTF-8, seven lines: realm, username, password, nonce, relay address ("127.0.0.1:port"), peer IP
 * ("127.0.0.1"), payload bytes per second per direction.
 *
 * Every result buffer is: status (1 byte: 0 ok, 1 not TURN, 2 too large: close the connection on 1 or 2), client
 * bytes length (4 bytes, big-endian), the client bytes, the number of peer datagrams (2 bytes), then per datagram the
 * peer port (2 bytes), its length (2 bytes) and its bytes. Free it with flagship_turn_buf_free.
 */
#ifndef FLAGSHIP_TURN_H
#define FLAGSHIP_TURN_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct FlagshipTurn FlagshipTurn;

typedef struct {
  uint8_t *ptr;
  size_t len;
  size_t cap;
} FlagshipTurnBuf;

/* NULL when the config does not parse. */
FlagshipTurn *flagship_turn_new(const uint8_t *config, size_t config_len);
void flagship_turn_free(FlagshipTurn *turn);
/* Bytes from the caller's TLS stream, in any split. */
FlagshipTurnBuf flagship_turn_client_bytes(FlagshipTurn *turn, const uint8_t *data, size_t len, uint64_t now_ms);
/* A datagram the relay socket received from the peer port; the result's client bytes are empty when it is dropped. */
FlagshipTurnBuf flagship_turn_peer_datagram(FlagshipTurn *turn, uint16_t peer_port, const uint8_t *data, size_t len,
                                            uint64_t now_ms);
int flagship_turn_is_allocated(const FlagshipTurn *turn, uint64_t now_ms);
void flagship_turn_buf_free(FlagshipTurnBuf buf);

#ifdef __cplusplus
}
#endif

#endif
