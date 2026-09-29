#define SERVER_NODE(ipaddr) \
  uip_ip6addr(ipaddr, 0xfd00, 0, 0, 0, 0x0200, 0, 0, 0x0005)
#include "../project-conf.h"
#define FOURE_CONF_LOG_LEVEL 2

/* Exp5438 has a tight RAM budget; bound log buffering to grow the neighbor pool. */
#undef NBR_TABLE_CONF_MAX_NEIGHBORS
#define NBR_TABLE_CONF_MAX_NEIGHBORS 12
#define RAMLOG_MAX_ENTRIES 32
