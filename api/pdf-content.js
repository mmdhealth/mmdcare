// Local API endpoint for PDF content parsing
import { loadTransferFromBlob } from './blobStore.js';
import { head } from '@vercel/blob';
import pdf from 'pdf-parse';
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
    
    console.log('=== PDF CONTENT GET REQUEST ===');
    console.log('Transfer ID:', transferId);
    console.log('Filename:', filename);
    
    if (!transferId || !filename) {
      return res.status(400).json({ error: 'Missing transferId or filename' });
    }

    try {
      // Get transfer data from Blob storage
      const transfer = await loadTransferFromBlob(transferId);
      if (!transfer) {
        return res.status(404).json({ error: 'Transfer not found' });
      }

      // Find the PDF file in the transfer
      const pdfFile = transfer.files.find(file => 
        file.name === filename && 
        (file.mimetype === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf'))
      );

      if (!pdfFile) {
        return res.status(404).json({ error: 'PDF file not found in transfer' });
      }

      // Get the actual PDF file from Blob storage
      const pdfBlobKey = `files/${transferId}/${filename}`;
      console.log('=== RETRIEVING PDF FROM BLOB ===');
      console.log('Looking for PDF file at key:', pdfBlobKey);
      console.log('Transfer ID:', transferId);
      console.log('Filename:', filename);
      
      let pdfBlob;
      try {
        // Try using head() first to get the URL, then fetch directly
        console.log('Trying to get PDF blob using head()...');
        const headResult = await head(pdfBlobKey);
        console.log('Head result:', headResult);
        
        if (headResult && headResult.url) {
          console.log('Got blob URL from head():', headResult.url);
          pdfBlob = {
            url: headResult.url,
            size: headResult.size
          };
        } else {
          throw new Error('No URL returned from head()');
        }
      } catch (error) {
        console.error('Error getting PDF blob:', error);
        console.error('Error details:', error.message);
        
        // Try alternative approach - check if file exists in transfer metadata
        console.log('Checking if file exists in transfer metadata...');
        const fileExists = transfer.files.some(f => f.name === filename);
        console.log('File exists in transfer metadata:', fileExists);
        
        return res.status(404).json({ 
          error: 'PDF file not found in storage', 
          key: pdfBlobKey, 
          details: error.message,
          fileExistsInMetadata: fileExists
        });
      }
      
      if (!pdfBlob) {
        console.log('PDF blob is null/undefined');
        return res.status(404).json({ error: 'PDF file not found in storage' });
      }

      // Download the PDF content
      console.log('Downloading PDF content from URL:', pdfBlob.url);
      const pdfResponse = await fetch(pdfBlob.url);
      
      if (!pdfResponse.ok) {
        console.error('Failed to download PDF, status:', pdfResponse.status);
        return res.status(500).json({ error: 'Failed to download PDF file' });
      }
      
      const pdfBuffer = await pdfResponse.arrayBuffer();
      console.log('PDF buffer size:', pdfBuffer.byteLength);
      
      // Parse the PDF content
      console.log('Parsing PDF content...');
      let pdfData;
      try {
        pdfData = await pdf(Buffer.from(pdfBuffer));
        console.log('PDF parsed successfully, text length:', pdfData.text.length);
        console.log('PDF text preview:', pdfData.text.substring(0, 200));
      } catch (parseError) {
        console.error('PDF parsing failed:', parseError);
        console.log('Creating fallback content due to parsing error');
        const fallbackContent = createFallbackContent(pdfFile);
        return res.status(200).json(fallbackContent);
      }
      
      if (!pdfData.text || pdfData.text.trim().length === 0) {
        console.log('PDF text is empty, creating fallback content');
        const fallbackContent = createFallbackContent(pdfFile);
        return res.status(200).json(fallbackContent);
      }
      
      const structuredContent = await parsePDFContent(pdfFile, pdfData.text);
      
      res.status(200).json(structuredContent);
    } catch (error) {
      console.error('Error processing PDF content:', error);
      console.error('Error stack:', error.stack);
      res.status(500).json({ error: 'Failed to process PDF content', details: error.message });
    }
  } else {
    res.status(405).json({ error: 'Method not allowed' });
  }
}

