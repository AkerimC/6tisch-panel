// Uygulama girisi: sekmeler, genel bakis paneli, canli akis
import { api, state, connectWS, onTick, initTabs, el, fmtTime, fmt1, fmt2, BAND_COLOR, CARRIER_LABEL } from "./api.js";
import { gauge, lineChart, hmFmt } from "./charts.js";
import { renderSlotframe, tickSlotframe } from "./panels/slotframe.js";
import { renderSlotfreq, tickSlotfreq } from "./panels/slotfreq.js";
import { renderTopology, tickTopology } from "./panels/topology.js";
import { renderEnergy, tickEnergy } from "./panels/energy.js";
import { renderRouting, tickRouting } from "./panels/routing.js";
import { renderConfig } from "./panels/config.js";

const $ = id => document.getElementById(id);

// ---- ust bilgi canli gostergeleri -------------------------------------------
onTick(snap => {
  $("hdr-asn").textContent = snap.asn.toLocaleString("tr-TR");
  const sfLen = state.network?.slotframe?.len || 57;
  $("hdr-slot").textContent = snap.slot + " / " + sfLen;
  $("hdr-freq").textContent = snap.freq.toFixed(3) + " MHz";
  const b = $("hdr-band");
  b.textContent = "Band " + snap.band;
  b.style.color = BAND_COLOR[snap.band];
  $("foot-ts").textContent = "son paket: " + fmtTime(snap.ts) + " · ASN " + snap.asn;
});

async function refreshHeaderNet() {
  try {
    state.network = await api("/api/network");
    state.cellmap = state.network.cellmap;
  } catch (e) { console.error(e); }
}

// ---- GENEL BAKIS -------------------------------------------------------------
const overview = { built: false, els: {} };

function buildOverview(root) {
  root.append(el("div", { class: "grid c4", id: "ov-kpis" }));
  const g2 = el("div", { class: "grid c2", style: "margin-top:14px" });

  // mimari sema karti
  const arch = el("div", { class: "card" });
  arch.append(el("h3", {}, "Sistem Mimarisi", el("small", {}, "6TiSCH ağı → sınır yönlendirici → bulut")));
  arch.append(el("div", { id: "ov-arch" }));
  arch.append(el("div", { class: "hint", style: "margin-top:8px" },
    "Düğümler TSCH ile DCU'ya (6LoWPAN border router) slotlu, kanal atlamalı iletim yapar; ölçümler CoAP/JSON ile backend'e akar."));

  // gorev dongusu karti
  const duty = el("div", { class: "card" });
  duty.append(el("h3", {}, "Görev Döngüsü Bütçesi", el("small", {}, "p90 / 30 sn pencere (ETSI EN 300 220-2)")));
  duty.append(el("div", { class: "grid c2", id: "ov-duty" }));
  duty.append(el("div", { class: "hint", style: "margin-top:6px" },
    "Enstrümante 5 düğümün Band L (%1) ve Band O (%10) tavanı kullanımı — makaledeki asimetri burada görünür."));

  g2.append(arch, duty);

  // kanal plani + olaylar
  const g3 = el("div", { class: "grid c2", style: "margin-top:14px" });
  const chans = el("div", { class: "card" });
  chans.append(el("h3", {}, "Kanal Planı", el("small", {}, "ETSI alt bantları")));
  chans.append(el("div", { id: "ov-chans" }));
  const ev = el("div", { class: "card" });
  ev.append(el("h3", {}, "Olay Akışı", el("small", {}, "karaliste · ebeveyn değişimi · konfigürasyon")));
  ev.append(el("div", { class: "feed", id: "ov-events" }));
  g3.append(chans, ev);

  root.append(g2, g3);
  overview.built = true;
}

