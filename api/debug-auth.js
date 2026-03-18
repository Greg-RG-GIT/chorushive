import fetch from 'node-fetch';

// TEMPORARY DEBUG ENDPOINT — remove after diagnosis
export default async function handler(req, res) {
  const clientId     = (process.env.SPOTIFY_CLIENT_ID     || '').trim();
  const clientSecret = (process.env.SPOTIFY_CLIENT_SECRET || '').trim();
  const redirectUri  = (process.env.SPOTIFY_REDIRECT_URI  || '').trim();

  // Test token exchange with a dummy code to see exact Spotify error
  const tokenRes = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: 'dummy_code_for_diagnosis',
      redirect_uri: redirectUri,
    }),
  });

  const data = await tokenRes.json();

  // Return diagnostic info — does NOT expose the secret
  res.json({
    client_id: clientId,
    client_id_length: clientId.length,
    client_secret_length: clientSecret.length,
    client_secret_prefix: clientSecret.slice(0, 4),
    redirect_uri: redirectUri,
    spotify_error: data.error,
    spotify_error_description: data.error_description,
  });
}
