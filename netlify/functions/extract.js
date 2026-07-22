// Load local ISSN lookup databases
let embaseData = [];
let scopusData = [];

try {
  embaseData = require('./embase_issns.json');
} catch (e) {
  console.warn("embase_issns.json not found or invalid.");
}

try {
  scopusData = require('./scopus_issns.json');
} catch (e) {
  console.warn("scopus_issns.json not found or invalid.");
}

// Helper function to extract and clean every ISSN from the provided JSON
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
          if (cleanVal.length === 8) {
            masterSet.add(cleanVal);
          }
        }
      });
    }
  });
  return Array.from(masterSet).filter(Boolean);
}

const embaseMasterList = buildMasterIssnList(embaseData);
const scopusMasterList = buildMasterIssnList(scopusData);

// Robust JavaScript date parser to compute days even from messy raw text
function calculateDaysRobust(dateStr1, dateStr2) {
  if (!dateStr1 || !dateStr2 || dateStr1.includes("Not reported") || dateStr2.includes("Not reported")) {
    return "Not reported";
  }
  
  // Strip out common text artifacts that publishers leave attached to dates
  const clean1 = dateStr1.replace(/(received|accepted|published|available online|recibido|aceptado|publicado|:|;|,)/gi, '').trim();
  const clean2 = dateStr2.replace(/(received|accepted|published|available online|recibido|aceptado|publicado|:|;|,)/gi, '').trim();

  const d1 = new Date(clean1);
  const d2 = new Date(clean2);

  if (isNaN(d1.getTime()) || isNaN(d2.getTime())) {
    return "Not reported";
  }

  const diffTime = d2.getTime() - d1.getTime();
  const diffDays = Math.round(diffTime / (1000 * 60 * 60 * 24));
  return diffDays >= 0 ? diffDays : "Not reported"; 
}

async function fetchWebsiteText(doi) {
  if (!doi) return "No DOI provided for website scraping.";
  try {
    const res = await fetch(`https://doi.org/${doi}`);
    const html = await res.text();
    const text = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
                     .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
                     .replace(/<[^>]+>/g, ' ')
                     .replace(/\s+/g, ' ')
                     .trim();
    return text.substring(0, 15000);
  } catch (e) {
    return "Failed to fetch website context.";
  }
}

async function fetchOpenAlexData(doi) {
  if (!doi) return null;
  try {
    const res = await fetch(`https://api.openalex.org/works/https://doi.org/${doi}`, {
      headers: { 'User-Agent': 'mailto:pqrs.audit.tool@example.com' }
    });
    if (res.ok) {
      return await res.json();
    }
    return null;
  } catch (e) {
    console.warn("OpenAlex fetch failed:", e);
    return null;
  }
}

exports.handler = async (event, context) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const { pdfBase64, doi, crossrefData } = JSON.parse(event.body);
    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) {
      return {
        statusCode: 500,
        body: JSON.stringify({ error: 'Server missing GEMINI_API_KEY configuration.' })
      };
    }

    // --- FETCH WEB & OPENALEX DATA ---
    const websiteContext = doi ? await fetchWebsiteText(doi) : "Not available";
    const openAlexData = doi ? await fetchOpenAlexData(doi) : null;

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
    const manuscriptIssns = crossrefData?.ISSN || [];
    const cleanManuscriptIssns = manuscriptIssns.map(issn => issn.replace(/[^0-9X]/gi, '').toUpperCase());

    if (cleanManuscriptIssns.length > 0) {
      if (cleanManuscriptIssns.some(issn => scopusMasterList.includes(issn))) { isScopus = "Yes"; }
      if (cleanManuscriptIssns.some(issn => embaseMasterList.includes(issn))) { isEmbase = "Yes"; }
    }

    // --- GEMINI EXTRACTION ---
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-lite-latest:generateContent?key=${apiKey}`;

    const promptText = `
You are an expert research integrity auditor and bibliometrician.
Analyze the attached manuscript PDF along with the CrossRef metadata, the OpenAlex database metadata, and the scraped Website Context.

INSTRUCTION: Use the OpenAlex metadata as your primary source of truth for identifiers and affiliations. If OpenAlex is missing data, default to reading the PDF.

OpenAlex Metadata:
${JSON.stringify(openAlexData || {})}
Note: OpenAlex official database publication date is: ${openAlexPubDate}

CrossRef Metadata:
${JSON.stringify(crossrefData || {})}
Note: CrossRef official database publication date is: ${crossrefPubDate}

Publisher Website Scraped Text:
${websiteContext}

Extract and audit the following fields. Provide response strictly as JSON with key-value pairs matching these exact keys:

