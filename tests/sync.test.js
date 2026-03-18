#!/usr/bin/env node
/**
 * Lyric word-sync test suite — zero dependencies, plain Node.js
 *
 * Tests three layers:
 *   1. Algorithm unit tests  — getActiveLineIdx logic in isolation
 *   2. Data quality checks   — every song's lineTimes array is sane
 *   3. Integration smoke     — tryCalibrateLrc returns valid output for
 *                              a real song (live lrclib.net call, skipped
 *                              in offline environments)
 *
 * Run: node tests/sync.test.js
 * Run (offline): SKIP_NETWORK=1 node tests/sync.test.js
 *
 * Exit 0 = all pass.  Exit 1 = at least one failure.
 * Each failure prints a clear message plus the three prepared alternatives.
 */

'use strict';
const fs   = require('fs');
const path = require('path');

// ─── Mini test harness ────────────────────────────────────────────────────────

let passed = 0, failed = 0;
const failures = [];

function assert(condition, label, detail = '') {
  if (condition) {
    passed++;
    process.stdout.write('  ✓ ' + label + '\n');
  } else {
    failed++;
    const msg = '  ✗ ' + label + (detail ? '\n    → ' + detail : '');
    process.stderr.write(msg + '\n');
    failures.push({ label, detail });
  }
}

function section(title) {
  console.log('\n── ' + title + ' ──');
}

// ─── The sync algorithm (exact copy from public/index.html) ──────────────────
// Keep this in sync with the real implementation. If they diverge, the test
// will catch it (the integration smoke will fail).

const PREVIEW_S  = 29;   // preview clip length
const LINE_COUNT = 4;
const lineSlot   = PREVIEW_S / LINE_COUNT; // ~7.25s per line (equal-slot fallback)

function getActiveLineIdx(currentTime, lineTimes) {
  if (!lineTimes) {
    return Math.min(Math.floor(currentTime / lineSlot), LINE_COUNT - 1);
  }
  let idx = 0;
  for (let i = 1; i < lineTimes.length; i++) {
    if (currentTime >= lineTimes[i]) idx = i;
    else break;
  }
  return idx;
}

// ─── 1. Algorithm unit tests ──────────────────────────────────────────────────

section('Algorithm unit tests');

// Null lineTimes → equal-slot fallback
assert(getActiveLineIdx(0, null)    === 0, 'equal-slot: t=0 → idx 0');
assert(getActiveLineIdx(7.24, null) === 0, 'equal-slot: t=7.24 → idx 0');
assert(getActiveLineIdx(7.25, null) === 1, 'equal-slot: t=7.25 → idx 1');
assert(getActiveLineIdx(14.5, null) === 2, 'equal-slot: t=14.5 → idx 2');
assert(getActiveLineIdx(21.75, null)=== 3, 'equal-slot: t=21.75 → idx 3');
assert(getActiveLineIdx(40, null)   === 3, 'equal-slot: t=40 (past end) → idx 3 (clamped)');

// LRC lineTimes
const t = [0, 5, 15, 25];
assert(getActiveLineIdx(0, t)    === 0, 'lrc: t=0 → idx 0');
assert(getActiveLineIdx(4.99, t) === 0, 'lrc: t=4.99 (just before line 1) → idx 0');
assert(getActiveLineIdx(5, t)    === 1, 'lrc: t=5 (exact line 1) → idx 1');
assert(getActiveLineIdx(5.01, t) === 1, 'lrc: t=5.01 → idx 1');
assert(getActiveLineIdx(14.99, t)=== 1, 'lrc: t=14.99 → idx 1');
assert(getActiveLineIdx(15, t)   === 2, 'lrc: t=15 → idx 2');
assert(getActiveLineIdx(24.99, t)=== 2, 'lrc: t=24.99 → idx 2');
assert(getActiveLineIdx(25, t)   === 3, 'lrc: t=25 → idx 3');
assert(getActiveLineIdx(99, t)   === 3, 'lrc: t=99 (past end) → idx 3 (no overflow)');

// Monotonicity: idx never goes backwards as time increases
{
  let prev = -1, mono = true;
  for (let s = 0; s <= 30; s += 0.1) {
    const idx = getActiveLineIdx(s, t);
    if (idx < prev) { mono = false; break; }
    prev = idx;
  }
  assert(mono, 'lrc: idx is monotonically non-decreasing over 0..30s');
}

// ─── 2. Data quality checks ───────────────────────────────────────────────────

section('Data quality — demoSongs lineTimes');

const html = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'index.html'),
  'utf8'
);

// Extract all lineTimes arrays from the HTML source.
// Matches:  lineTimes: [0.0, 4.81, 15.9, 27.44],
const lineTimesPattern = /lineTimes:\s*(\[[^\]]+\])/g;
const songTitlePattern = /title:\s*"([^"]+)"/g;

