/* Lightweight SVG chart renderers.
   Mark specs: bars ≤24px w/ 4px rounded data-end, 2px lines, hairline grid,
   2px surface gaps between touching marks, hover tooltips on every mark. */

const SVG_NS = 'http://www.w3.org/2000/svg';
const tooltipEl = () => document.getElementById('chart-tooltip');

export const fmtUSD = (n, opts = {}) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: opts.cents ? 2 : 0, minimumFractionDigits: opts.cents ? 2 : 0 }).format(n);

export const fmtCompact = (n) =>
  '$' + new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(n);

function el(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

/* Tooltip: values lead, series names follow; line keys, not boxes. */
export function showTooltip(x, y, title, rows) {
  const tt = tooltipEl();
  tt.replaceChildren();
  const t = document.createElement('div');
  t.className = 'tt-title';
  t.textContent = title;
  tt.appendChild(t);
  for (const r of rows) {
    const row = document.createElement('div');
    row.className = 'tt-row';
    const key = document.createElement('span');
    key.className = 'tt-key';
    key.style.background = r.color;
    const name = document.createElement('span');
    name.className = 'tt-name';
    name.textContent = r.name;
    const val = document.createElement('span');
    val.className = 'tt-val';
    val.textContent = r.value;
    row.append(key, name, val);
    tt.appendChild(row);
  }
  tt.classList.remove('hidden');
  const rect = tt.getBoundingClientRect();
  const px = Math.min(x + 14, window.innerWidth - rect.width - 12);
  const py = Math.max(y - rect.height - 12, 10);
  tt.style.left = `${px}px`;
  tt.style.top = `${py}px`;
}
export function hideTooltip() {
  tooltipEl().classList.add('hidden');
}

function niceMax(v) {
  if (v <= 0) return 100;
  const mag = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) {
    if (v <= m * mag) return m * mag;
  }
  return 10 * mag;
}

/* ---------------- Donut: spending share by category ---------------- */
export function renderDonut(container, data, { onHover } = {}) {
  container.replaceChildren();
  const total = data.reduce((s, d) => s + d.value, 0);
  const svg = el('svg', { viewBox: '0 0 200 200', role: 'img', 'aria-label': 'Spending by category' });
  const cx = 100, cy = 100, r = 80, width = 26;

  if (total <= 0 || data.length === 0) {
    const ring = el('circle', { cx, cy, r, fill: 'none', 'stroke-width': width });
    ring.style.stroke = 'var(--grid)';
    svg.appendChild(ring);
    container.appendChild(svg);
    return;
  }

  // 2px surface gap between segments, expressed as an angular pad per segment.
  const gapAngle = data.length > 1 ? (2 / r) : 0;
  let angle = -Math.PI / 2;

  for (const d of data) {
    const frac = d.value / total;
    const sweep = frac * Math.PI * 2;
    const pad = Math.min(gapAngle, sweep * 0.25);
    const a0 = angle + pad / 2;
    const a1 = angle + sweep - pad / 2;
    angle += sweep;
    if (a1 <= a0) continue;

    const large = a1 - a0 > Math.PI ? 1 : 0;
    const x0 = cx + r * Math.cos(a0), y0 = cy + r * Math.sin(a0);
    const x1 = cx + r * Math.cos(a1), y1 = cy + r * Math.sin(a1);
    const path = el('path', {
      d: `M ${x0} ${y0} A ${r} ${r} 0 ${large} 1 ${x1} ${y1}`,
      fill: 'none', 'stroke-width': width, 'stroke-linecap': 'butt',
      tabindex: '0', role: 'graphics-symbol',
      'aria-label': `${d.label}: ${fmtUSD(d.value)}`,
    });
    path.style.stroke = d.color;

    const activate = (ev) => {
      container.classList.add('hovering');
      const p = ev.touches?.[0] || ev;
      showTooltip(p.clientX ?? 0, p.clientY ?? 0, d.label, [
        { color: d.color, name: `${Math.round(frac * 100)}% of spending`, value: fmtUSD(d.value) },
      ]);
      onHover?.(d.label);
    };
    path.addEventListener('pointermove', activate);
    path.addEventListener('focus', (ev) => {
      const box = path.getBoundingClientRect();
      container.classList.add('hovering');
      showTooltip(box.x + box.width / 2, box.y, d.label, [
        { color: d.color, name: `${Math.round(frac * 100)}% of spending`, value: fmtUSD(d.value) },
      ]);
      onHover?.(d.label);
    });
    for (const evName of ['pointerleave', 'blur']) {
      path.addEventListener(evName, () => {
        container.classList.remove('hovering');
        hideTooltip();
        onHover?.(null);
      });
    }
    svg.appendChild(path);
  }

  container.appendChild(svg);
  const center = document.createElement('div');
  center.className = 'donut-center';
  const val = document.createElement('div');
  val.className = 'val';
  val.textContent = fmtCompact(total);
  const lbl = document.createElement('div');
  lbl.className = 'lbl';
  lbl.textContent = 'total spent';
  center.append(val, lbl);
  container.appendChild(center);
}

