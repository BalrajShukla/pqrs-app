// State Management
const extractedRecords = [];
let scopusMasterList = [];
let embaseMasterList = [];

// DOM Elements
const themeToggle = document.getElementById('themeToggle');
const themeIcon = document.getElementById('themeIcon');
const themeLabel = document.getElementById('themeLabel');
const modeSelect = document.getElementById('modeSelect');
const doiGroup = document.getElementById('doiGroup');
const doiInput = document.getElementById('doiInput');
const fileInput = document.getElementById('fileInput');
const fileLabel = document.getElementById('fileLabel');
const runBtn = document.getElementById('runBtn');
const btnText = document.getElementById('btnText');
const btnSpinner = document.getElementById('btnSpinner');
const statusMessage = document.getElementById('statusMessage');
const batchInfo = document.getElementById('batchInfo');
const resultsBody = document.getElementById('resultsBody');
const exportCsvBtn = document.getElementById('exportCsvBtn');
const apiKeyInput = document.getElementById('apiKeyInput');
const saveKeyBtn = document.getElementById('saveKeyBtn');

// Initialize App & Robustly Load Databases from GitHub Pages
window.addEventListener('DOMContentLoaded', async () => {
  const savedKey = localStorage.getItem('pqrs_gemini_key');
  if (savedKey && apiKeyInput) apiKeyInput.value = savedKey;

  const basePath = window.location.pathname.substring(0, window.location.pathname.lastIndexOf('/') + 1);

  try {
    const scopusRes = await fetch(`${basePath}scopus_issns.json`);
    if (scopusRes.ok) {
      const scopusData = await scopusRes.json();
      scopusMasterList = buildMasterIssnList(scopusData);
      console.log(`Loaded ${scopusMasterList.length} Scopus ISSNs.`);
    } else {
      console.error("Failed to load Scopus database.");
    }
  } catch (e) {
    console.error("Error fetching Scopus ISSNs:", e);
  }

  try {
    const embaseRes = await fetch(`${basePath}embase_issns.json`);
    if (embaseRes.ok) {
      const embaseData = await embaseRes.json();
      embaseMasterList = buildMasterIssnList(embaseData);
      console.log(`Loaded ${embaseMasterList.length} Embase ISSNs.`);
    } else {
      console.error("Failed to load Embase database.");
    }
  } catch (e) {
    console.error("Error fetching Embase ISSNs:", e);
  }
});

if (saveKeyBtn) {
  saveKeyBtn.addEventListener('click', () => {
    const key = apiKeyInput.value.trim();
    if (key) {
      localStorage.setItem('pqrs_gemini_key', key);
      alert('API Key saved securely!');
    } else {
      alert('Please enter a valid key.');
    }
  });
}

function buildMasterIssnList(dbArray) {
  let masterSet = new Set();
  if (!Array.isArray(dbArray)) return [];
  dbArray.forEach(row => {
    if (typeof row === 'string') {
      const clean = row.replace(/[^0-9X]/gi, '').toUpperCase();
      if (clean.length === 8) masterSet.add(clean);
    } else if (typeof row === 'object' && row !== null) {
      Object.values(row).forEach(val => {
        if (typeof val === 'string') {
          const cleanVal = val.replace(/[^0-9X]/gi, '').toUpperCase();
          if (cleanVal.length === 8) masterSet.add(cleanVal);
        }
      });
    }
  });
  return Array.from(masterSet).filter(Boolean);
}

function calculateDaysRobust(dateStr1, dateStr2) {
  if (!dateStr1 || !dateStr2 || dateStr1.includes("Not reported") || dateStr2.includes("Not reported")) {
    return "Not reported";
  }
  const clean1 = dateStr1.replace(/(received|accepted|published|available online|recibido|aceptado|publicado|:|;|,)/gi, '').trim();
  const clean2 = dateStr2.replace(/(received|accepted|published|available online|recibido|aceptado|publicado|:|;|,)/gi, '').trim();

  const d1 = new Date(clean1);
  const d2 = new Date(clean2);

  if (isNaN(d1.getTime()) || isNaN(d2.getTime())) return "Not reported";

  const diffTime = d2.getTime() - d1.getTime();
  const diffDays = Math.round(diffTime / (1000 * 60 * 60 * 24));
  return diffDays >= 0 ? diffDays : "Not reported"; 
}

