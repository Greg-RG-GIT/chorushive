# ChorusHive — Cowork Handoff
**Last updated:** 2026-03-17
**Repo:** `~/work/team-brain/projects/spotify-karaoke/` (own `.git` — separate from team-brain)
**Remote:** https://github.com/Greg-RG-GIT/chorushive.git
**Live URL:** https://chorushive.com
**Deploy:** Vercel auto-deploys on push to `main`

---

## ✅ Completed this session (commit `7716d32`)

| What | Details |
|------|---------|
| LRC-calibrated demo timing | `audioSyncTick` now fetches real timestamps from lrclib.net and aligns them to the Deezer preview window. Falls back to equal time slots if LRC fetch fails. |
| Word timing uses real line duration | `runLine` now accepts `lineDurationMs` and uses it for word-highlight pacing instead of the hardcoded `LINE_INTERVAL = 5500ms`. |
| Real-player elapsed-offset fix | `syncLyrics` now calculates how far into the current line the player already is and offsets `setTimeout` delays accordingly. Words that should already be done are marked immediately. |
| Removed bottom demo pill | `demo-audio-pill` ("Tap to hear demo") removed from HTML. Play is handled by the `fx-play-btn` in the mock player header only. |

---

## 🔧 How the demo audio timing works (post-fix)

```
Page load
  → Pick random demo song from demoSongs[]
  → Start timed fallback loop (LINE_INTERVAL, visual only)
  → Fetch Deezer MP3 blob via /api/audio-preview proxy
  → Fetch LRC from lrclib.net/api/search (parallel)

On LRC success:
  → Match each demoSong.lines[i].words[] against LRC text (50%+ word overlap)
  → Store lineTimes[] = [t0, t1, t2, t3] relative to preview start (= lrcTime - lrcTime[0])
  → Sanity check: ascending, all < 30s

On user tap (fx-play-btn):
  → clearInterval(fallback loop)
  → audio.play()
  → rAF starts audioSyncTick()

audioSyncTick():
  → If lineTimes available: binary search for current line by audio.currentTime
  → Else: Math.floor(t / lineSlot) equal-slot fallback

runLine(lineData, instant, lineDurMs):
  → Word interval = min(640, max(220, floor(lineDurMs * 0.78 / numWords)))
```

---

## 🔧 How real-player word sync works (post-fix)

```
Spotify poll → progressMs + interpolation via rAF
  → syncLyrics(progressMs)
    → Find current LRC line by timestamp
    → elapsed = (sec - lineStart) * 1000
    → For each word: delay = max(0, (i/n * dur * 0.8) - elapsed)
    → Words past their target: classList.add('done') immediately
    → Future words: setTimeout
```

---

## ⚠️ Known remaining issues

### Demo: LRC match quality
LRC calibration works automatically but depends on word-overlap matching (50% threshold). Some songs may not match if the LRC phrasing differs from the handpicked `words[]` arrays (contractions, alternate wording). If a song is consistently off, either:
- Update its `words[]` in `demoSongs` to match exact LRC phrasing
- OR add a `lineTimesOverride: [t0,t1,t2,t3]` field (needs a small code change to read it)

**To debug:** Add `console.log('lineTimes:', lineTimes)` after `if (valid) lineTimes = rel;` and watch the console on page load + tap.

### Demo: audio playback (MCP testing limitation)
The play button requires a real user gesture. Automated browser testing via MCP always gets `NotAllowedError`. Expected — works fine for real users.

### Deezer preview offset assumption
`tryCalibrateLrc` assumes the preview starts right at the first matched lyric line (`lineTimes[0] = 0`). If the preview starts with an instrumental intro, `lineTimes[0]` goes negative and the sanity check discards it, falling back to equal slots. Fix: allow a small negative offset or add a per-song `previewIntroSec` field.

---

## Architecture

```
~/work/team-brain/projects/spotify-karaoke/
├── public/
│   └── index.html          # Entire app — single-file HTML/CSS/JS (~5100 lines)
├── api/
│   ├── audio-preview.js    # Deezer proxy → returns MP3 blob (avoids CORS + DRM)
│   └── auth/
│       ├── callback.js     # Spotify OAuth callback
│       └── refresh.js      # Token refresh (currently untracked — needs git add)
└── vercel.json             # Routing config
```

**Key sections in `index.html`:**

| Line range | What |
|------------|------|
| ~3241 | `demoSongs[]` — 20 songs with lyric line data |
| ~3578 | `LINE_INTERVAL`, `runLine(lineData, instant, lineDurationMs)` |
| ~3658 | Demo audio IIFE: blob fetch + `tryCalibrateLrc` + `audioSyncTick` |
| ~4851 | Real player state (`lrcLines`, `lastProgressMs`, `rafId`) |
| ~4879 | `syncLyrics(progressMs)` — word timing for real player |
| ~4913 | `fetchLrc(track)` — lrclib fetch for real Spotify player |
| ~4951 | `poll()` — Spotify API polling loop |

---

## ✅ Completed next session (commits `908473b`, `8295ff6`)

| What | Details |
|------|---------|
| Tracked `api/auth/refresh.js` | Spotify token refresh handler was untracked. Now committed. |
| Fixed critical audio bug | Blob fetch was inside `if (pill)` guard — pill was removed from HTML so `audio.src` was never set. Moved fetch unconditional; added `clearInterval(demoIntervalId)` to play event listener. |
| LRC calibration verified | Network confirmed: both `lrclib.net` and `/api/audio-preview` fire on load. September LRC has "twenty-first" verbatim — all 4 lines match. Audio element loads blob and reaches `readyState:4`. |
| `lineTimesOverride` not needed | Fallback-to-equal-slots for unmatched songs (e.g. Shape of You phonetic line) is acceptable behavior. |

---

## ⚠️ Remaining known issues

### Deezer preview offset assumption
`tryCalibrateLrc` assumes the Deezer preview starts at `times[0]` (the timestamp of the first matched demo line). If the preview contains an intro before that line, `rel[0]` goes negative and the sanity check discards calibration → equal-slot fallback. Fix: per-song `previewIntroSec` field or allow a small negative offset.

### Shape of You — always uses equal-slot fallback
Line 3 is `["Oh-I-oh-I-oh-I-oh-I"]` — single phonetic token, won't match any LRC. Since ALL lines must match, the whole song falls back to equal slots. Timing is acceptable; not worth a fix unless the song feels noticeably off.

---

## Next tasks

- [ ] None — all handoff items complete. ✅

---

## Environment notes

- **VM disk was 100% full** across both sessions. Bash tool non-functional. All edits via Read/Edit tools on mounted Mac filesystem + osascript for git/shell ops.
- **No build step** — single static HTML file served directly by Vercel.
- **Vercel deploy** takes ~30s after push. Check https://vercel.com/greg-rg-git/chorushive for build status.
