/* ===========================================================
   Official course map import
   -----------------------------------------------------------
   Reads course geometry the user already owns and overlays it on the GPS
   data. Nothing from a vendor is bundled with this app - the user supplies
   their own files, and the parsed result stays on their device.

   Supported:
     DigSpice  cd_*.pth  - text, repeated <path> blocks of "lon,lat" lines
     Qstarz    XXX-YYY.bin - 148 bytes: name, type tag, then float32
                             latitude / longitude / heading of the start line
     Qstarz    .map       - a raster picture of the course, not geo-referenced;
                            ignored in favour of the vector data above
   =========================================================== */

const TRK = { nudgeX: 0, nudgeY: 0 };

/* ---------- parsers ---------- */
function parsePth(text) {
  const out = [];
  const re = /<path>([\s\S]*?)<\/path>/g;
  let m;
  while ((m = re.exec(text))) {
    const pts = [];
    for (const line of m[1].split(/\r?\n/)) {
      const t = line.trim(); if (!t) continue;
      const c = t.split(',');
      const lon = parseFloat(c[0]), lat = parseFloat(c[1]);
      if (isFinite(lon) && isFinite(lat) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) pts.push([lon, lat]);
    }
    if (pts.length > 2) out.push(pts);
  }
  return out;
}

/* Layout (148 bytes for a plain circuit):
     0x00  name, NUL-padded, 128 bytes
     0x80  type tag ("TRA")
     0x88  float32 lat, lon, heading  - the start/finish line
   Longer files carry further 12-byte lat/lon/heading records: the split
   (sector) lines. There is no bounding box or scale anywhere in the format,
   which is why the .map picture cannot be placed on the earth. */
function parseQstarzBin(bytes) {
  if (bytes.length < 148) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let name = '';
  for (let i = 0; i < 128 && bytes[i]; i++) name += String.fromCharCode(bytes[i]);
  const lines = [];
  for (let off = 136; off + 12 <= bytes.length; off += 12) {
    const lat = dv.getFloat32(off, true), lon = dv.getFloat32(off + 4, true), hd = dv.getFloat32(off + 8, true);
    if (!isFinite(lat) || Math.abs(lat) > 90 || Math.abs(lat) < 1e-6) continue;
    if (!isFinite(lon) || Math.abs(lon) > 180) continue;
    lines.push({ lat, lon, heading: hd });
  }
  if (!lines.length) return null;
  return { name: name.trim(), lat: lines[0].lat, lon: lines[0].lon, heading: lines[0].heading, splits: lines.slice(1) };
}

/* ---------- geometry helpers ---------- */
const TRK_R = 6378137.0;
function pathLenM(p) {
  let s = 0;
  for (let i = 1; i < p.length; i++) {
    const dx = (p[i][0] - p[i - 1][0]) * Math.cos(p[i][1] * Math.PI / 180) * TRK_R * Math.PI / 180;
    const dy = (p[i][1] - p[i - 1][1]) * TRK_R * Math.PI / 180;
    s += Math.hypot(dx, dy);
  }
  return s;
}
function pathClosed(p) {
  const dx = (p[0][0] - p[p.length - 1][0]) * 91000, dy = (p[0][1] - p[p.length - 1][1]) * 111320;
  return Math.hypot(dx, dy) < 2;
}
function pathCentroid(p) {
  let x = 0, y = 0; for (const q of p) { x += q[0]; y += q[1]; }
  return [x / p.length, y / p.length];
}
function sessionCentroid() {
  const P = A.P; if (!P) return null;
  let la = 0, lo = 0, n = 0;
  for (let i = 0; i < P.n; i += 97) { la += P.lat[i]; lo += P.lon[i]; n++; }
  return n ? [lo / n, la / n] : null;
}
function kmBetween(a, b) {
  const dx = (a[0] - b[0]) * Math.cos(b[1] * Math.PI / 180) * 111.32, dy = (a[1] - b[1]) * 111.32;
  return Math.hypot(dx, dy);
}

