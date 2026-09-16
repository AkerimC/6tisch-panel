// Slot-Frekans Zamanlamasi paneli: dugum x zaman isi haritasi + slot kaymasi
import { api, el, fmtDT, BAND_COLOR, tipShow, tipHide, state } from "../api.js";
import { lineChart, hmFmt } from "../charts.js";

const sf = { built: false, root: null, host: null, nodes: [], hours: 8,
  sel: null, lastFetch: 0 };

export function renderSlotfreq(root) {
  if (sf.built) { sf.root = root; refresh(); return; }
  sf.root = root;
  if (!sf.sel) {
    // enstrumante dugumleri API'den al, yoksa varsayilan
    sf.sel = new Set(state.network?.instrumented || ["7402", "71F4", "71D8", "71C0", "7181"]);
  }
  root.innerHTML = "";
  const card = el("div", { class: "card" });
  card.append(el("h3", {}, "Slot-Frekans Zamanlaması",
    el("small", {}, "hangi düğüm hangi slotta hangi alt bantla haberleşti")));

  const ctl = el("div", { style: "display:flex;gap:16px;flex-wrap:wrap;align-items:center;margin-bottom:10px" });
  const nodeChips = el("div", { class: "chips" });
  for (const nid of [...sf.sel]) {
    const c = el("span", { class: "chip on" }, nid);
    c.addEventListener("click", () => {
      if (sf.sel.has(nid) && sf.sel.size > 1) sf.sel.delete(nid); else sf.sel.add(nid);
      c.classList.toggle("on", sf.sel.has(nid));
      refresh();
    });
    nodeChips.append(c);
  }
  const rangeChips = el("div", { class: "chips" });
  [[2, "2 saat"], [8, "8 saat"], [24, "24 saat"]].forEach(([h, lbl]) => {
    const c = el("span", { class: "chip" + (h === sf.hours ? " on" : "") }, lbl);
    c.addEventListener("click", () => {
      sf.hours = h;
      rangeChips.querySelectorAll(".chip").forEach(x => x.classList.remove("on"));
      c.classList.add("on");
      refresh();
    });
    rangeChips.append(c);
  });
  ctl.append(el("span", { class: "hint" }, "Düğümler:"), nodeChips,
             el("span", { class: "hint" }, "Aralık:"), rangeChips);
  card.append(ctl);
  sf.host = el("div", {});
  card.append(sf.host);
  card.append(el("div", { class: "legend" },
    el("span", {}, el("span", { class: "sw", style: "background:" + BAND_COLOR.L }), "yalnız Band L (kısıtlı, %1)"),
    el("span", {}, el("span", { class: "sw", style: "background:" + BAND_COLOR.O }), "yalnız Band O (geniş, %10)"),
    el("span", {}, el("span", { class: "sw", style: "background:#fbbf24" }), "karışık bant kullanımı"),
    el("span", {}, el("span", { class: "sw", style: "background:#0d0e12" }), "kayıt yok")));
  root.append(card);

  const summary = el("div", { class: "card", style: "margin-top:14px" });
  summary.append(el("h3", {}, "Slot Analizi", el("small", {}, "çakışma · kayma · dağılım")));
  summary.append(el("div", { id: "sf-summary" }));
  root.append(summary);

  sf.built = true;
  refresh();
}

