// Slotframe gorunumu: 3 tasiyici x 57 slot, canli ASN animasyonu
import { state, el, CARRIER_LABEL, BAND_COLOR, tipShow, tipHide } from "../api.js";

const sf = { built: false, root: null, grid: null, info: null,
  lastFrame: -1, selNode: null, asnText: null, seqChips: [], marker: null,
  formula: null, carrierRows: {}, sfLen: 57, ebSlot: 0, shared: [35, 36, 37] };

let SLOT_W = 15, SLOT_H = 30, GAP = 1, ROW_H = SLOT_H + 6;
let GRID_W = 57 * (SLOT_W + GAP) + 4;
let GRID_H = 3 * ROW_H + 8;

// atlama dizisi: once build'de doldurulan sf.hopseq, yoksa API'nin slotframe.hopseq'i
function hopseq() {
  if (sf.hopseq && sf.hopseq.length) return sf.hopseq;
  const s = state.network?.slotframe?.hopseq;
  return (s && s.length) ? s : [0];
}

export const hueOf = (nid) => {
  if (nid === "DCU") return 200;
  let h = 0;
  for (const ch of nid) h = (h * 31 + parseInt(ch, 16)) % 360;
  return h;
};

export function nodeColor(nid) {
  return "hsl(" + hueOf(nid) + ",70%,58%)";
}

function cellTitle(slot, owner, carrier, asn, chanOfs) {
  const c = state.network.carriers[String(carrier)];
  const N = hopseq().length || 7;
  return "slot " + slot + " · " + owner + " · ch" + carrier + " " + c.freq_mhz.toFixed(3) + " MHz (Band " + c.band + ")" +
    " · δ=" + chanOfs + " · ASN mod " + N + "=" + ((asn + chanOfs) % N);
}

function sfMeta() {
  const s = state.network?.slotframe || {};
  return {
    len: s.len || 57,
    eb: s.eb_slot ?? 0,
    shared: s.shared_slots || [35, 36, 37],
    hopseq: s.hopseq || state.network?.slotframe?.hopseq || [],
  };
}

