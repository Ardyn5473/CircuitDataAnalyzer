/* ===========================================================
   Events, persistence, export, bootstrap
   =========================================================== */

/* ---------------- chart interaction ---------------- */
(function () {
  const cv = $('#chart');
  let mode = null, lastX = 0, startView = null;
  const dAt = px => {
    const p = A._plot; if (!p) return 0;
    return p.d0 + clamp((px - p.PADL) / p.plotW, 0, 1) * p.dspan;
  };
  cv.addEventListener('pointerdown', e => {
    if (!A.C) return;
    cv.setPointerCapture(e.pointerId);
    lastX = e.offsetX;
    if (e.shiftKey || e.button === 1 || e.button === 2) { mode = 'pan'; startView = { ...A.view }; }
    else { mode = 'scrub'; setCursor(dAt(e.offsetX)); }
  });
  cv.addEventListener('pointermove', e => {
    if (!mode) return;
    if (mode === 'scrub') setCursor(dAt(e.offsetX));
    else {
      const p = A._plot; const dx = (e.offsetX - lastX) / p.plotW * p.dspan;
      lastX = e.offsetX;
      setView(A.view.d0 - dx, A.view.d1 - dx);
    }
  });
  const end = e => { mode = null; try { cv.releasePointerCapture(e.pointerId); } catch (x) { } };
  cv.addEventListener('pointerup', end);
  cv.addEventListener('pointercancel', end);
  cv.addEventListener('contextmenu', e => e.preventDefault());
  cv.addEventListener('wheel', e => {
    if (!A.C) return; e.preventDefault();
    zoomView(e.deltaY > 0 ? 1.25 : 0.8, dAt(e.offsetX));
  }, { passive: false });
  cv.addEventListener('dblclick', () => setView(0, A.C.len));
})();

/* ---------------- map interaction ---------------- */
(function () {
  const cv = $('#map');
  let mode = null, last = null;
  const nearestD = (px, py) => {
    const [x, y] = mapInv(px, py); const C = A.C;
    let bi = 0, bd = Infinity;
    for (let i = 0; i < C.M; i++) {
      const dx = C.x[i] - x, dy = C.y[i] - y, d2 = dx * dx + dy * dy;
      if (d2 < bd) { bd = d2; bi = i; }
    }
    return C.d[bi];
  };
  cv.addEventListener('pointerdown', e => {
    if (!A.C) return; cv.setPointerCapture(e.pointerId);
    last = { x: e.offsetX, y: e.offsetY };
    if (e.shiftKey || e.button === 1 || e.button === 2) mode = 'pan';
    else { mode = 'pick'; setCursor(nearestD(e.offsetX, e.offsetY)); }
  });
  cv.addEventListener('pointermove', e => {
    if (!mode) return;
    if (mode === 'pick') setCursor(nearestD(e.offsetX, e.offsetY));
    else {
      A.mapT.cx -= (e.offsetX - last.x) / A.mapT.s;
      A.mapT.cy += (e.offsetY - last.y) / A.mapT.s;
      last = { x: e.offsetX, y: e.offsetY }; drawMap();
    }
  });
  const end = e => { mode = null; try { cv.releasePointerCapture(e.pointerId); } catch (x) { } };
  cv.addEventListener('pointerup', end);
  cv.addEventListener('pointercancel', end);
  cv.addEventListener('contextmenu', e => e.preventDefault());
  cv.addEventListener('wheel', e => {
    if (!A.mapT) return; e.preventDefault();
    const [wx, wy] = mapInv(e.offsetX, e.offsetY);
    const f = e.deltaY > 0 ? 1 / 1.2 : 1.2;
    A.mapT.s *= f;
    const [nx, ny] = mapInv(e.offsetX, e.offsetY);
    A.mapT.cx += wx - nx; A.mapT.cy += wy - ny;
    drawMap();
  }, { passive: false });
})();

