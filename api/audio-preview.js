/**
 * /api/audio-preview
 * Server-side proxy that streams a Deezer 30s MP3 preview directly to the browser.
 * The proxy fetches and pipes the audio bytes — no CORS or CDN hotlink issues.
 * audio.src = '/api/audio-preview?artist=...&title=...'
 *
 * Query params: artist, title
 * Returns: audio/mpeg byte stream
 */
export default async function handler(req, res) {
  const { artist, title } = req.query;
  if (!artist || !title) {
    return res.status(400).json({ error: 'artist and title are required' });
  }

  try {
    // 1. Find the Deezer preview URL
    const q = encodeURIComponent(`artist:"${artist}" track:"${title}"`);
    const deezerRes = await fetch(
      `https://api.deezer.com/search?q=${q}&limit=5`,
      { signal: AbortSignal.timeout(4000) }
    );
    const data = await deezerRes.json();
    const results = data.data || [];

    const match =
      results.find(r =>
        r.title.toLowerCase().includes(title.toLowerCase()) &&
        r.preview &&
        r.preview.endsWith('.mp3')
      ) ||
      results.find(r => r.preview && r.preview.endsWith('.mp3')) ||
      results[0];

    if (!match || !match.preview) {
      return res.status(404).json({ error: 'no preview found' });
    }

    // 2. Fetch and stream the MP3 bytes — server-side, so CDN hotlink protection is bypassed
    const audioRes = await fetch(match.preview, {
      signal: AbortSignal.timeout(15000),
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; ChorusHive/1.0)',
        'Referer': 'https://www.deezer.com/',
      },
    });

    if (!audioRes.ok) {
      return res.status(audioRes.status).json({ error: 'audio stream failed' });
    }

    // Cache at CDN for 1 hour — the MP3 bytes are stable
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
    res.setHeader('Accept-Ranges', 'bytes');

    // Pipe response body to browser
    const reader = audioRes.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!res.writableEnded) res.write(Buffer.from(value));
    }
    if (!res.writableEnded) res.end();
  } catch (err) {
    console.error('audio-preview error:', err);
    if (!res.headersSent) {
      return res.status(500).json({ error: 'preview fetch failed' });
    }
  }
}
