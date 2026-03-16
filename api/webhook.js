import Stripe from 'stripe';

export const config = { api: { bodyParser: false } };

async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const supaHeaders = (key) => ({
  apikey: key,
  Authorization: `Bearer ${key}`,
  'Content-Type': 'application/json',
  Prefer: 'resolution=merge-duplicates',
});

async function supabasePatch(url, key, data) {
  return fetch(url, {
    method: 'PATCH',
    headers: supaHeaders(key),
    body: JSON.stringify(data),
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const rawBody = await getRawBody(req);
  const sig = req.headers['stripe-signature'];

  let event;
  try {
    event = stripe.webhooks.constructEvent(
      rawBody,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature error:', err.message);
    return res.status(400).json({ error: err.message });
  }

  const SUPA_URL = process.env.SUPABASE_URL;
  const SUPA_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const TABLE = `${SUPA_URL}/rest/v1/chorushive_subscriptions`;

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const spotify_id = session.metadata?.spotify_id;
        if (!spotify_id) break;

        await fetch(TABLE, {
          method: 'POST',
          headers: supaHeaders(SUPA_KEY),
          body: JSON.stringify({
            spotify_id,
            stripe_customer_id: session.customer,
            stripe_sub_id: session.subscription,
            plan: 'pro_monthly',
            status: 'active',
          }),
        });
        break;
      }

      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const sub = event.data.object;
        const priceId = sub.items.data[0]?.price.id;
        const plan =
          priceId === process.env.STRIPE_PRICE_ANNUAL
            ? 'pro_annual'
            : 'pro_monthly';

        // Look up by stripe_customer_id
        const lookupRes = await fetch(
          `${TABLE}?stripe_customer_id=eq.${sub.customer}&select=spotify_id`,
          {
            headers: {
              apikey: SUPA_KEY,
              Authorization: `Bearer ${SUPA_KEY}`,
            },
          }
        );
        const rows = await lookupRes.json();
        if (!rows.length) break;

        await supabasePatch(
          `${TABLE}?spotify_id=eq.${rows[0].spotify_id}`,
          SUPA_KEY,
          {
            stripe_sub_id: sub.id,
            plan,
            status:
              sub.status === 'active'
                ? 'active'
                : sub.status === 'past_due'
                ? 'past_due'
                : 'canceled',
            current_period_end: new Date(
              sub.current_period_end * 1000
            ).toISOString(),
          }
        );
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        await supabasePatch(
          `${TABLE}?stripe_customer_id=eq.${sub.customer}`,
          SUPA_KEY,
          { plan: 'free', status: 'canceled' }
        );
        break;
      }
    }
  } catch (err) {
    console.error('Webhook handler error:', err);
  }

  res.json({ received: true });
}
