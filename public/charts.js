// Small SVG charts: a line/area chart with a hover crosshair, a bar chart and a donut.
// Colours come from CSS custom properties so light and dark themes both work.

const Charts = (() => {
  const NS = "http://www.w3.org/2000/svg";
  const tip = () => document.getElementById("tooltip");

  function el(tag, attrs = {}, parent) {
    const e = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    if (parent) parent.appendChild(e);
    return e;
  }

  function showTip(html, x, y) {
    const t = tip();
    t.innerHTML = html;
    t.hidden = false;
    const r = t.getBoundingClientRect();
    let left = x + 14, top = y - r.height - 10;
    if (left + r.width > window.innerWidth - 8) left = x - r.width - 14;
    if (top < 8) top = y + 14;
    t.style.left = `${left}px`;
    t.style.top = `${top}px`;
  }
  const hideTip = () => (tip().hidden = true);

  function niceTicks(min, max, count = 4) {
    if (min === max) { min -= 1; max += 1; }
    const span = max - min;
    const step0 = span / count;
    const mag = 10 ** Math.floor(Math.log10(step0));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= count) ?? mag * 10;
    const lo = Math.floor(min / step) * step;
    const hi = Math.ceil(max / step) * step;
    const ticks = [];
    for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Math.round(v * 100) / 100);
    return ticks;
  }

  const compact = (v) => {
    const a = Math.abs(v);
    if (a >= 1e6) return `${(v / 1e6).toFixed(1).replace(".", ",")} mln`;
    if (a >= 1e3) return `${(v / 1e3).toFixed(a >= 1e4 ? 0 : 1).replace(".", ",")} tys.`;
    return String(Math.round(v));
  };

  /**
   * Line chart. series: [{ key, points: [{x: Date|string, y}], className }]; the first
   * series is the main one (area + hover dot). format(v) formats values in the tooltip.
   */
  function line(container, series, { format, xLabel = (d) => d, tipTitle = (d) => d, baseline } = {}) {
    container.innerHTML = "";
    const w = container.clientWidth || 600, h = Number(container.dataset.h || 240);
    const m = { t: 12, r: 12, b: 26, l: 56 };
    const svg = el("svg", { viewBox: `0 0 ${w} ${h}`, role: "img", style: `height:${h}px` }, container);
    const all = series.flatMap((s) => s.points);
    const xs = all.map((p) => +new Date(p.x));
    const ys = all.map((p) => p.y);
    if (baseline !== undefined) ys.push(baseline);
    const ticks = niceTicks(Math.min(...ys), Math.max(...ys));
    const x0 = Math.min(...xs), x1 = Math.max(...xs);
    const y0 = ticks[0], y1 = ticks[ticks.length - 1];
    const X = (d) => m.l + ((+new Date(d) - x0) / (x1 - x0 || 1)) * (w - m.l - m.r);
    const Y = (v) => h - m.b - ((v - y0) / (y1 - y0 || 1)) * (h - m.t - m.b);

    for (const t of ticks) {
      el("line", { x1: m.l, x2: w - m.r, y1: Y(t), y2: Y(t), class: t === ticks[0] ? "baseline" : "gridline" }, svg);
      el("text", { x: m.l - 8, y: Y(t) + 4, "text-anchor": "end" }, svg).textContent = compact(t);
    }
    // x labels: first, middle, last
    const main = series[0].points;
    const idx = [...new Set([0, Math.floor((main.length - 1) / 2), main.length - 1])];
    idx.forEach((i, n) => {
      const anchor = n === 0 ? "start" : n === idx.length - 1 ? "end" : "middle";
      el("text", { x: X(main[i].x), y: h - 6, "text-anchor": anchor }, svg).textContent = xLabel(main[i].x);
    });

    series.forEach((s, i) => {
      const d = s.points.map((p, j) => `${j ? "L" : "M"}${X(p.x).toFixed(1)},${Y(p.y).toFixed(1)}`).join("");
      if (i === 0) el("path", { d: `${d}L${X(s.points.at(-1).x)},${Y(y0)}L${X(s.points[0].x)},${Y(y0)}Z`, class: "area" }, svg);
      el("path", { d, class: `line ${s.className ?? ""}` }, svg);
    });

    const cross = el("line", { y1: m.t, y2: h - m.b, class: "cross", visibility: "hidden" }, svg);
    const dot = el("circle", { r: 4.5, class: "dot", visibility: "hidden" }, svg);
    const hit = el("rect", { x: m.l, y: 0, width: w - m.l - m.r, height: h, fill: "transparent" }, svg);
    const move = (ev) => {
      const rect = svg.getBoundingClientRect();
      const px = ((ev.clientX - rect.left) / rect.width) * w;
      let best = 0;
      main.forEach((p, i) => { if (Math.abs(X(p.x) - px) < Math.abs(X(main[best].x) - px)) best = i; });
      const p = main[best];
      cross.setAttribute("x1", X(p.x)); cross.setAttribute("x2", X(p.x));
      dot.setAttribute("cx", X(p.x)); dot.setAttribute("cy", Y(p.y));
      cross.setAttribute("visibility", "visible"); dot.setAttribute("visibility", "visible");
      const rows = series
        .map((s) => ({ s, q: s.points.find((q) => +new Date(q.x) === +new Date(p.x)) }))
        .filter((r) => r.q)
        .map((r) => `<div class="tt-row"><span>${r.s.key}</span><span>${format(r.q.y)}</span></div>`)
        .join("");
      showTip(`<b>${tipTitle(p.x)}</b>${rows}`, ev.clientX, ev.clientY);
    };
    hit.addEventListener("pointermove", move);
    hit.addEventListener("pointerleave", () => { cross.setAttribute("visibility", "hidden"); dot.setAttribute("visibility", "hidden"); hideTip(); });
  }

  /** Vertical bars, one per item: [{label, value}]. Negative values drop below zero. */
  function bars(container, items, { format } = {}) {
    container.innerHTML = "";
    const w = container.clientWidth || 600, h = Number(container.dataset.h || 200);
    const m = { t: 18, r: 8, b: 26, l: 56 };
    const svg = el("svg", { viewBox: `0 0 ${w} ${h}`, style: `height:${h}px` }, container);
    const ticks = niceTicks(Math.min(0, ...items.map((i) => i.value)), Math.max(0, ...items.map((i) => i.value)));
    const y0 = ticks[0], y1 = ticks.at(-1);
    const Y = (v) => h - m.b - ((v - y0) / (y1 - y0 || 1)) * (h - m.t - m.b);
    for (const t of ticks) {
      el("line", { x1: m.l, x2: w - m.r, y1: Y(t), y2: Y(t), class: t === 0 ? "baseline" : "gridline" }, svg);
      el("text", { x: m.l - 8, y: Y(t) + 4, "text-anchor": "end" }, svg).textContent = compact(t);
    }
    const slot = (w - m.l - m.r) / items.length;
    const bw = Math.min(56, slot * 0.6);
    items.forEach((it, i) => {
      const cx = m.l + slot * i + slot / 2;
      const top = Y(Math.max(0, it.value)), bottom = Y(Math.min(0, it.value));
      const hgt = Math.max(1, bottom - top);
      const r = Math.min(4, hgt / 2);
      // rounded at the data end only
      const x = cx - bw / 2;
      const d = it.value >= 0
        ? `M${x},${bottom}V${top + r}Q${x},${top} ${x + r},${top}H${x + bw - r}Q${x + bw},${top} ${x + bw},${top + r}V${bottom}Z`
        : `M${x},${top}V${bottom - r}Q${x},${bottom} ${x + r},${bottom}H${x + bw - r}Q${x + bw},${bottom} ${x + bw},${bottom - r}V${top}Z`;
      const bar = el("path", { d, class: `bar ${it.value < 0 ? "neg" : ""}` }, svg);
      el("text", { x: cx, y: h - 6, "text-anchor": "middle" }, svg).textContent = it.label;
      el("text", { x: cx, y: (it.value >= 0 ? top : bottom + 14) - 5, "text-anchor": "middle", style: "fill:var(--text-2);font-weight:600" }, svg)
        .textContent = compact(it.value);
      const hit = el("rect", { x: m.l + slot * i, y: 0, width: slot, height: h, fill: "transparent" }, svg);
      hit.addEventListener("pointermove", (ev) => showTip(`<b>${it.label}</b>${it.tip ?? `<div class="tt-row"><span>Net</span><span>${format(it.value)}</span></div>`}`, ev.clientX, ev.clientY));
      hit.addEventListener("pointerleave", hideTip);
      bar.style.pointerEvents = "none";
    });
  }

  /** Donut with a legend: items [{label, value, color}]. */
  function donut(container, items, { format, center } = {}) {
    container.innerHTML = "";
    const total = items.reduce((a, i) => a + i.value, 0);
    const size = 200, r = 86, inner = 58, c = size / 2;
    const svg = el("svg", { viewBox: `0 0 ${size} ${size}` }, container);
    let angle = -Math.PI / 2;
    const arcs = [];
    items.forEach((it) => {
      const frac = total ? it.value / total : 0;
      const a0 = angle, a1 = angle + frac * Math.PI * 2;
      angle = a1;
      const large = a1 - a0 > Math.PI ? 1 : 0;
      const p = (a, rad) => `${(c + rad * Math.cos(a)).toFixed(2)},${(c + rad * Math.sin(a)).toFixed(2)}`;
      const d = frac >= 0.9999
        ? `M${c},${c - r}A${r},${r} 0 1 1 ${c - 0.01},${c - r}L${c - 0.01},${c - inner}A${inner},${inner} 0 1 0 ${c},${c - inner}Z`
        : `M${p(a0, r)}A${r},${r} 0 ${large} 1 ${p(a1, r)}L${p(a1, inner)}A${inner},${inner} 0 ${large} 0 ${p(a0, inner)}Z`;
      const path = el("path", { d, class: "seg-arc", fill: it.color }, svg);
      arcs.push(path);
      const share = total ? ((it.value / total) * 100).toFixed(1).replace(".", ",") : "0";
      const enter = (ev) => {
        container.classList.add("dim");
        path.classList.add("hot");
        showTip(`<b>${it.label}</b><div class="tt-row"><span>${format(it.value)}</span><span>${share}%</span></div>`, ev.clientX, ev.clientY);
      };
      path.addEventListener("pointermove", enter);
      path.addEventListener("pointerleave", () => { container.classList.remove("dim"); path.classList.remove("hot"); hideTip(); });
    });
    const label = el("text", { x: c, y: c - 4, "text-anchor": "middle", class: "donut-center" }, svg);
    label.textContent = center ?? "";
    el("text", { x: c, y: c + 15, "text-anchor": "middle" }, svg).textContent = "total";

    const legend = document.createElement("ul");
    legend.className = "legend";
    legend.innerHTML = items
      .map((it) => `<li><span class="sw" style="background:${it.color}"></span><span>${it.label}</span><span class="v">${format(it.value)}</span><span class="p">${total ? Math.round((it.value / total) * 100) : 0}%</span></li>`)
      .join("");
    container.appendChild(legend);
  }

  return { line, bars, donut, hideTip, compact };
})();