/* ------------- Grouped columns: monthly spending vs income ------------- */
export function renderMonthlyBars(container, months, series) {
  // months: ['2026-02', ...]; series: [{name, color(css var), values[]}]
  container.replaceChildren();
  const W = 640, H = 240, padL = 46, padR = 10, padT = 14, padB = 26;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Monthly spending vs income' });

  const maxVal = niceMax(Math.max(1, ...series.flatMap((s) => s.values)));
  const y = (v) => padT + plotH - (v / maxVal) * plotH;

  // hairline gridlines + clean tick labels
  const ticks = 4;
  for (let i = 0; i <= ticks; i++) {
    const v = (maxVal / ticks) * i;
    const line = el('line', { x1: padL, x2: W - padR, y1: y(v), y2: y(v), class: i === 0 ? 'baseline' : 'grid-line' });
    svg.appendChild(line);
    const t = el('text', { x: padL - 8, y: y(v) + 3.5, 'text-anchor': 'end' });
    t.style.fontVariantNumeric = 'tabular-nums';
    t.textContent = fmtCompact(v).replace('$', '$');
    svg.appendChild(t);
  }

  const slot = plotW / months.length;
  const barW = Math.min(24, (slot * 0.6) / series.length);
  const groupW = barW * series.length + 2 * (series.length - 1); // 2px surface gap between adjacent bars

  months.forEach((m, i) => {
    const gx = padL + slot * i + (slot - groupW) / 2;
    const group = el('g', { class: 'bar-group' });

    series.forEach((s, si) => {
      const v = s.values[i] || 0;
      const by = y(v);
      const h = Math.max(0, padT + plotH - by);
      // 4px rounded data-end, square at baseline: rounded rect + patch over bottom corners
      const rx = Math.min(4, barW / 2, h);
      const bar = el('rect', {
        x: gx + si * (barW + 2), y: by, width: barW, height: h, rx, class: 'bar-rect',
      });
      bar.style.fill = s.color;
      group.appendChild(bar);
      if (h > rx) {
        const patch = el('rect', { x: gx + si * (barW + 2), y: padT + plotH - rx, width: barW, height: rx });
        patch.style.fill = s.color;
        group.appendChild(patch);
      }
    });

    // whole-slot transparent hit target — bigger than the marks
    const hit = el('rect', { x: padL + slot * i, y: padT, width: slot, height: plotH, fill: 'transparent', tabindex: '0' });
    const label = new Date(m + '-15').toLocaleDateString('en-US', { month: 'short' });
    const show = (px, py) => showTooltip(px, py,
      new Date(m + '-15').toLocaleDateString('en-US', { month: 'long', year: 'numeric' }),
      series.map((s) => ({ color: s.resolvedColor || s.color, name: s.name, value: fmtUSD(s.values[i] || 0) })));
    hit.addEventListener('pointermove', (ev) => show(ev.clientX, ev.clientY));
    hit.addEventListener('focus', () => {
      const box = hit.getBoundingClientRect();
      show(box.x + box.width / 2, box.y + 20);
    });
    hit.addEventListener('pointerleave', hideTooltip);
    hit.addEventListener('blur', hideTooltip);
    group.appendChild(hit);
    svg.appendChild(group);

    const t = el('text', { x: padL + slot * i + slot / 2, y: H - 8, 'text-anchor': 'middle' });
    t.textContent = label;
    svg.appendChild(t);
  });

  container.appendChild(svg);
}

