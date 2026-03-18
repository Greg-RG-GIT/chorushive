export default async function handler(req, res) {
  const { spotify_id, email } = req.query;
  if (!spotify_id) return res.status(400).json({ error: 'spotify_id required' });

  const headers = {
    apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
  };

  try {
    // Primary lookup by spotify_id
    let resp = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/chorushive_subscriptions?spotify_id=eq.${encodeURIComponent(spotify_id)}&select=plan,status,current_period_end`,
      { headers }
    );
    let rows = await resp.json();

    // Fallback: email-based lookup for pre-granted accounts (ambassadors, etc.)
    if (!rows.length && email) {
      resp = await fetch(
        `${process.env.SUPABASE_URL}/rest/v1/chorushive_subscriptions?email=eq.${encodeURIComponent(email)}&select=plan,status,current_period_end`,
        { headers }
      );
      rows = await resp.json();
    }

    if (!rows.length) return res.json({ plan: 'free', status: 'active', isPro: false });

    const sub = rows[0];
    const isPro = sub.plan !== 'free' && sub.status === 'active';
    return res.json({ ...sub, isPro });
  } catch (err) {
    console.error('Subscription status error:', err);
    return res.json({ plan: 'free', status: 'active', isPro: false });
  }
}
