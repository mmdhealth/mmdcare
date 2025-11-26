// Local API endpoint for file uploads
import formidable from 'formidable';
import fs from 'fs';
import path from 'path';
import { put } from '@vercel/blob';
import { loadTransferFromBlob, saveTransferToBlob, createEmptyTransfer } from './blobStore.js';

// Global storage for transfers (in-memory for local development)
if (!global.__mmd_transfers) {
  global.__mmd_transfers = new Map();
  console.log('Initialized global.__mmd_transfers in upload.js');
}

export const config = {
  api: {
    bodyParser: false,
  },
};

export default async function handler(req, res) {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method === 'POST') {
    const { transferId } = req.query;
    
    console.log('=== LOCAL UPLOAD POST REQUEST ===');
    console.log('Transfer ID:', transferId);
    
    if (!transferId) {
      console.log('No transfer ID provided');
      return res.status(400).json({ error: 'No transfer ID provided' });
    }

    try {
      console.log('Parsing form data...');
      const form = formidable({
        maxFileSize: 100 * 1024 * 1024, // 100MB
        filter: ({ mimetype }) => {
          console.log('File mimetype:', mimetype);
          return true; // Accept all file types
        }
      });

      const [fields, files] = await form.parse(req);
      console.log('Parsed fields:', fields);
      console.log('Parsed files:', files);
      
      const file = files.file?.[0];
      console.log('Selected file:', file);

      if (!file) {
        console.log('No file found in request');
        return res.status(400).json({ error: 'No file uploaded' });
      }

      // Get or create transfer (Blob-backed)
      let transfer = await loadTransferFromBlob(transferId);
      if (!transfer) {
        console.log('Transfer not found in Blob, creating new transfer for ID:', transferId);
        transfer = createEmptyTransfer();
      }

      // Store the actual file content in Blob storage
      const fileContent = fs.readFileSync(file.filepath);
      const fileBlobKey = `files/${transferId}/${file.originalFilename}`;
      
      console.log('=== STORING FILE IN BLOB ===');
      console.log('File path:', file.filepath);
      console.log('File size:', fileContent.length);
      console.log('Blob key:', fileBlobKey);
      console.log('MIME type:', file.mimetype);
      
      let blobUrl = null;
      try {
        const blobResult = await put(fileBlobKey, fileContent, {
          contentType: file.mimetype,
          access: 'public',
          allowOverwrite: true,
        });
        blobUrl = blobResult.url;
        console.log('File stored in Blob storage successfully:', fileBlobKey);
        console.log('Blob URL:', blobUrl);
      } catch (blobError) {
        console.warn('Blob storage unavailable, keeping file metadata without URL:', blobError?.message);
      }

      // Store file metadata
      const meta = {
        name: file.originalFilename,
        size: file.size,
        mimetype: file.mimetype,
        uploadedAt: new Date().toISOString(),
        transferId: transferId,
        url: blobUrl,
        blobKey: blobUrl ? fileBlobKey : null
      };
      
      // Add file to transfer and persist
      transfer.files.push(meta);
      await saveTransferToBlob(transferId, transfer);
      global.__mmd_transfers.set(transferId, transfer);
      
      console.log('File uploaded successfully:', meta);
      console.log('Transfer now has', transfer.files.length, 'files');
      console.log('Updated transfer object:', transfer);

      // notify desktop via session stage
      try {
        await fetch(`${process.env.BASE_URL || ''}/api/session-code/stage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code: transfer.sessionCode, stage: 'uploaded' })
        });
      } catch (notifyError) {
        console.warn('Failed to notify session about uploaded stage:', notifyError?.message);
      }

      console.log('Upload completed successfully, sending 204 response');
      res.status(204).end();
    } catch (error) {
      console.error('Upload error:', error);
      console.error('Error stack:', error.stack);
      res.status(500).json({ error: 'Upload failed', message: error?.message || 'Unknown error' });
    }
  } else {
    res.status(405).json({ error: 'Method not allowed' });
  }
}