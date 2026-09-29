/*
 * Receives the existing RAMLOG type-0x04 UDP datagrams and writes JSONL to
 * the Cooja serial socket. The Contiki RAMLOG implementation is not modified.
 * Wire format: type, count, then count * {module_id, error_code, uptime_be32}.
 */
#include "contiki.h"
#include "net/netstack.h"
#include "net/routing/routing.h"
#include "net/ipv6/simple-udp.h"
#include "sys/log.h"

#include <stdint.h>
#include <stdio.h>

#define RAMLOG_UDP_PORT 5555
#define RAMLOG_PACKET_TYPE_LONG_TS 0x04
#define RAMLOG_HEADER_SIZE 2
#define RAMLOG_ENTRY_SIZE 6
#define RAMLOG_MAX_PACKET_ENTRIES 8
#define MAC_EVENT_UDP_PORT 5556
#define MAC_EVENT_PACKET_TYPE 0x06
#define MAC_EVENT_HEADER_SIZE 2
#define MAC_EVENT_ENTRY_SIZE 10
#define MAC_EVENT_MAX_ENTRIES 6

#define LOG_MODULE "RAMLOG-RX"
#define LOG_LEVEL LOG_LEVEL_WARN

static struct simple_udp_connection ramlog_receiver;
static struct simple_udp_connection mac_event_receiver;

PROCESS(ramlog_root_process, "4eMAC RAMLOG root receiver");
AUTOSTART_PROCESSES(&ramlog_root_process);

static void
ramlog_rx_callback(struct simple_udp_connection *connection,
                   const uip_ipaddr_t *sender_addr, uint16_t sender_port,
                   const uip_ipaddr_t *receiver_addr, uint16_t receiver_port,
                   const uint8_t *data, uint16_t datalen)
{
  uint8_t count;
  uint16_t node_id;
  uint8_t i;

  (void)connection;
  (void)sender_port;
  (void)receiver_addr;
  (void)receiver_port;

  if(sender_addr == NULL || data == NULL || datalen < RAMLOG_HEADER_SIZE ||
     data[0] != RAMLOG_PACKET_TYPE_LONG_TS) {
    return;
  }
  count = data[1];
  if(count == 0 || count > RAMLOG_MAX_PACKET_ENTRIES ||
     datalen != RAMLOG_HEADER_SIZE + count * RAMLOG_ENTRY_SIZE) {
    return;
  }

  /* Exp5438's IPv6 IID preserves the last two link-layer address bytes. */
  node_id = ((uint16_t)sender_addr->u8[14] << 8) | sender_addr->u8[15];
  for(i = 0; i < count; i++) {
    uint16_t offset = RAMLOG_HEADER_SIZE + i * RAMLOG_ENTRY_SIZE;
    uint32_t device_ts = ((uint32_t)data[offset + 2] << 24)
                         | ((uint32_t)data[offset + 3] << 16)
                         | ((uint32_t)data[offset + 4] << 8)
                         | (uint32_t)data[offset + 5];

    printf("{\"node_id\":\"%04x\",\"source_addr\":\"%x:%x:%x:%x:%x:%x:%x:%x\","
           "\"module_id\":%u,\"error_code\":%u,\"device_ts\":%lu}\n",
           (unsigned int)node_id,
           (unsigned int)(((uint16_t)sender_addr->u8[0] << 8) | sender_addr->u8[1]),
           (unsigned int)(((uint16_t)sender_addr->u8[2] << 8) | sender_addr->u8[3]),
           (unsigned int)(((uint16_t)sender_addr->u8[4] << 8) | sender_addr->u8[5]),
           (unsigned int)(((uint16_t)sender_addr->u8[6] << 8) | sender_addr->u8[7]),
           (unsigned int)(((uint16_t)sender_addr->u8[8] << 8) | sender_addr->u8[9]),
           (unsigned int)(((uint16_t)sender_addr->u8[10] << 8) | sender_addr->u8[11]),
           (unsigned int)(((uint16_t)sender_addr->u8[12] << 8) | sender_addr->u8[13]),
           (unsigned int)(((uint16_t)sender_addr->u8[14] << 8) | sender_addr->u8[15]),
           (unsigned int)data[offset],
           (unsigned int)data[offset + 1], (unsigned long)device_ts);
  }
}

