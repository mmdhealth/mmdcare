// transfer-server.js
import express from "express";
import cors from "cors";
import { v4 as uuid } from "uuid";
import QRCode from "qrcode";
import multer from "multer";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { networkInterfaces } from "os";
import pdfParse from "pdf-parse";
import * as XLSX from "xlsx";
import { put, head, del } from "@vercel/blob";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const hasBlobAccess = Boolean(
  process.env.BLOB_READ_WRITE_TOKEN ||
  process.env.BLOB_API_URL ||
  process.env.VERCEL
);

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static files from the public directory
const publicDir = path.join(__dirname, "public");
app.use(express.static(publicDir));

// Serve login.html at root (first page)
app.get("/", (req, res) => {
  res.sendFile(path.join(publicDir, "login.html"));
});

// Ephemeral state for demo
const transfers = new Map(); // transferId -> { status, files: [] }
const clients = new Map();   // transferId -> Set(res) for SSE
const patientTransfers = new Map(); // patientId -> transferId

// API endpoint to clear all transfers (called on logout)
app.post("/api/logout", async (req, res) => {
  console.log('Logout requested - clearing all transfers and deleting all files');
  
  // Delete all files from all transfers before clearing
  const deletePromises = [];
  const allTransferIds = new Set();
  
  // Collect all transferIds from transfers map
  for (const [transferId, transfer] of transfers.entries()) {
    allTransferIds.add(transferId);
    console.log(`Deleting files for transfer: ${transferId}`);
    
    // Delete all files from this transfer
    if (transfer.files && transfer.files.length > 0) {
      for (const file of transfer.files) {
        // Delete from blob storage if blobKey exists
        if (hasBlobAccess && file.blobKey) {
          console.log(`Deleting blob file: ${file.blobKey}`);
          deletePromises.push(
            del(file.blobKey).catch(err => {
              console.error(`Failed to delete blob ${file.blobKey}:`, err);
            })
          );
        }
        
        // Also try to delete using the standard blob key pattern
        const standardBlobKey = `files/${transferId}/${file.name}`;
        if (hasBlobAccess && standardBlobKey !== file.blobKey) {
          console.log(`Deleting blob file (standard pattern): ${standardBlobKey}`);
          deletePromises.push(
            del(standardBlobKey).catch(err => {
              // Ignore errors for files that don't exist
              if (err.message && !err.message.includes('not found')) {
                console.error(`Failed to delete blob ${standardBlobKey}:`, err);
              }
            })
          );
        }
        
        // Delete from local disk
        if (file.name) {
          const localFilePath = path.join(uploadsRoot, transferId, file.name);
          try {
            if (fs.existsSync(localFilePath)) {
              fs.unlinkSync(localFilePath);
              console.log(`Deleted local file: ${localFilePath}`);
            }
          } catch (err) {
            console.error(`Failed to delete local file ${localFilePath}:`, err);
          }
        }
      }
    }
    
    // Delete transfer metadata from blob storage
    if (hasBlobAccess) {
      const transferMetadataKey = `transfers/${transferId}.json`;
      console.log(`Deleting transfer metadata blob: ${transferMetadataKey}`);
      deletePromises.push(
        del(transferMetadataKey).catch(err => {
          if (err.message && !err.message.includes('not found')) {
            console.error(`Failed to delete transfer metadata ${transferMetadataKey}:`, err);
          }
        })
      );
    }
    
    // Delete the entire transfer directory from local disk
    const uploadDir = path.join(uploadsRoot, transferId);
    try {
      if (fs.existsSync(uploadDir)) {
        fs.rmSync(uploadDir, { recursive: true, force: true });
        console.log(`Deleted transfer directory: ${uploadDir}`);
      }
    } catch (err) {
      console.error(`Failed to delete transfer directory ${uploadDir}:`, err);
    }
  }
  
  // Also collect transferIds from patientTransfers map (in case they're not in transfers map)
  for (const [patientId, transferId] of patientTransfers.entries()) {
    if (!allTransferIds.has(transferId)) {
      allTransferIds.add(transferId);
      console.log(`Found additional transfer ID from patient mapping: ${transferId}`);
      
      // Try to delete all possible blob files for this transfer
      // We'll delete the transfer metadata and try to delete files with common patterns
      if (hasBlobAccess) {
        const transferMetadataKey = `transfers/${transferId}.json`;
        console.log(`Deleting transfer metadata blob: ${transferMetadataKey}`);
        deletePromises.push(
          del(transferMetadataKey).catch(err => {
            if (err.message && !err.message.includes('not found')) {
              console.error(`Failed to delete transfer metadata ${transferMetadataKey}:`, err);
            }
          })
        );
      }
      
      // Delete transfer directory from local disk
      const uploadDir = path.join(uploadsRoot, transferId);
      try {
        if (fs.existsSync(uploadDir)) {
          fs.rmSync(uploadDir, { recursive: true, force: true });
          console.log(`Deleted transfer directory: ${uploadDir}`);
        }
      } catch (err) {
        console.error(`Failed to delete transfer directory ${uploadDir}:`, err);
      }
    }
  }
  
  // Wait for all blob deletions to complete
  await Promise.all(deletePromises);
  console.log('All blob files and metadata deleted');
  
  // Clear all transfers from memory
  transfers.clear();
  
  // Clear all patient-to-transfer mappings
  patientTransfers.clear();
  
  // Close all SSE connections
  clients.forEach((clientSet, transferId) => {
    clientSet.forEach(res => {
      try {
        res.end();
      } catch (e) {
        // Ignore errors
      }
    });
  });
  clients.clear();
  
  console.log('All transfers, mappings, files, and blob storage completely deleted');
  res.status(200).json({ success: true, message: 'All transfers and files deleted' });
});