function renderArch(host, snap) {
  const nodes = snap.nodes.filter(n => n.active).length;
  const bandL = snap.nodes.filter(n => n.band === "L").length;
  const bandO = snap.nodes.filter(n => n.band === "O").length;
  host.innerHTML = '';
  const W = 640, H = 210;
  const box = (x, y, w, h, fill, title, sub) =>
    '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '" rx="12" fill="' + fill + '" stroke="#45464f"/>' +
    '<text x="' + (x + w / 2) + '" y="' + (y + 26) + '" text-anchor="middle" fill="#e4e1e7" font-size="14" font-weight="700">' + title + '</text>' +
    '<text x="' + (x + w / 2) + '" y="' + (y + 46) + '" text-anchor="middle" fill="#a5a4b0" font-size="11">' + sub + '</text>';
  const flow = (x1, x2, y) =>
    '<line x1="' + x1 + '" y1="' + y + '" x2="' + x2 + '" y2="' + y + '" stroke="#b7c4ff" stroke-width="2" class="arch-flow"/>' +
    '<circle r="3.5" fill="#b7c4ff"><animateMotion dur="1.6s" repeatCount="indefinite" path="M ' + x1 + ' ' + y + ' L ' + x2 + ' ' + y + '"/></circle>';
  let mesh = "";
  for (let i = 0; i < 7; i++) {
    const yy = 58 + i * 14;
    mesh += '<circle cx="86" cy="' + yy + '" r="4.5" fill="' + (i % 2 ? BAND_COLOR.O : BAND_COLOR.L) + '"/>';
  }
  host.append(Object.assign(document.createElement("div"), {
    innerHTML: '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%">' +
      box(30, 40, 115, 110, "#26262b", "6TiSCH Ağı", nodes + " düğüm · 4 hop") + mesh +
      '<text x="87" y="170" text-anchor="middle" fill="#8f909a" font-size="10">TSCH · 57 slot · 7 kanal dizisi</text>' +
      flow(148, 232, 95) +
      box(235, 40, 130, 110, "#1b1b1f", "Border Router", "DCU · 6LBR") +
      '<text x="300" y="170" text-anchor="middle" fill="#8f909a" font-size="10">CoAP/JSON · RPL DODAG kökü</text>' +
      flow(368, 452, 95) +
      box(455, 40, 150, 110, "#26262b", "Bulut / Backend", "FastAPI + SQLite") +
      '<text x="530" y="170" text-anchor="middle" fill="#8f909a" font-size="10">bu panel · CoAP :5683 /s/metrics</text>' +
      '</svg>'
  }));
  const counts = '<div class="legend" style="margin-top:2px">' +
    '<span><span class="sw" style="background:' + BAND_COLOR.L + '"></span>Band L aktif: <b class="mono">' + bandL + '</b> düğüm</span>' +
    '<span><span class="sw" style="background:' + BAND_COLOR.O + '"></span>Band O aktif: <b class="mono">' + bandO + '</b> düğüm</span></div>';
  host.append(Object.assign(document.createElement("div"), { innerHTML: counts }));
}

