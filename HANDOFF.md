# ChorusHive Demo Audio - Handoff

Date: 2026-03-17
File: projects/spotify-karaoke/public/index.html
Live site: https://chorushive.com/
Latest commit: fc68ea5

---

## What Is Working

1. Lyrics cycling on page load - fixed in d50d08e. The clearInterval(demoIntervalId) was being called immediately inside the IIFE on page load, killing the cycle. Removed. Lyrics now cycle through songs via timed interval until pill is tapped.

2. Mobile single-column layout - hiw-steps section is single-column on mobile.

3. Lava blob z-index - intentionally overlaps lyrics on mobile (stylistic choice, NOT a bug).

4. Blob preload fetch - fetch(previewApiUrl) on page load downloads ~480KB from Deezer proxy. The blob is valid MP3 (ID3 header confirmed). Web Audio API decodes it to 29.99s stereo at 48kHz. The data is good.

---

## The Bug

Audio never plays. After tapping the pill, audio.paused becomes false but audio.currentTime stays at 0 forever. readyState stays at 0. The stalled event fires ~3 seconds after loadstart.

---

## Root Cause (Confirmed)

Chrome audio element stalls on blob URL despite:
- Valid MP3 bytes (ID3 header, 0xFF 0xFB MPEG sync bytes confirmed)
- Correct MIME type (audio/mpeg)
- Web Audio API successfully decoding the exact same blob data
- No CSP policy blocking blob: URLs
- canPlayType("audio/mpeg") returning "probably"

This appears to be Chrome media autoplay policy. The audio element will not buffer or play without a genuine user activation context. The MCP-controlled tab does not carry a trusted activation signal, so we cannot verify from automation whether the real-user experience works.

**THE MOST IMPORTANT NEXT STEP: Open chorushive.com in a real Chrome window, wait 3 seconds, tap the pill yourself. If it plays, the bug is MCP-only and we are done.**

Earlier failed attempts (do not repeat):
- iTunes CDN preview URLs (song.previewUrl) -> audio/x-m4p FairPlay DRM, canPlayType returns empty string, Chrome refuses silently
- Direct audio src set to proxy URL -> Chrome sends Range: bytes=0-, proxy returns 200 not 206, Chrome retries in infinite loop
- Calling audio.load() manually -> still stalls
- new Blob([buf], {type:"audio/mpeg"}) with explicit type -> still stalls

---

## Current Code (fc68ea5)

Location: index.html around line 3710, inside the IIFE at the bottom

const previewApiUrl = "/api/audio-preview?artist=" + encodeURIComponent(song.artist) + "&title=" + encodeURIComponent(song.title);
let blobReady = false;
fetch(previewApiUrl)
  .then(r => r.ok ? r.blob() : Promise.reject(r.status))
  .then(blob => {
    audio.src = URL.createObjectURL(blob);
    blobReady = true;
  })
  .catch(() => {});

pill.addEventListener("click", () => {
  if (!blobReady) return;
  clearInterval(demoIntervalId);
  if (audio.paused) {
    audio.play().then(() => setPillPlaying()).catch(() => setPillTap());
  } else {
    audio.pause();
    setPillTap();
  }
});

---

## If Human Test Fails - Fix Options

### Option B: Fix proxy to support Range requests (cleanest fix)
Chrome audio element needs 206 Partial Content to stream. Edit api/audio-preview.js:

1. Read the Range header from the incoming request
2. Forward it to the Deezer upstream fetch
3. If Deezer returns 206, forward Content-Range header and respond 206
4. If no Range header, respond 200 as before
5. Then remove the blob URL approach entirely - use audio.src = previewApiUrl directly

This is the cleanest fix because it removes the blob URL complexity.

### Option C: Use Web Audio API (guaranteed but bigger refactor)
Web Audio API definitely works - confirmed decodes the MP3.
Replace the audio element with AudioContext + decodeAudioData + BufferSourceNode.
Track currentTime as audioCtx.currentTime - startTime instead of audio.currentTime.

---

## Lyrics Timing Note

Lyrics in demoSong.lines are timed to Deezer 30-second clips, NOT iTunes previews.
iTunes serves audio/x-m4p (FairPlay DRM) - Chrome cannot decode it at all.
Do NOT switch back to song.previewUrl.

Timing formula: lineSlot = 29 / lines.length seconds per line. Even distribution.

---

## Key Files

projects/spotify-karaoke/public/index.html - All inline CSS and JS. Demo IIFE at bottom, demoSongs array at line 3241.
projects/spotify-karaoke/api/audio-preview.js - Deezer proxy. Returns audio/mpeg. Needs Range request support if Option B chosen.
projects/spotify-karaoke/vercel.json - Route config.
