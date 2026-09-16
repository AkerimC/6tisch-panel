// Ortak durum + REST/WebSocket istemcisi
export const state = {
  snap: null,           // son WS tick (asn, slot, carrier, nodes[])
  network: null,        // /api/network
  wsOk: false,
  listeners: new Set(),
};

export async function api(path, opts) {
  const r = await fetch(path, opts);
  if (!r.ok) throw new Error(path + " -> " + r.status);
  return r.json();
}

export function post(path, body) {
  return api(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function onTick(fn) { state.listeners.add(fn); }

let ws = null, backoff = 800;
export function connectWS() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(proto + "://" + location.host + "/ws");
  ws.onopen = () => { state.wsOk = true; backoff = 800; setConn("live"); };
  ws.onmessage = (ev) => {
    state.snap = JSON.parse(ev.data);
    for (const fn of state.listeners) { try { fn(state.snap); } catch (e) { console.error(e); } }
  };
  ws.onclose = () => { state.wsOk = false; setConn("down"); setTimeout(connectWS, backoff); backoff = Math.min(backoff * 2, 8000); };
  ws.onerror = () => ws.close();
}

export function setConn(st) {
  const p = document.getElementById("hdr-conn");
  const t = document.getElementById("hdr-conn-t");
  p.classList.remove("live", "down");
  p.classList.add(st);
  t.textContent = st === "live" ? "canlı" : (st === "down" ? "bağlantı yok" : "bağlanıyor…");
}

// --- yardımcılar -------------------------------------------------------------
export const fmtTime = (ts) => new Date(ts * 1000).toLocaleTimeString("tr-TR", { hour12: false });
export const fmtDT = (ts) => new Date(ts * 1000).toLocaleString("tr-TR", { hour12: false });
export const fmt1 = (x) => (x == null ? "—" : Number(x).toFixed(1));
export const fmt2 = (x) => (x == null ? "—" : Number(x).toFixed(2));

export function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (v != null) e.setAttribute(k, v);
  }
  for (const c of children) e.append(c);
  return e;
}

export function tipShow(html, x, y) {
  const t = document.getElementById("tip");
  t.innerHTML = html; t.style.display = "block";
  const r = t.getBoundingClientRect();
  t.style.left = Math.min(x + 14, innerWidth - r.width - 10) + "px";
  t.style.top = Math.min(y + 14, innerHeight - r.height - 10) + "px";
}
export function tipHide() { document.getElementById("tip").style.display = "none"; }

// panel sekme yonetimi
export function initTabs(onShow) {
  const btns = document.querySelectorAll("nav button");
  btns.forEach(b => b.addEventListener("click", () => {
    btns.forEach(x => x.classList.remove("on"));
    b.classList.add("on");
    document.querySelectorAll("main .tab").forEach(s => s.classList.remove("on"));
    const sec = document.getElementById("tab-" + b.dataset.tab);
    sec.classList.add("on");
    onShow && onShow(b.dataset.tab, sec);
  }));
}

// bant rengi
export const BAND_COLOR = { L: "#34d399", O: "#fb923c" };
export const CARRIER_LABEL = { 1: "ch1 865.150", 2: "ch2 867.850", 0: "ch0 869.525" };