async function parsePDFContent(pdfFile, pdfText) {
  const filename = pdfFile.name;
  const uploadedAt = new Date(pdfFile.uploadedAt);
  
  // Extract title from PDF content or filename
  const title = extractTitle(pdfText, filename);
  
  // Extract doctor name from PDF content
  const doctor = extractDoctor(pdfText);
  
  // Extract date from PDF content or use upload date
  const date = extractDate(pdfText) || uploadedAt.toLocaleDateString('sv-SE');
  
  // Generate summary from PDF content
  const summary = generateSummary(pdfText);
  
  // Parse content into sections
  const sections = parseIntoSections(pdfText);
  
  // Create structured content
  const content = {
    title: title,
    doctor: doctor,
    date: date,
    summary: summary,
    sections: sections
  };

  return {
    filename: filename,
    title: title,
    doctor: doctor,
    date: date,
    summary: summary,
    content: content,
    parsedAt: new Date().toISOString()
  };
}

function extractTitle(pdfText, filename) {
  // Clean the text first
  const cleanText = pdfText.replace(/\s+/g, ' ').trim();
  
  // Generate a medical title based on content
  const medicalTitle = generateMedicalTitle(cleanText);
  if (medicalTitle) {
    return medicalTitle;
  }
  
  // Look for common title patterns in the PDF
  const titlePatterns = [
    /(?:titel|title|rubrik|heading):\s*(.+?)(?:\n|$)/i,
    /(?:dokument|document|rapport|report):\s*(.+?)(?:\n|$)/i,
    /(?:undersökning|examination|analysis):\s*(.+?)(?:\n|$)/i,
    /(?:journal|anteckning|note):\s*(.+?)(?:\n|$)/i,
    /^([A-ZÅÄÖ][A-ZÅÄÖa-zåäö\s]{10,50}?)(?:\n|$)/m, // First line with proper case
    /^(.{10,100}?)(?:\n|$)/m // First line as fallback
  ];
  
  for (const pattern of titlePatterns) {
    const match = cleanText.match(pattern);
    if (match && match[1]) {
      const title = match[1].trim();
      if (title.length > 3 && title.length < 100 && !title.includes('http')) {
        return title;
      }
    }
  }
  
  // Fallback to filename
  return filename
    .replace(/\.pdf$/i, '')
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, l => l.toUpperCase());
}

