// Netlify BACKGROUND function (filename ends in -background): runs up to 15
// minutes, so large REA packages never time out. It returns 202 immediately;
// the real result is written to the Supabase 'jobs' row, which the browser polls.

import { createClient } from "@supabase/supabase-js";

const SYSTEM_PROMPT = `You are an expert commercial real estate analyst specializing in Reciprocal Easement Agreements (REAs) and Operation & Easement Agreements (OEAs) and EV charging infrastructure siting at retail shopping centers. You analyze these agreements to determine where EV charging can be installed, who controls those areas, and whose approval is required.

Return ONLY a valid JSON object — no preamble, no markdown fences — with this schema:
{
  "propertySummary": "2-3 sentence overview of the property and the agreement structure",
  "documentsReviewed": ["each document analyzed and what it changed"],
  "parties": [ { "name": "", "role": "", "controlsAreas": "" } ],
  "controlZones": [ { "zone": "", "controllingParty": "", "evViable": "Yes | Conditional | No", "rationale": "", "constraints": "" } ],
  "approvalMatrix": [ { "action": "", "approvalRequired": "", "basis": "", "difficulty": "Low | Medium | High" } ],
  "evRestrictions": [ { "type": "Permitted | Restricted | Silent | Prohibited", "topic": "", "detail": "" } ],
  "recommendedZones": ["ranked best zones for L3 charging, short reason each"],
  "risks": ["key risks or unknowns needing legal/owner review"],
  "nextSteps": ["concrete recommended actions in order"]
}

Be rigorous and conservative. If the agreement is silent, say so. Treat multiple documents as one agreement (base + amendments read as a chain, later overriding earlier). Note party changes across amendments. Flag anything illegible in risks.`;

export default async (req) => {
  // runs in background; the client already got a 202.
  let jobId, supaUrl, supaKey;
  try {
    const body = await req.json();
    jobId = body.jobId; supaUrl = body.supabaseUrl; supaKey = body.supabaseKey;
    const { documents, propInfo } = body;
    const supabase = createClient(supaUrl, supaKey);

    const apiKey = (process.env.ANTHROPIC_API_KEY || "").trim();
    if (!apiKey) throw new Error("Server is missing ANTHROPIC_API_KEY.");

    const content = [];
    documents.forEach((d, i) => {
      content.push({ type: "text", text: `--- Document ${i + 1} of ${documents.length}: "${d.name}" ---` });
      content.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: d.base64 } });
    });
    content.push({ type: "text", text: `The documents above make up one REA/OEA package${documents.length > 1 ? " (base plus amendments)" : ""}. Analyze it for EV charging siting. ${propInfo ? "Property context: " + propInfo : ""} Return only the JSON object.` });

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 6000, system: SYSTEM_PROMPT, messages: [{ role: "user", content }] }),
    });
    const data = await r.json();
    if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
    const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
    const match = text.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse((match ? match[0] : text).replace(/```json|```/g, "").trim());

    await supabase.from("jobs").update({ status: "done", result: parsed }).eq("id", jobId);
  } catch (err) {
    try {
      if (jobId && supaUrl && supaKey) {
        const supabase = createClient(supaUrl, supaKey);
        await supabase.from("jobs").update({ status: "error", error: String(err && err.message ? err.message : err) }).eq("id", jobId);
      }
    } catch (e) {}
  }
  return new Response("", { status: 202 });
};

export const config = { path: "/api/analyze-rea-background" };