1. "article_title": The full title of the article. Use OpenAlex primarily.
2. "journal_name": The name of the publishing journal. Use OpenAlex primarily.
3. "authors": Formatted as "1 - [Name] [Surname]; 2 - [Name] [Surname]". Clean abnormal spaces and superscripts.
4. "affiliation_department": Format as "1 - [Dept]; 2 - [Dept]" matching the authorship order. Deduplicate identical departments.
5. "affiliation_college": Format as "1 - [College]; 2 - [College]" matching the authorship order.
6. "affiliation_university": Format as "1 - [University]; 2 - [University]" matching authorship order.
7. "affiliation_city": Deduplicate the list so no city is repeated. Format as a semicolon-separated string.
8. "affiliation_country": Deduplicate the list so no country is repeated. Format as a semicolon-separated string.
9. "orcid_ids": ORCID numbers in order of authorship.
10. "publisher": Name of publisher. You MUST extract this strictly from the OpenAlex or CrossRef metadata provided above. Do NOT use your training memory to guess the publisher.
11. "publisher_country": Country of publisher headquarters/issuance.
12. "special_issue": "Yes" or "No".
13. "study_design": Precise study design.
14. "reporting_guidelines": Scan the manuscript text for ANY mention of adherence to methodological frameworks, reporting standards, prior recommendations, or guidelines (e.g., PRISMA, CARE, STROBE, but also non-acronym statements like "conducted in accordance with the guidelines proposed by..."). If a guideline/standard is stated as followed, output its name or description. If none are mentioned, output "Not reported".
15. "ethics_approval": Determine if the study involves human/animal participants. If NO (e.g., review, bibliometric, editorial), output exactly "Not applicable". If YES, actively scan the text for Institutional Review Board (IRB), Institutional Ethics Committee (IEC), Ethical Clearance, or Animal Ethics approval statements. Extract the exact approval number or ID. If human/animal intervention is present but no approval is mentioned, state "Not reported".
16. "trial_registration": Mandatory for human/in vivo interventions. Mention registration number/registry. If non-human study, state "Not applicable". If clinical study without trial ID, state "Not reported".
17. "protocol_registration": Scan the manuscript text and reference list for protocol registrations (e.g., OSF, PROSPERO, ClinicalTrials.gov, INPLASY). Look explicitly for protocol DOIs (e.g., 10.17605/OSF.IO/...) or registry URLs. Extract the exact DOI, link, or registration number. If not found, output "Not reported".
18. "received_date": Aggressively scan the PDF's extreme vertical margins, footnotes, copyright headers, and title-page text for the exact "Received", "Submitted", or "Recibido" date. Extract the raw date text verbatim. If missing, output "Not reported".
19. "accepted_date": Aggressively scan the PDF's margins, footnotes, and headers for the exact "Accepted", "Revised", or "Aceptado" date. Extract the raw date text verbatim. If missing, output "Not reported".
20. "published_date": Use the OpenAlex or CrossRef publication date as your primary source. Also check the PDF and scraped website text for "Published", "Available online", or "Publicado". Extract the raw date text verbatim. If missing, output "Not reported".
21. "scientific_syntax": Actively count instances of spelling errors (ignoring standard UK/US variations), subject-verb agreement failures, and verb-tense inconsistencies. Apply this exact quantitative grading system: 0 to 5 total errors = "[Acceptable]". 6 to 15 total errors = "[Average]". More than 15 total errors = "[Poor]".
22. "funding": "Yes" or "No".
23. "journal_self_citation_percentage": Estimated percentage of references citing the publishing journal itself.
24. "tortured_phrases": List any tortured phrases (paraphrasing tool artifacts) identified. If none, state "None".
25. "hallucinated_references": List suspicious or non-existent references by number. If none found, state "None".
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
          {
            inline_data: {
              mime_type: "application/pdf",
              data: pdfBase64
            }
          },
          { text: promptText }
        ]
      });
    } else {
      contents.push({
        role: "user",
        parts: [{ text: promptText }]
      });
    }

    const payload = {
      contents: contents,
      generationConfig: {
        responseMimeType: "application/json"
      }
    };

    const response = await fetch(geminiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const data = await response.json();

    if (data.error) {
      throw new Error(data.error.message || 'Gemini API Error');
    }

    const jsonText = data.candidates[0].content.parts[0].text;
    const result = JSON.parse(jsonText);

    // Compute integer day gaps using the new, highly robust JavaScript cleaning function
    result.received_to_accepted_days = calculateDaysRobust(result.received_date, result.accepted_date);
    result.accepted_to_published_days = calculateDaysRobust(result.accepted_date, result.published_date);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(result)
    };

  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message || 'Internal Extraction Error' })
    };
  }
};