function generateMedicalTitle(pdfText) {
  // Medical condition patterns for Swedish
  const conditionPatterns = [
    { pattern: /(?:öron|ear|hörsel|hearing)/i, title: 'Anteckning - Öronproblem' },
    { pattern: /(?:hjärta|heart|kardiologi|cardiology)/i, title: 'Anteckning - Hjärtproblem' },
    { pattern: /(?:lung|lungor|respiratorisk|respiratory)/i, title: 'Anteckning - Lungproblem' },
    { pattern: /(?:mage|stomach|gastro|gastrointestinal)/i, title: 'Anteckning - Magproblem' },
    { pattern: /(?:led|joint|artrit|arthritis)/i, title: 'Anteckning - Ledproblem' },
    { pattern: /(?:hud|skin|dermatologi|dermatology)/i, title: 'Anteckning - Hudproblem' },
    { pattern: /(?:ögon|eye|syn|vision)/i, title: 'Anteckning - Synproblem' },
    { pattern: /(?:neurologi|neurology|hjärna|brain)/i, title: 'Anteckning - Neurologiska problem' },
    { pattern: /(?:diabetes|blodsocker|sugar)/i, title: 'Anteckning - Diabetes' },
    { pattern: /(?:blodtryck|hypertension|pressure)/i, title: 'Anteckning - Blodtryck' },
    { pattern: /(?:allergi|allergy|reaktion)/i, title: 'Anteckning - Allergi' },
    { pattern: /(?:infektion|infection|bakterie|bacteria)/i, title: 'Anteckning - Infektion' },
    { pattern: /(?:smärta|pain|ont|sore)/i, title: 'Anteckning - Smärta' },
    { pattern: /(?:inflammation|inflammation|swelling)/i, title: 'Anteckning - Inflammation' },
    { pattern: /(?:kontroll|check|uppföljning|follow-up)/i, title: 'Anteckning - Kontrollbesök' },
    { pattern: /(?:nybesök|new visit|första gången)/i, title: 'Anteckning - Nybesök' }
  ];
  
  // Check for specific medical conditions
  for (const condition of conditionPatterns) {
    if (condition.pattern.test(pdfText)) {
      return condition.title;
    }
  }
  
  // Check for age and gender to create a more specific title
  const ageMatch = pdfText.match(/(\d+)-årig\s+(man|kvinna|person)/i);
  if (ageMatch) {
    const age = ageMatch[1];
    const gender = ageMatch[2];
    const genderText = gender === 'man' ? 'man' : gender === 'kvinna' ? 'kvinna' : 'patient';
    return `Anteckning - ${age}-årig ${genderText}`;
  }
  
  // Check for specific symptoms or problems
  const symptomPatterns = [
    { pattern: /(?:knäppningar|clicking|popping)/i, title: 'Anteckning - Öronknäppningar' },
    { pattern: /(?:hörselnedsättning|hearing loss|dålig hörsel)/i, title: 'Anteckning - Hörselnedsättning' },
    { pattern: /(?:lockkänsla|fullness|pressure)/i, title: 'Anteckning - Öronlockkänsla' },
    { pattern: /(?:bullerdipp|noise dip|frekvens)/i, title: 'Anteckning - Hörseltest' }
  ];
  
  for (const symptom of symptomPatterns) {
    if (symptom.pattern.test(pdfText)) {
      return symptom.title;
    }
  }
  
  return null; // No specific medical title found
}

function extractDoctor(pdfText) {
  // Look for doctor patterns - more comprehensive for Swedish medical documents
  const doctorPatterns = [
    // Pattern for "Antecknad av [Name] (Läkare)"
    /(?:antecknad|noted|signed)\s+av\s+([a-zA-ZåäöÅÄÖ\s]+?)\s*\([^)]*läkare[^)]*\)/i,
    // Pattern for "Dr. [Name]" or "Doktor [Name]"
    /(?:dr\.?|doctor|doktor|läkare|physician)\s+([a-zA-ZåäöÅÄÖ\s]+?)(?:\s|$|,|\.)/i,
    // Pattern for "Undersökande läkare: [Name]"
    /(?:undersökande|examining|attending)\s+(?:läkare|doctor|physician):\s*([a-zA-ZåäöÅÄÖ\s]+?)(?:\s|$|,|\.)/i,
    // Pattern for "Signerat: [Name]"
    /(?:signerat|signed|signature):\s*([a-zA-ZåäöÅÄÖ\s]+?)(?:\s|$|,|\.)/i,
    // Pattern for names after "av" (by)
    /av\s+([A-ZÅÄÖ][a-zåäö]+\s+[A-ZÅÄÖ][a-zåäö]+(?:\s+[A-ZÅÄÖ][a-zåäö]+)*)/i
  ];
  
  for (const pattern of doctorPatterns) {
    const match = pdfText.match(pattern);
    if (match && match[1]) {
      const doctorName = match[1].trim();
      // Clean up the name and validate it
      if (doctorName.length > 2 && doctorName.length < 50 && !doctorName.includes('(') && !doctorName.includes(')')) {
        return doctorName.includes('Dr.') ? doctorName : `Dr. ${doctorName}`;
      }
    }
  }
  
  return 'Dr. Importerad';
}

function extractDate(pdfText) {
  // Look for date patterns
  const datePatterns = [
    /(?:datum|date):\s*(\d{4}-\d{2}-\d{2}|\d{2}\/\d{2}\/\d{4}|\d{2}\.\d{2}\.\d{4})/i,
    /(?:undersökt|examined|date):\s*(\d{4}-\d{2}-\d{2}|\d{2}\/\d{2}\/\d{4}|\d{2}\.\d{2}\.\d{4})/i,
    /(\d{4}-\d{2}-\d{2}|\d{2}\/\d{2}\/\d{4}|\d{2}\.\d{2}\.\d{4})/
  ];
  
  for (const pattern of datePatterns) {
    const match = pdfText.match(pattern);
    if (match && match[1]) {
      try {
        const date = new Date(match[1]);
        if (!isNaN(date.getTime())) {
          return date.toLocaleDateString('sv-SE');
        }
      } catch (e) {
        // Continue to next pattern
      }
    }
  }
  
  return null;
}

