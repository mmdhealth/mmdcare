// Local API endpoint for transfer completion
import { loadTransferFromBlob, saveTransferToBlob, createEmptyTransfer } from './blobStore.js';

export default async function handler(req, res) {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  // Initialize global storage if it doesn't exist
  if (!global.__mmd_transfers) {
    global.__mmd_transfers = new Map();
    console.log('Initialized global.__mmd_transfers');
  }

  if (req.method === 'GET') {
    const { transferId } = req.query;
    console.log('=== LOCAL COMPLETION GET REQUEST ===');
    console.log('Transfer ID:', transferId);
    
    if (!transferId) {
      return res.status(400).json({ error: 'No transfer ID provided' });
    }

    // Get transfer from Blob storage
    const transfer = await loadTransferFromBlob(transferId);
    console.log('Found transfer:', transfer);
    
    const files = transfer?.files || [];
    const closed = transfer && transfer.status === 'closed';
    const status = closed ? 'closed' : 'open';
    console.log('Returning status:', status, 'files:', files.length);
    
    return res.status(200).json({ status, files });
  }

  if (req.method === 'POST') {
    const { transferId } = req.query;
    console.log('=== LOCAL COMPLETION POST REQUEST ===');
    console.log('Transfer ID:', transferId);
    
    if (!transferId) {
      return res.status(400).json({ error: 'No transfer ID provided' });
    }

    try {
      // Get or create transfer
      let transfer = await loadTransferFromBlob(transferId);
      if (!transfer) {
        console.log('Transfer not found for completion POST (Blob), creating new record and marking closed:', transferId);
        transfer = createEmptyTransfer();
      }
      transfer.status = 'closed';
      await saveTransferToBlob(transferId, transfer);
      console.log('Updated transfer status to closed for:', transferId);
      console.log('Final transfer object:', transfer);

      console.log('Sending 204 response for completion');
      res.status(204).end();
    } catch (error) {
      console.error('Completion error:', error);
      res.status(500).json({ error: 'Completion failed', message: error.message });
    }
  } else {
    res.status(405).json({ error: 'Method not allowed' });
  }
}