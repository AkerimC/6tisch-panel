# -*- coding: utf-8 -*-
"""SQLite veri katmani - metrikler, slot kullanimi, yonlendirme, olaylar."""
import json
import os
import sqlite3
import threading
import time

DB_PATH = os.path.join(os.path.dirname(__file__), "..", "data", "dashboard.db")

_local = threading.local()

SCHEMA = """
CREATE TABLE IF NOT EXISTS nodes (
    id TEXT PRIMARY KEY, hop INT, parent TEXT, rssi_seed REAL,
    instrumented INT, tx_rate REAL, subtree INT, active INT DEFAULT 1
);
CREATE TABLE IF NOT EXISTS metrics (
    ts REAL, node TEXT, rssi REAL, snr REAL, etx REAL, energy_mj REAL,
    battery REAL, tx_rate REAL, retrans INT, pdr REAL, band TEXT,
    carrier INT, slot_id INT, parent TEXT, source TEXT DEFAULT 'sim'
);
CREATE INDEX IF NOT EXISTS ix_metrics_ts ON metrics(ts);
CREATE INDEX IF NOT EXISTS ix_metrics_node_ts ON metrics(node, ts);
CREATE TABLE IF NOT EXISTS slot_usage (
    ts REAL, node TEXT, slot INT, carrier INT, band TEXT, kind TEXT
);
CREATE INDEX IF NOT EXISTS ix_slot_ts ON slot_usage(ts);
CREATE TABLE IF NOT EXISTS routing_events (
    ts REAL, node TEXT, old_parent TEXT, new_parent TEXT, hop INT, reason TEXT
);
CREATE TABLE IF NOT EXISTS duty_windows (
    ts REAL, node TEXT, band TEXT, median REAL, p90 REAL,
    used_pct REAL, denied REAL, deferral REAL
);
CREATE INDEX IF NOT EXISTS ix_duty_ts ON duty_windows(ts);
CREATE TABLE IF NOT EXISTS ram_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    received_ts REAL NOT NULL, node TEXT NOT NULL,
    module_id INTEGER NOT NULL, error_code INTEGER NOT NULL,
    device_ts INTEGER NOT NULL, source_addr TEXT
);
CREATE INDEX IF NOT EXISTS ix_ramlog_node_ts ON ram_logs(node, received_ts);
CREATE INDEX IF NOT EXISTS ix_ramlog_module_ts ON ram_logs(module_id, received_ts);
CREATE INDEX IF NOT EXISTS ix_ramlog_node_module_ts ON ram_logs(node, module_id, received_ts);
CREATE TABLE IF NOT EXISTS mac_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    received_ts REAL NOT NULL, node TEXT NOT NULL,
    direction TEXT NOT NULL, channel INTEGER NOT NULL,
    status TEXT NOT NULL, ack_expected INTEGER NOT NULL,
    device_ts INTEGER NOT NULL, source_addr TEXT, peer_node TEXT
);
CREATE INDEX IF NOT EXISTS ix_mac_events_received ON mac_events(received_ts);
CREATE INDEX IF NOT EXISTS ix_mac_events_node_received ON mac_events(node, received_ts);
CREATE INDEX IF NOT EXISTS ix_mac_events_channel_received ON mac_events(channel, received_ts);
CREATE TABLE IF NOT EXISTS events (
    ts REAL, sev TEXT, kind TEXT, node TEXT, msg TEXT, data TEXT
);
CREATE TABLE IF NOT EXISTS configs (
    ts REAL, node TEXT, params TEXT, status TEXT, method TEXT, target TEXT
);
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);
"""


def conn() -> sqlite3.Connection:
    c = getattr(_local, "conn", None)
    if c is None:
        os.makedirs(os.path.dirname(os.path.abspath(DB_PATH)), exist_ok=True)
        c = sqlite3.connect(os.path.abspath(DB_PATH), timeout=15)
        c.row_factory = sqlite3.Row
        c.execute("PRAGMA journal_mode=WAL")
        c.execute("PRAGMA synchronous=NORMAL")
        _local.conn = c
    return c


def init():
    c = conn()
    c.executescript(SCHEMA)
    columns = {row["name"] for row in c.execute("PRAGMA table_info(mac_events)")}
    if "peer_node" not in columns:
        c.execute("ALTER TABLE mac_events ADD COLUMN peer_node TEXT")
    c.execute("CREATE INDEX IF NOT EXISTS ix_mac_events_peer_received "
              "ON mac_events(peer_node, received_ts)")
    # Created after the migration because it references peer_node. Covers the
    # 6-column GROUP BY of mac_event_summary, which otherwise builds a temporary
    # B-tree over every row in the window.
    c.execute("CREATE INDEX IF NOT EXISTS ix_mac_events_agg ON mac_events("
              "received_ts, node, peer_node, direction, channel, status, "
              "ack_expected)")
    c.commit()