/* ---------- import ---------- */
async function importTrackFiles(fileList) {
  progress('コースデータを読み込んでいます…', 5);
  const cands = [];      // {name, source, paths}
  const marks = [];      // {name, lat, lon, heading}
  const push = async (name, bytes) => {
    if (/\.pth$/i.test(name)) {
      const paths = parsePth(decodeText(bytes));
      if (paths.length) cands.push({ name: name.replace(/^cd_|\.pth$/gi, ''), source: 'DigSpice', paths });
    } else if (/\.bin$/i.test(name)) {
      const m = parseQstarzBin(bytes);
      if (m) marks.push({ ...m, code: name.replace(/\.bin$/i, '') });
    }
  };
  for (const f of fileList) {
    const buf = await f.arrayBuffer();
    if (/\.zip$/i.test(f.name)) {
      const items = await unzip(buf);
      for (const it of items) await push(it.name, it.bytes);
    } else await push(f.name, new Uint8Array(buf));
  }
  progress('', 0);
  if (!cands.length && !marks.length)
    throw new Error('コースデータが見つかりませんでした。\nデジスパイスの .pth か Qstarz の .bin を含むZIP/ファイルをお選びください。');

  /* pick whichever course lies nearest to the loaded session */
  const here = sessionCentroid();
  let best = null;
  if (here) {
    for (const c of cands) {
      const d = kmBetween(pathCentroid(c.paths[0]), here);
      if (!best || d < best.d) best = { d, c };
    }
  } else if (cands.length) best = { d: 0, c: cands[0] };

  let mark = null;
  if (here) for (const m of marks) {
    const d = kmBetween([m.lon, m.lat], here);
    if (!mark || d < mark.d) mark = { d, m };
  }
  /* a course far from the data is the wrong course, not a nudge problem */
  if (best && best.d > 5) best = null;
  if (mark && mark.d > 5) mark = null;

  if (!best && !mark) throw new Error('このセッションの近くにあるコースが見つかりませんでした。\n別のコースのデータを読み込んでいませんか？');

  const sf = mark ? { lat: mark.m.lat, lon: mark.m.lon, heading: mark.m.heading } : null;
  const splits = mark && mark.m.splits ? mark.m.splits : [];
  A.track = best ? {
    name: (mark && mark.m.name) || best.c.name,
    source: best.c.source + (mark ? ' + Qstarz' : ''),
    paths: best.c.paths, sf, splits,
  } : {
    name: mark.m.name, source: 'Qstarz', paths: [], sf, splits,
  };
  classifyTrackPaths();
  applyTrackSplits();
  saveTrack();
  updateTrackInfo();
  mapFit(); drawMap();
  toast('コースマップを読み込みました: ' + A.track.name, 4000);
}

/* Qstarz stores sector lines as further records in the .bin. Project them onto
   the centreline to turn them into distances the rest of the app understands. */
function applyTrackSplits() {
  const T = A.track;
  if (!T || !T.splits || !T.splits.length || !A.C || !A.P) return;
  const ds = [];
  for (const s of T.splits) {
    const x = (s.lon - A.P.lon0) * A.P.kx, y = (s.lat - A.P.lat0) * A.P.ky;
    const r = projectXY(A.C, x, y, -1);
    if (r.dist < 40) ds.push(Math.round(r.d));
  }
  const uniq = [...new Set(ds)].filter(d => d > 5 && d < A.C.len - 5).sort((a, b) => a - b);
  if (!uniq.length) return;
  A.sectors = uniq;
  $('#secList').value = uniq.join(', ');
  toast('コースデータのスプリットから ' + (uniq.length + 1) + ' セクターを設定しました', 4000);
}

/* split geometry into the track surface and decorative detail */
function classifyTrackPaths() {
  const T = A.track; if (!T || !T.paths) return;
  T.solid = []; T.detail = [];
  for (const p of T.paths) {
    if (pathClosed(p) && pathLenM(p) > 150) T.solid.push(p); else T.detail.push(p);
  }
  T.lenM = T.solid.length ? pathLenM(T.solid[0]) : 0;
}

