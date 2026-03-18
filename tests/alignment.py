#!/usr/bin/env python3
"""
Alignment test — verifies Deezer preview sync with lineTimes.

For each test song:
  1. Fetches Deezer preview URL (same logic as /api/audio-preview)
  2. Downloads the 30s MP3 to a temp file
  3. Transcribes with whisper-tiny (word-level timestamps)
  4. For each lineTime, checks whether the expected words appear
     within a ±TOLERANCE_S window around that timestamp
  5. Reports per-line delta: how far off the detected lyric is from
     the expected lineTime — this is the previewOffset you'd need to add

Usage:
  python3 tests/alignment.py                    # test 5 representative songs
  python3 tests/alignment.py --all              # test all 20 songs (~4 min)
  python3 tests/alignment.py Sweet Caroline     # test one song by title match
"""

import urllib.request, urllib.parse, json, tempfile, os, sys, time, re, subprocess

TOLERANCE_S = 4.0   # seconds — a delta this large already feels wrong in karaoke
DEEZER_TIMEOUT = 8  # seconds for API call
DOWNLOAD_TIMEOUT = 20

# Songs to test by default (representative spread of tempos/genres)
DEFAULT_SONGS = [
    "Sweet Caroline",
    "Bohemian Rhapsody",
    "Dancing Queen",
    "Blinding Lights",
    "Lose Yourself",
]

# Full song list with expected data extracted from demoSongs
SONGS = [
    {"title": "Running Up That Hill",  "artist": "Kate Bush",          "lineTimes": [0.0, 2.14, 6.01, 26.8],   "checkWords": [["running","hill"], ["building"], ["could"], ["bullet"]]},
    {"title": "Bohemian Rhapsody",     "artist": "Queen",              "lineTimes": [0.0, 5.56, 18.59, 23.56], "checkWords": [["poor","boy"], ["spare","life"], ["will","not","let"], ["will","not","let"]]},
    {"title": "Don't Stop Believin'",  "artist": "Journey",            "lineTimes": [0.0, 4.29, 15.97, 23.98], "checkWords": [["believin"], ["feelin"], ["believin"], ["streetlights"]]},
    {"title": "Sweet Caroline",        "artist": "Neil Diamond",       "lineTimes": [0.0, 4.81, 15.9, 27.44],  "checkWords": [["sweet","caroline"], ["good","times"], ["believe"], ["lonely"]]},
    {"title": "Cruel Summer",          "artist": "Taylor Swift",       "lineTimes": [0.0, 8.43, 17.22, 22.56], "checkWords": [["cruel","summer"], ["ooh"], ["hang"], ["screw"]]},
    {"title": "Blinding Lights",       "artist": "The Weeknd",         "lineTimes": [0.0, 6.03, 11.21, 21.9],  "checkWords": [["blinded","lights"], ["sleep"], ["drowning"], ["hey"]]},
    {"title": "Levitating",            "artist": "Dua Lipa",           "lineTimes": [0.0, 3.59, 11.45, 24.55], "checkWords": [["levitating"], ["moonlight","starlight"], ["levitating"], ["stars"]]},
    {"title": "As It Was",             "artist": "Harry Styles",       "lineTimes": [0.0, 6.13, 13.87, 22.12], "checkWords": [["as it was"], ["same"], ["sitting","home"], ["nobody"]]},
    {"title": "Flowers",               "artist": "Miley Cyrus",        "lineTimes": [0.0, 4.31, 11.82, 19.59], "checkWords": [["flowers"], ["name","sand"], ["understand"], ["hand"]]},
    {"title": "Dancing Queen",         "artist": "ABBA",               "lineTimes": [0.0, 2.29, 14.09, 23.06], "checkWords": [["dancing","queen"], ["tambourine"], ["time","life"], ["dancing","queen"]]},
    {"title": "Billie Jean",           "artist": "Michael Jackson",    "lineTimes": [0.0, 4.58, 15.02, 25.31], "checkWords": [["billie","jean"], ["lover","claims"], ["son"], ["forty"]]},
    {"title": "Hotel California",      "artist": "Eagles",             "lineTimes": [0.0, 5.61, 12.64, 22.1],  "checkWords": [["hotel","california"], ["lovely"], ["room"], ["find"]]},
    {"title": "September",             "artist": "Earth, Wind & Fire", "lineTimes": [0.0, 3.46, 15.35, 25.68], "checkWords": [["september"], ["cloudy"], ["ba-du"], ["thoughts"]]},
    {"title": "Africa",                "artist": "Toto",               "lineTimes": [0.0, 4.91, 12.11, 26.11], "checkWords": [["africa","rains"], ["time"], ["ooh"], ["wild"]]},
    {"title": "Shape of You",          "artist": "Ed Sheeran",         "lineTimes": [0.0, 5.44, 12.84, 20.03], "checkWords": [["follow","lead"], ["shape","you"], ["body"], ["discovering"]]},
    {"title": "Take On Me",            "artist": "a-ha",               "lineTimes": [0.0, 5.67, 16.1, 25.36],  "checkWords": [["take","me"], ["take","me"], ["gone"], ["needless"]]},
    {"title": "Waterloo",              "artist": "ABBA",               "lineTimes": [0.0, 6.45, 14.54, 20.91], "checkWords": [["waterloo"], ["waterloo"], ["escape"], ["fate"]]},
    {"title": "Lose Yourself",         "artist": "Eminem",             "lineTimes": [0.0, 2.97, 11.28, 19.71], "checkWords": [["lose","yourself","music"], ["own","never","let"], ["lose","yourself"], ["opportunity"]]},
]