static const char *
mac_event_status_name(uint8_t direction, uint8_t status)
{
  if(direction == 2) {
    return "received";
  }
  switch(status) {
  case 0: return "success";
  case 1: return "no_ack";
  case 2: return "collision";
  case 3: return "deferred";
  case 5: return "fatal_error";
  default: return "error";
  }
}

static void
mac_event_rx_callback(struct simple_udp_connection *connection,
                      const uip_ipaddr_t *sender_addr, uint16_t sender_port,
                      const uip_ipaddr_t *receiver_addr, uint16_t receiver_port,
                      const uint8_t *data, uint16_t datalen)
{
  uint8_t count;
  uint8_t i;
  uint16_t node_id;

  (void)connection;
  (void)sender_port;
  (void)receiver_addr;
  (void)receiver_port;
  if(sender_addr == NULL || data == NULL || datalen < MAC_EVENT_HEADER_SIZE ||
     data[0] != MAC_EVENT_PACKET_TYPE) {
    return;
  }
  count = data[1];
  if(count == 0 || count > MAC_EVENT_MAX_ENTRIES ||
     datalen != MAC_EVENT_HEADER_SIZE + count * MAC_EVENT_ENTRY_SIZE) {
    return;
  }

  node_id = ((uint16_t)sender_addr->u8[14] << 8) | sender_addr->u8[15];
  for(i = 0; i < count; i++) {
    uint16_t offset = MAC_EVENT_HEADER_SIZE + i * MAC_EVENT_ENTRY_SIZE;
    uint8_t direction = data[offset];
    uint8_t status = data[offset + 2];
    uint16_t peer_node = ((uint16_t)data[offset + 4] << 8)
                         | data[offset + 5];
    uint32_t device_ts = ((uint32_t)data[offset + 6] << 24)
                         | ((uint32_t)data[offset + 7] << 16)
                         | ((uint32_t)data[offset + 8] << 8)
                         | (uint32_t)data[offset + 9];
    /* Channel 0 is a real carrier in the 868 MHz plan (869.525 MHz, Band O) and
       HOPSEQ uses it 3 times out of 7, so it must not be treated as "unset".
       Only the direction byte is validated here; the producer owns the channel. */
    if(direction != 1 && direction != 2) {
      continue;
    }
    printf("{\"kind\":\"mac_event\",\"node_id\":\"%04x\","
           "\"peer_node\":\"%04x\",\"direction\":\"%s\","
           "\"channel\":%u,\"status\":\"%s\","
           "\"ack_expected\":%s,\"device_ts\":%lu}\n",
           (unsigned int)node_id, (unsigned int)peer_node,
           direction == 1 ? "tx" : "rx",
           (unsigned int)data[offset + 1],
           mac_event_status_name(direction, status),
           (data[offset + 3] & 1) ? "true" : "false",
           (unsigned long)device_ts);
  }
}

PROCESS_THREAD(ramlog_root_process, ev, data)
{
  (void)ev;
  (void)data;

  PROCESS_BEGIN();

  NETSTACK_ROUTING.root_start();
  if(!simple_udp_register(&ramlog_receiver, RAMLOG_UDP_PORT, NULL,
                          RAMLOG_UDP_PORT, ramlog_rx_callback)) {
    LOG_ERR("Failed to listen on UDP/%u\n", RAMLOG_UDP_PORT);
  }
  if(!simple_udp_register(&mac_event_receiver, MAC_EVENT_UDP_PORT, NULL,
                          MAC_EVENT_UDP_PORT, mac_event_rx_callback)) {
    LOG_ERR("Failed to listen on UDP/%u\n", MAC_EVENT_UDP_PORT);
  }

  /* Keep PROCESS_CURRENT() valid for simple-udp receive callbacks. */
  while(1) {
    PROCESS_WAIT_EVENT();
  }

  PROCESS_END();
}
