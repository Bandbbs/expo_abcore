#ifndef EXPO_ABCORE_H
#define EXPO_ABCORE_H

#include <stddef.h>
#include <stdint.h>

typedef int32_t (*expo_abcore_send_callback)(void *context, const uint8_t *data, size_t length);
typedef void (*expo_abcore_event_callback)(void *context, const char *name, const char *payload);

int32_t expo_abcore_init(void);
int32_t expo_abcore_set_callbacks(
  expo_abcore_send_callback send,
  expo_abcore_event_callback event,
  void *context
);
void expo_abcore_clear_callbacks(void);
char *expo_abcore_call(const char *command, const char *input);
int32_t expo_abcore_on_packet(
  const char *kind,
  const char *address,
  const uint8_t *data,
  size_t length
);
void expo_abcore_string_free(char *value);

#endif