ANSI_GREEN  = "\033[32m"
ANSI_RED    = "\033[31m"
ANSI_YELLOW = "\033[33m"
ANSI_RESET  = "\033[0m"
ANSI_BOLD   = "\033[1m"
ANSI_DIM    = "\033[2m"


def get_deezer_preview_url(title, artist):
    q = urllib.parse.quote(f'artist:"{artist}" track:"{title}"')
    url = f"https://api.deezer.com/search?q={q}&limit=5"
    req = urllib.request.Request(url, headers={"User-Agent": "ChorusHive/1.0"})
    with urllib.request.urlopen(req, timeout=DEEZER_TIMEOUT) as resp:
        data = json.loads(resp.read())
    results = data.get("data", [])
    match = next((r for r in results if title.lower() in r.get("title","").lower()
                  and r.get("preview","").endswith(".mp3")), None)
    if not match:
        match = next((r for r in results if r.get("preview","").endswith(".mp3")), None)
    if not match:
        match = results[0] if results else None
    if not match or not match.get("preview"):
        raise RuntimeError("no preview found")
    return match["preview"], match.get("title","?"), match.get("artist",{}).get("name","?")


def download_preview(url, dest_path):
    req = urllib.request.Request(url, headers={
        "User-Agent": "Mozilla/5.0 (compatible; ChorusHive/1.0)",
        "Referer": "https://www.deezer.com/",
    })
    with urllib.request.urlopen(req, timeout=DOWNLOAD_TIMEOUT) as resp:
        with open(dest_path, "wb") as f:
            f.write(resp.read())


def transcribe(mp3_path):
    """Transcribe with whisper-tiny, return list of {start, end, text} word segments."""
    import whisper
    model = whisper.load_model("tiny")
    result = model.transcribe(mp3_path, word_timestamps=True, language="en",
                              fp16=False, verbose=False)
    words = []
    for seg in result.get("segments", []):
        for w in seg.get("words", []):
            words.append({
                "start": w["start"],
                "end":   w["end"],
                "text":  re.sub(r"[^a-z'-]", "", w["word"].lower().strip()),
            })
    return words, result.get("text","").strip()


def check_line(words, expected_words, expected_t, tolerance):
    """
    Find the time window [expected_t - tolerance, expected_t + tolerance].
    Return (best_delta, matched_word) — best_delta is how far off the
    best keyword match is from expected_t (None if nothing found).
    """
    window_start = max(0, expected_t - tolerance)
    window_end   = expected_t + tolerance

    best_delta = None
    best_match = None

    for w in words:
        if w["start"] < window_start - 1 or w["start"] > window_end + 1:
            continue
        wt = re.sub(r"[^a-z]", "", w["text"].lower())
        for kw in expected_words:
            kw_clean = re.sub(r"[^a-z]", "", kw.lower())
            if kw_clean and (kw_clean in wt or wt in kw_clean):
                delta = abs(w["start"] - expected_t)
                if best_delta is None or delta < best_delta:
                    best_delta = delta
                    best_match = (w["start"], w["text"])
                break

    return best_delta, best_match


