/* ===========================================================
   Track engine : centerline / projection / laps / resampling
   =========================================================== */

/* --- build a 1 m-spaced, smoothed, closed centerline from one lap --- */
function buildCenterline(P, i0, i1, step = 1) {
  const xs = [], ys = [];
  for (let i = i0; i <= i1; i++) { xs.push(P.X[i]); ys.push(P.Y[i]); }
  // close the loop
  xs.push(xs[0]); ys.push(ys[0]);
  const m = xs.length;
  const s = new Float64Array(m);
  for (let i = 1; i < m; i++) s[i] = s[i - 1] + Math.hypot(xs[i] - xs[i - 1], ys[i] - ys[i - 1]);
  const total = s[m - 1];
  if (!(total > 100)) throw new Error('コース形状を生成できませんでした。');
  const M = Math.max(50, Math.round(total / step));
  const cx = new Float64Array(M), cy = new Float64Array(M);
  let j = 0;
  for (let k = 0; k < M; k++) {
    const target = total * k / M;
    while (j < m - 2 && s[j + 1] < target) j++;
    const seg = s[j + 1] - s[j];
    const f = seg > 0 ? (target - s[j]) / seg : 0;
    cx[k] = xs[j] + (xs[j + 1] - xs[j]) * f;
    cy[k] = ys[j] + (ys[j + 1] - ys[j]) * f;
  }
  // circular moving-average smoothing (GPS noise)
  const w = 4, sx = new Float64Array(M), sy = new Float64Array(M);
  for (let k = 0; k < M; k++) {
    let ax = 0, ay = 0;
    for (let q = -w; q <= w; q++) { const p = (k + q + M) % M; ax += cx[p]; ay += cy[p]; }
    sx[k] = ax / (2 * w + 1); sy[k] = ay / (2 * w + 1);
  }
  // arc length of the smoothed line
  const d = new Float64Array(M + 1);
  for (let k = 0; k < M; k++) {
    const p = (k + 1) % M;
    d[k + 1] = d[k] + Math.hypot(sx[p] - sx[k], sy[p] - sy[k]);
  }
  const len = d[M];
  // spatial hash for global nearest-segment search
  const cell = 25, grid = new Map();
  for (let k = 0; k < M; k++) {
    const gx = Math.floor(sx[k] / cell), gy = Math.floor(sy[k] / cell);
    const key = gx + ',' + gy;
    let a = grid.get(key); if (!a) grid.set(key, a = []); a.push(k);
  }
  return { M, x: sx, y: sy, d, len, cell, grid };
}

/* --- project one xy onto the centerline; hint = previous segment ----
   This runs once per logged point (hundreds of thousands of times), so the
   segment scan is written as a flat loop over a reusable candidate buffer:
   no closures and no allocation per call. */
