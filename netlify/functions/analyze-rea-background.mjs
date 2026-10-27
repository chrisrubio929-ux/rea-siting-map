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
  console.log("[analyze-rea-background] invoked");
  try {
    const body = await req.json();
    jobId = body.jobId; supaUrl = body.supabaseUrl; supaKey = body.supabaseKey;
    // docRefs: [{ name, url }] — PDFs uploaded to Supabase Storage. We download
    // them here (server-side) so large files never pass through the request body.
    const { docRefs, propInfo } = body;
    console.log(`[analyze-rea-background] jobId=${jobId} docRefs=${docRefs ? docRefs.length : "none"} supaUrl=${supaUrl ? "yes" : "no"} supaKey=${supaKey ? "yes" : "no"}`);
    const supabase = createClient(supaUrl, supaKey);
    // mark the job as running so the browser can tell it actually started
    await supabase.from("jobs").update({ status: "running" }).eq("id", jobId);

    const rawKey = process.env.ANTHROPIC_API_KEY || "";
    const apiKey = rawKey.trim();
    if (!apiKey) throw new Error("Server is missing ANTHROPIC_API_KEY.");

    if (!docRefs || !docRefs.length) throw new Error("No documents were provided to analyze.");

    // Download each PDF from its Supabase URL and base64-encode it server-side.
    const documents = [];
    for (let i = 0; i < docRefs.length; i++) {
      const ref = docRefs[i];
      console.log(`[analyze-rea-background] downloading doc ${i + 1}: ${ref.name}`);
      const fileResp = await fetch(ref.url);
      if (!fileResp.ok) throw new Error(`Could not download "${ref.name}" (status ${fileResp.status}).`);
      const buf = Buffer.from(await fileResp.arrayBuffer());
      documents.push({ name: ref.name, base64: buf.toString("base64") });
    }
    console.log(`[analyze-rea-background] downloaded ${documents.length} document(s), calling Anthropic`);

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
    if (data.error) {
      const reason = data.error.message || JSON.stringify(data.error);
      throw new Error(`[HTTP ${r.status}] ${reason}`);
    }
    const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
    const match = text.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse((match ? match[0] : text).replace(/```json|```/g, "").trim());

    console.log("[analyze-rea-background] analysis done, writing result");
    await supabase.from("jobs").update({ status: "done", result: parsed }).eq("id", jobId);
    console.log("[analyze-rea-background] result written OK");
  } catch (err) {
    const msg = String(err && err.message ? err.message : err);
    console.error("[analyze-rea-background] ERROR:", msg);
    try {
      if (jobId && supaUrl && supaKey) {
        const supabase = createClient(supaUrl, supaKey);
        await supabase.from("jobs").update({ status: "error", error: msg }).eq("id", jobId);
      }
    } catch (e) { console.error("[analyze-rea-background] failed to write error to jobs:", String(e)); }
  }
  return new Response("", { status: 202 });
};

// No custom `path` config: background functions are invoked at their canonical
// /.netlify/functions/analyze-rea-background path. A custom alias can prevent
// the background runner from firing, leaving jobs stuck at 'pending'.
