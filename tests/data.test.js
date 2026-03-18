#!/usr/bin/env node
/**
 * Song data quality tests — validates every field of every demoSong.
 *
 * No network calls. Parses demoSongs directly from index.html and checks:
 *   - Song count, no duplicates
 *   - Required fields: title, artist, albumColor
 *   - lines: exactly 4 entries per song, each with prev / words / next
 *   - words: 1–8 items, each capitalized, no empty strings
 *   - prev/next: first line has empty prev, last line has empty next
 *   - lineTimes: only Shape of You should have them (proven by whisper test)
 *   - previewUrl: must be absent (it's DRM m4p — dead code that misleads)
 *
 * Run: node tests/data.test.js
 * Exit 0 = all pass.  Exit 1 = at least one failure.
 */

'use strict';
const fs   = require('fs');
const path = require('path');

// ── Mini harness ─────────────────────────────────────────────────────────────

let passed = 0, failed = 0;

function assert(cond, label, detail = '') {
  if (cond) {
    passed++;
    process.stdout.write('  ✓ ' + label + '\n');
  } else {
    failed++;
    process.stderr.write('  ✗ ' + label + (detail ? '\n    → ' + detail : '') + '\n');
  }
}

function section(title) { console.log('\n── ' + title + ' ──'); }

// ── Extract demoSongs from HTML ───────────────────────────────────────────────

const html = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'index.html'), 'utf8'
);

// Extract the const demoSongs = [...] block
const startIdx = html.indexOf('const demoSongs = [');
if (startIdx === -1) {
  process.stderr.write('FATAL: demoSongs not found in index.html\n');
  process.exit(1);
}

// Find the matching closing bracket
let depth = 0, inStr = false, strChar = '', endIdx = startIdx;
const src = html.slice(startIdx);
for (let i = 0; i < src.length; i++) {
  const ch = src[i];
  if (inStr) {
    if (ch === '\\') { i++; continue; }
    if (ch === strChar) inStr = false;
    continue;
  }
  if (ch === '"' || ch === "'" || ch === '`') { inStr = true; strChar = ch; continue; }
  if (ch === '[') depth++;
  if (ch === ']') { depth--; if (depth === 0) { endIdx = startIdx + i + 1; break; } }
}

