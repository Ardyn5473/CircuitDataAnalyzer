/* Headless verification of the analysis pipeline against the real Mihama data */
import { readFileSync } from 'fs';
import vm from 'vm';
import { join } from 'path';

const DATA = 'C:/Users/Akito Nakada/Documents/2026年度_活動資料/2026年_自動車部活動/K4GP活動/データ分析ツール/0823美浜耐久_CSV一式';
const SRC = 'C:/Users/Akito Nakada/Documents/2026年度_活動資料/2026年_自動車部活動/K4GP活動/データ分析ツール/CircuitDataAnalyzer/src';

const ctx = vm.createContext({ console, TextDecoder, setTimeout, performance, Math, Date, JSON, document: { querySelector: () => ({ style: {}, classList: { add() { }, remove() { } } }) } });
vm.runInContext(readFileSync(join(SRC, '03_core.js'), 'utf8'), ctx);
vm.runInContext(readFileSync(join(SRC, '04_track.js'), 'utf8'), ctx);
const G = k => vm.runInContext(k, ctx);

const rd = f => readFileSync(join(DATA, f), 'utf8').replace(/^\uFEFF/, '');
const wp = rd('01_WayPoints.csv'), lapCsv = rd('02_Lap.csv'), beacon = rd('07_Beacon.csv');

ctx.__wp = wp;
const ok = (name, cond, extra = '') => console.log((cond ? '  PASS ' : '  FAIL ') + name + (extra ? '  :: ' + extra : ''));

