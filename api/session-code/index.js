import { getSessionByCode, SESSION_TTL_MS } from '../sessionStore.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const { code } = req.query || {};
  if (!code) {
    res.status(400).json({ error: 'code query parameter required' });
    return;
  }

  const session = await getSessionByCode(code);
  if (!session) {
    res.status(404).json({ error: 'Koden hittades inte eller har gått ut.' });
    return;
  }

  const ttlMs = Math.max(0, SESSION_TTL_MS - (Date.now() - Number(session.createdAt || 0)));
  res.status(200).json({
    ...session,
    expiresInSec: Math.floor(ttlMs / 1000)
  });
}