function build(root) {
  root.innerHTML = "";
  const m = sfMeta();
  sf.sfLen = m.len; sf.ebSlot = m.eb; sf.shared = m.shared; sf.hopseq = m.hopseq;
  SLOT_W = Math.max(8, Math.min(15, Math.round((960 - 92) / m.len) - 1));
  ROW_H = SLOT_H + 6;
  GRID_W = m.len * (SLOT_W + GAP) + 4;
  const nRows = Object.keys(state.network?.carriers || {}).length || 3;
  sf.nRows = nRows;
  GRID_H = nRows * ROW_H + 8;

  const head = el("div", { class: "card" });
  const slotMs = state.network?.slotframe?.slot_ms || 17;
  head.append(el("h3", {}, "TSCH Slotframe Yapısı",
    el("small", {}, `${m.len} slot × ${slotMs} ms = ${m.len * slotMs} ms · ${Object.keys(state.network?.carriers || {}).length} taşıyıcı · ${m.hopseq.length} elemanlı kanal atlama dizisi`)));

  const ctl = el("div", { style: "display:flex;gap:14px;align-items:center;flex-wrap:wrap;margin-bottom:8px" });
  const chips = el("div", { class: "chips", id: "sf-chips" });
  ctl.append(el("span", { class: "hint" }, "Düğüm vurgusu:"), chips);
  head.append(ctl);

  const wrap = el("div", { class: "sf-wrap" });
  wrap.append(el("div", { id: "sf-grid" }));
  head.append(wrap);

  head.append(el("div", { class: "legend" },
    el("span", {}, el("span", { class: "sw", style: "background:#b7c4ff" }), "EB (Enhanced Beacon)"),
    el("span", {}, el("span", { class: "sw", style: "background:#fbbf24" }), "paylaşımlı slot (contention)"),
    el("span", {}, el("span", { class: "sw", style: "background:#1b1b1f;border:1px solid #45464f" }), "ayrılmış (boş)"),
    el("span", {}, el("span", { class: "sw", style: "background:#4ade80" }), "veri hücresi (düğüm rengi)"),
    el("span", {}, "hücre rengi = bu ASN'de kullandığı taşıyıcı"),

  ));

  const below = el("div", { class: "grid c2", style: "margin-top:14px" });
  const fcard = el("div", { class: "card" });
  fcard.append(el("h3", {}, "Kanal Atlama Formülü", el("small", {}, "IEEE 802.15.4e TSCH")));
  fcard.append(el("div", { class: "formula" },
    "f = f", el("sub", {}, "base"), " + ((ASN + δ) mod N)   →   ",
    el("span", { class: "hl", id: "sf-formula" }, "—")));
  fcard.append(el("div", { style: "margin-top:10px", id: "sf-seq" }));
  fcard.append(el("div", { class: "hint", style: "margin-top:8px" },
    m.len % m.hopseq.length !== 0
      ? `Slotframe uzunluğu (${m.len}) dizi uzunluğunun (${m.hopseq.length}) katı olmadığından her hücre her slotframe'de bir pozisyon kayar ve ${m.hopseq.length} turda tüm taşıyıcıları gezer — makaledeki süperdöngü (${(m.len * 17 * m.hopseq.length / 1000).toFixed(1)} s).`
      : `Slotframe uzunluğu (${m.len}) dizi uzunluğunun (${m.hopseq.length}) katı; hücreler her slotframe'de aynı taşıyıcıyı kullanır.`));
  const info = el("div", { class: "card" });
  info.append(el("h3", {}, "Hücre Bilgisi", el("small", {}, "hücreye tıklayın")));
  info.append(el("div", { id: "sf-info", class: "mono", style: "font-size:13px;color:#a5a4b0" },
    "bir hücre seçin…"));
  below.append(fcard, info);
  head.append(below);
  root.append(head);

  sf.root = root; sf.info = info.querySelector("#sf-info");
  sf.formula = head.querySelector("#sf-formula");
  sf.seqChips = [];
  sf.asnText = null;
  sf.built = true;

  buildChips(head.querySelector("#sf-chips"));
  buildSeq(head.querySelector("#sf-seq"));
  buildGrid(head.querySelector("#sf-grid"));
  sf.lastFrame = -1;
}

function buildChips(host) {
  host.innerHTML = "";
  const all = el("span", { class: "chip on" }, "tümü");
  all.addEventListener("click", () => { sf.selNode = null; chipsSel(host, all); renderCells(true); });
  host.append(all);
  const instSet = new Set(state.network?.instrumented || []);
  for (const nid of Object.keys(state.cellmap || {}).sort()) {
    const c = el("span", { class: "chip" + (instSet.has(nid) ? " inst" : "") }, nid);
    c.addEventListener("click", () => { sf.selNode = nid; chipsSel(host, c); renderCells(true); });
    host.append(c);
  }
}
function chipsSel(host, sel) {
  host.querySelectorAll(".chip").forEach(x => x.classList.remove("on"));
  sel.classList.add("on");
}

function buildSeq(host) {
  host.innerHTML = "";
  host.append(el("div", { class: "hint", style: "margin-bottom:5px" }, "Kanal atlama dizisi (HOPSEQ):"));
  const row = el("div", { class: "chips" });
  const seq = hopseq();
  seq.forEach((ch, i) => {
    const c = state.network.carriers[String(ch)];
    const chip = el("span", { class: "chip" },
      "ch" + ch + " · " + c.freq_mhz.toFixed(3));
    chip.style.borderColor = BAND_COLOR[c.band];
    sf.seqChips.push(chip);
    row.append(chip);
  });
  host.append(row);
}

