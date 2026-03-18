#!/usr/bin/env python3
"""
calibrate_words.py — generate word-level karaoke timestamps from Deezer previews.

For each song:
  1. Fetches the 30s Deezer preview
  2. Transcribes with whisper (word_timestamps=True)
  3. Finds the chorus window via lrclib
  4. Groups transcribed words into 4 lyric lines
  5. Writes public/word-data.json — loaded by demo.html at runtime

Usage:
  python3 calibrate_words.py                    # all songs
  python3 calibrate_words.py "Shape of You"     # one song
  python3 calibrate_words.py --model small      # better accuracy (slower)

After running, refresh demo.html — it loads word-data.json automatically.
"""

import urllib.request, urllib.parse, json, tempfile, os, sys, re, time, subprocess

# ── CONFIG ──────────────────────────────────────────────────────────────────
CLIP_S          = 29.0
LINE_COUNT      = 4
WINDOW_S        = 28.0
SECTION_GAP_S   = 2.0     # gap between LRC lines that signals a section boundary
DEFAULT_MODEL   = "tiny"  # tiny = fast; small = better; base = middle ground

SONGS = [
    {"title": "Running Up That Hill",   "artist": "Kate Bush"},
    {"title": "Bohemian Rhapsody",      "artist": "Queen"},
    {"title": "Don't Stop Believin'",   "artist": "Journey"},
    {"title": "Mr. Brightside",         "artist": "The Killers"},
    {"title": "Africa",                 "artist": "Toto"},
    {"title": "Blinding Lights",        "artist": "The Weeknd"},
    {"title": "September",              "artist": "Earth, Wind & Fire"},
    {"title": "Lose Yourself",          "artist": "Eminem"},
    {"title": "Shape of You",           "artist": "Ed Sheeran"},
    {"title": "Sweet Caroline",         "artist": "Neil Diamond"},
    {"title": "Dancing Queen",          "artist": "ABBA"},
    {"title": "Billie Jean",            "artist": "Michael Jackson"},
    {"title": "Hotel California",       "artist": "Eagles"},
    {"title": "Levitating",             "artist": "Dua Lipa"},
    {"title": "As It Was",              "artist": "Harry Styles"},
    {"title": "Take On Me",             "artist": "a-ha"},
    {"title": "Flowers",                "artist": "Miley Cyrus"},
    {"title": "Waterloo",               "artist": "ABBA"},
]

ANSI_GREEN  = "\033[32m"
ANSI_RED    = "\033[31m"
ANSI_YELLOW = "\033[33m"
ANSI_RESET  = "\033[0m"
ANSI_BOLD   = "\033[1m"
ANSI_DIM    = "\033[2m"


# ── DEEZER ──────────────────────────────────────────────────────────────────

def get_preview_url(title, artist):
    q = urllib.parse.quote(f'artist:"{artist}" track:"{title}"')
    url = f"https://api.deezer.com/search?q={q}&limit=8"
    req = urllib.request.Request(url, headers={"User-Agent": "ChorusHive/1.0"})
    with urllib.request.urlopen(req, timeout=8) as r:
        data = json.loads(r.read())
    results = data.get("data", [])
    # Prefer exact title match with a valid preview URL
    for r in results:
        preview = r.get("preview", "")
        if title.lower() in r.get("title", "").lower() and preview:
            return preview
    for r in results:
        if r.get("preview"):
            return r["preview"]
    raise RuntimeError("no preview found")


def download(url, dest):
    req = urllib.request.Request(url, headers={
        "User-Agent": "Mozilla/5.0",
        "Referer":    "https://www.deezer.com/",
    })
    with urllib.request.urlopen(req, timeout=20) as r:
        with open(dest, "wb") as f:
            f.write(r.read())


# ── LRCLIB ──────────────────────────────────────────────────────────────────

