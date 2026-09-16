// Enerji Profil Panosu: dugum basina enerji, batarya, TX, gorev dongusu
import { api, el, BAND_COLOR, state } from "../api.js";
import { lineChart, hmFmt, gauge } from "../charts.js";

const en = { built: false, root: null, lastFetch: 0 };
const COLS = ["#b7c4ff", "#34d399", "#fb923c", "#f472b6", "#a78bfa"];

export function renderEnergy(root) {
  en.root = root;
  if (!en.built) {
    root.innerHTML = "";
    const head = el("div", { class: "grid c4" });
    head.append(el("div", { class: "card", id: "en-gL" }));
    head.append(el("div", { class: "card", id: "en-gO" }));
    head.append(el("div", { class: "card", id: "en-gBat" }));
    head.append(el("div", { class: "card", id: "en-gTx" }));
    root.append(head);
    const c1 = el("div", { class: "card", style: "margin-top:14px" });
    c1.append(el("h3", {}, "Ağ Toplamı Enerji", el("small", {}, "tüm düğümler · 5 dk çözünürlük")));
    c1.append(el("div", { id: "en-net" }));
    const c2 = el("div", { class: "card", style: "margin-top:14px" });
    c2.append(el("h3", {}, "Düğüm Karşılaştırma (enstrümante 5)", el("small", {}, "son 24 saat")));
    c2.append(el("div", { id: "en-nodes" }));
    const c3 = el("div", { class: "card", style: "margin-top:14px" });
    c3.append(el("h3", {}, "Görev Döngüsü Bütçe Takibi", el("small", {}, "p90 · 30 sn pencere · ETSI tavanları")));
    c3.append(el("div", { id: "en-duty" }));
    root.append(c1, c2, c3);
    en.built = true;
  }
  refresh();
}

