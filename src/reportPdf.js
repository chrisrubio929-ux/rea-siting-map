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

  // ---- Header band with the banner photo ----
  const HB = 92; // header band height
  const banner = await loadImageDataUrl("/banner.jpg");
  if (banner) {
    try {
      // cover-fit the banner across the full width of the band
      const props = doc.getImageProperties(banner);
      const scale = Math.max(PW / props.width, HB / props.height);
      const w = props.width * scale, h = props.height * scale;
      doc.addImage(banner, "JPEG", (PW - w) / 2, (HB - h) / 2, w, h);
    } catch (e) { setFill(BRAND.darkGreen); doc.rect(0, 0, PW, HB, "F"); }
  } else { setFill(BRAND.darkGreen); doc.rect(0, 0, PW, HB, "F"); }
  // dark gradient-style overlay (left solid -> lighter right) for legible text
  setFill(BRAND.darkGreen);
  doc.setGState && doc.setGState(new doc.GState({ opacity: 0.72 }));
  doc.rect(0, 0, PW * 0.62, HB, "F");
  doc.setGState && doc.setGState(new doc.GState({ opacity: 0.45 }));
  doc.rect(PW * 0.62, 0, PW * 0.38, HB, "F");
  doc.setGState && doc.setGState(new doc.GState({ opacity: 1 }));

  doc.setTextColor(255, 255, 255);
  doc.setFont("helvetica", "bold"); doc.setFontSize(22);
  doc.text("CBRE", M, 42);
  doc.setFont("helvetica", "normal"); doc.setFontSize(9);
  setText("#17E88F"); doc.text("EV INFRASTRUCTURE SOLUTIONS", M, 58);
  doc.setTextColor(255, 255, 255); doc.setFontSize(9);
  doc.text("REA / OEA EV SITING ANALYSIS", PW - M, 42, { align: "right" });
  const today = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
  doc.text(today, PW - M, 58, { align: "right" });
  y = 120;

  // ---- Title ----
  setText(BRAND.green); doc.setFont("helvetica", "bold"); doc.setFontSize(20);
  doc.text(propName || "Untitled Property", M, y); y += 22;
  if (propAddr) { setText(BRAND.cement); doc.setFont("helvetica", "normal"); doc.setFontSize(11); doc.text(propAddr, M, y); y += 18; }
  y += 6;

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
      zones.forEach((z) => {
        need(18);
        const v = z.viability === "Best" ? BRAND.green : z.viability === "Conditional" ? BRAND.amber : BRAND.red;
        setFill(v); doc.circle(M + 4, y - 3, 3, "F");
        setText(BRAND.darkGreen); doc.setFont("helvetica", "bold"); doc.setFontSize(10);
        doc.text(clean(z.label || "Zone"), M + 14, y);
        setText(BRAND.cement); doc.setFont("helvetica", "normal"); doc.setFontSize(9);
        const meta = [z.controllingParty && `Controlled by: ${z.controllingParty}`, z.approval && `Approval: ${z.approval}`].filter(Boolean).join("   ");
        if (meta) { y += 13; const ln = doc.splitTextToSize(clean(meta), CW - 14); ln.forEach((l) => { need(13); doc.text(l, M + 14, y); y += 12; }); }
        y += 8;
      });
    }
  }

  const a = analysis || {};

  // 01 Property Summary
  if (a.propertySummary) { sectionTitle("01", "Property Summary"); para(a.propertySummary);
    if (a.documentsReviewed?.length) { y += 4; setText(BRAND.darkGreen); doc.setFont("helvetica", "bold"); doc.setFontSize(9); need(14); doc.text("DOCUMENTS REVIEWED", M, y); y += 13; a.documentsReviewed.forEach((d) => para("• " + d, BRAND.grey, 10)); }
  }
  // 02 Parties
  if (a.parties?.length) { sectionTitle("02", "Controlling Parties"); a.parties.forEach((p) => { labelVal(`${p.name}  |  ${p.role || ""}`, p.controlsAreas); }); }
  // 03 Control Zones
  if (a.controlZones?.length) { sectionTitle("03", "Control Zones & EV Viability"); a.controlZones.forEach((z) => {
    need(20); setText(BRAND.darkGreen); doc.setFont("helvetica", "bold"); doc.setFontSize(11); doc.text(clean(z.zone || "Zone"), M, y);
    const vc = z.evViable === "Yes" ? BRAND.green : z.evViable === "Conditional" ? BRAND.amber : BRAND.red;
    chip("EV: " + (z.evViable || "?"), vc, M + 220, y); y += 15;
    if (z.controllingParty) para("Controlled by: " + z.controllingParty, BRAND.cement, 9.5);
    if (z.rationale) para(z.rationale, BRAND.grey, 10);
    if (z.constraints) para("⚠ " + z.constraints, BRAND.amber, 9.5);
    y += 6;
  }); }
  // 04 Approval Matrix
  if (a.approvalMatrix?.length) { sectionTitle("04", "Approval Matrix"); a.approvalMatrix.forEach((m) => {
    need(18); setText(BRAND.green); doc.setFont("helvetica", "bold"); doc.setFontSize(10.5);
    const h = doc.splitTextToSize(clean(m.action || ""), CW - 90); h.forEach((l) => { need(14); doc.text(l, M, y); y += 13; });
    const dc = m.difficulty === "Low" ? BRAND.sage : m.difficulty === "Medium" ? BRAND.amber : BRAND.red;
    chip((m.difficulty || "?") + " effort", dc, M, y); y += 16;
    if (m.approvalRequired) para("Approval required: " + m.approvalRequired, BRAND.grey, 10);
    if (m.basis) para("Basis: " + m.basis, BRAND.cement, 9.5);
    y += 6;
  }); }
  // 05 EV Restrictions
  if (a.evRestrictions?.length) { sectionTitle("05", "EV-Relevant REA Language"); a.evRestrictions.forEach((r) => {
    need(16); const rc = r.type === "Permitted" ? BRAND.green : r.type === "Silent" ? BRAND.cement : r.type === "Restricted" ? BRAND.amber : BRAND.red;
    const cw = chip(r.type || "?", rc, M, y);
    setText(BRAND.darkGreen); doc.setFont("helvetica", "bold"); doc.setFontSize(10); doc.text(clean(r.topic || ""), M + cw + 8, y); y += 15;
    if (r.detail) para(r.detail, BRAND.grey, 10);
    y += 6;
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

  // ---- Footer on every page ----
  const pages = doc.getNumberOfPages();
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    // thin rule
    setFill(BRAND.light); doc.rect(M, PH - 42, CW, 0.8, "F");
    setText(BRAND.green); doc.setFont("helvetica", "bold"); doc.setFontSize(8);
    doc.text("Created by Chris Rubio  |  chris.rubio2@cbre.com  |  linkedin.com/in/rubio-chris", M, PH - 28);
    setText(BRAND.cement); doc.setFont("helvetica", "normal"); doc.setFontSize(7.5);
    doc.text("Preliminary analysis only. Not legal advice. Confirm all findings against the executed REA with counsel.", M, PH - 17);
    setText(BRAND.cement); doc.setFontSize(8);
    doc.text(`${p} / ${pages}`, PW - M, PH - 22, { align: "right" });
  }
  // make the LinkedIn text a clickable link on every page
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    doc.link(M + 196, PH - 36, 120, 12, { url: "https://www.linkedin.com/in/rubio-chris/" });
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
