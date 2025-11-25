import { loadTransferFromBlob, saveTransferToBlob } from './blobStore.js';
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

  const transferId = req.query?.transferId || req.body?.transferId;
  if (!transferId) {
    res.status(400).json({ error: 'transferId required' });
    return;
  }

  try {
    let transfer = await loadTransferFromBlob(transferId);
    if (!transfer) {
      res.status(404).json({ error: 'Transfer not found' });
      return;
    }
    transfer = { ...transfer, status: 'cancelled' };
    await saveTransferToBlob(transferId, transfer);
    if (!global.__mmd_transfers) {
      global.__mmd_transfers = new Map();
    }
    global.__mmd_transfers.set(transferId, transfer);
    await removeSessionForTransfer(transferId);
    res.status(204).end();
  } catch (error) {
    console.error('Failed to cancel transfer:', error);
    res.status(500).json({ error: 'Failed to cancel transfer' });
  }
}

