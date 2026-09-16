// Yonlendirme Yapisi Paneli: RPL ebeveyn tablosu, guncelleme sayilari, degisim zaman cizelgesi
import { api, state, el, fmt1, fmt2, fmtDT, BAND_COLOR } from "../api.js";
import { lineChart, hmFmt } from "../charts.js";

const rt = { built: false, root: null, lastFetch: 0, lastSnap: null };

export function renderRouting(root) {
  rt.root = root;
  if (!rt.built) {
    root.innerHTML = "";
    const g = el("div", { class: "grid c2" });
    const t = el("div", { class: "card" });
    t.append(el("h3", {}, "RPL Ebeveyn Tablosu", el("small", {}, "anlık · son 10 dk güncelleme sayıları")));
    t.append(el("div", { id: "rt-table" }));
    const h = el("div", { class: "card" });
    h.append(el("h3", {}, "Hop Derinliği Dağılımı", el("small", {}, "ağ istikrarı göstergesi")));
    h.append(el("div", { id: "rt-hist" }));
    g.append(t, h);
    const s = el("div", { class: "card", style: "margin-top:14px" });
    s.append(el("h3", {}, "Ebeveyn Değişim Zaman Çizelgesi", el("small", {}, "son 24 saat · RPL yönlendirme kararlılığı")));
    s.append(el("div", { id: "rt-scatter" }));
    root.append(g, s);
    rt.built = true;
  }
  refresh();
}

async function refresh() {
  if (!document.getElementById("tab-routing").classList.contains("on")) return;
  rt.lastFetch = Date.now();
  const topo = await api("/api/topology");
  const nodes = topo.nodes.filter(n => n.id !== "DCU").sort((a, b) => a.id.localeCompare(b.id));
  const tb = el("table", { class: "t" });
  tb.append(el("tr", {}, el("th", {}, "Düğüm"), el("th", {}, "Ebeveyn"), el("th", {}, "Hop"),
    el("th", {}, "ETX"), el("th", {}, "RSSI"), el("th", {}, "RPL günc. (10 dk)"), el("th", {}, "Bant")));
  for (const n of nodes) {
    tb.append(el("tr", {},
      el("td", { class: "mono" }, n.id + (n.instrumented ? " ◆" : "")),
      el("td", { class: "mono" }, n.parent),
      el("td", { class: "mono" }, String(n.hop)),
      el("td", { class: "mono" }, fmt2(n.etx)),
      el("td", { class: "mono" }, fmt1(n.rssi)),
      el("td", { class: "mono" }, String(n.rpl_updates_10m || 0)),
      el("td", {}, el("span", { class: "tag " + n.band }, "Band " + n.band))));
  }
  document.getElementById("rt-table").innerHTML = "";
  document.getElementById("rt-table").append(tb);
  document.getElementById("rt-table").append(el("div", { class: "hint", style: "margin-top:8px" },
    "◆ enstrümante düğüm (makale Tablo 14)"));

  // hop dagilimi
  const hops = {};
  topo.nodes.forEach(n => { if (n.id !== "DCU") hops[n.hop] = (hops[n.hop] || 0) + 1; });
  const hs = Object.entries(hops).sort((a, b) => a[0] - b[0]);
  const W = 400, H = 220, padB = 30, padL = 30;
  const maxV = Math.max(...hs.map(h => h[1]));
  let svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%">';
  const bw = (W - padL - 20) / hs.length - 18;
  hs.forEach(([h, v], i) => {
    const x = padL + i * ((W - padL - 20) / hs.length) + 9;
    const bh = (H - padB - 16) * v / maxV;
    svg += '<rect x="' + x + '" y="' + (H - padB - bh) + '" width="' + bw + '" height="' + bh + '" rx="4" fill="#b7c4ff" opacity="0.8"/>';
    svg += '<text x="' + (x + bw / 2) + '" y="' + (H - padB - bh - 6) + '" fill="#e4e1e7" font-size="12" text-anchor="middle">' + v + '</text>';
    svg += '<text x="' + (x + bw / 2) + '" y="' + (H - 10) + '" fill="#a5a4b0" font-size="11" text-anchor="middle">' + h + ' hop</text>';
  });
  svg += "</svg>";
  document.getElementById("rt-hist").innerHTML = svg;

  // scatter: 24 saatlik ebeveyn degisimleri
  const t1 = Date.now() / 1000, t0 = t1 - 24 * 3600;
  const idx = {}; nodes.forEach((n, i) => idx[n.id] = i);
  const ch = topo.changes.filter(c => idx[c.node] != null);
  let sc = '<svg viewBox="0 0 900 ' + (nodes.length * 14 + 40) + '" width="100%">';
  for (let i = 0; i <= 6; i++) {
    const ts = t0 + (t1 - t0) * i / 6;
    const x = 60 + (830) * i / 6;
    sc += '<line x1="' + x + '" y1="10" x2="' + x + '" y2="' + (nodes.length * 14 + 20) + '" stroke="#35353b"/>';
    sc += '<text x="' + x + '" y="' + (nodes.length * 14 + 34) + '" fill="#8f909a" font-size="10" text-anchor="middle">' + hmFmt(ts) + '</text>';
  }
  nodes.forEach((n, i) => {
    const y = 18 + i * 14;
    sc += '<text x="0" y="' + (y + 3) + '" fill="#8f909a" font-size="9" font-family="ui-monospace,monospace">' + n.id + '</text>';
  });
  for (const c of ch) {
    const i = idx[c.node]; if (i == null) continue;
    const x = 60 + (c.ts - t0) / (t1 - t0) * 830;
    const y = 18 + i * 14;
    sc += '<circle cx="' + x + '" cy="' + y + '" r="4" fill="#f472b6" opacity="0.85"><title>' + c.node + ": " +
      c.old_parent + " → " + c.new_parent + "</title></circle>";
  }
  sc += "</svg>";
  const scat = document.getElementById("rt-scatter");
  scat.innerHTML = sc;
  scat.append(el("div", { class: "hint", style: "margin-top:6px" },
    ch.length + " ebeveyn değişimi · makalede 32 düğümden 25'i en az bir kez ebeveyn değiştirmişti (RPL ETX metriği band-farkında olmadığı için)"));
}

export function tickRouting(snap) {
  if (rt.built && Date.now() - rt.lastFetch > 20000 &&
      document.getElementById("tab-routing").classList.contains("on")) refresh();
}