function generateSummary(pdfText) {
  // Clean the text
  const cleanText = pdfText.replace(/\s+/g, ' ').trim();
  
  if (cleanText.length === 0) {
    return 'PDF-dokument importerat och analyserat.';
  }
  
  // Look for key medical information to create a better summary
  const summaryPatterns = [
    // Extract patient age and gender
    /(\d+)-årig\s+(man|kvinna|person)/i,
    // Extract main symptoms or complaints
    /(?:symptom|besvär|klagomål|problem)[:\s]*([^.!?]+)/i,
    // Extract diagnosis or findings
    /(?:diagnos|fynd|bedömning)[:\s]*([^.!?]+)/i,
    // Extract treatment or recommendations
    /(?:behandling|rekommendation|åtgärd)[:\s]*([^.!?]+)/i
  ];
  
  let summaryParts = [];
  
  // Try to extract structured information
  for (const pattern of summaryPatterns) {
    const match = cleanText.match(pattern);
    if (match && match[1]) {
      const info = match[1].trim();
      if (info.length > 5 && info.length < 100) {
        summaryParts.push(info);
      }
    }
  }
  
  // If we found structured information, use it
  if (summaryParts.length > 0) {
    return summaryParts.join('. ') + '.';
  }
  
  // Fallback: Extract first few meaningful sentences
  const sentences = cleanText.split(/[.!?]+/).filter(s => s.trim().length > 15);
  
  if (sentences.length === 0) {
    // If no sentences found, take first 150 characters
    const preview = cleanText.substring(0, 150);
    return preview + (cleanText.length > 150 ? '...' : '');
  }
  
  // Take first 2 meaningful sentences, but make sure they're not too long
  const summarySentences = sentences.slice(0, 2).map(s => s.trim()).filter(s => s.length > 0 && s.length < 200);
  
  if (summarySentences.length === 0) {
    const preview = cleanText.substring(0, 150);
    return preview + (cleanText.length > 150 ? '...' : '');
  }
  
  return summarySentences.join('. ') + '.';
}

