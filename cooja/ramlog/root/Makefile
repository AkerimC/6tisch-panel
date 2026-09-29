CONTIKI_PROJECT = ramlog-root
TARGET ?= exp5438
CONTIKI ?= /home/krm/contiki-ng

MAKE_MAC = MAKE_MAC_4EMAC
MAKE_ROUTING = MAKE_ROUTING_RPL_CLASSIC
CFLAGS += -I$(CONTIKI)/arch/dev/radio/cc2420

all: $(CONTIKI_PROJECT)

include $(CONTIKI)/Makefile.include
