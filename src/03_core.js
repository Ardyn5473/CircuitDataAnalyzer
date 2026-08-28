/* ===========================================================
   Circuit Data Analyzer  -  core / parser / normalizer
   =========================================================== */
'use strict';
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const R_EARTH = 6378137.0;
const G0 = 9.80665;
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const sleep = (ms = 0) => new Promise(r => setTimeout(r, ms));

/* Yield to the event loop so progress can paint during a long import.
   setTimeout is clamped hard (100s of ms) in background or non-compositing
   tabs, which would turn a 1 s import into 10 s; a MessageChannel task is not
   throttled that way. */
function yieldToUI() {
  return new Promise(res => {
    if (typeof MessageChannel !== 'function') return setTimeout(res, 0);
    const c = new MessageChannel();
    c.port1.onmessage = () => { c.port1.close(); c.port2.close(); res(); };
    c.port2.postMessage(0);
  });
}

function fmtTime(s) {
  if (s == null || !isFinite(s)) return '—';
  const neg = s < 0; s = Math.abs(s);
  const m = Math.floor(s / 60), r = s - m * 60;
  return (neg ? '-' : '') + (m > 0 ? m + ':' + r.toFixed(3).padStart(6, '0') : r.toFixed(3));
}
function fmtDelta(s) {
  if (s == null || !isFinite(s)) return '—';
  return (s >= 0 ? '+' : '') + s.toFixed(3);
}
function toast(msg, ms = 2200) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), ms);
}
function progress(msg, pct) {
  $('#prog').textContent = msg || '';
  $('#bar i').style.width = (pct == null ? 0 : clamp(pct, 0, 100)) + '%';
}
function showErr(msg) {
  const e = $('#err'); e.textContent = msg; e.classList.remove('hide'); progress('', 0);
}

/* ---------------- minimal ZIP reader (stored + deflate) ---------------- */
async function unzip(buf) {
  const dv = new DataView(buf), u8 = new Uint8Array(buf);
  let eocd = -1;
  for (let i = u8.length - 22; i >= 0 && i > u8.length - 66000; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('ZIPの中身を読み取れませんでした。');
  const nEnt = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const out = [];
  const dec = new TextDecoder('utf-8');
  for (let i = 0; i < nEnt; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const nLen = dv.getUint16(p + 28, true), eLen = dv.getUint16(p + 30, true), cLen = dv.getUint16(p + 32, true);
    const lho = dv.getUint32(p + 42, true);
    const name = dec.decode(u8.subarray(p + 46, p + 46 + nLen));
    p += 46 + nLen + eLen + cLen;
    if (name.endsWith('/')) continue;
    const lnLen = dv.getUint16(lho + 26, true), leLen = dv.getUint16(lho + 28, true);
    const start = lho + 30 + lnLen + leLen;
    const raw = u8.subarray(start, start + csize);
    let data;
    if (method === 0) data = raw;
    else if (method === 8) {
      if (typeof DecompressionStream !== 'function') throw new Error('このブラウザはZIP解凍に対応していません。CSVを直接お選びください。');
      const ds = new DecompressionStream('deflate-raw');
      const ab = await new Response(new Blob([raw]).stream().pipeThrough(ds)).arrayBuffer();
      data = new Uint8Array(ab);
    } else continue;
    out.push({ name: name.split('/').pop(), bytes: data });
  }
  return out;
}

/* ---------------- text decode (UTF-8 / BOM / Shift_JIS fallback) ------- */
function decodeText(bytes) {
  let b = bytes;
  if (b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF) b = b.subarray(3);
  let s = new TextDecoder('utf-8', { fatal: false }).decode(b);
  if (s.indexOf('\uFFFD') >= 0) {          // U+FFFD = it was not UTF-8
    try { s = new TextDecoder('shift_jis').decode(b); } catch (e) { }
  }
  return s;
}

/* ---------------- CSV ---------------- */
function splitLine(line) {
  if (line.indexOf('"') < 0) return line.split(',');
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur); return out;
}
function csvLines(text) {
  const raw = text.split(/\r\n|\n|\r/);
  while (raw.length && raw[raw.length - 1].trim() === '') raw.pop();
  return raw;
}
function parseCsvSmall(text) {
  const L = csvLines(text);
  if (!L.length) return { head: [], rows: [] };
  const head = splitLine(L[0]).map(s => s.trim().replace(/^\uFEFF/, ''));
  const rows = [];
  for (let i = 1; i < L.length; i++) {
    if (!L[i]) continue;
    const c = splitLine(L[i]); const o = {};
    for (let j = 0; j < head.length; j++) o[head[j]] = c[j] === undefined ? '' : c[j];
    rows.push(o);
  }
  return { head, rows };
}

