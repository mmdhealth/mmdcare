import { updateDoctorVerification } from '../sessionStore.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

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
}

