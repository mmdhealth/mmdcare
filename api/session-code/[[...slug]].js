import { getSessionByCode, updateSessionStage, updateDoctorVerification, SESSION_TTL_MS } from '../sessionStore.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  const slug = req.query.slug || [];
  const slugArray = Array.isArray(slug) ? slug : [slug];
  const action = slugArray[0];

  if (req.method === 'GET' && (!action || action.length === 0)) {
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
    return;
  }

  if (req.method === 'POST' && action === 'stage') {
    try {
      const { code, stage } = req.body || {};
      if (!code || !stage) {
        res.status(400).json({ error: 'Code and stage are required.' });
        return;
      }
      const updated = await updateSessionStage(code, stage);
      if (!updated) {
        res.status(404).json({ error: 'Koden hittades inte eller har gått ut.' });
        return;
      }
      res.status(200).json({ success: true, stage: updated.stage });
    } catch (error) {
      console.error('Failed to update session stage:', error);
      res.status(500).json({ error: 'Failed to update session stage' });
    }
    return;
  }

  if (req.method === 'POST' && action === 'doctor') {
    try {
      const { code, verified } = req.body || {};
      if (!code) {
        res.status(400).json({ error: 'Code is required.' });
        return;
      }
      const updated = await updateDoctorVerification(code, verified !== false);
      if (!updated) {
        res.status(404).json({ error: 'Koden hittades inte eller har gått ut.' });
        return;
      }
      res.status(200).json({ success: true, doctorVerified: updated.doctorVerified });
    } catch (error) {
      console.error('Failed to update doctor verification:', error);
      res.status(500).json({ error: 'Failed to update doctor verification' });
    }
    return;
  }

  res.status(404).json({ error: 'Not found' });
}