def fetch_lrc(title, artist):
    url = ("https://lrclib.net/api/search"
           "?track_name=" + urllib.parse.quote(title) +
           "&artist_name=" + urllib.parse.quote(artist))
    req = urllib.request.Request(url, headers={"Lrclib-Client": "ChorusHive/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=8) as r:
            results = json.loads(r.read())
    except Exception:
        return None
    hit = next((x for x in results if x.get("syncedLyrics")), None)
    return hit["syncedLyrics"] if hit else None


def parse_lrc(raw):
    lines = []
    for line in raw.split("\n"):
        m = re.match(r"^\[(\d+):(\d+\.\d+)\](.*)", line)
        if m and m.group(3).strip():
            lines.append({
                "time": int(m.group(1)) * 60 + float(m.group(2)),
                "text": m.group(3).strip().lower(),
            })
    return lines


def find_chorus_window(lrc_lines, title):
    """Return (win_start, win_end) in LRC absolute time."""
    title_words = [w for w in re.sub(r"[^a-z ]", "", title.lower()).split() if len(w) > 2]
    # Find anchor line containing the most title words
    best_score, anchor = 0, -1
    for i, line in enumerate(lrc_lines):
        score = sum(1 for w in title_words if w in line["text"])
        if score > best_score:
            best_score, anchor = score, i
    if anchor < 0:
        anchor = len(lrc_lines) // 2  # fallback: middle of song

    # Walk back to find section boundary (large gap before anchor)
    win_start_t = lrc_lines[anchor]["time"]
    for i in range(anchor, 0, -1):
        gap = lrc_lines[i]["time"] - lrc_lines[i - 1]["time"]
        if gap >= SECTION_GAP_S:
            win_start_t = lrc_lines[i]["time"]
            break

    win_end_t = win_start_t + WINDOW_S
    return win_start_t, win_end_t


def pick_line_times_from_lrc(lrc_lines, win_start, win_end):
    """Pick 4 representative line times within the chorus window (absolute LRC times)."""
    win = [l for l in lrc_lines if win_start <= l["time"] <= win_end]
    if len(win) < 4:
        return None

    n = len(win)
    if n == 4:
        idxs = [0, 1, 2, 3]
    elif n <= 6:
        idxs = [0, 1, n // 2, n - 1]
    else:
        idxs = [0, max(1, n // 4), max(2, n // 2), max(3, 3 * n // 4)]

    return [win[i]["time"] for i in idxs]


# ── WHISPER ──────────────────────────────────────────────────────────────────

def transcribe(mp3_path, model_name):
    import whisper
    model  = whisper.load_model(model_name)
    result = model.transcribe(mp3_path, word_timestamps=True,
                              language="en", fp16=False, verbose=False)
    words = []
    for seg in result.get("segments", []):
        for w in seg.get("words", []):
            text = w["word"].strip()
            if text:
                words.append({
                    "w": text,
                    "t": round(w["start"], 3),
                    "e": round(w["end"],   3),
                })
    return words


# ── ALIGN WORDS TO LINE WINDOWS ─────────────────────────────────────────────

def group_words_into_lines(all_words, preview_line_times):
    """
    Given Whisper word timestamps (relative to start of preview clip)
    and 4 line boundary times (also relative to preview clip),
    group words into 4 lines.

    Returns list of 4 lists: [[{w, t, e}, ...], ...]
    """
    boundaries = preview_line_times + [CLIP_S]
    lines = []
    for i in range(LINE_COUNT):
        start = boundaries[i]
        end   = boundaries[i + 1]
        line_words = [w for w in all_words if w["t"] >= start - 0.1 and w["t"] < end - 0.05]
        lines.append(line_words)
    return lines


# ── MAIN ────────────────────────────────────────────────────────────────────

def calibrate_song(song, model_name):
    title  = song["title"]
    artist = song["artist"]

    print(f"\n{ANSI_BOLD}{title} — {artist}{ANSI_RESET}")

    # 1. Deezer preview
    try:
        preview_url = get_preview_url(title, artist)
        print(f"  {ANSI_DIM}Preview: {preview_url[:60]}...{ANSI_RESET}")
    except Exception as e:
        print(f"  {ANSI_RED}✗ Deezer failed: {e}{ANSI_RESET}")
        return None

    # 2. Download
    with tempfile.NamedTemporaryFile(suffix=".mp3", delete=False) as tmp:
        tmp_path = tmp.name
    try:
        download(preview_url, tmp_path)
        size_kb = os.path.getsize(tmp_path) // 1024
        print(f"  {ANSI_DIM}Downloaded: {size_kb}KB{ANSI_RESET}")
    except Exception as e:
        print(f"  {ANSI_RED}✗ Download failed: {e}{ANSI_RESET}")
        os.unlink(tmp_path)
        return None

    # 3. LRC chorus window → line times relative to preview clip
    lrc_raw = fetch_lrc(title, artist)
    preview_line_times = None  # relative to preview clip start
    lrc_abs_line_times = None  # absolute LRC timestamps (for offset calc)

    if lrc_raw:
        lrc = parse_lrc(lrc_raw)
        if lrc:
            win_start, win_end = find_chorus_window(lrc, title)
            abs_lts = pick_line_times_from_lrc(lrc, win_start, win_end)
            if abs_lts:
                lrc_abs_line_times = abs_lts
                print(f"  {ANSI_DIM}LRC chorus at {win_start:.1f}s  lineTimes(abs): {[round(t,2) for t in abs_lts]}{ANSI_RESET}")

    # 4. Whisper transcription
    try:
        print(f"  Transcribing with whisper-{model_name}...")
        t0 = time.time()
        all_words = transcribe(tmp_path, model_name)
        print(f"  {ANSI_DIM}Whisper: {len(all_words)} words in {time.time()-t0:.1f}s{ANSI_RESET}")
        preview_text = " ".join(w["w"] for w in all_words[:12])
        print(f"  {ANSI_DIM}Heard:  \"{preview_text}...\"  {ANSI_RESET}")
    except Exception as e:
        print(f"  {ANSI_RED}✗ Whisper failed: {e}{ANSI_RESET}")
        os.unlink(tmp_path)
        return None
    finally:
        try: os.unlink(tmp_path)
        except: pass

    if not all_words:
        print(f"  {ANSI_RED}✗ No words transcribed{ANSI_RESET}")
        return None

    # 5. Determine preview_line_times (relative to preview clip start = 0)
    #    Strategy A: if LRC win_start matches a word we can hear, compute offset
    #    Strategy B: use equal-slot fallback
    if lrc_abs_line_times:
        # Try to detect the offset between LRC timestamps and Deezer preview.
        # The chorus starts at lrc_abs_line_times[0] in the song.
        # We search for those words near the start of the preview.
        # If the preview clip starts at lrc_abs_line_times[0] (ideal case),
        # offset ≈ 0 and preview_line_times = abs_line_times - abs_line_times[0].
        offset = lrc_abs_line_times[0]  # assume preview starts at chorus
        preview_line_times = [round(t - offset, 3) for t in lrc_abs_line_times]

        # Sanity check: if any time is negative or > CLIP_S, fall back
        if any(t < 0 or t >= CLIP_S for t in preview_line_times):
            print(f"  {ANSI_YELLOW}~ LRC offset produces out-of-range times, using equal-slot{ANSI_RESET}")
            preview_line_times = None

    if preview_line_times is None:
        # Equal-slot fallback: evenly divide the clip
        preview_line_times = [round(i * CLIP_S / LINE_COUNT, 3) for i in range(LINE_COUNT)]
        print(f"  {ANSI_YELLOW}~ Using equal-slot fallback{ANSI_RESET}")

    print(f"  Preview lineTimes: {preview_line_times}")

    # 6. Group Whisper words into 4 lines
    word_lines = group_words_into_lines(all_words, preview_line_times)

    for i, wl in enumerate(word_lines):
        preview = " ".join(w["w"] for w in wl[:6])
        count   = len(wl)
        flag    = ANSI_GREEN + "✓" + ANSI_RESET if count >= 2 else ANSI_YELLOW + "~" + ANSI_RESET
        print(f"  {flag} line {i} ({count} words): \"{preview}{'...' if count > 6 else ''}\"")

    return {
        "title":     title,
        "artist":    artist,
        "lineTimes": preview_line_times,
        "wordLines": word_lines,       # [[{w, t, e}, ...], ...]  relative to clip start
        "allWords":  all_words,        # full clip transcription
    }


def main():
    args       = sys.argv[1:]
    model_name = DEFAULT_MODEL
    filter_str = None

    i = 0
    while i < len(args):
        if args[i] == "--model" and i + 1 < len(args):
            model_name = args[i + 1]; i += 2
        else:
            filter_str = args[i].lower(); i += 1

    songs = SONGS
    if filter_str:
        songs = [s for s in SONGS if filter_str in s["title"].lower()]
        if not songs:
            print(f"No songs matching '{filter_str}'")
            sys.exit(1)

    print(f"{ANSI_BOLD}── ChorusHive Word Calibration (whisper-{model_name}) ──{ANSI_RESET}")
    print(f"Songs: {len(songs)}  |  Output: public/word-data.json\n")

    # Load existing data so we can merge (don't wipe songs we've already done)
    out_path = os.path.join(os.path.dirname(__file__), "public", "word-data.json")
    existing = {}
    if os.path.exists(out_path):
        try:
            with open(out_path) as f:
                existing = json.load(f)
            print(f"  Loaded {len(existing)} existing entries from word-data.json\n")
        except Exception:
            pass

    results = dict(existing)
    ok, fail = 0, 0

    for song in songs:
        key = song["title"]
        result = calibrate_song(song, model_name)
        if result:
            results[key] = result
            ok += 1
        else:
            fail += 1

    # Write output
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "w") as f:
        json.dump(results, f, indent=2)

    print(f"\n{ANSI_BOLD}── Done ──{ANSI_RESET}")
    print(f"  {ANSI_GREEN}{ok} succeeded{ANSI_RESET}  {ANSI_RED}{fail} failed{ANSI_RESET}")
    print(f"  Written: {out_path}")
    print(f"  Refresh demo.html to see word-by-word karaoke sync.\n")


if __name__ == "__main__":
    main()