themeToggle?.addEventListener('click', () => {
  const currentTheme = document.documentElement.getAttribute('data-theme');
  const newTheme = currentTheme === 'light' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', newTheme);
  if (themeIcon) themeIcon.textContent = newTheme === 'light' ? '🌙' : '☀️';
  if (themeLabel) themeLabel.textContent = newTheme === 'light' ? 'Dark Mode' : 'Light Mode';
});

modeSelect?.addEventListener('change', (e) => {
  if (e.target.value === 'batch') {
    doiGroup?.classList.add('hidden');
    batchInfo?.classList.remove('hidden');
    if (fileLabel) fileLabel.textContent = 'Upload CSV and/or PDF Files';
    if (fileInput) fileInput.multiple = true;
  } else {
    doiGroup?.classList.remove('hidden');
    batchInfo?.classList.add('hidden');
    if (fileLabel) fileLabel.textContent = 'Upload Manuscript PDF';
    if (fileInput) fileInput.multiple = false;
  }
});

runBtn?.addEventListener('click', async () => {
  const apiKey = localStorage.getItem('pqrs_gemini_key');
  if (!apiKey) {
    alert('Please enter and save your Gemini API Key first.');
    return;
  }

  const mode = modeSelect.value;
  setLoading(true);
  
  try {
    if (mode === 'single') {
      let rawDoi = doiInput ? doiInput.value : "";
      let cleanDoi = rawDoi ? (rawDoi.match(/(10\.\d{4,9}\/[-._;()/:a-zA-Z0-9]+)/)?.[0].replace(/\/+$/, '') || "") : "";
      const file = fileInput?.files[0];
      
      if (!cleanDoi && !file) {
        alert('Please provide a valid DOI or a PDF file.');
        setLoading(false);
        return;
      }

      updateStatus('Auditing manuscript with Gemini 2.5 Flash...');
      const record = await processItem(cleanDoi, file, apiKey);
      addRecordToTable(record);
    } else {
      const files = Array.from(fileInput?.files || []);
      let itemsToProcess = [];
      const csvFile = files.find(f => f.name.endsWith('.csv'));
      
      if (csvFile) {
        const csvText = await csvFile.text();
        const extractedDois = parseCsvDois(csvText);
        itemsToProcess = extractedDois.map(doi => {
          const pdfMatch = files.find(f => f.name.toLowerCase().includes(doi.replace(/[^a-zA-Z0-9]/g, '').toLowerCase()));
          return { doi, file: pdfMatch };
        });
      } else {
        itemsToProcess = files.map(file => ({ doi: '', file }));
      }

      if (itemsToProcess.length === 0) {
        alert('No valid files or DOIs found for batch processing.');
        setLoading(false);
        return;
      }

      for (let i = 0; i < itemsToProcess.length; i++) {
        const item = itemsToProcess[i];
        updateStatus(`Auditing ${i + 1} of ${itemsToProcess.length}: ${item.doi || item.file?.name}`);
        try {
          const record = await processItem(item.doi, item.file, apiKey);
          addRecordToTable(record);
        } catch (err) {
          console.error(`Error processing item ${i}:`, err);
        }
        if (i < itemsToProcess.length - 1) await new Promise(res => setTimeout(res, 2000));
      }
    }
    
    updateStatus('Audit completed successfully!');
  } catch (err) {
    alert('Execution error: ' + err.message);
    updateStatus('Error occurred during execution.');
  } finally {
    setLoading(false);
  }
});

