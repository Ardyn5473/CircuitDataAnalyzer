/* ===========================================================
   Application state, loading pipeline, UI
   =========================================================== */
/* Multiple sessions can be loaded at once so different days can be overlaid.
   sessions[0] is the base: its centerline defines the shared Track Distance
   axis, and every other session is projected onto that same centerline -
   otherwise the distance axes would not line up and comparison is meaningless.
   A lap is addressed by the key "<sessionIndex>:<lapNumber>". */
const A = {
  sessions: [], _cache: new Map(),
  sel: [], refLap: null, cursor: 0, view: { d0: 0, d1: 1000 },
  sectors: [], markers: [], channels: [],
  showSec: true, showDelta: true, mapLine: true, mapColor: false,
  mapT: null, playing: false, sid: 'default',
  step: 1, smooth: 5, invGx: false, invGy: false, gzGrav: true,
  loadMode: 'replace',

  get base() { return this.sessions[0] || null; },
  get P() { return this.sessions[0] ? this.sessions[0].P : null; },
  get C() { return this.sessions[0] ? this.sessions[0].C : null; },
  get PR() { return this.sessions[0] ? this.sessions[0].PR : null; },
  get laps() { return this.sessions[0] ? this.sessions[0].laps : []; },
  get meta() { return this.sessions[0] ? this.sessions[0].meta : {}; },

  key(si, num) { return si + ':' + num; },
  siOf(k) { const i = String(k).indexOf(':'); return i < 0 ? -1 : +String(k).slice(0, i); },
  numOf(k) { const i = String(k).indexOf(':'); return i < 0 ? NaN : +String(k).slice(i + 1); },
  sessOf(k) { return this.sessions[this.siOf(k)] || null; },
  lapByKey(k) {
    const s = this.sessOf(k); if (!s) return null;
    const n = this.numOf(k);
    return s.laps.find(l => l.num === n) || null;
  },
  /* every session resamples against the SHARED base centerline */
  getLap(k) {
    const ck = k + '|' + this.smooth + '|' + this.invGx + this.invGy + this.gzGrav;
    let v = this._cache.get(ck);
    if (v) return v;
    const s = this.sessOf(k), lap = this.lapByKey(k), C = this.C;
    if (!s || !lap || !C || !s.PR || !s.P) return null;
    v = resampleLap(s.P, C, s.PR, lap, Object.keys(s.P.ch), this.step, this.smooth);
    v.sessionIndex = this.siOf(k); v.key = k;
    if (this._cache.size > 60) this._cache.clear();
    this._cache.set(ck, v);
    return v;
  },
  allLapKeys() {
    const out = [];
    this.sessions.forEach((s, si) => s.laps.forEach(l => out.push(this.key(si, l.num))));
    return out;
  },
  bestTimeAll() {
    let b = Infinity;
    for (const s of this.sessions) for (const l of s.laps) if (l.valid && l.time < b) b = l.time;
    return isFinite(b) ? b : NaN;
  },
  clearCache() { this._cache.clear(); },
};

/* ---------------- G sign / gravity transforms ---------------- */
function applyTransforms() {
  for (const s of A.sessions) {
    const P = s.P; if (!P || !P.raw) continue;
    if (P.raw.gx) { const k = A.invGx ? -1 : 1, a = P.ch.gx, r = P.raw.gx; for (let i = 0; i < P.n; i++) a[i] = r[i] * k; }
    if (P.raw.gy) { const k = A.invGy ? -1 : 1, a = P.ch.gy, r = P.raw.gy; for (let i = 0; i < P.n; i++) a[i] = r[i] * k; }
    if (P.raw.gz) { const o = A.gzGrav ? 1 : 0, a = P.ch.gz, r = P.raw.gz; for (let i = 0; i < P.n; i++) a[i] = r[i] - o; }
    if (P.ch.gcomb && P.ch.gx && P.ch.gy) { const a = P.ch.gcomb; for (let i = 0; i < P.n; i++) a[i] = Math.hypot(P.ch.gx[i], P.ch.gy[i]); }
  }
  A.clearCache();
}

/* =====================  LOADING  ===================== */
const isCsv = n => /\.(csv|txt)$/i.test(n);