def is_empty() -> bool:
    r = conn().execute("SELECT COUNT(*) AS n FROM nodes").fetchone()
    return r["n"] == 0


def kv_get(key, default=None):
    r = conn().execute("SELECT v FROM kv WHERE k=?", (key,)).fetchone()
    return r["v"] if r else default


def kv_set(key, value):
    conn().execute("INSERT OR REPLACE INTO kv(k,v) VALUES(?,?)", (key, str(value)))
    conn().commit()


# ---- yazilar ---------------------------------------------------------------

def insert_nodes(rows):
    c = conn()
    c.executemany(
        "INSERT OR REPLACE INTO nodes(id,hop,parent,rssi_seed,instrumented,tx_rate,subtree) "
        "VALUES(?,?,?,?,?,?,?)", rows)
    c.commit()


def insert_metrics(rows):
    c = conn()
    c.executemany(
        "INSERT INTO metrics(ts,node,rssi,snr,etx,energy_mj,battery,tx_rate,retrans,"
        "pdr,band,carrier,slot_id,parent,source) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", rows)
    if len(rows) > 64:
        c.commit()


def insert_slot_usage(rows):
    c = conn()
    c.executemany(
        "INSERT INTO slot_usage(ts,node,slot,carrier,band,kind) VALUES(?,?,?,?,?,?)", rows)
    if len(rows) > 64:
        c.commit()


def insert_routing(rows):
    c = conn()
    c.executemany(
        "INSERT INTO routing_events(ts,node,old_parent,new_parent,hop,reason) "
        "VALUES(?,?,?,?,?,?)", rows)
    c.commit()


def insert_duty(rows):
    c = conn()
    c.executemany(
        "INSERT INTO duty_windows(ts,node,band,median,p90,used_pct,denied,deferral) "
        "VALUES(?,?,?,?,?,?,?,?)", rows)
    c.commit()


def insert_event(ts, sev, kind, node, msg, data=None):
    c = conn()
    c.execute("INSERT INTO events(ts,sev,kind,node,msg,data) VALUES(?,?,?,?,?,?)",
              (ts, sev, kind, node, msg, json.dumps(data) if data else None))
    c.commit()


def insert_config(ts, node, params, status, method, target):
    c = conn()
    c.execute("INSERT INTO configs(ts,node,params,status,method,target) VALUES(?,?,?,?,?,?)",
              (ts, node, json.dumps(params), status, method, target))
    c.commit()
    c.execute("UPDATE nodes SET active=1 WHERE id=?", (node,))
    c.commit()


# ---- okumalar --------------------------------------------------------------

def get_nodes():
    return [dict(r) for r in conn().execute("SELECT * FROM nodes").fetchall()]


def insert_ram_log(received_ts, node, module_id, error_code, device_ts, source_addr=None):
    c = conn()
    c.execute(
        "INSERT INTO ram_logs(received_ts,node,module_id,error_code,device_ts,source_addr) "
        "VALUES(?,?,?,?,?,?)",
        (received_ts, node, module_id, error_code, device_ts, source_addr),
    )
    c.commit()


def _ram_log_filters(hours, node=None, module_id=None):
    filters = ["received_ts > ?"]
    params = [time.time() - hours * 3600]
    if node is not None:
        filters.append("node = ?")
        params.append(node)
    if module_id is not None:
        filters.append("module_id = ?")
        params.append(module_id)
    return filters, params


def ram_log_count(hours=24, node=None, module_id=None):
    filters, params = _ram_log_filters(hours, node, module_id)
    row = conn().execute(
        "SELECT COUNT(*) AS total FROM ram_logs WHERE " + " AND ".join(filters),
        params,
    ).fetchone()
    return row["total"]


def ram_log_filters(hours=24):
    since = time.time() - hours * 3600
    c = conn()
    nodes = c.execute(
        "SELECT DISTINCT node FROM ram_logs WHERE received_ts > ? ORDER BY node",
        (since,),
    ).fetchall()
    modules = c.execute(
        "SELECT DISTINCT module_id FROM ram_logs WHERE received_ts > ? ORDER BY module_id",
        (since,),
    ).fetchall()
    return ([row["node"] for row in nodes],
            [row["module_id"] for row in modules])