// Storage (local disk for pilot)
const uploadsRoot = path.join(__dirname, "uploads");
fs.mkdirSync(uploadsRoot, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    // Support both route params and query params
    const transferId = req.params.transferId || req.query.transferId;
    if (!transferId) {
      return cb(new Error("transferId required"));
    }
    const dir = path.join(uploadsRoot, transferId);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => cb(null, file.originalname)
});

const upload = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024 }, // 100 MB each
  fileFilter: (req, file, cb) => {
    const ok = [
      "application/pdf",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    ].includes(file.mimetype);
    ok ? cb(null, true) : cb(new Error("Only PDF and XLSX allowed"));
  }
});

// 1) Create a new transfer session (desktop calls this)
app.post("/transfers", (req, res) => {
  const id = uuid();
  transfers.set(id, { status: "open", files: [], createdAt: Date.now() });
  res.status(201).json({ transferId: id, expiresInSec: 900 });
});

// API route alias for /api/transfers (for HTML compatibility)
app.get("/api/transfers", (req, res) => {
  const { patientId } = req.query;
  
  if (patientId) {
    // Check if a transfer already exists for this patient
    const existingTransferId = patientTransfers.get(patientId);
    
    if (existingTransferId) {
      // Return the existing transfer ID
      const existingTransfer = transfers.get(existingTransferId);
      if (existingTransfer) {
        console.log('Returning existing transfer ID for patient (GET):', patientId, existingTransferId);
        return res.status(200).json({ 
          transferId: existingTransferId, 
          patientId, 
          sessionId: existingTransfer.sessionId,
          existing: true
        });
      } else {
        // Transfer was deleted, create a new one
        console.log('Existing transfer ID found but transfer deleted, creating new one');
      }
    }
    
    // No existing transfer, create a new one
    const newId = uuid();
    const sessionId = `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    // Create new transfer with session ID
    transfers.set(newId, { 
      status: "open", 
      files: [], 
      createdAt: Date.now(), 
      patientId: patientId,
      sessionId: sessionId
    });
    patientTransfers.set(patientId, newId);
    console.log('Created NEW transfer ID for patient (GET):', patientId, newId, 'Session:', sessionId);
    return res.status(200).json({ transferId: newId, patientId, sessionId, existing: false });
  } else {
    return res.status(400).json({ error: 'patientId parameter required' });
  }
});

app.post("/api/transfers", (req, res) => {
  const { patientId } = req.body || {};
  
  // ALWAYS create a NEW transfer - NEVER reuse old ones
  // This ensures complete data isolation between sessions
  const id = uuid();
  const sessionId = `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  
  // Create transfer with session ID to ensure it's unique
  transfers.set(id, { 
    status: "open", 
    files: [], 
    createdAt: Date.now(), 
    patientId: patientId || null,
    sessionId: sessionId
  });
  
  // If patientId provided, ALWAYS update the mapping (even if it existed)
  if (patientId) {
    // CRITICAL: Delete any old transfer for this patient first
    // This ensures old files (PDF and Excel) are completely removed
    const oldTransferId = patientTransfers.get(patientId);
    if (oldTransferId && oldTransferId !== id) {
      console.log('Deleting old transfer and files for patient:', patientId, oldTransferId);
      const oldTransfer = transfers.get(oldTransferId);
      if (oldTransfer) {
        // Delete all files from old transfer
        oldTransfer.files = [];
      }
      // Delete the old transfer completely
      transfers.delete(oldTransferId);
      console.log('Removed old transfer mapping for patient:', patientId, oldTransferId);
    }
    patientTransfers.set(patientId, id);
    console.log('Created NEW transfer ID for patient:', patientId, id, 'Session:', sessionId);
  }
  
  res.status(201).json({ transferId: id, expiresInSec: 900, patientId, sessionId });
});

// Get local network IP for mobile access
function getLocalIP() {
  const interfaces = networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return null;
}

// API endpoint to get server info (for local development)
app.get("/api/server-info", (req, res) => {
  const localIP = getLocalIP();
  const port = process.env.PORT || 8000;
  res.json({
    localIP: localIP,
    port: port,
    baseUrl: localIP ? `http://${localIP}:${port}` : null
  });
});

// 2) Mobile upload page (QR opens this)
app.get("/upload", (req, res) => {
  const { transferId } = req.query;
  const t = transfers.get(transferId);
  if (!t || t.status !== "open") {
    return res.status(410).type("html").send(`<!doctype html>
    <html><head>
      <meta name="viewport" content="width=device-width,initial-scale=1" />
      <meta charset="utf-8" /><title>Transfer expired</title>
      <style>
        body{font-family:system-ui;padding:16px;text-align:center}
        .card{border:1px solid #e5e7eb;border-radius:16px;padding:16px;max-width:400px;margin:2rem auto}
        .error{color:#dc2626}
      </style></head><body>
      <div class="card">
        <h2 class="error">Transfer expired or invalid</h2>
        <p>This transfer session has expired or is invalid. Please scan the QR code again from your desktop.</p>
      </div>
    </body></html>`);
  }
  
  res.type("html").send(`<!doctype html>
  <html><head>
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; img-src 'self' data:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline';"/>
    <title>Share to MMDConnect</title>
    <style>
      body{font-family:system-ui;padding:16px;background:#f9fafb;min-height:100vh}
      .card{border:1px solid #e5e7eb;border-radius:16px;padding:24px;background:white;max-width:400px;margin:2rem auto}
      .header{text-align:center;margin-bottom:24px}
      .logo{width:40px;height:40px;margin-bottom:12px}
      h1{font-size:24px;font-weight:600;color:#1f2937;margin:0}
      .subtitle{color:#6b7280;font-size:14px;margin-top:8px}
      button{padding:12px 24px;border-radius:12px;border:none;background:#1d4ed8;color:white;font-weight:500;cursor:pointer;width:100%;margin-top:16px}
      button:disabled{background:#9ca3af;cursor:not-allowed}
      input[type=file]{display:block;margin:16px 0;padding:12px;border:2px dashed #d1d5db;border-radius:8px;width:100%;box-sizing:border-box}
      .hint{color:#6b7280;font-size:14px;text-align:center;margin-bottom:16px}
      .status{text-align:center;margin-top:16px;font-weight:500}
      .success{color:#059669}
      .error{color:#dc2626}
      .progress{color:#1d4ed8}
    </style></head><body>
    <div class="card">
      <div class="header">
        <img src="/Assets/mmdconnect.png" alt="MMDConnect" class="logo">
        <h1>Share health documents</h1>
        <p class="subtitle">Upload your health files to MMDConnect</p>
      </div>
      <p class="hint">Select PDF or Excel (XLSX) files. Maximum 100 MB each.</p>
      <input id="f" type="file" multiple accept=".pdf,application/pdf,.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" />
      <button id="send">Upload Files</button>
      <div id="msg" class="status"></div>
    </div>
    <script>
      const transferId = ${JSON.stringify(transferId)};
      const f = document.getElementById('f');
      const btn = document.getElementById('send');
      const msg = document.getElementById('msg');

      async function uploadOne(file) {
        const fd = new FormData();
        fd.append('file', file, file.name);
        const resp = await fetch('/upload/' + transferId, { method:'POST', body: fd });
        if (!resp.ok) throw new Error(await resp.text());
      }
      
      btn.onclick = async () => {
        const files = Array.from(f.files || []);
        if (!files.length) { 
          msg.textContent = "Please choose at least one file."; 
          msg.className = "status error";
          return; 
        }
        
        btn.disabled = true; 
        msg.textContent = "Uploading " + files.length + " file(s)...";
        msg.className = "status progress";
        
        try {
          for (const file of files) {
            await uploadOne(file);
          }
          await fetch('/complete/' + transferId, { method:'POST' });
          msg.textContent = "Upload completed! You can close this page.";
          msg.className = "status success";
        } catch (e) {
          msg.textContent = "Upload failed: " + e.message;
          msg.className = "status error";
        } finally {
          btn.disabled = false;
        }
      };
    </script>
  </body></html>`);
});

// API route for upload with query parameter (for mobile-upload.html compatibility)
app.post("/api/upload", upload.single("file"), (req, res) => {
  const { transferId } = req.query;
  if (!transferId) return res.status(400).send("transferId required");
  
  let t = transfers.get(transferId);
  
  // If transfer doesn't exist, try to create it (might have been lost on server restart)
  if (!t) {
    console.log('Transfer not found in Map, creating new one for:', transferId);
    t = { status: "open", files: [], createdAt: Date.now() };
    transfers.set(transferId, t);
  }
  
  // If transfer is closed, reopen it to allow multiple uploads
  if (t.status === "closed") {
    console.log('Transfer was closed, reopening for new upload:', transferId);
    t.status = "open";
    // Keep existing files, just reopen the transfer
  }
  
  if (t.status !== "open") {
    console.log('Transfer status is not open:', transferId, 'Status:', t.status);
    return res.status(410).send("Transfer expired or invalid");
  }

  console.log('Processing upload for transfer:', transferId, 'Current files:', t.files.length);

  (async () => {
    // Prepare metadata
    const meta = {
      name: req.file.originalname,
      size: req.file.size,
      mimetype: req.file.mimetype,
      uploadedAt: new Date().toISOString()
    };

    try {
      const localFilePath = path.join(uploadsRoot, transferId, req.file.originalname);
      if (hasBlobAccess) {
        const fileBuffer = fs.readFileSync(localFilePath);
        const blobKey = `files/${transferId}/${req.file.originalname}`;

        const result = await put(blobKey, fileBuffer, {
          contentType: req.file.mimetype,
          access: "public",
          allowOverwrite: true
        });

        meta.url = result.url;
        meta.blobKey = blobKey;

        if (process.env.NODE_ENV === 'production') {
          try { fs.unlinkSync(localFilePath); } catch (_) {}
        }
      } else {
        console.log('Skipping blob upload (no credentials) - keeping local file only');
      }
    } catch (e) {
      console.error("Blob upload failed:", e);
    }

    t.files.push(meta);
    console.log('File added to transfer:', transferId, 'File:', meta.name, 'Total files:', t.files.length);
    console.log('Transfer status after upload:', t.status, 'Files count:', t.files.length);
    broadcast(transferId, { type: "file", file: meta });
    res.sendStatus(204);
  })();
});

// 3) Receive file (mobile → server)
app.post("/upload/:transferId", upload.single("file"), (req, res) => {
  const { transferId } = req.params;
  let t = transfers.get(transferId);
  if (!t) return res.status(410).send("Transfer expired or invalid");
  
  // If transfer is closed, reopen it to allow multiple uploads
  if (t.status === "closed") {
    console.log('Transfer was closed, reopening for new upload:', transferId);
    t.status = "open";
    // Keep existing files, just reopen the transfer
  }
  
  if (t.status !== "open") return res.status(410).send("Transfer expired or invalid");

  (async () => {
    // Prepare metadata
    const meta = {
      name: req.file.originalname,
      size: req.file.size,
      mimetype: req.file.mimetype,
      uploadedAt: new Date().toISOString()
    };

    try {
      const localFilePath = path.join(uploadsRoot, transferId, req.file.originalname);
      if (hasBlobAccess) {
        const fileBuffer = fs.readFileSync(localFilePath);
        const blobKey = `files/${transferId}/${req.file.originalname}`;

        const result = await put(blobKey, fileBuffer, {
          contentType: req.file.mimetype,
          access: "public",
          allowOverwrite: true
        });

        meta.url = result.url;
        meta.blobKey = blobKey;

        if (process.env.NODE_ENV === 'production') {
          try { fs.unlinkSync(localFilePath); } catch (_) {}
        }
      } else {
        console.log('Skipping blob upload (no credentials) - keeping local file only');
      }
    } catch (e) {
      console.error("Blob upload failed:", e);
    }

    t.files.push(meta);
    broadcast(transferId, { type: "file", file: meta });
    res.sendStatus(204);
  })();
});

// 4) Mark done
app.post("/complete/:transferId", (req, res) => {
  const { transferId } = req.params;
  const t = transfers.get(transferId);
  if (!t) return res.sendStatus(404);
  t.status = "closed";
  broadcast(transferId, { type: "status", status: "closed" });
  broadcast(transferId, { type: "closed" });
  endStream(transferId);
  res.sendStatus(204);
});

// 5) Desktop subscribes to events
app.get("/events/:transferId", (req, res) => {
  const { transferId } = req.params;
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.flushHeaders();

  const set = clients.get(transferId) || new Set();
  set.add(res);
  clients.set(transferId, set);

  const t = transfers.get(transferId);
  res.write(`data: ${JSON.stringify({ type:"status", status: t?.status || "unknown" })}\n\n`);
  
  req.on("close", () => { 
    set.delete(res); 
    if (set.size === 0) {
      clients.delete(transferId);
    }
  });
});

// 6) Get transfer status and files
app.get("/transfer/:transferId", (req, res) => {
  const { transferId } = req.params;
  const t = transfers.get(transferId);
  if (!t) return res.status(404).json({ error: "Transfer not found" });
  
  res.json({
    transferId,
    status: t.status,
    files: t.files
  });
});

// API route for getting files (GET /api/files?transferId=...) - for dashboard
app.get("/api/files", (req, res) => {
  const { transferId } = req.query;
  if (!transferId) return res.status(400).json({ error: "transferId required" });
  
  const t = transfers.get(transferId);
  if (!t) {
    console.log('Transfer not found for ID (cleared or expired):', transferId);
    // Return empty files - NEVER load from blob storage or any persistent storage
    // This ensures old data is never returned after logout
    return res.json({
      transferId,
      status: "open",
      files: [],
      completed: false
    });
  }
  
  // Only return files if transfer exists in current session memory
  // NEVER fall back to blob storage or any persistent storage
  res.json({
    transferId,
    status: t.status,
    files: t.files || [], // Ensure files array exists
    completed: t.status === "closed"
  });
});

// API route for checking completion status (GET /api/complete?transferId=...)
app.get("/api/complete", (req, res) => {
  const { transferId } = req.query;
  if (!transferId) return res.status(400).json({ error: "transferId required" });
  
  let t = transfers.get(transferId);
  
  // If transfer doesn't exist, return open status (might be created on upload)
  if (!t) {
    console.log('Transfer not found when checking status, returning open:', transferId);
    return res.json({
      transferId,
      status: "open",
      files: [],
      completed: false
    });
  }
  
  console.log('Checking transfer status:', transferId, 'Status:', t.status, 'Files:', t.files.length);
  res.json({
    transferId,
    status: t.status,
    files: t.files,
    completed: t.status === "closed"
  });
});

// API route for marking completion (POST /api/complete?transferId=...) - for mobile-upload.html
app.post("/api/complete", (req, res) => {
  const { transferId } = req.query;
  if (!transferId) return res.status(400).json({ error: "transferId required" });
  
  let t = transfers.get(transferId);
  
  // If transfer doesn't exist, create it (might have been lost on server restart)
  if (!t) {
    console.log('Transfer not found in Map when marking complete, creating new one for:', transferId);
    t = { status: "open", files: [], createdAt: Date.now() };
    transfers.set(transferId, t);
  }
  
  console.log('Marking transfer as closed:', transferId, 'Files:', t.files.length);
  t.status = "closed";
  broadcast(transferId, { type: "status", status: "closed" });
  broadcast(transferId, { type: "closed" });
  endStream(transferId);
  res.sendStatus(204);
});

// 7) Get PDF content for journal notes
app.get("/pdf-content/:transferId/:filename", async (req, res) => {
  const { transferId, filename } = req.params;
  const t = transfers.get(transferId);
  if (!t) return res.status(404).json({ error: "Transfer not found" });
  
  try {
    // Prefer Blob if URL is present in metadata; otherwise fall back to local disk
    const meta = t.files.find(f => f.name === filename);
    let dataBuffer;

    if (meta && meta.url) {
      const response = await fetch(meta.url);
      if (!response.ok) return res.status(404).json({ error: "Blob file not accessible" });
      const arr = await response.arrayBuffer();
      dataBuffer = Buffer.from(arr);
    } else {
      const filePath = path.join(uploadsRoot, transferId, filename);
      if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: "File not found" });
      }
      dataBuffer = fs.readFileSync(filePath);
    }
    
    // Read and parse the PDF file
    const pdfData = await pdfParse(dataBuffer);
    
    // Extract text content
    const fullText = pdfData.text;
    
    // Parse the content to extract structured information
    const parsedContent = parsePDFContent(fullText, filename);
    
    res.json(parsedContent);
  } catch (error) {
    console.error('Error reading PDF:', error);
    res.status(500).json({ error: "Failed to read PDF content" });
  }
});

