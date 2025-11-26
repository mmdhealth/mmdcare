// Local API endpoint for Excel content parsing
import { loadTransferFromBlob } from './blobStore.js';
import { head } from '@vercel/blob';
import * as XLSX from 'xlsx';
import { Buffer } from 'buffer';

export default async function handler(req, res) {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method === 'GET') {
    const { transferId, filename } = req.query;
    
    console.log('=== EXCEL CONTENT GET REQUEST ===');
    console.log('Transfer ID:', transferId);
    console.log('Filename:', filename);
    console.log('Request URL:', req.url);
    console.log('Request headers:', req.headers);
    
    if (!transferId || !filename) {
      return res.status(400).json({ error: 'Missing transferId or filename' });
    }

    try {
      // Get transfer data from Blob storage
      const transfer = await loadTransferFromBlob(transferId);
      if (!transfer) {
        return res.status(404).json({ error: 'Transfer not found' });
      }

      // Find the Excel file in the transfer
      const excelFile = transfer.files.find(file => 
        file.name === filename && 
        (file.mimetype === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' || 
         file.mimetype === 'application/vnd.ms-excel' ||
         file.name.toLowerCase().endsWith('.xlsx') ||
         file.name.toLowerCase().endsWith('.xls'))
      );

      if (!excelFile) {
        return res.status(404).json({ error: 'Excel file not found in transfer' });
      }

      const excelBlobKey = `files/${transferId}/${filename}`;
      console.log('=== RETRIEVING EXCEL FROM BLOB ===');
      console.log('Looking for Excel file at key:', excelBlobKey);
      console.log('Transfer ID:', transferId);
      console.log('Filename:', filename);
      
      let downloadUrl = excelFile.url;
      if (!downloadUrl) {
        try {
          console.log('Trying to get Excel blob using head()...');
          const headResult = await head(excelBlobKey);
          console.log('Head result:', headResult);
          
          if (headResult && headResult.url) {
            console.log('Got blob URL from head():', headResult.url);
            downloadUrl = headResult.url;
          } else {
            throw new Error('No URL returned from head()');
          }
        } catch (error) {
          console.error('Error getting Excel blob:', error);
          console.error('Error details:', error.message);
          
          const fileExists = transfer.files.some(f => f.name === filename);
          console.log('File exists in transfer metadata:', fileExists);
          
          return res.status(404).json({ 
            error: 'Excel file not found in storage', 
            key: excelBlobKey, 
            details: error.message,
            fileExistsInMetadata: fileExists
          });
        }
      } else {
        console.log('Using cached blob URL from metadata for Excel file.');
      }
      
      if (!downloadUrl) {
        console.log('Excel download URL missing');
        return res.status(404).json({ error: 'Excel file not found in storage' });
      }

      // Download the Excel content
      console.log('Downloading Excel content from URL:', downloadUrl);
      const excelResponse = await fetch(downloadUrl);
      
      if (!excelResponse.ok) {
        console.error('Failed to download Excel, status:', excelResponse.status);
        return res.status(500).json({ error: 'Failed to download Excel file' });
      }
      
      const excelBuffer = await excelResponse.arrayBuffer();
      console.log('Excel buffer size:', excelBuffer.byteLength);
      
      // Parse the Excel content
      console.log('Parsing Excel content...');
      let workbook;
      let structuredContent;
      try {
        workbook = XLSX.read(Buffer.from(excelBuffer), { type: 'buffer' });
        console.log('Excel parsed successfully');
        console.log('Sheet names:', workbook.SheetNames);
        
        structuredContent = await parseExcelContent(excelFile, workbook);
      } catch (parseError) {
        console.error('Excel parsing failed:', parseError);
        console.log('Creating fallback content due to parsing error');
        const fallbackContent = createFallbackContent(excelFile);
        return res.status(200).json(fallbackContent);
      }
      
      res.status(200).json(structuredContent);
    } catch (error) {
      console.error('Error processing Excel content:', error);
      console.error('Error stack:', error.stack);
      res.status(500).json({ error: 'Failed to process Excel content', details: error.message });
    }
  } else {
    res.status(405).json({ error: 'Method not allowed' });
  }
}

