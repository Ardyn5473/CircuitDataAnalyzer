/* ===========================================================
   Report export : PNG images and a PowerPoint (.pptx) deck
   -----------------------------------------------------------
   A .pptx is a ZIP of OOXML parts. Everything is written here by hand so the
   app keeps its "single file, no dependencies" property. Entries are STORED
   (uncompressed) - valid ZIP, and the payload is mostly PNG which is already
   compressed.
   =========================================================== */

/* ---------- CRC32 ---------- */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

/* ---------- minimal ZIP writer (stored entries) ---------- */
function zipWrite(files) {           // files: [{name, bytes:Uint8Array}]
  const enc = new TextEncoder();
  const locals = [], central = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const data = f.bytes;
    const crc = crc32(data);
    const lh = new Uint8Array(30 + name.length);
    const dv = new DataView(lh.buffer);
    dv.setUint32(0, 0x04034b50, true);
    dv.setUint16(4, 20, true);          // version needed
    dv.setUint16(6, 0x0800, true);      // UTF-8 names
    dv.setUint16(8, 0, true);           // stored
    dv.setUint16(10, 0, true); dv.setUint16(12, 0, true);   // time/date
    dv.setUint32(14, crc, true);
    dv.setUint32(18, data.length, true);
    dv.setUint32(22, data.length, true);
    dv.setUint16(26, name.length, true);
    dv.setUint16(28, 0, true);
    lh.set(name, 30);
    locals.push(lh, data);

    const ch = new Uint8Array(46 + name.length);
    const cv = new DataView(ch.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true); cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, 0, true); cv.setUint16(14, 0, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    ch.set(name, 46);
    central.push(ch);
    offset += lh.length + data.length;
  }
  let cdSize = 0; for (const c of central) cdSize += c.length;
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, central.length, true);
  ev.setUint16(10, central.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  return new Blob([...locals, ...central, eocd], { type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' });
}

/* ---------- OOXML helpers ---------- */
const XE = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const NS_P = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const EMU_W = 12192000, EMU_H = 6858000;      // 16:9
const BG = '0D1014', FG = 'E8EDF4', DIM = '9AA8BA', ACC = '38BDF8';

let _shapeId = 1;
function txBox(text, x, y, w, h, opts) {
  const o = opts || {};
  const sz = (o.size || 18) * 100;
  const col = o.color || FG;
  const lines = String(text).split('\n');
  const paras = lines.map(t =>
    '<a:p><a:pPr algn="' + (o.align || 'l') + '"/>' +
    (t === '' ? '<a:endParaRPr lang="ja-JP"/>' :
      '<a:r><a:rPr lang="ja-JP" sz="' + sz + '" b="' + (o.bold ? 1 : 0) + '" dirty="0">' +
      '<a:solidFill><a:srgbClr val="' + col + '"/></a:solidFill>' +
      '<a:latin typeface="' + (o.mono ? 'Consolas' : 'Meiryo UI') + '"/>' +
      '<a:ea typeface="Meiryo UI"/></a:rPr><a:t>' + XE(t) + '</a:t></a:r>') +
    '</a:p>').join('');
  const id = ++_shapeId;
  return '<p:sp><p:nvSpPr><p:cNvPr id="' + id + '" name="tx' + id + '"/><p:cNvSpPr txBox="1"/>' +
    '<p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="' + Math.round(x) + '" y="' + Math.round(y) + '"/>' +
    '<a:ext cx="' + Math.round(w) + '" cy="' + Math.round(h) + '"/></a:xfrm>' +
    '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>' +
    '<p:txBody><a:bodyPr wrap="square" anchor="t"><a:normAutofit/></a:bodyPr><a:lstStyle/>' + paras + '</p:txBody></p:sp>';
}
function picShape(rId, x, y, w, h) {
  const id = ++_shapeId;
  return '<p:pic><p:nvPicPr><p:cNvPr id="' + id + '" name="img' + id + '"/>' +
    '<p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>' +
    '<p:blipFill><a:blip r:embed="' + rId + '"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>' +
    '<p:spPr><a:xfrm><a:off x="' + Math.round(x) + '" y="' + Math.round(y) + '"/>' +
    '<a:ext cx="' + Math.round(w) + '" cy="' + Math.round(h) + '"/></a:xfrm>' +
    '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>';
}
function tableShape(rows, x, y, w, colW) {
  const id = ++_shapeId;
  const rowH = 250000;
  const cell = (t, hdr) =>
    '<a:tc><a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:pPr algn="' + (hdr ? 'ctr' : 'r') + '"/>' +
    '<a:r><a:rPr lang="ja-JP" sz="1000" b="' + (hdr ? 1 : 0) + '">' +
    '<a:solidFill><a:srgbClr val="' + (hdr ? ACC : FG) + '"/></a:solidFill>' +
    '<a:latin typeface="Consolas"/><a:ea typeface="Meiryo UI"/></a:rPr>' +
    '<a:t>' + XE(t) + '</a:t></a:r></a:p></a:txBody>' +
    '<a:tcPr marL="45000" marR="45000" marT="20000" marB="20000" anchor="ctr">' +
    '<a:solidFill><a:srgbClr val="' + (hdr ? '1B222C' : '141920') + '"/></a:solidFill></a:tcPr></a:tc>';
  const trs = rows.map((r, i) =>
    '<a:tr h="' + rowH + '">' + r.map(c => cell(c, i === 0)).join('') + '</a:tr>').join('');
  return '<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="' + id + '" name="tbl' + id + '"/>' +
    '<p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr>' +
    '<p:xfrm><a:off x="' + Math.round(x) + '" y="' + Math.round(y) + '"/>' +
    '<a:ext cx="' + Math.round(w) + '" cy="' + Math.round(rowH * rows.length) + '"/></p:xfrm>' +
    '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table">' +
    '<a:tbl><a:tblPr firstRow="1" bandRow="1"/><a:tblGrid>' +
    colW.map(c => '<a:gridCol w="' + Math.round(c) + '"/>').join('') +
    '</a:tblGrid>' + trs + '</a:tbl></a:graphicData></a:graphic></p:graphicFrame>';
}
function slideXml(body) {
  return XML + '<p:sld ' + NS_P + '><p:cSld><p:bg><p:bgPr>' +
    '<a:solidFill><a:srgbClr val="' + BG + '"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>' +
    '<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
    '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/>' +
    '<a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>' +
    body + '</p:spTree></p:cSld><p:clrMapOvr><a:overrideClrMapping bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" ' +
    'accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" ' +
    'accent6="accent6" hlink="hlink" folHlink="folHlink"/></p:clrMapOvr></p:sld>';
}

const THEME = XML +
  '<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="CDA">' +
  '<a:themeElements><a:clrScheme name="CDA">' +
  '<a:dk1><a:srgbClr val="000000"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1>' +
  '<a:dk2><a:srgbClr val="0D1014"/></a:dk2><a:lt2><a:srgbClr val="E8EDF4"/></a:lt2>' +
  '<a:accent1><a:srgbClr val="38BDF8"/></a:accent1><a:accent2><a:srgbClr val="F87171"/></a:accent2>' +
  '<a:accent3><a:srgbClr val="4ADE80"/></a:accent3><a:accent4><a:srgbClr val="FBBF24"/></a:accent4>' +
  '<a:accent5><a:srgbClr val="C084FC"/></a:accent5><a:accent6><a:srgbClr val="F472B6"/></a:accent6>' +
  '<a:hlink><a:srgbClr val="38BDF8"/></a:hlink><a:folHlink><a:srgbClr val="C084FC"/></a:folHlink></a:clrScheme>' +
  '<a:fontScheme name="CDA"><a:majorFont><a:latin typeface="Meiryo UI"/><a:ea typeface="Meiryo UI"/><a:cs typeface=""/></a:majorFont>' +
  '<a:minorFont><a:latin typeface="Meiryo UI"/><a:ea typeface="Meiryo UI"/><a:cs typeface=""/></a:minorFont></a:fontScheme>' +
  '<a:fmtScheme name="CDA">' +
  '<a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' +
  '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst>' +
  '<a:lnStyleLst>' +
  '<a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln>' +
  '<a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln>' +
  '<a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln></a:lnStyleLst>' +
  '<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle>' +
  '<a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>' +
  '<a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' +
  '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst>' +
  '</a:fmtScheme></a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>';

const EMPTY_SPTREE = '<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
  '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/>' +
  '<a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree>';

const SLIDE_MASTER = XML + '<p:sldMaster ' + NS_P + '><p:cSld><p:bg><p:bgPr>' +
  '<a:solidFill><a:srgbClr val="' + BG + '"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>' +
  EMPTY_SPTREE + '</p:cSld>' +
  '<p:clrMap bg1="dk1" tx1="lt1" bg2="dk2" tx2="lt2" accent1="accent1" accent2="accent2" accent3="accent3" ' +
  'accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>' +
  '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst></p:sldMaster>';

const SLIDE_LAYOUT = XML + '<p:sldLayout ' + NS_P + ' type="blank" preserve="1"><p:cSld name="Blank">' +
  EMPTY_SPTREE + '</p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>';

/* ---------- canvas capture ---------- */
function canvasPng(cv) {
  return new Promise(res => cv.toBlob(b => res(b), 'image/png'));
}
/* redraw a canvas at a larger size so the slide image is not blurry */
async function captureHiRes(which, w, h) {
  const cv = $(which === 'chart' ? '#chart' : '#map');
  const oldW = cv.style.width, oldH = cv.style.height;
  const parent = cv.parentElement;
  const pw = parent.style.width, ph = parent.style.height;
  parent.style.width = w + 'px'; parent.style.height = h + 'px';
  if (which === 'chart') drawChart(); else { mapFit(); drawMap(); }
  const blob = await canvasPng(cv);
  parent.style.width = pw; parent.style.height = ph;
  cv.style.width = oldW; cv.style.height = oldH;
  if (which === 'chart') drawChart(); else { mapFit(); drawMap(); }
  return blob;
}

/* ---------- report content ---------- */
function reportRows() {
  const b = [0, ...A.sectors, A.C.len];
  const head = ['ラップ', 'ドライバー', 'タイム', 'Δベスト', '最高速', '最大横G'];
  for (let i = 0; i < b.length - 1; i++) head.push('S' + (i + 1));
  const best = A.bestTimeAll();
  const rows = [head];
  for (const k of A.sel) {
    const l = A.lapByKey(k), rl = A.getLap(k), sx = A.sessOf(k);
    if (!l) continue;
    const secs = [];
    for (let i = 0; i < b.length - 1; i++)
      secs.push(rl ? (sampleAt(rl, b[i + 1] - .001, 't') - sampleAt(rl, b[i], 't')).toFixed(2) : '');
    rows.push([(A.sessions.length > 1 ? sx.short + ' ' : '') + 'L' + l.num,
    driverOfKey(k) || '—', fmtTime(l.time), fmtDelta(l.time - best),
    (l.maxSpd || 0).toFixed(0), (l.maxLat || 0).toFixed(2), ...secs]);
  }
  return rows;
}

async function buildPptx() {
  if (!A.C) throw new Error('データが読み込まれていません。');
  if (!A.sel.length) throw new Error('スライドに載せるラップを選択してください。');
  _shapeId = 1;
  const enc = new TextEncoder();
  const files = [];
  const put = (name, str) => files.push({ name, bytes: enc.encode(str) });

  const mapPng = await captureHiRes('map', 900, 900);
  const chartPng = await captureHiRes('chart', 1600, 900);
  const mapBytes = new Uint8Array(await mapPng.arrayBuffer());
  const chartBytes = new Uint8Array(await chartPng.arrayBuffer());

  const S = A.sessions;
  const title = (S[0].meta.track || 'Circuit') + ' 走行データ解析';
  const sub = S.map(s => s.short + '（' + s.laps.length + '周 / ベスト ' +
    fmtTime(Math.min.apply(null, s.laps.filter(l => l.valid).map(l => l.time))) + '）').join('　');
  const notes = readState(A.sid);
  const meta = notes.meta || {};

  /* --- slide 1: cover --- */
  const s1 = slideXml(
    txBox(title, 900000, 2000000, 10400000, 900000, { size: 40, bold: true, color: FG }) +
    txBox(sub, 900000, 3050000, 10400000, 700000, { size: 18, color: ACC }) +
    txBox([meta.driver ? 'ドライバー: ' + meta.driver : '', meta.vehicle ? '車両: ' + meta.vehicle : '',
    meta.weather ? '天候: ' + meta.weather : '', 'コース長(実測): ' + A.C.len.toFixed(1) + ' m']
      .filter(Boolean).join('　'), 900000, 3750000, 10400000, 600000, { size: 13, color: DIM }) +
    txBox('Circuit Data Analyzer　' + new Date().toLocaleDateString('ja-JP'),
      900000, 5900000, 10400000, 400000, { size: 11, color: DIM }));

  /* --- slide 2: track map + legend --- */
  const mh = 4900000, mw = mh;                        // map capture is square
  const s2 = slideXml(
    txBox('走行ライン', 685800, 400000, 6000000, 600000, { size: 24, bold: true }) +
    picShape('rId2', 685800, 1200000, mw, mh) +
    txBox(A.sel.map((k, i) => '■ ' + lapLabel(k, { short: true }) + '  ' + fmtTime(A.lapByKey(k).time)).join('\n'),
      6100000, 1300000, 5400000, 4000000, { size: 14, mono: true, color: FG }));

  /* --- slide 3: channels --- */
  const cw = 10900000, ch2 = cw * 900 / 1600;
  const s3 = slideXml(
    txBox('チャンネル比較（コース距離軸）', 685800, 300000, 9000000, 500000, { size: 22, bold: true }) +
    picShape('rId2', 685800, 950000, cw, ch2));

  /* --- slide 4: lap table --- */
  const rows = reportRows();
  const nCol = rows[0].length;
  const tW = 10900000;
  const colW = rows[0].map((_, i) => i === 1 ? tW * 0.16 : (i === 0 ? tW * 0.13 : (tW * 0.71) / (nCol - 2)));
  const s4 = slideXml(
    txBox('ラップ比較', 685800, 300000, 9000000, 500000, { size: 22, bold: true }) +
    tableShape(rows, 685800, 1000000, tW, colW) +
    txBox('セクター区切り: ' + [0, ...A.sectors].map(v => Math.round(v) + 'm').join(' / '),
      685800, 6100000, 9000000, 400000, { size: 11, color: DIM }));

  /* --- slide 5: notes --- */
  const mk = (A.markers || []).map(m => '・' + m.d + ' m : ' + m.text).join('\n');
  const s5 = slideXml(
    txBox('気づき・メモ', 685800, 300000, 9000000, 500000, { size: 22, bold: true }) +
    txBox(notes.global || '（メモは未記入）', 685800, 1000000, 10800000, 2600000, { size: 14 }) +
    txBox(mk ? 'マーカー\n' + mk : '', 685800, 3800000, 10800000, 2400000, { size: 13, color: DIM }));

  const slides = [s1, s2, s3, s4, s5];

  /* ---- package ---- */
  put('[Content_Types].xml', XML +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Default Extension="png" ContentType="image/png"/>' +
    '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>' +
    '<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>' +
    '<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>' +
    '<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>' +
    slides.map((_, i) => '<Override PartName="/ppt/slides/slide' + (i + 1) +
      '.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>').join('') +
    '</Types>');

  put('_rels/.rels', XML +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>' +
    '</Relationships>');

  put('ppt/presentation.xml', XML + '<p:presentation ' + NS_P + ' saveSubsetFonts="1">' +
    '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>' +
    '<p:sldIdLst>' + slides.map((_, i) =>
      '<p:sldId id="' + (256 + i) + '" r:id="rId' + (i + 2) + '"/>').join('') + '</p:sldIdLst>' +
    '<p:sldSz cx="' + EMU_W + '" cy="' + EMU_H + '"/><p:notesSz cx="' + EMU_H + '" cy="' + EMU_W + '"/>' +
    '</p:presentation>');

  put('ppt/_rels/presentation.xml.rels', XML +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>' +
    slides.map((_, i) => '<Relationship Id="rId' + (i + 2) +
      '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide' + (i + 1) + '.xml"/>').join('') +
    '<Relationship Id="rId' + (slides.length + 2) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/>' +
    '</Relationships>');

  put('ppt/theme/theme1.xml', THEME);
  put('ppt/slideMasters/slideMaster1.xml', SLIDE_MASTER);
  put('ppt/slideMasters/_rels/slideMaster1.xml.rels', XML +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/>' +
    '</Relationships>');
  put('ppt/slideLayouts/slideLayout1.xml', SLIDE_LAYOUT);
  put('ppt/slideLayouts/_rels/slideLayout1.xml.rels', XML +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/>' +
    '</Relationships>');

  slides.forEach((xml, i) => {
    put('ppt/slides/slide' + (i + 1) + '.xml', xml);
    const img = i === 1 ? 'image1.png' : (i === 2 ? 'image2.png' : null);
    put('ppt/slides/_rels/slide' + (i + 1) + '.xml.rels', XML +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>' +
      (img ? '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/' + img + '"/>' : '') +
      '</Relationships>');
  });

  files.push({ name: 'ppt/media/image1.png', bytes: mapBytes });
  files.push({ name: 'ppt/media/image2.png', bytes: chartBytes });

  return zipWrite(files);
}

/* ---------- save helpers ---------- */
async function saveBinary(name, blob) {
  const use = window.claude && window.claude.use;
  if (use) {
    let dl = null;
    try { dl = await window.claude.use('downloads'); } catch (e) { dl = null; }
    if (!dl) { toast('この画面ではファイルの書き出しを利用できません'); return; }
    try { await dl.save({ filename: name, data: blob }); toast('書き出しました: ' + name); }
    catch (e) { if (e && e.code !== 'declined') toast('書き出しできませんでした'); }
    return;
  }
  const u = URL.createObjectURL(blob), a = document.createElement('a');
  a.href = u; a.download = name; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(u); a.remove(); }, 800);
}

async function exportPptx() {
  try {
    toast('スライドを作成しています…');
    const blob = await buildPptx();
    await saveBinary('CDA_' + (A.meta.track || 'report') + '.pptx', blob);
  } catch (e) { console.error(e); toast(String(e.message || e), 5000); }
}
async function exportPng() {
  try {
    const map = await captureHiRes('map', 900, 900);
    const chart = await captureHiRes('chart', 1600, 900);
    await saveBinary('CDA_map.png', map);
    await saveBinary('CDA_chart.png', chart);
  } catch (e) { console.error(e); toast('画像を書き出せませんでした'); }
}

$('#expPptx').onclick = exportPptx;
$('#expPng').onclick = exportPng;
