"""Tests for the existing 4eMAC RAMLOG packet-to-panel ingestion path."""
import asyncio
import json
import sqlite3
import tempfile
import time
import xml.etree.ElementTree as ET
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from threading import Thread
from unittest.mock import patch

from fastapi import HTTPException

from backend import store
from backend.main import (MacEventIn, RamLogIn, api_mac_event_ingest,
                          api_mac_events, api_ramlog, api_ramlog_ingest)
from cooja.ramlog.serial_bridge import parse_record, post_record


class RamLogTests(unittest.TestCase):
    def test_accepts_decoded_ramlog_event(self):
        record = parse_record(
            b'{"node_id":"01aF","module_id":2,"error_code":49,"device_ts":4294967295}\n'
        )
        self.assertEqual(record, {
            "node_id": "01af",
            "module_id": 2,
            "error_code": 49,
            "device_ts": 4294967295,
        })
        with_source = parse_record(
            b'{"node_id":"01af","module_id":85,"error_code":49,'
            b'"device_ts":3,"source_addr":"fd00::1af"}'
        )
        self.assertEqual(with_source["source_addr"], "fd00::1af")

    def test_rejects_invalid_ramlog_fields(self):
        records = (
            b'{"node_id":"abc","module_id":2,"error_code":49,"device_ts":3}',
            b'{"node_id":"0001","module_id":256,"error_code":49,"device_ts":3}',
            b'{"node_id":"0001","module_id":2,"error_code":-1,"device_ts":3}',
            b'{"node_id":"0001","module_id":2,"error_code":49,"device_ts":4294967296}',
            b'{"node_id":"0001","module_id":true,"error_code":49,"device_ts":3}',
        )
        for raw in records:
            with self.subTest(raw=raw), self.assertRaises((ValueError, json.JSONDecodeError)):
                parse_record(raw)

    def test_parses_mac_event_with_ack_status_and_channel(self):
        event = parse_record(
            b'{"kind":"mac_event","node_id":"01AF","direction":"tx",'
            b'"peer_node":"0005","channel":26,"status":"no_ack",'
            b'"ack_expected":true,"device_ts":7}'
        )
        self.assertEqual(event, {
            "kind": "mac_event", "node_id": "01af", "direction": "tx",
            "peer_node": "0005", "channel": 26, "status": "no_ack",
            "ack_expected": True, "device_ts": 7,
        })

    def test_rejects_inconsistent_rx_mac_event(self):
        with self.assertRaises(ValueError):
            parse_record(
                b'{"kind":"mac_event","node_id":"0101","direction":"rx",'
                b'"channel":11,"status":"success","ack_expected":false,"device_ts":1}'
            )

    def test_serial_bridge_posts_decoded_ramlog_contract(self):
        received = []

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                length = int(self.headers["Content-Length"])
                received.append((self.path, self.headers["Content-Type"],
                                 json.loads(self.rfile.read(length))))
                body = b'{"ok":true}'
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args):
                pass

        server = HTTPServer(("127.0.0.1", 0), Handler)
        thread = Thread(target=server.serve_forever, daemon=True)
        thread.start()
        record = {"node_id": "0202", "module_id": 2,
                  "error_code": 49, "device_ts": 368}
        try:
            result = post_record(
                f"http://127.0.0.1:{server.server_port}/api/ramlog", record
            )
        finally:
            server.shutdown()
            thread.join(timeout=2)
            server.server_close()
        self.assertEqual(result, {"ok": True})
        self.assertEqual(received, [
            ("/api/ramlog", "application/json", record),
        ])

    def test_serial_bridge_routes_mac_events_to_their_endpoint(self):
        received = []

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                length = int(self.headers["Content-Length"])
                received.append((self.path, json.loads(self.rfile.read(length))))
                body = b'{"ok":true}'
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args):
                pass

        server = HTTPServer(("127.0.0.1", 0), Handler)
        thread = Thread(target=server.serve_forever, daemon=True)
        thread.start()
        event = {"kind": "mac_event", "node_id": "0202", "peer_node": "0005",
                 "direction": "tx", "channel": 15, "status": "success",
                 "ack_expected": True, "device_ts": 368}
        try:
            result = post_record(
                f"http://127.0.0.1:{server.server_port}/api/ramlog", event
            )
        finally:
            server.shutdown()
            thread.join(timeout=2)
            server.server_close()
        self.assertEqual(result, {"ok": True})
        self.assertEqual(received, [
            ("/api/mac-events", {key: value for key, value in event.items()
                                  if key != "kind"}),
        ])

    def test_api_validates_and_persists_a_ramlog_event(self):
        payload = RamLogIn(node_id="01AF", module_id=2, error_code=49,
                           device_ts=368, source_addr="fd00::201:0:0:2")
        with patch("backend.main.store.insert_ram_log") as insert:
            result = asyncio.run(api_ramlog_ingest(payload))
        self.assertEqual(result["node_id"], "01af")
        self.assertEqual(insert.call_args.args[1:],
                         ("01af", 2, 49, 368, "fd00::201:0:0:2"))
        self.assertAlmostEqual(insert.call_args.args[0], result["received_ts"])

    def test_api_rejects_invalid_ipv6_source(self):
        payload = RamLogIn(node_id="0001", module_id=1, error_code=2,
                           device_ts=3, source_addr="not-ipv6")
        with self.assertRaises(HTTPException) as raised:
            asyncio.run(api_ramlog_ingest(payload))
        self.assertEqual(raised.exception.status_code, 422)

    def test_api_persists_mac_event_with_result_fields(self):
        payload = MacEventIn(node_id="01AF", direction="tx", channel=26,
                             peer_node="0005", status="no_ack",
                             ack_expected=True, device_ts=7)
        with patch("backend.main.store.insert_mac_event") as insert:
            result = asyncio.run(api_mac_event_ingest(payload))
        self.assertEqual(result["node_id"], "01af")
        self.assertEqual(result["peer_node"], "0005")
        self.assertEqual(insert.call_args.args[1:],
                         ("01af", "tx", 26, "no_ack", True, 7, None, "0005"))

    def test_mac_event_schema_migrates_peer_node_column(self):
        previous_conn = getattr(store._local, "conn", None)
        if previous_conn is not None:
            previous_conn.close()
            del store._local.conn
        old_path = store.DB_PATH
        try:
            with tempfile.TemporaryDirectory() as tmp:
                store.DB_PATH = str(Path(tmp) / "old.db")
                c = sqlite3.connect(store.DB_PATH)
                c.execute(
                    "CREATE TABLE mac_events (id INTEGER PRIMARY KEY,"
                    "received_ts REAL NOT NULL,node TEXT NOT NULL,direction TEXT NOT NULL,"
                    "channel INTEGER NOT NULL,status TEXT NOT NULL,ack_expected INTEGER NOT NULL,"
                    "device_ts INTEGER NOT NULL,source_addr TEXT)"
                )
                c.commit()
                c.close()
                store.init()
                columns = {row["name"] for row in store.conn().execute(
                    "PRAGMA table_info(mac_events)")}
                self.assertIn("peer_node", columns)
        finally:
            conn = getattr(store._local, "conn", None)
            if conn is not None:
                conn.close()
                del store._local.conn
            store.DB_PATH = old_path
            if previous_conn is not None:
                store._local.conn = previous_conn

    def test_ramlog_store_round_trip_and_filtering(self):
        previous_conn = getattr(store._local, "conn", None)
        if previous_conn is not None:
            previous_conn.close()
            del store._local.conn
        old_path = store.DB_PATH
        try:
            with tempfile.TemporaryDirectory() as tmp:
                store.DB_PATH = str(Path(tmp) / "ramlog-test.db")
                store.init()
                now = time.time()
                store.insert_ram_log(now - 2, "01af", 2, 49, 368, None)
                store.insert_ram_log(now, "01af", 2, 50, 370, None)
                store.insert_ram_log(now - 1, "0005", 1, 35, 100, None)
                rows = store.ram_log_history(hours=1, node="01af", module_id=2)
                self.assertEqual([row["error_code"] for row in rows], [50, 49])
                self.assertEqual(store.ram_log_count(hours=1, node="01af", module_id=2), 2)
                page = store.ram_log_history(
                    hours=1, node="01af", module_id=2, limit=1, offset=1
                )
                self.assertEqual([row["error_code"] for row in page], [49])
                response = asyncio.run(api_ramlog(
                    hours=1, node_id="01AF", module_id=2, limit=1, offset=1
                ))
                self.assertEqual(response["total"], 2)
                self.assertEqual(response["offset"], 1)
                self.assertEqual(response["nodes"], ["0005", "01af"])
                self.assertEqual(response["modules"], [1, 2])
                self.assertEqual(len(store.ram_log_history(hours=1)), 3)

                store.insert_mac_event(now, "01af", "tx", 26, "no_ack", True,
                                       368, peer_node="0005")
                store.insert_mac_event(now - 1, "01af", "rx", 15, "received", False,
                                       366, peer_node="0005")
                for i in range(9):
                    store.insert_mac_event(now - 3 - i, "01af", "tx", 26,
                                           "success", True, 360 - i, peer_node="0005")
                store.insert_mac_event(now - 20, "0005", "tx", 26, "success", True,
                                       340, peer_node="01af")
                events = asyncio.run(api_mac_events(
                    hours=1, node_id="01AF", direction="tx", status="no_ack", channel=26,
                    limit=10, offset=0,
                ))
                self.assertEqual(events["total"], 1)
                self.assertEqual(events["records"][0]["status"], "no_ack")
                self.assertEqual(events["records"][0]["source_node"], "01af")
                self.assertEqual(events["records"][0]["dest_node"], "0005")
                self.assertTrue(events["records"][0]["ack_expected"])
                self.assertIn({"direction": "tx", "channel": 26,
                               "node": "01af", "peer_node": "0005",
                               "status": "no_ack", "ack_expected": 1,
                               "count": 1}, events["summary"])
                success = next(item for item in events["summary"]
                               if item["node"] == "01af" and item["status"] == "success")
                self.assertEqual(success["count"], 9)
                rx = asyncio.run(api_mac_events(
                    hours=1, node_id="01AF", direction="rx", channel=15,
                    limit=10, offset=0,
                ))["records"][0]
                self.assertEqual((rx["source_node"], rx["dest_node"]), ("0005", "01af"))
        finally:
            conn = getattr(store._local, "conn", None)
            if conn is not None:
                conn.close()
                del store._local.conn
            store.DB_PATH = old_path
            if previous_conn is not None:
                store._local.conn = previous_conn

    def test_cooja_scenario_has_exp5438_root_and_32_clients(self):
        scenario = Path(__file__).parents[1] / "cooja" / "ramlog" / "ramlog-4emac.csc"
        root = ET.parse(scenario).getroot()
        motes = root.findall("./simulation/mote")
        self.assertEqual(len(motes), 33)
        types = [mote.findtext("motetype_identifier") for mote in motes]
        self.assertEqual(types.count("ramlogRoot"), 1)
        self.assertEqual(types.count("ramlogNode"), 32)
        root_type = root.find("./simulation/motetype[identifier='ramlogRoot']")
        self.assertIn("Exp5438MoteType", root_type.text)
        self.assertEqual(root_type.findtext("commands"),
                         "make ramlog-root.exp5438 TARGET=exp5438")
        self.assertEqual(root_type.findtext("firmware"),
                         "[CONFIG_DIR]/root/build/exp5438/ramlog-root.exp5438")
        node_conf = Path(__file__).parents[1] / "cooja" / "ramlog" / "node" / "project-conf.h"
        self.assertIn("0xfd00, 0, 0, 0, 0x0200, 0, 0, 0x0005",
                      node_conf.read_text())
        serial = next((plugin for plugin in root.findall("./plugin")
                       if plugin.findtext("mote_arg") == "0"), None)
        self.assertIsNotNone(serial)
        self.assertEqual(serial.findtext("plugin_config/port"), "60001")


if __name__ == "__main__":
    unittest.main()
