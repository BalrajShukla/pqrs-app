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

// Helper function to compute integer days using STRICT YYYY-MM-DD format
function calculateDaysBetweenISO(dateStr1, dateStr2) {
  if (!dateStr1 || !dateStr2 || dateStr1 === "Not reported" || dateStr2 === "Not reported") {
    return "Not reported";
  }
  
  const d1 = new Date(dateStr1);
  const d2 = new Date(dateStr2);

  if (isNaN(d1.getTime()) || isNaN(d2.getTime())) {
    return "Not reported";
  }

  const diffTime = d2.getTime() - d1.getTime();
  const diffDays = Math.round(diffTime / (1000 * 60 * 60 * 24));
  return diffDays >= 0 ? diffDays : "Not reported"; 
}

// Helper function to scrape the publisher's website text via the DOI
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

// NEW: Helper function to fetch OpenAlex Data natively
async function fetchOpenAlexData(doi) {
  if (!doi) return null;
  try {
    // The polite pool simply adds a mailto header, preventing rate limits
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

    // Strict PubMed and PMC check via OpenAlex IDs
    const isPubMed = (openAlexData && openAlexData.ids && openAlexData.ids.pmid) ? "Yes" : "No";
    const isPmc = (openAlexData && openAlexData.ids && openAlexData.ids.pmcid) ? "Yes" : "No";

    // --- EXTRACT CROSSREF DATES FOR BACKUP ---
    let crossrefPubDate = "Not reported in CrossRef";
    const crPub = crossrefData?.published || crossrefData?.['published-online'] || crossrefData?.['published-print'];
    if (crPub && crPub['date-parts'] && crPub['date-parts'][0]) {
      const parts = crPub['date-parts'][0];
      const y = parts[0];
      const m = parts[1] ? String(parts[1]).padStart(2, '0') : '01';
      const d = parts[2] ? String(parts[2]).padStart(2, '0') : '01';
      crossrefPubDate = `${y}-${m}-${d}`;
    }

    // --- DETERMINISTIC ISSN INDEXING CHECK ---
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
You are an expert research integrity auditor and bibliometrician specializing in dental/stomatology literature.
Analyze the attached manuscript PDF along with the CrossRef metadata, the OpenAlex database metadata, and the scraped Website Context provided below.

INSTRUCTION: Use the OpenAlex metadata as your primary source of truth for identifiers and affiliations. If OpenAlex is missing data, incomplete, or null, default to reading the PDF manuscript to extract the needed details.

OpenAlex Metadata:
${JSON.stringify(openAlexData || {})}

CrossRef Metadata:
${JSON.stringify(crossrefData || {})}
Note: CrossRef official database publication date is strictly: ${crossrefPubDate}

Publisher Website Scraped Text:
${websiteContext}

Extract and audit the following fields. Provide response strictly as JSON with key-value pairs matching these exact keys:

1. "article_title": The full title of the article. Use OpenAlex primarily.
2. "journal_name": The name of the publishing journal. Use OpenAlex primarily.
3. "authors": Formatted as "1 - [Name] [Surname]; 2 - [Name] [Surname]". Clean abnormal spaces and superscripts.
4. "affiliation_department": Departments. Format as "1 - [Dept]; 2 - [Dept]" matching the exact authorship order. Deduplicate identical or synonymous departments. If private clinic, state clinic name.
5. "affiliation_college": Colleges. Format as "1 - [College]; 2 - [College]" matching the exact authorship order.
6. "affiliation_university": Universities. Format as "1 - [University]; 2 - [University]" matching authorship order.
7. "affiliation_city": Identify the cities for all authors. You MUST deduplicate the list so no city is repeated. Format as a semicolon-separated string (e.g., "Ahmedabad; New York").
8. "affiliation_country": Identify the countries for all authors. You MUST deduplicate the list so no country is repeated. Format as a semicolon-separated string (e.g., "India; United States").
9. "orcid_ids": ORCID numbers in order of authorship, or "Not reported". Use OpenAlex primarily.
10. "publisher": Name of publisher.
11. "publisher_country": Country of publisher headquarters/issuance.
12. "special_issue": "Yes" or "No" (Check for supplement, special issue, special section).
13. "study_design": Precise study design (e.g., Randomized Controlled Trial, In Vitro, Systematic Review, Cross-sectional).
14. "reporting_guidelines": State if reporting guidelines (e.g., CONSORT, PRISMA, STROBE) were reported AND if actually followed correctly (e.g., "Reported and Followed", "Reported but Not Followed", or "Not Reported").
15. "ethics_approval": Determine if the study involves an intervention on human/animal participants. If the article DOES NOT involve human/animal participants (e.g., a review article, bibliometric study, or editorial), you MUST output exactly "Not applicable". If it does involve interventions, state the ethics approval statement with reference number. If human/animal intervention is present but no approval is mentioned, state "Not reported".
16. "trial_registration": Mandatory for human/in vivo interventions. Mention registration number/registry. If non-human study, state "Not applicable". If clinical study without trial ID, state "Not reported".
17. "received_date_iso": Search the PDF manuscript, the CrossRef metadata, AND the Publisher Website Scraped Text for the exact "Received" or "Submitted" date. Format strictly as YYYY-MM-DD. If missing, output "Not reported".
18. "accepted_date_iso": Search the PDF manuscript, the CrossRef metadata, AND the Publisher Website Scraped Text for the exact "Accepted" or "Revised" date. Format strictly as YYYY-MM-DD. If missing, output "Not reported".
19. "published_date_iso": Search the PDF manuscript, the Publisher Website Scraped Text, AND the CrossRef publication date for the "Published" or "Available online" date. Format strictly as YYYY-MM-DD. If missing, output "Not reported".
20. "scientific_syntax": Give a qualitative rating of exactly "[Poor]", "[Average]", or "[Acceptable]" based on your analysis of spelling errors (both American and British spellings are acceptable), subject-verb agreement, and verb-tense consistency throughout the manuscript text.
21. "funding": "Yes" or "No".
22. "journal_self_citation_percentage": Estimated percentage of references in this paper citing the publishing journal itself.
23. "tortured_phrases": List any tortured phrases (paraphrasing tool artifacts) identified in the text, separated by commas. If none, state "None".
24. "hallucinated_references": Check reference list DOIs, titles, and journal details. List suspicious or non-existent references by number. If none found, state "None".
25. "pubmed": "Output EXACTLY this string, do not alter it: ${isPubMed}"
26. "pmc": "Output EXACTLY this string, do not alter it: ${isPmc}"
27. "scopus": "Output EXACTLY this string, do not alter it: ${isScopus}"
28. "embase": "Output EXACTLY this string, do not alter it: ${isEmbase}"
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

    // Compute integer day gaps flawlessly
    result.received_to_accepted_days = calculateDaysBetweenISO(result.received_date_iso, result.accepted_date_iso);
    result.accepted_to_published_days = calculateDaysBetweenISO(result.accepted_date_iso, result.published_date_iso);

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