function parseIntoSections(pdfText) {
  const sections = [];
  const cleanText = pdfText.replace(/\s+/g, ' ').trim();
  
  // Swedish medical document section patterns
  const sectionPatterns = [
    { pattern: /(?:AKTUELL\s+ANAMNES|CURRENT\s+ANAMNESIS|ANAMNES)/i, title: 'Anamnes' },
    { pattern: /(?:STATUS|FYND|FINDINGS|UNDERSÖKNING|EXAMINATION)/i, title: 'Status' },
    { pattern: /(?:DIAGNOS|DIAGNOSIS|BEDÖMNING|ASSESSMENT)/i, title: 'Diagnos' },
    { pattern: /(?:BEHANDLING|TREATMENT|REKOMMENDATION|RECOMMENDATION)/i, title: 'Behandling' },
    { pattern: /(?:SLUTSATS|CONCLUSION|SAMMANFATTNING|SUMMARY)/i, title: 'Slutsats' },
    { pattern: /(?:UPPFÖLJNING|FOLLOW-UP|KONTROLL)/i, title: 'Uppföljning' }
  ];
  
  let lastIndex = 0;
  let foundSections = [];
  
  // Find all section boundaries
  for (const section of sectionPatterns) {
    const match = cleanText.search(section.pattern);
    if (match > lastIndex) {
      foundSections.push({
        index: match,
        title: section.title,
        pattern: section.pattern
      });
    }
  }
  
  // Sort sections by position
  foundSections.sort((a, b) => a.index - b.index);
  
  // Create sections
  for (let i = 0; i < foundSections.length; i++) {
    const currentSection = foundSections[i];
    const nextSection = foundSections[i + 1];
    
    const startIndex = currentSection.index;
    const endIndex = nextSection ? nextSection.index : cleanText.length;
    
    let sectionContent = cleanText.substring(startIndex, endIndex).trim();
    
    // Clean up the content - remove the section header from the content
    sectionContent = sectionContent.replace(currentSection.pattern, '').trim();
    
    if (sectionContent.length > 10) {
      sections.push({
        heading: currentSection.title,
        content: sectionContent
      });
    }
  }
  
  // If no structured sections found, try to create logical sections from the content
  if (sections.length === 0) {
    // Look for common Swedish medical terms and create sections
    const medicalTerms = [
      { term: /(?:besöksanteckning|visit note|journalanteckning)/i, title: 'Besöksanteckning' },
      { term: /(?:patient|personnummer|födelsedatum)/i, title: 'Patientinformation' },
      { term: /(?:symptom|besvär|klagomål)/i, title: 'Symptom' },
      { term: /(?:undersökning|examination|status)/i, title: 'Undersökning' },
      { term: /(?:behandling|medicin|recept)/i, title: 'Behandling' }
    ];
    
    let lastIndex = 0;
    for (const term of medicalTerms) {
      const match = cleanText.search(term.term);
      if (match > lastIndex && match < cleanText.length - 50) {
        const sectionText = cleanText.substring(lastIndex, match).trim();
        if (sectionText.length > 20) {
          sections.push({
            heading: 'Information',
            content: sectionText
          });
        }
        lastIndex = match;
      }
    }
    
    // Add remaining content
    if (lastIndex < cleanText.length - 20) {
      const remainingText = cleanText.substring(lastIndex).trim();
      if (remainingText.length > 20) {
        sections.push({
          heading: 'Innehåll',
          content: remainingText
        });
      }
    }
    
    // If still no sections, create a single content section
    if (sections.length === 0) {
      sections.push({
        heading: 'Journalanteckning',
        content: cleanText
      });
    }
  }
  
  return sections;
}

function isSectionHeader(line) {
  // Check if line looks like a section header
  const headerPatterns = [
    /^[A-ZÅÄÖ][A-ZÅÄÖ\s]+:$/, // All caps with colon
    /^\d+\.\s+[A-ZÅÄÖ]/, // Numbered sections
    /^(?:sammanfattning|summary|resultat|result|fynd|findings|slutsats|conclusion|rekommendation|recommendation)/i,
    /^(?:anamnes|history|symptom|symptoms|undersökning|examination|diagnos|diagnosis|behandling|treatment)/i
  ];
  
  return headerPatterns.some(pattern => pattern.test(line)) && line.length < 100;
}

function createFallbackContent(pdfFile) {
  const filename = pdfFile.name;
  const uploadedAt = new Date(pdfFile.uploadedAt);
  
  // Extract title from filename
  const title = filename
    .replace(/\.pdf$/i, '')
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, l => l.toUpperCase());
  
  return {
    filename: filename,
    title: title,
    doctor: 'Dr. Importerad',
    date: uploadedAt.toLocaleDateString('sv-SE'),
    summary: 'PDF-dokument importerat. Innehållet kunde inte analyseras automatiskt.',
    content: {
      title: title,
      doctor: 'Dr. Importerad',
      date: uploadedAt.toLocaleDateString('sv-SE'),
      summary: 'PDF-dokument importerat. Innehållet kunde inte analyseras automatiskt.',
      sections: [
        {
          heading: 'Dokumentinformation',
          content: `Dokument: ${filename}\nUppladdad: ${uploadedAt.toLocaleString('sv-SE')}\nTyp: PDF-dokument\nStatus: Innehållet kunde inte analyseras automatiskt.`
        },
        {
          heading: 'Anteckning',
          content: 'Detta PDF-dokument har importerats från mobilen men innehållet kunde inte analyseras automatiskt. Du kan använda "Summera med Hälsa+GPT" för att få hjälp med att analysera innehållet.'
        }
      ]
    },
    parsedAt: new Date().toISOString()
  };
}

