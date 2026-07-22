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

// API Key Elements
const apiKeyInput = document.getElementById('apiKeyInput');
const saveKeyBtn = document.getElementById('saveKeyBtn');

// Initialize App & Load Databases
window.addEventListener('DOMContentLoaded', async () => {
  // Load saved API key
  const savedKey = localStorage.getItem('pqrs_gemini_key');
  if (savedKey) {
    apiKeyInput.value = savedKey;
  }

  // Load local ISSN databases directly from GitHub Pages hosting
  try {
    const scopusRes = await fetch('./scopus_issns.json');
    const scopusData = await scopusRes.json();
    scopusMasterList = buildMasterIssnList(scopusData);
  } catch (e) {
    console.warn("Could not load Scopus database. Ensure scopus_issns.json is in the root folder.");
  }

  try {
    const embaseRes = await fetch('./embase_issns.json');
    const embaseData = await embaseRes.json();
    embaseMasterList = buildMasterIssnList(embaseData);
  } catch (e) {
    console.warn("Could not load Embase database. Ensure embase_issns.json is in the root folder.");
  }
});

// Save API Key locally
saveKeyBtn.addEventListener('click', () => {
  const key = apiKeyInput.value.trim();
  if (key) {
    localStorage.setItem('pqrs_gemini_key', key);
    alert('API Key saved securely to your browser!');
  } else {
    alert('Please enter a valid key.');
  }
});