// Helper function to parse content into structured sections
function parseStructuredContent(text) {
  const sections = {
    anamnes: null,
    status: null,
    bedomning: null,
    rekommendationer: null,
    undersokningar: null,
    medicin: null,
    other: []
  };

  // Split text into lines for better processing
  const lines = text.split('\n').map(line => line.trim()).filter(line => line.length > 0);
  
  let currentSection = 'other';
  let currentContent = [];
  
  // Define section patterns (Swedish medical terms)
  const sectionPatterns = {
    anamnes: /\b(anamnes|historik|beskrivning|patienten uppger|patienten rapporterar|symptom|besvär|nybesök|aktuell anamnes)\b/i,
    status: /\b(status|undersökning|fynd|fynd vid undersökning|klinisk undersökning|gott och opåverkat|öron|näsa|munhåla|svalg|epifarynx)\b/i,
    bedomning: /\b(bedömning|diagnos|slutsats|utlåtande|bedömning av|normalt hörselprov|bullerdipp|klickljud|bruxism|tts)\b/i,
    rekommendationer: /\b(rekommendation|rekommenderar|förslag|behandling|uppföljning|nästa steg|utprovning|betskena|ryaltris|åter vid behov)\b/i,
    undersokningar: /\b(undersökning|prov|test|analys|röntgen|mrt|ct|ultraljud|ekg|blodprov|hörselprov)\b/i,
    medicin: /\b(medicin|läkemedel|behandling|terapi|dos|mg|tablett|kapsel|ryaltris)\b/i
  };

  // Enhanced parsing for Swedish medical documents
  const textToProcess = text;
  
  // Try to extract specific sections using more sophisticated patterns
  const sectionExtractors = {
    anamnes: {
      startPattern: /(?:nybesök|aktuell anamnes|anamnes|historik)/i,
      endPattern: /(?:status|undersökning|fynd|bedömning)/i,
      content: null
    },
    status: {
      startPattern: /(?:status|undersökning|fynd|klinisk undersökning)/i,
      endPattern: /(?:bedömning|diagnos|slutsats|rekommendation)/i,
      content: null
    },
    bedomning: {
      startPattern: /(?:bedömning|diagnos|slutsats|utlåtande)/i,
      endPattern: /(?:rekommendation|behandling|uppföljning|åter)/i,
      content: null
    },
    rekommendationer: {
      startPattern: /(?:rekommendation|rekommenderar|behandling|uppföljning)/i,
      endPattern: /(?:åter vid behov|nästa besök|slut)/i,
      content: null
    }
  };
  
  // Extract each section
  for (const [sectionName, extractor] of Object.entries(sectionExtractors)) {
    const startMatch = textToProcess.match(extractor.startPattern);
    if (startMatch) {
      const startIndex = startMatch.index + startMatch[0].length;
      let endIndex = textToProcess.length;
      
      // Find end of section
      const endMatch = textToProcess.substring(startIndex).match(extractor.endPattern);
      if (endMatch) {
        endIndex = startIndex + endMatch.index;
      }
      
      const sectionContent = textToProcess.substring(startIndex, endIndex).trim();
      if (sectionContent.length > 10) {
        sections[sectionName] = sectionContent;
      }
    }
  }
  
  // If no structured sections found, try simple keyword-based splitting
  if (Object.keys(sections).every(key => sections[key] === null || (Array.isArray(sections[key]) && sections[key].length === 0))) {
    const majorSections = ['ANAMNES', 'STATUS', 'BEDÖMNING', 'REKOMMENDATION'];
    
    for (const section of majorSections) {
      const regex = new RegExp(`\\b${section}\\b`, 'i');
      if (regex.test(textToProcess)) {
        const parts = textToProcess.split(regex);
        if (parts.length > 1) {
          for (let i = 0; i < parts.length; i++) {
            const part = parts[i].trim();
            if (part.length > 0) {
              if (i === 0) {
                if (part.length > 50) {
                  sections.other.push(part);
                }
              } else {
                const sectionKey = section.toLowerCase().replace('ö', 'o').replace('ä', 'a');
                if (sections[sectionKey] === null) {
                  sections[sectionKey] = part;
                } else {
                  sections.other.push(part);
                }
              }
            }
          }
          break;
        }
      }
    }
  }
  
  // If no major sections found, try line-by-line parsing
  if (Object.keys(sections).every(key => sections[key] === null || (Array.isArray(sections[key]) && sections[key].length === 0))) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      let sectionFound = false;
      
      // Check if this line starts a new section
      for (const [sectionName, pattern] of Object.entries(sectionPatterns)) {
        if (pattern.test(line) && line.length < 100) { // Short lines are likely headers
          // Save previous section content
          if (currentContent.length > 0) {
            if (sections[currentSection] === null) {
              sections[currentSection] = currentContent.join(' ').trim();
            } else {
              sections.other.push(currentContent.join(' ').trim());
            }
          }
          
          // Start new section
          currentSection = sectionName;
          currentContent = [line];
          sectionFound = true;
          break;
        }
      }
      
      if (!sectionFound) {
        currentContent.push(line);
      }
    }
  }
  
  // Save the last section
  if (currentContent.length > 0) {
    if (sections[currentSection] === null) {
      sections[currentSection] = currentContent.join(' ').trim();
    } else {
      sections.other.push(currentContent.join(' ').trim());
    }
  }
  
  // Clean up empty sections and format content
  const cleanedSections = {};
  for (const [key, value] of Object.entries(sections)) {
    if (value !== null && value.length > 0) {
      cleanedSections[key] = value;
    }
  }
  
  return cleanedSections;
}