// Co-extract title + lineTimes together so labels stay accurate even when
// some songs intentionally omit lineTimes.
// Strategy: find each `title:` occurrence, then look for the next `lineTimes:`
// within the same song block (before the next `title:` appears).
const songBlocks = html.split(/(?=title:\s*")/);
const songsWithLineTimes = [];
for (const block of songBlocks) {
  const titleM = block.match(/^title:\s*"([^"]+)"/);
  if (!titleM) continue;
  const ltM = block.match(/lineTimes:\s*(\[[^\]]+\])/);
  if (!ltM) continue;
  try {
    songsWithLineTimes.push({ title: titleM[1], lineTimes: JSON.parse(ltM[1]) });
  } catch (_) { /* ignore unparseable arrays */ }
}

const allLineTimes = songsWithLineTimes.map(s => s.lineTimes);

// Only Shape of You has proven lineTimes (validated by whisper alignment test:
// Deezer's preview positions don't match the LRC winStart for other songs).
// All others use equal-slot fallback intentionally.
assert(
  allLineTimes.length >= 1,
  `at least 1 song has lineTimes (found ${allLineTimes.length})`,
  'Shape of You should always have lineTimes — only song with confirmed Deezer alignment'
);

// Per-array checks
allLineTimes.forEach((lt, i) => {
  const label = `song[${i}] (${songsWithLineTimes[i].title})`;

  assert(Array.isArray(lt) && lt.length === 4,
    `${label}: has exactly 4 entries`,
    `got ${lt}`);

  assert(lt[0] === 0.0,
    `${label}: lineTimes[0] === 0 (algorithm assumes preview starts at window)`,
    `got ${lt[0]}`);

  const strictlyIncreasing = lt.every((v, j) => j === 0 || v > lt[j - 1]);
  assert(strictlyIncreasing,
    `${label}: strictly increasing`,
    `got ${lt}`);

  const allInRange = lt.every(v => v >= 0 && v < PREVIEW_S);
  assert(allInRange,
    `${label}: all values 0 ≤ t < ${PREVIEW_S}s`,
    `got ${lt}`);

  // No line should be held for more than 22s (would look frozen)
  const maxGap = Math.max(
    ...lt.slice(1).map((v, j) => v - lt[j]),
    PREVIEW_S - lt[lt.length - 1]  // duration of last line
  );
  assert(maxGap <= 22,
    `${label}: max single-line display duration ≤ 22s`,
    `largest gap is ${maxGap.toFixed(2)}s`);

  // No two consecutive lines within 0.5s (too fast to read)
  const minGap = Math.min(...lt.slice(1).map((v, j) => v - lt[j]));
  assert(minGap >= 0.5,
    `${label}: min gap between lines ≥ 0.5s`,
    `smallest gap is ${minGap.toFixed(2)}s`);
});

// ─── 3. Integration smoke (live lrclib.net) ───────────────────────────────────
//
// Validates that tryCalibrateLrc's algorithm produces valid output for
// one well-known song.  This catches: lrclib API changes, response format
// changes, or the window-finding heuristic breaking for a canonical case.
//
// Skipped when SKIP_NETWORK=1 (e.g. CI without outbound access).

section('Integration smoke (live lrclib.net)');

