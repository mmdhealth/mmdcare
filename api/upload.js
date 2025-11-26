// Local API endpoint for file uploads
import formidable from 'formidable';
import fs from 'fs';
import path from 'path';
import { put } from '@vercel/blob';
import { loadTransferFromBlob, saveTransferToBlob, createEmptyTransfer } from './blobStore.js';
import { getSessionCodeForTransfer } from './sessionStore.js';

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

function resolveInternalUrl(req, pathname) {
  const base =
    process.env.BASE_URL ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null);
  if (base) {
    return new URL(pathname, base).toString();
  }
  const proto = req.headers['x-forwarded-proto'] || req.headers['x-forwarded-protocol'] || req.protocol || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost:3000';
  return `${proto}://${host}${pathname}`;
}

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

      if (!transfer.sessionCode) {
        const resolvedCode = await getSessionCodeForTransfer(transferId);
        if (resolvedCode) {
          transfer.sessionCode = resolvedCode;
        }
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
      const sessionCode = transfer.sessionCode || await getSessionCodeForTransfer(transferId);
      if (sessionCode) {
        try {
          const stageUrl = resolveInternalUrl(req, '/api/session-code/stage');
          await fetch(stageUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code: sessionCode, stage: 'uploaded' })
          });
        } catch (notifyError) {
          console.warn('Failed to notify session about uploaded stage:', notifyError?.message);
        }
      } else {
        console.warn('Upload finished but no session code found for transfer:', transferId);
      }

      console.log('Upload completed successfully, sending JSON response');
      res.status(200).json({
        success: true,
        transferId,
        fileCount: transfer.files.length,
        files: transfer.files
      });
    } catch (error) {
      console.error('Upload error:', error);
      console.error('Error stack:', error.stack);
      res.status(500).json({ error: 'Upload failed', message: error?.message || 'Unknown error' });
    }
  } else {
    res.status(405).json({ error: 'Method not allowed' });
  }
}