// Helper function to parse PDF content and extract structured information
function parsePDFContent(text, filename) {
  // Clean up the text
  const cleanText = text.replace(/\s+/g, ' ').trim();
  
  // Extract title (first line or filename-based)
  let title = "Importerad Journalanteckning";
  const lines = text.split('\n').filter(line => line.trim().length > 0);
  if (lines.length > 0) {
    const firstLine = lines[0].trim();
    if (firstLine.length > 5 && firstLine.length < 100) {
      title = firstLine;
    }
  }
  
  // Extract doctor name (look for common patterns)
  let doctor = "Dr. Okänd Läkare";
  const doctorPatterns = [
    /Dr\.?\s+([A-ZÅÄÖ][a-zåäö]+\s+[A-ZÅÄÖ][a-zåäö]+)/i,
    /Läkare:\s*([A-ZÅÄÖ][a-zåäö]+\s+[A-ZÅÄÖ][a-zåäö]+)/i,
    /Undersökande:\s*([A-ZÅÄÖ][a-zåäö]+\s+[A-ZÅÄÖ][a-zåäö]+)/i,
    /Antecknad av\s+([A-ZÅÄÖ][a-zåäö\s]+?)\s*\(Läkare\)/i,
    /([A-ZÅÄÖ][a-zåäö\s]+?)\s*\(Läkare\)/i
  ];
  
  for (const pattern of doctorPatterns) {
    const match = cleanText.match(pattern);
    if (match) {
      doctor = `Dr. ${match[1]}`;
      break;
    }
  }
  
  // Extract date (look for Swedish date patterns)
  let date = new Date().toLocaleDateString('sv-SE');
  const datePatterns = [
    /(\d{4}-\d{2}-\d{2})/,
    /(\d{2}\/\d{2}\/\d{4})/,
    /(\d{2}\.\d{2}\.\d{4})/,
    /(\d{1,2}\s+(januari|februari|mars|april|maj|juni|juli|augusti|september|oktober|november|december)\s+\d{4})/i
  ];
  
  for (const pattern of datePatterns) {
    const match = cleanText.match(pattern);
    if (match) {
      date = match[1];
      break;
    }
  }
  
  // Create summary with section titles
  let summary = "";
  const structuredContent = parseStructuredContent(cleanText);
  
  // If we have structured content, show section titles
  if (typeof structuredContent === 'object' && structuredContent !== null) {
    const sectionLabels = {
      'anamnes': 'Anamnes',
      'status': 'Status', 
      'undersokningar': 'Undersökningar',
      'bedomning': 'Bedömning',
      'rekommendationer': 'Rekommendationer',
      'medicin': 'Medicin/Behandling'
    };
    
    const availableSections = [];
    for (const [key, label] of Object.entries(sectionLabels)) {
      if (structuredContent[key]) {
        availableSections.push(label);
      }
    }
    
    if (availableSections.length > 0) {
      summary = `Innehåller: ${availableSections.join(', ')}`;
    } else {
      summary = "Importerad journalanteckning";
    }
  } else {
    // Fallback to first 200 characters
    summary = cleanText.substring(0, 200);
    const firstSentence = cleanText.match(/^[^.!?]*[.!?]/);
    if (firstSentence && firstSentence[0].length < 200) {
      summary = firstSentence[0];
    }
    if (summary.length > 200) {
      summary = summary.substring(0, 200) + "...";
    }
  }
  
  return {
    title: title,
    doctor: doctor,
    date: date,
    summary: summary,
    content: structuredContent
  };
}