async function refresh() {
  if (!document.getElementById("tab-energy").classList.contains("on")) return;
  en.lastFetch = Date.now();
  const inst = state.network?.instrumented || ["7402", "71F4", "71D8", "71C0", "7181"];
  const [data, duties] = await Promise.all([
    api("/api/energy"),
    Promise.all(inst.map(id =>
      api("/api/duty/" + id).then(d => [id, d]))),
  ]);

  // gaugeler (son degerler)
  const ids = Object.keys(data.nodes);
  const last = id => { const s = data.nodes[id]; return s.length ? s[s.length - 1] : null; };
  const dutySnap = await api("/api/network").then(n => n.duty);
  const pick = b => {
    for (const id of inst) {
      const v = dutySnap[id + "_" + b];
      if (v) return v;
    }
    return null;
  };
  const vL = pick("L"), vO = pick("O");
  document.getElementById("en-gL").innerHTML = "<h3>Band L Bütçe</h3>";
  document.getElementById("en-gL").append(gauge(vL ? vL.used : 0, 100, "en yüksek düğüm / %1", "#34d399", vL ? "p90 " + vL.p90.toFixed(2) + "%" : ""));
  document.getElementById("en-gO").innerHTML = "<h3>Band O Bütçe</h3>";
  document.getElementById("en-gO").append(gauge(vO ? vO.used : 0, 100, "en yüksek düğüm / %10", "#fb923c", vO ? "p90 " + vO.p90.toFixed(2) + "%" : ""));
  const bats = ids.map(id => [id, last(id)]);
  const minB = bats.reduce((a, x) => (x[1] && x[1].battery < a[1] ? x : a), bats[0]);
  document.getElementById("en-gBat").innerHTML = "<h3>En Düşük Batarya</h3><div class='num mono' style='font-size:24px'>" +
    (minB[1] ? minB[1].battery.toFixed(2) + " V" : "—") + "</div><div class='lbl' style='color:#a5a4b0'>" + minB[0] + " · değişim aralığı 3.05–3.66 V</div>";
  const txs = ids.map(id => [id, last(id)]);
  document.getElementById("en-gTx").innerHTML = "<h3>TX Hızı (anlık)</h3><div class='num mono' style='font-size:24px'>" +
    fmt2(sum(txs.map(x => x[1] ? x[1].tx_rate : 0))) + " /s</div><div class='lbl' style='color:#a5a4b0'>ağ toplamı · tüm tekrarlar dahil</div>";

  // ag toplami
  document.getElementById("en-net").innerHTML = "";
  document.getElementById("en-net").append(lineChart(
    [{ name: "ağ toplam enerji (mJ / 30 sn)", color: "#b7c4ff", data: data.network.map(r => [r.ts, r.e]), area: true }],
    { height: 210, xFmt: hmFmt, yFmt: v => v.toFixed(0) }));

  // dugum karsilastirma (enerji)
  const seriesE = ids.map((id, i) => ({
    name: id, color: COLS[i % 5], data: data.nodes[id].map(r => [r.ts, r.energy_mj]) }));
  const seriesB = ids.map((id, i) => ({
    name: id, color: COLS[i % 5], data: data.nodes[id].map(r => [r.ts, r.battery]) }));
  const box = document.getElementById("en-nodes");
  box.innerHTML = "";
  box.append(lineChart(seriesE, { height: 220, xFmt: hmFmt, yFmt: v => v.toFixed(0) }));
  box.append(el("div", { class: "hint", style: "margin:8px 0 4px" }, "Batarya gerilimi (V)"));
  box.append(lineChart(seriesB, { height: 180, xFmt: hmFmt, yFmt: v => v.toFixed(2) }));

  // gorev dongusu: Band L p90 %1 limiti + Band O p90 %10 (limitler API'den)
  const lims = (duties[0] && duties[0][1].limits) || { L: 1, O: 10 };
  const dutyL = [], dutyO = [];
  for (const [id, d] of duties) {
    for (const r of d.L) dutyL.push([r.ts, r.p90, id]);
    for (const r of d.O) dutyO.push([r.ts, r.p90, id]);
  }
  const agg = (rows) => {
    const m = {};
    for (const [b, v] of rows) (m[b] = m[b] || []).push(v);
    return Object.entries(m).map(([b, vs]) => [+b, Math.max(...vs)]).sort((a, b) => a[0] - b[0]);
  };
  const dbox = document.getElementById("en-duty");
  dbox.innerHTML = "";
  dbox.append(el("div", { class: "hint" }, "Band L — p90 (tavan %1):"));
  dbox.append(lineChart([{ name: "en yüksek p90 (" + inst.length + " düğüm)", color: BAND_COLOR.L, data: agg(dutyL), area: true }],
    { height: 180, xFmt: hmFmt, yFmt: v => v.toFixed(2), yMax: lims.L * 1.4,
      limitLines: [{ y: lims.L, color: "#ffb4ab", label: "%" + lims.L + " ETSI tavanı" }] }));
  dbox.append(el("div", { class: "hint", style: "margin:8px 0 4px" }, "Band O — p90 (tavan %10):"));
  dbox.append(lineChart([{ name: "en yüksek p90 (" + inst.length + " düğüm)", color: BAND_COLOR.O, data: agg(dutyO), area: true }],
    { height: 180, xFmt: hmFmt, yFmt: v => v.toFixed(2), yMax: lims.O * 1.2,
      limitLines: [{ y: lims.O, color: "#ffb4ab", label: "%" + lims.O + " ETSI tavanı" }] }));
  dbox.append(el("div", { class: "hint" },
    "Not: makalede 7402 ve 71D8 Band L tavanının %99-100'ünde, 71C0 ise %102 ile üzerinde ölçülmüştü — simülasyon bu davranışı korur."));
}

const fmt2 = x => (x == null ? "—" : Number(x).toFixed(2));
const sum = a => a.reduce((x, y) => x + y, 0);
// sekme gorunurken 30 sn'de bir tazele
export function tickEnergy() {
  if (en.built && Date.now() - en.lastFetch > 30000 &&
      document.getElementById("tab-energy").classList.contains("on") && !document.hidden) refresh();
}
