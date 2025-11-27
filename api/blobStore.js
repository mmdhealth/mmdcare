// Simple Vercel Blob JSON store for transfer metadata
// Key layout: transfers/{transferId}.json

import { put, head, del } from '@vercel/blob';

const buildKey = (transferId) => `transfers/${transferId}.json`;

export const hasBlobAccess = () => {
  // In Vercel production, VERCEL env var is always set to "1"
  // BLOB_READ_WRITE_TOKEN is automatically available in serverless functions
  // This should ALWAYS return true in Vercel production
  return Boolean(
    process.env.VERCEL ||
    process.env.BLOB_READ_WRITE_TOKEN ||
    process.env.BLOB_API_URL
  );
};

export async function loadTransferFromBlob(transferId, { cacheBust = true } = {}) {
  if (!hasBlobAccess()) {
    console.error('❌ BLOB ACCESS DENIED - Cannot load transfer. VERCEL env:', process.env.VERCEL);
    return null;
  }
  const key = buildKey(transferId);
  try {
    console.log('📂 Loading transfer from Blob:', key);
    const meta = await head(key);
    if (!meta || !meta.url) {
      console.log('Transfer not found in Blob:', key);
      return null;
    }
    let fetchUrl = meta.url;
    if (cacheBust) {
      const urlObj = new URL(meta.url);
      urlObj.searchParams.set('ts', Date.now().toString());
      fetchUrl = urlObj.toString();
    }
    const res = await fetch(fetchUrl, {
      cache: 'no-store',
      headers: { 'Cache-Control': 'no-cache' }
    });
    if (!res.ok) {
      console.log('Failed to fetch transfer from Blob URL:', res.status);
      return null;
    }
    const data = await res.json();
    console.log('✅ Transfer loaded from Blob:', key, 'files:', data.files?.length || 0);
    return data;
  } catch (err) {
    // HEAD throws if not found
    console.log('Transfer not found in Blob (HEAD error):', key, err.message);
    return null;
  }
}

export async function saveTransferToBlob(transferId, transfer) {
  if (!hasBlobAccess()) {
    console.error('❌ BLOB ACCESS DENIED - Cannot save transfer. VERCEL env:', process.env.VERCEL);
    throw new Error('Blob storage not available - cannot persist transfer');
  }
  const key = buildKey(transferId);
  console.log('💾 Saving transfer to Blob:', key, 'with', transfer.files?.length || 0, 'files');
  
  // Ensure files array exists
  if (!Array.isArray(transfer.files)) {
    transfer.files = [];
  }
  
  const transferJson = JSON.stringify(transfer, null, 2);
  console.log('Transfer JSON size:', transferJson.length, 'bytes');
  
  await put(key, transferJson, {
    contentType: 'application/json',
    access: 'public',
    cacheControlMaxAge: 0,
    allowOverwrite: true,
  });
  
  console.log('✅ Transfer saved to Blob:', key, '-', transfer.files.length, 'files');
}

export function createEmptyTransfer() {
  return { status: 'open', files: [], createdAt: Date.now() };
}

export async function deleteTransferFromBlob(transferId) {
  if (!hasBlobAccess()) return;
  const transfer = await loadTransferFromBlob(transferId);
  if (transfer?.files) {
    await Promise.all(
      transfer.files.map(async (file) => {
        if (file?.blobKey) {
          try {
            await del(file.blobKey);
          } catch (err) {
            if (!err?.message?.includes('not found')) {
              console.error(`Failed to delete blob ${file.blobKey}:`, err);
            }
          }
        }
      })
    );
  }
  try {
    await del(buildKey(transferId));
  } catch (err) {
    if (!err?.message?.includes('not found')) {
      console.error(`Failed to delete transfer metadata for ${transferId}:`, err);
    }
  }
}

export async function deletePatientTransferMapping(patientId) {
  if (!hasBlobAccess()) return;
  const mappingKey = buildKey(`patient_transfer_${patientId}`);
  try {
    await del(mappingKey);
  } catch (err) {
    if (!err?.message?.includes('not found')) {
      console.error(`Failed to delete patient transfer mapping for ${patientId}:`, err);
    }
  }
}