/* ---------------- keyboard ---------------- */
addEventListener('keydown', e => {
  if (!A.C || /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
  const stepM = e.shiftKey ? 25 : 2;
  if (e.key === 'ArrowRight') { setCursor(A.cursor + stepM); e.preventDefault(); }
  else if (e.key === 'ArrowLeft') { setCursor(A.cursor - stepM); e.preventDefault(); }
  else if (e.key === ' ') { togglePlay(); e.preventDefault(); }
  else if (e.key === 's' || e.key === 'S') { A.showSec = !A.showSec; $('#gSec').classList.toggle('on', A.showSec); redraw(); }
  else if (e.key === 'l' || e.key === 'L') { A.mapLine = !A.mapLine; $('#mapLine').classList.toggle('on', A.mapLine); drawMap(); }
  else if (e.key === 'b' || e.key === 'B') { addMarker('Brake'); }
  else if (e.key === '+' || e.key === '=') zoomView(0.8);
  else if (e.key === '-') zoomView(1.25);
  else if (e.key === '0') setView(0, A.C.len);
});

/* ---------------- playback ---------------- */
let playRaf = 0, playT0 = 0, playElapsed0 = 0;
function togglePlay() {
  A.playing = !A.playing;
  $('#btnPlay').textContent = A.playing ? '❚❚' : '▶';
  $('#btnPlay').classList.toggle('on', A.playing);
  if (!A.playing) { cancelAnimationFrame(playRaf); return; }
  const rl = A.sel[0] != null ? A.getLap(A.sel[0]) : null;
  if (!rl) { A.playing = false; $('#btnPlay').textContent = '▶'; return; }
  playT0 = performance.now(); playElapsed0 = sampleAt(rl, A.cursor, 't');
  const tick = () => {
    if (!A.playing) return;
    const el = playElapsed0 + (performance.now() - playT0) / 1000;
    const M = rl.M;
    if (el >= rl.t[M - 1]) { setCursor(0); playT0 = performance.now(); playElapsed0 = 0; }
    else {
      let lo = 0, hi = M - 1;
      while (lo < hi - 1) { const m = (lo + hi) >> 1; if (rl.t[m] <= el) lo = m; else hi = m; }
      setCursor(lo * rl.step);
    }
    playRaf = requestAnimationFrame(tick);
  };
  playRaf = requestAnimationFrame(tick);
}

/* ---------------- toolbar ---------------- */
$('#btnPlay').onclick = togglePlay;
function openLoader(mode) {
  A.loadMode = mode;
  $('#drop').classList.remove('hide'); $('#err').classList.add('hide'); progress('', 0);
  $('#dropClose').classList.toggle('hide', !A.C);
  $('#dzTitle').textContent = mode === 'add' ? '比較する別日のデータをドロップ' : 'CSV / ZIP をドロップ';
  $('#dzAdd').classList.toggle('hide', mode !== 'add');
  $('#btnAdd').classList.toggle('hide', !A.C);
}
$('#btnLoad').onclick = () => openLoader('replace');
$('#btnAdd').onclick = () => openLoader('add');
$('#dropClose').onclick = () => { $('#drop').classList.add('hide'); if (A.C) redraw(); };
$('#btnReload').onclick = () => $('#btnLoad').click();
$('#gZoomIn').onclick = () => zoomView(0.7);
$('#gZoomOut').onclick = () => zoomView(1.4);
$('#gReset').onclick = () => setView(0, A.C.len);
$('#gSec').onclick = e => { A.showSec = !A.showSec; e.target.classList.toggle('on', A.showSec); redraw(); };
$('#gDelta').onclick = e => { A.showDelta = !A.showDelta; e.target.classList.toggle('on', A.showDelta); drawChart(); };
$('#mapLine').onclick = e => { A.mapLine = !A.mapLine; e.target.classList.toggle('on', A.mapLine); drawMap(); };
$('#mapColor').onclick = e => { A.mapColor = !A.mapColor; e.target.classList.toggle('on', A.mapColor); drawMap(); };
$('#mapFit').onclick = () => { mapFit(); drawMap(); };
$('#lapBest').onclick = () => {
  A.sel = pickBest(5);
  A.refLap = A.sel.reduce((a, b) => A.lapByKey(b).time < A.lapByKey(a).time ? b : a, A.sel[0]);
  renderLapTable(); redraw();
};
$('#lapClear').onclick = () => { A.sel = []; renderLapTable(); redraw(); };
$('#hideOut').onchange = renderLapTable;

$$('#tabbar button').forEach(b => b.onclick = () => {
  $$('#tabbar button').forEach(x => x.classList.toggle('on', x === b));
  ['laps', 'ch', 'note', 'set'].forEach(t => $('#tab-' + t).classList.toggle('hide', t !== b.dataset.tab));
});

/* settings */
$('#invGx').onchange = e => { A.invGx = e.target.checked; applyTransforms(); redraw(); saveNotes(); };
$('#invGy').onchange = e => { A.invGy = e.target.checked; applyTransforms(); redraw(); saveNotes(); };
$('#gzGrav').onchange = e => { A.gzGrav = e.target.checked; applyTransforms(); redraw(); saveNotes(); };
$('#smooth').oninput = e => { A.smooth = +e.target.value; $('#smLbl').textContent = A.smooth; A.clearCache(); redraw(); saveNotes(); };
$('#secApply').onclick = () => {
  const v = $('#secList').value.split(/[,、\s]+/).map(s => parseFloat(s)).filter(x => isFinite(x) && x > 0 && x < A.C.len);
  A.sectors = [...new Set(v)].sort((a, b) => a - b); redraw(); saveNotes();
};
$('#secAdd').onclick = () => {
  A.sectors = [...new Set([...A.sectors, Math.round(A.cursor)])].filter(x => x > 0 && x < A.C.len).sort((a, b) => a - b);
  $('#secList').value = A.sectors.join(', '); redraw(); saveNotes(); toast('セクターを追加しました');
};
$('#clHere').onclick = () => {
  if (A.sessions.length > 1) { toast('比較データを外してから設定してください'); return; }
  const rl = A.sel[0] != null ? A.getLap(A.sel[0]) : null; if (!rl) return;
  const la = sampleAt(rl, A.cursor, 'lat'), lo = sampleAt(rl, A.cursor, 'lon');
  const hd = sampleAt(rl, A.cursor, 'heading');
  const CL = makeControlLine(A.P, la, lo, isFinite(hd) ? hd : 0, 40);
  const laps = detectLaps(A.P, CL);
  if (laps.length < 2) { toast('この位置ではラップを検出できませんでした'); return; }
  A.controlLine = CL; A.sessions[0].laps = laps;
  const times = laps.map(l => l.time).sort((a, b) => a - b), med = times[times.length >> 1];
  for (const l of laps) { l.valid = l.time > med * .85 && l.time < med * 1.3; Object.assign(l, lapStats(A.P, l)); }
  const bt = Math.min(...laps.filter(l => l.valid).map(l => l.time));
  for (const l of laps) l.isBest = l.time === bt;
  A.clearCache(); A.sel = pickBest(3); A.refLap = A.sel[0];
  $('#clInfo').innerHTML = `緯度 ${la.toFixed(6)} / 経度 ${lo.toFixed(6)}<br>ラップ判定: 手動設定 (${laps.length} laps)`;
  renderLapTable(); redraw(); toast(laps.length + ' ラップを再検出しました');
};
['mDriver', 'mVehicle', 'mTire', 'mWeather', 'mSetup'].forEach(id => $('#' + id).oninput = saveNotes);
$('#noteGlobal').oninput = saveNotes;
$('#noteLap').oninput = saveNotes;
$('#mkAdd').onclick = () => { addMarker($('#mkText').value.trim() || 'Mark'); $('#mkText').value = ''; };
function addMarker(text) {
  A.markers.push({ d: Math.round(A.cursor), text, lap: A.sel[0] ?? null });
  A.markers.sort((a, b) => a.d - b.d); renderMarkers(); redraw(); saveNotes(); toast('マーカー追加: ' + Math.round(A.cursor) + 'm');
}
function renderMarkers() {
  const box = $('#mkList'); box.innerHTML = '';
  A.markers.forEach((m, i) => {
    const row = document.createElement('div'); row.className = 'chrow';
    row.innerHTML = `<span class="u" style="width:52px">${m.d}m</span><span class="nm">${m.text}</span>`;
    const go = document.createElement('button'); go.textContent = '→'; go.style.padding = '1px 7px';
    go.onclick = () => setCursor(m.d);
    const del = document.createElement('button'); del.textContent = '×'; del.style.padding = '1px 7px';
    del.onclick = () => { A.markers.splice(i, 1); renderMarkers(); redraw(); saveNotes(); };
    row.append(go, del); box.appendChild(row);
  });
}

/* ---------------- notes persistence (localStorage) ----------------
   Storage is not guaranteed: opened as a local file:// page, in a private
   window, or with site data blocked, these calls can throw. Nothing here is
   essential to analysing a lap, so every access degrades to "no saved state"
   rather than breaking the import. */
const LS = {
  get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } },
  del(k) { try { localStorage.removeItem(k); } catch (e) { } },
};
function readState(k) { try { return JSON.parse(LS.get(k) || '{}'); } catch (e) { return {}; } }

