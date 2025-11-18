// Simple Vercel Blob JSON store for transfer metadata
// Key layout: transfers/{transferId}.json

import { put, head } from '@vercel/blob';

const buildKey = (transferId) => `transfers/${transferId}.json`;

const hasBlobAccess = () => {
  return Boolean(
    process.env.BLOB_READ_WRITE_TOKEN ||
    process.env.BLOB_API_URL ||
    process.env.VERCEL
  );
};

export async function loadTransferFromBlob(transferId) {
  if (!hasBlobAccess()) {
    return null;
  }
  const key = buildKey(transferId);
  try {
    const meta = await head(key);
    if (!meta || !meta.url) return null;
    const res = await fetch(meta.url, { cache: 'no-store' });
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    // HEAD throws if not found
    return null;
  }
}

export async function saveTransferToBlob(transferId, transfer) {
  if (!hasBlobAccess()) {
    return;
  }
  const key = buildKey(transferId);
  await put(key, JSON.stringify(transfer, null, 2), {
    contentType: 'application/json',
    access: 'public',
    cacheControlMaxAge: 0,
    allowOverwrite: true,
  });
}

export function createEmptyTransfer() {
  return { status: 'open', files: [], createdAt: Date.now() };
}


