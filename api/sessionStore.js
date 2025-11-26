import { put, head, del } from '@vercel/blob';
import { loadTransferFromBlob, saveTransferToBlob, hasBlobAccess } from './blobStore.js';

const SESSION_TTL_MS = 45 * 60 * 1000;
const SESSION_STAGES = new Set(['waiting', 'initiated', 'bankid', 'approved', 'uploading', 'uploaded', 'cancelled']);

const buildSessionKey = (code) => `transfers/session_code_${code}.json`;

function ensureMaps() {
  if (!global.__mmd_sessionCodes) {
    global.__mmd_sessionCodes = new Map();
  }
  if (!global.__mmd_sessionTransfers) {
    global.__mmd_sessionTransfers = new Map();
  }
  if (!global.__mmd_transfers) {
    global.__mmd_transfers = new Map();
  }
}

export function normalizeSessionCode(code) {
  if (!code) return null;
  const digits = String(code).replace(/[^0-9]/g, '');
  if (digits.length !== 6) return null;
  return `${digits.slice(0, 3)}-${digits.slice(3)}`;
}

function generateSessionCode() {
  ensureMaps();
  let code;
  do {
    const digits = Math.floor(100000 + Math.random() * 900000).toString();
    code = `${digits.slice(0, 3)}-${digits.slice(3)}`;
  } while (global.__mmd_sessionCodes.has(code));
  return code;
}

function isExpired(session) {
  if (!session?.createdAt) return false;
  return Date.now() - Number(session.createdAt) > SESSION_TTL_MS;
}

async function persistSession(session) {
  ensureMaps();
  global.__mmd_sessionCodes.set(session.code, session);
  global.__mmd_sessionTransfers.set(session.transferId, session.code);

  if (!hasBlobAccess()) {
    console.error('❌ BLOB ACCESS DENIED - Cannot persist session. VERCEL env:', process.env.VERCEL);
    throw new Error('Blob storage not available - cannot persist session');
  }
  const key = buildSessionKey(session.code);
  console.log('💾 Saving session to Blob:', key);
  await put(key, JSON.stringify(session, null, 2), {
    contentType: 'application/json',
    access: 'public',
    cacheControlMaxAge: 0,
    allowOverwrite: true,
  });
  console.log('✅ Session saved to Blob:', key);
}

async function loadSessionFromBlob(code) {
  if (!hasBlobAccess()) return null;
  try {
    const meta = await head(buildSessionKey(code));
    if (!meta?.url) return null;
    const res = await fetch(meta.url, { cache: 'no-store' });
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    return null;
  }
}

async function deleteSessionFromBlob(code) {
  if (!hasBlobAccess()) return;
  try {
    await del(buildSessionKey(code));
  } catch (err) {
    if (!err?.message?.includes('not found')) {
      console.error(`Failed to delete session blob ${code}:`, err);
    }
  }
}

async function getTransferRecord(transferId) {
  ensureMaps();
  let transfer = global.__mmd_transfers.get(transferId);
  if (!transfer) {
    transfer = await loadTransferFromBlob(transferId);
    if (transfer) {
      global.__mmd_transfers.set(transferId, transfer);
    }
  }
  return transfer;
}

async function saveTransferRecord(transferId, transfer) {
  ensureMaps();
  global.__mmd_transfers.set(transferId, transfer);
  await saveTransferToBlob(transferId, transfer);
}

export async function registerSession({ transferId, patientAlias = 'Patient', doctorName = 'Dr. Anna Andersson' }) {
  ensureMaps();
  if (!transferId) {
    throw new Error('transferId required to register session');
  }
  await removeSessionForTransfer(transferId);
  const code = generateSessionCode();
  const session = {
    code,
    transferId,
    patientAlias,
    doctorName,
    createdAt: Date.now(),
    stage: 'waiting',
    patientVerified: false,
    doctorVerified: false,
  };
  await persistSession(session);
  await updateTransferMeta(transferId, transfer => ({
    ...transfer,
    sessionCode: code,
    patientAlias,
    doctorName,
  }));
  return session;
}