function saveNotes() {
  if (!A.sid) return;
  const prim = A.sel[0];
  const st = readState(A.sid);
  st.global = $('#noteGlobal').value;
  st.lapNotes = st.lapNotes || {};
  if (prim != null) st.lapNotes[prim] = $('#noteLap').value;
  st.markers = A.markers; st.sectors = A.sectors; st.sel = A.sel; st.ref = A.refLap;
  st.channels = A.channels.filter(c => c.on).map(c => c.key);
  st.smooth = A.smooth; st.invGx = A.invGx; st.invGy = A.invGy; st.gzGrav = A.gzGrav;
  st.meta = { driver: $('#mDriver').value, vehicle: $('#mVehicle').value, tire: $('#mTire').value, weather: $('#mWeather').value, setup: $('#mSetup').value };
  A._notes = st;
  LS.set(A.sid, JSON.stringify(st));
}
function loadNotes() {
  const st = readState(A.sid);
  A._notes = st;
  if (st.sectors) A.sectors = st.sectors;
  if (st.markers) A.markers = st.markers;
  if (st.sel && st.sel.length) {          // a stored selection from an older format filters to nothing - keep the default then
    const keep = st.sel.filter(k => A.lapByKey(k));
    if (keep.length) A.sel = keep;
  }
  if (st.ref != null && A.lapByKey(st.ref)) A.refLap = st.ref;
  if (st.smooth) { A.smooth = st.smooth; $('#smooth').value = st.smooth; $('#smLbl').textContent = st.smooth; }
  A.invGx = !!st.invGx; A.invGy = !!st.invGy; A.gzGrav = st.gzGrav !== false;
  $('#invGx').checked = A.invGx; $('#invGy').checked = A.invGy; $('#gzGrav').checked = A.gzGrav;
  applyTransforms();
  $('#noteGlobal').value = st.global || '';
  $('#secList').value = A.sectors.join(', ');
  const m = st.meta || {};
  $('#mDriver').value = m.driver || ''; $('#mVehicle').value = m.vehicle || '';
  $('#mTire').value = m.tire || ''; $('#mWeather').value = m.weather || ''; $('#mSetup').value = m.setup || '';
  renderMarkers();
  if (st.channels && st.channels.length) setTimeout(() => {
    A.channels.forEach(c => c.on = st.channels.includes(c.key));
    $$('#chList input').forEach((el, i) => el.checked = A.channels[i].on);
    drawChart();
  }, 0);
}
let _noteLapShown = undefined;
function syncLapNote() {                    // never clobber text the user is typing
  const prim = A.sel[0] ?? null;
  if (prim === _noteLapShown) return;
  _noteLapShown = prim;
  const st = A._notes || {};
  $('#noteLap').value = (st.lapNotes && prim != null) ? (st.lapNotes[prim] || '') : '';
}
$('#btnForget').onclick = () => {
  if (!confirm('この端末に保存したメモ・設定・読み込み履歴を削除します。よろしいですか？')) return;
  LS.del(A.sid); idbClear(); toast('保存データを削除しました');
};

