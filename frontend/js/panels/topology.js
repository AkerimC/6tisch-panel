// Kapsama / Topoloji paneli: RPL DODAG agaci, bant/RSSI renklendirme, dugum cekmecesi
import { api, state, el, fmt1, fmt2, fmtDT, BAND_COLOR, tipShow, tipHide } from "../api.js";
import { sparkline } from "../charts.js";

const tp = { built: false, root: null, mode: "band", topo: null, lastFetch: 0, drawer: null, selNode: null };

export function renderTopology(root) {
  tp.root = root;
  if (!tp.built) {
    root.innerHTML = "";
    const card = el("div", { class: "card" });
    card.append(el("h3", {}, "Kapsama ve Ağ Topolojisi",
      el("small", {}, "RPL DODAG · makale Şekil 14 yapısı ile üretilmiş ağ")));
    const ctl = el("div", { style: "display:flex;gap:12px;align-items:center;margin-bottom:10px" });
    const modes = el("div", { class: "chips" });
    [["band", "Bant renkleri"], ["rssi", "RSSI ısı haritası"], ["hop", "Hop derinliği"]].forEach(([m, lbl]) => {
      const c = el("span", { class: "chip" + (m === tp.mode ? " on" : "") }, lbl);
      c.addEventListener("click", () => {
        tp.mode = m;
        modes.querySelectorAll(".chip").forEach(x => x.classList.remove("on"));
        c.classList.add("on");
        if (tp.topo) draw(tp.topo);
      });
      modes.append(c);
    });
    ctl.append(el("span", { class: "hint" }, "Gösterim:"), modes);
    card.append(ctl);
    tp.host = el("div", { id: "topo-wrap" });
    card.append(tp.host);
    card.append(el("div", { class: "legend", id: "topo-legend" }));
    root.append(card);
    tp.drawer = buildDrawer();
    document.body.append(tp.drawer.el);
    tp.built = true;
  }
  refresh();
}

function colorOf(n) {
  if (tp.mode === "band") return n.band === "O" ? BAND_COLOR.O : BAND_COLOR.L;
  if (tp.mode === "rssi") {
    const r = n.rssi;
    if (r >= -60) return "#34d399";
    if (r >= -70) return "#a3e635";
    if (r >= -80) return "#fbbf24";
    return "#ffb4ab";
  }
  return ["#b7c4ff", "#b5bbff", "#f472b6", "#fbbf24", "#34d399"][n.hop % 5];
}

async function refresh() {
  if (!document.getElementById("tab-topology").classList.contains("on")) return;
  tp.lastFetch = Date.now();
  tp.topo = await api("/api/topology");
  draw(tp.topo);
}

function layout(nodes) {
  // katmanlara ayir
  const byId = {}; nodes.forEach(n => byId[n.id] = n);
  const children = {};
  nodes.forEach(n => {
    const p = n.parent || "DCU";
    (children[p] = children[p] || []).push(n.id);
  });
  // DCU byId'de YOK -> depth id uzerinden calisir (undefined.id cokmesinin duzeltmesi)
  const depth = id => id === "DCU" ? 0 : (byId[id] ? byId[id].hop : 1);
  // dongu korumasi: yol uzerindeki dugumleri isaretle, geri donen kenarlari yaprak say
  const count = (id, path) => {
    if (path.has(id)) return 1;
    path.add(id);
    const v = (children[id] || []).reduce((a, c) => a + count(c, path), 0) || 1;
    path.delete(id);
    return v;
  };
  const pos = {};
  const W = 960, PAD = 40;
  const assign = (id, x0, x1, path) => {
    if (path.has(id)) return;
    path.add(id);
    pos[id] = { x: (x0 + x1) / 2, y: 30 + depth(id) * 92 };
    const kids = children[id] || [];
    if (!kids.length) { path.delete(id); return; }
    let cx = x0;
    const total = kids.reduce((a, c) => a + count(c, path), 0) || 1;
    for (const k of kids) {
      const w = (x1 - x0) * count(k, path) / total;
      assign(k, cx, cx + w, path);
      cx += w;
    }
    path.delete(id);
  };
  assign("DCU", PAD, W - PAD, new Set());
  return { pos, children, byId, W };
}

