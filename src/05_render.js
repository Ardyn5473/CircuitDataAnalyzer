/* ===========================================================
   Rendering : chart lanes + track map
   =========================================================== */
const LAP_COLORS = ['#38bdf8', '#f87171', '#4ade80', '#fbbf24', '#c084fc', '#f472b6', '#2dd4bf', '#a3e635'];
const CHMETA = {
  speed: { label: 'SPEED', unit: 'km/h', zero: true, dec: 0 },
  gx: { label: 'LONG G  (加速 +)', unit: 'G', sym: true, dec: 2 },
  gy: { label: 'LAT G  (左 +)', unit: 'G', sym: true, dec: 2 },
  gz: { label: 'VERT G', unit: 'G', dec: 2 },
  yaw: { label: 'YAW RATE', unit: 'deg/s', sym: true, dec: 1 },
  gcomb: { label: 'COMBINED G', unit: 'G', zero: true, dec: 2 },
  alt: { label: 'ALTITUDE', unit: 'm', dec: 1 },
  heading: { label: 'HEADING', unit: 'deg', dec: 0 },
  off: { label: 'LINE OFFSET (右 +)', unit: 'm', sym: true, dec: 1 },
  rpm: { label: 'RPM', unit: 'rpm', zero: true, dec: 0 },
  throttle: { label: 'THROTTLE', unit: '%', zero: true, dec: 0 },
  brake: { label: 'BRAKE', unit: '', zero: true, dec: 1 },
  steer: { label: 'STEERING', unit: 'deg', sym: true, dec: 0 },
  watertemp: { label: 'WATER TEMP', unit: '°C', dec: 1 },
  oiltemp: { label: 'OIL TEMP', unit: '°C', dec: 1 },
  gear: { label: 'GEAR', unit: '', zero: true, dec: 0 },
};

function niceStep(range, target) {
  const raw = range / Math.max(1, target);
  const p = Math.pow(10, Math.floor(Math.log10(raw || 1)));
  const n = raw / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
}
function dpiSetup(cv) {
  const r = window.devicePixelRatio || 1;
  const w = cv.clientWidth, h = cv.clientHeight;
  if (cv.width !== Math.round(w * r) || cv.height !== Math.round(h * r)) {
    cv.width = Math.round(w * r); cv.height = Math.round(h * r);
  }
  const g = cv.getContext('2d');
  g.setTransform(r, 0, 0, r, 0, 0);
  return { g, w, h };
}