async function collectFiles(fileList) {
  const out = [];
  for (const f of fileList) {
    const buf = await f.arrayBuffer();
    if (/\.zip$/i.test(f.name)) {
      progress('ZIPを展開しています…', 5);
      const items = await unzip(buf);
      const g = f.name.replace(/\.zip$/i, '');
      for (const it of items) if (isCsv(it.name)) out.push({ name: it.name, text: decodeText(it.bytes), group: g });
    } else if (isCsv(f.name)) {
      out.push({ name: f.name, text: decodeText(new Uint8Array(buf)), group: '' });
    }
  }
  return out;
}

function classify(files) {
  const r = { points: null, lapCsv: null, beacon: null, info: [], others: [], extraPoints: [] };
  for (const f of files) {
    const nl = f.text.indexOf('\n');
    const head = splitLine(f.text.slice(0, nl < 0 ? 400 : nl).replace(/^\uFEFF/, '').trim()).map(norm);
    f.head = head;
    const has = k => head.indexOf(k) >= 0;
    if (has('startwp') && has('finishwp') && has('duration')) { if (!r.lapCsv || /lap/i.test(f.name)) r.lapCsv = f; }
    else if (has('lat') && has('lon') && has('heading') && has('width')) r.beacon = f;
    else if (head.length === 2 && has('name') && has('value')) r.info.push(f);
    else if ((has('lat') || has('latitude') || has('gpslatitude')) && (has('lon') || has('longitude') || has('lng') || has('gpslongitude'))) {
      if (!r.points) r.points = f;
      else if (f.text.length > r.points.text.length) { r.extraPoints.push(r.points); r.points = f; }
      else r.extraPoints.push(f);
    } else r.others.push(f);
  }
  if (!r.points) {
    let big = null;
    for (const f of files) if (!big || f.text.length > big.text.length) big = f;
    r.points = big;
  }
  return r;
}

/* Split a drop into one group per source archive so that dropping two days'
   ZIPs at once yields two sessions instead of silently keeping the larger. */
function classifyGroups(files) {
  const byGroup = new Map();
  for (const f of files) {
    const g = f.group || '';
    let a = byGroup.get(g); if (!a) byGroup.set(g, a = []);
    a.push(f);
  }
  return [...byGroup.entries()].map(([g, fs]) => ({ group: g, ...classify(fs) })).filter(s => s.points);
}

function readInfo(files) {
  const kv = {};
  for (const f of files) for (const row of parseCsvSmall(f.text).rows) if (row.name) kv[row.name] = row.value;
  return kv;
}

async function loadFiles(fileList, mode) {
  $('#err').classList.add('hide');
  try {
    progress('ファイルを読み込んでいます…', 2);
    const files = await collectFiles(fileList);
    if (!files.length) throw new Error('CSVファイルが見つかりませんでした。');
    const groups = classifyGroups(files);
    if (!groups.length) throw new Error('走行データのCSVが見つかりませんでした。');

    let add = (mode || A.loadMode) === 'add' && A.sessions.length > 0;
    const skipped = [];
    for (const set of groups) {
      for (const x of set.extraPoints) skipped.push(x.name);
      const headRaw = splitLine(csvLines(set.points.text)[0].replace(/^\uFEFF/, '')).map(s => s.trim());
      let map = autoMap(headRaw);
      if (map.lat === undefined || map.lon === undefined) {
        progress('', 0);
        const m = await askMapping(headRaw, map);
        if (!m) { progress('', 0); return; }
        map = m;
      }
      await ingest(set, headRaw, map, add);
      add = true;                 // further groups in the same drop are added, never replacing
    }
    if (skipped.length) toast('走行データが複数あったため ' + skipped.join(', ') + ' は読み込んでいません', 5000);
    A.loadMode = 'replace';                 // the add-mode is a one-shot, set by the +比較 button
  } catch (e) {
    console.error(e);
    $('#drop').classList.remove('hide');          // the message lives on the loader, so make sure it is visible
    $('#dropClose').classList.toggle('hide', !A.C);
    showErr(friendlyError(e));
  }
}