function updateTrackInfo() {
  const el = $('#trkInfo'); if (!el) return;
  const T = A.track;
  if (!T) { el.textContent = '公式コースマップ: 未読込（走行データから復元した路面を表示中）'; return; }
  el.innerHTML = '<b style="color:var(--good)">' + XE_(T.name) + '</b>（' + T.source + '）<br>' +
    (T.solid ? T.solid.length + ' 面 / ' + (T.detail ? T.detail.length : 0) + ' 線' : '') +
    (T.lenM ? ' · 外周 ' + T.lenM.toFixed(0) + ' m' : '') +
    (T.sf ? '<br>スタートライン ' + T.sf.lat.toFixed(6) + ', ' + T.sf.lon.toFixed(6) : '') +
    '<br><span style="color:var(--fg3)">出典: 読み込んだコースデータ（この端末にのみ保存）</span>';
}
const XE_ = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/* ---------- persistence (the user's own imported data, kept locally) ---------- */
function saveTrack() {
  if (!A.sid || !A.track) return;
  const st = readState(A.sid);
  st.track = {
    name: A.track.name, source: A.track.source, sf: A.track.sf, splits: A.track.splits || [],
    paths: A.track.paths.map(p => p.map(q => [+q[0].toFixed(6), +q[1].toFixed(6)])),
    nudgeX: TRK.nudgeX, nudgeY: TRK.nudgeY,
  };
  LS.set(A.sid, JSON.stringify(st));
}
function loadTrack() {
  const st = readState(A.sid);
  if (!st.track || !st.track.paths) { A.track = null; updateTrackInfo(); return; }
  A.track = { name: st.track.name, source: st.track.source, paths: st.track.paths, sf: st.track.sf, splits: st.track.splits || [] };
  TRK.nudgeX = st.track.nudgeX || 0; TRK.nudgeY = st.track.nudgeY || 0;
  $('#trkDX').value = TRK.nudgeX; $('#trkDY').value = TRK.nudgeY;
  classifyTrackPaths();
  updateTrackInfo();
}

/* ---------- drawing ---------- */
/* course lon/lat -> the session's local metric frame, plus the manual nudge */
function trackXY(lon, lat) {
  const P = A.P;
  return [(lon - P.lon0) * P.kx + TRK.nudgeX, (lat - P.lat0) * P.ky + TRK.nudgeY];
}
function drawOfficialTrack(g) {
  const T = A.track; if (!T || !A.P) return false;
  if (T.solid && T.solid.length) {
    g.beginPath();
    for (const poly of T.solid) {
      poly.forEach((q, i) => {
        const [x, y] = trackXY(q[0], q[1]);
        const [px, py] = mapXY(x, y);
        i ? g.lineTo(px, py) : g.moveTo(px, py);
      });
      g.closePath();
    }
    g.fillStyle = '#1b222c';
    g.fill('evenodd');                       // islands punch holes in the surface
    g.strokeStyle = '#3a4655'; g.lineWidth = 1.2;
    g.stroke();
  }
  if (T.detail && T.detail.length) {
    g.strokeStyle = '#2c3743'; g.lineWidth = 1;
    for (const poly of T.detail) {
      g.beginPath();
      poly.forEach((q, i) => {
        const [x, y] = trackXY(q[0], q[1]);
        const [px, py] = mapXY(x, y);
        i ? g.lineTo(px, py) : g.moveTo(px, py);
      });
      g.stroke();
    }
  }
  return !!(T.solid && T.solid.length);
}
/* fit the map to the official outline when we have one */
function trackBounds() {
  const T = A.track; if (!T || !T.solid || !T.solid.length || !A.P) return null;
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const poly of T.solid) for (const q of poly) {
    const [x, y] = trackXY(q[0], q[1]);
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return { x0, x1, y0, y1 };
}

/* ---------- wiring ---------- */
$('#trkPick').onclick = () => $('#trkFile').click();
$('#trkFile').onchange = async e => {
  const fs = [...e.target.files]; e.target.value = '';
  if (!fs.length) return;
  try { await importTrackFiles(fs); }
  catch (err) { console.error(err); showTrackErr(String(err.message || err)); }
};
function showTrackErr(msg) {
  const el = $('#trkInfo');
  el.innerHTML = '<span style="color:var(--bad);white-space:pre-wrap">' + XE_(msg) + '</span>';
}
$('#trkClear').onclick = () => {
  A.track = null;
  const st = readState(A.sid); delete st.track; LS.set(A.sid, JSON.stringify(st));
  updateTrackInfo(); mapFit(); drawMap();
};
const applyNudge = () => {
  TRK.nudgeX = +$('#trkDX').value || 0;
  TRK.nudgeY = +$('#trkDY').value || 0;
  saveTrack(); drawMap();
};
$('#trkDX').oninput = applyNudge;
$('#trkDY').oninput = applyNudge;