let _cand = new Int32Array(1024);
let _bD2 = 0, _bK = 0, _bF = 0;
function _scan(C, x, y, nc) {
  const M = C.M, CX = C.x, CY = C.y;
  for (let q = 0; q < nc; q++) {
    const k = _cand[q], p = k + 1 === M ? 0 : k + 1;
    const ax = CX[k], ay = CY[k];
    const ex = CX[p] - ax, ey = CY[p] - ay;
    const L2 = ex * ex + ey * ey; if (L2 <= 0) continue;
    let f = ((x - ax) * ex + (y - ay) * ey) / L2;
    f = f < 0 ? 0 : f > 1 ? 1 : f;
    const dx = x - (ax + ex * f), dy = y - (ay + ey * f);
    const d2 = dx * dx + dy * dy;
    if (d2 < _bD2) { _bD2 = d2; _bK = k; _bF = f; }
  }
}
function projectXY(C, x, y, hint) {
  const M = C.M;
  _bD2 = Infinity; _bK = 0; _bF = 0;
  /* The centerline is sampled every ~1 m and a lap point advances only a few
     metres per sample, so a narrow window around the previous match is enough.
     Anything it cannot explain (pit lane, stops, data gaps) falls through to the
     spatial-hash search below. */
  if (hint >= 0) {
    const W = 20; let nc = 0;
    for (let q = -W; q <= W; q++) { let k = hint + q; if (k < 0) k += M; else if (k >= M) k -= M; _cand[nc++] = k; }
    _scan(C, x, y, nc);
  }
  if (_bD2 > 900 || hint < 0) {             // > 30 m off : global search
    const gx = Math.floor(x / C.cell), gy = Math.floor(y / C.cell);
    let nc = 0;
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
      const arr = C.grid.get((gx + a) + ',' + (gy + b));
      if (!arr) continue;
      for (let z = 0; z < arr.length; z++) {
        if (nc + 2 > _cand.length) { const g = new Int32Array(_cand.length * 2); g.set(_cand); _cand = g; }
        const k = arr[z];
        _cand[nc++] = k;
        _cand[nc++] = k === 0 ? M - 1 : k - 1;
      }
    }
    _scan(C, x, y, nc);
  }
  const bestD2 = _bD2, bestK = _bK, bestF = _bF;
  const p = (bestK + 1) % M;
  const ex = C.x[p] - C.x[bestK], ey = C.y[p] - C.y[bestK];
  const el = Math.hypot(ex, ey) || 1;
  const px = C.x[bestK] + ex * bestF, py = C.y[bestK] + ey * bestF;
  const off = ((x - px) * (ey / el) - (y - py) * (ex / el));   // + = right of travel
  return { d: C.d[bestK] + el * bestF, off, k: bestK, dist: Math.sqrt(bestD2) };
}

async function projectAll(P, C, onProg) {
  const n = P.n;
  const D = new Float32Array(n), OFF = new Float32Array(n), OK = new Uint8Array(n);
  let hint = -1;
  for (let i = 0; i < n; i++) {
    const r = projectXY(C, P.X[i], P.Y[i], hint);
    D[i] = r.d; OFF[i] = r.off; OK[i] = r.dist < 60 ? 1 : 0;
    hint = r.k;
    if ((i & 32767) === 0) { onProg && onProg(i / n); await yieldToUI(); }
  }
  return { d: D, off: OFF, ok: OK };
}

/* ---------------- control line & lap detection ---------------- */
function makeControlLine(P, lat, lon, headingDeg, width) {
  const x0 = (lon - P.lon0) * P.kx, y0 = (lat - P.lat0) * P.ky;
  const h = headingDeg * Math.PI / 180;
  return { x0, y0, fx: Math.sin(h), fy: Math.cos(h), w: width || 40, lat, lon, heading: headingDeg };
}

function detectLaps(P, CL) {
  const { X, Y, t } = P, sp = P.ch.speed;
  const n = P.n, cross = [];
  const px = CL.fy, py = -CL.fx;             // line direction (perpendicular to travel)
  let uPrev = (X[0] - CL.x0) * CL.fx + (Y[0] - CL.y0) * CL.fy;
  let lastT = -1e9;
  for (let i = 1; i < n; i++) {
    const dx = X[i] - CL.x0, dy = Y[i] - CL.y0;
    const u = dx * CL.fx + dy * CL.fy;
    if (uPrev < 0 && u >= 0) {
      const v = dx * px + dy * py;
      // must cross inside the line width, moving, and travelling roughly with the line's direction
      const vx = X[i] - X[i - 1], vy = Y[i] - Y[i - 1], vl = Math.hypot(vx, vy);
      const along = vl > 0 ? (vx * CL.fx + vy * CL.fy) / vl : 0;
      if (Math.abs(v) <= CL.w / 2 && sp[i] > 5 && along > 0.5) {
        const f = (u - uPrev) !== 0 ? (-uPrev) / (u - uPrev) : 0;
        const tc = t[i - 1] + (t[i] - t[i - 1]) * f;
        if (tc - lastT > 8) { cross.push({ t: tc, i }); lastT = tc; }
      }
    }
    uPrev = u;
  }
  /* drop spurious extra crossings (track crossovers, GPS jitter on the line):
     anything that would produce a lap far shorter than the typical one */
  if (cross.length > 6) {
    const gaps = [];
    for (let k = 0; k < cross.length - 1; k++) gaps.push(cross[k + 1].t - cross[k].t);
    const med = gaps.slice().sort((a, b) => a - b)[gaps.length >> 1];
    const keep = [cross[0]];
    for (let k = 1; k < cross.length; k++) {
      if (cross[k].t - keep[keep.length - 1].t < med * 0.6 && k < cross.length - 1) continue;
      keep.push(cross[k]);
    }
    cross.length = 0; cross.push(...keep);
  }
  const laps = [];
  for (let k = 0; k < cross.length - 1; k++) {
    const a = cross[k], b = cross[k + 1];
    laps.push({ num: k + 1, tStart: a.t, tEnd: b.t, time: b.t - a.t, i0: a.i - 1, i1: b.i });
  }
  return laps;
}

