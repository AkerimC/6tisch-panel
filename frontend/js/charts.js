// Minimal SVG grafik yardimcilari (bagimsiz, cevrimdisi guvenli)
export const NS = "http://www.w3.org/2000/svg";

export function svgEl(tag, attrs = {}, parent) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (parent) parent.append(e);
  return e;
}

export function svg(html) {
  const d = document.createElement("div");
  d.innerHTML = html;
  return d.firstElementChild;
}

/**
 * Cizgi grafigi. series: [{name,color,data:[[x,y]...],dashed?,area?}]
 * opts: {height, yFmt, xFmt, yMin, yMax, limitLines:[{y,color,label}], legend}
 */
export function lineChart(series, opts = {}) {
  const W = opts.width || 860, H = opts.height || 260;
  const padL = 46, padR = 12, padT = 12, padB = 26;
  const pts = series.flatMap(s => s.data);
  if (!pts.length) return svg(`<svg viewBox="0 0 ${W} ${H}" width="100%"><text x="20" y="30" fill="#8f909a">veri yok</text></svg>`);
  let x0 = Math.min(...pts.map(p => p[0])), x1 = Math.max(...pts.map(p => p[0]));
  let y0 = opts.yMin ?? Math.min(...pts.map(p => p[1]));
  let y1 = opts.yMax ?? Math.max(...pts.map(p => p[1]));
  for (const l of (opts.limitLines || [])) { y0 = Math.min(y0, l.y); y1 = Math.max(y1, l.y); }
  if (x1 === x0) x1 = x0 + 1;
  if (y1 === y0) y1 = y0 + 1;
  const yp = (y1 - y0) * 0.08; y0 -= yp; y1 += yp;
  const X = x => padL + (x - x0) / (x1 - x0) * (W - padL - padR);
  const Y = y => padT + (1 - (y - y0) / (y1 - y0)) * (H - padT - padB);
  const xF = opts.xFmt || (v => v), yF = opts.yFmt || (v => v.toFixed(1));

  let g = "";
  for (let i = 0; i <= 4; i++) {
    const yy = y0 + (y1 - y0) * i / 4;
    g += `<line x1="${padL}" y1="${Y(yy)}" x2="${W - padR}" y2="${Y(yy)}" stroke="#35353b"/>`;
    g += `<text x="${padL - 6}" y="${Y(yy) + 3}" fill="#8f909a" font-size="10" text-anchor="end">${yF(yy)}</text>`;
  }
  for (let i = 0; i <= 4; i++) {
    const xx = x0 + (x1 - x0) * i / 4;
    g += `<text x="${X(xx)}" y="${H - 8}" fill="#8f909a" font-size="10" text-anchor="middle">${xF(xx)}</text>`;
  }
  for (const l of (opts.limitLines || [])) {
    g += `<line x1="${padL}" y1="${Y(l.y)}" x2="${W - padR}" y2="${Y(l.y)}" stroke="${l.color}" stroke-dasharray="5 4" stroke-width="1.2"/>`;
    if (l.label) g += `<text x="${W - padR - 4}" y="${Y(l.y) - 4}" fill="${l.color}" font-size="10" text-anchor="end">${l.label}</text>`;
  }
  let paths = "", areas = "";
  for (const s of series) {
    if (!s.data.length) continue;
    const d = s.data.map((p, i) => (i ? "L" : "M") + X(p[0]).toFixed(1) + "," + Y(p[1]).toFixed(1)).join("");
    if (s.area) areas += `<path d="${d}L${X(s.data.at(-1)[0])},${Y(y0)}L${X(s.data[0][0])},${Y(y0)}Z" fill="${s.color}" opacity="0.10"/>`;
    paths += `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="1.6"${s.dashed ? ' stroke-dasharray="4 4"' : ""} opacity="0.95"/>`;
  }
  const legend = (opts.legend === false) ? "" :
    `<div class="legend">${series.map(s => `<span><span class="sw" style="background:${s.color}"></span>${s.name}</span>`).join("")}</div>`;
  return svg(`<div>${legend}<svg viewBox="0 0 ${W} ${H}" width="100%">${g}${areas}${paths}</svg></div>`);
}

/** Yarim daire gosterge: value/max (yuzde) */
export function gauge(value, max, label, color, sub) {
  const frac = Math.max(0, Math.min(1.25, value / max));
  const R = 54, cx = 70, cy = 68;
  const a0 = Math.PI, a = Math.min(Math.PI * 1.02, a0 + Math.PI * frac);
  const pol = (ang, r) => [cx + r * Math.cos(ang), cy - r * Math.sin(ang)];
  const [sx, sy] = pol(a0, R), [ex, ey] = pol(a, R);
  const large = (a - a0) > Math.PI ? 1 : 0;
  const col = frac > 1 ? "#ffb4ab" : (frac > 0.85 ? "#fbbf24" : color);
  return svg(`<div style="text-align:center"><svg viewBox="0 0 140 84" width="150">` +
    `<path d="M ${cx - R} ${cy} A ${R} ${R} 0 0 1 ${cx + R} ${cy}" fill="none" stroke="#35353b" stroke-width="11" stroke-linecap="round"/>` +
    `<path d="M ${sx} ${sy} A ${R} ${R} 0 ${large} 1 ${ex} ${ey}" fill="none" stroke="${col}" stroke-width="11" stroke-linecap="round"/>` +
    `<text x="70" y="60" text-anchor="middle" fill="${col}" font-size="19" font-weight="700">${value.toFixed(2)}%</text>` +
    `<text x="70" y="76" text-anchor="middle" fill="#a5a4b0" font-size="9">${label}</text>` +
    `</svg><div style="color:#8f909a;font-size:11px;margin-top:-4px">${sub || ""}</div></div>`);
}

/** Kucuk sparkline */
export function sparkline(data, color, W = 330, H = 44) {
  if (!data || data.length < 2) return svg(`<svg viewBox="0 0 ${W} ${H}" width="100%"></svg>`);
  const xs = data.map(p => p[0]), ys = data.map(p => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  let y0 = Math.min(...ys), y1 = Math.max(...ys);
  if (y1 === y0) y1 = y0 + 1;
  const X = x => (x - x0) / (x1 - x0 || 1) * (W - 4) + 2;
  const Y = y => H - 4 - (y - y0) / (y1 - y0) * (H - 8);
  const d = data.map((p, i) => (i ? "L" : "M") + X(p[0]).toFixed(1) + "," + Y(p[1]).toFixed(1)).join("");
  return svg(`<svg viewBox="0 0 ${W} ${H}" width="100%"><path d="${d}" fill="none" stroke="${color}" stroke-width="1.4"/></svg>`);
}

/** x ekseni saat:dakika etiketi */
export const hmFmt = (ts) => {
  const d = new Date(ts * 1000);
  return d.toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit", hour12: false });
};