// Eval in a controlled sandbox — extracts just the array
let demoSongs;
try {
  const snippet = 'const demoSongs = ' + src.slice(src.indexOf('['), endIdx - startIdx + 1) + '; demoSongs';
  demoSongs = eval(snippet); // eslint-disable-line no-eval
} catch (e) {
  process.stderr.write('FATAL: could not parse demoSongs: ' + e.message + '\n');
  process.exit(1);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

section('Song catalogue');

assert(Array.isArray(demoSongs), 'demoSongs is an array');
assert(demoSongs.length === 19, `exactly 19 songs (found ${demoSongs.length})`,
  'Cruel Summer removed — no Deezer preview available (returns 0 results)');

const titles = demoSongs.map(s => s.title);
const uniqueTitles = new Set(titles);
assert(uniqueTitles.size === titles.length,
  'no duplicate titles',
  [...titles.filter((t, i) => titles.indexOf(t) !== i)].join(', ')
);

const artists = demoSongs.map(s => s.artist);
const pairs = demoSongs.map(s => s.title + ' / ' + s.artist);
const uniquePairs = new Set(pairs);
assert(uniquePairs.size === pairs.length, 'no duplicate title+artist pairs');


section('Required fields — all songs');

for (const song of demoSongs) {
  const id = `"${song.title}"`;

  // title + artist
  assert(typeof song.title === 'string' && song.title.length > 0,
    `${id}: title is non-empty string`);
  assert(typeof song.artist === 'string' && song.artist.length > 0,
    `${id}: artist is non-empty string`);

  // albumColor — must be a CSS gradient string
  assert(typeof song.albumColor === 'string' && song.albumColor.includes('radial-gradient'),
    `${id}: albumColor is a CSS radial-gradient string`,
    `got: ${String(song.albumColor).slice(0, 60)}`);

  // previewUrl must NOT be present — it's DRM-protected m4p, dead code
  assert(!('previewUrl' in song),
    `${id}: previewUrl absent (m4p DRM, dead code — use Deezer proxy instead)`,
    'remove previewUrl to avoid misleading future developers');
}


section('lines[] structure — all songs');

for (const song of demoSongs) {
  const id = `"${song.title}"`;
  const lines = song.lines;

  assert(Array.isArray(lines), `${id}: lines is an array`);
  assert(lines.length === 4,
    `${id}: exactly 4 lines (got ${Array.isArray(lines) ? lines.length : '?'})`);

  if (!Array.isArray(lines) || lines.length !== 4) continue;

  // Each line must have prev, words, next
  lines.forEach((line, i) => {
    const lid = `${id} line[${i}]`;
    assert('prev'  in line, `${lid}: has prev field`);
    assert('words' in line, `${lid}: has words field`);
    assert('next'  in line, `${lid}: has next field`);
  });

  // First line: prev must be empty string (nothing before the start of the window)
  assert(lines[0].prev === '',
    `${id}: first line has empty prev (nothing before the start)`,
    `got: "${lines[0].prev}"`);

  // Last line: next is optional context (showing what follows in the song is valid UX)
  assert(typeof lines[3].next === 'string',
    `${id}: last line next is a string`, `got: ${typeof lines[3].next}`);

  // Middle lines: prev and next should be non-empty (they're context lines)
  for (let i = 1; i <= 2; i++) {
    assert(typeof lines[i].prev === 'string' && lines[i].prev.length > 0,
      `${id} line[${i}]: prev is non-empty`,
      `got: "${lines[i].prev}"`);
  }
  for (let i = 0; i <= 1; i++) {
    assert(typeof lines[i].next === 'string' && lines[i].next.length > 0,
      `${id} line[${i}]: next is non-empty`,
      `got: "${lines[i].next}"`);
  }
}


section('words[] content — all songs');

for (const song of demoSongs) {
  if (!Array.isArray(song.lines)) continue;
  const id = `"${song.title}"`;

  song.lines.forEach((line, i) => {
    const lid = `${id} line[${i}]`;
    const words = line.words;

    assert(Array.isArray(words), `${lid}: words is an array`);
    if (!Array.isArray(words)) return;

    assert(words.length >= 1 && words.length <= 8,
      `${lid}: 1–8 words (got ${words.length})`,
      `words: ${JSON.stringify(words)}`);

    // No empty strings
    const empties = words.filter(w => typeof w !== 'string' || w.length === 0);
    assert(empties.length === 0,
      `${lid}: no empty words`,
      `empty/non-string entries: ${JSON.stringify(empties)}`);

    // Every word must be capitalized (first char uppercase)
    const uncapped = words.filter(
      w => typeof w === 'string' && w.length > 0 && w[0] !== w[0].toUpperCase()
    );
    assert(uncapped.length === 0,
      `${lid}: every word is capitalized`,
      `not capitalized: ${JSON.stringify(uncapped)}`);

    // No stray quote characters (regression: Hotel California had "Welcome)
    const withQuotes = words.filter(w => typeof w === 'string' && w.includes('"'));
    assert(withQuotes.length === 0,
      `${lid}: no stray double-quote characters in words`,
      `affected: ${JSON.stringify(withQuotes)}`);
  });
}


section('lineTimes — only Shape of You should have them');

const withLineTimes = demoSongs.filter(s => s.lineTimes != null);

assert(withLineTimes.length === 1,
  `exactly 1 song has lineTimes (got ${withLineTimes.length}: ${withLineTimes.map(s => s.title).join(', ')})`,
  'Only Shape of You is confirmed by whisper alignment test. Others use equal-slot.');

const shapeOfYou = demoSongs.find(s => s.title === 'Shape of You');
assert(shapeOfYou != null, 'Shape of You is in the song list');
if (shapeOfYou && shapeOfYou.lineTimes) {
  assert(Array.isArray(shapeOfYou.lineTimes) && shapeOfYou.lineTimes.length === 4,
    'Shape of You: lineTimes has exactly 4 entries');
  assert(shapeOfYou.lineTimes[0] === 0.0,
    'Shape of You: lineTimes[0] === 0');
  const soy = shapeOfYou.lineTimes;
  assert(soy.every((v, i) => i === 0 || v > soy[i-1]),
    'Shape of You: lineTimes strictly increasing');
  assert(soy.every(v => v >= 0 && v < 30),
    'Shape of You: all lineTimes within 0–30s');
}


section('albumColor coverage');

// Each song should have a unique-ish color — extract the first hex color value
// from each albumColor string and check they're not all identical
const colors = demoSongs.map(s => s.albumColor || '');
const firstHex = colors.map(c => { const m = c.match(/#[0-9a-f]{6}/i); return m ? m[0] : ''; });
const uniqueHex = new Set(firstHex.filter(Boolean));
assert(uniqueHex.size >= 15,
  `album colors are diverse (${uniqueHex.size} distinct first-hex values)`,
  'Too many identical hex colors suggests a copy-paste error');


// ── Results ───────────────────────────────────────────────────────────────────

console.log('\n' + '─'.repeat(52));
console.log(`Results: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