function friendlyError(e) {
  const m = String(e && e.message || e);
  if (m === 'NOLATLON') return 'GPSデータを検出できませんでした。\n確認してください：\n・緯度(Latitude)の列\n・経度(Longitude)の列\n・CSVの文字コード';
  return m + '\n\n読み込むファイルを確認してください。';
}

/* Everything below is built into locals first and only committed to A once the
   whole import has succeeded. A half-applied import (new points, old laps and
   projection) would leave every array index out of range. */
async function ingest(set, headRaw, map, join) {
  const joining = !!join && A.sessions.length > 0;
  progress('走行データを解析しています…', 10);
  const P = await buildPoints(set.points.text, map, f => progress('走行データを解析しています… ' + Math.round(f * 100) + '%', 10 + f * 35));
  P.raw = {};
  for (const k of ['gx', 'gy', 'gz']) if (P.ch[k]) P.raw[k] = P.ch[k].slice();

  /* A joined session must be expressed in the base session's metric frame,
     otherwise its X/Y are relative to a different origin and the shared
     centerline is meaningless. */
  if (joining) {
    const B = A.sessions[0].P;
    P.lat0 = B.lat0; P.lon0 = B.lon0; P.kx = B.kx; P.ky = B.ky;
    for (let i = 0; i < P.n; i++) {
      P.X[i] = (P.lon[i] - B.lon0) * B.kx;
      P.Y[i] = (P.lat[i] - B.lat0) * B.ky;
    }
  }

  /* ---- metadata ---- */
  const info = readInfo(set.info);
  const meta = {
    track: info['C/B_name'] || info['track'] || '—',
    model: info['model'] || '',
    file: set.points.name,
    freq: info['frequency'] || Math.round(P.hz),
    raceType: info['RaceType'] || '',
  };

  /* ---- laps ---- */
  progress('ラップを検出しています…', 48);
  let laps = null, lapSrc = '';
  if (set.lapCsv && map.id !== undefined && P.id) {
    laps = lapsFromCsv(P, set.lapCsv); if (laps && laps.length) lapSrc = 'ロガーのラップ情報';
  }
  let CL = null;
  if (set.beacon) {
    const b = parseCsvSmall(set.beacon.text).rows[0];
    if (b) CL = makeControlLine(P, +b.lat, +b.lon, +b.heading, Math.max(20, +b.width || 40));
  }
  if ((!laps || laps.length < 1) && joining && A.controlLine) {
    CL = makeControlLine(P, A.controlLine.lat, A.controlLine.lon, A.controlLine.heading, A.controlLine.w);
    laps = detectLaps(P, CL); if (laps.length) lapSrc = '基準セッションのライン';
  }
  if (!laps || laps.length < 1) {
    if (!CL) CL = guessControlLine(P);
    if (CL) { laps = detectLaps(P, CL); lapSrc = set.beacon ? 'ビーコン位置' : '自動推定'; }
  }
  if (!laps || !laps.length) throw new Error('ラップを検出できませんでした。\n走行していない区間だけのデータか、コース形状を読み取れない可能性があります。');

  /* mark abnormal laps (pit in/out, red flag). Traffic can cost ~10-15% in an
     endurance stint, so 1.3x median keeps racing laps but rejects pit laps. */
  const times = laps.map(l => l.time).slice().sort((a, b) => a - b);
  const med = times[times.length >> 1];
  for (const l of laps) l.valid = l.time > med * 0.85 && l.time < med * 1.3;

  const valid = laps.filter(l => l.valid);
  const best = (valid.length ? valid : laps).reduce((a, b) => b.time < a.time ? b : a);

  /* ---- centerline: the base session defines it, joined sessions reuse it ---- */
  let C;
  if (joining) C = A.sessions[0].C;
  else { progress('コース形状を生成しています…', 55); C = buildCenterline(P, best.i0, best.i1, 1); }

  progress('コース位置を計算しています…', 60);
  const PR = await projectAll(P, C, f => progress('コース位置を計算しています… ' + Math.round(f * 100) + '%', 60 + f * 32));

  /* A different circuit projects onto the base centerline as garbage, so refuse
     it rather than drawing a meaningless overlay. */
  if (joining) {
    let on = 0; for (let i = 0; i < P.n; i++) on += PR.ok[i];
    if (on / P.n < 0.5) throw new Error('このデータは基準セッションと同じコースではないようです。\n別コースの重ね合わせはできません。「読込」で新しく開いてください。');
  }

  /* ---- lap stats ---- */
  for (const l of laps) Object.assign(l, lapStats(P, l));
  const bestT = Math.min(...(valid.length ? valid : laps).map(l => l.time));
  for (const l of laps) l.isBest = (l.time === bestT);

  /* ---- commit: from here on nothing can fail partway ---- */
  const started = new Date(P.t[0] * 1000);
  const sess = {
    P, C, PR, laps, meta, controlLine: CL, lapSrc,
    id: 'cda_' + (meta.track || 'x') + '_' + Math.round(P.t[0]),
    date: started,
    short: (started.getMonth() + 1) + '/' + started.getDate(),
    label: meta.track + ' ' + started.toLocaleString('ja-JP'),
  };
  if (joining) A.sessions.push(sess);
  else { A.sessions = [sess]; A.controlLine = CL; A.lapSrc = lapSrc; }
  const si = A.sessions.length - 1;
  /* disambiguate same-day sessions so the legend stays readable */
  const sameDay = A.sessions.filter(s => s.date.toDateString() === sess.date.toDateString());
  if (sameDay.length > 1) sameDay.forEach((s, i) => {
    s.short = (s.date.getMonth() + 1) + '/' + s.date.getDate() + String.fromCharCode(65 + i);
  });
  A.clearCache();

  /* ---- defaults ---- */
  if (!joining) {
    A.sid = sess.id;
    A.sectors = [Math.round(C.len / 3), Math.round(C.len * 2 / 3)];
    A.markers = [];
    A.view = { d0: 0, d1: C.len };
    A.cursor = 0;
    A.refLap = A.key(0, best.num);
    A.sel = pickBest(3);
  } else {
    if (A.sel.length < 8) A.sel = A.sel.concat(A.key(si, best.num));
  }
  buildChannelList();
  applyTransforms();
  if (!joining) { loadNotes(); if (typeof videoResetForSession === 'function') videoResetForSession(); }
  progress('完了', 100);
  await sleep(60);

  $('#drop').classList.add('hide'); $('#app').classList.remove('hide');
  updateSessionBar();
  $('#kTrack').textContent = A.meta.track;
  $('#clInfo').innerHTML = A.controlLine
    ? '緯度 ' + A.controlLine.lat.toFixed(6) + ' / 経度 ' + A.controlLine.lon.toFixed(6)
    + '<br>方位 ' + A.controlLine.heading.toFixed(1) + '° / 幅 ' + A.controlLine.w + ' m<br>ラップ判定: ' + A.lapSrc
    : 'ラップ判定: ' + A.lapSrc;
  $('#dataInfo').innerHTML = A.sessions.map(s =>
    '<b>' + s.short + '</b> ' + s.meta.file + '<br>点数: ' + s.P.n.toLocaleString()
    + ' / ' + ((s.P.t[s.P.n - 1] - s.P.t[0]) / 60 | 0) + ' 分 · ' + s.laps.length + ' laps<br>'
    + '速度の入力単位: 自動判定 <b>' + s.P.speedUnit + '</b> → km/h'
    + (s.P.yawDerived ? '<br><span style="color:var(--warn)">ヨーレートはGPS方位から算出</span>' : '')
  ).join('<hr class="sep">')
    + '<hr class="sep">コース長(実測): ' + C.len.toFixed(1) + ' m（基準: ' + A.sessions[0].short + '）';
  mapFit(); renderLapTable(); redraw();
  saveRecent(set, sess.id, sess.label);
}

