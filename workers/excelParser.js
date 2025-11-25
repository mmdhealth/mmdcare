import { parentPort, workerData } from "worker_threads";
import fs from "fs";
import * as XLSX from "xlsx";

const { filePath, meta } = workerData;

const DATE_KEYWORDS = ["date", "datum", "dag", "dato"];
const TIME_KEYWORDS = ["time", "tid", "klock", "kl", "hour"];
const DATETIME_KEYWORDS = ["timestamp", "tidpunkt", "date/time", "datetime"];

const PARAMETER_MAP = [
  { key: "weight", label: "Vikt", unit: "kg", matchers: ["weight", "vikt", "kg"], min: 20, max: 400, timeline: true },
  { key: "heartRate", label: "Hjärtfrekvens", unit: "bpm", matchers: ["heart rate", "pulse", "hjärtfrekvens", "hr", "slag/min"], min: 20, max: 260, timeline: true },
  { key: "oxygenSaturation", label: "Syresättning", unit: "%", matchers: ["spo2", "so2", "oxygen", "syres", "o2"], min: 40, max: 100, timeline: true },
  { key: "ldl", label: "LDL", unit: "mmol/L", matchers: ["ldl-kolesterol", "ldl"], min: 0, max: 20, timeline: true },
  { key: "hdl", label: "HDL", unit: "mmol/L", matchers: ["hdl-kolesterol", "hdl"], min: 0, max: 20, timeline: true },
  { key: "totalCholesterol", label: "Totalkolesterol", unit: "mmol/L", matchers: ["total cholesterol", "cholesterol", "kolesterol"], min: 0, max: 25, timeline: true },
  { key: "triglycerides", label: "Triglycerider", unit: "mmol/L", matchers: ["triglycerid"], min: 0, max: 50, timeline: true },
  { key: "glucose", label: "Glukos", unit: "mmol/L", matchers: ["glucose", "glukos", "hba1c"], min: 0, max: 100, timeline: true },
  { key: "egfr", label: "eGFR", unit: "mL/min", matchers: ["egfr"], min: 0, max: 200, timeline: true },
  { key: "steps", label: "Steg", unit: "steg", matchers: ["steps", "steg"], min: 0, max: 200000, timeline: true },
  { key: "sleep", label: "Sömn", unit: "h", matchers: ["sleep", "sömn"], min: 0, max: 24, timeline: true },
  { key: "bloodPressureSys", label: "Systoliskt", unit: "mmHg", matchers: ["systolic", "systoliskt", "sys", "upper bp", "övre"], min: 40, max: 300 },
  { key: "bloodPressureDia", label: "Diastoliskt", unit: "mmHg", matchers: ["diastolic", "diastoliskt", "dia", "lower bp", "nedre"], min: 20, max: 200 },
  { key: "bloodPressureCombined", label: "Blodtryck", unit: "mmHg", matchers: ["blood pressure", "blodtryck", "bp", "rr"] },
  { key: "afBurden", label: "AF-börda", unit: "%", matchers: ["af", "atrial fibrillation", "fibrillation", "rytm"], min: 0, max: 100, timeline: true }
];

const PARAMETER_META = PARAMETER_MAP.reduce((acc, item) => {
  acc[item.key] = item;
  return acc;
}, {});

const MAX_RAW_ITEMS = 100;

function createAggregation(excelMeta, workbook) {
  return {
    filename: excelMeta?.name || "excel.xlsx",
    uploadedAt: new Date(excelMeta?.uploadedAt || Date.now()).toISOString(),
    parsedAt: new Date().toISOString(),
    sheetNames: workbook.SheetNames,
    sheetSummaries: [],
    metrics: createEmptyMetrics(),
    rawLabelSet: new Set(),
    dynamicData: {},
    sampleSequence: 0
  };
}

