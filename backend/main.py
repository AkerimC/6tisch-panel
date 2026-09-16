# -*- coding: utf-8 -*-
"""
6TiSCH 868 MHz Izleme ve Konfigurasyon Paneli - FastAPI sunucusu.

Calistir:  uvicorn backend.main:app --host 0.0.0.0 --port 8680
"""
import asyncio
import contextlib
import json
import os
import time

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from typing import Optional, List

from . import config as C
from . import store
from .engine import ENGINE

FRONTEND_DIR = os.path.join(os.path.dirname(__file__), "..", "frontend")

app = FastAPI(title="6TiSCH Izleme Paneli", version="1.0")


@app.on_event("startup")
async def _startup():
    ENGINE.setup(seed_hours=24)
    ENGINE._task = asyncio.create_task(ENGINE.run())
    asyncio.create_task(_coap_server())


@app.on_event("shutdown")
async def _shutdown():
    ENGINE._running = False
    if ENGINE._task:
        ENGINE._task.cancel()


async def _coap_server():
    """Gercek entegrasyon: CoAP PUT/POST /s/metrics (aiocoap kuruluysa)."""
    try:
        import aiocoap
        import aiocoap.resource as resource
    except Exception:
        print("aiocoap yok - CoAP sunucusu atlandi (HTTP /api/ingest aktif)")
        return

    class MetricsResource(resource.Resource):
        async def render_put(self, request):
            try:
                data = json.loads(request.payload.decode("utf-8"))
                ENGINE.ingest(data)
                return aiocoap.Message(code=aiocoap.CHANGED)
            except Exception as e:
                return aiocoap.Message(code=aiocoap.BAD_REQUEST,
                                       payload=str(e).encode())

        async def render_post(self, request):
            return await self.render_put(request)

    class Root(resource.Resource):
        async def render_get(self, request):
            return aiocoap.Message(payload=b"</s/metrics>;ct=50")

    site = resource.Site()
    site.add_resource((".well-known", "core"), Root())
    site.add_resource(("s", "metrics"), MetricsResource())
    try:
        proto = await aiocoap.Context.create_server_context(site, bind=("0.0.0.0", 5683))
    except OSError as e:
        print("CoAP :5683 mesgul - CoAP sunucusu atlandi (HTTP /api/ingest aktif):", e)
        return
    print("CoAP sunucusu :5683 - /s/metrics (veri hatti hazir)")
    with contextlib.suppress(asyncio.CancelledError):
        await asyncio.get_event_loop().create_future()


# ---- modeller ---------------------------------------------------------------

class ConfigIn(BaseModel):
    node_id: str
    tx_power_dbm: Optional[float] = Field(None, ge=-10, le=27)
    erp_class: Optional[str] = None
    erp_class_mw: Optional[int] = Field(None, ge=1, le=500)
    eb_period: Optional[int] = None
    rssi_threshold: Optional[float] = Field(None, ge=-100, le=-50)
    slot_update_s: Optional[int] = None


class IngestIn(BaseModel):
    node_id: str
    rssi: float
    snr: float
    etx: float
    energy_mj: float
    slot_id: int
    retrans: int
    ts: Optional[float] = None
    carrier: Optional[int] = None
    band: Optional[str] = None
    battery_v: Optional[float] = None
    tx_rate: Optional[float] = None
    parent: Optional[str] = None


# ---- API --------------------------------------------------------------------

@app.get("/api/network")
async def api_network():
    snap = ENGINE.snapshot()
    nodes = snap["nodes"]
    active = sum(1 for n in nodes if n["active"])
    avg_rssi = sum(n["rssi"] for n in nodes) / max(1, len(nodes))
    duty = store.duty_snapshot()
    duty_out = {f"{nid}_{b}": v for (nid, b), v in duty.items()}
    return {
        "asn": snap["asn"], "slot": snap["slot"], "carrier": snap["carrier"],
        "freq": snap["freq"], "band": snap["band"],
        "slotframe": {"len": C.SLOTFRAME_LEN, "slot_ms": C.SLOT_MS,
                      "duration_ms": C.SLOTFRAME_MS,
                      "eb_slot": C.EB_SLOT, "shared_slots": C.SHARED_SLOTS,
                      "hopseq": C.HOPSEQ},
        "carriers": {str(k): v for k, v in C.CARRIERS.items()},
        "cellmap": {nid: {"slot": ENGINE._slot_of_node(nid),
                           "chan_ofs": ENGINE.nodes[nid].chan_ofs}
                    for nid in ENGINE.nodes},
        "instrumented": sorted(C.INSTRUMENTED),
        "totals": {"nodes": len(nodes), "active": active,
                   "dcu": "DCU (6LBR)", "avg_rssi": round(avg_rssi, 1),
                   "uptime_s": round(time.time() - ENGINE.t0)},
        "duty": duty_out,
        "duty_limits": {b: round(C.duty_limit_of(b) * 100, 1)
                        for b in ("L", "O")},
    }


