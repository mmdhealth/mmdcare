// Local API endpoint for creating new transfers
import { loadTransferFromBlob, saveTransferToBlob, createEmptyTransfer, deleteTransferFromBlob, deletePatientTransferMapping } from './blobStore.js';

export default async function handler(req, res) {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  // Initialize global storage if needed
  if (!global.__mmd_transfers) {
    global.__mmd_transfers = new Map();
  }
  
  // Initialize patient-to-transferId mapping
  if (!global.__patient_transfers) {
    global.__patient_transfers = new Map();
  }

  if (req.method === 'GET') {
    // Get transferId by patientId
    const { patientId } = req.query;
    
    if (patientId) {
      console.log('=== GET TRANSFER BY PATIENT ID ===');
      console.log('Patient ID:', patientId);
      
      // Check global mapping first
      let transferId = global.__patient_transfers.get(patientId);
      
      // If not found in memory, try to load from blob storage
      // We'll use a consistent naming pattern: patient_transfer_{patientId}
      if (!transferId) {
        const patientTransferKey = `patient_transfer_${patientId}`;
        try {
          const stored = await loadTransferFromBlob(patientTransferKey);
          if (stored && stored.transferId) {
            transferId = stored.transferId;
            global.__patient_transfers.set(patientId, transferId);
          }
        } catch (e) {
          console.log('No stored transfer found for patient:', patientId);
        }
      }
      
      if (transferId) {
        console.log('Found transfer ID for patient:', patientId, transferId);
        return res.status(200).json({ transferId, patientId });
      } else {
        return res.status(404).json({ error: 'No transfer found for this patient' });
      }
    } else {
      return res.status(400).json({ error: 'patientId parameter required' });
    }
  }

  if (req.method === 'POST') {
    console.log('=== LOCAL TRANSFERS POST REQUEST ===');
    
    const { patientId } = req.body || {};
    
    // If patientId is provided, check if a transfer already exists for this patient
    if (patientId) {
      let existingTransferId = global.__patient_transfers.get(patientId);
      
      // Check blob storage if not in memory
      if (!existingTransferId) {
        const patientTransferKey = `patient_transfer_${patientId}`;
        try {
          const stored = await loadTransferFromBlob(patientTransferKey);
          if (stored && stored.transferId) {
            existingTransferId = stored.transferId;
            global.__patient_transfers.set(patientId, existingTransferId);
          }
        } catch (e) {
          // No existing transfer
        }
      }
      
      if (existingTransferId) {
        console.log('Deleting existing transfer before creating new one for patient:', patientId, existingTransferId);
        global.__mmd_transfers.delete(existingTransferId);
        global.__patient_transfers.delete(patientId);
        await deleteTransferFromBlob(existingTransferId);
        await deletePatientTransferMapping(patientId);
      }
    }
    
    // Generate a new unique transfer ID
    const transferId = 'transfer_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    console.log('Generated new transfer ID:', transferId);
    
    // Create new transfer record
    const transfer = {
      status: 'open',
      files: [],
      createdAt: Date.now(),
      patientId: patientId || null
    };
    
    // Store transfer
    global.__mmd_transfers.set(transferId, transfer);
    await saveTransferToBlob(transferId, transfer);
    
    // If patientId provided, store the mapping
    if (patientId) {
      global.__patient_transfers.set(patientId, transferId);
      
      // Also store the mapping in blob storage
      const patientTransferKey = `patient_transfer_${patientId}`;
      await saveTransferToBlob(patientTransferKey, { transferId, patientId, createdAt: Date.now() });
      console.log('Stored patient-to-transfer mapping:', patientId, '->', transferId);
    }
    
    console.log('Created new transfer:', transfer);
    
    res.status(200).json({ transferId, patientId });
  } else {
    res.status(405).json({ error: 'Method not allowed' });
  }
}