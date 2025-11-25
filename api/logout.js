import { deleteTransferFromBlob, deletePatientTransferMapping } from './blobStore.js';
import { removeSessionForTransfer } from './sessionStore.js';

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

  if (!global.__mmd_transfers) {
    global.__mmd_transfers = new Map();
  }
  if (!global.__patient_transfers) {
    global.__patient_transfers = new Map();
  }

  try {
    const deletions = [];
    for (const transferId of global.__mmd_transfers.keys()) {
      deletions.push(removeSessionForTransfer(transferId));
      deletions.push(deleteTransferFromBlob(transferId));
    }
    for (const patientId of global.__patient_transfers.keys()) {
      deletions.push(deletePatientTransferMapping(patientId));
    }
    await Promise.all(deletions);
    global.__mmd_transfers.clear();
    global.__patient_transfers.clear();
    res.status(200).json({ success: true });
  } catch (error) {
    console.error('Failed to logout/clear transfers:', error);
    res.status(500).json({ error: 'Failed to clear transfers' });
  }
}

