# -*- coding: utf-8 -*-
"""
Simulasyon motoru.
Makaledeki 22 saatlik 32 dugumlu yerlesimin davranislarini (gorev dongusu
asimetrisi, ebeveyn degisimi, Band L cezasi) uretir; ayni zamanda gercek
veri hattini (ingest) besleyecek sekilde tasarlanmistir.
"""
import asyncio
import json
import math
import random
import re
import time

from . import config as C
from . import store

R = random.Random(42)


class NodeState:
    def __init__(self, nid, hop, parent, rssi_seed, instrumented, tx_rate, subtree):
        self.id = nid
        self.hop = hop
        self.parent = parent
        self.rssi_seed = float(rssi_seed)
        self.tx_power_dbm = C.TX_POWER_DEFAULT_DBM
        self.instrumented = instrumented
        self.tx_rate = float(tx_rate)
        self.tx_rate_base = float(tx_rate)  # geri beslemesiz taban (drift yok)
        self.subtree = subtree
        self.active = True
        # canli durum
        self.rssi = float(rssi_seed)
        self.phase = R.uniform(0, 2 * math.pi)
        self.battery = R.uniform(3.58, 3.66)
        self.etx = 1.2
        self.energy_window = 0.0      # son pencere mJ
        self.duty = {"L": [], "O": []}  # 30s pencere hava zamanlari (ms)
        self.window_air = {"L": 0.0, "O": 0.0}
        self.window_tx = 0
        self.window_retrans = 0
        self.acc_energy = 0.0   # canli modda pencere boyu biriken enerji (mJ)
        self.acc_retrans = 0    # canli modda pencere boyu biriken tekrar sayisi
        self.band_split = self._band_split()
        self.slot_id = None
        try:
            self.chan_ofs = int(nid, 16) % 7  # deterministik (JS ile ayni kural)
        except ValueError:
            self.chan_ofs = 0
        self.denied_pct = 0.0
        self.deferral_pct = 0.0
        self.blacklist_until = {"L": 0, "O": 0}
        self.erp_cap_mw = 500   # konfigurasyonla kisitlanir; <500 ise Band O kullanilamaz
        self.source = "sim"
        # Tablo 14 tabanli ETX hedefi
        if instrumented and nid in C.TABLE14:
            self.etx_target = C.TABLE14[nid][0]
        else:
            # zayif baglanti -> yuksek ETX
            r = self.rssi_seed
            if r <= -79: self.etx_target = R.uniform(2.6, 3.9)
            elif r <= -70: self.etx_target = R.uniform(1.8, 2.6)
            elif r <= -60: self.etx_target = R.uniform(1.4, 1.9)
            else: self.etx_target = R.uniform(1.05, 1.4)
        self.etx = self.etx_target

    def _band_split(self):
        """Band L payi. Enstrumante dugumlerde Tablo 14'e gore Band L baskindir
        (makale: Band L butcesi tukendigi icin hücreler orada yogunlasir)."""
        cal = {"7402": 0.78, "71D8": 0.82, "71C0": 0.86, "71F4": 0.62, "7181": 0.72}
        if self.id in cal:
            return cal[self.id]
        if self.rssi_seed <= -79: return 0.30
        if self.rssi_seed <= -70: return 0.45
        if self.rssi_seed <= -60: return 0.60
        return 0.72


