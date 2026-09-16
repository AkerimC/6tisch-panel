// Dinamik Konfigurasyon Paneli: CoAP PUT ile cihaz parametresi guncelleme
import { api, post, el, fmtDT } from "../api.js";

const cf = { built: false, root: null };

export function renderConfig(root) {
  if (cf.built) { loadLog(); return; }
  cf.root = root;
  root.innerHTML = "";
  const g = el("div", { class: "grid c2" });

  const form = el("div", { class: "card" });
  form.append(el("h3", {}, "Cihaz Parametreleri", el("small", {}, "ağ yöneticisi paneli")));

  const nodeSel = el("select", { id: "cf-node" });
  api("/api/nodes").then(nodes => {
    let defSet = false;
    for (const n of nodes.sort((a, b) => a.id.localeCompare(b.id))) {
      const o = el("option", { value: n.id }, n.id + (n.instrumented ? "  ◆" : ""));
      if (!defSet && n.instrumented) { o.selected = true; defSet = true; }
      nodeSel.append(o);
    }
  });

  const power = el("input", { type: "range", min: "-10", max: "27", step: "1", value: "14", id: "cf-power" });
  const powerV = el("span", { class: "mono", style: "color:#b7c4ff" }, "+14 dBm");
  power.addEventListener("input", () => {
    powerV.textContent = (power.value > 0 ? "+" : "") + power.value + " dBm";
  });

  const erp = el("select", { id: "cf-erp" });
  erp.append(el("option", { value: "" }, "— değiştirme (mevcut sınıf)"));
  [["10 mW — düşük ERP bantları (868.3)", "10"], ["14–17 mW — orta ERP", "14"],
   ["25 mW — Band L tavanı", "25"], ["500 mW — Band O tavanı (+27 dBm)", "500"]].forEach(([l, v]) => {
    erp.append(el("option", { value: v }, l));
  });

  const eb = el("input", { type: "range", min: "1", max: "19", step: "1", value: "1", id: "cf-eb" });
  const ebV = el("span", { class: "mono", style: "color:#b7c4ff" }, "her 1 slotframe");
  eb.addEventListener("input", () => { ebV.textContent = "her " + eb.value + " slotframe"; });

  const thr = el("input", { type: "range", min: "-95", max: "-60", step: "1", value: "-85", id: "cf-thr" });
  const thrV = el("span", { class: "mono", style: "color:#b7c4ff" }, "−85 dBm");
  thr.addEventListener("input", () => { thrV.textContent = thr.value + " dBm"; });

  const upd = el("select", { id: "cf-upd" });
  [["15 saniye", "15"], ["30 saniye", "30"], ["60 saniye", "60"], ["120 saniye", "120"]].forEach(([l, v]) => {
    upd.append(el("option", { value: v }, l));
  });

  form.append(
    el("label", { class: "f" }, "Hedef cihaz"), nodeSel,
    el("label", { class: "f" }, "İletim gücü (TX power)"), power, el("div", { style: "text-align:right;margin-top:2px" }, powerV),
    el("label", { class: "f" }, "ERP sınır sınıfı"), erp,
    el("label", { class: "f" }, "EB (Enhanced Beacon) periyodu"), eb, el("div", { style: "text-align:right;margin-top:2px" }, ebV),
    el("label", { class: "f" }, "Komşuluk tablosu RSSI eşiği (zayıf link sınırı)"), thr, el("div", { style: "text-align:right;margin-top:2px" }, thrV),
    el("label", { class: "f" }, "Slot/ölçüm güncelleme sıklığı"), upd,
    el("div", { style: "margin-top:16px;display:flex;gap:10px;align-items:center" },
      el("button", { class: "btn", id: "cf-send" }, "CoAP PUT Gönder"),
      el("span", { class: "hint" }, "cihaza coap://[…]/a/cfg hedefine PUT olarak iletilir")));

  const result = el("div", { class: "card" });
  result.append(el("h3", {}, "İşlem Sonucu", el("small", {}, "CoAP işlem kaydı")));
  result.append(el("div", { id: "cf-result" }, el("div", { class: "hint" }, "henüz işlem yok")));
  g.append(form, result);
  root.append(g);

  const logCard = el("div", { class: "card", style: "margin-top:14px" });
  logCard.append(el("h3", {}, "Konfigürasyon Günlüğü", el("small", {}, "uygulanan tüm değişiklikler")));
  logCard.append(el("div", { id: "cf-log" }));
  root.append(logCard);

  form.querySelector("#cf-send").addEventListener("click", send);
  cf.built = true;
  loadLog();
}

async function send() {
  const node = document.getElementById("cf-node").value;
  const params = {
    tx_power_dbm: +document.getElementById("cf-power").value,
    eb_period: +document.getElementById("cf-eb").value,
    rssi_threshold: +document.getElementById("cf-thr").value,
    slot_update_s: +document.getElementById("cf-upd").value,
  };
  const erpV = document.getElementById("cf-erp").value;
  if (erpV !== "") params.erp_class_mw = +erpV;  // secilmezse mevcut sinifa dokunma
  const box = document.getElementById("cf-result");
  box.innerHTML = "gönderiliyor…";
  try {
    const r = await post("/api/config", { node_id: node, ...params });
    box.innerHTML = "";
    box.append(el("div", {},
      el("div", {}, "Durum: ", el("span", { class: "tag info" }, r.status)),
      el("div", { class: "hint", style: "margin-top:6px" }, "Hedef: "),
      el("div", { class: "mono", style: "font-size:12px;color:#b7c4ff" }, r.target),
      el("div", { class: "hint", style: "margin-top:6px" }, "Payload: "),
      el("pre", { class: "mono", style: "font-size:11.5px;background:#121216;padding:9px;border-radius:8px;overflow:auto" },
        JSON.stringify(params, null, 2)),
      el("div", { class: "hint", style: "margin-top:6px" },
        "✓ Cihaz onayı alındı (2.04 Changed) — simülasyon motoru parametreleri anında uyguladı; RSSI/ETX değişimini izleyin.")));
    loadLog();
  } catch (e) {
    box.innerHTML = "";
    box.append(el("div", { class: "tag bad" }, "hata: " + e.message));
  }
}

async function loadLog() {
  const log = document.getElementById("cf-log");
  if (!log) return;
  const rows = await api("/api/configs");
  const tb = el("table", { class: "t" });
  tb.append(el("tr", {}, el("th", {}, "Zaman"), el("th", {}, "Düğüm"), el("th", {}, "Parametreler"), el("th", {}, "Sonuç"), el("th", {}, "Hedef")));
  for (const r of rows.slice(0, 15)) {
    tb.append(el("tr", {},
      el("td", { class: "mono" }, fmtDT(r.ts)),
      el("td", { class: "mono" }, r.node),
      el("td", { class: "mono", style: "font-size:11.5px" }, Object.entries(r.params).map(([k, v]) => k + "=" + v).join(" · ")),
      el("td", {}, el("span", { class: "tag info" }, r.status)),
      el("td", { class: "mono", style: "font-size:11px;color:#8f909a" }, r.target)));
  }
  log.innerHTML = "";
  log.append(rows.length ? tb : el("div", { class: "hint" }, "henüz konfigürasyon gönderilmedi"));
}