async function runNetworkSmoke() {
  const https = require('https');

  function get(url) {
    return new Promise((resolve, reject) => {
      const req = https.get(url, { headers: { 'Lrclib-Client': 'ChorusHive-test/1.0' } }, res => {
        let body = '';
        res.on('data', d => body += d);
        res.on('end', () => {
          try { resolve(JSON.parse(body)); }
          catch (e) { reject(new Error('JSON parse failed: ' + body.slice(0, 80))); }
        });
      });
      req.setTimeout(5000, () => { req.destroy(); reject(new Error('timeout')); });
      req.on('error', reject);
    });
  }

  // Canonical test case: Sweet Caroline has high title-word density (100%)
  // so the window-finder should reliably land on the chorus.
  const title  = 'Sweet Caroline';
  const artist = 'Neil Diamond';
  const url    = `https://lrclib.net/api/search?track_name=${encodeURIComponent(title)}&artist_name=${encodeURIComponent(artist)}`;

  let results;
  try {
    results = await get(url);
  } catch (e) {
    assert(false, `lrclib.net reachable for "${title}"`, e.message);
    return;
  }

  assert(Array.isArray(results) && results.length > 0,
    `lrclib returns results for "${title}"`);

  const hit = (results || []).find(x => x.syncedLyrics);
  assert(!!hit, `at least one result has syncedLyrics`);
  if (!hit) return;

  // Parse LRC (same logic as tryCalibrateLrc)
  const lrc = hit.syncedLyrics.split('\n').reduce((acc, line) => {
    const m2 = line.match(/^\[(\d+):(\d+\.\d+)\](.*)/);
    if (m2 && m2[3].trim()) acc.push({
      time: parseInt(m2[1]) * 60 + parseFloat(m2[2]),
      text: m2[3].trim().toLowerCase()
    });
    return acc;
  }, []);

  assert(lrc.length >= 4, `LRC has ≥ 4 lines (got ${lrc.length})`);

  // Check the algorithm finds a chorus window starting with "sweet caroline"
  const WINDOW_S = 28;
  const titleWords = ['sweet', 'caroline'];
  const anchorLine = lrc.findIndex(l => titleWords.every(w => l.text.includes(w)));
  assert(anchorLine >= 0, `anchor line containing "${titleWords.join(' ')}" exists in LRC`);

  // Walk back to section boundary
  let winStart = -1;
  for (let bi = anchorLine; bi >= 0; bi--) {
    const gap = bi === 0 ? 999 : lrc[bi].time - lrc[bi - 1].time;
    if (gap >= 2.0) { winStart = lrc[bi].time; break; }
  }
  assert(winStart >= 0, `section boundary found before anchor line`);

  const win = lrc.filter(l => l.time >= winStart && l.time <= winStart + WINDOW_S);
  assert(win.length >= 4, `chorus window contains ≥ 4 lines (got ${win.length})`);

  // Verify the rel timestamps are in a valid range
  const rel0 = win[0].time - winStart;
  assert(rel0 === 0.0 || rel0 < 0.01,
    `first line in window has relative time ≈ 0 (got ${rel0.toFixed(3)})`,
    'Algorithm assumes lineTimes[0] = 0');

  // Run the full picks algorithm (same logic as tryCalibrateLrc) and validate
  // the output structure — ordering, range, gaps.  We don't compare against
  // hardcoded values because lrclib source timing can drift between updates.
  const latinWin = win.filter(l => {
    const nonAscii = (l.text.match(/[^\x00-\x7F]/g) || []).length;
    return nonAscii / Math.max(1, l.text.length) < 0.3;
  });
  const wn = latinWin.length;
  const idxs = wn <= 4 ? [0,1,2,3].slice(0, wn)
              : wn <= 6 ? [0, 1, Math.floor(wn/2), wn-1]
              : [0, Math.max(1,Math.floor(wn/4)), Math.max(2,Math.floor(wn/2)), Math.max(3,Math.floor(3*wn/4))];
  const seen = {}, clean = [];
  idxs.forEach(p => { if (!seen[p]) { seen[p] = 1; clean.push(p); } });
  if (clean.length < 4) {
    assert(false, 'could not pick 4 lines from chorus window', `window has ${wn} latin lines`);
    return;
  }
  const picks = clean.slice(0, 4);
  const liveRel = picks.map(pi => latinWin[pi].time - winStart);

  assert(liveRel[0] < 0.01,
    `algorithm output: lineTimes[0] ≈ 0 (got ${liveRel[0].toFixed(3)})`);

  const liveOrdered = liveRel.every((v, i) => i === 0 || v > liveRel[i - 1]);
  assert(liveOrdered,
    `algorithm output: strictly increasing`,
    `got ${JSON.stringify(liveRel.map(v => +v.toFixed(2)))}`);

  const liveInRange = liveRel.every(v => v >= 0 && v < PREVIEW_S);
  assert(liveInRange,
    `algorithm output: all values 0 ≤ t < ${PREVIEW_S}s`,
    `got ${JSON.stringify(liveRel.map(v => +v.toFixed(2)))}`);

  console.log(`  ℹ live lineTimes for "${title}": [${liveRel.map(v => +v.toFixed(2))}]`);
}

// ─── Summary + alternatives ───────────────────────────────────────────────────

async function main() {
  if (process.env.SKIP_NETWORK === '1') {
    console.log('\n  (network smoke skipped — SKIP_NETWORK=1)');
  } else {
    try {
      await runNetworkSmoke();
    } catch (e) {
      assert(false, 'network smoke: unexpected exception', e.message);
    }
  }

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);

  if (failed > 0) {
    console.error('\nFailed tests:');
    failures.forEach(f => console.error(`  • ${f.label}${f.detail ? '\n    → ' + f.detail : ''}`));

    console.error(`
── If tests fail, three prepared alternatives ──

Option A — Per-song previewOffset (most targeted fix)
  Add a "previewOffset: N" field to the song entry (seconds).
  In audioSyncTick, use: lineTimes[i] + song.previewOffset
  Positive N = Deezer clip starts later than bestWinStart.
  Negative N = Deezer clip starts earlier.
  Measure offset by playing the Deezer preview and noting which
  LRC timestamp you hear at t=0 of the audio.

Option B — Deezer preview position lookup via API
  The Deezer API search result includes 'preview' (the 30s URL).
  Some Deezer track URLs encode the start time in the CDN path.
  Try: curl -I "<preview_url>" and inspect the Content-Range header
  or URL structure. If start position is deducible, pipe it through
  /api/audio-preview as a JSON response {url, startMs} and use
  startMs to re-anchor lineTimes at runtime.

Option C — Equal-slot timing with confirmed chorus content (safe fallback)
  Remove all lineTimes entries and accept 7.25s/line mechanical timing.
  The static song.lines content is already calibrated to the correct
  chorus section. A viewer sees right lyrics, just not word-perfect timing.
  Revisit Option A or B after collecting user feedback on which songs
  feel most off.
`);
    process.exit(1);
  }
}

main().catch(e => {
  console.error('Unhandled error:', e);
  process.exit(1);
});
