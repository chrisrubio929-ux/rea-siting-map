// Netlify serverless function.
// Holds the Anthropic API key (never exposed to the browser) and the
// site-plan analysis prompt. The frontend posts the image; this returns zones.

const SYSTEM_PROMPT = `You are an expert CRE analyst specializing in EV charging siting at retail centers. You are given a SITE PLAN image. Identify the distinct parking fields, pad sites, and drive-aisle zones, and assess each for EV charging viability.

Return ONLY a valid JSON object, no markdown fences, with this schema:
{
  "imageNote": "one line on what the site plan shows",
  "zones": [
    {
      "label": "short zone name (e.g. 'East parking field', 'Pad sites — hwy frontage')",
      "viability": "Best | Conditional | No-go",
      "controllingParty": "best guess at who controls this area, or 'Unknown — confirm in REA'",
      "approval": "what approval would likely be needed, or a short note",
      "x": 0.0, "y": 0.0, "w": 0.0, "h": 0.0
    }
  ]
}

x, y, w, h are the zone's bounding box as fractions (0 to 1) of the image width/height: x,y = top-left corner, w,h = width,height. Place boxes over the actual parking areas you can see. Create 3 to 7 zones. Pad sites and open parking fields away from anchor-store frontage are usually 'Best'; large shared fields needing multi-party approval are 'Conditional'; drive aisles and fire lanes are 'No-go'. Be realistic about positions based on what the image actually shows.

If an REA ANALYSIS is provided, use its real findings — name the ACTUAL controlling parties and the ACTUAL approval requirements from the analysis in each zone's controllingParty and approval fields, and let its control zones and viability ratings guide your Best/Conditional/No-go calls. Do not invent parties when the analysis names them.`;

export default async (req) => {
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return json({ error: "Server is missing ANTHROPIC_API_KEY. Add it in Netlify environment variables." }, 500);
  }
  try {
    const { imageBase64, mediaType, analysis } = await req.json();
    if (!imageBase64) return json({ error: "No image provided." }, 400);

    const content = [
      { type: "image", source: { type: "base64", media_type: mediaType || "image/png", data: imageBase64 } },
    ];
    if (analysis) {
      content.push({
        type: "text",
        text: "REA ANALYSIS of this property (use its real parties and approval rules):\n" + JSON.stringify(analysis),
      });
    }
    content.push({ type: "text", text: "Analyze this site plan and return the zones JSON." });

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 4000,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content }],
      }),
    });
    const data = await r.json();
    return json(data, r.status);
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
};

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { "Content-Type": "application/json" },
  });
}

export const config = { path: "/api/draft-zones" };