const run = async () => {
  const head = ctx.splitLine(ctx.csvLines(wp)[0]).map(s => s.trim());
  const map = ctx.autoMap(head);
  console.log('\n=== column mapping ===');
  console.log(Object.entries(map).map(([k, v]) => `${k} -> ${head[v]}`).join('\n'));
  ok('lat/lon mapped', map.lat !== undefined && map.lon !== undefined);
  ok('Gx->longitudinal', head[map.gx] === 'Gx');
  ok('Gy->lateral', head[map.gy] === 'Gy');
  ok('no gyro column', map.yaw === undefined);

  console.log('\n=== parse ===');
  const t0 = Date.now();
  const P = await ctx.buildPoints(wp, map, null);
  console.log(`  parsed ${P.n} points in ${Date.now() - t0} ms, ${P.hz.toFixed(2)} Hz`);
  ok('point count', P.n === 190558, String(P.n));
  ok('10 Hz detected', Math.abs(P.hz - 10) < 0.05, P.hz.toFixed(3));
  let spMax = 0; for (let i = 0; i < P.n; i++) if (P.ch.speed[i] > spMax) spMax = P.ch.speed[i];
  ok('speed already km/h (no rescale)', spMax > 60 && spMax < 100, spMax.toFixed(1));
  ok('yaw derived from heading', P.yawDerived === true);
  ok('ids captured', !!P.id && P.id[0] === 1);
  const t = P.t;
  console.log('  first sample local time:', new Date(t[0] * 1000).toISOString(), '/ span', ((t[P.n - 1] - t[0]) / 3600).toFixed(2), 'h');

  console.log('\n=== laps from logger table ===');
  const laps = ctx.lapsFromCsvTest ? null : null;
  // replicate lapsFromCsv (lives in 06_app.js) here
  const rows = ctx.parseCsvSmall(lapCsv).rows;
  const idAt = id => { let lo = 0, hi = P.n - 1; if (id <= P.id[0]) return 0; if (id >= P.id[hi]) return hi; while (lo < hi - 1) { const m = (lo + hi) >> 1; if (P.id[m] <= id) lo = m; else hi = m; } return lo; };
  const L2 = [];
  for (const r of rows) {
    const i0 = idAt(+r.start_wp), i1 = idAt(+r.finish_wp);
    if (!(i1 > i0)) continue;
    let tS = P.t[i0];
    const ilat = +r.start_inter_lat, ilon = +r.start_inter_lon;
    if (isFinite(ilat) && i0 + 1 < P.n) {
      const ax = (P.lon[i0] - P.lon0) * P.kx, ay = (P.lat[i0] - P.lat0) * P.ky;
      const bx = (P.lon[i0 + 1] - P.lon0) * P.kx, by = (P.lat[i0 + 1] - P.lat0) * P.ky;
      const cx = (ilon - P.lon0) * P.kx, cy = (ilat - P.lat0) * P.ky;
      const ex = bx - ax, ey = by - ay, l2 = ex * ex + ey * ey;
      if (l2 > 0) { const fr = Math.min(1, Math.max(0, ((cx - ax) * ex + (cy - ay) * ey) / l2)); tS = P.t[i0] + (P.t[i0 + 1] - P.t[i0]) * fr; }
    }
    L2.push({ num: L2.length + 1, tStart: tS, time: +r.duration, tEnd: tS + (+r.duration), i0, i1 });
  }
  ok('220 laps', L2.length === 220, String(L2.length));
  const times = L2.map(l => l.time).sort((a, b) => a - b), med = times[110];
  for (const l of L2) l.valid = l.time > med * 0.75 && l.time < med * 1.6;
  console.log(`  best ${Math.min(...times).toFixed(3)}s  median ${med.toFixed(3)}s  valid ${L2.filter(l => l.valid).length}/220`);
  // continuity: lap N end should equal lap N+1 start
  let maxGap = 0, gapLap = 0;
  for (let i = 0; i < L2.length - 1; i++) {
    const g = Math.abs(L2[i].tEnd - L2[i + 1].tStart);
    if (g > maxGap) { maxGap = g; gapLap = L2[i].num; }
  }
  ok('lap chain continuous (<150ms)', maxGap < 0.15, `worst ${(maxGap * 1000).toFixed(0)} ms at lap ${gapLap} (${L2[gapLap - 1].time.toFixed(1)}s)`);

  console.log('\n=== beacon-based detection (fallback path) ===');
  const b = ctx.parseCsvSmall(beacon).rows[0];
  const CL = ctx.makeControlLine(P, +b.lat, +b.lon, +b.heading, Math.max(20, +b.width));
  const bl = ctx.detectLaps(P, CL);
  ok('beacon finds ~same lap count', Math.abs(bl.length - 220) <= 2, String(bl.length));
  if (bl.length > 5) {
    let d = 0, c = 0;
    for (let i = 0; i < Math.min(bl.length, L2.length); i++) { d += Math.abs(bl[i].time - L2[i].time); c++; }
    console.log('  mean |beaconTime - loggerTime| =', (d / c * 1000).toFixed(1), 'ms');
  }
  console.log('\n=== auto-guess control line (generic logger path) ===');
  /* the guessed line sits at an arbitrary point on the track, so the lap *count*
     legitimately differs from the beacon's; what must hold is that every detected
     lap is a real full lap. */
  const gl = ctx.guessControlLine(P);
  const gLaps = gl ? ctx.detectLaps(P, gl) : [];
  const gt = gLaps.map(l => l.time).sort((a, b) => a - b), gmed = gt[gt.length >> 1];
  const runt = gLaps.filter(l => l.time < gmed * 0.7).length;
  console.log(`  ${gLaps.length} laps, median ${gmed.toFixed(3)}s, shortest ${gt[0].toFixed(3)}s`);
  ok('no partial/duplicate laps', runt === 0, runt + ' runts');
  ok('median matches logger within 1%', Math.abs(gmed - med) / med < 0.01, `${gmed.toFixed(3)} vs ${med.toFixed(3)}`);

  console.log('\n=== centerline ===');
  const valid = L2.filter(l => l.valid);
  const best = valid.reduce((a, x) => x.time < a.time ? x : a);
  const t1 = Date.now();
  const C = ctx.buildCenterline(P, best.i0, best.i1, 1);
  console.log(`  best lap #${best.num} ${best.time.toFixed(3)}s -> centerline ${C.len.toFixed(1)} m, ${C.M} nodes (${Date.now() - t1} ms)`);
  ok('track length plausible (900±40m)', Math.abs(C.len - 911) < 40, C.len.toFixed(1));

  console.log('\n=== projection ===');
  const t2 = Date.now();
  const PR = await ctx.projectAll(P, C, null);
  const okCount = PR.ok.reduce((a, v) => a + v, 0);
  console.log(`  projected ${P.n} pts in ${Date.now() - t2} ms`);
  ok('>=98% points on track', okCount / P.n > 0.98, (okCount / P.n * 100).toFixed(2) + '%');
  let offAbs = 0, offN = 0, offMax = 0;
  for (const l of L2) {                                    // only while actually lapping
    if (!l.valid) continue;
    for (let i = l.i0; i <= l.i1; i++) { const a = Math.abs(PR.off[i]); offAbs += a; offN++; if (a > offMax) offMax = a; }
  }
  console.log('  mean |lateral offset| on racing laps =', (offAbs / offN).toFixed(2), 'm  (max', offMax.toFixed(1), 'm)');
  ok('mean offset < 3 m', offAbs / offN < 3);

  console.log('\n=== resampling + delta time ===');
  const keys = Object.keys(P.ch);
  const t3 = Date.now();
  const rBest = ctx.resampleLap(P, C, PR, best, keys, 1, 5);
  const others = valid.filter(l => l.num !== best.num).slice(0, 5).map(l => ctx.resampleLap(P, C, PR, l, keys, 1, 5));
  console.log(`  resampled 6 laps in ${Date.now() - t3} ms, M=${rBest.M}`);
  ok('elapsed time monotonic', (() => { for (let i = 1; i < rBest.M; i++) if (rBest.t[i] <= rBest.t[i - 1]) return false; return true; })());
  ok('resampled lap end time ~ lap time', Math.abs(rBest.t[rBest.M - 1] - best.time) < 1.5,
    `${rBest.t[rBest.M - 1].toFixed(3)} vs ${best.time.toFixed(3)}`);
  console.log('  final Δ vs lap time (should match lap-time difference):');
  let deltaErr = 0;
  for (let k = 0; k < others.length; k++) {
    const rl = others[k], lp = valid.filter(l => l.num !== best.num)[k];
    const dEnd = rl.t[rl.M - 1] - rBest.t[rBest.M - 1];
    const dTrue = lp.time - best.time;
    deltaErr = Math.max(deltaErr, Math.abs(dEnd - dTrue));
    console.log(`    Lap ${String(lp.num).padStart(3)}  Δend ${dEnd >= 0 ? '+' : ''}${dEnd.toFixed(3)}s   true ${dTrue >= 0 ? '+' : ''}${dTrue.toFixed(3)}s   err ${(Math.abs(dEnd - dTrue) * 1000).toFixed(0)} ms`);
  }
  ok('Δ-time closes within 150 ms', deltaErr < 0.15, (deltaErr * 1000).toFixed(0) + ' ms');

  console.log('\n=== channel sanity on best lap ===');
  const mm = k => { let a = Infinity, b = -Infinity; for (let i = 0; i < rBest.M; i++) { const v = rBest[k][i]; if (v < a) a = v; if (v > b) b = v; } return [a, b]; };
  for (const k of ['speed', 'gx', 'gy', 'gz', 'yaw']) {
    const [a, b] = mm(k); console.log(`  ${k.padEnd(6)} ${a.toFixed(2)} .. ${b.toFixed(2)}`);
  }
  const [ymin, ymax] = mm('yaw');
  ok('yaw rate in a sane range', Math.abs(ymin) < 120 && ymax < 120);
  const [smin, smax] = mm('speed');
  ok('speed range sane', smin > 15 && smax < 100);

  console.log('\n=== lap start alignment (regression: start/finish wrap) ===');
  /* Every lap must begin at the same physical point. If interpAtTime interpolates
     across the finish-line wrap, dStart lands mid-lap and that lap's whole
     distance axis is silently rotated. */
  {
    const RE = 6378137.0, toM = (la1, lo1, la2, lo2) => {
      const x = (lo2 - lo1) * Math.PI / 180 * Math.cos((la1 + la2) / 2 * Math.PI / 180) * RE;
      const y = (la2 - la1) * Math.PI / 180 * RE;
      return Math.hypot(x, y);
    };
    /* Use the CONTROL-LINE detected laps: their tStart is interpolated strictly
       between a sample before the finish line and one after it, which is exactly
       the case that wraps. (The Qstarz lap table starts each lap just past the
       line, so it never exercises this.) */
    const blValid = bl.filter(l => l.time > gmed * 0.85 && l.time < gmed * 1.3);
    const pick = blValid.slice(0, 60);
    const sample = pick.map(l => ctx.resampleLap(P, C, PR, l, keys, 1, 5));
    let worst = 0, worstLap = 0;
    sample.forEach((rl, i) => {
      const d = toM(sample[0].lat[0], sample[0].lon[0], rl.lat[0], rl.lon[0]);
      if (d > worst) { worst = d; worstLap = pick[i].num; }
    });
    console.log('  worst lap-start offset =', worst.toFixed(1), 'm (lap', worstLap + ')');
    ok('all laps start at the same point (<15 m)', worst < 15, worst.toFixed(1) + ' m');
    /* Direct rotation check: the point a lap reports at grid index g must lie on
       the centerline near node g. A rotated axis puts it hundreds of metres away.
       (Comparing elapsed-time curves between laps cannot work here - a lap held up
       in traffic legitimately differs by many seconds.) */
    let worstD = 0, worstDLap = 0;
    sample.forEach((rl, i) => {
      let m = 0;
      for (let g = 0; g < rl.M; g += 5) {
        const x = (rl.lon[g] - P.lon0) * P.kx, y = (rl.lat[g] - P.lat0) * P.ky;
        const d = Math.hypot(x - C.x[g], y - C.y[g]);
        if (d > m) m = d;
      }
      if (m > worstD) { worstD = m; worstDLap = pick[i].num; }
    });
    console.log('  worst distance from centerline node at same index =', worstD.toFixed(1), 'm (lap', worstDLap + ')');
    ok('no lap has a rotated distance axis (<25 m)', worstD < 25, worstD.toFixed(1) + ' m');
  }

  console.log('\n=== sector times ===');
  const bnds = [0, Math.round(C.len / 3), Math.round(C.len * 2 / 3), C.len];
  const sec = [];
  for (let i = 0; i < 3; i++) sec.push(ctx.sampleAt(rBest, bnds[i + 1] - 0.001, 't') - ctx.sampleAt(rBest, bnds[i], 't'));
  console.log('  ' + sec.map((s, i) => `S${i + 1} ${s.toFixed(3)}s`).join('  ') + `  sum ${sec.reduce((a, b) => a + b).toFixed(3)}s vs lap ${best.time.toFixed(3)}s`);
  ok('sector sum ≈ lap time', Math.abs(sec.reduce((a, b) => a + b) - best.time) < 1.0);
};
run().catch(e => { console.error('FATAL', e); process.exit(1); });