// Helper function to extract and clean every ISSN
function buildMasterIssnList(dbArray) {
  let masterSet = new Set();
  if (!Array.isArray(dbArray)) return [];
  dbArray.forEach(row => {
    if (typeof row === 'string') {
      masterSet.add(row.replace(/[^0-9X]/gi, '').toUpperCase());
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

// Robust JavaScript date parser to compute days
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

// Theme Switcher
themeToggle.addEventListener('click', () => {
  const currentTheme = document.documentElement.getAttribute('data-theme');
  const newTheme = currentTheme === 'light' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', newTheme);
  themeIcon.textContent = newTheme === 'light' ? '🌙' : '☀️';
  themeLabel.textContent = newTheme === 'light' ? 'Dark Mode' : 'Light Mode';
});

// Mode Toggle Listener
modeSelect.addEventListener('change', (e) => {
  if (e.target.value === 'batch') {
    doiGroup.classList.add('hidden');
    batchInfo.classList.remove('hidden');
    fileLabel.textContent = 'Upload CSV and/or PDF Files';
    fileInput.multiple = true;
  } else {
    doiGroup.classList.remove('hidden');
    batchInfo.classList.add('hidden');
    fileLabel.textContent = 'Upload Manuscript PDF';
    fileInput.multiple = false;
  }
});

// Main Execution
runBtn.addEventListener('click', async () => {
  const apiKey = localStorage.getItem('pqrs_gemini_key');
  if (!apiKey) {
    alert('Please enter and save your Gemini API Key first.');
    return;
  }

  const mode = modeSelect.value;
  setLoading(true);
  
  try {
    if (mode === 'single') {
      let rawDoi = doiInput.value;
      let cleanDoi = rawDoi ? (rawDoi.match(/(10\.\d{4,9}\/[-._;()/:a-zA-Z0-9]+)/)?.[0].replace(/\/+$/, '') || "") : "";
      const file = fileInput.files[0];
      
      if (!cleanDoi && !file) {
        alert('Please provide a valid DOI or a PDF file.');
        setLoading(false);
        return;
      }

      updateStatus('Processing manuscript...');
      const record = await processItem(cleanDoi, file, apiKey);
      addRecordToTable(record);
    } else {
      // Batch Mode
      const files = Array.from(fileInput.files);
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
        updateStatus(`Processing ${i + 1} of ${itemsToProcess.length}: ${item.doi || item.file?.name}`);
        try {
          const record = await processItem(item.doi, item.file, apiKey);
          addRecordToTable(record);
        } catch (err) {
          console.error(`Error processing item ${i}:`, err);
        }
        if (i < itemsToProcess.length - 1) await new Promise(res => setTimeout(res, 2000));
      }
    }
    
    updateStatus('Extraction completed successfully!');
  } catch (err) {
    alert('Execution error: ' + err.message);
    updateStatus('Error occurred during execution.');
  } finally {
    setLoading(false);
  }
});

async function processItem(doi, file, apiKey) {
  let crossrefData = {};
  
  // 1. Fetch CrossRef Metadata
  if (doi) {
    try {
      const crRes = await fetch(`https://api.crossref.org/works/${encodeURIComponent(doi)}`);
      if (crRes.ok) crossrefData = (await crRes.json()).message || {};
    } catch (e) { console.warn('CrossRef lookup failed.', e); }
  }

  const issns = crossrefData.ISSN || [];
  const issnsFormatted = issns.join(' / ') || 'Not reported';

  // 2. Query External APIs (MEDLINE, DOAJ, OpenAlex, Website Text)
  const [medlineStatus, doajStatus, openAlexData, websiteContext] = await Promise.all([
    checkStrictMedline(doi),
    checkDOAJIndexing(issns),
    fetchOpenAlexData(doi),
    fetchWebsiteText(doi)
  ]);

  // 3. Convert PDF to Base64
  let pdfBase64 = null;
  if (file) {
    pdfBase64 = await fileToBase64(file);
  }

  // 4. Construct AI Prompt Parameters
  const isPubMed = (openAlexData && openAlexData.ids && openAlexData.ids.pmid) ? "Yes" : "No";
  const isPmc = (openAlexData && openAlexData.ids && openAlexData.ids.pmcid) ? "Yes" : "No";
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

  let isScopus = "No";
  let isEmbase = "No";
  const cleanManuscriptIssns = issns.map(issn => issn.replace(/[^0-9X]/gi, '').toUpperCase());
  if (cleanManuscriptIssns.length > 0) {
    if (cleanManuscriptIssns.some(i => scopusMasterList.includes(i))) isScopus = "Yes";
    if (cleanManuscriptIssns.some(i => embaseMasterList.includes(i))) isEmbase = "Yes";
  }

  // 5. Call Gemini API Directly from Browser
  const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-lite-latest:generateContent?key=${apiKey}`;

  const promptText = `
You are an expert research integrity auditor and bibliometrician.
Analyze the attached manuscript PDF along with the CrossRef metadata, OpenAlex metadata, and scraped Website Context.

INSTRUCTION: Use OpenAlex metadata as your primary source of truth for identifiers/affiliations. If missing, default to the PDF.

OpenAlex Metadata:
${JSON.stringify(openAlexData || {})}
Note: OpenAlex official database publication date is: ${openAlexPubDate}

CrossRef Metadata:
${JSON.stringify(crossrefData || {})}
Note: CrossRef official database publication date is: ${crossrefPubDate}

Publisher Website Scraped Text:
${websiteContext}

Extract and audit these exact keys strictly as JSON:

1. "article_title": Full title of the article. Use OpenAlex primarily.
2. "journal_name": Name of the publishing journal. Use OpenAlex primarily.
3. "authors": Formatted as "1 - [Name] [Surname]; 2 - [Name] [Surname]". 
4. "affiliation_department": Format as "1 - [Dept]; 2 - [Dept]". Deduplicate identical departments.
5. "affiliation_college": Format as "1 - [College]; 2 - [College]".
6. "affiliation_university": Format as "1 - [University]; 2 - [University]".
7. "affiliation_city": Deduplicate the list so no city is repeated. Format as a semicolon-separated string.
8. "affiliation_country": Deduplicate the list so no country is repeated. Format as a semicolon-separated string.
9. "orcid_ids": ORCID numbers in order of authorship.
10. "publisher": Name of publisher. Extract strictly from OpenAlex or CrossRef. Do NOT guess based on memory.
11. "publisher_country": Country of publisher headquarters.
12. "special_issue": "Yes" or "No".
13. "study_design": Precise study design.
14. "reporting_guidelines": Scan the manuscript for ANY mention of adherence to methodological frameworks, reporting standards, prior recommendations, or guidelines (e.g., PRISMA, CARE, STROBE, or "conducted in accordance with..."). If followed, output its name or description. If none, output "Not reported".
15. "ethics_approval": If study DOES NOT involve human/animal participants, output "Not applicable". If it DOES, actively scan the text for Institutional Review Board (IRB), Institutional Ethics Committee (IEC), Ethical Clearance, or Animal Ethics approval statements. Extract the exact approval number or ID. If human/animal intervention is present but no approval is mentioned, state "Not reported".
16. "trial_registration": Mandatory for clinical interventions. Mention registration number. If non-human, state "Not applicable". If clinical without ID, state "Not reported".
17. "protocol_registration": Scan the text and reference list for protocol registrations (e.g., OSF, PROSPERO). Look explicitly for protocol DOIs (e.g., 10.17605/OSF.IO/...) or URLs. Extract the exact DOI/link. If not found, output "Not reported".
18. "received_date": Aggressively scan the PDF's extreme margins, footnotes, copyright headers, and title-page for the exact "Received", "Submitted", or "Recibido" date. Extract raw date text. If missing, output "Not reported".
19. "accepted_date": Aggressively scan the PDF margins/footnotes for the exact "Accepted", "Revised", or "Aceptado" date. Extract raw date text. If missing, output "Not reported".
20. "published_date": Use OpenAlex/CrossRef date primarily. Also check the PDF and website text for "Published", "Available online", or "Publicado". Extract raw date text. If missing, output "Not reported".
21. "scientific_syntax": Count spelling errors, subject-verb agreement failures, and verb-tense inconsistencies. Apply this grading: 0 to 5 errors = "[Acceptable]". 6 to 15 errors = "[Average]". More than 15 errors = "[Poor]".
22. "funding": "Yes" or "No".
23. "journal_self_citation_percentage": Estimated percentage of references citing the publishing journal itself.
24. "tortured_phrases": List any tortured phrases identified. If none, state "None".
25. "hallucinated_references": List suspicious references by number. If none found, state "None".
26. "pubmed": "Output EXACTLY this string, do not alter it: ${isPubMed}"
27. "pmc": "Output EXACTLY this string, do not alter it: ${isPmc}"
28. "scopus": "Output EXACTLY this string, do not alter it: ${isScopus}"
29. "embase": "Output EXACTLY this string, do not alter it: ${isEmbase}"
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

  const aiRes = await fetch(geminiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: contents, generationConfig: { responseMimeType: "application/json" } })
  });

  if (!aiRes.ok) throw new Error('Gemini API extraction failed. Check your API Key.');
  
  const aiData = await aiRes.json();
  const aiResult = JSON.parse(aiData.candidates[0].content.parts[0].text);

  // 6. Combine results and apply math
  aiResult.received_to_accepted_days = calculateDaysRobust(aiResult.received_date, aiResult.accepted_date);
  aiResult.accepted_to_published_days = calculateDaysRobust(aiResult.accepted_date, aiResult.published_date);

  const finalRecord = {
    doi: doi || crossrefData.DOI || 'Extracted from PDF',
    article_title: aiResult.article_title || 'Not reported',
    journal_name: aiResult.journal_name || 'Not reported',
    issn: issnsFormatted,
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
    pubmed: aiResult.pubmed || 'No', 
    pmc: aiResult.pmc || 'No',       
    medline: medlineStatus ? 'Yes' : 'No', 
    scopus: aiResult.scopus || 'No',
    embase: aiResult.embase || 'No',
    doaj: doajStatus ? 'Yes' : 'No'
  };

  return finalRecord;
}

// Data Fetchers
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

// Utilizes AllOrigins CORS Proxy to scrape publisher websites client-side
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
  if (extractedRecords.length === 1) resultsBody.innerHTML = '';
  
  const tr = document.createElement('tr');
  tr.innerHTML = Object.values(record).map(val => `<td>${val}</td>`).join('');
  resultsBody.appendChild(tr);
  exportCsvBtn.disabled = false;
}

exportCsvBtn.addEventListener('click', () => {
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
  runBtn.disabled = isLoading;
  btnText.textContent = isLoading ? 'Processing...' : 'Run Extraction';
  btnSpinner.classList.toggle('hidden', !isLoading);
  statusMessage.classList.toggle('hidden', !isLoading);
}

function updateStatus(msg) { statusMessage.textContent = msg; }