/* ------------- Line: daily spending with crosshair tooltip ------------- */
export function renderDailyLine(container, points, { color = 'var(--cat-1)', label = 'Spent' } = {}) {
  container.replaceChildren();
  if (points.length === 0) return;
  const W = 640, H = 220, padL = 46, padR = 14, padT = 14, padB = 26;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Daily spending' });

  const maxVal = niceMax(Math.max(1, ...points.map((p) => p.value)));
  const x = (i) => padL + (points.length === 1 ? plotW / 2 : (i / (points.length - 1)) * plotW);
  const y = (v) => padT + plotH - (v / maxVal) * plotH;

  const ticks = 4;
  for (let i = 0; i <= ticks; i++) {
    const v = (maxVal / ticks) * i;
    svg.appendChild(el('line', { x1: padL, x2: W - padR, y1: y(v), y2: y(v), class: i === 0 ? 'baseline' : 'grid-line' }));
    const t = el('text', { x: padL - 8, y: y(v) + 3.5, 'text-anchor': 'end' });
    t.style.fontVariantNumeric = 'tabular-nums';
    t.textContent = fmtCompact(v);
    svg.appendChild(t);
  }

  // x labels: first, last, and a few in between
  const labelEvery = Math.max(1, Math.ceil(points.length / 6));
  points.forEach((p, i) => {
    if (i % labelEvery !== 0 && i !== points.length - 1) return;
    const t = el('text', { x: x(i), y: H - 8, 'text-anchor': 'middle' });
    t.textContent = new Date(p.date + 'T12:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    svg.appendChild(t);
  });

  const lineD = points.map((p, i) => `${i ? 'L' : 'M'} ${x(i).toFixed(1)} ${y(p.value).toFixed(1)}`).join(' ');
  // area wash at ~10% opacity
  const area = el('path', {
    d: `${lineD} L ${x(points.length - 1)} ${y(0)} L ${x(0)} ${y(0)} Z`,
    'fill-opacity': '0.1', stroke: 'none',
  });
  area.style.fill = color;
  svg.appendChild(area);
  const line = el('path', { d: lineD, fill: 'none', 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' });
  line.style.stroke = color;
  svg.appendChild(line);

  // end marker: ≥8px dot with 2px surface ring
  const last = points.length - 1;
  const ring = el('circle', { cx: x(last), cy: y(points[last].value), r: 6 });
  ring.style.fill = 'var(--surface)';
  const dot = el('circle', { cx: x(last), cy: y(points[last].value), r: 4 });
  dot.style.fill = color;
  svg.append(ring, dot);

  // crosshair finds the X
  const crosshair = el('line', { y1: padT, y2: padT + plotH, class: 'baseline', opacity: 0 });
  const hoverRing = el('circle', { r: 6, opacity: 0 });
  hoverRing.style.fill = 'var(--surface)';
  const hoverDot = el('circle', { r: 4, opacity: 0 });
  hoverDot.style.fill = color;
  svg.append(crosshair, hoverRing, hoverDot);

  const hit = el('rect', { x: padL, y: padT, width: plotW, height: plotH, fill: 'transparent' });
  hit.addEventListener('pointermove', (ev) => {
    const box = svg.getBoundingClientRect();
    const mx = ((ev.clientX - box.left) / box.width) * W;
    const i = Math.max(0, Math.min(points.length - 1, Math.round(((mx - padL) / plotW) * (points.length - 1))));
    const px = x(i), py = y(points[i].value);
    crosshair.setAttribute('x1', px); crosshair.setAttribute('x2', px);
    crosshair.setAttribute('opacity', 1);
    for (const [n, cxv, cyv] of [[hoverRing, px, py], [hoverDot, px, py]]) {
      n.setAttribute('cx', cxv); n.setAttribute('cy', cyv); n.setAttribute('opacity', 1);
    }
    showTooltip(ev.clientX, ev.clientY,
      new Date(points[i].date + 'T12:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }),
      [{ color: getComputedStyle(container).getPropertyValue('--cat-1') || color, name: label, value: fmtUSD(points[i].value, { cents: true }) }]);
  });
  hit.addEventListener('pointerleave', () => {
    crosshair.setAttribute('opacity', 0);
    hoverRing.setAttribute('opacity', 0);
    hoverDot.setAttribute('opacity', 0);
    hideTooltip();
  });
  svg.appendChild(hit);
  container.appendChild(svg);
}