function createEmptyMetrics() {
  const latest = {
    bloodPressure: null,
    heartRate: null,
    oxygenSaturation: null,
    weight: null,
    rhythm: null,
    ldl: null,
    hdl: null,
    totalCholesterol: null,
    triglycerides: null,
    glucose: null,
    egfr: null,
    steps: null,
    sleep: null
  };

  const trends = {
    bloodPressure: [],
    heartRate: [],
    oxygenSaturation: [],
    weight: [],
    ldl: [],
    hdl: [],
    totalCholesterol: [],
    triglycerides: [],
    glucose: [],
    egfr: [],
    steps: [],
    sleep: [],
    afBurden: []
  };

  return { latest, trends };
}

function parseWorkbook(excelMeta, workbook) {
  const aggregation = createAggregation(excelMeta, workbook);

  workbook.SheetNames.forEach(sheetName => {
    const worksheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: null });
    processSheet(rows, sheetName, aggregation);
  });

  finalizeTrends(aggregation.metrics);

  const rawData = Array.from(aggregation.rawLabelSet).slice(0, MAX_RAW_ITEMS);
  return {
    filename: aggregation.filename,
    uploadedAt: aggregation.uploadedAt,
    parsedAt: aggregation.parsedAt,
    sheetNames: aggregation.sheetNames,
    sheetSummaries: aggregation.sheetSummaries,
    metrics: aggregation.metrics,
    rawData,
    dynamicData: aggregation.dynamicData,
    heartData: buildHeartData(aggregation.metrics)
  };
}

function processSheet(rows, sheetName, aggregation) {
  if (!rows || rows.length === 0) return;
  const headerInfo = findHeaderRow(rows);
  if (!headerInfo) return;

  const { headerIndex, headers } = headerInfo;
  const dataRows = rows.slice(headerIndex + 1).filter(row => Array.isArray(row) && row.some(value => value !== null && value !== ""));
  if (dataRows.length === 0) return;

  const descriptors = describeColumns(headers, rows, headerIndex);

  aggregation.sheetSummaries.push({
    sheetName,
    headerRowIndex: headerIndex,
    headerRow: headers,
    rowCount: dataRows.length
  });

  dataRows.forEach((row, offset) => {
    const timestamp = deriveTimestamp(row, descriptors);
    const rowValues = extractRowValues(row, descriptors);
    applyRowValues(aggregation, rowValues, timestamp, { sheetName, rowIndex: headerIndex + 1 + offset });
    updateRawCollections(aggregation, descriptors, row);
  });
}

function findHeaderRow(rows) {
  let bestIndex = -1;
  let bestScore = -1;

  for (let i = 0; i < Math.min(rows.length, 20); i++) {
    const row = rows[i];
    if (!Array.isArray(row)) continue;
    let score = 0;
    row.forEach(cell => {
      if (typeof cell === "string" && cell.trim().length > 0) {
        score += 2;
      } else if (cell !== null && cell !== "") {
        score += 1;
      }
    });
    if (score > bestScore) {
      bestScore = score;
      bestIndex = i;
    }
  }

  if (bestIndex === -1 || bestScore === 0) return null;

  const headers = (rows[bestIndex] || []).map((cell, idx) => {
    const label = typeof cell === "string" ? cell.trim() : "";
    return label || `Kolumn ${idx + 1}`;
  });

  return { headerIndex: bestIndex, headers };
}

function describeColumns(headers, rows, headerIndex) {
  return headers.map((header, index) => {
    const normalized = normalizeText(header);
    let role = detectDeclaredRole(normalized);
    let matcher = matchParameter(normalized);

    if (!role || role === "value") {
      const sampleValues = [];
      for (let i = headerIndex + 1; i < Math.min(rows.length, headerIndex + 10); i++) {
        const cell = rows[i]?.[index];
        if (cell !== null && cell !== undefined && cell !== "") {
          sampleValues.push(cell);
        }
      }
      if (!role) {
        role = inferRoleFromSamples(sampleValues);
      }
      if (!matcher) {
        matcher = matchParameterBySamples(sampleValues);
      }
    }

    return {
      index,
      header,
      normalized,
      role: role || "value",
      matcher
    };
  });
}