/* header line + the session chips under it */
function updateSessionBar() {
  const S = A.sessions;
  if (!S.length) return;
  $('#sessName').textContent = S.length === 1
    ? S[0].meta.track + ' · ' + S[0].date.toLocaleString('ja-JP') + ' · ' + S[0].laps.length
    + ' laps · ' + S[0].P.n.toLocaleString() + ' pts @' + S[0].meta.freq + 'Hz'
    : S[0].meta.track + ' · ' + S.length + ' セッション比較中 · ' + S.map(s => s.short).join(' / ');
  $('#btnAdd').classList.remove('hide');
  const box = $('#sessChips');
  box.innerHTML = '';
  box.classList.toggle('hide', S.length < 2);
  S.forEach((s, i) => {
    const el = document.createElement('span');
    el.className = 'chip';
    const v = s.laps.filter(l => l.valid);
    const bt = v.length ? Math.min.apply(null, v.map(l => l.time)) : NaN;
    el.innerHTML = '<b>' + s.short + '</b> ' + s.laps.length + '周 <span class="bt">' + fmtTime(bt) + '</span>';
    if (i > 0) {
      const x = document.createElement('button');
      x.textContent = '×'; x.title = 'この比較データを外す';
      x.onclick = () => removeSession(i);
      el.appendChild(x);
    } else el.title = '基準セッション（コース形状の基準）';
    box.appendChild(el);
  });
}

