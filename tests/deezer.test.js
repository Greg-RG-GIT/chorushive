#!/usr/bin/env node
/**
 * Deezer preview health check — validates every demo song gets a working preview.
 *
 * For each song:
 *   1. Hits the Deezer search API (same logic as /api/audio-preview)
 *   2. Checks the matched result has a .mp3 preview URL
 *   3. Checks the matched artist/title is a reasonable match (not a wrong song)
 *   4. Fetches the first 512 bytes of the preview to verify it's real MP3 data
 *
 * Run: node tests/deezer.test.js
 * Skip: SKIP_NETWORK=1 node tests/deezer.test.js  (prints a note and exits 0)
 * Exit 0 = all pass.  Exit 1 = at least one failure.
 *
 * This test catches:
 *   - Songs Deezer can't find (Cruel Summer was failing in alignment test)
 *   - Wrong-song matches (Deezer returns a remix, cover, or unrelated track)
 *   - Dead/expired preview URLs (CDN returns 403 or 404)
 *   - Non-MP3 responses (DRM content, HTML error pages)
 */

'use strict';
const fs   = require('fs');
const path = require('path');

if (process.env.SKIP_NETWORK) {
  console.log('SKIP_NETWORK=1 — skipping Deezer health check');
  process.exit(0);
}

// ── Mini harness ─────────────────────────────────────────────────────────────

let passed = 0, failed = 0, warned = 0;

function assert(cond, label, detail = '') {
  if (cond) {
    passed++;
    process.stdout.write('  ✓ ' + label + '\n');
  } else {
    failed++;
    process.stderr.write('  ✗ ' + label + (detail ? '\n    → ' + detail : '') + '\n');
  }
}

function warn(cond, label, detail = '') {
  if (cond) {
    passed++;
    process.stdout.write('  ✓ ' + label + '\n');
  } else {
    warned++;
    process.stdout.write('  ~ ' + label + (detail ? '\n    → ' + detail : '') + '\n');
  }
}

function section(title) { console.log('\n── ' + title + ' ──'); }

// ── Extract demoSongs from HTML ───────────────────────────────────────────────

const html = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'index.html'), 'utf8'
);

const startIdx = html.indexOf('const demoSongs = [');
if (startIdx === -1) { process.stderr.write('FATAL: demoSongs not found\n'); process.exit(1); }

let depth = 0, inStr = false, strChar = '', endIdx = startIdx;
const src = html.slice(startIdx);
for (let i = 0; i < src.length; i++) {
  const ch = src[i];
  if (inStr) { if (ch === '\\') { i++; continue; } if (ch === strChar) inStr = false; continue; }
  if (ch === '"' || ch === "'" || ch === '`') { inStr = true; strChar = ch; continue; }
  if (ch === '[') depth++;
  if (ch === ']') { depth--; if (depth === 0) { endIdx = startIdx + i + 1; break; } }
}

let demoSongs;
try {
  demoSongs = eval('const demoSongs = ' + src.slice(src.indexOf('['), endIdx - startIdx + 1) + '; demoSongs'); // eslint-disable-line no-eval
} catch (e) { process.stderr.write('FATAL: could not parse demoSongs: ' + e.message + '\n'); process.exit(1); }

// ── Fetch helpers ─────────────────────────────────────────────────────────────

async function deezerSearch(artist, title) {
  const q   = encodeURIComponent(`artist:"${artist}" track:"${title}"`);
  const url = `https://api.deezer.com/search?q=${q}&limit=5`;
  const res = await fetch(url, {
    signal: AbortSignal.timeout(6000),
    headers: { 'User-Agent': 'ChorusHive/1.0 (test)' },
  });
  if (!res.ok) throw new Error(`Deezer returned ${res.status}`);
  return res.json();
}