@app.get("/api/nodes")
async def api_nodes():
    return ENGINE.snapshot()["nodes"]


@app.get("/api/nodes/{node_id}")
async def api_node(node_id: str):
    snap = ENGINE.snapshot()
    node = next((n for n in snap["nodes"] if n["id"] == node_id), None)
    if not node:
        raise HTTPException(404, "dugum yok")
    neighbors = [n for n in snap["nodes"]
                 if n["parent"] == node_id or n["id"] == node_id]
    return {"node": node, "subtree": neighbors}


@app.get("/api/history/{node_id}")
async def api_history(node_id: str, hours: float = 24, step_s: int = 120):
    return store.metrics_history(node_id, hours, step_s)


@app.get("/api/energy")
async def api_energy(hours: float = 24):
    return {"network": store.network_energy_series(hours, 300),
            "nodes": {nid: store.metrics_history(nid, hours, 300)
                      for nid in C.INSTRUMENTED}}


@app.get("/api/slotlog")
async def api_slotlog(hours: float = 24):
    return store.slot_usage_series(C.INSTRUMENTED, hours)


@app.get("/api/duty/{node_id}")
async def api_duty(node_id: str, hours: float = 24):
    return {"L": store.duty_series(node_id, hours, "L"),
            "O": store.duty_series(node_id, hours, "O"),
            "limits": {b: round(C.duty_limit_of(b) * 100, 1) for b in ("L", "O")}}


@app.get("/api/topology")
async def api_topology():
    per10, cur_parent = store.routing_summary()
    nodes = []
    for n in ENGINE.snapshot()["nodes"]:
        n = dict(n)
        rp = cur_parent.get(n["id"])
        if rp and rp["parent"]:
            n["parent"] = rp["parent"]
            n["hop"] = rp["hop"]
        n["rpl_updates_10m"] = per10.get(n["id"], 0)
        nodes.append(n)
    # dongu dezenfeksiyonu: DCU'ya ulasamayan ebeveyn zincirini config ile kir
    cfg_parent = {nid: v[1] for nid, v in C.NODES.items()}
    pmap = {n["id"]: (n["parent"], n["hop"]) for n in nodes}
    for n in nodes:
        nid = n["id"]
        seen = set()
        cur = nid
        ok = False
        for _ in range(len(nodes) + 2):
            if cur == "DCU":
                ok = True
                break
            if cur in seen:
                break
            seen.add(cur)
            cur = pmap.get(cur, ("DCU", 0))[0]
        if not ok:
            n["parent"] = cfg_parent.get(nid, "DCU")
            n["hop"] = C.NODES.get(nid, (1, "DCU",))[0]
    return {"nodes": nodes,
            "changes": store.routing_changes(24)}


@app.get("/api/events")
async def api_events(limit: int = 40):
    return store.recent_events(limit)


@app.get("/api/configs")
async def api_configs():
    return store.configs_recent()


@app.post("/api/config")
async def api_set_config(cfg: ConfigIn):
    params = {k: v for k, v in cfg.model_dump().items()
              if k != "node_id" and v is not None}
    if not params:
        raise HTTPException(400, "degistirilecek parametre yok")
    try:
        result = ENGINE.apply_config(cfg.node_id, params)
    except KeyError:
        raise HTTPException(404, "dugum yok")
    return result


@app.post("/api/ingest")
async def api_ingest(data: IngestIn):
    """Gercek veri hatti: cihaz -> CoAP(JSON) -> BR -> backend.
    CoAP 5683 portu /s/metrics kaynagi ayni JSON formatini kabul eder."""
    try:
        ENGINE.ingest({k: v for k, v in data.model_dump().items() if v is not None})
    except Exception as e:
        raise HTTPException(400, str(e))
    return {"ok": True}


@app.get("/api/ingest/schema")
async def api_ingest_schema():
    return {"required": C.INGEST_FIELDS, "optional": C.INGEST_OPTIONAL,
            "coap": {"port": 5683, "path": "/s/metrics", "method": "PUT|POST",
                     "format": "application/json"},
            "example": {"node_id": "7402", "rssi": -75.2, "snr": 24.8,
                        "etx": 2.33, "energy_mj": 48.6, "slot_id": 12,
                        "ts": time.time(), "retrans": 3, "carrier": 0,
                        "band": "O"}}


# ---- WebSocket (canli akis) -------------------------------------------------

@app.websocket("/ws")
async def ws_live(ws: WebSocket):
    await ws.accept()
    ENGINE.ws_clients.add(ws)
    try:
        await ws.send_text(json.dumps(ENGINE.snapshot()))
        while True:
            await ws.receive_text()  # ping/pong; istemci veri gondermez
    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        ENGINE.ws_clients.discard(ws)


# ---- statik frontend --------------------------------------------------------

from fastapi.staticfiles import StaticFiles

app.mount("/", StaticFiles(directory=os.path.abspath(FRONTEND_DIR), html=True),
          name="frontend")
