# -*- coding: utf-8 -*-
"""
6TiSCH 868 MHz izleme paneli - sabitler ve ag topolojisi.
Parametreler 868 MHz saha olcum makalesinden (22 saatlik 32 dugumlu yerlesim,
Sekil 14 + Tablo 14) alinmistir.
"""

# ---- Zamanlama (TSCH) -------------------------------------------------------
SLOT_MS = 17                 # makale: timeslot 17 ms
SLOTFRAME_LEN = 57           # makale: 57 timeslot = 969 ms
SLOTFRAME_MS = SLOT_MS * SLOTFRAME_LEN
EB_SLOT = 0                  # Enhanced Beacon slotu
SHARED_SLOTS = [35, 36, 37]  # icerik paylasimli (contention) slotlar

# ---- Kanal plani (makale Sekil 11/12) ---------------------------------------
CARRIERS = {
    1: {"freq_mhz": 865.150, "band": "L", "duty_limit": 0.01,  "erp": "25 mW"},
    2: {"freq_mhz": 867.850, "band": "L", "duty_limit": 0.01,  "erp": "25 mW"},
    0: {"freq_mhz": 869.525, "band": "O", "duty_limit": 0.10,  "erp": "500 mW"},
}
# 7 elemanli atlama dizisi: 3 x Band O, 4 x Band L (makale: 3/7 O, 4/7 L)
HOPSEQ = [2, 0, 1, 0, 2, 0, 1]

# ---- Butce / esikler --------------------------------------------------------
RSSI_WEAK = -85.0    # zayif baglanti siniri (dBm)
SNR_WEAK = 4.0       # dB
ETX_WEAK = 2.5
RSSI_STRONG = -70.0  # guclu baglanti siniri (dBm)
SNR_STRONG = 7.0     # dB
ETX_STRONG = 1.5
NOISE_FLOOR = -100.0 # dBm, 150 kbps 2-FSK

DUTY_WINDOW_S = 30   # gorev dongusu penceresi (makale: 30 s pencere medyan/p90)
AIRTIME_MS = 3.8     # kadre basi havada kalma suresi (makale: medyan 3.5-4.1 ms)

# ---- Topoloji (makale Sekil 14 + Tablo 14) ----------------------------------
# id: (hop, parent, rssi_seed, instrumented, tx_rate, subtree)
NODES = {
    "7181": (1, "DCU",  -15, True,  1.19, 0),
    "71B7": (1, "DCU",  -67, False, 1.10, 2),
    "71BE": (1, "DCU",  -45, False, 1.12, 2),
    "71D0": (1, "DCU",  -64, False, 1.08, 1),
    "71F1": (1, "DCU",  -66, False, 1.10, 2),
    "71F5": (1, "DCU",  -44, False, 1.10, 1),
    "71FD": (1, "DCU",  -63, False, 1.05, 0),
    "7402": (1, "DCU",  -75, True,  2.33, 15),
    "740B": (1, "DCU",  -36, False, 1.05, 0),
    # 2. hop
    "71F4": (2, "7402", -58, True,  1.64, 8),
    "71F9": (2, "7402", -14, False, 1.02, 0),
    "71E0": (2, "7402", -15, False, 1.02, 0),
    "71D7": (2, "7402", -77, False, 1.35, 0),
    "71DE": (2, "7402", -79, False, 1.40, 0),
    "71F8": (2, "7402", -14, False, 1.02, 0),
    "7411": (2, "7402", -57, False, 1.05, 0),
    "71C0": (2, "71F1", -79, True,  3.13, 0),
    "740E": (2, "71F1", -15, False, 1.02, 0),
    "7410": (2, "71B7", -66, False, 1.05, 0),
    "71D2": (2, "71B7", -14, False, 1.02, 0),
    "71D5": (2, "71BE", -63, False, 1.05, 0),
    "71DC": (2, "71BE", -64, False, 1.05, 0),
    "71A6": (2, "71D0", -84, False, 1.45, 0),
    "71AD": (2, "71F5", -14, False, 1.02, 0),
    # 3. hop
    "71D8": (3, "71F4", -75, True,  3.85, 1),
    "71CF": (3, "71F4", -44, False, 1.05, 0),
    "71F0": (3, "71F4", -54, False, 1.05, 0),
    "71F7": (3, "71F4", -14, False, 1.02, 0),
    "7405": (3, "71F4", -14, False, 1.02, 0),
    "71B3": (3, "71F4", -14, False, 1.02, 0),
    "71B9": (3, "71F4", -63, False, 1.05, 0),
    # 4. hop
    "71FE": (4, "71D8", -50, False, 1.05, 0),
}

INSTRUMENTED = [n for n, v in NODES.items() if v[3]]

# Tablo 14 olcumleri: node: (etx, bl_med, bl_p90, bl_used, bo_p90, bo_used)
TABLE14 = {
    "7181": (1.19, 0.25, 0.36, 36,  0.31, 3),
    "71F4": (1.64, 0.27, 0.77, 77,  0.62, 6),
    "7402": (2.33, 0.32, 0.99, 99,  1.02, 10),
    "71D8": (3.85, 0.36, 1.00, 100, 2.46, 25),
    "71C0": (3.13, 0.54, 1.02, 102, 1.43, 14),
}

# Parent degistirme egilimi (makale: 71C0 uc ebeyn denedi; 25/32 dugum en az bir kez)
# degerler: saat basina beklenen degisim olasiligi
PARENT_CANDIDATES = {
    "71C0": ["71F1", "740E", "71D5"],
}
CHURN_PRONE = {"71C0": 0.12, "71D8": 0.06, "71A6": 0.07, "71DE": 0.06,
               "71D7": 0.05, "71FE": 0.05, "7402": 0.025, "71F4": 0.025}

# ---- Veri formati ------------------------------------------------------------
# Sistem her cihazdan su alanlari toplar (CoAP uzerinden JSON):
INGEST_FIELDS = ["node_id", "rssi", "snr", "etx", "energy_mj",
                 "slot_id", "ts", "retrans"]
INGEST_OPTIONAL = ["carrier", "band", "battery_v", "tx_rate", "parent"]


def carrier_for(asn: int, chan_ofs: int = 0) -> int:
    """TSCH kanal atlama kurali: HOPSEQ[(ASN + delta) mod 7]."""
    return HOPSEQ[(asn + chan_ofs) % len(HOPSEQ)]


def freq_of(carrier: int) -> float:
    return CARRIERS[carrier]["freq_mhz"]


def band_of(carrier: int) -> str:
    return CARRIERS[carrier]["band"]


def duty_limit_of(band: str) -> float:
    return 0.01 if band == "L" else 0.10


def slot_of(asn: int) -> int:
    return asn % SLOTFRAME_LEN


def asn_of_time(t: float, t0: float) -> int:
    return int((t - t0) * 1000.0 / SLOT_MS)
