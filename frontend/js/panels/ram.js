import { api, el, fmtDT } from "../api.js";

const PAGE_SIZE = 100;
const HOURS = [1, 6, 24, 72, 168, 720];
const MODULE_NAMES = { 0x55: "CORE_NET_MAC" };
const ERROR_NAMES = {
  0x31: "TX başarılı",
  0x32: "TX başarısız — ACK alınmadı",
  0x33: "TX çakışması",
  0x34: "TX ertelendi",
  0x35: "Kritik TX hatası",
  0x36: "TX hatası",
  0x37: "Paket düşürüldü",
  0x38: "Paylaşımlı hücrede paket düşürüldü",
};

const ram = {
  built: false, lastFetch: 0, selectedNode: "", selectedModule: "",
  hours: 24, offset: 0, total: 0, loading: false, refreshQueued: false,
};

export function renderRam(root) {
  if (!ram.built) build(root);
  refresh().catch(showError);
}

function build(root) {
  root.innerHTML = "";
  const overview = el("div", { class: "grid c3", id: "ram-kpis" });
  const controls = el("div", { class: "card", style: "margin-top:14px" });
  controls.append(el("h3", {}, "4eMAC RAM kayıtları",
    el("small", {}, "module ID · hata kodu · cihaz çalışma zamanı")));

  const filters = el("div", { class: "grid c4" });
  const timeSelect = el("select", { id: "ram-hours" });
  HOURS.forEach(hours => timeSelect.append(el("option", { value: hours },
    hours < 24 ? `Son ${hours} saat` : hours === 24 ? "Son 24 saat" : `Son ${hours / 24} gün`)));
  timeSelect.value = String(ram.hours);
  timeSelect.addEventListener("change", () => {
    ram.hours = Number(timeSelect.value);
    ram.offset = 0;
    refresh().catch(showError);
  });

  const nodeSelect = el("select", { id: "ram-node" });
  nodeSelect.append(el("option", { value: "" }, "Tüm düğümler"));
  nodeSelect.addEventListener("change", () => {
    ram.selectedNode = nodeSelect.value;
    ram.offset = 0;
    refresh().catch(showError);
  });

  const moduleSelect = el("select", { id: "ram-module" });
  moduleSelect.append(el("option", { value: "" }, "Tüm modüller"));
  moduleSelect.addEventListener("change", () => {
    ram.selectedModule = moduleSelect.value;
    ram.offset = 0;
    refresh().catch(showError);
  });

  filters.append(
    filter("Zaman aralığı", timeSelect),
    filter("Düğüm", nodeSelect),
    filter("Modül", moduleSelect),
  );
  controls.append(filters);

  const tableCard = el("div", { class: "card", style: "margin-top:14px" });
  tableCard.append(el("h3", {}, "RAM log kayıtları",
    el("small", {}, "Contiki RAMLOG type 0x04 paketlerinden çözüldü")));
  tableCard.append(el("div", { id: "ram-table" }));
  const pager = el("div", { id: "ram-pager", style: "display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:14px" });
  const pageLabel = el("span", { id: "ram-page-label", class: "hint" });
  const prev = el("button", { class: "btn ghost", id: "ram-prev", type: "button" }, "← Önceki");
  const next = el("button", { class: "btn ghost", id: "ram-next", type: "button" }, "Sonraki →");
  prev.addEventListener("click", () => {
    ram.offset = Math.max(0, ram.offset - PAGE_SIZE);
    refresh().catch(showError);
  });
  next.addEventListener("click", () => {
    if (ram.offset + PAGE_SIZE < ram.total) {
      ram.offset += PAGE_SIZE;
      refresh().catch(showError);
    }
  });
  pager.append(prev, pageLabel, next);
  tableCard.append(pager);
  root.append(overview, controls, tableCard);
  ram.built = true;
}

function filter(label, control) {
  return el("label", { class: "f" }, label, control);
}

async function refresh() {
  if (!ram.built || !document.getElementById("tab-ram").classList.contains("on")) return;
  if (ram.loading) {
    ram.refreshQueued = true;
    return;
  }
  ram.loading = true;
  ram.lastFetch = Date.now();
  const params = new URLSearchParams({
    hours: String(ram.hours), limit: String(PAGE_SIZE), offset: String(ram.offset),
  });
  if (ram.selectedNode) params.set("node_id", ram.selectedNode);
  if (ram.selectedModule !== "") params.set("module_id", ram.selectedModule);
  try {
    const data = await api(`/api/ramlog?${params}`);
    renderData(data);
  } finally {
    ram.loading = false;
    if (ram.refreshQueued) {
      ram.refreshQueued = false;
      refresh().catch(showError);
    }
  }
}