function detectDeclaredRole(normalizedHeader) {
  if (!normalizedHeader) return null;
  if (DATETIME_KEYWORDS.some(keyword => normalizedHeader.includes(keyword))) return "datetime";
  if (DATE_KEYWORDS.some(keyword => normalizedHeader.includes(keyword))) return "date";
  if (TIME_KEYWORDS.some(keyword => normalizedHeader.includes(keyword))) return "time";
  return "value";
}

function inferRoleFromSamples(samples) {
  if (samples.some(value => parseDateValue(value))) return "date";
  if (samples.some(value => parseTimeValue(value))) return "time";
  return "value";
}

function matchParameter(normalizedHeader) {
  if (!normalizedHeader) return null;
  let best = null;
  PARAMETER_MAP.forEach(param => {
    param.matchers.forEach(matcher => {
      const normalizedMatcher = normalizeText(matcher);
      if (normalizedHeader.includes(normalizedMatcher)) {
        const score = normalizedMatcher.length;
        if (!best || score > best.score) {
          best = { paramKey: param.key, score };
        }
      }
    });
  });
  return best;
}

function matchParameterBySamples(samples) {
  for (const sample of samples) {
    if (sample === null || sample === undefined) continue;
    const asString = String(sample).toLowerCase();
    const bpMatch = asString.match(/(\d{2,3})\s*[\/\-]\s*(\d{2,3})/);
    if (bpMatch) {
      return { paramKey: "bloodPressureCombined", score: 5 };
    }
  }
  return null;
}

function deriveTimestamp(row, descriptors) {
  for (const descriptor of descriptors) {
    if (descriptor.role === "datetime") {
      const value = parseDateValue(row[descriptor.index]);
      if (value) return value;
    }
  }

  let datePart = null;
  for (const descriptor of descriptors) {
    if (descriptor.role === "date") {
      const value = parseDateValue(row[descriptor.index]);
      if (value) {
        datePart = value;
        break;
      }
    }
  }

  let timePart = null;
  for (const descriptor of descriptors) {
    if (descriptor.role === "time") {
      const value = parseTimeValue(row[descriptor.index]);
      if (value) {
        timePart = value;
        break;
      }
    }
  }

  if (!datePart && !timePart) return null;
  return combineDateAndTime(datePart, timePart);
}

function extractRowValues(row, descriptors) {
  const values = {};

  descriptors.forEach(descriptor => {
    if (!descriptor.matcher) return;
    const rawValue = row[descriptor.index];
    if (rawValue === null || rawValue === undefined || rawValue === "") return;

    switch (descriptor.matcher.paramKey) {
      case "bloodPressureCombined": {
        const bp = parseBloodPressureCompound(rawValue);
        if (bp) {
          values.systolic = bp.systolic;
          values.diastolic = bp.diastolic;
        }
        break;
      }
      case "bloodPressureSys": {
        const num = parseNumber(rawValue);
        if (num !== null) values.systolic = num;
        break;
      }
      case "bloodPressureDia": {
        const num = parseNumber(rawValue);
        if (num !== null) values.diastolic = num;
        break;
      }
      default: {
        const num = parseNumber(rawValue);
        if (num !== null) {
          values[descriptor.matcher.paramKey] = num;
        }
        break;
      }
    }
  });

  return values;
}

function applyRowValues(aggregation, rowValues, timestamp, meta) {
  const ts = timestamp ? new Date(timestamp) : null;
  const isoTimestamp = ts && !Number.isNaN(ts.valueOf()) ? ts.toISOString() : null;
  const order = ++aggregation.sampleSequence;

  if (rowValues.systolic || rowValues.diastolic) {
    addBloodPressureSample(aggregation.metrics, rowValues, isoTimestamp, order, meta);
  }

  Object.entries(rowValues).forEach(([key, value]) => {
    if (key === "systolic" || key === "diastolic") return;
    addNumericSample(aggregation.metrics, key, value, isoTimestamp, order, meta);
  });
}