async function refresh() {
  if (!document.getElementById("tab-slotfreq").classList.contains("on")) return;
  sf.lastFetch = Date.now();
  const hours = sf.hours;
  const rows = await api("/api/slotlog?hours=" + hours);
  const nodes = [...sf.sel].sort();
  const t1 = Date.now() / 1000, t0 = t1 - hours * 3600;
  const NBUCK = 90;
  const bd = (t1 - t0) / NBUCK;
  const bi = ts => Math.min(NBUCK - 1, Math.floor((ts - t0) / bd));

  const buckets = {};  // node -> bucket -> {L,O,slots:[]}
  for (const n of nodes) buckets[n] = {};
  for (const r of rows) {
    if (!buckets[r.node]) continue;
    const b = buckets[r.node][bi(r.ts)] || (buckets[r.node][bi(r.ts)] = { L: 0, O: 0, slots: [] });
    b[r.band]++; b.slots.push(r.slot);
  }

  const W = 900, LH = 26, padL = 46, top = 16;
  const H = top + nodes.length * LH + 18;
  let svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%">';
  for (let i = 0; i <= 6; i++) {
    const ts = t0 + (t1 - t0) * i / 6;
    const x = padL + (W - padL - 8) * i / 6;
    svg += '<line x1="' + x + '" y1="' + top + '" x2="' + x + '" y2="' + (H - 16) + '" stroke="#35353b"/>';
    svg += '<text x="' + x + '" y="' + (H - 4) + '" fill="#8f909a" font-size="10" text-anchor="middle">' + hmFmt(ts) + '</text>';
  }
  const cw = (W - padL - 8) / NBUCK;
  nodes.forEach((n, ni) => {
    const y = top + ni * LH;
    svg += '<text x="0" y="' + (y + LH / 2 + 4) + '" fill="#a5a4b0" font-size="11" font-family="ui-monospace,monospace">' + n + '</text>';
    for (let b = 0; b < NBUCK; b++) {
      const d = buckets[n][b];
      let col = "#0d0e12", tip = n + " · " + fmtDT(t0 + b * bd) + "<br>kayıt yok";
      if (d) {
        const tot = d.L + d.O;
        if (d.L && !d.O) { col = BAND_COLOR.L; tip = n + " · " + fmtDT(t0 + b * bd) + "<br>yalnız Band L · " + tot + " iletim"; }
        else if (d.O && !d.L) { col = BAND_COLOR.O; tip = n + " · " + fmtDT(t0 + b * bd) + "<br>yalnız Band O · " + tot + " iletim"; }
        else {
          const fO = d.O / tot;
          col = fO > 0.5 ? "#fbbf24" : "#a3e635";
          tip = n + " · " + fmtDT(t0 + b * bd) + "<br>karışık: L=" + d.L + " O=" + d.O;
        }
      }
      const x = padL + b * cw;
      svg += '<rect class="sfq-cell" data-i="' + ni + '" data-b="' + b + '" x="' + x + '" y="' + (y + 3) + '" width="' + Math.max(1, cw - 1.2) + '" height="' + (LH - 6) + '" rx="2" fill="' + col + '"/>';
    }
  });
  svg += "</svg>";
  sf.host.innerHTML = svg;
  sf.host.querySelectorAll(".sfq-cell").forEach(r => {
    const ni = +r.getAttribute("data-i"), b = +r.getAttribute("data-b");
    const n = nodes[ni], d = buckets[n] && buckets[n][b];
    r._tip = d ? (n + " · " + fmtDT(t0 + b * bd) + "<br>Band L: " + d.L + " · Band O: " + d.O + "<br>slotlar: " +
      [...new Set(d.slots)].slice(0, 6).join(", ") + (d.slots.length > 6 ? "…" : "")) : (n + " · kayıt yok");
    r.addEventListener("mousemove", ev => { r.setAttribute("stroke", "#fff"); tipShow(r._tip, ev.clientX, ev.clientY); });
    r.addEventListener("mouseleave", () => { r.removeAttribute("stroke"); tipHide(); });
  });

  // slot kaymasi: her kovada slot std'si
  const driftSeries = nodes.map((n, i) => {
    const data = [];
    for (let b = 0; b < NBUCK; b++) {
      const d = buckets[n][b];
      if (d && d.slots.length > 2) {
        const m = d.slots.reduce((a, x) => a + x, 0) / d.slots.length;
        const std = Math.sqrt(d.slots.reduce((a, x) => a + (x - m) * (x - m), 0) / d.slots.length);
        data.push([t0 + (b + 0.5) * bd, std]);
      }
    }
    return { name: n, color: ["#b7c4ff", "#34d399", "#fb923c", "#f472b6", "#a78bfa"][i % 5], data };
  });
  const sum = document.getElementById("sf-summary");
  sum.innerHTML = "";
  sum.append(lineChart(driftSeries, { height: 200, yFmt: v => v.toFixed(1), xFmt: hmFmt })
    , el("div", { class: "hint", style: "margin-top:6px" },
      "Slot kayması (std. sapma, slot cinsinden): slotframe yapısındaki zaman kaymalarını gösterir. Düşük değer = deterministik zamanlama korunuyor."));

  // cakisma sayimi: ayni kovada ayni slotu kullanan iki dugum
  let conflicts = 0, totalTx = 0, totL = 0, totO = 0;
  const slotUse = {};
  for (const r of rows) {
    totalTx++; if (r.band === "L") totL++; else totO++;
    const k = bi(r.ts) + ":" + r.slot;
    slotUse[k] = (slotUse[k] || 0) + 1;
  }
  for (const k in slotUse) if (slotUse[k] > 1) conflicts += slotUse[k] - 1;
  const stats = el("div", { class: "grid c4", style: "margin-top:10px" });
  const mk = (v, l, c) => {
    const d = el("div", { class: "card kpi", style: "padding:10px 12px" });
    const n = el("div", { class: "num", style: "font-size:20px" }, v);
    if (c) n.style.color = c;
    d.append(n, el("div", { class: "lbl" }, l));
    return d;
  };
  stats.append(
    mk(totalTx.toLocaleString("tr-TR"), "slot kullanım kaydı"),
    mk("%" + Math.round(100 * totL / Math.max(1, totalTx)), "Band L payı", BAND_COLOR.L),
    mk("%" + Math.round(100 * totO / Math.max(1, totalTx)), "Band O payı", BAND_COLOR.O),
    mk(String(conflicts), "potansiyel çakışma", conflicts ? "var(--warn)" : "var(--ok)"));
  sum.append(stats);
}

export function tickSlotfreq(snap) {
  if (sf.built && Date.now() - sf.lastFetch > 30000 &&
      document.getElementById("tab-slotfreq").classList.contains("on")) refresh();
}