async function parseExcelContent(excelFile, workbook) {
  const filename = excelFile.name;
  const uploadedAt = new Date(excelFile.uploadedAt);
  
  // Get the first sheet
  const firstSheetName = workbook.SheetNames[0];
  const worksheet = workbook.Sheets[firstSheetName];
  
  // Convert to JSON for easier parsing
  const jsonData = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: '' });
  
  console.log('=== EXCEL PARSING DEBUG ===');
  console.log('Excel data rows:', jsonData.length);
  console.log('First few rows:', JSON.stringify(jsonData.slice(0, 10), null, 2));
  console.log('All sheet names:', workbook.SheetNames);
  console.log('Using sheet:', firstSheetName);
  
  // Log the structure to understand how data is organized
  console.log('=== EXCEL STRUCTURE ANALYSIS ===');
  for (let i = 0; i < Math.min(5, jsonData.length); i++) {
    const row = jsonData[i];
    console.log(`Row ${i}:`, JSON.stringify(row, null, 2));
  }
  
  // Extract heart-related data
  const heartData = extractHeartData(jsonData);
  
  // Create dynamic data mapping from rawData
  const dynamicData = {};
  
  // Filter out unwanted data points
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
    
    // Skip empty items
    if (trimmed === '') return false;
    
    // Skip unwanted patterns
    for (const pattern of unwantedPatterns) {
      if (trimmed.includes(pattern)) return false;
    }
    
    // Skip items that are just numbers or symbols
    if (/^[\d\s\.,\-<>≤≥]+$/.test(trimmed)) return false;
    
    // Skip items that are too short (likely not meaningful)
    if (trimmed.length < 3) return false;
    
    return true;
  });
  
  // Try to find values for each rawData item
  rawDataItems.forEach(item => {
    console.log(`Looking for value for: ${item}`);
    
    let foundValues = [];
    
    // Look through all rows to find this item and its values
    for (let i = 0; i < jsonData.length; i++) {
      const row = jsonData[i];
      if (!row || row.length === 0) continue;
      
      for (let j = 0; j < row.length; j++) {
        const cell = String(row[j]).trim();
        if (cell === item) {
          // Found the item, look for values in the column below
          console.log(`Found ${item} at row ${i}, col ${j}`);
          
          // Look in the same column for values in subsequent rows
          for (let k = i + 1; k < jsonData.length; k++) {
            const valueRow = jsonData[k];
            if (valueRow && j < valueRow.length) {
              const cellValue = valueRow[j];
              const numValue = parseFloat(cellValue);
              
              if (!isNaN(numValue) && numValue > 0) {
                foundValues.push({
                  value: numValue,
                  row: k,
                  col: j
                });
                console.log(`Found value ${numValue} for ${item} at row ${k}, col ${j}`);
              }
            }
          }
          
          // Also try next column (horizontal structure)
          if (j + 1 < row.length) {
            const nextColValue = parseFloat(row[j + 1]);
            if (!isNaN(nextColValue) && nextColValue > 0) {
              foundValues.push({
                value: nextColValue,
                row: i,
                col: j + 1
              });
              console.log(`Found value ${nextColValue} for ${item} at row ${i}, col ${j + 1}`);
            }
          }
        }
      }
    }
    
    // Use the latest value (highest row number) and avoid duplicates
    if (foundValues.length > 0) {
      const latestValue = foundValues.sort((a, b) => b.row - a.row)[0];
      
      // Only add if we don't already have this exact value
      const existingValues = Object.values(dynamicData);
      if (!existingValues.includes(latestValue.value)) {
        dynamicData[item] = latestValue.value;
        console.log(`✓ Using latest value for ${item}: ${latestValue.value} (from row ${latestValue.row})`);
      } else {
        console.log(`⚠️ Skipping duplicate value for ${item}: ${latestValue.value}`);
      }
    } else {
      console.log(`❌ No values found for ${item}`);
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

function extractHeartData(jsonData) {
  console.log('=== EXTRACTING HEART DATA ===');
  console.log('Total rows to process:', jsonData.length);
  console.log('Sample data:', JSON.stringify(jsonData.slice(0, 10), null, 2));
  
  // Initialize heart data structure
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
  
  // Enhanced patterns to match actual medical test names from Excel files
  const patterns = {
    heartRate: /(?:hjärtfrekvens|heart[\s-]*rate|puls|pulse|hr\b|resting[\s-]*hr|heart[\s-]*beat|hjärtfrekvens|hjärtfrekvens)/i,
    systolic: /(?:systolisk|systolic|sys\b|övre[\s-]*blodtryck|upper[\s-]*bp|systolisk[\s-]*blodtryck|systolisk[\s-]*blodtryck)/i,
    diastolic: /(?:diastolisk|diastolic|dia\b|nedre[\s-]*blodtryck|lower[\s-]*bp|diastolisk[\s-]*blodtryck|diastolisk[\s-]*blodtryck)/i,
    cholesterol: /(?:kolesterol|cholesterol|ldl[\s-]*cholesterol|ldl\b|kolesterol[\s-]*ldl|ldl[\s-]*kolesterol|ldl[\s-]*cholesterol|ldl[\s-]*kolesterol|ldl[\s-]*cholesterol)/i,
    bloodPressure: /(?:blodtryck|blood[\s-]*pressure|bp\b)/i,
    ecg: /(?:ekg|ecg|elektrokardiogram|electrocardiogram)/i,
    hrv: /(?:hrv|hjärtfrekvensvariabilitet|heart[\s-]*rate[\s-]*variability)/i
  };
  
  // Additional patterns for medical test names that might be in the Excel file
  const medicalPatterns = {
    cholesterol: /(?:ldl[\s-]*kolesterol|ldl[\s-]*cholesterol|kolesterol[\s-]*ldl|cholesterol[\s-]*ldl|ldl\b|kolesterol\b|cholesterol\b|ldl[\s-]*kolesterol|ldl[\s-]*cholesterol)/i,
    heartRate: /(?:hjärtfrekvens|heart[\s-]*rate|puls|pulse|hr\b)/i,
    systolic: /(?:systolisk|systolic|sys\b|övre[\s-]*blodtryck|upper[\s-]*bp)/i,
    diastolic: /(?:diastolisk|diastolic|dia\b|nedre[\s-]*blodtryck|lower[\s-]*bp)/i
  };
  
  // Look for specific medical test names that might be in the Excel file
  const specificMedicalTests = {
    cholesterol: /(?:ldl[\s-]*kolesterol|ldl[\s-]*cholesterol|kolesterol[\s-]*ldl|cholesterol[\s-]*ldl|ldl\b|kolesterol\b|cholesterol\b)/i,
    heartRate: /(?:hjärtfrekvens|heart[\s-]*rate|puls|pulse|hr\b)/i,
    systolic: /(?:systolisk|systolic|sys\b|övre[\s-]*blodtryck|upper[\s-]*bp)/i,
    diastolic: /(?:diastolisk|diastolic|dia\b|nedre[\s-]*blodtryck|lower[\s-]*bp)/i
  };
  
  console.log('Patterns being used:', patterns);
  
  // Helper function to find value near a label
  const findValueNearLabel = (row, colIndex, nextRow) => {
    // Try next cell (same row)
    if (colIndex + 1 < row.length) {
      const val = parseFloat(row[colIndex + 1]);
      if (!isNaN(val)) return val;
    }
    // Try cell below (next row, same column)
    if (nextRow && colIndex < nextRow.length) {
      const val = parseFloat(nextRow[colIndex]);
      if (!isNaN(val)) return val;
    }
    // Try cell below and to the right
    if (nextRow && colIndex + 1 < nextRow.length) {
      const val = parseFloat(nextRow[colIndex + 1]);
      if (!isNaN(val)) return val;
    }
    return null;
  };
  
  // Search through all rows and cells with more flexible matching
  for (let i = 0; i < jsonData.length; i++) {
    const row = jsonData[i];
    const nextRow = i + 1 < jsonData.length ? jsonData[i + 1] : null;
    
    // Skip empty rows
    if (!row || row.length === 0) continue;
    
    for (let j = 0; j < row.length; j++) {
      const cell = String(row[j]).trim();
      
      if (!cell) continue;
      
      // Log every cell to see what we're working with
      if (i < 5) { // Only log first 5 rows to avoid spam
        console.log(`Cell [${i},${j}]: "${cell}" (type: ${typeof cell})`);
      }
      
      // Check for heart rate
      if ((patterns.heartRate.test(cell) || medicalPatterns.heartRate.test(cell)) && !heartData.heartRate) {
        const value = findValueNearLabel(row, j, nextRow);
        console.log(`Found heart rate pattern in cell "${cell}", value found: ${value}`);
        if (value !== null && value > 0 && value < 300) {
          heartData.heartRate = Math.round(value);
          console.log('✓ Heart rate set to:', heartData.heartRate);
        }
      }
      
      // Check for systolic blood pressure
      if ((patterns.systolic.test(cell) || medicalPatterns.systolic.test(cell)) && !heartData.systolicBP) {
        const value = findValueNearLabel(row, j, nextRow);
        console.log(`Found systolic pattern in cell "${cell}", value found: ${value}`);
        if (value !== null && value > 0 && value < 300) {
          heartData.systolicBP = Math.round(value);
          console.log('✓ Systolic BP set to:', heartData.systolicBP);
        }
      }
      
      // Check for diastolic blood pressure
      if ((patterns.diastolic.test(cell) || medicalPatterns.diastolic.test(cell)) && !heartData.diastolicBP) {
        const value = findValueNearLabel(row, j, nextRow);
        console.log(`Found diastolic pattern in cell "${cell}", value found: ${value}`);
        if (value !== null && value > 0 && value < 200) {
          heartData.diastolicBP = Math.round(value);
          console.log('✓ Diastolic BP set to:', heartData.diastolicBP);
        }
      }
      
      // Check for cholesterol (LDL) - try both pattern sets
      if ((patterns.cholesterol.test(cell) || medicalPatterns.cholesterol.test(cell)) && !heartData.cholesterolLDL) {
        const value = findValueNearLabel(row, j, nextRow);
        console.log(`Found cholesterol pattern in cell "${cell}", value found: ${value}`);
        if (value !== null && value > 0 && value < 20) {
          heartData.cholesterolLDL = value.toFixed(1);
          console.log('✓ Cholesterol LDL set to:', heartData.cholesterolLDL);
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
          console.log(`✓ Found BP in format: ${sys}/${dia}`);
        }
      }
      
      // Check for time series data (e.g., heart rate over time)
      if (cell.match(/^\d{1,2}:\d{2}$/)) {
        // Found a time value, check next cell for numeric value
        if (j + 1 < row.length) {
          const value = parseFloat(row[j + 1]);
          if (!isNaN(value) && value > 0) {
            heartData.heartRateOverTime.push({ time: cell, value: Math.round(value) });
          }
        }
      }
    }
  }
  
  // Look for time series patterns in consecutive rows
  extractTimeSeriesData(jsonData, heartData);
  
  // NEW APPROACH: Look for the actual data structure
  console.log('=== SEARCHING FOR MEDICAL TEST NAMES AND VALUES ===');
  
  // First, let's understand the data structure better
  console.log('Looking for data structure patterns...');
  
  // Look for rows that might contain test names and values
  for (let i = 0; i < jsonData.length; i++) {
    const row = jsonData[i];
    if (!row || row.length === 0) continue;
    
    console.log(`Analyzing row ${i}:`, row);
    
    // Look for LDL cholesterol in medical test names
    for (let j = 0; j < row.length; j++) {
      const cell = String(row[j]).trim();
      if (!cell) continue;
      
      if (cell.includes('LDL') && cell.includes('kolesterol') && !heartData.cholesterolLDL) {
        console.log(`Found LDL cholesterol test: "${cell}" in row ${i}, col ${j}`);
        console.log(`Full row:`, row);
        
        // Try different approaches to find the value
        let value = null;
        
        // Approach 1: Look in the same row, next column
        if (j + 1 < row.length) {
          value = parseFloat(row[j + 1]);
          console.log(`Trying next column (${j + 1}): ${row[j + 1]} -> ${value}`);
        }
        
        // Approach 2: Look in the same row, previous column
        if ((value === null || isNaN(value)) && j > 0) {
          value = parseFloat(row[j - 1]);
          console.log(`Trying previous column (${j - 1}): ${row[j - 1]} -> ${value}`);
        }
        
        // Approach 3: Look in the next row, same column
        if ((value === null || isNaN(value)) && i + 1 < jsonData.length) {
          const nextRow = jsonData[i + 1];
          if (nextRow && j < nextRow.length) {
            value = parseFloat(nextRow[j]);
            console.log(`Trying next row, same column: ${nextRow[j]} -> ${value}`);
          }
        }
        
        // Approach 4: Look in the next row, next column
        if ((value === null || isNaN(value)) && i + 1 < jsonData.length) {
          const nextRow = jsonData[i + 1];
          if (nextRow && j + 1 < nextRow.length) {
            value = parseFloat(nextRow[j + 1]);
            console.log(`Trying next row, next column: ${nextRow[j + 1]} -> ${value}`);
          }
        }
        
        if (value !== null && !isNaN(value) && value > 0 && value < 20) {
          heartData.cholesterolLDL = value.toFixed(1);
          console.log('✓ Cholesterol LDL set to:', heartData.cholesterolLDL);
        } else {
          console.log('❌ Could not find valid cholesterol value');
        }
      }
      
      // Look for heart rate in medical test names
      if ((cell.includes('hjärtfrekvens') || cell.includes('heart rate') || cell.includes('puls')) && !heartData.heartRate) {
        console.log(`Found heart rate test: "${cell}" in row ${i}, col ${j}`);
        console.log(`Full row:`, row);
        
        let value = null;
        
        // Try different approaches to find the value
        if (j + 1 < row.length) {
          value = parseFloat(row[j + 1]);
          console.log(`Trying next column: ${row[j + 1]} -> ${value}`);
        }
        
        if ((value === null || isNaN(value)) && j > 0) {
          value = parseFloat(row[j - 1]);
          console.log(`Trying previous column: ${row[j - 1]} -> ${value}`);
        }
        
        if ((value === null || isNaN(value)) && i + 1 < jsonData.length) {
          const nextRow = jsonData[i + 1];
          if (nextRow && j < nextRow.length) {
            value = parseFloat(nextRow[j]);
            console.log(`Trying next row: ${nextRow[j]} -> ${value}`);
          }
        }
        
        if (value !== null && !isNaN(value) && value > 0 && value < 300) {
          heartData.heartRate = Math.round(value);
          console.log('✓ Heart rate set to:', heartData.heartRate);
        } else {
          console.log('❌ Could not find valid heart rate value');
        }
      }
      
      // Look for blood pressure in medical test names
      if ((cell.includes('blodtryck') || cell.includes('blood pressure')) && (!heartData.systolicBP || !heartData.diastolicBP)) {
        console.log(`Found blood pressure test: "${cell}" in row ${i}, col ${j}`);
        console.log(`Full row:`, row);
        
        let value = null;
        
        // Try different approaches to find the value
        if (j + 1 < row.length) {
          value = parseFloat(row[j + 1]);
          console.log(`Trying next column: ${row[j + 1]} -> ${value}`);
        }
        
        if ((value === null || isNaN(value)) && j > 0) {
          value = parseFloat(row[j - 1]);
          console.log(`Trying previous column: ${row[j - 1]} -> ${value}`);
        }
        
        if ((value === null || isNaN(value)) && i + 1 < jsonData.length) {
          const nextRow = jsonData[i + 1];
          if (nextRow && j < nextRow.length) {
            value = parseFloat(nextRow[j]);
            console.log(`Trying next row: ${nextRow[j]} -> ${value}`);
          }
        }
        
        if (value !== null && !isNaN(value) && value > 0) {
          // Try to parse as systolic/diastolic if it's in format like "120/80"
          const bpMatch = String(value).match(/(\d{2,3})\s*[\/\-]\s*(\d{2,3})/);
          if (bpMatch) {
            const sys = parseInt(bpMatch[1]);
            const dia = parseInt(bpMatch[2]);
            if (sys > 60 && sys < 300 && dia > 40 && dia < 200) {
              if (!heartData.systolicBP) heartData.systolicBP = sys;
              if (!heartData.diastolicBP) heartData.diastolicBP = dia;
              console.log(`✓ BP set to: ${sys}/${dia}`);
            }
          } else if (value > 60 && value < 300) {
            // Assume it's systolic if no diastolic found
            if (!heartData.systolicBP) {
              heartData.systolicBP = Math.round(value);
              console.log('✓ Systolic BP set to:', heartData.systolicBP);
            }
          }
        } else {
          console.log('❌ Could not find valid blood pressure value');
        }
      }
    }
  }
  
  // NEW: If we still haven't found values, try a different approach
  // Look for the actual data rows (not just headers)
  console.log('=== TRYING ALTERNATIVE DATA EXTRACTION ===');
  
  // Look for rows that contain actual data (not just test names)
  for (let i = 1; i < jsonData.length; i++) { // Start from row 1 (skip header)
    const row = jsonData[i];
    if (!row || row.length === 0) continue;
    
    console.log(`Checking data row ${i}:`, row);
    
    // Look for numerical values that might be our health metrics
    for (let j = 0; j < row.length; j++) {
      const cell = String(row[j]).trim();
      if (!cell) continue;
      
      // Try to parse as a number
      const numValue = parseFloat(cell);
      if (!isNaN(numValue) && numValue > 0) {
        console.log(`Found numerical value: ${numValue} in row ${i}, col ${j}`);
        
        // Check if this might be a health metric based on value ranges
        if (numValue >= 50 && numValue <= 300 && !heartData.heartRate) {
          // Could be heart rate
          heartData.heartRate = Math.round(numValue);
          console.log('✓ Heart rate set to:', heartData.heartRate);
        } else if (numValue >= 60 && numValue <= 200 && !heartData.systolicBP) {
          // Could be systolic blood pressure
          heartData.systolicBP = Math.round(numValue);
          console.log('✓ Systolic BP set to:', heartData.systolicBP);
        } else if (numValue >= 40 && numValue <= 120 && !heartData.diastolicBP) {
          // Could be diastolic blood pressure
          heartData.diastolicBP = Math.round(numValue);
          console.log('✓ Diastolic BP set to:', heartData.diastolicBP);
        } else if (numValue >= 1 && numValue <= 15 && !heartData.cholesterolLDL) {
          // Could be cholesterol LDL
          heartData.cholesterolLDL = numValue.toFixed(1);
          console.log('✓ Cholesterol LDL set to:', heartData.cholesterolLDL);
        }
      }
    }
  }
  
  // Summary of extracted data
  console.log('=== EXTRACTION COMPLETE ===');
  console.log('Heart Rate:', heartData.heartRate || 'NOT FOUND');
  console.log('Systolic BP:', heartData.systolicBP || 'NOT FOUND');
  console.log('Diastolic BP:', heartData.diastolicBP || 'NOT FOUND');
  console.log('Cholesterol LDL:', heartData.cholesterolLDL || 'NOT FOUND');
  console.log('Time series data points:', heartData.heartRateOverTime.length);
  
  return heartData;
}

function extractTimeSeriesData(jsonData, heartData) {
  // Look for patterns like:
  // Time | Value
  // 00:00 | 65
  // 04:00 | 72
  
  for (let i = 0; i < jsonData.length - 1; i++) {
    const row = jsonData[i];
    
    // Check if this row might be a header
    if (row && row.length >= 2) {
      const header1 = String(row[0]).toLowerCase();
      const header2 = String(row[1]).toLowerCase();
      
      // Check if headers suggest time series data
      if ((header1.includes('tid') || header1.includes('time')) && 
          (header2.includes('värde') || header2.includes('value') || header2.includes('bpm'))) {
        
        // Parse the following rows
        for (let j = i + 1; j < Math.min(i + 20, jsonData.length); j++) {
          const dataRow = jsonData[j];
          if (dataRow && dataRow.length >= 2) {
            const time = String(dataRow[0]).trim();
            const value = parseFloat(dataRow[1]);
            
            if (time && !isNaN(value) && value > 0) {
              heartData.heartRateOverTime.push({ time, value: Math.round(value) });
            }
          }
        }
        break;
      }
    }
  }
}

function createFallbackContent(excelFile) {
  const filename = excelFile.name;
  const uploadedAt = new Date(excelFile.uploadedAt);
  
  return {
    filename: filename,
    uploadedAt: uploadedAt.toISOString(),
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