function buildGrid(host) {
  host.innerHTML = "";
  const svgNS = "http://www.w3.org/2000/svg";
  const m = sfMeta();
  const W = GRID_W + 92, H = GRID_H + 26;
  const svg = document.createElementNS(svgNS, "svg");
  svg.setAttribute("viewBox", "0 0 " + W + " " + H);
  svg.setAttribute("width", "100%");
  // tasiyici satirlari API'den (carrier id -> satir sirasi)
  const cIds = Object.keys(state.network.carriers).map(Number).sort((a, b) => a - b);
  const rows = cIds.map(cid => {
    const c = state.network.carriers[String(cid)];
    return [cid, `ch${cid} · ${c.freq_mhz.toFixed(3)} MHz · Band ${c.band} %${(c.duty_limit * 100).toFixed(0)}`];
  });
  sf.cells = [];
  rows.forEach((r, ri) => {
    const y = 20 + ri * ROW_H;
    const lbl = document.createElementNS(svgNS, "text");
    lbl.setAttribute("x", 0); lbl.setAttribute("y", y + SLOT_H / 2 + 4);
    lbl.setAttribute("fill", BAND_COLOR[r[0] === 0 || state.network.carriers[String(r[0])].band === "O" ? "O" : "L"]);
    lbl.setAttribute("font-size", 10);
    lbl.textContent = r[1];
    svg.append(lbl);
    sf.carrierRows[r[0]] = y;
  });
  // slot numaralari
  const step = Math.max(2, Math.ceil(sf.sfLen / 16) * 2);
  for (let s = 0; s < sf.sfLen; s += step) {
    const t = document.createElementNS(svgNS, "text");
    t.setAttribute("x", 92 + s * (SLOT_W + GAP) + SLOT_W / 2);
    t.setAttribute("y", 12); t.setAttribute("fill", "#8f909a");
    t.setAttribute("font-size", 9); t.setAttribute("text-anchor", "middle");
    t.textContent = s;
    svg.append(t);
  }
  const cellAt = (s, c) => {
    const g = document.createElementNS(svgNS, "rect");
    g.setAttribute("class", "slotcell");
    g.setAttribute("x", 92 + s * (SLOT_W + GAP));
    g.setAttribute("y", sf.carrierRows[c]);
    g.setAttribute("width", SLOT_W); g.setAttribute("height", SLOT_H);
    g.setAttribute("rx", 3);
    svg.append(g);
    return g;
  };
  const cOrder = Object.keys(state.network.carriers).map(Number).sort((a, b) => a - b);
  for (let s = 0; s < sf.sfLen; s++) {
    for (const c of cOrder) {
      sf.cells.push({ s, c, el: cellAt(s, c) });
    }
  }
  // su an isareti
  sf.marker = document.createElementNS(svgNS, "rect");
  sf.marker.setAttribute("class", "sf-nowcol");
  sf.marker.setAttribute("width", SLOT_W + 2);
  sf.marker.setAttribute("height", (sf.nRows || 3) * ROW_H);
  sf.marker.setAttribute("rx", 3);
  sf.marker.setAttribute("fill", "none");
  sf.marker.setAttribute("stroke", "#ffffffcc");
  sf.marker.setAttribute("stroke-width", 1.6);
  svg.append(sf.marker);
  host.append(svg);
}