/* ---------------- export ---------------- */
/* Saving a file works two different ways depending on where this page runs:
   opened as a local file a blob link is fine, but inside the published viewer
   downloads are mediated and a plain link silently does nothing. */
async function download(name, text, type = 'text/plain') {
  const use = window.claude && window.claude.use;
  if (use) {
    let dl = null;
    try { dl = await window.claude.use('downloads'); } catch (e) { dl = null; }
    if (!dl) { toast('この画面ではファイルの書き出しを利用できません'); return; }
    try {
      await dl.save({ filename: name, data: text });
      toast('書き出しました: ' + name);
    } catch (e) {
      const c = e && e.code;
      if (c === 'declined') return;                       // viewer said no - not an error
      toast(c === 'too_large' ? 'データが大きすぎて書き出せません'
        : c === 'rate_limited' ? '続けて書き出せません。少し待ってからもう一度お試しください'
          : '書き出しできませんでした');
    }
    return;
  }
  const b = new Blob([text], { type: type + ';charset=utf-8' });
  const u = URL.createObjectURL(b), a = document.createElement('a');
  a.href = u; a.download = name; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(u); a.remove(); }, 500);
}
$('#expCsv').onclick = () => {
  const b = [0, ...A.sectors, A.C.len];
  const head = ['session', 'date', 'lap', 'lap_time_s', 'valid', 'max_speed_kmh', 'min_speed_kmh', 'avg_speed_kmh',
    'max_lat_g', 'max_brake_g', ...b.slice(0, -1).map((_, i) => 'sector' + (i + 1) + '_s')];
  const lines = [head.join(',')];
  for (const [si, sess] of A.sessions.entries()) for (const l of sess.laps) {
    const rl = A.getLap(A.key(si, l.num));
    const secs = b.slice(0, -1).map((s, i) => rl ? (sampleAt(rl, b[i + 1] - .001, 't') - sampleAt(rl, s, 't')).toFixed(3) : '');
    lines.push([sess.short, sess.date.toISOString().slice(0, 10), l.num, l.time.toFixed(3), l.valid ? 1 : 0,
    (l.maxSpd || 0).toFixed(1), (l.minSpd || 0).toFixed(1),
    (l.avgSpd || 0).toFixed(2), (l.maxLat || 0).toFixed(3), (l.maxBrake || 0).toFixed(3), ...secs].join(','));
  }
  download('CDA_laps_' + (A.meta.track || 'session') + '.csv', '\uFEFF' + lines.join('\n'), 'text/csv');
};
$('#expJson').onclick = () => {
  const st = readState(A.sid);
  const b = [0, ...A.sectors, A.C.len];
  const out = {
    app: 'Circuit Data Analyzer', exported: new Date().toISOString(),
    sessions: A.sessions.map(s => ({
      name: s.short, track: s.meta.track, logger: s.meta.model, file: s.meta.file,
      start: s.date.toISOString(), points: s.P.n, hz: s.meta.freq, laps: s.laps.length,
      best_s: +Math.min.apply(null, s.laps.filter(l => l.valid).map(l => l.time)).toFixed(3)
    })),
    track_length_m: +A.C.len.toFixed(1), lap_detection: A.lapSrc,
    vehicle: st.meta || {}, sectors_m: A.sectors, markers: A.markers,
    notes: { session: st.global || '', laps: st.lapNotes || {} },
    laps: A.sessions.flatMap((sess, si) => sess.laps.map(l => {
      const rl = A.getLap(A.key(si, l.num));
      return {
        session: sess.short, lap: l.num, time_s: +l.time.toFixed(3), valid: l.valid, best: !!l.isBest,
        max_speed_kmh: +(l.maxSpd || 0).toFixed(1), avg_speed_kmh: +(l.avgSpd || 0).toFixed(2),
        max_lateral_g: +(l.maxLat || 0).toFixed(3), max_braking_g: +(l.maxBrake || 0).toFixed(3),
        sectors_s: rl ? b.slice(0, -1).map((s, i) => +(sampleAt(rl, b[i + 1] - .001, 't') - sampleAt(rl, s, 't')).toFixed(3)) : []
      };
    }))
  };
  download('CDA_analysis_' + (A.meta.track || 'session') + '.json', JSON.stringify(out, null, 2), 'application/json');
};