// 8) Get Excel content for parsing
app.get("/api/excel-content", async (req, res) => {
  const { transferId, filename } = req.query;
  if (!transferId || !filename) {
    return res.status(400).json({ error: "Missing transferId or filename" });
  }

  const t = transfers.get(transferId);
  if (!t) return res.status(404).json({ error: "Transfer not found" });

  try {
    // Find the Excel file in the transfer
    const excelFile = t.files.find(f => 
      f.name === filename && 
      (f.mimetype === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' || 
       f.mimetype === 'application/vnd.ms-excel' ||
       f.name.toLowerCase().endsWith('.xlsx') ||
       f.name.toLowerCase().endsWith('.xls'))
    );

    if (!excelFile) {
      return res.status(404).json({ error: "Excel file not found in transfer" });
    }

    // Try to get file from local disk first, then from blob URL
    let excelBuffer;
    const localFilePath = path.join(uploadsRoot, transferId, filename);
    
    if (fs.existsSync(localFilePath)) {
      excelBuffer = fs.readFileSync(localFilePath);
    } else if (excelFile.url) {
      // Download from blob URL
      const response = await fetch(excelFile.url);
      if (!response.ok) {
        return res.status(500).json({ error: "Failed to download Excel file" });
      }
      const arrayBuffer = await response.arrayBuffer();
      excelBuffer = Buffer.from(arrayBuffer);
    } else {
      return res.status(404).json({ error: "Excel file not found in storage" });
    }

    // Parse the Excel content
    let workbook;
    let structuredContent;
    try {
      workbook = XLSX.read(excelBuffer, { type: 'buffer' });
      structuredContent = parseExcelContent(excelFile, workbook);
    } catch (parseError) {
      console.error('Excel parsing failed:', parseError);
      structuredContent = createFallbackExcelContent(excelFile);
    }

    res.json(structuredContent);
  } catch (error) {
    console.error('Error processing Excel content:', error);
    res.status(500).json({ error: "Failed to process Excel content", details: error.message });
  }
});