async function processItem(doi, file, apiKey) {
  let crossrefData = {};
  
  if (doi) {
    try {
      const crRes = await fetch(`https://api.crossref.org/works/${encodeURIComponent(doi)}`);
      if (crRes.ok) crossrefData = (await crRes.json()).message || {};
    } catch (e) { console.warn('CrossRef lookup failed.', e); }
  }

  const [medlineStatus, doajStatus, openAlexData, websiteContext] = await Promise.all([
    checkStrictMedline(doi),
    checkDOAJIndexing(crossrefData.ISSN || []),
    fetchOpenAlexData(doi),
    fetchWebsiteText(doi)
  ]);

  let pdfBase64 = null;
  if (file) {
    pdfBase64 = await fileToBase64(file);
  }

  const openAlexPubMed = (openAlexData?.ids?.pmid) ? "Yes" : "No";
  const openAlexPMC = (openAlexData?.ids?.pmcid) ? "Yes" : "No";
  const openAlexPubDate = openAlexData?.publication_date || "Not reported in OpenAlex";

  let crossrefPubDate = "Not reported in CrossRef";
  const crPub = crossrefData?.published || crossrefData?.['published-online'] || crossrefData?.['published-print'];
  if (crPub && crPub['date-parts'] && crPub['date-parts'][0]) {
    const parts = crPub['date-parts'][0];
    const y = parts[0];
    const m = parts[1] ? String(parts[1]).padStart(2, '0') : '01';
    const d = parts[2] ? String(parts[2]).padStart(2, '0') : '01';
    crossrefPubDate = `${y}-${m}-${d}`;
  }

  const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;

  const promptText = `
You are an expert research integrity auditor performing a forensic manuscript extraction.
Analyze the attached manuscript PDF, OpenAlex metadata, CrossRef metadata, and scraped web text.

OpenAlex Metadata: ${JSON.stringify(openAlexData || {})} (Pub Date: ${openAlexPubDate})
CrossRef Metadata: ${JSON.stringify(crossrefData || {})} (Pub Date: ${crossrefPubDate})
Scraped Website Context: ${websiteContext}

Extract and audit these parameters with strict fidelity:
1. article_title: Full title.
2. journal_name: Official journal title.
3. authors: Format "1 - Name Surname; 2 - Name Surname".
4. affiliation_department: Format "1 - Dept; 2 - Dept". Deduplicate synonyms.
5. affiliation_college: Format "1 - College; 2 - College".
6. affiliation_university: Format "1 - Univ; 2 - Univ".
7. affiliation_city: Unique semicolon-separated cities.
8. affiliation_country: Unique semicolon-separated countries.
9. orcid_ids: ORCID numbers or "Not reported".
10. publisher: Exact publisher name from OpenAlex/CrossRef JSON (Do not guess from memory).
11. publisher_country: Publisher location country.
12. special_issue: "Yes" or "No".
13. study_design: Exact design (e.g., Cross-sectional, Psychometric Validation, Case Report, Systematic Review).
14. reporting_guidelines: Scan Methodology/Text for ANY statement of adherence to reporting standards or frameworks (e.g., PRISMA, CARE, STROBE, or author-developed frameworks like "guidelines developed by Boateng et al."). Output the exact framework name or citation. If none, state "Not reported".
15. ethics_approval: Scan for Ethics Committee, IEC, IRB, or Ethical Clearance mentions. ACTIVELY extract parenthetical IDs (e.g., "IEC/CDSRC/2026/24"). Do not ignore codes inside parentheses. If non-human/animal study, output "Not applicable".
16. trial_registration: Clinical trial registry ID or "Not applicable" / "Not reported".
17. protocol_registration: Scan text and references for protocol registrations (e.g., OSF, PROSPERO). Reconstruct split DOIs caused by line breaks (e.g., "10.17605/OSF.IO/TVUKC"). Extract full DOI or URL.
18. received_date: Search extreme PDF margins, headers, title page, and footnotes for Received/Submitted/Recibido date. Extract verbatim.
19. accepted_date: Search PDF margins, headers, and footnotes for Accepted/Revised/Aceptado date. Extract verbatim.
20. published_date: Primary source OpenAlex/CrossRef or PDF text. Extract verbatim.
21. scientific_syntax: Actively count spelling, subject-verb, and tense errors. 0-5 = "[Acceptable]", 6-15 = "[Average]", >15 = "[Poor]".
22. funding: "Yes" or "No".
23. journal_self_citation_percentage: Estimated percentage.
24. tortured_phrases: List tortured phrases or "None".
25. hallucinated_references: List non-existent references or "None".
26. pdf_extracted_issns: Extract ALL p-ISSN and e-ISSN numbers printed on the PDF pages (e.g., "0898-9621; 1545-5815").
27. detected_pubmed: Output "Yes" if PMID is found in PDF/OpenAlex, else "${openAlexPubMed}".
28. detected_pmc: Output "Yes" if PMCID is found in PDF/OpenAlex, else "${openAlexPMC}".
`;

  const contents = [];
  if (pdfBase64) {
    contents.push({
      role: "user",
      parts: [
        { inline_data: { mime_type: "application/pdf", data: pdfBase64 } },
        { text: promptText }
      ]
    });
  } else {
    contents.push({ role: "user", parts: [{ text: promptText }] });
  }

  const payload = {
    contents: contents,
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: {
        type: "OBJECT",
        properties: {
          article_title: { type: "STRING" },
          journal_name: { type: "STRING" },
          authors: { type: "STRING" },
          affiliation_department: { type: "STRING" },
          affiliation_college: { type: "STRING" },
          affiliation_university: { type: "STRING" },
          affiliation_city: { type: "STRING" },
          affiliation_country: { type: "STRING" },
          orcid_ids: { type: "STRING" },
          publisher: { type: "STRING" },
          publisher_country: { type: "STRING" },
          special_issue: { type: "STRING" },
          study_design: { type: "STRING" },
          reporting_guidelines: { type: "STRING" },
          ethics_approval: { type: "STRING" },
          trial_registration: { type: "STRING" },
          protocol_registration: { type: "STRING" },
          received_date: { type: "STRING" },
          accepted_date: { type: "STRING" },
          published_date: { type: "STRING" },
          scientific_syntax: { type: "STRING" },
          funding: { type: "STRING" },
          journal_self_citation_percentage: { type: "STRING" },
          tortured_phrases: { type: "STRING" },
          hallucinated_references: { type: "STRING" },
          pdf_extracted_issns: { type: "STRING" },
          detected_pubmed: { type: "STRING" },
          detected_pmc: { type: "STRING" }
        },
        required: [
          "article_title", "journal_name", "authors", "affiliation_department",
          "affiliation_college", "affiliation_university", "affiliation_city",
          "affiliation_country", "orcid_ids", "publisher", "publisher_country",
          "special_issue", "study_design", "reporting_guidelines", "ethics_approval",
          "trial_registration", "protocol_registration", "received_date",
          "accepted_date", "published_date", "scientific_syntax", "funding",
          "journal_self_citation_percentage", "tortured_phrases", "hallucinated_references",
          "pdf_extracted_issns", "detected_pubmed", "detected_pmc"
        ]
      }
    }
  };

  const aiRes = await fetch(geminiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  if (!aiRes.ok) {
    const errObj = await aiRes.json();
    throw new Error(errObj.error?.message || 'Gemini API extraction failed.');
  }
  
  const aiData = await aiRes.json();
  const aiResult = JSON.parse(aiData.candidates[0].content.parts[0].text);

  // --- MULTI-SOURCE ISSN MERGING (CRITICAL SCOPUS/EMBASE FIX) ---
  let masterIssnPool = new Set();

  // 1. Add CrossRef ISSNs
  (crossrefData.ISSN || []).forEach(i => masterIssnPool.add(i));

  // 2. Add OpenAlex ISSNs
  if (openAlexData?.issn) {
    (Array.isArray(openAlexData.issn) ? openAlexData.issn : [openAlexData.issn]).forEach(i => masterIssnPool.add(i));
  }
  if (openAlexData?.primary_location?.source?.issn) {
    (Array.isArray(openAlexData.primary_location.source.issn) ? openAlexData.primary_location.source.issn : [openAlexData.primary_location.source.issn]).forEach(i => masterIssnPool.add(i));
  }

  // 3. Add AI-Extracted ISSNs from PDF
  if (aiResult.pdf_extracted_issns) {
    aiResult.pdf_extracted_issns.split(/;|,|\//).forEach(i => masterIssnPool.add(i.trim()));
  }

  // Clean and check against local master lists
  const cleanedIssnArray = Array.from(masterIssnPool).map(i => i.replace(/[^0-9X]/gi, '').toUpperCase()).filter(i => i.length === 8);
  
  let isScopus = "No";
  let isEmbase = "No";
  if (cleanedIssnArray.length > 0) {
    if (cleanedIssnArray.some(i => scopusMasterList.includes(i))) isScopus = "Yes";
    if (cleanedIssnArray.some(i => embaseMasterList.includes(i))) isEmbase = "Yes";
  }

  const formattedIssnDisplay = Array.from(masterIssnPool).filter(Boolean).join(' / ') || 'Not reported';

  aiResult.received_to_accepted_days = calculateDaysRobust(aiResult.received_date, aiResult.accepted_date);
  aiResult.accepted_to_published_days = calculateDaysRobust(aiResult.accepted_date, aiResult.published_date);

  const finalRecord = {
    doi: doi || crossrefData.DOI || 'Extracted from PDF',
    article_title: aiResult.article_title || 'Not reported',
    journal_name: aiResult.journal_name || 'Not reported',
    issn: formattedIssnDisplay,
    authors: aiResult.authors || 'Not reported',
    affiliation_department: aiResult.affiliation_department || 'Not reported',
    affiliation_college: aiResult.affiliation_college || 'Not reported',
    affiliation_university: aiResult.affiliation_university || 'Not reported',
    affiliation_city: aiResult.affiliation_city || 'Not reported',
    affiliation_country: aiResult.affiliation_country || 'Not reported',
    orcid_ids: aiResult.orcid_ids || 'Not reported',
    publisher: aiResult.publisher || crossrefData.publisher || 'Not reported',
    publisher_country: aiResult.publisher_country || 'Not reported',
    special_issue: aiResult.special_issue || 'No',
    study_design: aiResult.study_design || 'Not reported',
    reporting_guidelines: aiResult.reporting_guidelines || 'Not reported',
    ethics_approval: aiResult.ethics_approval || 'Not reported',
    trial_registration: aiResult.trial_registration || 'Not applicable',
    protocol_registration: aiResult.protocol_registration || 'Not reported',
    received_to_accepted_days: aiResult.received_to_accepted_days,
    accepted_to_published_days: aiResult.accepted_to_published_days,
    scientific_syntax: aiResult.scientific_syntax || 'Not evaluated',
    funding: aiResult.funding || 'No',
    journal_self_citation_percentage: aiResult.journal_self_citation_percentage || '0%',
    tortured_phrases: aiResult.tortured_phrases || 'None',
    hallucinated_references: aiResult.hallucinated_references || 'None',
    pubmed: aiResult.detected_pubmed || 'No', 
    pmc: aiResult.detected_pmc || 'No',       
    medline: medlineStatus ? 'Yes' : 'No', 
    scopus: isScopus,
    embase: isEmbase,
    doaj: doajStatus ? 'Yes' : 'No'
  };

  return finalRecord;
}

async function checkStrictMedline(doi) {
  if (!doi) return false;
  try {
    const res = await fetch(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=${encodeURIComponent(doi)}[doi]+AND+medline[sb]&retmode=json`);
    const data = await res.json();
    return parseInt(data.esearchresult?.count || '0') > 0;
  } catch { return false; }
}

async function checkDOAJIndexing(issns) {
  if (!issns || issns.length === 0) return false;
  try {
    const res = await fetch(`https://doaj.org/api/v2/search/journals/issn%3A${issns[0]}`);
    const data = await res.json();
    return data.total > 0;
  } catch { return false; }
}

async function fetchOpenAlexData(doi) {
  if (!doi) return null;
  try {
    const res = await fetch(`https://api.openalex.org/works/https://doi.org/${doi}`, {
      headers: { 'User-Agent': 'mailto:pqrs.audit.tool@example.com' }
    });
    return res.ok ? await res.json() : null;
  } catch { return null; }
}

async function fetchWebsiteText(doi) {
  if (!doi) return "Not available";
  try {
    const targetUrl = `https://doi.org/${doi}`;
    const proxyUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(targetUrl)}`;
    const res = await fetch(proxyUrl);
    const html = await res.text();
    return html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().substring(0, 15000);
  } catch { return "Not available"; }
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = () => resolve(reader.result.split(',')[1]);
    reader.onerror = error => reject(error);
  });
}

function parseCsvDois(csvText) {
  const lines = csvText.split('\n');
  const dois = [];
  lines.forEach(line => {
    const match = line.match(/(10\.\d{4,9}\/[-._;()/:a-zA-Z0-9]+)/);
    if (match) dois.push(match[0].replace(/\/+$/, ''));
  });
  return [...new Set(dois)];
}

function addRecordToTable(record) {
  extractedRecords.push(record);
  if (extractedRecords.length === 1 && resultsBody) resultsBody.innerHTML = '';
  
  const tr = document.createElement('tr');
  tr.innerHTML = Object.values(record).map(val => `<td>${val}</td>`).join('');
  resultsBody?.appendChild(tr);
  if (exportCsvBtn) exportCsvBtn.disabled = false;
}

exportCsvBtn?.addEventListener('click', () => {
  if (extractedRecords.length === 0) return;
  const headers = Object.keys(extractedRecords[0]).join(',');
  const rows = extractedRecords.map(rec => Object.values(rec).map(val => `"${String(val).replace(/"/g, '""')}"`).join(','));
  const csvContent = "data:text/csv;charset=utf-8," + [headers, ...rows].join("\n");
  const link = document.createElement("a");
  link.setAttribute("href", encodeURI(csvContent));
  link.setAttribute("download", "PQRS_Stomatology_Quality_Audit.csv");
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
});

function setLoading(isLoading) {
  if (runBtn) runBtn.disabled = isLoading;
  if (btnText) btnText.textContent = isLoading ? 'Processing...' : 'Run Extraction';
  btnSpinner?.classList.toggle('hidden', !isLoading);
  statusMessage?.classList.toggle('hidden', !isLoading);
}

function updateStatus(msg) { if (statusMessage) statusMessage.textContent = msg; }