/* ---------------- column mapping modal ---------------- */
function askMapping(head, initial) {
  return new Promise(res => {
    const grid = $('#mapGrid'); grid.innerHTML = '';
    const sels = {};
    for (const f of FIELD_DEFS) {
      if (f.key === 'id' || f.key === 'ms') continue;
      const lbl = document.createElement('div'); lbl.className = 'lbl';
      lbl.textContent = f.label + (f.req ? ' *' : '');
      const sel = document.createElement('select');
      sel.innerHTML = '<option value="-1">— 未使用 —</option>' + head.map((h, i) => `<option value="${i}">${h}</option>`).join('');
      if (initial[f.key] !== undefined) sel.value = initial[f.key];
      sels[f.key] = sel;
      grid.append(lbl, sel);
    }
    $('#mapModal').classList.remove('hide');
    const close = v => { $('#mapModal').classList.add('hide'); res(v); };
    $('#mapCancel').onclick = () => close(null);
    $('#mapOk').onclick = () => {
      const m = {};
      for (const k in sels) { const v = +sels[k].value; if (v >= 0) m[k] = v; }
      if (m.lat === undefined || m.lon === undefined) { toast('緯度と経度は必須です'); return; }
      close(m);
    };
  });
}

/* ---------------- recent sessions (IndexedDB) ---------------- */
let idb = null;
let idbDead = false;
function idbOpen() {
  return new Promise(res => {
    if (idb) return res(idb);
    if (idbDead || typeof indexedDB === 'undefined') return res(null);
    try {
      const rq = indexedDB.open('cda', 1);           // throws on file:// in Chrome
      rq.onupgradeneeded = () => rq.result.createObjectStore('sessions', { keyPath: 'id' });
      rq.onsuccess = () => res(idb = rq.result);
      rq.onerror = () => { idbDead = true; res(null); };
      rq.onblocked = () => res(null);
    } catch (e) { idbDead = true; res(null); }
  });
}
async function saveRecent(set, id, label) {
  try {
    const db = await idbOpen(); if (!db) return;
    const files = [set.points, set.lapCsv, set.beacon, ...set.info].filter(Boolean)
      .map(f => ({ name: f.name, text: f.text }));
    const tx = db.transaction('sessions', 'readwrite');
    tx.objectStore('sessions').put({ id: id || A.sid, name: A.meta.track, when: Date.now(), label: label || $('#sessName').textContent, files });
    tx.oncomplete = listRecent;
  } catch (e) { }
}
async function listRecent() {
  const box = $('#recent'); box.innerHTML = '';
  let db = null, rq = null;
  try {
    db = await idbOpen(); if (!db) return;
    rq = db.transaction('sessions').objectStore('sessions').getAll();
  } catch (e) { return; }
  rq.onsuccess = () => {
    const all = (rq.result || []).sort((a, b) => b.when - a.when).slice(0, 6);
    if (!all.length) return;
    const h = document.createElement('div'); h.className = 'note';
    h.style.textAlign = 'left'; h.textContent = '最近のセッション（この端末に保存済み）';
    box.appendChild(h);
    for (const s of all) {
      const b = document.createElement('button');
      b.innerHTML = `▸ ${s.label || s.name}`;
      b.onclick = async () => {
        progress('保存データを読み込んでいます…', 5);
        try {
          const files = s.files.map(f => ({ ...f }));
          const st = classify(files);
          const headRaw = splitLine(csvLines(st.points.text)[0].replace(/^\uFEFF/, '')).map(x => x.trim());
          await ingest(st, headRaw, autoMap(headRaw));
        } catch (e) { showErr(friendlyError(e)); }
      };
      box.appendChild(b);
    }
  };
}
async function idbClear() {
  try { const db = await idbOpen(); if (db) db.transaction('sessions', 'readwrite').objectStore('sessions').clear(); } catch (e) { }
}

/* ---------------- drop zone ---------------- */
(function () {
  const dz = $('#dz'), fi = $('#file');
  dz.onclick = () => fi.click();
  fi.onchange = () => { if (fi.files.length) loadFiles([...fi.files]); };
  ['dragenter', 'dragover'].forEach(ev => addEventListener(ev, e => { e.preventDefault(); dz.classList.add('hot'); }));
  ['dragleave', 'drop'].forEach(ev => addEventListener(ev, e => { e.preventDefault(); if (ev === 'dragleave' && e.relatedTarget) return; dz.classList.remove('hot'); }));
  addEventListener('drop', e => {
    e.preventDefault(); dz.classList.remove('hot');
    const fs = [...(e.dataTransfer.files || [])];
    if (fs.length) { $('#drop').classList.remove('hide'); loadFiles(fs); }
  });
})();

/* ---------------- resize / boot ---------------- */
let rzT = 0;
addEventListener('resize', () => { clearTimeout(rzT); rzT = setTimeout(() => { if (A.C) redraw(); }, 100); });
listRecent();