function draw(topo) {
  const { pos, children, byId, W } = layout(topo.nodes);
  const H = 30 + 4 * 92 + 50;
  let edges = "";
  for (const n of topo.nodes) {
    if (n.id === "DCU") continue;
    const p = pos[n.parent] || pos["DCU"];
    const c = pos[n.id];
    edges += '<line class="edge" data-from="' + n.parent + '" data-to="' + n.id + '" x1="' + p.x + '" y1="' + (p.y + 12) + '" x2="' + c.x + '" y2="' + (c.y - 12) + '"/>' +
      '<text x="' + ((p.x + c.x) / 2) + '" y="' + ((p.y + c.y) / 2) + '" fill="#8f909a" font-size="9" text-anchor="middle">' + Math.round(n.rssi) + ' dBm</text>';
  }
  let dots = "";
  for (const n of topo.nodes) {
    const p = pos[n.id];
    const col = n.id === "DCU" ? "#b7c4ff" : colorOf(n);
    const ring = n.instrumented ? '<circle cx="' + p.x + '" cy="' + p.y + '" r="13.5" fill="none" stroke="#b5bbff" stroke-width="1.6"/>' : "";
    const chg = tp.mode === "band" && n.band === "O" ? ' class="pulse"' : "";
    dots += '<g class="tnode" data-id="' + n.id + '"' + chg + '>' + ring +
      '<circle cx="' + p.x + '" cy="' + p.y + '" r="10" fill="' + col + '" fill-opacity="0.9" stroke="#0d0e12" stroke-width="2"/>' +
      '<text x="' + p.x + '" y="' + (p.y + 24) + '" text-anchor="middle" font-size="9.5" fill="' + (n.instrumented ? "#f1b3e6" : "#a5a4b0") + '">' + n.id + '</text>' +
      (n.id === "DCU" ? '<text x="' + p.x + '" y="' + (p.y - 16) + '" text-anchor="middle" fill="#b7c4ff" font-size="10" font-weight="700">DCU · 6LBR</text>' : "") +
      '</g>';
  }
  tp.host.innerHTML = '<div class="scroll-x"><svg id="topo-svg" viewBox="0 0 ' + W + ' ' + H + '" width="100%">' +
    edges + dots + '</svg></div>';
  tp.host.querySelectorAll(".tnode").forEach(g => {
    g.addEventListener("click", () => openDrawer(g.getAttribute("data-id")));
    const id = g.getAttribute("data-id");
    const n = topo.nodes.find(x => x.id === id);
    g.addEventListener("mousemove", ev => tipShow(
      "<b>" + n.id + "</b>" + (n.instrumented ? " · enstrümante" : "") +
      "<br>ebeveyn: " + n.parent + " · hop " + n.hop +
      "<br>RSSI " + fmt1(n.rssi) + " dBm · ETX " + fmt2(n.etx) +
      "<br>bant: Band " + n.band + " · PDR %" + fmt1(n.pdr), ev.clientX, ev.clientY));
    g.addEventListener("mouseleave", tipHide);
  });
  const lg = document.getElementById("topo-legend");
  if (tp.mode === "band") lg.innerHTML =
    '<span><span class="sw" style="background:' + BAND_COLOR.L + '"></span>Band L (düşük ERP · %1) </span>' +
    '<span><span class="sw" style="background:' + BAND_COLOR.O + '"></span>Band O (yüksek ERP · %10) — yüksek parazit/zayıf link</span>' +
    '<span><span class="sw" style="border:1px solid #b5bbff;background:none"></span>enstrümante düğüm</span>';
  else if (tp.mode === "rssi") lg.innerHTML =
    '<span><span class="sw" style="background:#34d399"></span>&gt; −60 dBm</span><span><span class="sw" style="background:#a3e635"></span>−60…−70</span>' +
    '<span><span class="sw" style="background:#fbbf24"></span>−70…−80</span><span><span class="sw" style="background:#ffb4ab"></span>&lt; −80 dBm</span>';
  else lg.innerHTML = '<span>renk = hop derinliği (DCU = 0)</span>';
}

export function tickTopology(snap) {
  if (tp.built && Date.now() - tp.lastFetch > 20000 &&
      document.getElementById("tab-topology").classList.contains("on")) refresh();
}

// ---- dugum cekmecesi ---------------------------------------------------------

function buildDrawer() {
  const eld = el("div", { class: "drawer", id: "node-drawer" });
  const close = el("button", { class: "close" }, "✕");
  close.addEventListener("click", () => eld.classList.remove("open"));
  eld.append(close, el("div", { id: "drawer-body" }));
  return { el: eld };
}

async function openDrawer(nid) {
  const body = document.getElementById("drawer-body");
  tp.drawer.el.classList.add("open");
  body.innerHTML = "yükleniyor…";
  const [node] = await api("/api/nodes/" + nid).then(r => [r.node]);
  const hist = await api("/api/history/" + nid + "?hours=2&step_s=60");
  const topo = tp.topo || await api("/api/topology");
  const changes = topo.changes.filter(c => c.node === nid).slice(0, 8);
  const rssiData = hist.map(h => [h.ts, h.rssi]);
  const energyData = hist.map(h => [h.ts, h.energy_mj]);
  body.innerHTML =
    "<h2>" + node.id + "</h2>" +
    '<div style="color:#a5a4b0;font-size:12px;margin-bottom:10px">' +
    (node.instrumented ? '<span class="tag info">enstrümante</span> ' : "") +
    '<span class="tag ' + node.band + '">Band ' + node.band + '</span></div>' +
    "<table class='t' style='margin-bottom:12px'>" +
    row("Ebeveyn", node.parent) + row("Hop", node.hop) +
    row("RSSI", fmt1(node.rssi) + " dBm") + row("SNR", fmt1(node.snr) + " dB") +
    row("ETX", fmt2(node.etx)) + row("PDR", "%" + fmt1(node.pdr)) +
    row("TX hızı", fmt2(node.tx_rate) + " /s") + row("Batarya", fmt2(node.battery) + " V") +
    row("Slot ID", node.slot_id != null ? node.slot_id : "—") +
    "</table>" +
    "<div class='hint'>RSSI (son 2 saat)</div>" + sparkline(rssiData, "#b7c4ff").outerHTML +
    "<div class='hint' style='margin-top:8px'>Enerji mJ (son 2 saat)</div>" + sparkline(energyData, "#34d399").outerHTML +
    "<div class='hint' style='margin-top:12px'>Ebeveyn değişim geçmişi</div>" +
    (changes.length ? changes.map(c =>
      "<div class='ev'><time>" + fmtDT(c.ts) + "</time> " + c.old_parent + " → <b>" + c.new_parent + "</b></div>").join("")
      : "<div class='hint'>kayıt yok</div>");
}
function row(k, v) {
  return "<tr><td style='color:#a5a4b0'>" + k + "</td><td class='mono'>" + v + "</td></tr>";
}
