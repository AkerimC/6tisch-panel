import { api, el, fmtDT } from "../api.js";
import { svgEl } from "../charts.js";

const PAGE_SIZE = 100;
// Retention in the store is 48 h (backend/store.py purge_older_than); offering a
// longer window would silently return a partial result.
const HOURS = [1, 6, 12, 24, 48];
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
  offset: 0, total: 0, channelDetail: "", nodeDetail: "", chartType: "bar",
  latestData: null,
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

  filters.append(filter("Zaman aralığı (liste + grafikler)", hours), filter("Düğüm", node),
    filter("Yön", direction), filter("Fiziksel kanal", channel),
    filter("Sonuç", status));
  filterCard.append(filters);

  const chartsCard = el("div", { class: "card", style: "margin-top:14px" });
  chartsCard.append(el("h3", {}, "TX/RX grafikleri",
    el("small", {}, "Zaman, düğüm ve kanal filtreleri grafikleri etkiler; yön ve sonuç filtreleri yalnızca olay listesini süzer.")));
  const chartFilters = el("div", { class: "grid c3" });
  const channelDetail = el("select", { id: "mac-chart-channel-detail" });
  channelDetail.append(el("option", { value: "" }, "Tekil kanal seçin"));
  channelDetail.addEventListener("change", () => {
    view.channelDetail = channelDetail.value;
    if (view.latestData) renderCharts(view.latestData);
  });
  const nodeDetail = el("select", { id: "mac-chart-node-detail" });
  nodeDetail.append(el("option", { value: "" }, "Tekil node seçin"));
  nodeDetail.addEventListener("change", () => {
    view.nodeDetail = nodeDetail.value;
    if (view.latestData) renderCharts(view.latestData);
  });
  const chartType = el("select", { id: "mac-chart-type" });
  chartType.append(el("option", { value: "bar" }, "Sütun grafik"),
    el("option", { value: "line" }, "Çizgi grafik"));
  chartType.value = view.chartType;
  chartType.addEventListener("change", () => {
    view.chartType = chartType.value;
    if (view.latestData) renderCharts(view.latestData);
  });
  chartFilters.append(filter("Kanalı tekil incele", channelDetail),
    filter("Node'u tekil incele", nodeDetail), filter("Grafik tipi", chartType));
  chartsCard.append(chartFilters);

  const channelChartsTitle = el("h3", { style: "margin-top:18px" }, "Kanal karşılaştırması");
  const channelCharts = el("div", { class: "grid c2" });
  channelCharts.append(chartPanel("Kanal bazında TX başarı oranı", "mac-chart-channels-tx"),
    chartPanel("Kanal bazında kabul edilen RX", "mac-chart-channels-rx"));
  chartsCard.append(channelChartsTitle, channelCharts);

  const channelDetailTitle = el("h3", { id: "mac-chart-channel-title", style: "margin-top:18px" },
    "Tekil kanal grafiği");
  const channelDetailCharts = el("div", { id: "mac-chart-channel-detail-section", class: "grid c2" });
  channelDetailCharts.append(chartPanel("Seçilen kanal · TX başarısı", "mac-chart-channel-one-tx"),
    chartPanel("Seçilen kanal · RX", "mac-chart-channel-one-rx"));
  chartsCard.append(channelDetailTitle, channelDetailCharts);

  const nodeChartsTitle = el("h3", { style: "margin-top:18px" }, "Node karşılaştırması");
  const nodeCharts = el("div", { class: "grid c2" });
  nodeCharts.append(chartPanel("Node bazında TX başarı oranı", "mac-chart-nodes-tx"),
    chartPanel("Node bazında kabul edilen RX", "mac-chart-nodes-rx"));
  chartsCard.append(nodeChartsTitle, nodeCharts);

  const nodeDetailTitle = el("h3", { id: "mac-chart-node-title", style: "margin-top:18px" },
    "Tekil node grafiği");
  const nodeDetailCharts = el("div", { id: "mac-chart-node-detail-section", class: "grid c2" });
  nodeDetailCharts.append(chartPanel("Seçilen node · TX başarısı", "mac-chart-node-one-tx"),
    chartPanel("Seçilen node · RX", "mac-chart-node-one-rx"));
  chartsCard.append(nodeDetailTitle, nodeDetailCharts);

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
  root.append(kpis, summaryCard, filterCard, chartsCard, tableCard);
  view.built = true;
}

function filter(title, input) {
  return el("label", { class: "f" }, title, input);
}

