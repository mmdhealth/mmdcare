// Local API endpoint for file uploads
import formidable from 'formidable';
import fs from 'fs';
import path from 'path';
import { put } from '@vercel/blob';
import { loadTransferFromBlob, saveTransferToBlob, createEmptyTransfer } from './blobStore.js';
import { getSessionCodeForTransfer, getSessionByCode } from './sessionStore.js';

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
    let { transferId, code } = req.query;
    
    console.log('=== LOCAL UPLOAD POST REQUEST ===');
    console.log('Incoming transferId:', transferId, 'code:', code);
    
    // Allow client to specify either transferId OR session code.
    if (!transferId && code) {
      const session = await getSessionByCode(code);
      if (session?.transferId) {
        transferId = session.transferId;
        console.log('Resolved transferId from session code:', transferId);
      }
    }

    if (!transferId) {
      console.log('No transfer ID could be resolved from query');
      return res.status(400).json({ error: 'No transfer ID provided or resolvable from code' });
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
      
      // CRITICAL: Save to Blob and verify it was saved
      console.log('💾 Saving transfer with', transfer.files.length, 'files to Blob...');
      await saveTransferToBlob(transferId, transfer);
      
      // Verify the save by reading it back immediately
      const verifyTransfer = await loadTransferFromBlob(transferId);
      if (!verifyTransfer || !verifyTransfer.files || verifyTransfer.files.length !== transfer.files.length) {
        console.error('❌ VERIFICATION FAILED - Transfer not saved correctly!');
        console.error('Expected files:', transfer.files.length, 'Got:', verifyTransfer?.files?.length || 0);
        // Retry once
        console.log('🔄 Retrying save...');
        await saveTransferToBlob(transferId, transfer);
        const retryVerify = await loadTransferFromBlob(transferId);
        if (!retryVerify || retryVerify.files.length !== transfer.files.length) {
          throw new Error(`Failed to save transfer to Blob - verification failed after retry`);
        }
        console.log('✅ Retry successful - transfer verified');
      } else {
        console.log('✅ Transfer saved and verified -', verifyTransfer.files.length, 'files in Blob');
      }
      
      global.__mmd_transfers.set(transferId, transfer);
      
      console.log('File uploaded successfully:', meta);
      console.log('Transfer now has', transfer.files.length, 'files');
      console.log('Updated transfer object:', JSON.stringify(transfer, null, 2));

      // Send response IMMEDIATELY after saving file (don't wait for stage notification)
      console.log('Upload completed successfully, sending JSON response');
      res.status(200).json({
        success: true,
        transferId,
        fileCount: transfer.files.length,
        files: transfer.files
      });

      // Notify desktop via session stage (fire-and-forget, don't block response)
      // Do this AFTER sending response so it doesn't timeout the function
      (async () => {
        try {
          const sessionCode = transfer.sessionCode || await getSessionCodeForTransfer(transferId);
          if (sessionCode) {
            const stageUrl = resolveInternalUrl(req, '/api/session-code/stage');
            await fetch(stageUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ code: sessionCode, stage: 'uploaded' })
            });
          }
        } catch (notifyError) {
          console.warn('Failed to notify session about uploaded stage:', notifyError?.message);
        }
      })();
    } catch (error) {
      console.error('Upload error:', error);
      console.error('Error stack:', error.stack);
      res.status(500).json({ error: 'Upload failed', message: error?.message || 'Unknown error' });
    }
  } else {
    res.status(405).json({ error: 'Method not allowed' });
  }
}