/**
 * /api/audio-preview
 * Server-side proxy for Deezer 30s preview URLs.
 * Deezer blocks direct browser fetches (CORS), so we proxy via Vercel.
 *
 * Query params: artist, title
 * Returns: { previewUrl, title, artist } or { error }
 */
export default async function handler(req, res) {
  const { artist, title } = req.query;
  if (!artist || !title) {
    return res.status(400).json({ error: 'artist and title are required' });
  }

  // Cache for 10 minutes — preview URLs are stable
  res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=3600');

  try {
    const q = encodeURIComponent(`artist:"${artist}" track:"${title}"`);
    const deezerRes = await fetch(
      `https://api.deezer.com/search?q=${q}&limit=5`,
      { signal: AbortSignal.timeout(4000) }
    );
    const data = await deezerRes.json();
    const results = data.data || [];

    // Prefer an exact-ish title match, fall back to first result
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

    return res.json({
      previewUrl: match.preview,
      title: match.title,
      artist: match.artist?.name || artist,
    });
  } catch (err) {
    console.error('audio-preview error:', err);
    return res.status(500).json({ error: 'preview fetch failed' });
  }
}
