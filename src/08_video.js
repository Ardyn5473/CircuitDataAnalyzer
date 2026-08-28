/* ===========================================================
   Video sync
   -----------------------------------------------------------
   The data has an absolute clock (lap.tStart + elapsed). A clip has its own
   0..duration clock. One number links them per clip:

       t0 = (absolute session time) - (position in the clip)

   Each clip carries its own t0, so a camera clock that drifts over a long
   endurance race is corrected every time a new clip is aligned.
   =========================================================== */
const V = {
  clips: [],            // {kind:'file'|'yt', name, url|vid, t0, dur, synced}
  active: -1,
  link: true,           // bidirectional following on/off
  sessionIndex: 0,      // which loaded session the video belongs to
  yt: null, ytReady: false, ytPending: null, ytCreating: false, ytReadyCbs: [],
  driving: null,        // 'data' | 'video' - guards the feedback loop
  poll: 0, lastSeek: 0, lastSeekTo: -1,
};

const YT_ORIGIN = 'https://www.youtube.com';
const IS_FILE = location.protocol === 'file:';

/* IFrame API error codes - each needs a different action from the user */
const YT_ERRORS = {
  2: '動画IDが正しくありません。URLを確認してください。',
  5: 'この動画はHTML5プレーヤーで再生できませんでした。',
  100: '動画が見つかりません。削除済みか非公開の可能性があります。',
  101: 'この動画は所有者の設定で外部サイトへの埋め込みが許可されていません。',
  150: 'この動画は所有者の設定で外部サイトへの埋め込みが許可されていません。',
};

/* ---------- helpers ---------- */
function vClip() { return V.clips[V.active] || null; }
function vHasSynced() { return V.clips.some(c => c.synced); }

/* absolute session time under the cursor (NaN when unavailable) */
function cursorAbsTime() {
  const k = A.sel[0]; if (k == null) return NaN;
  if (A.siOf(k) !== V.sessionIndex) return NaN;      // cursor is on another day
  const lap = A.lapByKey(k), rl = A.getLap(k);
  if (!lap || !rl) return NaN;
  return lap.tStart + sampleAt(rl, A.cursor, 't');
}

/* inverse of the lap's time-vs-distance curve */
function distAtElapsed(rl, el) {
  const M = rl.M;
  if (!(el > rl.t[0])) return 0;
  if (el >= rl.tEnd) return rl.L;
  let lo = 0, hi = M - 1;
  while (lo < hi - 1) { const m = (lo + hi) >> 1; if (rl.t[m] <= el) lo = m; else hi = m; }
  const span = rl.t[hi] - rl.t[lo];
  return (lo + (span > 0 ? (el - rl.t[lo]) / span : 0)) * rl.step;
}

/* which clip covers an absolute time: synced clips sorted by t0 own the span
   up to the next one (or their own duration when it is known) */
function clipForTime(T) {
  const s = V.clips.map((c, i) => ({ c, i })).filter(x => x.c.synced).sort((a, b) => a.c.t0 - b.c.t0);
  for (let n = 0; n < s.length; n++) {
    const cur = s[n], nxt = s[n + 1];
    const end = cur.c.dur ? cur.c.t0 + cur.c.dur : (nxt ? nxt.c.t0 : Infinity);
    if (T >= cur.c.t0 && T < (nxt ? Math.min(end, nxt.c.t0) : end)) return cur.i;
  }
  return -1;
}

/* ---------- player abstraction ---------- */
function vTime() {
  const c = vClip(); if (!c) return NaN;
  if (c.kind === 'file') { const e = $('#vidFile'); return e ? e.currentTime : NaN; }
  return V.yt && V.ytReady && V.yt.getCurrentTime ? V.yt.getCurrentTime() : NaN;
}
function vDuration() {
  const c = vClip(); if (!c) return 0;
  if (c.kind === 'file') { const e = $('#vidFile'); return e && isFinite(e.duration) ? e.duration : 0; }
  return V.yt && V.ytReady && V.yt.getDuration ? V.yt.getDuration() : 0;
}
function vSeek(t) {
  const c = vClip(); if (!c) return;
  if (c.kind === 'file') { const e = $('#vidFile'); if (e) e.currentTime = Math.max(0, t); }
  else if (V.yt && V.ytReady) V.yt.seekTo(Math.max(0, t), true);
}
function vIsPlaying() {
  const c = vClip(); if (!c) return false;
  if (c.kind === 'file') { const e = $('#vidFile'); return e && !e.paused && !e.ended; }
  return V.yt && V.ytReady && V.yt.getPlayerState && V.yt.getPlayerState() === 1;
}