function updateRawCollections(aggregation, descriptors, row) {
  descriptors.forEach(descriptor => {
    if (!descriptor.matcher) return;
    const label = descriptor.header || `Kolumn ${descriptor.index + 1}`;
    aggregation.rawLabelSet.add(label);
    const cellValue = row[descriptor.index];
    if (cellValue === null || cellValue === undefined || cellValue === "") return;

    const numeric = parseNumber(cellValue);
    if (numeric !== null) {
      aggregation.dynamicData[label] = numeric;
    } else if (typeof cellValue === "string") {
      const trimmed = cellValue.trim();
      if (trimmed) {
        aggregation.dynamicData[label] = trimmed;
      }
    }
  });
}

function addNumericSample(metrics, key, value, timestamp, order, meta) {
  const def = PARAMETER_META[key];
  if (!def) return;
  if (typeof value !== "number" || Number.isNaN(value)) return;
  if (def.min !== undefined && value < def.min) return;
  if (def.max !== undefined && value > def.max) return;

  if (def.timeline && timestamp) {
    metrics.trends[key] = metrics.trends[key] || [];
    metrics.trends[key].push({ value, timestamp, sheet: meta?.sheetName });
  }

  const current = metrics.latest[key];
  if (shouldReplaceLatest(current, timestamp, order)) {
    metrics.latest[key] = {
      value,
      timestamp,
      unit: def.unit,
      order
    };
  }
}

function addBloodPressureSample(metrics, rowValues, timestamp, order, meta) {
  const systolic = rowValues.systolic;
  const diastolic = rowValues.diastolic;

  if (systolic !== undefined && (systolic < 40 || systolic > 300)) return;
  if (diastolic !== undefined && (diastolic < 20 || diastolic > 200)) return;

  if (systolic === undefined && diastolic === undefined) return;

  if (timestamp && systolic !== undefined && diastolic !== undefined) {
    metrics.trends.bloodPressure.push({
      systolic,
      diastolic,
      timestamp,
      sheet: meta?.sheetName
    });
  }

  const current = metrics.latest.bloodPressure;
  if (shouldReplaceLatest(current, timestamp, order)) {
    metrics.latest.bloodPressure = {
      systolic: systolic ?? current?.systolic ?? null,
      diastolic: diastolic ?? current?.diastolic ?? null,
      unit: "mmHg",
      timestamp,
      order
    };
  }
}

function shouldReplaceLatest(current, timestamp, order) {
  if (!current) return true;
  if (timestamp && current.timestamp) {
    return new Date(timestamp) >= new Date(current.timestamp);
  }
  if (timestamp && !current.timestamp) return true;
  if (!timestamp && current.timestamp) return false;
  return (order || 0) >= (current.order || 0);
}

function finalizeTrends(metrics) {
  Object.entries(metrics.trends).forEach(([key, entries]) => {
    if (!Array.isArray(entries) || entries.length === 0) return;
    entries.sort((a, b) => {
      if (!a.timestamp || !b.timestamp) return 0;
      return new Date(a.timestamp) - new Date(b.timestamp);
    });
  });
}

function buildHeartData(metrics) {
  const formatTimeline = (entries, unitSuffix = "") =>
    (entries || []).map(entry => ({
      time: entry.timestamp ? new Date(entry.timestamp).toLocaleString("sv-SE") : "",
      value: entry.value,
      unit: unitSuffix.trim()
    }));

  return {
    heartRate: metrics.latest.heartRate?.value ?? null,
    systolicBP: metrics.latest.bloodPressure?.systolic ?? null,
    diastolicBP: metrics.latest.bloodPressure?.diastolic ?? null,
    cholesterolLDL: metrics.latest.ldl?.value ?? null,
    heartRateOverTime: formatTimeline(metrics.trends.heartRate, "bpm"),
    bloodPressureData: metrics.trends.bloodPressure,
    ecgData: [],
    hrvData: []
  };
}

