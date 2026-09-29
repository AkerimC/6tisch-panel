/*
 * Minimal 4eMAC/RPL client. The existing RAM_LOG_SEND_ENABLED hook in
 * 4emac-timesynch.c starts Contiki's unchanged os/services/ram-log-send code.
 */
#include "contiki.h"
#include "net/mac/4emac/4emac-timesynch.h"

PROCESS(ramlog_node_process, "4eMAC RAMLOG client");
AUTOSTART_PROCESSES(&ramlog_node_process);

PROCESS_THREAD(ramlog_node_process, ev, data)
{
  (void)ev;
  (void)data;

  PROCESS_BEGIN();

  /* Match the 4eMAC client startup sequence used by the UDP example. */
  foure_timesynch_init(0);

  /* The MAC records actual transmission results in the RAMLOG service. */
  while(1) {
    PROCESS_WAIT_EVENT();
  }

  PROCESS_END();
}