/* ---------- data -> video ---------- */
function videoFollowCursor() {
  if (!V.link || V.driving === 'video' || V.active < 0) return;
  const c = vClip(); if (!c || !c.synced) return;
  const T = cursorAbsTime(); if (!isFinite(T)) return;

  const want = clipForTime(T);
  if (want >= 0 && want !== V.active) { videoSetActive(want, T); return; }

  const ct = T - c.t0;
  if (ct < -1 || (c.dur && ct > c.dur + 1)) return;      // outside this clip
  const now = performance.now();
  /* YouTube seeks are slow and jerky, so rate-limit while scrubbing */
  if (now - V.lastSeek < (c.kind === 'yt' ? 220 : 60)) return;
  if (Math.abs(ct - V.lastSeekTo) < 0.05) return;
  V.driving = 'data';
  V.lastSeek = now; V.lastSeekTo = ct;
  vSeek(ct);
  setTimeout(() => { if (V.driving === 'data') V.driving = null; }, 120);
  vUpdateBar();
}

/* ---------- video -> data ---------- */
function videoTick() {
  if (!V.link || V.active < 0) return;
  const c = vClip(); if (!c || !c.synced) return;
  if (V.driving === 'data') return;
  if (!vIsPlaying()) return;
  const ct = vTime(); if (!isFinite(ct)) return;
  const T = c.t0 + ct;
  const s = A.sessions[V.sessionIndex]; if (!s) return;
  let lap = null;
  for (const l of s.laps) if (T >= l.tStart && T < l.tEnd) { lap = l; break; }
  if (!lap) { vUpdateBar(); return; }
  const key = A.key(V.sessionIndex, lap.num);
  V.driving = 'video';
  if (A.sel[0] !== key) {                       // follow the video across laps
    const rest = A.sel.filter(k => k !== key);
    A.sel = [key].concat(rest).slice(0, 8);
    renderLapTable();
  }
  const rl = A.getLap(key);
  if (rl) setCursor(distAtElapsed(rl, T - lap.tStart));
  V.driving = null;
  vUpdateBar();
}

/* ---------- clip management ---------- */
function videoSetActive(i, seekToAbs) {
  const c = V.clips[i]; if (!c) return;
  V.active = i;
  const fileEl = $('#vidFile'), ytEl = $('#vidYT');
  fileEl.classList.toggle('hide', c.kind !== 'file');
  ytEl.classList.toggle('hide', c.kind !== 'yt');
  if (c.kind === 'file') {
    if (fileEl.dataset.url !== c.url) { fileEl.src = c.url; fileEl.dataset.url = c.url; }
  } else if (V.yt && V.ytReady) {
    V.yt.loadVideoById(c.vid);
  }
  if (seekToAbs != null && c.synced) setTimeout(() => vSeek(seekToAbs - c.t0), 300);
  vRenderClips(); vUpdateBar();
}