function removeSession(si) {
  if (si === 0 || !A.sessions[si]) return;
  A.sessions.splice(si, 1);
  /* lap keys embed the session index, so rebuild the selection */
  const remap = k => {
    if (k == null) return null;
    const s = A.siOf(k); if (s === si) return null;
    return A.key(s > si ? s - 1 : s, A.numOf(k));
  };
  A.sel = A.sel.map(remap).filter(Boolean);
  A.refLap = remap(A.refLap) || A.sel[0] || null;
  A.clearCache(); buildChannelList(); updateSessionBar(); renderLapTable(); redraw(); saveNotes();
}

function lapsFromCsv(P, f) {
  const { rows } = parseCsvSmall(f.text);
  const idAt = id => {                       // binary search in P.id
    let lo = 0, hi = P.n - 1;
    if (id <= P.id[0]) return 0; if (id >= P.id[hi]) return hi;
    while (lo < hi - 1) { const m = (lo + hi) >> 1; if (P.id[m] <= id) lo = m; else hi = m; }
    return lo;
  };
  const out = [];
  for (const r of rows) {
    const i0 = idAt(+r.start_wp), i1 = idAt(+r.finish_wp);
    if (!(i1 > i0)) continue;
    // refine the crossing instant with the interpolated line-cross point Qstarz stores
    let tS = P.t[i0];
    const ilat = +r.start_inter_lat, ilon = +r.start_inter_lon;
    if (isFinite(ilat) && i0 + 1 < P.n) {
      const ax = (P.lon[i0] - P.lon0) * P.kx, ay = (P.lat[i0] - P.lat0) * P.ky;
      const bx = (P.lon[i0 + 1] - P.lon0) * P.kx, by = (P.lat[i0 + 1] - P.lat0) * P.ky;
      const cx = (ilon - P.lon0) * P.kx, cy = (ilat - P.lat0) * P.ky;
      const ex = bx - ax, ey = by - ay, L2 = ex * ex + ey * ey;
      if (L2 > 0) {
        const fr = clamp(((cx - ax) * ex + (cy - ay) * ey) / L2, 0, 1);
        tS = P.t[i0] + (P.t[i0 + 1] - P.t[i0]) * fr;
      }
    }
    const dur = +r.duration;
    out.push({
      num: out.length + 1, tStart: tS, tEnd: tS + (isFinite(dur) ? dur : P.t[i1] - tS),
      time: isFinite(dur) ? dur : P.t[i1] - tS, i0, i1
    });
  }
  return out;
}

function pickBest(k) {
  const s = A.sessions[0]; if (!s) return [];
  const v = s.laps.filter(l => l.valid).slice().sort((a, b) => a.time - b.time).slice(0, k).map(l => l.num);
  const nums = v.length ? v.sort((a, b) => a - b) : s.laps.slice(0, k).map(l => l.num);
  return nums.map(n => A.key(0, n));
}

