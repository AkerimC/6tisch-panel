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
    conn().executescript(SCHEMA)
    conn().commit()


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
    c.execute("DELETE FROM events WHERE ts<?", (cut,))
    c.commit()
