import { api, el, fmtDT } from "../api.js";

const PAGE_SIZE = 100;
const HOURS = [1, 6, 24, 72, 168, 720];
const STATUS_LABELS = {
  received: "RX alındı",
  success: "TX başarılı",
  no_ack: "TX başarısız (ACK yok)",
  collision: "Kanal meşgul / çakışma",
  deferred: "TX ertelendi",
  error: "TX hatası",
  fatal_error: "Kritik TX hatası",
};

const view = {
  built: false, loading: false, refreshQueued: false, lastFetch: 0,
  hours: 24, node: "", direction: "", channel: "", status: "",
  offset: 0, total: 0,
};

export function renderMacEvents(root) {
  if (!view.built) build(root);
  refresh().catch(showError);
}

function build(root) {
  root.innerHTML = "";
  const kpis = el("div", { class: "grid c4", id: "mac-event-kpis" });
  const summaryCard = el("div", { class: "card", style: "margin-top:14px" });
  summaryCard.append(el("h3", {}, "Kanal bazında başarı",
    el("small", {}, "TX başarısı = başarılı TX / tüm TX denemeleri; RX sayısı kabul edilip yinelenmemiş çerçevelerdir")));
  summaryCard.append(el("div", { id: "mac-event-channel-summary" }));
  summaryCard.append(el("div", { id: "mac-event-node-summary", style: "margin-top:18px" }));
  summaryCard.append(el("div", { id: "mac-event-link-summary", style: "margin-top:18px" }));

  const filterCard = el("div", { class: "card", style: "margin-top:14px" });
  filterCard.append(el("h3", {}, "Filtreler"));
  const filters = el("div", { class: "grid c4" });
  const hours = el("select", { id: "mac-hours" });
  HOURS.forEach(h => hours.append(el("option", { value: h },
    h < 24 ? `Son ${h} saat` : h === 24 ? "Son 24 saat" : `Son ${h / 24} gün`)));
  hours.value = String(view.hours);
  hours.addEventListener("change", () => {
    view.hours = Number(hours.value); resetAndFetch();
  });

  const node = el("select", { id: "mac-node" });
  node.append(el("option", { value: "" }, "Tüm düğümler"));
  node.addEventListener("change", () => { view.node = node.value; resetAndFetch(); });

  const direction = el("select", { id: "mac-direction" });
  direction.append(el("option", { value: "" }, "TX + RX"),
    el("option", { value: "tx" }, "Yalnız TX"), el("option", { value: "rx" }, "Yalnız RX"));
  direction.addEventListener("change", () => { view.direction = direction.value; resetAndFetch(); });

  const channel = el("select", { id: "mac-channel" });
  channel.append(el("option", { value: "" }, "Tüm kanallar"));
  channel.addEventListener("change", () => { view.channel = channel.value; resetAndFetch(); });

  const status = el("select", { id: "mac-status" });
  status.append(el("option", { value: "" }, "Tüm sonuçlar"));
  Object.entries(STATUS_LABELS).forEach(([value, label]) =>
    status.append(el("option", { value }, label)));
  status.addEventListener("change", () => { view.status = status.value; resetAndFetch(); });

  filters.append(filter("Zaman aralığı", hours), filter("Düğüm", node),
    filter("Yön", direction), filter("Fiziksel kanal", channel),
    filter("Sonuç", status));
  filterCard.append(filters);

  const tableCard = el("div", { class: "card", style: "margin-top:14px" });
  tableCard.append(el("h3", {}, "TX/RX olayları",
    el("small", {}, "Cihaz zamanı açılıştan itibaren saniye; panel zamanı sunucuya ulaşma zamanı")));
  tableCard.append(el("div", { id: "mac-event-table" }));
  const pager = el("div", { id: "mac-event-pager", style: "display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:14px" });
  const prev = el("button", { class: "btn ghost", type: "button", id: "mac-event-prev" }, "← Önceki");
  const label = el("span", { class: "hint", id: "mac-event-page-label" });
  const next = el("button", { class: "btn ghost", type: "button", id: "mac-event-next" }, "Sonraki →");
  prev.addEventListener("click", () => {
    view.offset = Math.max(0, view.offset - PAGE_SIZE);
    refresh().catch(showError);
  });
  next.addEventListener("click", () => {
    if (view.offset + PAGE_SIZE < view.total) {
      view.offset += PAGE_SIZE;
      refresh().catch(showError);
    }
  });
  pager.append(prev, label, next);
  tableCard.append(pager);
  root.append(kpis, summaryCard, filterCard, tableCard);
  view.built = true;
}

function filter(title, input) {
  return el("label", { class: "f" }, title, input);
}

function resetAndFetch() {
  view.offset = 0;
  refresh().catch(showError);
}