// Helper function to parse Excel content
function parseExcelContent(excelFile, workbook) {
  const filename = excelFile.name;
  const uploadedAt = new Date(excelFile.uploadedAt || Date.now());

  // Get the first sheet
  const firstSheetName = workbook.SheetNames[0];
  const worksheet = workbook.Sheets[firstSheetName];

  // Convert to JSON for easier parsing
  const jsonData = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: '' });

  // Extract heart-related data
  const heartData = extractHeartData(jsonData);

  // Create dynamic data mapping
  const dynamicData = {};
  const unwantedPatterns = [
    'datum', 'date', 'tid', 'time', 'kl', 'klockan',
    '<', '>', '≤', '≥', 'under', 'över', 'mindre', 'mer',
    'normal', 'referens', 'ref', 'range', 'intervall',
    'enhet', 'unit', 'värde', 'value', 'resultat', 'result',
    'prov', 'sample', 'analys', 'analysis', 'test', 'mätning'
  ];

  const rawDataItems = jsonData.flat().filter(item => {
    if (!item || typeof item !== 'string') return false;
    const trimmed = item.trim().toLowerCase();
    if (trimmed === '' || trimmed.length < 3) return false;
    for (const pattern of unwantedPatterns) {
      if (trimmed.includes(pattern)) return false;
    }
    if (/^[\d\s\.,\-<>≤≥]+$/.test(trimmed)) return false;
    return true;
  });

  // Find values for each rawData item
  rawDataItems.forEach(item => {
    let foundValues = [];
    for (let i = 0; i < jsonData.length; i++) {
      const row = jsonData[i];
      if (!row || row.length === 0) continue;
      for (let j = 0; j < row.length; j++) {
        const cell = String(row[j]).trim();
        if (cell === item) {
          // Look in same column below
          for (let k = i + 1; k < jsonData.length; k++) {
            const valueRow = jsonData[k];
            if (valueRow && j < valueRow.length) {
              const numValue = parseFloat(valueRow[j]);
              if (!isNaN(numValue) && numValue > 0) {
                foundValues.push({ value: numValue, row: k, col: j });
              }
            }
          }
          // Try next column
          if (j + 1 < row.length) {
            const nextColValue = parseFloat(row[j + 1]);
            if (!isNaN(nextColValue) && nextColValue > 0) {
              foundValues.push({ value: nextColValue, row: i, col: j + 1 });
            }
          }
        }
      }
    }
    if (foundValues.length > 0) {
      const latestValue = foundValues.sort((a, b) => b.row - a.row)[0];
      const existingValues = Object.values(dynamicData);
      if (!existingValues.includes(latestValue.value)) {
        dynamicData[item] = latestValue.value;
      }
    }
  });

  return {
    filename: filename,
    uploadedAt: uploadedAt.toISOString(),
    sheetNames: workbook.SheetNames,
    heartData: heartData,
    rawData: rawDataItems,
    dynamicData: dynamicData,
    parsedAt: new Date().toISOString()
  };
}