/* auto-guess a control line when the logger gives none */
function guessControlLine(P) {
  const cell = 12, m = new Map(), sp = P.ch.speed;
  for (let i = 0; i < P.n; i++) {
    if (sp[i] < 20) continue;
    const key = Math.floor(P.X[i] / cell) + ',' + Math.floor(P.Y[i] / cell);
    let o = m.get(key); if (!o) m.set(key, o = { c: 0, i: i, s: 0 });
    o.c++; o.s += sp[i];
  }
  let best = null;
  for (const o of m.values()) { const sc = o.c * (o.s / o.c); if (!best || sc > best.sc) best = { ...o, sc }; }
  if (!best) return null;
  const i = best.i;
  return makeControlLine(P, P.lat[i], P.lon[i], P.ch.heading[i], 40);
}

/* ---------------- per-lap stats from raw samples ---------------- */
function lapStats(P, lap) {
  const sp = P.ch.speed, gy = P.ch.gy, gx = P.ch.gx;
  let mx = -1e9, mn = 1e9, sum = 0, c = 0, mlat = 0, mbrk = 0;
  for (let i = Math.max(0, lap.i0); i <= Math.min(P.n - 1, lap.i1); i++) {
    const v = sp[i]; if (!isFinite(v)) continue;
    if (v > mx) mx = v; if (v < mn) mn = v; sum += v; c++;
    if (gy) { const a = Math.abs(gy[i]); if (a > mlat) mlat = a; }
    if (gx) { if (gx[i] < mbrk) mbrk = gx[i]; }
  }
  return { maxSpd: c ? mx : NaN, minSpd: c ? mn : NaN, avgSpd: c ? sum / c : NaN, maxLat: mlat, maxBrake: mbrk };
}

