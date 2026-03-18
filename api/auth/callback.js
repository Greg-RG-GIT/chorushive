import fetch from 'node-fetch';

export default async function handler(req, res) {
  const { code, error } = req.query;

  if (error) return res.redirect(`/?error=${encodeURIComponent(error)}`);
  if (!code) return res.redirect('/?error=no_code');

  try {
    // Exchange code for tokens
    const clientId = (process.env.SPOTIFY_CLIENT_ID || '').trim();
    const clientSecret = (process.env.SPOTIFY_CLIENT_SECRET || '').trim();
    const redirectUri = (process.env.SPOTIFY_REDIRECT_URI || '').trim();

    const tokenRes = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
      }),
    });

    const tokens = await tokenRes.json();
    if (!tokens.access_token) {
      console.error('Token exchange failed:', JSON.stringify({ error: tokens.error, error_description: tokens.error_description, redirect_uri: redirectUri, client_id: clientId }));
      return res.redirect(`/?error=${encodeURIComponent(tokens.error || 'token_error')}`);
    }

    // Get Spotify user profile
    const profileRes = await fetch('https://api.spotify.com/v1/me', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    const profile = await profileRes.json();

    // If a pre-granted record exists keyed on this email (e.g. ambassador), claim it
    if (profile.email) {
      await fetch(
        `${process.env.SUPABASE_URL}/rest/v1/chorushive_subscriptions?spotify_id=eq.${encodeURIComponent('pending:' + profile.email)}`,
        {
          method: 'PATCH',
          headers: {
            apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
            Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ spotify_id: profile.id }),
        }
      );
    }

    // Upsert user in Supabase (creates free tier record on first visit)
    await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/chorushive_subscriptions`,
      {
        method: 'POST',
        headers: {
          apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
          'Content-Type': 'application/json',
          Prefer: 'resolution=ignore-duplicates',
        },
        body: JSON.stringify({
          spotify_id: profile.id,
          email: profile.email || null,
          plan: 'free',
          status: 'active',
        }),
      }
    );

    // Pass non-sensitive session data via URL fragment (read by JS, not logged by servers)
    const sessionPayload = encodeURIComponent(
      Buffer.from(
        JSON.stringify({
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token,
          spotify_id: profile.id,
          email: profile.email || null,
          display_name: profile.display_name || profile.id,
          expires_at: Date.now() + tokens.expires_in * 1000,
        })
      ).toString('base64')
    );

    res.redirect(`/#s=${sessionPayload}`);
  } catch (err) {
    console.error('Callback error:', err);
    res.redirect('/?error=server_error');
  }
}
