// Netlify serverless function — reads the REA document package and returns the
// six-section written analysis. Holds the Anthropic key server-side.

const SYSTEM_PROMPT = `You are an expert commercial real estate analyst specializing in Reciprocal Easement Agreements (REAs) and Operation & Easement Agreements (OEAs) and EV charging infrastructure siting at retail shopping centers. You analyze these agreements to determine where EV charging can be installed, who controls those areas, and whose approval is required.

Return ONLY a valid JSON object — no preamble, no markdown fences — with this schema:
{
  "propertySummary": "2-3 sentence plain-language overview of the property and the agreement structure",
  "documentsReviewed": ["each document analyzed and what it changed — e.g. 'Original OEA (1988)', 'Third Amendment (2005) — replaced site plan, changed Developer owner'"],
  "parties": [ { "name": "party name", "role": "e.g. Developer/Landlord, Anchor Tenant, Pad Owner", "controlsAreas": "which parking/common areas this party controls" } ],
  "controlZones": [ { "zone": "zone/parcel label", "controllingParty": "who controls it", "evViable": "Yes | Conditional | No", "rationale": "why", "constraints": "ADA, fire lane, drive aisle, utility notes if any" } ],
  "approvalMatrix": [ { "action": "specific action needed for EV install", "approvalRequired": "which party/parties must approve", "basis": "the clause or right that triggers this", "difficulty": "Low | Medium | High" } ],
  "evRestrictions": [ { "type": "Permitted | Restricted | Silent | Prohibited", "topic": "what it covers", "detail": "the relevant language or finding, paraphrased" } ],
  "recommendedZones": ["ranked best zones to pursue for L3 charging with a short reason each"],
  "risks": ["key risks or unknowns that need legal/owner review"],
  "nextSteps": ["concrete recommended actions in order"]
}

Be rigorous and conservative. If the agreement is silent on a topic, say so rather than assuming permission. Treat multiple documents as one agreement: a base OEA/REA plus amendments read as a chain, later amendments overriding earlier terms. Note any change of parties across amendments. Some documents are older scans — read them as best you can and flag anything illegible in risks.`;

export default async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return json({ error: "Server is missing ANTHROPIC_API_KEY." }, 500);
  try {
    const { documents, propInfo } = await req.json(); // documents: [{name, base64}]
    if (!documents || !documents.length) return json({ error: "No documents provided." }, 400);

    const content = [];
    documents.forEach((d, i) => {
      content.push({ type: "text", text: `--- Document ${i + 1} of ${documents.length}: "${d.name}" ---` });
      content.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: d.base64 } });
    });
    content.push({
      type: "text",
      text: `The documents above make up one REA/OEA package${documents.length > 1 ? " (base agreement plus amendments)" : ""}. Analyze it for EV charging siting. ${propInfo ? "Property context: " + propInfo : ""} Return only the JSON object.`,
    });

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 8000, system: SYSTEM_PROMPT, messages: [{ role: "user", content }] }),
    });
    const data = await r.json();
    return json(data, r.status);
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
};

function json(obj, status) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: { "Content-Type": "application/json" } });
}

export const config = { path: "/api/analyze-rea" };