async function refresh() {
  if (!view.built || !document.getElementById("tab-mac-events").classList.contains("on")) return;
  if (view.loading) {
    view.refreshQueued = true;
    return;
  }
  view.loading = true;
  view.lastFetch = Date.now();
  const params = new URLSearchParams({
    hours: String(view.hours), limit: String(PAGE_SIZE), offset: String(view.offset),
  });
  if (view.node) params.set("node_id", view.node);
  if (view.direction) params.set("direction", view.direction);
  if (view.channel !== "") params.set("channel", view.channel);
  if (view.status) params.set("status", view.status);
  try {
    renderData(await api(`/api/mac-events?${params}`));
  } finally {
    view.loading = false;
    if (view.refreshQueued) {
      view.refreshQueued = false;
      refresh().catch(showError);
    }
  }
}

function renderData(data) {
  const rows = data.records || [];
  view.total = Number(data.total || 0);
  const counts = { tx: 0, rx: 0, success: 0, no_ack: 0 };
  (data.summary || []).forEach(item => {
    if (item.direction === "tx") counts.tx += item.count;
    else counts.rx += item.count;
    if (item.status === "success" && item.ack_expected) counts.success += item.count;
    if (item.status === "no_ack") counts.no_ack += item.count;
  });
  const kpis = document.getElementById("mac-event-kpis");
  kpis.replaceChildren(
    kpi(String(counts.tx), "TX olayları"),
    kpi(String(counts.rx), "RX olayları"),
    kpi(String(counts.success), "TX ACK başarılı"),
    kpi(String(counts.no_ack), "TX ACK başarısız"),
  );

  const nodes = document.getElementById("mac-node");
  nodes.replaceChildren(el("option", { value: "" }, "Tüm düğümler"));
  (data.nodes || []).forEach(id => nodes.append(el("option", { value: id }, id.toUpperCase())));
  nodes.value = view.node;
  const channels = document.getElementById("mac-channel");
  channels.replaceChildren(el("option", { value: "" }, "Tüm kanallar"));
  (data.channels || []).forEach(ch => channels.append(el("option", { value: ch }, `Kanal ${ch}`)));
  channels.value = view.channel;

  const summary = el("table", { class: "t" });
  summary.append(el("tr", {}, el("th", {}, "Kanal"),
    el("th", {}, "TX başarılı / toplam TX"), el("th", {}, "Başarı oranı"),
    el("th", {}, "TX ACK yok"), el("th", {}, "RX kabul edilen")));
  const byChannel = new Map();
  (data.summary || []).forEach(item => {
    const entry = byChannel.get(item.channel) ||
      { success: 0, attempts: 0, noAck: 0, rx: 0 };
    if (item.direction === "rx") entry.rx += item.count;
    else {
      entry.attempts += item.count;
      if (item.status === "success") entry.success += item.count;
      if (item.status === "no_ack") entry.noAck += item.count;
    }
    byChannel.set(item.channel, entry);
  });
  [...byChannel.entries()].sort((a, b) => a[0] - b[0]).forEach(([ch, v]) =>
    summary.append(el("tr", {}, el("td", { class: "mono" }, ch),
      el("td", {}, `${v.success} / ${v.attempts}`),
      el("td", {}, formatRate(v.success, v.attempts)),
      el("td", {}, String(v.noAck)), el("td", {}, String(v.rx)))));
  const summaryHost = document.getElementById("mac-event-channel-summary");
  summaryHost.replaceChildren(byChannel.size ? summary : el("div", { class: "hint" },
    "Henüz TX/RX istatistiği alınmadı."));

  const byNode = new Map();
  const byLink = new Map();
  (data.summary || []).forEach(item => {
    const node = byNode.get(item.node) || { success: 0, attempts: 0, rx: 0 };
    const source = item.direction === "tx" ? item.node : item.peer_node;
    const dest = item.direction === "tx" ? item.peer_node : item.node;
    const linkKey = `${source || "?"}>${dest || "?"}`;
    const link = byLink.get(linkKey) ||
      { source, dest, success: 0, attempts: 0, rx: 0 };
    if (item.direction === "tx") {
      node.attempts += item.count;
      link.attempts += item.count;
      if (item.status === "success") {
        node.success += item.count;
        link.success += item.count;
      }
    } else {
      node.rx += item.count;
      link.rx += item.count;
    }
    byNode.set(item.node, node);
    byLink.set(linkKey, link);
  });

  const nodeTable = el("table", { class: "t" });
  nodeTable.append(el("tr", {}, el("th", {}, "Node"),
    el("th", {}, "TX başarılı / toplam TX"), el("th", {}, "Başarı oranı"),
    el("th", {}, "RX kabul edilen")));
  [...byNode.entries()].sort((a, b) => a[0].localeCompare(b[0])).forEach(([node, v]) =>
    nodeTable.append(el("tr", {}, el("td", { class: "mono" }, formatNode(node)),
      el("td", {}, `${v.success} / ${v.attempts}`),
      el("td", {}, formatRate(v.success, v.attempts)), el("td", {}, String(v.rx)))));
  const nodeHost = document.getElementById("mac-event-node-summary");
  nodeHost.replaceChildren(el("h3", {}, "Node bazında TX/RX"),
    byNode.size ? nodeTable : el("div", { class: "hint" }, "Henüz node istatistiği yok."));

  const linkTable = el("table", { class: "t" });
  linkTable.append(el("tr", {}, el("th", {}, "Kaynak → hedef"),
    el("th", {}, "TX başarılı / toplam TX"), el("th", {}, "Başarı oranı"),
    el("th", {}, "RX kabul edilen")));
  [...byLink.values()].sort((a, b) =>
    `${a.source || ""}>${a.dest || ""}`.localeCompare(`${b.source || ""}>${b.dest || ""}`)
  ).forEach(link => linkTable.append(el("tr", {},
    el("td", { class: "mono" }, `${formatNode(link.source, "Bilinmiyor")} → ` +
      formatNode(link.dest, link.source ? "Yayın" : "Bilinmiyor")),
    el("td", {}, `${link.success} / ${link.attempts}`),
    el("td", {}, formatRate(link.success, link.attempts)), el("td", {}, String(link.rx)))));
  const linkHost = document.getElementById("mac-event-link-summary");
  linkHost.replaceChildren(el("h3", {}, "Node’lar arası bağlantı istatistiği"),
    byLink.size ? linkTable : el("div", { class: "hint" }, "Henüz bağlantı istatistiği yok."));

  const table = el("table", { class: "t" });
  table.append(el("tr", {}, el("th", {}, "Kaynak node"), el("th", {}, "Hedef node"),
    el("th", {}, "Raporlayan node"), el("th", {}, "Yön"),
    el("th", {}, "Kanal"), el("th", {}, "Sonuç"), el("th", {}, "ACK gerekli"),
    el("th", {}, "Cihaz zamanı"), el("th", {}, "Panel alım zamanı")));
  rows.forEach(row => table.append(el("tr", {},
    el("td", { class: "mono" }, formatNode(row.source_node,
      row.direction === "rx" ? "Bilinmiyor" : "—")),
    el("td", { class: "mono" }, formatNode(row.dest_node,
      row.direction === "tx" ? "Yayın" : "—")),
    el("td", { class: "mono" }, formatNode(row.node)),
    el("td", {}, row.direction.toUpperCase()),
    el("td", { class: "mono" }, String(row.channel)),
    el("td", {}, row.status === "success"
      ? (row.ack_expected ? "TX başarılı (ACK alındı)" : "TX başarılı (ACK gerekmedi)")
      : (STATUS_LABELS[row.status] || row.status)),
    el("td", {}, row.direction === "tx" ? (row.ack_expected ? "Evet" : "Hayır / yayın") : "—"),
    el("td", { class: "mono" }, `${Number(row.device_ts).toLocaleString("tr-TR")} s`),
    el("td", { class: "mono" }, fmtDT(row.received_ts)))));
  const host = document.getElementById("mac-event-table");
  host.replaceChildren(rows.length ? table : el("div", { class: "hint" },
    "Bu filtrelerle TX/RX olayı bulunamadı. MAC olay gönderimini ve serial bridge'i kontrol edin."));

  const first = view.total ? view.offset + 1 : 0;
  const last = Math.min(view.offset + rows.length, view.total);
  document.getElementById("mac-event-page-label").textContent = `${first}–${last} / ${view.total}`;
  document.getElementById("mac-event-prev").disabled = view.offset === 0;
  document.getElementById("mac-event-next").disabled = view.offset + rows.length >= view.total;
}

function kpi(value, title) {
  const card = el("div", { class: "card kpi" });
  card.append(el("div", { class: "num" }, value), el("div", { class: "lbl" }, title));
  return card;
}

function formatNode(node, fallback = "—") {
  return node ? String(node).toUpperCase() : fallback;
}

function formatRate(success, attempts) {
  if (!attempts) return "—";
  const percent = 100 * success / attempts;
  return `${success}/${attempts} · %${percent.toLocaleString("tr-TR", { maximumFractionDigits: 1 })}`;
}

function showError(error) {
  const host = document.getElementById("mac-event-table");
  if (host) host.textContent = "TX/RX verisi alınamadı: " + error.message;
}

export function tickMacEvents() {
  if (view.built && Date.now() - view.lastFetch > 15000 && !document.hidden &&
      document.getElementById("tab-mac-events").classList.contains("on")) {
    refresh().catch(showError);
  }
}