/* ------------------------------------------------------------------ */
/*  CHART                                                              */
/* ------------------------------------------------------------------ */
function drawChart() {
  const cv = $('#chart'); if (!cv.clientWidth) return;
  const { g, w, h } = dpiSetup(cv);
  g.clearRect(0, 0, w, h);
  g.fillStyle = '#0d1014'; g.fillRect(0, 0, w, h);
  if (!A.C) return;

  const lanesOn = A.channels.filter(c => c.on);
  const showDelta = A.showDelta && A.sel.length > 1;
  const nLane = lanesOn.length + (showDelta ? 1 : 0);
  if (!nLane) { g.fillStyle = '#6c7a8c'; g.font = '13px sans-serif'; g.fillText('Channelsタブでグラフを選択してください', 16, 30); return; }

  const PADL = 46, PADR = 8, AXH = 20, TOP = 2;
  const plotW = Math.max(10, w - PADL - PADR);
  const laneH = Math.max(28, (h - AXH - TOP) / nLane);
  const d0 = A.view.d0, d1 = A.view.d1, dspan = Math.max(1, d1 - d0);
  const X = d => PADL + (d - d0) / dspan * plotW;

  const pairs = A.sel.map(k => ({ key: k, lap: A.lapByKey(k), rl: A.getLap(k), sess: A.sessOf(k) }))
    .filter(p => p.lap && p.rl);
  const refRl = A.refLap != null ? A.getLap(A.refLap) : null;

  /* --- sector / marker verticals --- */
  const verticals = [];
  if (A.showSec) for (const s of A.sectors) verticals.push({ d: s, c: '#3a4655', dash: [4, 4] });
  for (const mk of A.markers) verticals.push({ d: mk.d, c: '#fbbf24', dash: [], lbl: mk.text });
  verticals.push({ d: 0, c: '#e8edf4', dash: [], lbl: 'S/F' });
  if (A.C) verticals.push({ d: A.C.len, c: '#e8edf4', dash: [], lbl: '' });

  let y = TOP;
  const laneRects = [];
  for (let li = 0; li < nLane; li++) {
    const isDelta = showDelta && li === nLane - 1;
    const ch = isDelta ? null : lanesOn[li];
    const meta = isDelta ? { label: 'Δ TIME  vs ' + lapLabel(A.refLap), unit: 's', sym: true, dec: 3 } : CHMETA[ch.key] || { label: ch.key, unit: '', dec: 2 };
    const y0 = y, y1 = y + laneH - 1;
    laneRects.push({ y0, y1, key: isDelta ? '__delta' : ch.key, meta });

    // background
    g.fillStyle = li % 2 ? '#101419' : '#0d1014';
    g.fillRect(PADL, y0, plotW, laneH - 1);

    /* --- gather series --- */
    const series = [];
    if (isDelta) {
      if (refRl) for (let k = 0; k < pairs.length; k++) {
        if (pairs[k].key === A.refLap) continue;
        series.push({ rl: pairs[k].rl, color: LAP_COLORS[k % LAP_COLORS.length], delta: true });
      }
    } else {
      for (let k = 0; k < pairs.length; k++) {
        if (!pairs[k].rl[ch.key]) continue;      // this session has no such channel
        series.push({ rl: pairs[k].rl, color: LAP_COLORS[k % LAP_COLORS.length], key: ch.key });
      }
    }

    /* --- y range over the visible window --- */
    let mn = Infinity, mx = -Infinity;
    for (const s of series) {
      const rl = s.rl, M = rl.M;
      const gi0 = Math.max(0, Math.floor(d0 / rl.step)), gi1 = Math.min(M - 1, Math.ceil(d1 / rl.step));
      for (let i = gi0; i <= gi1; i++) {
        const v = s.delta ? (rl.t[i] - refRl.t[i]) : rl[s.key][i];
        if (!isFinite(v)) continue;
        if (v < mn) mn = v; if (v > mx) mx = v;
      }
    }
    if (!isFinite(mn)) { mn = 0; mx = 1; }
    if (meta.zero) mn = Math.min(0, mn);
    if (meta.sym) { const a = Math.max(Math.abs(mn), Math.abs(mx)) || 1; mn = -a; mx = a; }
    let pad = (mx - mn) * 0.08 || 0.5; mn -= pad; mx += pad;
    const Yv = v => y1 - (v - mn) / (mx - mn) * (y1 - y0);

    // grid + labels
    const stp = niceStep(mx - mn, laneH < 60 ? 2 : 4);
    g.strokeStyle = '#1c232c'; g.lineWidth = 1;
    g.fillStyle = '#5c6a7c'; g.font = '9.5px ui-monospace,monospace'; g.textAlign = 'right';
    for (let v = Math.ceil(mn / stp) * stp; v <= mx; v += stp) {
      const yy = Math.round(Yv(v)) + .5;
      if (yy < y0 + 8 || yy > y1 - 2) continue;
      g.beginPath(); g.moveTo(PADL, yy); g.lineTo(PADL + plotW, yy); g.stroke();
      g.fillText(Math.abs(v) < 1e-9 ? '0' : v.toFixed(meta.dec), PADL - 4, yy + 3);
    }
    // zero line
    if (mn < 0 && mx > 0) {
      g.strokeStyle = '#33404f'; g.beginPath();
      const zy = Math.round(Yv(0)) + .5; g.moveTo(PADL, zy); g.lineTo(PADL + plotW, zy); g.stroke();
    }
    // verticals
    for (const v of verticals) {
      const xx = Math.round(X(v.d)) + .5;
      if (xx < PADL || xx > PADL + plotW) continue;
      g.save(); g.strokeStyle = v.c; g.globalAlpha = .55; g.setLineDash(v.dash);
      g.beginPath(); g.moveTo(xx, y0); g.lineTo(xx, y1); g.stroke(); g.restore();
    }

    /* --- series --- */
    g.save(); g.beginPath(); g.rect(PADL, y0, plotW, laneH - 1); g.clip();
    for (const s of series) {
      const rl = s.rl, M = rl.M;
      const gi0 = Math.max(0, Math.floor(d0 / rl.step) - 1), gi1 = Math.min(M - 1, Math.ceil(d1 / rl.step) + 1);
      const stepPx = (gi1 - gi0) / plotW;
      const skip = Math.max(1, Math.floor(stepPx / 2));
      g.strokeStyle = s.color; g.lineWidth = 1.4; g.lineJoin = 'round'; g.beginPath();
      let started = false;
      for (let i = gi0; i <= gi1; i += skip) {
        const v = s.delta ? (rl.t[i] - refRl.t[i]) : rl[s.key][i];
        if (!isFinite(v)) { started = false; continue; }
        const xx = X(i * rl.step), yy = Yv(v);
        if (!started) { g.moveTo(xx, yy); started = true; } else g.lineTo(xx, yy);
      }
      g.stroke();
    }
    g.restore();

    // lane label
    g.textAlign = 'left';
    g.fillStyle = '#9aa8ba'; g.font = '700 10px sans-serif';
    g.fillText(meta.label, PADL + 5, y0 + 12);
    g.fillStyle = '#5c6a7c'; g.font = '9.5px ui-monospace,monospace';
    g.fillText(meta.unit, PADL + 8 + g.measureText(meta.label).width * 1.02, y0 + 12);

    // top border
    g.strokeStyle = '#232c37'; g.beginPath(); g.moveTo(PADL, y0 + .5); g.lineTo(PADL + plotW, y0 + .5); g.stroke();
    y += laneH;
  }
  A._laneRects = laneRects; A._plot = { PADL, plotW, X, d0, d1, dspan };

  /* --- x axis --- */
  const ay = h - AXH;
  g.fillStyle = '#141920'; g.fillRect(0, ay, w, AXH);
  g.strokeStyle = '#28313d'; g.beginPath(); g.moveTo(0, ay + .5); g.lineTo(w, ay + .5); g.stroke();
  const xs = niceStep(dspan, Math.max(2, Math.floor(plotW / 90)));
  g.fillStyle = '#6c7a8c'; g.font = '10px ui-monospace,monospace'; g.textAlign = 'center';
  for (let v = Math.ceil(d0 / xs) * xs; v <= d1; v += xs) {
    const xx = Math.round(X(v)) + .5;
    g.strokeStyle = '#28313d'; g.beginPath(); g.moveTo(xx, ay); g.lineTo(xx, ay + 4); g.stroke();
    g.fillText(Math.round(v) + 'm', xx, ay + 14);
  }
  // sector labels
  if (A.showSec && A.sectors.length) {
    const bounds = [0, ...A.sectors, A.C.len];
    g.font = '700 9px sans-serif';
    for (let i = 0; i < bounds.length - 1; i++) {
      const mid = (bounds[i] + bounds[i + 1]) / 2;
      if (mid < d0 || mid > d1) continue;
      g.fillStyle = '#4a5867'; g.fillText('S' + (i + 1), X(mid), ay - 2);
    }
  }

  /* --- cursor --- */
  const cx = X(A.cursor);
  if (cx >= PADL - 1 && cx <= PADL + plotW + 1) {
    g.strokeStyle = '#ffffff'; g.globalAlpha = .85; g.lineWidth = 1;
    g.beginPath(); g.moveTo(Math.round(cx) + .5, TOP); g.lineTo(Math.round(cx) + .5, ay); g.stroke();
    g.globalAlpha = 1;
    // value chips
    g.font = '700 10px ui-monospace,monospace';
    for (const lr of laneRects) {
      let yy = lr.y0 + 24;
      for (let k = 0; k < pairs.length; k++) {
        const rl = pairs[k].rl;
        let v;
        if (lr.key === '__delta') { if (!refRl || pairs[k].key === A.refLap) continue; v = sampleAt(rl, A.cursor, 't') - sampleAt(refRl, A.cursor, 't'); }
        else v = sampleAt(rl, A.cursor, lr.key);
        if (!isFinite(v)) continue;
        const txt = (lr.key === '__delta' ? fmtDelta(v) : v.toFixed(lr.meta.dec));
        const tw = g.measureText(txt).width;
        let bx = cx + 5; if (bx + tw + 8 > PADL + plotW) bx = cx - tw - 13;
        g.fillStyle = 'rgba(13,16,20,.85)'; g.fillRect(bx - 2, yy - 9, tw + 6, 12);
        g.fillStyle = LAP_COLORS[k % LAP_COLORS.length]; g.fillText(txt, bx + 1, yy);
        yy += 13;
        if (yy > lr.y1 - 2) break;
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/*  MAP                                                                */
/* ------------------------------------------------------------------ */
function mapFit() {
  const C = A.C; if (!C) return;
  const cv = $('#map'), w = cv.clientWidth || 300, h = cv.clientHeight || 200;
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let i = 0; i < C.M; i++) {
    if (C.x[i] < x0) x0 = C.x[i]; if (C.x[i] > x1) x1 = C.x[i];
    if (C.y[i] < y0) y0 = C.y[i]; if (C.y[i] > y1) y1 = C.y[i];
  }
  const pad = 26;
  const s = Math.min((w - pad * 2) / Math.max(1, x1 - x0), (h - pad * 2) / Math.max(1, y1 - y0));
  A.mapT = { s, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, w, h };
}
function mapXY(x, y) {
  const t = A.mapT;
  return [t.w / 2 + (x - t.cx) * t.s, t.h / 2 - (y - t.cy) * t.s];
}
function mapInv(px, py) {
  const t = A.mapT;
  return [(px - t.w / 2) / t.s + t.cx, -(py - t.h / 2) / t.s + t.cy];
}
function speedColor(v, lo, hi) {
  const f = clamp((v - lo) / Math.max(1, hi - lo), 0, 1);
  const stops = [[56, 60, 220], [56, 189, 248], [74, 222, 128], [251, 191, 36], [248, 113, 113]];
  const x = f * (stops.length - 1), i = Math.min(stops.length - 2, Math.floor(x)), t = x - i;
  const a = stops[i], b = stops[i + 1];
  return `rgb(${a[0] + (b[0] - a[0]) * t | 0},${a[1] + (b[1] - a[1]) * t | 0},${a[2] + (b[2] - a[2]) * t | 0})`;
}

function drawMap() {
  const cv = $('#map'); if (!cv.clientWidth) return;
  const { g, w, h } = dpiSetup(cv);
  g.clearRect(0, 0, w, h);
  g.fillStyle = '#0a0d11'; g.fillRect(0, 0, w, h);
  const C = A.C; if (!C) return;
  if (!A.mapT || A.mapT.w !== w || A.mapT.h !== h) { mapFit(); }
  A.mapT.w = w; A.mapT.h = h;

  /* track band */
  g.lineJoin = g.lineCap = 'round';
  g.strokeStyle = '#1b222c'; g.lineWidth = Math.max(5, 11 * A.mapT.s);
  g.beginPath();
  for (let i = 0; i <= C.M; i++) { const [px, py] = mapXY(C.x[i % C.M], C.y[i % C.M]); i ? g.lineTo(px, py) : g.moveTo(px, py); }
  g.closePath(); g.stroke();
  g.strokeStyle = '#2c3743'; g.lineWidth = 1; g.setLineDash([5, 6]);
  g.beginPath();
  for (let i = 0; i <= C.M; i++) { const [px, py] = mapXY(C.x[i % C.M], C.y[i % C.M]); i ? g.lineTo(px, py) : g.moveTo(px, py); }
  g.closePath(); g.stroke(); g.setLineDash([]);

  /* racing lines */
  const keys = A.sel.filter(k => A.lapByKey(k));
  if (A.mapLine) {
    for (let k = keys.length - 1; k >= 0; k--) {
      const rl = A.getLap(keys[k]); if (!rl) continue;
      const col = LAP_COLORS[k % LAP_COLORS.length];
      const step = Math.max(1, Math.floor(rl.M / 1200));
      if (A.mapColor && rl.speed) {
        let lo = Infinity, hi = -Infinity;
        for (let i = 0; i < rl.M; i++) { const v = rl.speed[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
        g.lineWidth = k === 0 ? 3 : 2;
        for (let i = 0; i < rl.M - step; i += step) {
          const [ax, ay] = mapXY((rl.lon[i] - A.P.lon0) * A.P.kx, (rl.lat[i] - A.P.lat0) * A.P.ky);
          const j = i + step;
          const [bx, by] = mapXY((rl.lon[j] - A.P.lon0) * A.P.kx, (rl.lat[j] - A.P.lat0) * A.P.ky);
          g.strokeStyle = speedColor(rl.speed[i], lo, hi);
          g.beginPath(); g.moveTo(ax, ay); g.lineTo(bx, by); g.stroke();
        }
      } else {
        g.strokeStyle = col; g.lineWidth = k === 0 ? 2.4 : 1.6; g.globalAlpha = k === 0 ? 1 : .8;
        g.beginPath();
        for (let i = 0; i < rl.M; i += step) {
          const [px, py] = mapXY((rl.lon[i] - A.P.lon0) * A.P.kx, (rl.lat[i] - A.P.lat0) * A.P.ky);
          i ? g.lineTo(px, py) : g.moveTo(px, py);
        }
        g.stroke(); g.globalAlpha = 1;
      }
    }
  }

  /* sectors + S/F */
  const markAt = (dist, color, label) => {
    const k = clamp(Math.round(dist / C.len * C.M), 0, C.M - 1);
    const p = (k + 1) % C.M;
    const ex = C.x[p] - C.x[k], ey = C.y[p] - C.y[k], el = Math.hypot(ex, ey) || 1;
    const nx = ey / el * 9, ny = -ex / el * 9;
    const [ax, ay] = mapXY(C.x[k] + nx, C.y[k] + ny);
    const [bx, by] = mapXY(C.x[k] - nx, C.y[k] - ny);
    g.strokeStyle = color; g.lineWidth = 2; g.beginPath(); g.moveTo(ax, ay); g.lineTo(bx, by); g.stroke();
    if (label) { g.fillStyle = color; g.font = '700 9px sans-serif'; g.textAlign = 'center'; g.fillText(label, (ax + bx) / 2, (ay + by) / 2 - 6); }
  };
  if (A.showSec) A.sectors.forEach((s, i) => markAt(s, '#4a5867', 'S' + (i + 2)));
  markAt(0, '#ffffff', 'S/F');
  for (const mk of A.markers) markAt(mk.d, '#fbbf24', '');

  /* cursor position per lap */
  for (let k = keys.length - 1; k >= 0; k--) {
    const rl = A.getLap(keys[k]); if (!rl) continue;
    const la = sampleAt(rl, A.cursor, 'lat'), lo = sampleAt(rl, A.cursor, 'lon');
    if (!isFinite(la)) continue;
    const [px, py] = mapXY((lo - A.P.lon0) * A.P.kx, (la - A.P.lat0) * A.P.ky);
    g.fillStyle = LAP_COLORS[k % LAP_COLORS.length];
    g.strokeStyle = '#04080c'; g.lineWidth = 2;
    g.beginPath(); g.arc(px, py, k === 0 ? 6 : 4.5, 0, 7); g.fill(); g.stroke();
  }

  /* scale bar */
  const target = 60 / A.mapT.s, unit = niceStep(target, 1);
  const bw = unit * A.mapT.s;
  g.strokeStyle = '#3a4655'; g.lineWidth = 2;
  g.beginPath(); g.moveTo(10, h - 12); g.lineTo(10 + bw, h - 12); g.stroke();
  g.fillStyle = '#6c7a8c'; g.font = '9.5px ui-monospace,monospace'; g.textAlign = 'left';
  g.fillText(unit + ' m', 10, h - 16);
}

function redraw() { drawChart(); drawMap(); updateKpi(); }