function renderData(data) {
  const records = data.records || [];
  const total = Number(data.total ?? records.length);
  ram.total = total;
  const kpis = document.getElementById("ram-kpis");
  kpis.innerHTML = "";
  kpis.append(
    kpi(`${records.length} / ${total}`, "Gösterilen / toplam kayıt"),
    kpi(String((data.nodes || []).length), `${ram.hours} saatte kayıt gönderen düğüm`),
    kpi(records.length ? fmtDT(records[0].received_ts) : "—", "Bu sayfanın en yeni kaydı"),
  );

  const nodeSelect = document.getElementById("ram-node");
  const knownNodes = data.nodes || [];
  nodeSelect.replaceChildren(el("option", { value: "" }, "Tüm düğümler"));
  knownNodes.forEach(id => nodeSelect.append(el("option", { value: id }, id.toUpperCase())));
  if (knownNodes.includes(ram.selectedNode)) nodeSelect.value = ram.selectedNode;
  else {
    ram.selectedNode = "";
    nodeSelect.value = "";
  }

  const moduleSelect = document.getElementById("ram-module");
  moduleSelect.replaceChildren(el("option", { value: "" }, "Tüm modüller"));
  (data.modules || []).forEach(id => {
    const name = MODULE_NAMES[id] || "Bilinmeyen modül";
    moduleSelect.append(el("option", { value: id }, `${name} (0x${hex(id)})`));
  });
  if ((data.modules || []).map(Number).includes(Number(ram.selectedModule))) {
    moduleSelect.value = ram.selectedModule;
  } else if (ram.selectedModule !== "") {
    ram.selectedModule = "";
    moduleSelect.value = "";
  }

  const table = el("table", { class: "t" });
  table.append(el("tr", {},
    el("th", {}, "Node ID"), el("th", {}, "Kaynak IPv6"),
    el("th", {}, "Modül"), el("th", {}, "Olay / hata"),
    el("th", {}, "Düğüm zamanı"), el("th", {}, "Panel alım zamanı")));
  records.forEach(row => {
    const moduleName = MODULE_NAMES[row.module_id] || "Bilinmeyen modül";
    const errorName = ERROR_NAMES[row.error_code] || "Tanımsız olay kodu";
    table.append(el("tr", {},
      el("td", { class: "mono" }, row.node.toUpperCase()),
      el("td", { class: "mono" }, row.source_addr || "—"),
      el("td", {}, `${moduleName} (0x${hex(row.module_id)})`),
      el("td", {}, `${errorName} (0x${hex(row.error_code)})`),
      el("td", { class: "mono" }, `${Number(row.device_ts).toLocaleString("tr-TR")} s`),
      el("td", { class: "mono" }, fmtDT(row.received_ts))));
  });
  const host = document.getElementById("ram-table");
  host.innerHTML = "";
  host.append(records.length ? table : el("div", { class: "hint" },
    "Bu filtrelerle RAMLOG kaydı bulunamadı. Simülasyonu ve serial bridge'i kontrol edin."));

  const first = total ? ram.offset + 1 : 0;
  const last = Math.min(ram.offset + records.length, total);
  document.getElementById("ram-page-label").textContent = `${first}–${last} / ${total}`;
  document.getElementById("ram-prev").disabled = ram.offset === 0;
  document.getElementById("ram-next").disabled = ram.offset + records.length >= total;
}

function hex(value) {
  return Number(value).toString(16).padStart(2, "0");
}

function kpi(value, label) {
  const card = el("div", { class: "card kpi" });
  card.append(el("div", { class: "num" }, value), el("div", { class: "lbl" }, label));
  return card;
}

function showError(error) {
  const host = document.getElementById("ram-table");
  if (host) host.textContent = "RAMLOG verisi alınamadı: " + error.message;
}

export function tickRam() {
  if (ram.built && Date.now() - ram.lastFetch > 15000 && !document.hidden &&
      document.getElementById("tab-ram").classList.contains("on")) {
    refresh().catch(showError);
  }
}