async function fetchFirstBytes(url, bytes = 512) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(8000),
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; ChorusHive/1.0)',
      'Referer':    'https://www.deezer.com/',
      'Range':      `bytes=0-${bytes - 1}`,
    },
  });
  if (!res.ok) throw new Error(`preview fetch returned ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, contentType: res.headers.get('content-type') || '', buf };
}

function isMp3(buf) {
  // MP3 frame sync: 0xFF 0xEx or 0xFF 0xFx
  if (buf[0] === 0xFF && (buf[1] & 0xE0) === 0xE0) return true;
  // ID3 header: "ID3"
  if (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) return true;
  return false;
}

function titleOverlap(expected, actual) {
  // Returns fraction of significant expected words found in actual title
  const stop = new Set(['the','a','an','and','of','in','on','at','to','it','is','are','or']);
  const words = expected.toLowerCase().replace(/[',\-]/g, ' ').split(/\s+/)
    .filter(w => w.length > 1 && !stop.has(w));
  if (!words.length) return 1;
  const actualLow = actual.toLowerCase();
  const hits = words.filter(w => actualLow.includes(w)).length;
  return hits / words.length;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function runAll() {
  section('Deezer preview health — all 20 songs');
  console.log('  (fetches Deezer API + first bytes of each preview URL)\n');

  const results = [];

  for (const song of demoSongs) {
    const { title, artist } = song;
    process.stdout.write(`  ${title} — ${artist}\n`);

    // 1. Search
    let data;
    try {
      data = await deezerSearch(artist, title);
    } catch (e) {
      assert(false, `  ${title}: Deezer search succeeded`, e.message);
      results.push({ title, status: 'search_fail' });
      continue;
    }

    const results_list = data.data || [];
    assert(results_list.length > 0,
      `  ${title}: Deezer returned ≥1 result (got ${results_list.length})`);

    if (!results_list.length) { results.push({ title, status: 'no_results' }); continue; }

    // 2. Find best match (same logic as audio-preview.js)
    // Deezer CDN URLs now have query strings — check path only
    const hasPreview = r => r.preview && r.preview.split('?')[0].endsWith('.mp3');
    const match =
      results_list.find(r => r.title.toLowerCase().includes(title.toLowerCase()) && hasPreview(r)) ||
      results_list.find(hasPreview) ||
      results_list[0];

    assert(hasPreview(match),
      `  ${title}: matched result has .mp3 preview`,
      `preview: ${match?.preview || 'none'}`);

    if (!match?.preview) { results.push({ title, status: 'no_preview' }); continue; }

    // 3. Title similarity check
    const overlap = titleOverlap(title, match.title);
    warn(overlap >= 0.5,
      `  ${title}: Deezer match looks correct ("${match.title}" by ${match.artist?.name || '?'})`,
      `overlap ${(overlap*100).toFixed(0)}% — may be wrong song`);

    // 4. Preview URL reachability + MP3 check
    let previewOk = false;
    try {
      const { status, contentType, buf } = await fetchFirstBytes(match.preview);
      const mp3 = isMp3(buf);
      assert(mp3,
        `  ${title}: preview URL returns valid MP3 data`,
        `content-type: ${contentType}, first bytes: ${buf.slice(0,4).toString('hex')}`);
      previewOk = mp3;
    } catch (e) {
      assert(false, `  ${title}: preview URL is reachable`, e.message);
    }

    results.push({ title, status: previewOk ? 'ok' : 'bad_audio' });
    process.stdout.write('\n');
  }

  // ── Summary ──
  section('Summary');
  const ok      = results.filter(r => r.status === 'ok').length;
  const broken  = results.filter(r => r.status !== 'ok');

  console.log(`  ${ok}/${demoSongs.length} songs have working Deezer previews (19 after removing Cruel Summer)`);
  if (broken.length) {
    console.log(`  Broken:`);
    broken.forEach(r => console.log(`    ✗ ${r.title} (${r.status})`));
  }

  console.log('\n' + '─'.repeat(52));
  console.log(`Results: ${passed} passed, ${failed} failed, ${warned} warnings`);
  process.exit(failed > 0 ? 1 : 0);
}

runAll().catch(e => { process.stderr.write('FATAL: ' + e.message + '\n'); process.exit(1); });
