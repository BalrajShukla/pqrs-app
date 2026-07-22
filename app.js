// State Management
const extractedRecords = [];

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
  const mode = modeSelect.value;
  setLoading(true);
  
  try {
    if (mode === 'single') {
      let rawDoi = doiInput.value;
      let cleanDoi = "";
      
      if (rawDoi) {
        const doiMatch = rawDoi.match(/(10\.\d{4,9}\/[-._;()/:a-zA-Z0-9]+)/);
        cleanDoi = doiMatch ? doiMatch[0].replace(/\/+$/, '') : "";
      }

      const file = fileInput.files[0];
      
      if (!cleanDoi && !file) {
        alert('Please provide a valid DOI or a PDF file.');
        setLoading(false);
        return;
      }

      updateStatus('Processing manuscript...');
      const record = await processItem(cleanDoi, file);
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
          const record = await processItem(item.doi, item.file);
          addRecordToTable(record);
        } catch (err) {
          console.error(`Error processing item ${i}:`, err);
        }
        if (i < itemsToProcess.length - 1) {
          await new Promise(res => setTimeout(res, 2000));
        }
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

// Item Processing Function
async function processItem(doi, file) {
  let crossrefData = {};
  let cleanDoi = doi;

  // 1. Fetch CrossRef Metadata if DOI present
  if (cleanDoi) {
    try {
      const crRes = await fetch(`https://api.crossref.org/works/${encodeURIComponent(cleanDoi)}`);
      if (crRes.ok) {
        const crJson = await crRes.json();
        crossrefData = crJson.message || {};
      }
    } catch (e) {
      console.warn('CrossRef lookup failed, relying on Gemini parsing.', e);
    }
  }

  // Extract ISSN from CrossRef
  const issns = crossrefData.ISSN || [];
  const issnsFormatted = issns.join(' / ') || 'Not reported';

  // 2. Query strict Indexing APIs concurrently (MEDLINE article-level / DOAJ)
  const [medlineStatus, doajStatus] = await Promise.all([
    checkStrictMedline(cleanDoi),
    checkDOAJIndexing(issns)
  ]);

  // 3. Convert PDF to Base64
  let pdfBase64 = null;
  if (file) {
    pdfBase64 = await fileToBase64(file);
  }

  // 4. Call Backend Gemini Serverless Function (Handles OpenAlex natively)
  const apiRes = await fetch('/api/extract', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      pdfBase64,
      doi: cleanDoi,
      crossrefData
    })
  });

  if (!apiRes.ok) {
    throw new Error('Gemini extraction function failed.');
  }

  const aiResult = await apiRes.json();

  // Combine results
  const finalRecord = {
    doi: cleanDoi || crossrefData.DOI || 'Extracted from PDF',
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
    received_to_accepted_days: (aiResult.received_to_accepted_days !== undefined && aiResult.received_to_accepted_days !== null) ? aiResult.received_to_accepted_days : 'Not reported',
    accepted_to_published_days: (aiResult.accepted_to_published_days !== undefined && aiResult.accepted_to_published_days !== null) ? aiResult.accepted_to_published_days : 'Not reported',
    scientific_syntax: aiResult.scientific_syntax || 'Not evaluated',
    funding: aiResult.funding || 'No',
    journal_self_citation_percentage: aiResult.journal_self_citation_percentage || '0%',
    tortured_phrases: aiResult.tortured_phrases || 'None',
    hallucinated_references: aiResult.hallucinated_references || 'None',
    pubmed: aiResult.pubmed || 'No', // Pulled strictly from OpenAlex PMID in backend
    pmc: aiResult.pmc || 'No',       // Pulled strictly from OpenAlex PMCID in backend
    medline: medlineStatus ? 'Yes' : 'No', // Strict DOI search
    scopus: aiResult.scopus || 'No',
    embase: aiResult.embase || 'No',
    doaj: doajStatus ? 'Yes' : 'No'
  };

  return finalRecord;
}

// Helpers & External APIs
async function checkStrictMedline(doi) {
  if (!doi) return false;
  try {
    // Uses [doi] and medline[sb] to strictly check if the article itself is in the MEDLINE subset
    const url = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=${encodeURIComponent(doi)}[doi]+AND+medline[sb]&retmode=json`;
    const res = await fetch(url);
    const data = await res.json();
    return parseInt(data.esearchresult?.count || '0') > 0;
  } catch {
    return false;
  }
}

async function checkDOAJIndexing(issns) {
  if (!issns || issns.length === 0) return false;
  try {
    const issn = issns[0];
    const res = await fetch(`https://doaj.org/api/v2/search/journals/issn%3A${issn}`);
    const data = await res.json();
    return data.total > 0;
  } catch {
    return false;
  }
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
  
  if (extractedRecords.length === 1) {
    resultsBody.innerHTML = '';
  }

  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td>${record.doi}</td>
    <td>${record.article_title}</td>
    <td>${record.journal_name}</td>
    <td>${record.issn}</td>
    <td>${record.authors}</td>
    <td>${record.affiliation_department}</td>
    <td>${record.affiliation_college}</td>
    <td>${record.affiliation_university}</td>
    <td>${record.affiliation_city}</td>
    <td>${record.affiliation_country}</td>
    <td>${record.orcid_ids}</td>
    <td>${record.publisher}</td>
    <td>${record.publisher_country}</td>
    <td>${record.special_issue}</td>
    <td>${record.study_design}</td>
    <td>${record.reporting_guidelines}</td>
    <td>${record.ethics_approval}</td>
    <td>${record.trial_registration}</td>
    <td>${record.received_to_accepted_days}</td>
    <td>${record.accepted_to_published_days}</td>
    <td>${record.scientific_syntax}</td>
    <td>${record.funding}</td>
    <td>${record.journal_self_citation_percentage}</td>
    <td>${record.tortured_phrases}</td>
    <td>${record.hallucinated_references}</td>
    <td>${record.pubmed}</td>
    <td>${record.pmc}</td>
    <td>${record.medline}</td>
    <td>${record.scopus}</td>
    <td>${record.embase}</td>
    <td>${record.doaj}</td>
  `;
  resultsBody.appendChild(tr);
  exportCsvBtn.disabled = false;
}

// Export CSV Handler
exportCsvBtn.addEventListener('click', () => {
  if (extractedRecords.length === 0) return;
  
  const headers = Object.keys(extractedRecords[0]).join(',');
  const rows = extractedRecords.map(rec => 
    Object.values(rec).map(val => `"${String(val).replace(/"/g, '""')}"`).join(',')
  );

  const csvContent = "data:text/csv;charset=utf-8," + [headers, ...rows].join("\n");
  const encodedUri = encodeURI(csvContent);
  const link = document.createElement("a");
  link.setAttribute("href", encodedUri);
  link.setAttribute("download", "PQRS_Stomatology_Quality_Audit.csv");
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
});

function setLoading(isLoading) {
  runBtn.disabled = isLoading;
  if (isLoading) {
    btnText.textContent = 'Processing...';
    btnSpinner.classList.remove('hidden');
    statusMessage.classList.remove('hidden');
  } else {
    btnText.textContent = 'Run Extraction';
    btnSpinner.classList.add('hidden');
  }
}

function updateStatus(msg) {
  statusMessage.textContent = msg;
}
