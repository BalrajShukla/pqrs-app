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

// Helper function to compute integer days between two date strings deterministically
function calculateDaysBetween(dateStr1, dateStr2) {
  if (!dateStr1 || !dateStr2 || dateStr1 === "Not reported" || dateStr2 === "Not reported") {
    return "Not reported";
  }
  
  // Clean ordinal suffixes (e.g., '12th May' -> '12 May')
  const cleanStr1 = String(dateStr1).replace(/(\d+)(st|nd|rd|th)/i, '$1').trim();
  const cleanStr2 = String(dateStr2).replace(/(\d+)(st|nd|rd|th)/i, '$1').trim();

  const d1 = new Date(cleanStr1);
  const d2 = new Date(cleanStr2);

  if (isNaN(d1.getTime()) || isNaN(d2.getTime())) {
    return "Not reported";
  }

  const diffTime = d2.getTime() - d1.getTime();
  const diffDays = Math.round(diffTime / (1000 * 60 * 60 * 24));
  return diffDays >= 0 ? diffDays : "Not reported";
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

    // --- DETERMINISTIC ISSN INDEXING CHECK ---
    let isScopus = "No";
    let isEmbase = "No";

    const manuscriptIssns = crossrefData?.ISSN || [];
    const cleanManuscriptIssns = manuscriptIssns.map(issn => issn.replace(/[^0-9X]/gi, '').toUpperCase());

    if (cleanManuscriptIssns.length > 0) {
      if (cleanManuscriptIssns.some(issn => scopusMasterList.includes(issn))) {
        isScopus = "Yes";
      }
      if (cleanManuscriptIssns.some(issn => embaseMasterList.includes(issn))) {
        isEmbase = "Yes";
      }
    }

    // --- GEMINI EXTRACTION ---
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-lite-latest:generateContent?key=${apiKey}`;

    const promptText = `
You are an expert research integrity auditor and bibliometrician specializing in dental/stomatology literature.
Analyze the attached manuscript PDF along with the CrossRef metadata provided below.

CrossRef Metadata:
${JSON.stringify(crossrefData || {})}

Extract and audit the following fields. Provide response strictly as JSON with key-value pairs matching these exact keys:

1. "authors": Formatted as "1 - [Name] [Surname]; 2 - [Name] [Surname]". Clean abnormal spaces and superscripts.
2. "affiliation_department": Departments in order of authorship. Deduplicate identical or synonymous departments (e.g., "Pedodontics" and "Pediatric Dentistry"). Format as semicolon separated string. If private clinic, state clinic name.
3. "affiliation_college": College names in authorship order, semicolon separated.
4. "affiliation_university": University names in authorship order. If missing in PDF, infer based on known college affiliation.
5. "affiliation_city": City names in authorship order, semicolon separated.
6. "affiliation_country": Country names in authorship order, semicolon separated.
7. "orcid_ids": ORCID numbers in order of authorship, or "Not reported".
8. "publisher": Name of publisher.
9. "publisher_country": Country of publisher headquarters/issuance.
10. "special_issue": "Yes" or "No" (Check for supplement, special issue, special section).
11. "study_design": Precise study design (e.g., Randomized Controlled Trial, In Vitro, Systematic Review, Cross-sectional).
12. "reporting_guidelines": State if reporting guidelines (e.g., CONSORT, PRISMA, STROBE) were reported AND if actually followed correctly (e.g., "Reported and Followed", "Reported but Not Followed", or "Not Reported").
13. "ethics_approval": State ethics approval statement with reference number. If mentioned without number state "Mentioned without approval number". If absent, state "Not reported".
14. "trial_registration": Mandatory for human/in vivo interventions. Mention registration number/registry. If non-human study, state "Not applicable". If clinical study without trial ID, state "Not reported".
15. "received_date": Exact string of the "Received" or "Submitted" date as printed in the PDF or CrossRef metadata. If missing, output "Not reported".
16. "accepted_date": Exact string of the "Accepted" or "Revised" date as printed in the PDF or CrossRef metadata. If missing, output "Not reported".
17. "published_date": Exact string of the "Published" or "Available online" date as printed in the PDF or CrossRef metadata. If missing, output "Not reported".
18. "credit_taxonomy": CRediT roles statement if reported, else "Not reported".
19. "funding": "Yes" or "No".
20. "journal_self_citation_percentage": Estimated percentage of references in this paper citing the publishing journal itself.
21. "tortured_phrases": List any tortured phrases (paraphrasing tool artifacts) identified in the text, separated by commas. If none, state "None".
22. "hallucinated_references": Check reference list DOIs, titles, and journal details. List suspicious or non-existent references by number (e.g., "Ref 14 - Invalid DOI / Title mismatch"). If none found, state "None".
23. "scopus": "Output EXACTLY this string, do not alter it: ${isScopus}"
24. "embase": "Output EXACTLY this string, do not alter it: ${isEmbase}"
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

    // Compute integer day gaps in JavaScript
    result.received_to_accepted_days = calculateDaysBetween(result.received_date, result.accepted_date);
    result.accepted_to_published_days = calculateDaysBetween(result.accepted_date, result.published_date);

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
