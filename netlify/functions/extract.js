const fetch = require('node-fetch');

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

    // Direct Gemini API Endpoint (using gemini-1.5-flash-lite / flash-lite)
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-lite:generateContent?key=${apiKey}`;

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
15. "received_to_accepted_days": Integer number of days between received and accepted dates, or "Not reported".
16. "accepted_to_published_days": Integer number of days between accepted and published dates, or "Not reported".
17. "credit_taxonomy": CRediT roles statement if reported, else "Not reported".
18. "funding": "Yes" or "No".
19. "journal_self_citation_percentage": Estimated percentage of references in this paper citing the publishing journal itself.
20. "tortured_phrases": List any tortured phrases (paraphrasing tool artifacts) identified in the text, separated by commas. If none, state "None".
21. "hallucinated_references": Check reference list DOIs, titles, and journal details. List suspicious or non-existent references by number (e.g., "Ref 14 - Invalid DOI / Title mismatch"). If none found, state "None".
`;

    const contents = [];

    // Add PDF inline data if supplied
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