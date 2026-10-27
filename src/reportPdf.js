// Builds a branded, multi-page PDF of the REA analysis + the marked-up site plan.
// The analysis is drawn as real (selectable) text so it's crisp at any zoom;
// the site plan is captured as an image snapshot so the colored zones appear
// exactly as positioned on screen.
import jsPDF from "jspdf";
import html2canvas from "html2canvas";

const BRAND = {
  green: "#003F2D", darkGreen: "#012A2D", sage: "#538184",
  amber: "#E8A33D", red: "#C0392B", grey: "#435254", cement: "#7F8480",
  light: "#EFECD2",
};

// Snapshot a DOM element (the map stage) to a PNG data URL.
export async function captureElement(el) {
  if (!el) return null;
  const canvas = await html2canvas(el, { backgroundColor: "#000", scale: 2, useCORS: true, logging: false });
  return canvas.toDataURL("image/png");
}

// Load an image URL (e.g. the banner in /public) into a data URL for jsPDF.
async function loadImageDataUrl(url) {
  try {
    const resp = await fetch(url);
    const blob = await resp.blob();
    return await new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(r.result);
      r.onerror = rej;
      r.readAsDataURL(blob);
    });
  } catch (e) { return null; }
}

export async function generateReportPdf({ analysis, propName, propAddr, mapImage, zones }) {
  const doc = new jsPDF({ unit: "pt", format: "letter" }); // 612 x 792 pt
  const PW = 612, PH = 792, M = 48;
  const CW = PW - M * 2;
  let y = 0;

  const hex = (h) => h;
  const setFill = (h) => { const n = parseInt(h.slice(1), 16); doc.setFillColor((n >> 16) & 255, (n >> 8) & 255, n & 255); };
  const setText = (h) => { const n = parseInt(h.slice(1), 16); doc.setTextColor((n >> 16) & 255, (n >> 8) & 255, n & 255); };

  // page break helper
  const need = (h) => { if (y + h > PH - M) { doc.addPage(); y = M; } };

  // ---- Clean solid header band (no photo; readability first) ----
  const HB = 76;
  setFill(BRAND.darkGreen); doc.rect(0, 0, PW, HB, "F");
  // thin mint accent rule along the bottom of the band
  setFill("#17E88F"); doc.rect(0, HB, PW, 2.5, "F");

  doc.setTextColor(255, 255, 255);
  doc.setFont("helvetica", "bold"); doc.setFontSize(20);
  doc.text("CBRE", M, 36);
  setText("#17E88F"); doc.setFont("helvetica", "normal"); doc.setFontSize(8);
  doc.text("EV INFRASTRUCTURE SOLUTIONS", M, 52);
  doc.setTextColor(255, 255, 255); doc.setFont("helvetica", "normal"); doc.setFontSize(8.5);
  doc.text("REA / OEA EV SITING ANALYSIS", PW - M, 36, { align: "right" });
  const today = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
  doc.text(today, PW - M, 52, { align: "right" });

  // ---- Title block (below the band, on white) ----
  y = HB + 36;
  setText(BRAND.darkGreen); doc.setFont("helvetica", "bold"); doc.setFontSize(19);
  const titleLines = doc.splitTextToSize(propName || "Untitled Property", CW);
  titleLines.forEach((ln) => { doc.text(ln, M, y); y += 23; });
  if (propAddr) { setText(BRAND.cement); doc.setFont("helvetica", "normal"); doc.setFontSize(11); doc.text(propAddr, M, y); y += 18; }
  y += 10;

  // section title helper
  const sectionTitle = (num, title) => {
    need(40); y += 8;
    setText(BRAND.sage); doc.setFont("helvetica", "normal"); doc.setFontSize(9); doc.text(num, M, y);
    setText(BRAND.green); doc.setFont("helvetica", "bold"); doc.setFontSize(14); doc.text(title, M + 26, y);
    y += 6; setFill(BRAND.green); doc.rect(M, y, CW, 1.5, "F"); y += 16;
  };
  // Normalize AI punctuation: em/en dashes -> hyphen, smart quotes -> straight.
  const clean = (t) => String(t == null ? "" : t)
    .replace(/\s*[—–]\s*/g, " - ")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/…/g, "...");
  const para = (text, color, size) => {
    setText(color || BRAND.grey); doc.setFont("helvetica", "normal"); doc.setFontSize(size || 10.5);
    const lines = doc.splitTextToSize(clean(text), CW);
    lines.forEach((ln) => { need(16); doc.text(ln, M, y); y += 15; });
  };
  const labelVal = (label, value) => {
    setText(BRAND.darkGreen); doc.setFont("helvetica", "bold"); doc.setFontSize(10.5);
    const head = doc.splitTextToSize(clean(label), CW);
    head.forEach((ln) => { need(15); doc.text(ln, M, y); y += 14; });
    if (value) para(value, BRAND.grey, 10);
    y += 4;
  };
  const chip = (text, color, x, yy) => {
    doc.setFont("helvetica", "bold"); doc.setFontSize(8);
    const w = doc.getTextWidth(text) + 12;
    setFill(color); doc.roundedRect(x, yy - 9, w, 13, 3, 3, "F");
    doc.setTextColor(255, 255, 255); doc.text(text, x + 6, yy);
    return w;
  };

  // ---- Site plan snapshot (if present) ----
  if (mapImage) {
    sectionTitle("", "Site Plan: Potential EV Charging Zones");
    try {
      const props = doc.getImageProperties(mapImage);
      const imgW = CW;
      const imgH = (props.height / props.width) * imgW;
      const drawH = Math.min(imgH, PH - M - y - 40);
      const drawW = (props.width / props.height) * drawH;
      need(drawH + 24);
      doc.addImage(mapImage, "PNG", M, y, drawW > CW ? CW : drawW, drawW > CW ? (props.height / props.width) * CW : drawH);
      y += (drawW > CW ? (props.height / props.width) * CW : drawH) + 12;
    } catch (e) { para("(Site plan image could not be embedded.)", BRAND.cement, 9); }

    // color key
    need(20);
    let kx = M;
    kx += chip("Best", BRAND.green, kx, y) + 8;
    kx += chip("Conditional", BRAND.amber, kx, y) + 8;
    kx += chip("No-go", BRAND.red, kx, y) + 8;
    y += 18;

    if (zones && zones.length) {
      y += 6;
      setText(BRAND.darkGreen); doc.setFont("helvetica", "bold"); doc.setFontSize(9); need(14);
      doc.text("ZONE DETAIL", M, y); y += 14;
      zones.forEach((z) => {
        need(22);
        const v = z.viability === "Best" ? BRAND.green : z.viability === "Conditional" ? BRAND.amber : BRAND.red;
        setFill(v); doc.circle(M + 4, y - 3, 3.2, "F");
        setText(BRAND.darkGreen); doc.setFont("helvetica", "bold"); doc.setFontSize(10.5);
        const labelLines = doc.splitTextToSize(clean(z.label || "Zone") + "  (" + (z.viability || "") + ")", CW - 16);
        labelLines.forEach((l, i) => { need(14); doc.text(l, M + 14, y); y += 13; });
        setText(BRAND.grey); doc.setFont("helvetica", "normal"); doc.setFontSize(9.5);
        if (z.controllingParty) { const ln = doc.splitTextToSize("Controlled by: " + clean(z.controllingParty), CW - 16); ln.forEach((l) => { need(12); doc.text(l, M + 14, y); y += 12; }); }
        if (z.approval) { const ln = doc.splitTextToSize("Approval: " + clean(z.approval), CW - 16); ln.forEach((l) => { need(12); doc.text(l, M + 14, y); y += 12; }); }
        y += 8;
      });
    } else {
      para("No zones were drafted on the site plan. Add zones on the Map step to include them here.", BRAND.cement, 9.5);
    }
  }

  const a = analysis || {};

  // 01 Property Summary
  if (a.propertySummary) { sectionTitle("01", "Property Summary"); para(a.propertySummary);
    if (a.documentsReviewed?.length) { y += 4; setText(BRAND.darkGreen); doc.setFont("helvetica", "bold"); doc.setFontSize(9); need(14); doc.text("DOCUMENTS REVIEWED", M, y); y += 13; a.documentsReviewed.forEach((d) => para("• " + d, BRAND.grey, 10)); }
  }
  // 02 Parties
  if (a.parties?.length) { sectionTitle("02", "Controlling Parties"); a.parties.forEach((p) => { labelVal(`${p.name}  |  ${p.role || ""}`, p.controlsAreas); }); }
  // 03 Control Zones — title on its own line(s), chip on the line below (no overlap)
  if (a.controlZones?.length) { sectionTitle("03", "Control Zones & EV Viability"); a.controlZones.forEach((z) => {
    need(34);
    setText(BRAND.darkGreen); doc.setFont("helvetica", "bold"); doc.setFontSize(11.5);
    const tl = doc.splitTextToSize(clean(z.zone || "Zone"), CW); tl.forEach((l) => { need(16); doc.text(l, M, y); y += 15; });
    const vc = z.evViable === "Yes" ? BRAND.green : z.evViable === "Conditional" ? BRAND.amber : BRAND.red;
    y += 2; chip("EV viability: " + (z.evViable || "?"), vc, M, y); y += 16;
    if (z.controllingParty) para("Controlled by: " + z.controllingParty, BRAND.grey, 9.5);
    if (z.rationale) para(z.rationale, BRAND.grey, 10);
    if (z.constraints) para("Constraint: " + z.constraints, BRAND.orange, 9.5);
    y += 10;
  }); }
  // 04 Approval Matrix
  if (a.approvalMatrix?.length) { sectionTitle("04", "Approval Matrix"); a.approvalMatrix.forEach((m) => {
    need(34); setText(BRAND.darkGreen); doc.setFont("helvetica", "bold"); doc.setFontSize(11);
    const h = doc.splitTextToSize(clean(m.action || ""), CW); h.forEach((l) => { need(15); doc.text(l, M, y); y += 14; });
    const dc = m.difficulty === "Low" ? BRAND.sage : m.difficulty === "Medium" ? BRAND.amber : BRAND.red;
    y += 2; chip((m.difficulty || "?") + " effort", dc, M, y); y += 16;
    if (m.approvalRequired) para("Approval required: " + m.approvalRequired, BRAND.grey, 10);
    if (m.basis) para("Basis: " + m.basis, BRAND.grey, 9.5);
    y += 10;
  }); }
  // 05 EV Restrictions — chip on its own line above the topic (no overlap)
  if (a.evRestrictions?.length) { sectionTitle("05", "EV-Relevant REA Language"); a.evRestrictions.forEach((r) => {
    need(32); const rc = r.type === "Permitted" ? BRAND.green : r.type === "Silent" ? BRAND.cement : r.type === "Restricted" ? BRAND.amber : BRAND.red;
    chip(r.type || "?", rc, M, y); y += 16;
    setText(BRAND.darkGreen); doc.setFont("helvetica", "bold"); doc.setFontSize(11);
    const tp = doc.splitTextToSize(clean(r.topic || ""), CW); tp.forEach((l) => { need(15); doc.text(l, M, y); y += 14; });
    if (r.detail) para(r.detail, BRAND.grey, 10);
    y += 10;
  }); }
  // 06 Recommended Zones
  if (a.recommendedZones?.length) { sectionTitle("06", "Recommended Zones"); a.recommendedZones.forEach((z, i) => {
    need(16); setText(BRAND.green); doc.setFont("helvetica", "bold"); doc.setFontSize(10); doc.text(String(i + 1).padStart(2, "0"), M, y);
    para2(doc, clean(z), M + 22, CW - 22, () => y, (ny) => { y = ny; }, need, BRAND.grey);
    y += 4;
  }); }
  // Risks + Next steps
  if (a.risks?.length) { sectionTitle("", "Risks & Unknowns"); a.risks.forEach((r) => para("• " + r, BRAND.grey, 10)); }
  if (a.nextSteps?.length) { sectionTitle("", "Next Steps"); a.nextSteps.forEach((s, i) => para(`${i + 1}. ${s}`, BRAND.grey, 10)); }

  // ---- Footer band on every page (sage-grey, matching the site footer) ----
  const pages = doc.getNumberOfPages();
  const FB = 44; // footer band height
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    setFill(BRAND.cement); doc.rect(0, PH - FB, PW, FB, "F");
    doc.setTextColor(255, 255, 255);
    doc.setFont("helvetica", "bold"); doc.setFontSize(8);
    doc.text("Created by Chris Rubio  |  chris.rubio2@cbre.com  |  linkedin.com/in/rubio-chris", M, PH - 28);
    doc.setFont("helvetica", "normal"); doc.setFontSize(7);
    doc.text("Preliminary analysis only. Not legal advice. Confirm all findings against the executed REA with counsel.", M, PH - 18);
    doc.setFontSize(7);
    doc.text(`© ${new Date().getFullYear()} CBRE, Inc. All Rights Reserved. Confidential & Proprietary.`, M, PH - 9);
    doc.setFontSize(8);
    doc.text(`${p} / ${pages}`, PW - M, PH - 18, { align: "right" });
    // clickable LinkedIn
    doc.link(M + 196, PH - 34, 120, 11, { url: "https://www.linkedin.com/in/rubio-chris/" });
  }

  const safe = (propName || "REA-Analysis").replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "");
  doc.save(`${safe}-EV-Siting-Report.pdf`);
}

// small helper for a wrapped indented paragraph with external y control
function para2(doc, text, x, w, getY, setY, need, color) {
  const n = parseInt(color.slice(1), 16);
  doc.setTextColor((n >> 16) & 255, (n >> 8) & 255, n & 255);
  doc.setFont("helvetica", "normal"); doc.setFontSize(10);
  const lines = doc.splitTextToSize(text || "", w);
  lines.forEach((ln) => { need(14); doc.text(ln, x, getY()); setY(getY() + 14); });
}