/* =====================  LAP TABLE  ===================== */
function renderLapTable() {
  const tb = $('#lapBody'); tb.innerHTML = '';
  const hide = $('#hideOut').checked;
  const frag = document.createDocumentFragment();
  const multi = A.sessions.length > 1;

  A.sessions.forEach((sess, si) => {
    const vl = sess.laps.filter(l => l.valid);
    const bestT = vl.length ? Math.min.apply(null, vl.map(l => l.time)) : NaN;
    if (multi) {                                  // session header row
      const hr = document.createElement('tr');
      hr.className = 'shead';
      hr.innerHTML = '<td colspan="6">' + sess.short + '　' + sess.date.toLocaleDateString('ja-JP')
        + '　<span style="color:var(--fg3)">best ' + fmtTime(bestT) + '</span></td>';
      frag.appendChild(hr);
    }
    for (const l of sess.laps) {
      if (hide && !l.valid) continue;
      const key = A.key(si, l.num);
      const tr = document.createElement('tr');
      const ci = A.sel.indexOf(key);
      if (ci >= 0) tr.className = 'sel';
      if (key === A.refLap) tr.className += ' ref';
      if (!l.valid) tr.className += ' out';
      const col = ci >= 0 ? LAP_COLORS[ci % LAP_COLORS.length] : 'transparent';
      const dlt = l.time - bestT;
      tr.innerHTML =
        '<td><span class="swatch" style="background:' + col + '"></span>' + l.num + '</td>' +
        '<td class="' + (l.isBest ? 'best' : '') + '">' + fmtTime(l.time) + '</td>' +
        '<td style="color:' + (dlt <= 0 ? 'var(--purple)' : 'var(--fg3)') + '">' + (l.isBest ? '—' : fmtDelta(dlt)) + '</td>' +
        '<td>' + (isFinite(l.maxSpd) ? l.maxSpd.toFixed(0) : '—') + '</td>' +
        '<td>' + (isFinite(l.avgSpd) ? l.avgSpd.toFixed(1) : '—') + '</td>' +
        '<td><button data-ref="1" style="padding:0 6px;font-size:10px;'
        + (key === A.refLap ? 'background:var(--good);color:#04120a;border-color:var(--good)' : '') + '">R</button></td>';
      tr.onclick = e => {
        if (e.target.dataset.ref) {
          A.refLap = key;
          if (!A.sel.includes(key)) toggleLap(key, true);
          renderLapTable(); redraw(); return;
        }
        toggleLap(key);
      };
      frag.appendChild(tr);
    }
  });
  tb.appendChild(frag);
}

/* "Lap 7" alone is ambiguous once two days are loaded */
function lapLabel(k) {
  const l = A.lapByKey(k), sx = A.sessOf(k);
  if (!l) return '—';
  return (A.sessions.length > 1 ? sx.short + ' ' : '') + 'Lap ' + l.num;
}

function lapSortKey(k) { return A.siOf(k) * 100000 + A.numOf(k); }

function toggleLap(key, forceOn) {
  const i = A.sel.indexOf(key);
  if (i >= 0 && !forceOn) A.sel.splice(i, 1);
  else if (i < 0) {
    if (A.sel.length >= 8) { toast('同時表示は8ラップまでです'); return; }
    A.sel.push(key); A.sel.sort((a, b) => lapSortKey(a) - lapSortKey(b));
  }
  if (!A.sel.includes(A.refLap)) A.refLap = A.sel[0] ?? null;
  renderLapTable(); redraw(); saveNotes();
}

/* =====================  CHANNELS  ===================== */
function buildChannelList() {
  const order = ['speed', 'gx', 'gy', 'gz', 'yaw', 'gcomb', 'off', 'alt', 'rpm', 'throttle', 'brake', 'steer', 'watertemp', 'oiltemp', 'gear', 'heading'];
  const avail = new Set(['off']);
  for (const s of A.sessions) for (const k of Object.keys(s.P.ch)) avail.add(k);
  const prev = new Map(A.channels.map(c => [c.key, c.on]));
  const defOn = ['speed', 'gx', 'gy', 'gz', 'yaw'];
  A.channels = order.filter(k => avail.has(k))
    .map(k => ({ key: k, on: prev.has(k) ? prev.get(k) : defOn.includes(k) }));
  const box = $('#chList'); box.innerHTML = '';
  for (const c of A.channels) {
    const m = CHMETA[c.key] || { label: c.key, unit: '' };
    const row = document.createElement('label'); row.className = 'chrow';
    row.innerHTML = '<input type="checkbox" ' + (c.on ? 'checked' : '') + '><span class="nm">' + m.label + '</span><span class="u">' + m.unit + '</span>';
    row.querySelector('input').onchange = e => { c.on = e.target.checked; drawChart(); saveNotes(); };
    box.appendChild(row);
  }
}