def run_song(song):
    title  = song["title"]
    artist = song["artist"]
    lts    = song["lineTimes"]
    checks = song["checkWords"]

    print(f"\n{ANSI_BOLD}{title} — {artist}{ANSI_RESET}")

    # 1. Deezer lookup
    try:
        preview_url, dz_title, dz_artist = get_deezer_preview_url(title, artist)
    except Exception as e:
        print(f"  {ANSI_RED}✗ Deezer lookup failed: {e}{ANSI_RESET}")
        return {"title": title, "status": "deezer_fail", "lines": []}
    print(f"  {ANSI_DIM}Deezer: {dz_title} / {dz_artist}{ANSI_RESET}")

    # 2. Download
    with tempfile.NamedTemporaryFile(suffix=".mp3", delete=False) as tmp:
        tmp_path = tmp.name
    try:
        download_preview(preview_url, tmp_path)
        size_kb = os.path.getsize(tmp_path) // 1024
        dur_out = subprocess.check_output(
            ["ffprobe", "-v","error","-show_entries","format=duration",
             "-of","default=noprint_wrappers=1:nokey=1", tmp_path],
            stderr=subprocess.DEVNULL
        ).decode().strip()
        dur = float(dur_out) if dur_out else 0
        print(f"  {ANSI_DIM}Preview: {size_kb}KB, {dur:.1f}s{ANSI_RESET}")
    except Exception as e:
        print(f"  {ANSI_RED}✗ Download failed: {e}{ANSI_RESET}")
        os.unlink(tmp_path)
        return {"title": title, "status": "download_fail", "lines": []}

    # 3. Transcribe
    try:
        wds, full_text = transcribe(tmp_path)
        print(f"  {ANSI_DIM}Transcription: \"{full_text[:80]}...\"" if len(full_text) > 80
              else f"  {ANSI_DIM}Transcription: \"{full_text}\"{ANSI_RESET}")
    except Exception as e:
        print(f"  {ANSI_RED}✗ Whisper failed: {e}{ANSI_RESET}")
        os.unlink(tmp_path)
        return {"title": title, "status": "whisper_fail", "lines": []}
    finally:
        os.unlink(tmp_path)

    # 4. Check each line
    results = []
    passed = 0
    for i, (lt, kws) in enumerate(zip(lts, checks)):
        delta, match = check_line(wds, kws, lt, TOLERANCE_S)
        if delta is not None and delta <= TOLERANCE_S:
            status = "pass"
            passed += 1
            flag = ANSI_GREEN + "✓" + ANSI_RESET
            detail = f"heard at {match[0]:.2f}s, expected {lt:.2f}s  (delta {delta:+.2f}s)"
        elif delta is not None:
            status = "warn"
            flag = ANSI_YELLOW + "~" + ANSI_RESET
            detail = f"found '{match[1]}' at {match[0]:.2f}s, expected {lt:.2f}s  (delta {delta:+.2f}s — outside ±{TOLERANCE_S}s)"
        else:
            status = "fail"
            flag = ANSI_RED + "✗" + ANSI_RESET
            detail = f"'{' '.join(kws)}' not found near {lt:.2f}s"
        print(f"  {flag} line {i}: [{', '.join(kws[:3])}...]  {detail}")
        results.append({"line": i, "expected_t": lt, "status": status,
                         "delta": delta, "match": match})

    song_status = "pass" if passed == len(lts) else ("warn" if passed > 0 else "fail")
    return {"title": title, "status": song_status, "passed": passed,
            "total": len(lts), "lines": results}


def main():
    args = sys.argv[1:]
    test_all = "--all" in args
    filter_term = " ".join(a for a in args if not a.startswith("--")).lower()

    if filter_term:
        songs = [s for s in SONGS if filter_term in s["title"].lower()]
        if not songs:
            print(f"No songs matching '{filter_term}'")
            sys.exit(1)
    elif test_all:
        songs = SONGS
    else:
        songs = [s for s in SONGS if s["title"] in DEFAULT_SONGS]

    print(f"{ANSI_BOLD}── ChorusHive Alignment Test (whisper-tiny + Deezer) ──{ANSI_RESET}")
    print(f"Testing {len(songs)} song(s). Tolerance: ±{TOLERANCE_S}s per line.\n")

    t0 = time.time()
    results = [run_song(s) for s in songs]
    elapsed = time.time() - t0

    # Summary
    total_lines = sum(r.get("total", 0) for r in results)
    passed_lines = sum(r.get("passed", 0) for r in results)
    songs_pass = sum(1 for r in results if r["status"] == "pass")

    print(f"\n{ANSI_BOLD}── Summary ──────────────────────────────{ANSI_RESET}")
    for r in results:
        s = r["status"]
        icon = ANSI_GREEN+"✓"+ANSI_RESET if s=="pass" else ANSI_YELLOW+"~"+ANSI_RESET if s=="warn" else ANSI_RED+"✗"+ANSI_RESET
        passed = r.get("passed", 0)
        total  = r.get("total", 0)
        print(f"  {icon} {r['title']:30s}  {passed}/{total} lines")

        # Suggest previewOffset if any line delta is large
        if r.get("lines"):
            deltas = [l["delta"] for l in r["lines"] if l["delta"] is not None]
            if deltas:
                median_delta = sorted(deltas)[len(deltas)//2]
                # positive delta = whisper heard lyric AFTER expected → preview starts later than winStart
                # negative delta = whisper heard lyric BEFORE expected → preview starts earlier
                if abs(median_delta) > 2.0:
                    offset = round(median_delta, 1)
                    print(f"    {ANSI_YELLOW}→ suggest previewOffset: {offset:+.1f}s{ANSI_RESET}")

    print(f"\n  {passed_lines}/{total_lines} lines aligned  |  "
          f"{songs_pass}/{len(songs)} songs fully passing  |  "
          f"{elapsed:.0f}s elapsed")

    # Exit code: 0 if all pass, 1 if any fail
    sys.exit(0 if all(r["status"] in ("pass","warn") for r in results) else 1)


if __name__ == "__main__":
    main()