class Engine:
    def __init__(self):
        self.nodes = {}
        self.t0 = time.time()
        self.ws_clients = set()
        self.pending_configs = []
        self._task = None
        self._running = False

    # ---- kurulum -----------------------------------------------------------

    def setup(self, seed_hours=24):
        store.init()
        rows = [(nid, v[0], v[1], v[2], 1 if v[3] else 0, v[4], v[5])
                for nid, v in C.NODES.items()]
        store.insert_nodes(rows)
        for nid, v in C.NODES.items():
            self.nodes[nid] = NodeState(nid, *v)
        seeded = store.kv_get("seeded_until")
        now = time.time()
        if seeded is None:
            start = now - seed_hours * 3600
            self._seed_history(start, now)
            store.kv_set("seeded_until", now)
            store.kv_set("t0", start)
        else:
            store.kv_set("t0", store.kv_get("t0", now))
        self.t0 = float(store.kv_get("t0", now))
        store.insert_event(now, "info", "boot", None,
                           "Panel baslatildi - 32 dugum + DCU (simulasyon motoru hazir)")

    # ---- uretim yardimcilari -----------------------------------------------

    def _rssi_now(self, n: NodeState, t: float):
        """Yavas solunum + darbe gurultusu; Band L cezasi makaledeki gibi ~13 dB."""
        drift = 2.2 * math.sin(t / 900 + n.phase) + 0.8 * math.sin(t / 97 + 2 * n.phase)
        return n.rssi_seed + drift + R.gauss(0, 1.2)

    def _pick_band(self, n: NodeState, t: float):
        """Gorev dongusu karalistesi + ERP sinifi + band split ile bant secimi."""
        now = t
        if now < n.blacklist_until["L"]:
            return "O", 0
        if now < n.blacklist_until["O"]:
            return "L", 1
        # dusuk ERP sinifi secildiyse 500 mW'lik Band O kullanilamaz (ETSI uyumu)
        if getattr(n, "erp_cap_mw", 500) < 500:
            return "L", 1
        return ("L", 1) if R.random() < n.band_split else ("O", 0)

    def _slot_of_node(self, nid: str):
        """Her dugume ozel 1 TX slotu (slot 3..34); makale: dugum basina 1 iletim
        hucresi (~3715 cadir/saat)."""
        idx = sorted(C.NODES.keys()).index(nid)
        return 3 + (idx % 32)

    # ---- metrik uretimi ----------------------------------------------------

    def _gen_metrics_row(self, n: NodeState, t: float, dt_s: float = None, emit: bool = True):
        """dt_s: bu cagrinin kapsadigi sure. Tohumlama 30 sn'yi tek cagrida uretir;
        canli dongu 1 sn'lik cagrilarda pencereye olcekli birikim yapar (emit=False).
        (Eski hata: canlida her saniye tam 30 sn'lik hava zamani ekleniyordu ->
        gorev dongusu degerleri ~30x sisliydi.)"""
        if dt_s is None:
            dt_s = float(C.DUTY_WINDOW_S)
        rssi = self._rssi_now(n, t)
        band, carrier = self._pick_band(n, t)
        if band == "L":
            rssi -= 13.0  # makale: ayni link Band L'de 13 dB daha kotu
        snr = rssi - C.NOISE_FLOOR
        # ETX: hedefe yaklasir, zayif + Band L daha kotu
        target = n.etx_target * (1.25 if (band == "L" and rssi < -75) else 1.0)
        n.etx += (target - n.etx) * 0.05 + R.gauss(0, 0.02)
        n.etx = max(1.0, n.etx)
        pdr = 100.0 * (1.0 - (1.0 - 1.0 / n.etx) ** 3)  # 3 MAC denemesi sonrasi teslim
        # iletim sayisi ve gorev dongusu (taban sabit; sin gecici salinim)
        base = n.tx_rate_base * (0.85 if not n.instrumented else 1.0)
        tx_rate = base * (1.0 + 0.15 * math.sin(t / 300 + n.phase))
        n.tx_rate = tx_rate
        retrans = max(0, int(round(tx_rate * dt_s * (n.etx - 1.0) / max(1.0, n.etx))))
        # enerji: TX havada kalma + RX dinleme (CC1312R1+CC1190 yaklasimi)
        p_tx = 1.30 if band == "O" else 0.47        # W (+27 dBm / +14 dBm)
        p_rx = 0.095
        tx_count = max(0, int(round(tx_rate * dt_s)))
        # NOT: tx_rate makalede tekrarlar+ack DAHIL fiziksel iletim sayisidir;
        # havada kalmaya retrans'i ayrica eklemek cifte sayim olurdu.
        air_s = tx_count * C.AIRTIME_MS / 1000.0
        energy = air_s * p_tx * 1000 + (dt_s * p_rx * 1000) * R.uniform(0.85, 1.0)
        # batarya: agir ceken dugumler hizli duser
        # NOT: boley DUTY_WINDOW_S'e bagli (2880 pencere/gun); dt_s'den bagimsiz
        # boylece tohumlama (dt=30) ve canli tik (dt=1) ayni hizda deşarj olur.
        drain = (air_s * 0.35 + dt_s * 0.0008) / (86400.0 / C.DUTY_WINDOW_S)
        n.battery = max(3.05, n.battery - drain * R.uniform(0.7, 1.3))
        # pencere sayaclarina hava zamani ekle
        n.window_air[band] += air_s * 1000
        n.window_tx = tx_count
        n.window_retrans = retrans
        n.rssi = rssi
        n.last_band = band
        n.last_carrier = carrier
        n.slot_id = self._slot_of_node(n.id)
        if emit:
            row = (t, n.id, round(rssi, 1), round(snr, 1), round(n.etx, 2),
                   round(energy, 2), round(n.battery, 3), round(tx_rate, 2),
                   retrans, round(pdr, 1), band, carrier, n.slot_id,
                   n.parent, n.source)
            return row, band, carrier
        # canli mod: pencere boyu biriktir; satir pencere kapaninca yazilir
        n.acc_energy += energy
        n.acc_retrans += retrans
        return None, band, carrier

    def _close_duty_window(self, n: NodeState, t: float):
        """30 sn'lik gorev dongusu penceresini kapat; medyan/p90 uret."""
        rows = []
        for band in ("L", "O"):
            air = n.window_air[band]
            n.duty[band].append(air)
            if len(n.duty[band]) > 40:
                n.duty[band].pop(0)
            n.window_air[band] = 0.0
            if not n.instrumented:
                continue
            seq = sorted(n.duty[band])
            med = seq[len(seq) // 2] / 1000.0 / C.DUTY_WINDOW_S
            p90 = seq[int(len(seq) * 0.9)] / 1000.0 / C.DUTY_WINDOW_S
            limit = C.duty_limit_of(band)
            used = p90 / limit * 100
            # makale Tablo 14'e kalibrasyon: enstrumante dugumlerde hedef p90
            tgt = C.TABLE14.get(n.id)
            if tgt:
                bi = 2 if band == "L" else 4  # TABLE14: (etx, bl_med, bl_p90, bl_used, bo_p90, bo_used)
                scale = (tgt[bi] / 100.0 * limit) / max(p90, 1e-6)
                scale = max(0.5, min(2.0, scale))
                p90 *= scale ** 0.45
                used = p90 / limit * 100
            denied = max(0.0, used - 100) * 0.3 if used > 100 else R.uniform(0, 0.05)
            deferral = R.uniform(0, 3) if used > 90 else R.uniform(0, 0.4)
            rows.append((t, n.id, band, round(med * 100, 3), round(p90 * 100, 3),
                         round(used, 1), round(denied, 2), round(deferral, 2)))
            # olaylar: esik ihlali / karaliste
            if used > 100 and R.random() < 0.35:
                n.blacklist_until[band] = t + R.uniform(45, 120)
                store.insert_event(t, "warn", "duty_violation", n.id,
                    f"{n.id}: Band {band} gorev dongusu p90 %{used:.0f} - limit %"
                    f"{limit*100:.0f} asildi, kanal gecici karalisteye alindi")
            elif used > 90 and R.random() < 0.15:
                store.insert_event(t, "info", "duty_warning", n.id,
                    f"{n.id}: Band {band} gorev dongusu p90 limitin %{used:.0f}'i")
        n.denied_pct = rows[0][6] if rows else 0
        return rows

    def _in_subtree(self, root_id: str, nid: str) -> bool:
        """nid, root_id'nin alt agacinda mi (dongu olusmasini engeller)."""
        cur = nid
        for _ in range(len(self.nodes) + 1):
            if cur == root_id:
                return True
            st = self.nodes.get(cur)
            if not st:
                return False
            cur = st.parent
        return False

    def _maybe_churn(self, n: NodeState, t: float, dt_s: float = 1.0):
        """Saat bazli oranla ebeveyn degisimi; dt_s cagrililar arasi sure."""
        # varsayilan: saatte ~%6 -> 24 saatte dugumlerin ~%78'i en az bir kez
        # ebeveyn degistirir (makale: 32'de 25). 0.12 ust sinir olarak kaldi.
        rate = C.CHURN_PRONE.get(n.id, 0.06)
        pr = rate * dt_s / 3600.0
        if n.instrumented:
            pr *= 1.4
        if R.random() < pr:
            cands = C.PARENT_CANDIDATES.get(n.id)
            if cands:
                newp = R.choice([c for c in cands if c != n.parent] or cands)
            else:
                # ust seviyede, kendi alt agacinda olmayan bir aday
                # (hop korunur; dongu ve derinlik sisması engellenir)
                same = [m for m, v in self.nodes.items()
                        if v.hop < n.hop and m != n.id and m != n.parent
                        and not self._in_subtree(n.id, m)]
                newp = R.choice(same) if same else n.parent
            if newp != n.parent:
                old = n.parent
                n.parent = newp
                n.rssi_seed = self.nodes[newp].rssi_seed if newp in self.nodes else n.rssi_seed
                if newp in self.nodes:
                    n.hop = self.nodes[newp].hop + 1
                store.insert_routing([(t, n.id, old, newp, n.hop, "ETX/komuluk guncellemesi")])
                store.insert_event(t, "info", "parent_change", n.id,
                    f"{n.id}: ebeveyn {old} -> {newp}")

    # ---- tohumlama (24 saat gecmis) ----------------------------------------

    def _seed_history(self, start, end):
        t = start
        step = C.DUTY_WINDOW_S
        n_nodes = len(self.nodes)
        print(f"Tohumlama: {seed_hours_h(start, end)} saatlik gecmis uretiliyor...")
        while t < end:
            mrows, srows, drows = [], [], []
            for n in self.nodes.values():
                row, band, carrier = self._gen_metrics_row(n, t)
                mrows.append(row)
                if n.instrumented and int(t) % 60 < step:
                    srows.append((t, n.id, n.slot_id, carrier, band, "TX"))
                drows.extend(self._close_duty_window(n, t))
                # gecmis ebeveyn degisimi (makale: 25/32 dugum en az bir kez)
                self._maybe_churn(n, t, step)
            store.insert_metrics(mrows)
            if srows:
                store.insert_slot_usage(srows)
            store.insert_duty(drows)
            t += step
        store.conn().commit()
        print("Tohumlama tamam.")

    # ---- ana dongu ---------------------------------------------------------

    async def run(self):
        self._running = True
        last_window = time.time()
        last_sample = time.time()
        last_purge = time.time()
        while self._running:
            await asyncio.sleep(1.0)
            t = time.time()
            # 1 sn'lik tik: dugum durumunu guncelle, 30 sn'lik pencereye olcekli biriktir
            for n in self.nodes.values():
                self._gen_metrics_row(n, t, dt_s=1.0, emit=False)
                self._maybe_churn(n, t)
            # 30 sn'lik pencere kapandiginda metrik + gorev dongusu satirlarini yaz
            if t - last_window >= C.DUTY_WINDOW_S:
                drows = []
                mrows = []
                for n in self.nodes.values():
                    drows.extend(self._close_duty_window(n, t))
                    pdr = 100.0 * (1.0 - (1.0 - 1.0 / max(1.0, n.etx)) ** 3)
                    mrows.append((t, n.id, round(n.rssi, 1), round(n.rssi - C.NOISE_FLOOR, 1),
                                  round(n.etx, 2), round(n.acc_energy, 2), round(n.battery, 3),
                                  round(n.tx_rate, 2), n.acc_retrans, round(pdr, 1),
                                  n.last_band, n.last_carrier, n.slot_id, n.parent, n.source))
                    n.acc_energy = 0.0
                    n.acc_retrans = 0
                store.insert_metrics(mrows)
                store.insert_duty(drows)
                store.conn().commit()
                last_window = t
            # slot kullanim orneklemesi (enstrumante)
            if t - last_sample >= 30:
                srows = []
                for n in self.nodes.values():
                    if n.instrumented:
                        band, carrier = self._pick_band(n, t)
                        srows.append((t, n.id, self._slot_of_node(n.id),
                                      carrier, band, "TX"))
                store.insert_slot_usage(srows)
                store.conn().commit()
                last_sample = t
            if t - last_purge > 1800:
                store.purge_older_than(48)
                last_purge = t
            await self._broadcast(t)

    def snapshot(self, t=None):
        t = t or time.time()
        asn = C.asn_of_time(t, self.t0)
        slot = C.slot_of(asn)
        carrier = C.carrier_for(asn)
        nodes = []
        for n in sorted(self.nodes.values(), key=lambda x: x.id):
            nodes.append({
                "id": n.id, "hop": n.hop, "parent": n.parent,
                "rssi": round(n.rssi, 1), "etx": round(n.etx, 2),
                "snr": round(n.rssi - C.NOISE_FLOOR, 1),
                "battery": round(n.battery, 2),
                "tx_rate": round(n.tx_rate, 2),
                "band": getattr(n, "last_band", "L"),
                "carrier": getattr(n, "last_carrier", 1),
                "slot_id": getattr(n, "slot_id", None), 
                "instrumented": n.instrumented, "active": n.active,
                "pdr": round(100.0 * (1.0 - (1.0 - 1.0 / max(1.0, n.etx)) ** 3), 1),
                "retrans": n.window_retrans,
            })
        return {"type": "tick", "ts": t, "asn": asn, "slot": slot,
                "carrier": carrier, "freq": C.freq_of(carrier),
                "band": C.band_of(carrier), "nodes": nodes}

    async def _broadcast(self, t):
        if not self.ws_clients:
            return
        msg = json.dumps(self.snapshot(t))
        dead = []
        for ws in list(self.ws_clients):
            try:
                await ws.send_text(msg)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.ws_clients.discard(ws)

    # ---- konfigurasyon (dinamik konfigurasyon, CoAP PUT) --------------------

    def apply_config(self, node_id: str, params: dict):
        t = time.time()
        n = self.nodes.get(node_id)
        if not n:
            raise KeyError(node_id)
        # Ayni TX gucunu tekrar uygulamak durumu veya islem kaydini degistirmez.
        if set(params) == {"tx_power_dbm"} and float(params["tx_power_dbm"]) == n.tx_power_dbm:
            return {"status": "2.04 Changed", "method": "PUT",
                    "target": f"coap://[fd00::c30c:0:0:{node_id}]/a/cfg",
                    "payload": json.dumps(params, separators=(",", ":")),
                    "ts": t, "unchanged": True}
        # etkiler: TX gucu -> RSSI/ETX; RSSI esigi -> bant ayrilmasi
        if "tx_power_dbm" in params:
            power = float(params["tx_power_dbm"])
            delta = power - n.tx_power_dbm
            n.rssi_seed += delta * 0.8
            n.tx_power_dbm = power
        if "rssi_threshold" in params:
            thr = float(params["rssi_threshold"])
            n.band_split = max(0.15, min(0.85, 0.45 + (thr + 75) * 0.02))
        if "erp_class_mw" in params:
            # ERP sinifi: 500 mW alti siniflarda Band O (500 mW) kullanilamaz
            n.erp_cap_mw = int(params["erp_class_mw"])
        elif "erp_class" in params:
            m = re.search(r"(\d+)\s*mW", str(params["erp_class"]))
            if m:
                n.erp_cap_mw = int(m.group(1))
        if "eb_period" in params:
            pass  # gorsel etkiyi frontend gosterir
        target = f"coap://[fd00::c30c:0:0:{node_id}]/a/cfg"
        payload = json.dumps(params, separators=(",", ":"))
        store.insert_config(t, node_id, params, "2.04 Changed", "PUT", target)
        store.insert_event(t, "info", "config", node_id,
                           f"{node_id}: konfigurasyon uygulandi (CoAP PUT)", params)
        return {"status": "2.04 Changed", "method": "PUT", "target": target,
                "payload": payload, "ts": t}

    # ---- gercek veri hatti (ingest) -----------------------------------------

    def ingest(self, data: dict):
        t = float(data.get("ts") or time.time())
        nid = str(data["node_id"])
        n = self.nodes.get(nid)
        if n:
            n.source = "real"
            n.rssi = float(data["rssi"])
            n.etx = float(data["etx"])
            # gercek olcum dugum durumunu kalici bicimde beslesin:
            # aksi halde bir sonraki sim tik'i degeri eski tohum uzerine ezerdi
            n.rssi_seed = float(data["rssi"])
            n.etx_target = max(1.0, float(data["etx"]))
        carrier = int(data.get("carrier", 0))
        band = data.get("band") or C.band_of(carrier)
        row = (t, nid, float(data["rssi"]), float(data["snr"]), float(data["etx"]),
               float(data["energy_mj"]), float(data.get("battery_v", 3.6)),
               float(data.get("tx_rate", 1.0)), int(data["retrans"]),
               round(100.0 * (1.0 - (1.0 - 1.0 / max(1.0, float(data["etx"]))) ** 3), 1), band, carrier,
               int(data["slot_id"]), data.get("parent", n.parent if n else "DCU"),
               "real")
        store.insert_metrics([row])
        store.conn().commit()
        return True


def seed_hours_h(a, b):
    return round((b - a) / 3600)


ENGINE = Engine()