def ram_log_history(hours=24, node=None, module_id=None, limit=100, offset=0):
    filters, params = _ram_log_filters(hours, node, module_id)
    params.append(limit)
    params.append(offset)
    rows = conn().execute(
        "SELECT received_ts,node,module_id,error_code,device_ts,source_addr "
        "FROM ram_logs WHERE " + " AND ".join(filters) +
        " ORDER BY received_ts DESC, id DESC LIMIT ? OFFSET ?",
        params,
    ).fetchall()
    return [dict(r) for r in rows]


def insert_mac_event(received_ts, node, direction, channel, status,
                     ack_expected, device_ts, source_addr=None, peer_node=None):
    c = conn()
    c.execute(
        "INSERT INTO mac_events(received_ts,node,direction,channel,status,"
        "ack_expected,device_ts,source_addr,peer_node) VALUES(?,?,?,?,?,?,?,?,?)",
        (received_ts, node, direction, channel, status, int(ack_expected),
         device_ts, source_addr, peer_node),
    )
    c.commit()


def _mac_event_filters(hours, node=None, direction=None, channel=None, status=None):
    filters = ["received_ts > ?"]
    params = [time.time() - hours * 3600]
    for column, value in (("node", node), ("direction", direction),
                          ("channel", channel), ("status", status)):
        if value is not None:
            filters.append(f"{column} = ?")
            params.append(value)
    return filters, params


def mac_event_count(hours=24, node=None, direction=None, channel=None, status=None):
    filters, params = _mac_event_filters(hours, node, direction, channel, status)
    row = conn().execute(
        "SELECT COUNT(*) AS total FROM mac_events WHERE " + " AND ".join(filters),
        params,
    ).fetchone()
    return row["total"]


def mac_event_history(hours=24, node=None, direction=None, channel=None,
                      status=None, limit=100, offset=0):
    filters, params = _mac_event_filters(hours, node, direction, channel, status)
    params.extend((limit, offset))
    rows = conn().execute(
        "SELECT received_ts,node,peer_node,"
        "CASE direction WHEN 'tx' THEN node ELSE peer_node END AS source_node,"
        "CASE direction WHEN 'tx' THEN peer_node ELSE node END AS dest_node,"
        "direction,channel,status,ack_expected,device_ts,source_addr "
        "FROM mac_events WHERE " + " AND ".join(filters) +
        " ORDER BY received_ts DESC,id DESC LIMIT ? OFFSET ?", params,
    ).fetchall()
    return [dict(row) for row in rows]


def mac_event_summary(hours=24, node=None, direction=None, channel=None, status=None):
    filters, params = _mac_event_filters(hours, node, direction, channel, status)
    rows = conn().execute(
        "SELECT node,peer_node,direction,channel,status,ack_expected,COUNT(*) AS count "
        "FROM mac_events WHERE " + " AND ".join(filters) +
        " GROUP BY node,peer_node,direction,channel,status,ack_expected "
        "ORDER BY channel,node,peer_node,direction,status,ack_expected", params,
    ).fetchall()
    return [dict(row) for row in rows]


def mac_event_filter_values(hours=24):
    since = time.time() - hours * 3600
    c = conn()
    nodes = c.execute(
        "SELECT DISTINCT node FROM mac_events WHERE received_ts > ? ORDER BY node",
        (since,),
    ).fetchall()
    channels = c.execute(
        "SELECT DISTINCT channel FROM mac_events WHERE received_ts > ? ORDER BY channel",
        (since,),
    ).fetchall()
    return ([row["node"] for row in nodes], [row["channel"] for row in channels])


def latest_metrics(limit_ts_s=4.0):
    now = time.time()
    rows = conn().execute(
        "SELECT * FROM metrics WHERE ts > ? ORDER BY ts DESC", (now - limit_ts_s,)
    ).fetchall()
    out = {}
    for r in rows:
        if r["node"] not in out:
            out[r["node"]] = dict(r)
    return out


def metrics_history(node, hours=24, step_s=0):
    since = time.time() - hours * 3600
    if step_s > 0:
        rows = conn().execute(
            "SELECT CAST(ts/? AS INTEGER) AS b, AVG(ts) ts, AVG(rssi) rssi, AVG(snr) snr, AVG(etx) etx, "
            "AVG(energy_mj) energy_mj, AVG(battery) battery, AVG(tx_rate) tx_rate, "
            "SUM(retrans) retrans, AVG(pdr) pdr, MAX(parent) parent "
            "FROM metrics WHERE node=? AND ts>? GROUP BY b ORDER BY b",
            (step_s, node, since)).fetchall()
        return [dict(r) for r in rows]
    rows = conn().execute(
        "SELECT ts, rssi, snr, etx, energy_mj, battery, tx_rate, retrans, pdr, parent "
        "FROM metrics WHERE node=? AND ts>? ORDER BY ts", (node, since)).fetchall()
    return [dict(r) for r in rows]