/* ---------------- channel dictionary ---------------- */
/* aliases are matched lowercased with non-alphanumerics stripped */
const FIELD_DEFS = [
  { key: 'id', label: '行ID', al: ['id'] },
  { key: 'lat', label: '緯度 Latitude', req: true, al: ['lat', 'latitude', 'gpslatitude', 'ido'] },
  { key: 'lon', label: '経度 Longitude', req: true, al: ['lon', 'lng', 'long', 'longitude', 'gpslongitude', 'keido'] },
  { key: 'time', label: '時刻 Time', al: ['time', 'timestamp', 'utc', 'gpstime', 'datetime', 'secs', 'seconds', 'localtime'] },
  { key: 'ms', label: 'ミリ秒 Milliseconds', al: ['ms', 'millis', 'milliseconds', 'msec'] },
  { key: 'speed', label: '速度 Speed', al: ['speed', 'velocity', 'gpsspeed', 'vehiclespeed', 'spd', 'sokudo'] },
  { key: 'alt', label: '高度 Altitude', al: ['altitude', 'alt', 'height', 'elevation', 'ele'] },
  { key: 'heading', label: '方位 Heading', al: ['heading', 'course', 'bearing', 'track', 'dir'] },
  { key: 'gx', label: '前後G Longitudinal', al: ['gx', 'accelx', 'accx', 'axisx', 'longitudinalg', 'longg', 'longacc', 'ax'] },
  { key: 'gy', label: '横G Lateral', al: ['gy', 'accely', 'accy', 'axisy', 'lateralg', 'latg', 'latacc', 'ay'] },
  { key: 'gz', label: '上下G Vertical', al: ['gz', 'accelz', 'accz', 'axisz', 'verticalg', 'vertg', 'az'] },
  { key: 'yaw', label: 'ヨーレート Yaw rate', al: ['gyroz', 'yawrate', 'yaw', 'rz', 'wz', 'gyrz'] },
  { key: 'rpm', label: 'エンジン回転 RPM', al: ['rpm', 'enginerpm', 'engspeed'] },
  { key: 'throttle', label: 'スロットル Throttle', al: ['throttle', 'tps', 'accelpedal'] },
  { key: 'brake', label: 'ブレーキ Brake', al: ['brake', 'brakepressure', 'brk'] },
  { key: 'steer', label: 'ステアリング Steering', al: ['steering', 'steer', 'steeringangle', 'sas'] },
  { key: 'watertemp', label: '水温 Water temp', al: ['watertemp', 'coolanttemp', 'wt'] },
  { key: 'oiltemp', label: '油温 Oil temp', al: ['oiltemp', 'ot'] },
  { key: 'gear', label: 'ギア Gear', al: ['gear'] },
];
const norm = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');

function autoMap(head) {
  const used = new Set(), map = {};
  const H = head.map(norm);
  for (const f of FIELD_DEFS) {
    for (const a of f.al) {
      const i = H.indexOf(a);
      if (i >= 0 && !used.has(i)) { map[f.key] = i; used.add(i); break; }
    }
  }
  return map;
}

/* unit heuristics -------------------------------------------------- */
/* A single outlier sample must never decide a unit, so these look at the
   99th percentile rather than the maximum. */
function pct99(vals, abs) {
  const a = [];
  for (let i = 0; i < vals.length; i += 3) {
    const v = abs ? Math.abs(vals[i]) : vals[i];
    if (isFinite(v)) a.push(v);
  }
  if (!a.length) return 0;
  a.sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.floor(a.length * 0.99))];
}

/* Speed magnitude alone is ambiguous (25 m/s and 25 km/h are both plausible on a
   short circuit), so calibrate the column against GPS-derived speed instead. */
const SPEED_UNITS = [{ f: 1, u: 'km/h' }, { f: 3.6, u: 'm/s' }, { f: 1.609344, u: 'mph' }, { f: 1.852, u: 'kn' }];
function speedFactor(vals, ref) {
  const r = [];
  if (ref) for (let i = 0; i < vals.length; i += 7) {
    const v = vals[i], g = ref[i];
    if (!isFinite(v) || v <= 0 || !isFinite(g) || g < 25) continue;   // only clearly-moving samples
    r.push(g / v);
  }
  if (r.length < 30) {                                               // no usable GPS reference
    const p = pct99(vals, true);
    return p > 0 && p < 12 ? 3.6 : 1;
  }
  r.sort((a, b) => a - b);
  const med = r[r.length >> 1];
  let best = SPEED_UNITS[0];
  for (const c of SPEED_UNITS) if (Math.abs(Math.log(c.f / med)) < Math.abs(Math.log(best.f / med))) best = c;
  return best.f;
}
function accelFactor(vals) {          // -> G
  return pct99(vals, true) > 6 ? 1 / G0 : 1;                         // > 6 means m/s^2
}
function gyroFactor(vals) {           // -> deg/s
  const p = pct99(vals, true);
  return p > 0 && p < 8 ? 180 / Math.PI : 1;                         // < 8 means rad/s
}