function renderCells(force) {
  if (!state.network || !state.snap) return;
  const asn = state.snap.asn;
  const frame = Math.floor(asn / sf.sfLen);
  if (!force && frame === sf.lastFrame) return;
  sf.lastFrame = frame;
  const cm = state.cellmap || {};
  const SEQ = hopseq();
  const N = SEQ.length;
  const slotOwners = {};
  for (const [nid, cc] of Object.entries(cm)) slotOwners[cc.slot] = { nid, ofs: cc.chan_ofs };
  const ebCarrier = SEQ[(asn + sf.ebSlot) % N];
  const sel = sf.selNode;
  for (const cell of sf.cells) {
    const { s, c, el: rect } = cell;
    let fill = "#1b1b1f", opacity = "1", stroke = null, w = null;
    if (s === sf.ebSlot) {
      if (c === ebCarrier) { fill = "#b7c4ff"; stroke = "#f1b3e6"; w = 1.4; }
      else fill = "#b7c4ff22";
    } else if (sf.shared.includes(s)) {
      fill = "#fbbf2444"; stroke = "#fbbf2466"; w = 0.7;
    } else if (slotOwners[s]) {
      const { nid, ofs } = slotOwners[s];
      const carr = SEQ[(asn + ofs) % N];
      if (carr === c) {
        const dim = sel && nid !== sel;
        fill = nodeColor(nid);
        opacity = dim ? "0.18" : "0.95";
        stroke = dim ? null : "#ffffff88"; w = dim ? null : 1.1;
      }
    }
    rect.setAttribute("fill", fill);
    rect.setAttribute("opacity", opacity);
    if (stroke) { rect.setAttribute("stroke", stroke); rect.setAttribute("stroke-width", w); }
    else { rect.removeAttribute("stroke"); }
    // tiklama davranisi
    const owner = slotOwners[s] ? slotOwners[s].nid : null;
    rect.onclick = (ev) => {
      let html;
      if (s === sf.ebSlot) {
        html = "<b>EB slotu (" + s + ")</b><br>Enhanced Beacon · senkronizasyon<br>taşıyıcı: ch" + ebCarrier + " (ASN mod " + N + ")";
      } else if (sf.shared.includes(s)) {
        html = "<b>Paylaşımlı slot (" + s + ")</b><br>contention erişim · CSMA/CA<br>katılma (join) trafiği";
      } else if (owner) {
        const cc = cm[owner];
        const carr = SEQ[(asn + cc.chan_ofs) % N];
        const cfg = state.network.carriers[String(carr)];
        html = "<b>Veri hücresi (slot " + s + ")</b><br>sahibi: " + owner +
          "<br>δ (kanal ofseti): " + cc.chan_ofs +
          "<br>bu ASN'de taşıyıcı: ch" + carr + " · " + cfg.freq_mhz.toFixed(3) + " MHz (Band " + cfg.band + ")" +
          "<br>formula: (ASN " + asn.toLocaleString("tr-TR") + " + " + cc.chan_ofs + ") mod " + N + " = " + ((asn + cc.chan_ofs) % N);
      } else {
        html = "<b>Ayrılmış slot (" + s + ")</b><br>boş · MSF tarafından dinamik ayrılabilir";
      }
      sf.info.innerHTML = html;
      tipShow(html, ev.clientX, ev.clientY);
    };
    rect.onmousemove = (ev) => { if (owner || s === sf.ebSlot) tipShow(cellTitle(s, owner || "EB", s === sf.ebSlot ? ebCarrier : SEQ[(asn + (cm[owner] || { chan_ofs: 0 }).chan_ofs) % N], asn, cm[owner] ? cm[owner].chan_ofs : 0), ev.clientX, ev.clientY); };
    rect.onmouseleave = () => tipHide();
  }
  // dizi vurgusu
  const idx = asn % N;
  sf.seqChips.forEach((chip, i) => {
    chip.style.background = i === idx ? "rgba(183,196,255,.25)" : "";
    chip.style.color = i === idx ? "#fff" : "";
  });
}

export function renderSlotframe(root) {
  sf.root = root;
  if (!state.network) { root.innerHTML = ""; root.append(el("div", { class: "hint" }, "ağ verisi yükleniyor…")); return; }
  if (!sf.built) build(root);
  renderCells(true);
}

export function tickSlotframe(snap) {
  if (!document.getElementById("tab-slotframe").classList.contains("on")) return;
  state.snap = snap;
  if (!sf.built) {
    if (!state.network || !sf.root) return;  // ag verisi henuz gelmedi
    build(sf.root);                          // gec gelen veriyle kur
  }
  renderCells(false);
  // canli kolon isareti + ASN
  const asn = snap.asn;
  const N = hopseq().length;
  const slot = asn % sf.sfLen;
  const x = 92 + slot * (SLOT_W + GAP) - 1;
  const rowY = sf.carrierRows[snap.carrier];
  if (rowY == null) return;
  sf.marker.setAttribute("x", x);
  sf.marker.setAttribute("y", rowY - 3);
  sf.marker.setAttribute("height", SLOT_H + 6);
  const f = sf.formula;
  if (f) {
    const carr = snap.carrier;
    const cfg = state.network.carriers[String(carr)];
    f.textContent = "ch" + carr + " · " + cfg.freq_mhz.toFixed(3) + " MHz   (ASN " + asn.toLocaleString("tr-TR") + " mod " + N + " = " + (asn % N) + ")";
  }
}