def network_energy_series(hours=24, step_s=300):
    since = time.time() - hours * 3600
    rows = conn().execute(
        "SELECT CAST(ts/? AS INTEGER) AS b, AVG(ts) ts, SUM(energy_mj) e, AVG(battery) batt "
        "FROM metrics WHERE ts>? GROUP BY b ORDER BY b", (step_s, since)).fetchall()
    return [dict(r) for r in rows]


def slot_usage_series(nodes, hours=24, bucket_s=60):
    since = time.time() - hours * 3600
    qmarks = ",".join("?" * len(nodes))
    rows = conn().execute(
        f"SELECT ts, node, slot, carrier, band, kind FROM slot_usage "
        f"WHERE node IN ({qmarks}) AND ts>? ORDER BY ts", (*nodes, since)).fetchall()
    return [dict(r) for r in rows]


def duty_series(node, hours=24, band="L", step_s=300):
    since = time.time() - hours * 3600
    rows = conn().execute(
        "SELECT CAST(ts/? AS INTEGER) AS b, AVG(ts) ts, AVG(p90) p90, MAX(used_pct) used, AVG(denied) denied "
        "FROM duty_windows WHERE node=? AND band=? AND ts>? GROUP BY b ORDER BY b",
        (step_s, node, band, since)).fetchall()
    return [dict(r) for r in rows]


def routing_summary():
    now = time.time()
    rows = conn().execute(
        "SELECT node, new_parent AS parent, hop, COUNT(*) n_upd FROM routing_events "
        "WHERE ts>? GROUP BY node", (now - 600,)).fetchall()
    per10 = {r["node"]: r["n_upd"] for r in rows}
    latest = conn().execute(
        "SELECT node, new_parent AS parent, hop, ts FROM routing_events r "
        "WHERE ts = (SELECT MAX(ts) FROM routing_events WHERE node=r.node)").fetchall()
    cur_parent = {r["node"]: dict(r) for r in latest}
    return per10, cur_parent


def routing_changes(hours=24):
    since = time.time() - hours * 3600
    rows = conn().execute(
        "SELECT ts, node, old_parent, new_parent, reason FROM routing_events "
        "WHERE ts>? ORDER BY ts DESC LIMIT 400", (since,)).fetchall()
    return [dict(r) for r in rows]


def recent_events(limit=40, since=None):
    q = "SELECT ts, sev, kind, node, msg, data FROM events"
    args = []
    if since:
        q += " WHERE ts>?"
        args.append(since)
    q += " ORDER BY ts DESC LIMIT ?"
    args.append(limit)
    rows = conn().execute(q, args).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        d["data"] = json.loads(d["data"]) if d["data"] else None
        out.append(d)
    return out


def configs_recent(limit=30):
    rows = conn().execute(
        "SELECT ts, node, params, status, method, target FROM configs "
        "ORDER BY ts DESC LIMIT ?", (limit,)).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        d["params"] = json.loads(d["params"])
        out.append(d)
    return out


def duty_snapshot():
    """Her enstrumante dugum icin son 10 dakikanin EN YUKSEK Band L/O p90'i (anlik sapmalari engeller)."""
    since = time.time() - 600
    rows = conn().execute(
        "SELECT node, band, MAX(p90) p90, MAX(used_pct) used FROM duty_windows "
        "WHERE ts>? GROUP BY node, band", (since,)).fetchall()
    snap = {}
    for r in rows:
        snap[(r["node"], r["band"])] = {"p90": r["p90"], "used": r["used"]}
    return snap


def purge_older_than(hours=48):
    cut = time.time() - hours * 3600
    c = conn()
    for t in ("metrics", "slot_usage", "duty_windows"):
        c.execute(f"DELETE FROM {t} WHERE ts<?", (cut,))
    c.execute("DELETE FROM ram_logs WHERE received_ts<?", (cut,))
    c.execute("DELETE FROM mac_events WHERE received_ts<?", (cut,))
    c.execute("DELETE FROM events WHERE ts<?", (cut,))
    c.commit()
