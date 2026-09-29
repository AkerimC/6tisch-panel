#!/usr/bin/env python3
"""Generate a 1-root + 32-client Cooja Exp5438 4eMAC simulation."""
from pathlib import Path
import xml.etree.ElementTree as ET


OUT = Path(__file__).with_name("ramlog-4emac.csc")
INTERFACES = [
    "org.contikios.cooja.interfaces.Position",
    "org.contikios.cooja.interfaces.RimeAddress",
    "org.contikios.cooja.interfaces.IPAddress",
    "org.contikios.cooja.interfaces.Mote2MoteRelations",
    "org.contikios.cooja.interfaces.MoteAttributes",
    "org.contikios.cooja.mspmote.interfaces.MspClock",
    "org.contikios.cooja.mspmote.interfaces.MspMoteID",
    "org.contikios.cooja.mspmote.interfaces.Msp802154Radio",
    "org.contikios.cooja.mspmote.interfaces.UsciA1Serial",
    "org.contikios.cooja.mspmote.interfaces.Exp5438LED",
    "org.contikios.cooja.mspmote.interfaces.MspDebugOutput",
]


def add_mote_type(sim, identifier, description, project, source, firmware):
    mote_type = ET.SubElement(sim, "motetype")
    mote_type.text = "\n      org.contikios.cooja.mspmote.Exp5438MoteType\n      "
    ET.SubElement(mote_type, "identifier").text = identifier
    ET.SubElement(mote_type, "description").text = description
    ET.SubElement(mote_type, "source", {"EXPORT": "discard"}).text = (
        f"[CONFIG_DIR]/{project}/{source}"
    )
    ET.SubElement(mote_type, "commands", {"EXPORT": "discard"}).text = (
        f"make {firmware}.exp5438 TARGET=exp5438"
    )
    ET.SubElement(mote_type, "firmware", {"EXPORT": "copy"}).text = (
        f"[CONFIG_DIR]/{project}/build/exp5438/{firmware}.exp5438"
    )
    for interface in INTERFACES:
        ET.SubElement(mote_type, "moteinterface").text = interface
    mote_type.tail = "\n    "


def add_mote(sim, mote_id, mote_type, x, y):
    mote = ET.SubElement(sim, "mote")
    mote.text = "\n      "
    ET.SubElement(mote, "breakpoints")
    mote[-1].tail = "\n      "
    position = ET.SubElement(mote, "interface_config")
    position.text = "\n        org.contikios.cooja.interfaces.Position\n        "
    for key, value in (("x", x), ("y", y), ("z", 0.0)):
        ET.SubElement(position, key).text = str(value)
    position.tail = "\n      "
    clock = ET.SubElement(mote, "interface_config")
    clock.text = "\n        org.contikios.cooja.mspmote.interfaces.MspClock\n        "
    ET.SubElement(clock, "deviation").text = "1.0"
    clock.tail = "\n      "
    mid = ET.SubElement(mote, "interface_config")
    mid.text = "\n        org.contikios.cooja.mspmote.interfaces.MspMoteID\n        "
    ET.SubElement(mid, "id").text = str(mote_id)
    mid.tail = "\n      "
    ET.SubElement(mote, "motetype_identifier").text = mote_type
    mote.tail = "\n    "


def add_plugin(parent, class_name, fields):
    plugin = ET.SubElement(parent, "plugin")
    plugin.text = f"\n    {class_name}\n    "
    for key, value in fields:
        ET.SubElement(plugin, key).text = value
    plugin.tail = "\n  "
    return plugin


def main():
    root = ET.Element("simconf")
    sim = ET.SubElement(root, "simulation")
    sim.text = "\n    "
    ET.SubElement(sim, "title").text = "4eMAC RAMLOG — 1 root + 32 clients"
    ET.SubElement(sim, "randomseed").text = "123456"
    ET.SubElement(sim, "motedelay_us").text = "1000000"
    radio = ET.SubElement(sim, "radiomedium")
    radio.text = "\n      org.contikios.cooja.radiomediums.UDGM\n      "
    for key, value in (("transmitting_range", 50.0), ("interference_range", 100.0),
                       ("success_ratio_tx", 1.0), ("success_ratio_rx", 0.9)):
        ET.SubElement(radio, key).text = str(value)
    radio.tail = "\n    "
    events = ET.SubElement(sim, "events")
    events.text = "\n      "
    ET.SubElement(events, "logoutput").text = "40000"
    events.tail = "\n    "

    add_mote_type(sim, "ramlogRoot", "4eMAC RPL root / RAMLOG receiver",
                  "root", "ramlog-root.c", "ramlog-root")
    add_mote_type(sim, "ramlogNode", "4eMAC client / existing RAMLOG sender",
                  "node", "ramlog-node.c", "ramlog-node")

    # The existing RAMLOG sender defaults to fd00::5. Exp5438's EUI-64-derived
    # IID for mote ID 5 is 0200:0000:0000:0005, matched in node/project-conf.h.
    add_mote(sim, 5, "ramlogRoot", 10, 70)
    for row in range(4):
        for col in range(8):
            mote_id = 0x0101 + row * 8 + col
            # A 30-unit lattice keeps each mote's neighbor set within the
            # Exp5438 RAM budget while preserving a connected multi-hop mesh.
            add_mote(sim, mote_id, "ramlogNode", 30 + col * 30, 40 + row * 30)
    sim.tail = "\n  "

    add_plugin(root, "org.contikios.cooja.plugins.SimControl", [
        ("width", "260"), ("height", "180"), ("location_x", "0"),
        ("location_y", "0"), ("z", "4"),
    ])
    script_runner = ET.SubElement(root, "plugin")
    script_runner.text = "\n    org.contikios.cooja.plugins.ScriptRunner\n    "
    script_config = ET.SubElement(script_runner, "plugin_config")
    script_config.text = "\n      "
    ET.SubElement(script_config, "script").text = (
        "TIMEOUT(10000000000); /* milliseconds; leave the simulation running */\n"
        "while (true) { YIELD(); }"
    )
    ET.SubElement(script_config, "active").text = "true"
    script_config.tail = "\n    "
    script_runner.tail = "\n  "

    serial = ET.SubElement(root, "plugin")
    serial.text = "\n    org.contikios.cooja.serialsocket.SerialSocketServer\n    "
    ET.SubElement(serial, "mote_arg").text = "0"
    serial_config = ET.SubElement(serial, "plugin_config")
    serial_config.text = "\n      "
    ET.SubElement(serial_config, "port").text = "60001"
    ET.SubElement(serial_config, "bound").text = "true"
    serial_config.tail = "\n    "
    serial.tail = "\n  "

    ET.indent(root, space="  ")
    OUT.write_text('<?xml version="1.0" encoding="UTF-8"?>\n'
                   + ET.tostring(root, encoding="unicode") + "\n")
    print(f"Wrote {OUT} with one root and 32 RAMLOG clients")


if __name__ == "__main__":
    main()