/* =====================  KPI  ===================== */
function updateKpi() {
  if (!A.C) return;
  const primKey = A.sel[0] ?? null;
  const prim = primKey != null ? A.lapByKey(primKey) : null;
  const primSess = primKey != null ? A.sessOf(primKey) : null;
  const rl = primKey != null ? A.getLap(primKey) : null;
  const ref = A.refLap != null ? A.getLap(A.refLap) : null;
  const multi = A.sessions.length > 1;
  $('#kLap').textContent = prim
    ? (multi ? primSess.short + ' ' : '') + prim.num + '/' + primSess.laps.length : '—';
  $('#kTime').textContent = prim ? fmtTime(prim.time) : '—';
  $('#kBest').textContent = fmtTime(A.bestTimeAll());
  $('#kPos').textContent = Math.round(A.cursor) + ' m';
  if (rl) {
    const sp = sampleAt(rl, A.cursor, 'speed');
    $('#kSpd').textContent = isFinite(sp) ? sp.toFixed(0) + ' km/h' : '—';
    $('#kGx').textContent = rl.gx ? sampleAt(rl, A.cursor, 'gx').toFixed(2) : '—';
    $('#kGy').textContent = rl.gy ? sampleAt(rl, A.cursor, 'gy').toFixed(2) : '—';
    $('#kYaw').textContent = rl.yaw ? sampleAt(rl, A.cursor, 'yaw').toFixed(1) : '—';
  } else { $('#kSpd').textContent = $('#kGx').textContent = $('#kGy').textContent = $('#kYaw').textContent = '—'; }
  const dEl = $('#kDelta');
  if (rl && ref && primKey !== A.refLap) {
    const d = sampleAt(rl, A.cursor, 't') - sampleAt(ref, A.cursor, 't');
    dEl.textContent = fmtDelta(d);
    dEl.style.color = d < 0 ? 'var(--good)' : d > 0 ? 'var(--bad)' : 'var(--fg)';
  } else { dEl.textContent = '—'; dEl.style.color = ''; }
  const b = [0, ...A.sectors, A.C.len];
  let si = 0; for (let i = 0; i < b.length - 1; i++) if (A.cursor >= b[i]) si = i;
  let secTxt = 'S' + (si + 1);
  if (rl) { const st = sampleAt(rl, b[si + 1] - 0.001, 't') - sampleAt(rl, b[si], 't'); if (isFinite(st)) secTxt += '  ' + st.toFixed(2) + 's'; }
  $('#kSec').textContent = secTxt;
  $('#noteLapLbl').textContent = 'ラップ別メモ'
    + (prim ? '（' + (multi ? primSess.short + ' ' : '') + 'Lap ' + prim.num + '）' : '');
  syncLapNote();
}

/* =====================  CURSOR / VIEW  ===================== */
function setCursor(d, redrawAll = true) {
  const L = A.C ? A.C.len : 1;
  A.cursor = ((d % L) + L) % L;
  if (redrawAll) redraw();
  if (typeof videoFollowCursor === 'function') videoFollowCursor();
}
function setView(d0, d1) {
  const L = A.C.len;
  let span = clamp(d1 - d0, 20, L);
  d0 = clamp(d0, 0, L - span);
  A.view = { d0, d1: d0 + span };
  redraw();
}
function zoomView(factor, anchorD) {
  const { d0, d1 } = A.view, span = d1 - d0;
  const a = anchorD == null ? A.cursor : anchorD;
  const f = clamp((a - d0) / span, 0, 1);
  const ns = clamp(span * factor, 20, A.C.len);
  setView(a - ns * f, a - ns * f + ns);
}