function chartPanel(title, id) {
  const panel = el("div", { class: "card" });
  panel.append(el("h3", {}, title), el("div", { id }));
  return panel;
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
  view.latestData = data;
  const rows = data.records || [];
  view.total = Number(data.total || 0);
  const counts = { tx: 0, rx: 0, success: 0, no_ack: 0, ack_tx: 0 };
  (data.summary || []).forEach(item => {
    if (item.direction === "tx") {
      counts.tx += item.count;
      if (item.ack_expected) counts.ack_tx += item.count;
    } else counts.rx += item.count;
    // Same definition as the channel/node/link tables and the charts:
    // every successful TX, including broadcast (ack_expected === 0).
    if (item.direction === "tx" && item.status === "success") counts.success += item.count;
    if (item.status === "no_ack") counts.no_ack += item.count;
  });
  const kpis = document.getElementById("mac-event-kpis");
  kpis.replaceChildren(
    kpi(String(counts.tx), `TX olayları (${counts.ack_tx} ACK'li)`),
    kpi(String(counts.rx), "RX olayları"),
    kpi(String(counts.success), "TX başarılı"),
    kpi(String(counts.no_ack), "TX ACK yok"),
  );

  const nodes = document.getElementById("mac-node");
  nodes.replaceChildren(el("option", { value: "" }, "Tüm düğümler"));
  const knownNodes = data.nodes || [];
  (knownNodes).forEach(id => nodes.append(el("option", { value: id }, id.toUpperCase())));
  // If the selected node aged out of the window, drop the filter instead of
  // silently keeping it in the query while the UI shows "Tüm düğümler".
  if(view.node && !knownNodes.includes(view.node)) view.node = "";
  nodes.value = view.node;
  const channels = document.getElementById("mac-channel");
  channels.replaceChildren(el("option", { value: "" }, "Tüm kanallar"));
  const knownChannels = (data.channels || []).map(String);
  (data.channels || []).forEach(ch => channels.append(el("option", { value: ch }, `Kanal ${ch}`)));
  if(view.channel && !knownChannels.includes(String(view.channel))) view.channel = "";
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

  renderCharts(data);

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

  // view.offset can point past the end after a purge / aging out, which would
  // render a label such as "201–150 / 150".
  const safeOffset = view.total ? Math.min(view.offset, Math.max(0, view.total - 1)) : 0;
  const first = view.total ? safeOffset + 1 : 0;
  const last = Math.min(safeOffset + rows.length, view.total);
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

function renderCharts(data) {
  const channels = new Map();
  const nodes = new Map();
  (data.summary || []).forEach(item => {
    const channel = channels.get(item.channel) || { success: 0, attempts: 0, rx: 0 };
    const node = nodes.get(item.node) || { success: 0, attempts: 0, rx: 0 };
    if (item.direction === "rx") {
      channel.rx += item.count;
      node.rx += item.count;
    } else {
      channel.attempts += item.count;
      node.attempts += item.count;
      if (item.status === "success") {
        channel.success += item.count;
        node.success += item.count;
      }
    }
    channels.set(item.channel, channel);
    nodes.set(item.node, node);
  });

  const channelIds = [...channels.keys()].sort((a, b) => a - b);
  const nodeIds = [...nodes.keys()].sort((a, b) => a.localeCompare(b));
  updateChartSelect("mac-chart-channel-detail", channelIds.map(String), view.channelDetail,
    value => { view.channelDetail = value; });
  updateChartSelect("mac-chart-node-detail", nodeIds, view.nodeDetail,
    value => { view.nodeDetail = value; });

  const channelTx = channelIds.map(id => ({ label: `CH ${id}`, ...channels.get(id) }));
  const channelRx = channelIds.map(id => ({ label: `CH ${id}`, value: channels.get(id).rx }));
  const nodeTx = nodeIds.map(id => ({ label: id.toUpperCase(), ...nodes.get(id) }));
  const nodeRx = nodeIds.map(id => ({ label: id.toUpperCase(), value: nodes.get(id).rx }));
  renderStatChart("mac-chart-channels-tx", channelTx, "rate", "Kanal TX başarı oranı");
  renderStatChart("mac-chart-channels-rx", channelRx, "count", "Kanal RX adedi");
  renderStatChart("mac-chart-nodes-tx", nodeTx, "rate", "Node TX başarı oranı");
  renderStatChart("mac-chart-nodes-rx", nodeRx, "count", "Node RX adedi");

  const channelId = view.channelDetail === "" ? null : Number(view.channelDetail);
  const channelDetail = channelId == null ? null : channels.get(channelId);
  const channelSection = document.getElementById("mac-chart-channel-detail-section");
  const channelTitle = document.getElementById("mac-chart-channel-title");
  if (channelDetail) {
    channelTitle.textContent = `Kanal ${channelId} · tekil grafikler`;
    renderStatChart("mac-chart-channel-one-tx", [
      { label: `CH ${channelId}`, ...channelDetail },
    ], "rate", `Kanal ${channelId} TX başarı oranı`);
    renderStatChart("mac-chart-channel-one-rx", [
      { label: `CH ${channelId}`, value: channelDetail.rx },
    ], "count", `Kanal ${channelId} kabul edilen RX`);
    channelSection.hidden = false;
  } else {
    channelTitle.textContent = "Tekil kanal grafiği";
    channelSection.hidden = true;
  }

  const nodeDetail = view.nodeDetail === "" ? null : nodes.get(view.nodeDetail);
  const nodeSection = document.getElementById("mac-chart-node-detail-section");
  const nodeTitle = document.getElementById("mac-chart-node-title");
  if (nodeDetail) {
    const id = view.nodeDetail.toUpperCase();
    nodeTitle.textContent = `Node ${id} · tekil grafikler`;
    renderStatChart("mac-chart-node-one-tx", [
      { label: id, ...nodeDetail },
    ], "rate", `Node ${id} TX başarı oranı`);
    renderStatChart("mac-chart-node-one-rx", [
      { label: id, value: nodeDetail.rx },
    ], "count", `Node ${id} kabul edilen RX`);
    nodeSection.hidden = false;
  } else {
    nodeTitle.textContent = "Tekil node grafiği";
    nodeSection.hidden = true;
  }
}

function updateChartSelect(id, values, selected, onChange) {
  const select = document.getElementById(id);
  const firstLabel = id === "mac-chart-channel-detail" ? "Tekil kanal seçin" : "Tekil node seçin";
  select.replaceChildren(el("option", { value: "" }, firstLabel),
    ...values.map(value => el("option", { value },
      id === "mac-chart-channel-detail" ? `Kanal ${value}` : value.toUpperCase())));
  const value = values.includes(selected) ? selected : "";
  select.value = value;
  onChange(value);
}

function renderStatChart(hostId, rows, kind, ariaLabel) {
  const host = document.getElementById(hostId);
  host.replaceChildren();
  if (!rows.length) {
    host.append(el("div", { class: "hint" }, "Seçilen zaman aralığında grafik verisi yok."));
    return;
  }

  const width = 860, height = 290;
  const left = 52, right = 18, top = 28, bottom = 58;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const color = view.chartType === "line"
    ? (kind === "rate" ? "#ef4444" : "#fda4af")
    : (kind === "rate" ? "#b7c4ff" : "#34d399");
  const values = rows.map(row => kind === "rate"
    ? (row.attempts ? row.success * 100 / row.attempts : 0)
    : Math.max(0, Number(row.value) || 0));
  const rawMax = kind === "rate" ? 100 : Math.max(1, ...values);
  const max = kind === "rate" ? 100 : Math.max(1, Math.ceil(rawMax));
  const svg = svgEl("svg", {
    viewBox: `0 0 ${width} ${height}`, width: "100%", role: "img",
    "aria-label": ariaLabel, style: "display:block;overflow:visible",
  });
  const title = svgEl("title", {}, svg);
  title.textContent = ariaLabel;

  const tickCount = kind === "rate" ? 4 : Math.min(4, max);
  for (let i = 0; i <= tickCount; i++) {
    const fraction = i / tickCount;
    const value = max * fraction;
    const y = top + plotHeight * (1 - fraction);
    svgEl("line", { x1: left, y1: y, x2: width - right, y2: y,
      stroke: "#35353b", "stroke-width": 1 }, svg);
    const tick = svgEl("text", { x: left - 8, y: y + 4, fill: "#8f909a",
      "font-size": 11, "text-anchor": "end" }, svg);
    tick.textContent = kind === "rate" ? `${Math.round(value)}%`
      : Math.round(value).toLocaleString("tr-TR");
  }

  const slotWidth = plotWidth / rows.length;
  const barWidth = Math.min(48, Math.max(7, slotWidth * 0.58));
  const points = rows.map((row, index) => ({
    row,
    x: left + slotWidth * index + slotWidth / 2,
    y: top + plotHeight * (1 - values[index] / max),
    value: values[index],
  }));
  if (view.chartType === "line" && points.length > 1) {
    svgEl("polyline", {
      points: points.map(point => `${point.x},${point.y}`).join(" "),
      fill: "none", stroke: color, "stroke-width": 3,
      "stroke-linecap": "round", "stroke-linejoin": "round",
    }, svg);
  }
  rows.forEach((row, index) => {
    const value = values[index];
    const barHeight = value / max * plotHeight;
    const x = left + slotWidth * index + (slotWidth - barWidth) / 2;
    const y = top + plotHeight - barHeight;
    const mark = view.chartType === "line"
      ? svgEl("circle", { cx: points[index].x, cy: points[index].y, r: 4,
        fill: color, stroke: "#fff", "stroke-width": 1.2 }, svg)
      : svgEl("rect", { x, y, width: barWidth, height: Math.max(0, barHeight),
        rx: 3, fill: color, opacity: 0.88 }, svg);
    const detail = kind === "rate"
      ? `TX ${row.success}/${row.attempts} · ${formatRate(row.success, row.attempts)}`
      : `RX ${Math.round(value).toLocaleString("tr-TR")}`;
    const tooltip = svgEl("title", {}, mark);
    tooltip.textContent = `${row.label}: ${detail}`;

    if (rows.length <= 20) {
      const dataLabel = svgEl("text", { x: x + barWidth / 2, y: Math.max(top - 7, y - 6),
        fill: "#e4e1e7", "font-size": 10, "text-anchor": "middle" }, svg);
      dataLabel.textContent = kind === "rate"
        ? (row.attempts ? `%${Math.round(value)}` : "—")
        : Math.round(value).toLocaleString("tr-TR");
    }

    const category = svgEl("text", { x: x + barWidth / 2, y: height - 22,
      fill: "#a5a4b0", "font-size": rows.length > 20 ? 8 : 10,
      "text-anchor": "middle" }, svg);
    category.textContent = row.label;
  });
  host.append(svg);
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
