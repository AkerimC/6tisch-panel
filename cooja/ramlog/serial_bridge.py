#!/usr/bin/env python3
"""Forward JSONL RAMLOG events from the Cooja root serial socket to the panel."""
import argparse
import ipaddress
import json
import re
import socket
import time
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


MAX_LINE = 256
NODE_ID_RE = re.compile(r"^[0-9a-fA-F]{4}$")


def parse_record(raw):
    record = json.loads(raw.decode("ascii"))
    if not isinstance(record, dict):
        raise ValueError("record must be a JSON object")
    node_id = record.get("node_id")
    if record.get("kind") == "mac_event":
        direction = record.get("direction")
        channel = record.get("channel")
        status = record.get("status")
        ack_expected = record.get("ack_expected")
        peer_node = record.get("peer_node")
        device_ts = record.get("device_ts")
        allowed_statuses = {
            "received", "success", "no_ack", "collision", "deferred",
            "error", "fatal_error",
        }
        if not isinstance(node_id, str) or not NODE_ID_RE.fullmatch(node_id):
            raise ValueError("node_id must be a 4-digit hexadecimal MAC suffix")
        if direction not in ("tx", "rx"):
            raise ValueError("direction must be tx or rx")
        if type(channel) is not int or not 0 <= channel <= 255:
            raise ValueError("channel must be an unsigned byte")
        if status not in allowed_statuses:
            raise ValueError("unsupported MAC event status")
        if type(ack_expected) is not bool:
            raise ValueError("ack_expected must be boolean")
        if type(device_ts) is not int or not 0 <= device_ts <= 0xffffffff:
            raise ValueError("device_ts must be an unsigned 32-bit uptime")
        if peer_node is not None:
            if not isinstance(peer_node, str) or not NODE_ID_RE.fullmatch(peer_node):
                raise ValueError("peer_node must be a 4-digit hexadecimal node ID or null")
            peer_node = None if peer_node.lower() == "ffff" else peer_node.lower()
        if direction == "rx" and (status != "received" or ack_expected):
            raise ValueError("RX event status/ack fields are inconsistent")
        if direction == "tx" and status == "received":
            raise ValueError("TX event requires a transmission result")
        result = {
            "kind": "mac_event",
            "node_id": node_id.lower(),
            "direction": direction,
            "channel": channel,
            "status": status,
            "ack_expected": ack_expected,
            "device_ts": device_ts,
        }
        if "peer_node" in record:
            result["peer_node"] = peer_node
        source_addr = record.get("source_addr")
        if source_addr is not None:
            try:
                result["source_addr"] = str(ipaddress.IPv6Address(source_addr))
            except (ipaddress.AddressValueError, TypeError):
                raise ValueError("source_addr must be an IPv6 address")
        return result

    module_id = record.get("module_id")
    error_code = record.get("error_code")
    device_ts = record.get("device_ts")
    if not isinstance(node_id, str) or not NODE_ID_RE.fullmatch(node_id):
        raise ValueError("node_id must be a 4-digit hexadecimal MAC suffix")
    if type(module_id) is not int or not 0 <= module_id <= 255:
        raise ValueError("module_id must be an unsigned byte")
    if type(error_code) is not int or not 0 <= error_code <= 255:
        raise ValueError("error_code must be an unsigned byte")
    if type(device_ts) is not int or not 0 <= device_ts <= 0xffffffff:
        raise ValueError("device_ts must be an unsigned 32-bit uptime")

    source_addr = record.get("source_addr")
    if source_addr is not None:
        try:
            source_addr = str(ipaddress.IPv6Address(source_addr))
        except (ipaddress.AddressValueError, TypeError):
            raise ValueError("source_addr must be an IPv6 address")

    result = {
        "node_id": node_id.lower(),
        "module_id": module_id,
        "error_code": error_code,
        "device_ts": device_ts,
    }
    if source_addr is not None:
        result["source_addr"] = source_addr
    return result


def post_record(api_url, record):
    endpoint = api_url.rsplit("/", 1)[0] + "/mac-events" \
        if record.get("kind") == "mac_event" else api_url
    payload = {key: value for key, value in record.items() if key != "kind"}
    body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    request = Request(endpoint, data=body,
                      headers={"Content-Type": "application/json"}, method="POST")
    with urlopen(request, timeout=5) as response:
        if response.status < 200 or response.status >= 300:
            raise RuntimeError(f"panel returned HTTP {response.status}")
        return json.loads(response.read())


def bridge(host, port, api_url):
    delay = 1
    while True:
        try:
            print(f"RAMLOG bridge: connecting to {host}:{port}", flush=True)
            with socket.create_connection((host, port), timeout=5) as sock:
                sock.settimeout(None)
                delay = 1
                with sock.makefile("rb") as stream:
                    while True:
                        raw = stream.readline(MAX_LINE + 1)
                        if not raw:
                            raise ConnectionError("Cooja serial socket closed")
                        if len(raw) > MAX_LINE or not raw.endswith(b"\n"):
                            raise ConnectionError("serial line is too long or incomplete")
                        # Cooja serial also carries Contiki log lines; JSONL only is RAMLOG.
                        if not raw.lstrip().startswith(b"{"):
                            continue
                        try:
                            record = parse_record(raw.strip())
                            post_record(api_url, record)
                            if record.get("kind") == "mac_event":
                                print(f"forwarded {record['direction']} node "
                                      f"{record['node_id']} ch {record['channel']} "
                                      f"{record['status']}", flush=True)
                            else:
                                print(f"forwarded node {record['node_id']} module "
                                      f"0x{record['module_id']:02x} error "
                                      f"0x{record['error_code']:02x}", flush=True)
                        except (ValueError, UnicodeDecodeError, HTTPError, URLError,
                                TimeoutError, json.JSONDecodeError) as exc:
                            print(f"rejected/failed RAMLOG record: {exc}", flush=True)
        except (OSError, ConnectionError) as exc:
            print(f"RAMLOG bridge disconnected: {exc}; retry in {delay}s", flush=True)
            time.sleep(delay)
            delay = min(delay * 2, 30)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--serial-host", default="127.0.0.1")
    parser.add_argument("--serial-port", default=60001, type=int)
    parser.add_argument("--api-url", default="http://127.0.0.1:8680/api/ramlog")
    args = parser.parse_args()
    try:
        bridge(args.serial_host, args.serial_port, args.api_url)
    except KeyboardInterrupt:
        print("RAMLOG bridge stopped", flush=True)


if __name__ == "__main__":
    main()