/* parse a HH:MM:SS(.mmm) / ISO / epoch time cell into seconds --------- */
function parseTimeCell(s) {
  if (s === '' || s == null) return NaN;
  const n = +s;
  if (isFinite(n) && String(s).indexOf(':') < 0 && String(s).indexOf('-') < 0) return n;
  const iso = Date.parse(s);
  if (isFinite(iso)) return iso / 1000;
  const m = String(s).match(/(\d{1,2}):(\d{2}):(\d{2}(?:\.\d+)?)/);
  if (m) return (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]);
  return NaN;
}

/* ============================================================
   Build normalized session from a big point CSV
   ============================================================ */
async function buildPoints(text, map, onProg) {
  const L = csvLines(text);
  const nRows = L.length - 1;
  if (nRows < 20) throw new Error('データ行が足りません（20行以上必要）。');

  const cols = {};
  for (const k in map) if (map[k] >= 0) cols[k] = map[k];
  if (cols.lat === undefined || cols.lon === undefined) throw new Error('NOLATLON');

  const keys = Object.keys(cols);
  const arr = {};
  for (const k of keys) arr[k] = new Float64Array(nRows);

  /* Sniff the timestamp format once instead of re-testing it on every one of
     hundreds of thousands of rows. */
  let timeConv = parseTimeCell;
  if (cols.time !== undefined) {
    let sample = '';
    for (let i = 1; i <= nRows && !sample; i++) if (L[i]) sample = (splitLine(L[i])[cols.time] || '').trim();
    if (/^-?\d+(\.\d+)?$/.test(sample)) timeConv = s => { const v = +s; return v === v ? v : parseTimeCell(s); };
  }

  /* Hot loop: flatten the column map into parallel indexed arrays so the inner
     loop does no object-property lookups and allocates no iterators per row. */
  const nk = keys.length;
  const colIdx = new Int32Array(nk);
  const dest = new Array(nk);
  let timeK = -1;
  for (let j = 0; j < nk; j++) {
    colIdx[j] = cols[keys[j]];
    dest[j] = arr[keys[j]];
    if (keys[j] === 'time') timeK = j;
  }
  const latC = cols.lat, lonC = cols.lon;

  const CH = 20000;
  let n = 0;
  for (let i = 1; i <= nRows; i++) {
    const line = L[i];
    if (!line) continue;
    const c = splitLine(line);
    const la = +c[latC], lo = +c[lonC];
    if (!isFinite(la) || !isFinite(lo) || (la === 0 && lo === 0) || Math.abs(la) > 90) continue;
    for (let j = 0; j < nk; j++) {
      const raw = c[colIdx[j]];
      dest[j][n] = j === timeK ? timeConv(raw)
        : (raw === '' || raw === undefined ? NaN : +raw);
    }
    n++;
    if (i % CH === 0) { onProg && onProg(i / nRows); await yieldToUI(); }
  }
  if (n < 20) throw new Error('有効なGPS点が見つかりませんでした。緯度・経度の列を確認してください。');
  for (const k of keys) arr[k] = arr[k].subarray(0, n);

  /* ---- time base ---- */
  let t = new Float64Array(n);
  if (arr.time) {
    const ms = arr.ms;
    for (let i = 0; i < n; i++) t[i] = arr.time[i] + (ms ? (isFinite(ms[i]) ? ms[i] / 1000 : 0) : 0);
    // detect midnight rollover for HH:MM:SS sources
    for (let i = 1; i < n; i++) if (t[i] < t[i - 1] - 3600) for (let j = i; j < n; j++) t[j] += 86400;
    let bad = 0; for (let i = 1; i < n; i++) if (!(t[i] > t[i - 1])) bad++;
    if (bad > n * 0.3) t = null;
  } else t = null;
  if (!t) { t = new Float64Array(n); for (let i = 0; i < n; i++) t[i] = i * 0.1; }

  /* ---- local metric frame ---- */
  let lat0 = 0, lon0 = 0;
  for (let i = 0; i < n; i++) { lat0 += arr.lat[i]; lon0 += arr.lon[i]; }
  lat0 /= n; lon0 /= n;
  const kx = Math.cos(lat0 * Math.PI / 180) * R_EARTH * Math.PI / 180, ky = R_EARTH * Math.PI / 180;
  const X = new Float64Array(n), Y = new Float64Array(n);
  for (let i = 0; i < n; i++) { X[i] = (arr.lon[i] - lon0) * kx; Y[i] = (arr.lat[i] - lat0) * ky; }

  /* ---- speed (GPS-derived first: it is unit-unambiguous and calibrates the column) ---- */
  const gpsSpeed = new Float32Array(n);
  for (let i = 1; i < n - 1; i++) {
    const dt = t[i + 1] - t[i - 1];
    gpsSpeed[i] = dt > 0 ? Math.hypot(X[i + 1] - X[i - 1], Y[i + 1] - Y[i - 1]) / dt * 3.6 : 0;
  }
  if (n > 2) { gpsSpeed[0] = gpsSpeed[1]; gpsSpeed[n - 1] = gpsSpeed[n - 2]; }

  let speed, speedUnit = 'GPS';
  if (arr.speed) {
    const f = speedFactor(arr.speed, gpsSpeed);
    speedUnit = (SPEED_UNITS.find(c => c.f === f) || {}).u || 'km/h';
    speed = new Float32Array(n);
    for (let i = 0; i < n; i++) speed[i] = arr.speed[i] * f;
  } else speed = gpsSpeed;

  /* ---- heading (measured or derived) ---- */
  const heading = new Float32Array(n);
  if (arr.heading) for (let i = 0; i < n; i++) heading[i] = arr.heading[i];
  else {
    for (let i = 1; i < n; i++) {
      const dx = X[i] - X[i - 1], dy = Y[i] - Y[i - 1];
      heading[i] = (dx || dy) ? (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360 : heading[i - 1];
    }
    heading[0] = heading[1];
  }

  /* ---- accelerations ---- */
  const ch = {}, units = {};
  const put = (k, a, u) => { ch[k] = a; units[k] = u; };
  put('speed', speed, 'km/h');
  put('heading', heading, 'deg');
  for (const [k, u] of [['gx', 'G'], ['gy', 'G'], ['gz', 'G']]) {
    if (!arr[k]) continue;
    const f = accelFactor(arr[k]); const a = new Float32Array(n);
    for (let i = 0; i < n; i++) a[i] = arr[k][i] * f;
    put(k, a, u);
  }
  if (arr.alt) { const a = new Float32Array(n); for (let i = 0; i < n; i++) a[i] = arr.alt[i]; put('alt', a, 'm'); }

  /* ---- yaw rate: sensor if present, otherwise derived from heading ---- */
  let yawDerived = false;
  if (arr.yaw) {
    const f = gyroFactor(arr.yaw); const a = new Float32Array(n);
    for (let i = 0; i < n; i++) a[i] = arr.yaw[i] * f;
    put('yaw', a, 'deg/s');
  } else {
    /* GPS course is meaningless when the car is barely moving, and differentiating
       it there produces huge fake yaw spikes - gate on speed and clamp to a rate a
       car can physically reach. */
    const a = new Float32Array(n);
    for (let i = 1; i < n - 1; i++) {
      const dt = t[i + 1] - t[i - 1];
      if (dt <= 0 || speed[i] < 8) { a[i] = 0; continue; }
      let dh = heading[i + 1] - heading[i - 1];
      dh = ((dh + 540) % 360) - 180;
      a[i] = clamp(dh / dt, -200, 200);
    }
    if (n > 2) { a[0] = a[1]; a[n - 1] = a[n - 2]; }
    put('yaw', a, 'deg/s'); yawDerived = true;
  }

  /* ---- optional extra channels ---- */
  for (const [k, u] of [['rpm', 'rpm'], ['throttle', '%'], ['brake', ''], ['steer', 'deg'],
  ['watertemp', '°C'], ['oiltemp', '°C'], ['gear', '']]) {
    if (!arr[k]) continue;
    const a = new Float32Array(n); for (let i = 0; i < n; i++) a[i] = arr[k][i];
    put(k, a, u);
  }

  /* ---- combined G ---- */
  if (ch.gx && ch.gy) {
    const a = new Float32Array(n);
    for (let i = 0; i < n; i++) a[i] = Math.hypot(ch.gx[i], ch.gy[i]);
    put('gcomb', a, 'G');
  }

  /* ---- original row ids (used to map logger lap tables back to points) ---- */
  let ids = null;
  if (arr.id) { ids = new Int32Array(n); for (let i = 0; i < n; i++) ids[i] = arr.id[i]; }

  const hz = n > 2 ? 1 / Math.max(1e-6, (t[n - 1] - t[0]) / (n - 1)) : 10;
  return { n, t, lat: arr.lat, lon: arr.lon, X, Y, lat0, lon0, kx, ky, ch, units, hz, yawDerived, id: ids, speedUnit };
}