/* ---------------- resample a lap onto the track-distance grid ------- */
function resampleLap(P, C, PR, lap, chKeys, step, smoothM) {
  const L = C.len, M = Math.max(20, Math.round(L / step));
  const i0 = Math.max(0, lap.i0 - 2), i1 = Math.min(P.n - 1, lap.i1 + 2);
  const cnt = i1 - i0 + 1;

  // unwrapped distance relative to the lap start crossing
  const dStart = interpAtTime(P, PR, lap.tStart, L);
  const rel = new Float64Array(cnt), tt = new Float64Array(cnt);
  let prev = 0;
  for (let q = 0; q < cnt; q++) {
    const i = i0 + q;
    let r0 = PR.d[i] - dStart;
    r0 = ((r0 % L) + L) % L;                       // wrapped into [0, L)
    let r;
    if (q === 0) r = r0 > L * 0.5 ? r0 - L : r0;   // the first samples sit just *before* the line
    else {
      r = r0 + Math.round((prev - r0) / L) * L;    // lift to the branch nearest the previous sample
      if (r < prev) r = prev;                      // keep it monotonic through GPS jitter
    }
    prev = r; rel[q] = r; tt[q] = P.t[i] - lap.tStart;
  }

  const out = {
    M, step, L, tEnd: lap.time, num: lap.num,
    t: new Float32Array(M), lat: new Float32Array(M), lon: new Float32Array(M), off: new Float32Array(M)
  };
  for (const k of chKeys) out[k] = new Float32Array(M);

  let p = 0;
  for (let g = 0; g < M; g++) {
    const target = g * step;
    while (p < cnt - 2 && rel[p + 1] < target) p++;
    const span = rel[p + 1] - rel[p];
    const f = span > 1e-9 ? clamp((target - rel[p]) / span, 0, 1) : 0;
    const a = i0 + p, b = i0 + p + 1;
    out.t[g] = tt[p] + (tt[p + 1] - tt[p]) * f;
    out.lat[g] = P.lat[a] + (P.lat[b] - P.lat[a]) * f;
    out.lon[g] = P.lon[a] + (P.lon[b] - P.lon[a]) * f;
    out.off[g] = PR.off[a] + (PR.off[b] - PR.off[a]) * f;
    for (const k of chKeys) {
      const A = P.ch[k]; if (!A) continue;
      if (k === 'heading') {
        let dh = A[b] - A[a]; dh = ((dh + 540) % 360) - 180;
        out[k][g] = (A[a] + dh * f + 360) % 360;
      } else out[k][g] = A[a] + (A[b] - A[a]) * f;
    }
  }
  // make elapsed time strictly increasing
  for (let g = 1; g < M; g++) if (!(out.t[g] > out.t[g - 1])) out.t[g] = out.t[g - 1] + 1e-4;

  if (smoothM > 1) {
    const w = Math.floor(smoothM / 2);
    for (const k of chKeys) {
      if (k === 'heading') continue;
      out[k] = circSmooth(out[k], w);
    }
  }
  return out;
}

function circSmooth(a, w) {
  const M = a.length, o = new Float32Array(M), n = 2 * w + 1;
  let s = 0;
  for (let q = -w; q <= w; q++) s += a[(q + M) % M];
  for (let i = 0; i < M; i++) { o[i] = s / n; s -= a[(i - w + M) % M]; s += a[(i + w + 1) % M]; }
  return o;
}

/* Track distance at an arbitrary instant. The value is circular: a lap start
   usually falls between a sample just BEFORE the finish line (d ~ L) and one
   just after (d ~ 0). Interpolating those directly walks backwards around the
   whole lap, which silently rotates that lap's distance axis, so interpolate
   along the short way round and wrap the result. */
function interpAtTime(P, PR, tq, L) {
  let lo = 0, hi = P.n - 1;
  while (lo < hi - 1) { const m = (lo + hi) >> 1; if (P.t[m] <= tq) lo = m; else hi = m; }
  const span = P.t[hi] - P.t[lo];
  const f = span > 0 ? clamp((tq - P.t[lo]) / span, 0, 1) : 0;
  const a = PR.d[lo];
  let d = PR.d[hi] - a;
  if (L > 0) d -= L * Math.round(d / L);
  const v = a + d * f;
  return L > 0 ? ((v % L) + L) % L : v;
}

/* sample a resampled lap at an arbitrary distance.
   Channels wrap around the lap; elapsed time does not - it is clamped to
   [0, lapTime] so that sector splits taken at the finish line stay exact. */
function sampleAt(rl, dist, key) {
  const A = rl[key]; if (!A) return NaN;
  const M = rl.M, step = rl.step;
  if (key === 't') {
    const g = clamp(dist, 0, rl.L) / step;
    const last = M - 1;
    if (g >= last) {                                  // tail segment: last node -> finish line
      const w = rl.L / step - last;
      return w > 1e-9 ? A[last] + (rl.tEnd - A[last]) * clamp((g - last) / w, 0, 1) : rl.tEnd;
    }
    const i = Math.floor(g);
    return A[i] + (A[i + 1] - A[i]) * (g - i);
  }
  const g = dist / step, i = Math.floor(g), f = g - i;
  const a = ((i % M) + M) % M, b = (a + 1) % M;
  return A[a] + (A[b] - A[a]) * f;
}