// Helper function to extract heart data from Excel
function extractHeartData(jsonData) {
  const heartData = {
    heartRate: null,
    systolicBP: null,
    diastolicBP: null,
    cholesterolLDL: null,
    heartRateOverTime: [],
    bloodPressureData: [],
    ecgData: [],
    hrvData: []
  };

  const patterns = {
    heartRate: /(?:hjärtfrekvens|heart[\s-]*rate|puls|pulse|hr\b)/i,
    systolic: /(?:systolisk|systolic|sys\b|övre[\s-]*blodtryck|upper[\s-]*bp)/i,
    diastolic: /(?:diastolisk|diastolic|dia\b|nedre[\s-]*blodtryck|lower[\s-]*bp)/i,
    cholesterol: /(?:kolesterol|cholesterol|ldl\b)/i
  };

  const findValueNearLabel = (row, colIndex, nextRow) => {
    if (colIndex + 1 < row.length) {
      const val = parseFloat(row[colIndex + 1]);
      if (!isNaN(val)) return val;
    }
    if (nextRow && colIndex < nextRow.length) {
      const val = parseFloat(nextRow[colIndex]);
      if (!isNaN(val)) return val;
    }
    return null;
  };

  for (let i = 0; i < jsonData.length; i++) {
    const row = jsonData[i];
    const nextRow = i + 1 < jsonData.length ? jsonData[i + 1] : null;
    if (!row || row.length === 0) continue;

    for (let j = 0; j < row.length; j++) {
      const cell = String(row[j]).trim();
      if (!cell) continue;

      if (patterns.heartRate.test(cell) && !heartData.heartRate) {
        const value = findValueNearLabel(row, j, nextRow);
        if (value !== null && value > 0 && value < 300) {
          heartData.heartRate = Math.round(value);
        }
      }

      if (patterns.systolic.test(cell) && !heartData.systolicBP) {
        const value = findValueNearLabel(row, j, nextRow);
        if (value !== null && value > 0 && value < 300) {
          heartData.systolicBP = Math.round(value);
        }
      }

      if (patterns.diastolic.test(cell) && !heartData.diastolicBP) {
        const value = findValueNearLabel(row, j, nextRow);
        if (value !== null && value > 0 && value < 200) {
          heartData.diastolicBP = Math.round(value);
        }
      }

      if (patterns.cholesterol.test(cell) && !heartData.cholesterolLDL) {
        const value = findValueNearLabel(row, j, nextRow);
        if (value !== null && value > 0 && value < 20) {
          heartData.cholesterolLDL = value.toFixed(1);
        }
      }

      // Handle blood pressure in "120/80" format
      const bpMatch = cell.match(/(\d{2,3})\s*[\/\-]\s*(\d{2,3})/);
      if (bpMatch && (!heartData.systolicBP || !heartData.diastolicBP)) {
        const sys = parseInt(bpMatch[1]);
        const dia = parseInt(bpMatch[2]);
        if (sys > 60 && sys < 300 && dia > 40 && dia < 200) {
          if (!heartData.systolicBP) heartData.systolicBP = sys;
          if (!heartData.diastolicBP) heartData.diastolicBP = dia;
        }
      }
    }
  }

  return heartData;
}

// Helper function for fallback Excel content
function createFallbackExcelContent(excelFile) {
  return {
    filename: excelFile.name,
    uploadedAt: new Date(excelFile.uploadedAt || Date.now()).toISOString(),
    sheetNames: [],
    heartData: {
      heartRate: null,
      systolicBP: null,
      diastolicBP: null,
      cholesterolLDL: null,
      heartRateOverTime: [],
      bloodPressureData: [],
      ecgData: [],
      hrvData: []
    },
    error: 'Excel file could not be parsed automatically',
    parsedAt: new Date().toISOString()
  };
}

