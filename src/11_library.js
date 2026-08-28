/* ===========================================================
   Hosted data library
   -----------------------------------------------------------
   When the app is served over http(s) - GitHub Pages, or the bundled
   launcher - it looks for data/manifest.json next to itself and offers the
   sessions listed there, so the files do not have to be picked by hand.

   Opened as a local file:// page this is skipped: the browser refuses to
   fetch neighbouring files from a file URL.
   =========================================================== */

const LIB = { manifest: null, base: '', busy: false };

function libBase() {
  const u = location.href.split('?')[0].split('#')[0];
  return u.slice(0, u.lastIndexOf('/') + 1);
}

async function loadLibrary() {
  if (location.protocol === 'file:') return;          // fetch is blocked from file://
  LIB.base = libBase();
  let mf = null;
  try {
    const r = await fetch(LIB.base + 'data/manifest.json', { cache: 'no-cache' });
    if (!r.ok) return;
    mf = await r.json();
  } catch (e) { return; }                              // no library published - fine
  if (!mf || !Array.isArray(mf.sessions) || !mf.sessions.length) return;
  LIB.manifest = mf;
  renderLibrary();

  /* ?s=<name or index> wins; otherwise an entry marked auto loads by itself */
  const q = new URLSearchParams(location.search).get('s');
  let pick = -1;
  if (q != null) {
    const byIdx = parseInt(q, 10);
    pick = mf.sessions.findIndex(s => s.name === q);
    if (pick < 0 && isFinite(byIdx) && mf.sessions[byIdx]) pick = byIdx;
    if (pick < 0) pick = mf.sessions.findIndex(s => (s.name || '').indexOf(q) >= 0);
  } else {
    pick = mf.sessions.findIndex(s => s.auto);
  }
  if (pick >= 0 && !A.C) openLibrarySession(pick);
}

function renderLibrary() {
  const box = $('#library'); if (!box || !LIB.manifest) return;
  box.innerHTML = '';
  const h = document.createElement('div');
  h.className = 'note'; h.style.textAlign = 'left';
  h.textContent = LIB.manifest.title || '公開されている走行データ';
  box.appendChild(h);
  LIB.manifest.sessions.forEach((s, i) => {
    const b = document.createElement('button');
    b.innerHTML = '▸ ' + XE_(s.name || ('セッション ' + (i + 1))) +
      (s.date ? ' <span style="color:var(--fg3)">' + XE_(s.date) + '</span>' : '') +
      (s.note ? ' <span style="color:var(--fg3)">' + XE_(s.note) + '</span>' : '');
    b.onclick = () => openLibrarySession(i);
    box.appendChild(b);
  });
  box.classList.remove('hide');
}

async function fetchAsFile(url) {
  const abs = /^https?:/i.test(url) ? url : LIB.base + url.replace(/^\.?\//, '');
  const r = await fetch(abs, { cache: 'no-cache' });
  if (!r.ok) throw new Error('ファイルを取得できませんでした: ' + url + '（HTTP ' + r.status + '）');
  const blob = await r.blob();
  return new File([blob], url.split('/').pop());
}

async function openLibrarySession(i) {
  const s = LIB.manifest && LIB.manifest.sessions[i];
  if (!s || LIB.busy) return;
  LIB.busy = true;
  $('#err').classList.add('hide');
  try {
    progress('サーバーからデータを取得しています…', 4);
    const files = [];
    for (const f of (s.files || [])) files.push(await fetchAsFile(f));
    if (!files.length) throw new Error('このセッションにはファイルが登録されていません。');
    await loadFiles(files, 'replace');

    /* course geometry, if the library publishes any */
    const tf = s.track || (LIB.manifest.track);
    if (tf && A.C && !A.track) {
      try {
        const list = Array.isArray(tf) ? tf : [tf];
        const tfiles = [];
        for (const f of list) tfiles.push(await fetchAsFile(f));
        await importTrackFiles(tfiles);
      } catch (e) { console.warn('course data skipped:', e); }
    }
  } catch (e) {
    console.error(e);
    $('#drop').classList.remove('hide');
    $('#dropClose').classList.toggle('hide', !A.C);
    showErr(String(e.message || e));
  } finally { LIB.busy = false; }
}

loadLibrary();