function parseNumber(value) {
  if (typeof value === "number") {
    if (Number.isNaN(value)) return null;
    return value;
  }
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const normalized = trimmed.replace(/,/g, ".").replace(/\s+/g, "");
    const number = Number(normalized);
    if (!Number.isNaN(number)) return number;
  }
  return null;
}

function parseBloodPressureCompound(value) {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/\s+/g, "");
  const match = normalized.match(/(\d{2,3})[\/\-](\d{2,3})/);
  if (!match) return null;
  return {
    systolic: parseInt(match[1], 10),
    diastolic: parseInt(match[2], 10)
  };
}

function parseDateValue(value) {
  if (value instanceof Date) {
    if (Number.isNaN(value.valueOf())) return null;
    return value;
  }
  if (typeof value === "number") {
    const parsed = XLSX.SSF.parse_date_code(value);
    if (!parsed) return null;
    return new Date(Date.UTC(parsed.y, parsed.m - 1, parsed.d, parsed.H, parsed.M, parsed.S));
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const normalized = trimmed.replace(/\./g, "-").replace(/\//g, "-");
    const parsed = new Date(normalized);
    if (!Number.isNaN(parsed.valueOf())) return parsed;

    const match = trimmed.match(/^(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{2,4})$/);
    if (match) {
      const [, d, m, y] = match;
      const year = y.length === 2 ? `20${y}` : y;
      const iso = `${year}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
      const parsedIso = new Date(iso);
      if (!Number.isNaN(parsedIso.valueOf())) return parsedIso;
    }
  }
  return null;
}

function parseTimeValue(value) {
  if (value instanceof Date) {
    if (Number.isNaN(value.valueOf())) return null;
    return value;
  }
  if (typeof value === "number") {
    const totalSeconds = Math.round(value * 24 * 60 * 60);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    return new Date(Date.UTC(1970, 0, 1, hours, minutes, seconds));
  }
  if (typeof value === "string") {
    const match = value.trim().match(/^(\d{1,2})[:.](\d{2})(?:[:.](\d{2}))?$/);
    if (match) {
      const hours = parseInt(match[1], 10);
      const minutes = parseInt(match[2], 10);
      const seconds = match[3] ? parseInt(match[3], 10) : 0;
      if (hours < 24 && minutes < 60 && seconds < 60) {
        return new Date(Date.UTC(1970, 0, 1, hours, minutes, seconds));
      }
    }
  }
  return null;
}

function combineDateAndTime(datePart, timePart) {
  if (!datePart && !timePart) return null;
  const base = datePart ? new Date(datePart) : new Date();
  if (timePart) {
    base.setHours(timePart.getHours(), timePart.getMinutes(), timePart.getSeconds(), 0);
  }
  return base;
}

function normalizeText(value) {
  if (!value) return "";
  return value
    .toString()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

function createFallbackExcelContent(excelFile) {
  return {
    filename: excelFile.name,
    uploadedAt: new Date(excelFile.uploadedAt || Date.now()).toISOString(),
    sheetNames: [],
    metrics: createEmptyMetrics(),
    rawData: [],
    dynamicData: {},
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
    error: "Excel file could not be parsed automatically",
    parsedAt: new Date().toISOString()
  };
}

(async () => {
  try {
    const buffer = await fs.promises.readFile(filePath);
    const workbook = XLSX.read(buffer, { type: "buffer" });
    const parsed = parseWorkbook(meta || {}, workbook);
    parentPort.postMessage({ success: true, data: parsed });
  } catch (err) {
    console.error("Excel parser worker error:", err);
    const fallback = createFallbackExcelContent(meta || {});
    parentPort.postMessage({ success: true, data: fallback });
  }
})();

