// Local API endpoint for retrieving uploaded files
import { loadTransferFromBlob } from './blobStore.js';
import { getSessionByCode } from './sessionStore.js';

export default async function handler(req, res) {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method === 'GET') {
    let { transferId, code } = req.query;
    
    console.log('=== LOCAL FILES GET REQUEST ===');
    console.log('Incoming transferId:', transferId, 'code:', code);
    
    if (!transferId && code) {
      const session = await getSessionByCode(code);
      if (session?.transferId) {
        transferId = session.transferId;
        console.log('Resolved transferId from session code:', transferId);
      }
    }

    if (!transferId) {
      return res.status(400).json({ error: 'No transfer ID or resolvable code provided' });
    }

    // Get transfer from Blob storage
    const transfer = await loadTransferFromBlob(transferId);
    console.log('Found transfer:', transfer);
    
    if (!transfer) {
      console.warn('Transfer not found for ID (Blob):', transferId);
      return res.status(404).json({ error: 'Transfer not found' });
    }

    const response = {
      transferId,
      status: transfer.status,
      files: Array.isArray(transfer.files) ? transfer.files : []
    };
    
    console.log('Returning files response:', response);
    res.status(200).json(response);
  } else {
    res.status(405).json({ error: 'Method not allowed' });
  }
}