function videoAddFiles(files) {
  let added = 0;
  for (const f of files) {
    if (!/^video\//.test(f.type) && !/\.(mp4|mov|m4v|webm|mkv|avi)$/i.test(f.name)) continue;
    V.clips.push({ kind: 'file', name: f.name, url: URL.createObjectURL(f), t0: NaN, dur: 0, synced: false });
    added++;
  }
  if (!added) { toast('動画ファイルが見つかりませんでした'); return; }
  if (V.active < 0) videoSetActive(V.clips.length - added);
  vRenderClips();
  toast(added + ' 本の動画を追加しました。位置を合わせて「ここで同期」を押してください', 4200);
}

/* accepts watch / youtu.be / playlist URLs, one per line */
function parseYouTube(text) {
  const vids = [], lists = [];
  for (const raw of String(text).split(/[\s,]+/)) {
    if (!raw) continue;
    let m = raw.match(/[?&]list=([A-Za-z0-9_-]+)/);
    if (m) { lists.push(m[1]); continue; }
    m = raw.match(/[?&]v=([A-Za-z0-9_-]{6,})/) || raw.match(/youtu\.be\/([A-Za-z0-9_-]{6,})/)
      || raw.match(/\/embed\/([A-Za-z0-9_-]{6,})/);
    if (m) { vids.push(m[1]); continue; }
    if (/^[A-Za-z0-9_-]{11}$/.test(raw)) vids.push(raw);
  }
  return { vids, lists };
}

function videoLoadYouTube(text) {
  const { vids, lists } = parseYouTube(text);
  if (!vids.length && !lists.length) { toast('YouTubeのURLを認識できませんでした'); return; }
  if (IS_FILE) {
    $('#vidMsg').classList.remove('hide');
    $('#vidMsg').innerHTML = 'このページは <b>file://</b> で開かれています。この状態ではYouTubeの'
      + '埋め込み再生がブロックされます。<br>同梱の <b>CDAを起動.bat</b> をダブルクリックして'
      + '開き直すと利用できます。<br>（動画ファイルを選ぶ方式は file:// でも動作します）';
  }
  ytEnsureApi(() => {
    if (lists.length) ytCuePlaylist(lists[0]);
    else {
      for (const v of vids) V.clips.push({ kind: 'yt', name: 'YouTube ' + v, vid: v, t0: NaN, dur: 0, synced: false });
      ytEnsurePlayer(() => videoSetActive(V.clips.findIndex(c => c.kind === 'yt')));
      vRenderClips();
    }
  });
}

/* The published page blocks every external host, so the API script cannot load
   there. Say so plainly instead of failing silently. */
function ytEnsureApi(cb) {
  if (window.YT && window.YT.Player) return cb();
  if (V.ytPending) { V.ytPending.push(cb); return; }
  V.ytPending = [cb];
  const done = ok => { const q = V.ytPending || []; V.ytPending = null; if (ok) q.forEach(f => f()); };
  window.onYouTubeIframeAPIReady = () => done(true);
  const s = document.createElement('script');
  s.src = YT_ORIGIN + '/iframe_api';
  s.onerror = () => { done(false); vShowYtBlocked(); };
  setTimeout(() => { if (V.ytPending) { done(false); vShowYtBlocked(); } }, 8000);
  document.head.appendChild(s);
}
function vShowYtBlocked() {
  $('#vidMsg').classList.remove('hide');
  $('#vidMsg').innerHTML =
    'YouTubeプレーヤーを読み込めませんでした。<br>' +
    '公開URL版は外部サーバーへの通信が遮断されているため、YouTube同期は<b>PCのローカル版 index.html</b> でのみ利用できます。<br>' +
    'この画面では「動画ファイルを選ぶ」をお使いください。';
}

/* The player's methods (cuePlaylist, loadVideoById, getPlaylist...) do not exist
   until onReady fires, so every caller has to queue behind it. */
function ytEnsurePlayer(cb) {
  if (V.yt && V.ytReady) return cb && cb();
  if (V.ytCreating) { if (cb) V.ytReadyCbs.push(cb); return; }
  V.ytCreating = true; V.ytReadyCbs = cb ? [cb] : [];
  $('#vidYT').classList.remove('hide');
  $('#vidEmpty').classList.add('hide');
  V.yt = new YT.Player('vidYT', {
    host: YT_ORIGIN,
    playerVars: { rel: 0, playsinline: 1, modestbranding: 1 },
    events: {
      onReady: () => {
        V.ytReady = true; V.ytCreating = false;
        const q = V.ytReadyCbs; V.ytReadyCbs = [];
        q.forEach(f => { try { f(); } catch (e) { console.error(e); } });
        vUpdateBar();
      },
      onStateChange: () => vUpdateBar(),
      onError: e => {
        const code = e && e.data;
        let msg = YT_ERRORS[code] || ('動画を再生できませんでした（コード ' + code + '）。');
        /* From a file:// page the frame has no real origin, so YouTube rejects
           the embed. This is by far the most common cause, so say it first. */
        if (IS_FILE) msg = 'ファイルを直接開いた状態（file://）では、YouTubeの埋め込み再生が'
          + 'ブロックされます。<br>同梱の <b>CDAを起動.bat</b> から開くと解決します。'
          + '<br><span style="color:var(--fg3)">（参考: ' + msg + '）</span>';
        $('#vidMsg').classList.remove('hide');
        $('#vidMsg').innerHTML = msg;
        toast(IS_FILE ? 'file:// ではYouTubeを再生できません。CDAを起動.bat をお使いください' : msg.replace(/<[^>]+>/g, ''), 6000);
      },
    }
  });
}

function ytCuePlaylist(listId) {
  ytEnsurePlayer(() => {
    V.yt.cuePlaylist({ list: listId, listType: 'playlist' });
    setTimeout(grab, 800);
  });
  let tries = 0;
  const grab = () => {
    if (!V.yt || !V.ytReady || !V.yt.getPlaylist) return setTimeout(grab, 400);
    const ids = V.yt.getPlaylist();
    if (!ids || !ids.length) {
      if (++tries > 25) { toast('プレイリストを読み取れませんでした。動画URLを個別に貼り付けてください', 5000); return; }
      return setTimeout(grab, 400);
    }
    for (let i = 0; i < ids.length; i++)
      V.clips.push({ kind: 'yt', name: '動画 ' + (i + 1), vid: ids[i], t0: NaN, dur: 0, synced: false });
    V.active = V.clips.length - ids.length;
    vRenderClips(); vUpdateBar();
    toast(ids.length + ' 本の動画を読み込みました。1本ずつ「ここで同期」で合わせてください', 5000);
  };
}

/* ---------- sync ---------- */
function videoSyncHere() {
  const c = vClip(); if (!c) { toast('先に動画を読み込んでください'); return; }
  const T = cursorAbsTime();
  if (!isFinite(T)) { toast('同期する日のラップを選んでからにしてください'); return; }
  const ct = vTime();
  if (!isFinite(ct)) { toast('動画の再生位置を取得できませんでした'); return; }
  c.t0 = T - ct;
  c.dur = vDuration() || c.dur;
  c.synced = true;
  vRenderClips(); vUpdateBar();
  toast('同期しました（この動画の0秒 = ' + new Date(c.t0 * 1000).toLocaleTimeString('ja-JP') + '）', 4000);
  saveVideoState();
}
function videoUnsync() {
  const c = vClip(); if (!c) return;
  c.synced = false; c.t0 = NaN; vRenderClips(); vUpdateBar(); saveVideoState();
}

/* ---------- persistence (YouTube clips only; blob URLs die with the tab) ---------- */
function saveVideoState() {
  if (!A.sid) return;
  const st = readState(A.sid);
  st.video = {
    sessionIndex: V.sessionIndex,
    clips: V.clips.filter(c => c.kind === 'yt').map(c => ({ vid: c.vid, name: c.name, t0: c.t0, dur: c.dur, synced: c.synced }))
  };
  LS.set(A.sid, JSON.stringify(st));
}
function loadVideoState() {
  const st = readState(A.sid);
  if (!st.video || !st.video.clips || !st.video.clips.length) return;
  V.sessionIndex = st.video.sessionIndex || 0;
  V.restore = st.video.clips;
  $('#vidRestore').classList.remove('hide');
  $('#vidRestore').textContent = '前回のYouTube同期設定を復元 (' + st.video.clips.length + '本)';
}

/* A new session invalidates every clip: blob URLs belong to the old files and
   a t0 aligned to another day is meaningless. */
function videoResetForSession() {
  for (const c of V.clips) if (c.kind === 'file' && c.url) { try { URL.revokeObjectURL(c.url); } catch (e) { } }
  V.clips = []; V.active = -1; V.sessionIndex = 0; V.restore = null;
  const fe = $('#vidFile');
  if (fe) { fe.pause && fe.pause(); fe.removeAttribute('src'); fe.dataset.url = ''; }
  $('#vidEmpty').classList.remove('hide');
  $('#vidRestore').classList.add('hide');
  $('#vidMsg').classList.add('hide');
  vRenderClips(); vUpdateBar();
  loadVideoState();
}

/* ---------- UI ---------- */
function vRenderClips() {
  const box = $('#vidClips'); if (!box) return;
  box.innerHTML = '';
  box.classList.toggle('hide', V.clips.length < 2);
  V.clips.forEach((c, i) => {
    const b = document.createElement('button');
    b.className = 'vclip' + (i === V.active ? ' on' : '') + (c.synced ? ' ok' : '');
    b.textContent = (c.synced ? '● ' : '○ ') + (i + 1);
    b.title = c.name + (c.synced ? '（同期済み）' : '（未同期）');
    b.onclick = () => videoSetActive(i);
    box.appendChild(b);
  });
}
function vUpdateBar() {
  const c = vClip();
  const el = $('#vidInfo'); if (!el) return;
  if (!c) { el.textContent = '動画が読み込まれていません'; return; }
  const ct = vTime();
  el.innerHTML = (c.synced ? '<b style="color:var(--good)">同期済み</b>' : '<b style="color:var(--warn)">未同期</b>')
    + ' · ' + c.name.slice(0, 28)
    + (isFinite(ct) ? ' · ' + ct.toFixed(1) + ' s' : '');
}

function videoTogglePanel(force) {
  const p = $('#vidPanel');
  const show = force != null ? force : p.classList.contains('hide');
  p.classList.toggle('hide', !show);
  $('#btnVideo').classList.toggle('on', show);
  if (show && !V.poll) V.poll = setInterval(() => { videoTick(); if (!vIsPlaying()) vUpdateBar(); }, 200);
  if (!show && V.poll) { clearInterval(V.poll); V.poll = 0; }
  if (A.C) redraw();
}

/* ---------------- wiring ---------------- */
$('#btnVideo').onclick = () => videoTogglePanel();
$('#vidClose').onclick = () => videoTogglePanel(false);
$('#vidLink').onclick = e => { V.link = !V.link; e.target.classList.toggle('on', V.link); };
$('#vidPickFile').onclick = () => $('#vidFileInput').click();
$('#vidAddMore').onclick = () => $('#vidFileInput').click();
$('#vidFileInput').onchange = e => { if (e.target.files.length) videoAddFiles([...e.target.files]); e.target.value = ''; };
$('#vidLoadUrl').onclick = () => videoLoadYouTube($('#vidUrl').value.trim());
$('#vidUrl').onkeydown = e => { if (e.key === 'Enter') $('#vidLoadUrl').click(); };
$('#vidSync').onclick = videoSyncHere;
$('#vidUnsync').onclick = videoUnsync;
$('#vidRestore').onclick = () => {
  if (!V.restore) return;
  ytEnsureApi(() => {
    for (const c of V.restore) V.clips.push({ kind: 'yt', name: c.name, vid: c.vid, t0: c.t0, dur: c.dur, synced: c.synced });
    ytEnsurePlayer(() => videoSetActive(V.clips.length - V.restore.length));
    V.restore = null; $('#vidRestore').classList.add('hide');
    vRenderClips();
  });
};

/* hide the placeholder once something is loaded */
const _vSetActive = videoSetActive;
videoSetActive = function (i, seekToAbs) {
  _vSetActive(i, seekToAbs);
  $('#vidEmpty').classList.toggle('hide', V.clips.length > 0);
};

/* a local <video> drives the data directly while it plays */
$('#vidFile').addEventListener('timeupdate', () => { if (vIsPlaying()) videoTick(); });
$('#vidFile').addEventListener('seeked', () => { vUpdateBar(); if (V.driving !== 'data') videoTick(); });
$('#vidFile').addEventListener('loadedmetadata', () => {
  const c = vClip(); if (c && c.kind === 'file') { c.dur = $('#vidFile').duration || 0; vUpdateBar(); }
});