async function showOverview(root) {
  if (!overview.built) buildOverview(root);
  const snap = state.snap || await api("/api/network").then(n => ({ nodes: [], asn: n.asn, slot: n.slot, carrier: n.carrier, freq: n.freq, band: n.band, ts: Date.now() / 1000 }));
  const net = state.network || await api("/api/network");
  // KPI'lar
  const kpis = $("ov-kpis");
  kpis.innerHTML = "";
  const nodes = snap.nodes || [];
  const active = nodes.filter(n => n.active).length;
  const avgRssi = nodes.length ? nodes.reduce((a, n) => a + n.rssi, 0) / nodes.length : 0;
  const pdr = nodes.length ? nodes.reduce((a, n) => a + n.pdr, 0) / nodes.length : 0;
  const mkKpi = (num, lbl, sub2, color) => {
    const c = el("div", { class: "card kpi" });
    const n = el("div", { class: "num" }, num);
    if (color) n.style.color = color;
    c.append(n, el("div", { class: "lbl" }, lbl), el("div", { class: "sub2" }, sub2 || ""));
    return c;
  };
  kpis.append(
    mkKpi(active + " / " + net.totals.nodes, "Aktif Düğüm", "DCU + " + (net.totals.nodes - 1) + " sayaç motesi"),
    mkKpi(net.totals.uptime_s < 1e9 ? Math.floor(net.totals.uptime_s / 60) + " dk" : "—", "Ağ Çalışma Süresi", "ASN " + net.asn.toLocaleString("tr-TR")),
    mkKpi(fmt1(avgRssi) + " dBm", "Ortalama RSSI", "son hop"),
    mkKpi(fmt1(pdr) + "%", "Ortalama PDR", "ETX kaynaklı", avgRssi > -70 ? "var(--ok)" : "var(--warn)"),
  );
  renderArch($("ov-arch"), { nodes });
  // gorev dongusu gaugeleri (enstrumante dugumler API'den dinamik)
  const duty = $("ov-duty");
  duty.innerHTML = "";
  const inst = net.instrumented || ["7402", "71D8", "71C0", "71F4", "7181"];
  const pick = (b) => {
    for (const id of inst) {
      const v = net.duty[id + "_" + b];
      if (v) return v;
    }
    return null;
  };
  const lim = net.duty_limits || { L: 1, O: 10 };
  const vL = pick("L"), vO = pick("O");
  duty.append(
    el("div", {}, gauge(vL ? vL.used : 0, 100, `Band L / %${lim.L} tavan`, "#34d399", vL ? "p90 " + fmt2(vL.p90) + " · en yüksek düğüm" : "")),
    el("div", {}, gauge(vO ? vO.used : 0, 100, `Band O / %${lim.O} tavan`, "#fb923c", vO ? "p90 " + fmt2(vO.p90) + " · en yüksek düğüm" : "")),
  );
  // kanal plani
  const ch = $("ov-chans");
  ch.innerHTML = "";
  const tb = el("table", { class: "t" });
  tb.append(el("tr", {}, el("th", {}, "Kanal"), el("th", {}, "Frekans"), el("th", {}, "Bant"), el("th", {}, "Görev Döngüsü"), el("th", {}, "ERP")));
  for (const [cid, c] of Object.entries(net.carriers)) {
    tb.append(el("tr", {},
      el("td", { class: "mono" }, "ch" + cid),
      el("td", { class: "mono" }, c.freq_mhz.toFixed(3) + " MHz"),
      el("td", {}, el("span", { class: "tag " + c.band }, "Band " + c.band)),
      el("td", { class: "mono" }, "%" + (c.duty_limit * 100).toFixed(0)),
      el("td", { class: "mono" }, c.erp)));
  }
  ch.append(tb);
  // olaylar
  const evs = await api("/api/events?limit=30");
  const feed = $("ov-events");
  feed.innerHTML = "";
  for (const e of evs.slice(0, 22)) {
    feed.append(el("div", { class: "ev" },
      el("time", {}, fmtTime(e.ts)),
      el("span", { class: "tag " + (e.sev === "warn" ? "warn" : e.sev === "bad" ? "bad" : "info") },
        e.kind),
      el("span", {}, e.msg)));
  }
}

// ---- boot --------------------------------------------------------------------
async function boot() {
  await refreshHeaderNet();
  connectWS();
  // ilk snap gelene kadar biraz bekle
  for (let i = 0; i < 40 && !state.snap; i++) await new Promise(r => setTimeout(r, 100));
  const sections = {
    overview: showOverview,
    slotframe: renderSlotframe,
    slotfreq: renderSlotfreq,
    topology: renderTopology,
    energy: renderEnergy,
    routing: renderRouting,
    config: renderConfig,
  };
  initTabs((tab, sec) => sections[tab](sec));
  showOverview(document.getElementById("tab-overview"));
  onTick(snap => {
    tickSlotframe(snap);
    tickSlotfreq(snap);
    tickTopology(snap);
    tickRouting(snap);
    tickEnergy(snap);
  });
  setInterval(refreshHeaderNet, 15000);
  // genel bakis panelini gorunurken periyodik tazele
  setInterval(() => {
    if (!document.hidden && document.getElementById("tab-overview").classList.contains("on")) {
      refreshHeaderNet().then(() => showOverview(document.getElementById("tab-overview"))).catch(() => {});
    }
  }, 20000);
}

boot();
