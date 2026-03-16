export default function handler(req, res) {
  const scopes = [
    'user-read-playback-state',
    'user-read-currently-playing',
    'user-read-private',
    'user-read-email',
  ].join(' ');

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: (process.env.SPOTIFY_CLIENT_ID || '').trim(),
    scope: scopes,
    redirect_uri: (process.env.SPOTIFY_REDIRECT_URI || '').trim(),
    show_dialog: 'false',
  });

  res.redirect(`https://accounts.spotify.com/authorize?${params}`);
}