// 7) Cancel transfer
app.post("/cancel/:transferId", (req, res) => {
  const { transferId } = req.params;
  const t = transfers.get(transferId);
  if (!t) return res.status(404).json({ error: "Transfer not found" });
  
  t.status = "cancelled";
  broadcast(transferId, { type: "status", status: "cancelled" });
  broadcast(transferId, { type: "cancelled" });
  endStream(transferId);
  res.sendStatus(204);
});

// 8) Delete all files for a transfer
app.delete("/delete-all/:transferId", (req, res) => {
  const { transferId } = req.params;
  const t = transfers.get(transferId);
  if (!t) return res.status(404).json({ error: "Transfer not found" });
  
  try {
    // Clear files from memory
    t.files = [];
    
    // Delete files from disk
    const uploadDir = path.join(uploadsRoot, transferId);
    if (fs.existsSync(uploadDir)) {
      fs.rmSync(uploadDir, { recursive: true, force: true });
    }
    
    // Broadcast deletion event
    broadcast(transferId, { type: "files_deleted" });
    
    res.sendStatus(204);
  } catch (error) {
    console.error('Error deleting files:', error);
    res.status(500).json({ error: "Failed to delete files" });
  }
});

// Favicon handler to prevent CSP errors
app.get("/favicon.ico", (req, res) => {
  res.status(204).end();
});

// 9) For quick local testing: a simple receive page with QR
app.get("/receive", async (req, res) => {
  const id = uuid();
  transfers.set(id, { status: "open", files: [], createdAt: Date.now() });
  const mobileUrl = `${req.protocol}://${req.get("host")}/upload?transferId=${id}`;
  const qrDataUrl = await QRCode.toDataURL(mobileUrl);

  res.type("html").send(`<!doctype html>
  <html><head><meta charset="utf-8"/><meta http-equiv="Content-Security-Policy" content="default-src 'self'; img-src 'self' data:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline';"/><title>Receive files - MMDConnect</title>
  <style>
    body{font-family:system-ui;max-width:800px;margin:2rem auto;padding:20px;background:#f9fafb}
    .card{border:1px solid #e5e7eb;border-radius:16px;padding:24px;background:white;margin-bottom:20px}
    .file{padding:12px 0;border-bottom:1px solid #eee;display:flex;justify-content:space-between;align-items:center}
    .file:last-child{border-bottom:none}
    .file-name{font-weight:500}
    .file-size{color:#6b7280;font-size:14px}
    .status{display:inline-block;padding:4px 12px;border-radius:20px;font-size:12px;font-weight:500}
    .status.open{background:#dbeafe;color:#1e40af}
    .status.closed{background:#dcfce7;color:#166534}
    .status.cancelled{background:#fee2e2;color:#dc2626}
    .qr-container{text-align:center;margin:20px 0}
    .qr-container img{border:1px solid #e5e7eb;border-radius:8px}
  </style></head>
  <body>
    <div class="card">
      <h1>Receive files - MMDConnect</h1>
      <div class="qr-container">
        <p>Scan with phone camera:</p>
        <img src="${qrDataUrl}" style="width:240px;height:240px"/>
        <p><a href="${mobileUrl}" target="_blank">${mobileUrl}</a></p>
      </div>
      <p>Status: <span id="status" class="status open">open</span></p>
      <button onclick="cancelTransfer()" style="background:#dc2626;color:white;border:none;padding:8px 16px;border-radius:6px;cursor:pointer;margin-top:10px">Cancel Transfer</button>
    </div>
    
    <div class="card">
      <h3>Incoming files</h3>
      <div id="files"></div>
    </div>
    
    <script>
      const transferId = "${id}";
      const statusEl = document.getElementById('status');
      const filesEl = document.getElementById('files');

      function addFileRow(f) {
        const div = document.createElement('div');
        div.className = 'file';
        div.innerHTML = \`
          <span class="file-name">\${f.name}</span>
          <span class="file-size">\${Math.round(f.size/1024)} KB</span>
        \`;
        filesEl.prepend(div);
      }
      
      function updateStatus(status) {
        statusEl.textContent = status;
        statusEl.className = \`status \${status}\`;
      }
      
      async function cancelTransfer() {
        try {
          await fetch('/cancel/' + transferId, { method: 'POST' });
        } catch (e) {
          console.error('Failed to cancel transfer:', e);
        }
      }
      
      const ev = new EventSource('/events/' + transferId);
      ev.onmessage = (e) => {
        const m = JSON.parse(e.data);
        if (m.type === 'status') updateStatus(m.status);
        if (m.type === 'file') addFileRow(m.file);
        if (m.type === 'closed' || m.type === 'cancelled') ev.close();
      };
    </script>
  </body></html>`);
});

// Utilities
function broadcast(transferId, payload) {
  const set = clients.get(transferId);
  if (!set) return;
  for (const r of set) {
    try {
      r.write(`data: ${JSON.stringify(payload)}\n\n`);
    } catch (e) {
      // Remove dead connections
      set.delete(r);
    }
  }
}

function endStream(transferId) {
  const set = clients.get(transferId);
  if (!set) return;
  for (const r of set) {
    try {
      r.end();
    } catch (e) {
      // Ignore errors when ending streams
    }
  }
  clients.delete(transferId);
}

// Clean up expired transfers every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [id, transfer] of transfers.entries()) {
    // Remove transfers older than 30 minutes
    if (now - transfer.createdAt > 30 * 60 * 1000) {
      transfers.delete(id);
      endStream(id);
    }
  }
}, 5 * 60 * 1000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`MMDConnect Transfer Server running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  if (process.env.NODE_ENV !== 'production') {
    console.log(`Local access: http://localhost:${PORT}`);
    console.log(`Test page: http://localhost:${PORT}/receive`);
  }
});