export async function getSessionByCode(code) {
  ensureMaps();
  const normalized = normalizeSessionCode(code);
  if (!normalized) return null;
  let session = global.__mmd_sessionCodes.get(normalized);
  if (!session) {
    session = await loadSessionFromBlob(normalized);
    if (session) {
      global.__mmd_sessionCodes.set(normalized, session);
      global.__mmd_sessionTransfers.set(session.transferId, normalized);
    }
  }
  if (!session) return null;
  if (isExpired(session)) {
    await removeSessionCode(normalized);
    return null;
  }
  return session;
}

async function removeSessionCode(code) {
  ensureMaps();
  const session = global.__mmd_sessionCodes.get(code);
  if (session) {
    global.__mmd_sessionCodes.delete(code);
    global.__mmd_sessionTransfers.delete(session.transferId);
    await updateTransferMeta(session.transferId, transfer => {
      if (!transfer) return transfer;
      const next = { ...transfer };
      delete next.sessionCode;
      return next;
    });
  }
  await deleteSessionFromBlob(code);
}

export async function removeSessionForTransfer(transferId) {
  ensureMaps();
  const code = global.__mmd_sessionTransfers.get(transferId);
  if (code) {
    await removeSessionCode(code);
  }
}

export async function getSessionCodeForTransfer(transferId) {
  ensureMaps();
  if (!transferId) return null;
  let code = global.__mmd_sessionTransfers.get(transferId);
  if (!code) {
    for (const [storedCode, session] of global.__mmd_sessionCodes.entries()) {
      if (session?.transferId === transferId) {
        code = storedCode;
        break;
      }
    }
  }
  if (!code) {
    const transfer = await loadTransferFromBlob(transferId);
    if (transfer?.sessionCode) {
      const normalized = normalizeSessionCode(transfer.sessionCode);
      code = normalized || transfer.sessionCode;
    }
  }
  if (code) {
    global.__mmd_sessionTransfers.set(transferId, code);
    return code;
  }
  return null;
}

async function updateSession(code, updater) {
  const normalized = normalizeSessionCode(code);
  if (!normalized) return null;
  const session = await getSessionByCode(normalized);
  if (!session) return null;
  const updated = typeof updater === 'function' ? updater({ ...session }) : { ...session, ...updater };
  await persistSession(updated);
  return updated;
}

async function updateTransferMeta(transferId, updater) {
  if (!transferId) return null;
  const transfer = await getTransferRecord(transferId);
  if (!transfer) return null;
  const updated = typeof updater === 'function' ? updater({ ...transfer }) : { ...transfer, ...updater };
  await saveTransferRecord(transferId, updated);
  return updated;
}

export async function updateSessionStage(code, stage) {
  if (!SESSION_STAGES.has(stage)) return null;
  const session = await updateSession(code, current => {
    const next = { ...current, stage };
    if (stage === 'approved') {
      next.patientVerified = true;
    }
    if (stage === 'waiting') {
      next.patientVerified = false;
    }
    return next;
  });
  if (session?.transferId) {
    await updateTransferMeta(session.transferId, transfer => ({
      ...transfer,
      patientAlias: session.patientAlias,
      doctorName: session.doctorName,
      patientVerified: session.patientVerified,
      sessionStage: stage,
      status: stage === 'cancelled' ? 'cancelled' : transfer.status || 'open',
    }));
  }
  return session;
}

export async function updateDoctorVerification(code, verified = true) {
  const session = await updateSession(code, current => ({
    ...current,
    doctorVerified: Boolean(verified),
  }));
  if (session?.transferId) {
    await updateTransferMeta(session.transferId, transfer => ({
      ...transfer,
      doctorVerified: Boolean(verified),
    }));
  }
  return session;
}

export async function markPatientVerified(code, verified = true) {
  const session = await updateSession(code, current => ({
    ...current,
    patientVerified: Boolean(verified),
    stage: verified ? 'approved' : current.stage,
  }));
  if (session?.transferId) {
    await updateTransferMeta(session.transferId, transfer => ({
      ...transfer,
      patientVerified: Boolean(verified),
    }));
  }
  return session;
}

export async function getSessionSummary(code) {
  const session = await getSessionByCode(code);
  if (!session) return null;
  return session;
}

export { SESSION_TTL_MS, SESSION_STAGES };

