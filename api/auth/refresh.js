import fetch from 'node-fetch';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch(e) { body = {}; } }

  const { refresh_token } = body || {};
  if (!refresh_token) return res.status(400).json({ error: 'no_refresh_token' });

  const clientId     = (process.env.SPOTIFY_CLIENT_ID     || '').trim();
  const clientSecret = (process.env.SPOTIFY_CLIENT_SECRET || '').trim();

  try {
    const r = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
      },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token }),
    });

    const data = await r.json();
    if (!data.access_token) {
      return res.status(400).json({ error: data.error || 'refresh_failed' });
    }

    res.json({
      access_token: data.access_token,
      expires_in:   data.expires_in || 3600,
    });
  } catch (err) {
    console.error('Refresh error:', err);
    res.status(500).json({ error: 'server_error' });
  }
}
