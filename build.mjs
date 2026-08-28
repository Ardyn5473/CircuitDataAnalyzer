// Concatenate src/* into a single self-contained index.html
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
const D = dirname(fileURLToPath(import.meta.url));
const r = f => readFileSync(join(D, 'src', f), 'utf8');

const html = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8">
${r('01_head.html')}
</head><body>
${r('02_body.html')}
<script>
${r('03_core.js')}
${r('04_track.js')}
${r('05_render.js')}
${r('06_app.js')}
${r('07_ui.js')}
${r('08_video.js')}
<\/script>
</body></html>
`;
writeFileSync(join(D, 'index.html'), html, 'utf8');

// artifact version: no doctype/html/head/body wrapper
const art = `${r('01_head.html')}
${r('02_body.html')}
<script>
${r('03_core.js')}
${r('04_track.js')}
${r('05_render.js')}
${r('06_app.js')}
${r('07_ui.js')}
${r('08_video.js')}
<\/script>
`;
writeFileSync(join(D, 'artifact.html'), art, 'utf8');
console.log('built index.html', html.length, 'bytes / artifact.html', art.length);
