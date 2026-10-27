import React, { useState, useRef, useCallback, useEffect } from "react";
import { supabaseReady, supabaseUrl, supabaseAnonKey, saveProperty, listProperties, loadProperty, createJob, pollJob } from "./supabaseClient";
import * as pdfjsLib from "pdfjs-dist";
import pdfWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url";
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker;

const CBRE_LOGO = "/CBRE_logo.png";

const C = {
  green: "#003F2D", darkGreen: "#012A2D", darkGrey: "#435254", accent: "#17E88F",
  midnight: "#032842", sage: "#538184", celadon: "#80BBAD", wheat: "#DBD99A",
  cement: "#7F8480", wheatTint: "#EFECD2", celadonTint: "#C0D4CB",
  orange: "#D2785A", amber: "#E8A33D", red: "#C0392B", paper: "#FAFAF7", white: "#FFFFFF",
};

const VIABILITY = {
  Best: { color: C.green, label: "Best" },
  Conditional: { color: C.amber, label: "Conditional" },
  "No-go": { color: C.red, label: "No-go" },
};

let ZID = 1;
const newId = () => "z" + ZID++;
const clamp = (v, min) => Math.max(min || 0, Math.min(1, typeof v === "number" ? v : 0.1));

async function loadPdf(file) { const buf = await file.arrayBuffer(); return pdfjsLib.getDocument({ data: buf }).promise; }
async function renderPdfPage(pdf, pageNum, scale, maxPx) {
  const page = await pdf.getPage(pageNum);
  let viewport = page.getViewport({ scale });
  if (maxPx) { const e = Math.max(viewport.width, viewport.height); if (e > maxPx) viewport = page.getViewport({ scale: scale * (maxPx / e) }); }
  const canvas = document.createElement("canvas");
  canvas.width = viewport.width; canvas.height = viewport.height;
  await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
  return canvas.toDataURL("image/jpeg", 0.85);
}
function dataURLtoBlob(dataURL) {
  const [head, body] = dataURL.split(","); const mime = head.match(/:(.*?);/)[1];
  const bin = atob(body); const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}
const fileToBase64 = (file) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result.split(",")[1]); r.onerror = () => rej(new Error("read failed")); r.readAsDataURL(file); });

// Read an API response safely. If the server returned an HTML error page
// (e.g. a function timeout or size limit), give a clear message instead of
// a cryptic "Unexpected token '<'" JSON error.
async function readApiJson(resp) {
  const raw = await resp.text();
  let data;
  try { data = JSON.parse(raw); }
  catch {
    if (resp.status === 502 || resp.status === 504 || /timed out|timeout/i.test(raw)) {
      throw new Error("the request took too long (the document set is large). Try analyzing fewer documents at once — e.g. the base agreement plus only the most recent amendments.");
    }
    if (resp.status === 413 || /too large|payload/i.test(raw)) {
      throw new Error("the upload was too large for one request. Try fewer or smaller PDFs at once.");
    }
    throw new Error("the server returned an unexpected response (status " + resp.status + "). Try again, or with fewer documents.");
  }
  if (data.error) throw new Error(data.error.message || data.error);
  return data;
}
function extractJson(data) {
  const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
  const match = text.match(/\{[\s\S]*\}/);
  return JSON.parse((match ? match[0] : text).replace(/```json|```/g, "").trim());
}

const STEPS = ["Analysis", "Map", "Save"];

export default function App() {
  const [step, setStep] = useState(0);
  const [propName, setPropName] = useState("");
  const [propAddr, setPropAddr] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [library, setLibrary] = useState([]);

  const [reaFiles, setReaFiles] = useState([]);
  const [propInfo, setPropInfo] = useState("");
  const [analysis, setAnalysis] = useState(null);
  const [analyzing, setAnalyzing] = useState(false);

  const [imgSrc, setImgSrc] = useState(null);
  const [imgType, setImgType] = useState(null);
  const [imgBlob, setImgBlob] = useState(null);
  const [zones, setZones] = useState([]);
  const [selected, setSelected] = useState(null);
  const [pdfPages, setPdfPages] = useState(null);
  const [drafting, setDrafting] = useState(false);
  const [saving, setSaving] = useState(false);

  const reaRef = useRef();
  const planRef = useRef();
  const stageRef = useRef();
  const drag = useRef(null);

  useEffect(() => { refreshLibrary(); }, []);
  const refreshLibrary = async () => { if (!supabaseReady) return; try { setLibrary(await listProperties()); } catch (e) {} };

  const resetAll = () => {
    setStep(0); setPropName(""); setPropAddr(""); setError(""); setNotice("");
    setReaFiles([]); setPropInfo(""); setAnalysis(null);
    setImgSrc(null); setImgType(null); setImgBlob(null); setZones([]); setSelected(null); setPdfPages(null);
  };

  const runAnalysis = async () => {
    if (reaFiles.length === 0) { setError("Upload at least one REA/OEA document."); return; }
    setError(""); setAnalyzing(true);
    try {
      const documents = [];
      for (const f of reaFiles) documents.push({ name: f.name, base64: await fileToBase64(f) });

      if (supabaseReady) {
        // Background flow: no timeout, handles large document packages.
        const jobId = await createJob();
        await fetch("/api/analyze-rea-background", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jobId, documents, propInfo, supabaseUrl, supabaseKey: supabaseAnonKey }),
        });
        // poll until done (up to ~5 minutes)
        const started = Date.now();
        while (Date.now() - started < 5 * 60 * 1000) {
          await new Promise((r) => setTimeout(r, 3000));
          const job = await pollJob(jobId);
          if (job.status === "done") { setAnalysis(job.result); return; }
          if (job.status === "error") throw new Error(job.error || "analysis failed");
        }
        throw new Error("the analysis is taking unusually long. Try fewer documents, or check back shortly.");
      } else {
        // No database configured — use the direct (timeout-limited) endpoint.
        const resp = await fetch("/api/analyze-rea", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ documents, propInfo }) });
        const data = await readApiJson(resp);
        setAnalysis(extractJson(data));
      }
    } catch (e) { setError("Couldn't analyze the documents: " + e.message); }
    finally { setAnalyzing(false); }
  };

  const onPickPlan = async (file) => {
    if (!file) return;
    setError(""); setZones([]); setSelected(null); setImgSrc(null); setPdfPages(null);
    if (file.type === "application/pdf") {
      setDrafting(true);
      try {
        const pdf = await loadPdf(file);
        const thumbs = []; const n = Math.min(pdf.numPages, 30);
        for (let i = 1; i <= n; i++) thumbs.push(await renderPdfPage(pdf, i, 0.5, 400));
        if (thumbs.length === 1) await choosePage(pdf, 1); else setPdfPages({ pdf, thumbs });
      } catch (e) { setError("Couldn't read that PDF: " + e.message); }
      finally { setDrafting(false); }
      return;
    }
    setImgBlob(file); setImgType(file.type);
    const url = await new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(file); });
    setImgSrc(url);
  };
  const choosePage = async (pdf, pageNum) => {
    setDrafting(true);
    try {
      const url = await renderPdfPage(pdf, pageNum, 2.0, 1600);
      setImgSrc(url); setImgType("image/jpeg"); setImgBlob(dataURLtoBlob(url)); setPdfPages(null);
    } catch (e) { setError("Couldn't render that page: " + e.message); }
    finally { setDrafting(false); }
  };
  const autoDraft = async () => {
    if (!imgSrc) return;
    setError(""); setDrafting(true);
    try {
      const resp = await fetch("/api/draft-zones", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ imageBase64: imgSrc.split(",")[1], mediaType: imgType, analysis }) });
      const data = await readApiJson(resp);
      const parsed = extractJson(data);
      const drafted = (parsed.zones || []).map((z) => ({
        id: newId(), label: z.label || "Zone",
        viability: VIABILITY[z.viability] ? z.viability : "Conditional",
        controllingParty: z.controllingParty || "Unknown — confirm in REA", approval: z.approval || "",
        x: clamp(z.x), y: clamp(z.y), w: clamp(z.w, 0.05), h: clamp(z.h, 0.05),
      }));
      if (drafted.length === 0) setError("No clear parking zones found on this page. Make sure you picked the site-plan page, or add zones manually.");
      else setZones(drafted);
    } catch (e) { setError("Couldn't auto-draft zones: " + e.message + ". You can add zones manually."); }
    finally { setDrafting(false); }
  };

  const updateZone = (id, patch) => setZones((zs) => zs.map((z) => (z.id === id ? { ...z, ...patch } : z)));
  const removeZone = (id) => { setZones((zs) => zs.filter((z) => z.id !== id)); setSelected(null); };
  const addZone = () => { const z = { id: newId(), label: "New zone", viability: "Conditional", controllingParty: "Unknown — confirm in REA", approval: "", x: 0.35, y: 0.4, w: 0.3, h: 0.18 }; setZones((zs) => [...zs, z]); setSelected(z.id); };

  const onPointerDown = (e, id, mode) => {
    e.stopPropagation();
    const rect = stageRef.current.getBoundingClientRect();
    const z = zones.find((x) => x.id === id);
    drag.current = { id, mode, startX: e.clientX, startY: e.clientY, orig: { ...z }, rect };
    setSelected(id);
    window.addEventListener("pointermove", onPointerMove); window.addEventListener("pointerup", onPointerUp);
  };
  const onPointerMove = useCallback((e) => {
    const d = drag.current; if (!d) return;
    const dx = (e.clientX - d.startX) / d.rect.width, dy = (e.clientY - d.startY) / d.rect.height;
    if (d.mode === "move") updateZone(d.id, { x: Math.max(0, Math.min(1 - d.orig.w, d.orig.x + dx)), y: Math.max(0, Math.min(1 - d.orig.h, d.orig.y + dy)) });
    else updateZone(d.id, { w: Math.max(0.05, Math.min(1 - d.orig.x, d.orig.w + dx)), h: Math.max(0.05, Math.min(1 - d.orig.y, d.orig.h + dy)) });
  }, []);
  const onPointerUp = useCallback(() => { drag.current = null; window.removeEventListener("pointermove", onPointerMove); window.removeEventListener("pointerup", onPointerUp); }, []);

  const doSave = async () => {
    if (!supabaseReady) { setError("Supabase isn't configured — add your VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY env vars."); return; }
    if (!propName.trim()) { setError("Give the property a name before saving."); return; }
    setError(""); setNotice(""); setSaving(true);
    try {
      await saveProperty({ name: propName.trim(), address: propAddr.trim(), imageBlob: imgBlob, imageType: imgType, zones, analysis });
      setNotice(`Saved "${propName.trim()}" to the property library.`);
      refreshLibrary();
    } catch (e) { setError("Save failed: " + (e.message || e) + ". Check Supabase setup and that the schema SQL (incl. the analysis column) has been run."); }
    finally { setSaving(false); }
  };

  const openProperty = async (p) => {
    setError(""); setNotice("");
    try {
      const { imageUrl, zones: zs } = await loadProperty(p.id);
      setAnalysis(p.analysis || null);
      setPropName(p.name); setPropAddr(p.address || "");
      if (imageUrl) { setImgSrc(imageUrl); setImgBlob(null); setImgType(null); setZones(zs); }
      setStep(p.analysis ? 0 : 1);
    } catch (e) { setError("Couldn't open that property: " + (e.message || e)); }
  };

  const sel = zones.find((z) => z.id === selected);
  const onLibrary = !analysis && !imgSrc && reaFiles.length === 0;

  return (
    <div style={{ fontFamily: "'Calibre','Inter',Tahoma,sans-serif", background: C.paper, minHeight: "100vh", color: C.darkGreen }}>
      <style>{`
        * { box-sizing: border-box; }
        .fin { font-family: 'Financier Display','Playfair Display',Times,serif; }
        .zone { position:absolute; border:2px solid; cursor:move; }
        .handle { position:absolute; right:-6px; bottom:-6px; width:12px; height:12px; background:#fff; border:2px solid ${C.darkGreen}; border-radius:2px; cursor:nwse-resize; }
        @media (max-width:980px){ .layout { grid-template-columns:1fr !important; } }
        button:focus-visible, input:focus-visible, textarea:focus-visible { outline:3px solid ${C.accent}; outline-offset:2px; }
      `}</style>

      <div style={{ background: C.darkGreen, padding: "20px 24px" }}>
        <div style={{ maxWidth: 1280, margin: "0 auto", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <img src={CBRE_LOGO} alt="CBRE" style={{ height: 32 }} />
          <div style={{ color: C.celadon, fontSize: 11, letterSpacing: 2 }}>EV INFRASTRUCTURE SOLUTIONS</div>
        </div>
      </div>

      <div style={{ background: C.green, padding: "32px 24px 0", borderBottom: `3px solid ${C.accent}` }}>
        <div style={{ maxWidth: 1280, margin: "0 auto" }}>
          <div style={{ color: C.accent, fontSize: 12, letterSpacing: 3, marginBottom: 12 }}>REA ANALYSIS &amp; SITE MAP</div>
          <h1 className="fin" style={{ color: C.white, fontSize: 38, margin: 0, fontWeight: 500 }}>EV Siting Workbench</h1>
          <p style={{ color: C.celadonTint, margin: "10px 0 24px", fontSize: 16, maxWidth: 720 }}>
            Analyze the REA, map the charging zones onto the site plan, and save the property — in one flow.
          </p>
          <div style={{ display: "flex", gap: 4 }}>
            {STEPS.map((s, i) => (
              <button key={s} onClick={() => setStep(i)}
                style={{ background: "transparent", border: "none", cursor: "pointer", padding: "10px 20px 14px", fontFamily: "inherit",
                  color: step === i ? C.white : C.celadon, fontWeight: step === i ? 700 : 400, fontSize: 14,
                  borderBottom: step === i ? `3px solid ${C.accent}` : "3px solid transparent", marginBottom: -3 }}>
                {i + 1}. {s}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div style={{ maxWidth: 1280, margin: "0 auto", padding: "28px 24px" }}>
        {!supabaseReady && (
          <div style={{ marginBottom: 20, padding: 14, background: C.wheatTint, border: `1px solid ${C.wheat}`, borderRadius: 4, fontSize: 14, color: C.darkGrey }}>
            <strong>Running without a database.</strong> Analysis and mapping work; Save needs your Supabase keys (see README).
          </div>
        )}
        {error && <div style={{ marginBottom: 16, padding: 12, background: "#FBEAEA", color: C.red, borderRadius: 4, fontSize: 14, border: `1px solid ${C.red}` }}>{error}</div>}
        {notice && <div style={{ marginBottom: 16, padding: 12, background: C.celadonTint + "44", color: C.green, borderRadius: 4, fontSize: 14, border: `1px solid ${C.sage}` }}>{notice}</div>}

        {supabaseReady && library.length > 0 && onLibrary && step === 0 && (
          <div style={{ marginBottom: 28 }}>
            <div className="fin" style={{ fontSize: 20, color: C.green, marginBottom: 12 }}>Property library</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 12 }}>
              {library.map((p) => (
                <div key={p.id} onClick={() => openProperty(p)} style={{ background: "#fff", border: `1px solid ${C.celadonTint}`, borderRadius: 6, overflow: "hidden", cursor: "pointer" }}>
                  {p.site_maps && p.site_maps[0]
                    ? <img src={p.site_maps[0].image_url} alt="" style={{ width: "100%", height: 110, objectFit: "cover", display: "block" }} />
                    : <div style={{ height: 110, background: C.celadonTint + "33", display: "flex", alignItems: "center", justifyContent: "center", color: C.sage, fontSize: 13 }}>Analysis only</div>}
                  <div style={{ padding: 12 }}>
                    <div style={{ fontWeight: 600, fontSize: 14, color: C.green }}>{p.name}</div>
                    {p.address && <div style={{ fontSize: 12, color: C.cement, marginTop: 2 }}>{p.address}</div>}
                  </div>
                </div>
              ))}
            </div>
            <div style={{ borderTop: `1px solid ${C.celadonTint}`, margin: "24px 0 0" }} />
          </div>
        )}

        {step === 0 && (
          <div className="layout" style={{ display: "grid", gridTemplateColumns: analysis ? "380px 1fr" : "1fr", gap: 24, alignItems: "start" }}>
            <div>
              <div className="fin" style={{ fontSize: 22, color: C.green, marginBottom: 12 }}>Step 1 — Analyze the REA / OEA</div>
              <MultiUpload label="REA / OEA document(s)" hint="PDF · base agreement plus any amendments" files={reaFiles} inputRef={reaRef}
                onAdd={(fs) => setReaFiles((p) => [...p, ...fs])} onRemove={(i) => setReaFiles((p) => p.filter((_, x) => x !== i))} />
              <label style={{ display: "block", marginTop: 16, fontWeight: 600, fontSize: 13, color: C.darkGrey }}>Property context (optional)</label>
              <textarea value={propInfo} onChange={(e) => setPropInfo(e.target.value)} rows={3}
                placeholder="e.g. Power center in Hillsboro, OR. Targeting L3 charging near the pad sites."
                style={{ width: "100%", marginTop: 6, padding: 10, borderRadius: 4, border: `1px solid ${C.celadonTint}`, fontFamily: "inherit", fontSize: 13, resize: "vertical" }} />
              <button onClick={runAnalysis} disabled={analyzing}
                style={{ marginTop: 14, background: analyzing ? C.cement : C.green, color: "#fff", border: "none", padding: "12px 22px", borderRadius: 4, fontWeight: 600, fontSize: 14, cursor: analyzing ? "default" : "pointer", fontFamily: "inherit" }}>
                {analyzing ? "Analyzing…" : analysis ? "Re-run analysis" : "Analyze documents"}
              </button>
              {analysis && !analyzing && <button onClick={() => setStep(1)} style={{ marginTop: 14, marginLeft: 10, background: "#fff", color: C.green, border: `1px solid ${C.green}`, padding: "12px 22px", borderRadius: 4, fontWeight: 600, fontSize: 14, cursor: "pointer", fontFamily: "inherit" }}>Next: map the site plan →</button>}
              {analyzing && <div style={{ marginTop: 12, fontSize: 13, color: C.sage }}>Reading the documents and building the analysis — a large package (like a full OEA plus amendments) can take a minute or two. You can leave this running.</div>}
            </div>
            {analysis && <div><AnalysisReport data={analysis} /></div>}
          </div>
        )}

        {step === 1 && (
          <div>
            <div className="fin" style={{ fontSize: 22, color: C.green, marginBottom: 6 }}>Step 2 — Map the site plan</div>
            {analysis && <div style={{ fontSize: 13, color: C.sage, marginBottom: 16 }}>✓ Zones will be drafted using your REA analysis (real parties &amp; approvals).</div>}
            {pdfPages ? (
              <div>
                <div style={{ fontSize: 14, color: C.cement, marginBottom: 14 }}>Click the page that shows the site plan (e.g. the Exhibit page).</div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: 14 }}>
                  {pdfPages.thumbs.map((t, i) => (
                    <div key={i} onClick={() => choosePage(pdfPages.pdf, i + 1)} style={{ cursor: "pointer", border: `1px solid ${C.celadonTint}`, borderRadius: 6, overflow: "hidden", background: "#fff" }}>
                      <img src={t} alt={"page " + (i + 1)} style={{ width: "100%", display: "block" }} />
                      <div style={{ fontSize: 11, color: C.darkGrey, textAlign: "center", padding: "6px 0" }}>Page {i + 1}</div>
                    </div>
                  ))}
                </div>
                <button onClick={() => setPdfPages(null)} style={{ marginTop: 16, background: "transparent", color: C.cement, border: "none", fontSize: 13, cursor: "pointer", fontFamily: "inherit", textDecoration: "underline" }}>Cancel</button>
              </div>
            ) : !imgSrc ? (
              <div onClick={() => !drafting && planRef.current.click()} style={{ border: `2px dashed ${C.celadonTint}`, borderRadius: 6, padding: 56, textAlign: "center", cursor: drafting ? "default" : "pointer", background: "#fff" }}>
                <div className="fin" style={{ fontSize: 20, color: C.green }}>{drafting ? "Reading your file…" : "Upload the site plan"}</div>
                <div style={{ fontSize: 12, color: C.cement, marginTop: 8 }}>PDF, PNG, or JPG · the site plan or an exhibit page</div>
              </div>
            ) : (
              <div>
                <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center", marginBottom: 16 }}>
                  <button onClick={autoDraft} disabled={drafting} style={{ background: drafting ? C.cement : C.green, color: "#fff", border: "none", padding: "11px 20px", borderRadius: 4, fontWeight: 600, fontSize: 14, cursor: drafting ? "default" : "pointer", fontFamily: "inherit" }}>{drafting ? "Analyzing…" : "✨ Auto-draft zones with AI"}</button>
                  <button onClick={addZone} style={{ background: "#fff", color: C.green, border: `1px solid ${C.green}`, padding: "11px 20px", borderRadius: 4, fontWeight: 600, fontSize: 14, cursor: "pointer", fontFamily: "inherit" }}>+ Add zone</button>
                  <button onClick={() => { setImgSrc(null); setZones([]); setSelected(null); }} style={{ background: "transparent", color: C.cement, border: "none", padding: "11px 8px", fontSize: 13, cursor: "pointer", fontFamily: "inherit", textDecoration: "underline" }}>Replace plan</button>
                  <div style={{ flex: 1 }} />
                  <div style={{ display: "flex", gap: 14, alignItems: "center" }}>
                    {Object.entries(VIABILITY).map(([k, v]) => (
                      <div key={k} style={{ display: "flex", gap: 6, alignItems: "center" }}>
                        <span style={{ width: 13, height: 13, borderRadius: 3, background: v.color, opacity: 0.3, border: `2px solid ${v.color}` }} />
                        <span style={{ fontSize: 12, color: C.darkGrey }}>{v.label}</span>
                      </div>
                    ))}
                  </div>
                </div>
                <div className="layout" style={{ display: "grid", gridTemplateColumns: "1fr 360px", gap: 20, alignItems: "start" }}>
                  <div ref={stageRef} onClick={() => setSelected(null)} style={{ position: "relative", borderRadius: 6, overflow: "hidden", border: `1px solid ${C.celadonTint}`, background: "#000", lineHeight: 0 }}>
                    <img src={imgSrc} alt="site plan" style={{ width: "100%", display: "block" }} draggable={false} />
                    {zones.map((z) => {
                      const v = VIABILITY[z.viability]; const isSel = z.id === selected;
                      return (
                        <div key={z.id} className="zone" onPointerDown={(e) => onPointerDown(e, z.id, "move")}
                          style={{ left: `${z.x * 100}%`, top: `${z.y * 100}%`, width: `${z.w * 100}%`, height: `${z.h * 100}%`, borderColor: v.color, background: hexA(v.color, isSel ? 0.4 : 0.26), boxShadow: isSel ? `0 0 0 2px ${C.darkGreen}` : "none", zIndex: isSel ? 5 : 1 }}>
                          <div style={{ position: "absolute", top: 0, left: 0, transform: "translateY(-100%)", background: v.color, color: "#fff", fontSize: 11, fontWeight: 600, padding: "2px 7px", whiteSpace: "nowrap", lineHeight: 1.4 }}>{z.label}</div>
                          <div className="handle" onPointerDown={(e) => onPointerDown(e, z.id, "resize")} />
                        </div>
                      );
                    })}
                  </div>
                  <div style={{ background: "#fff", border: `1px solid ${C.celadonTint}`, borderRadius: 6, padding: 18 }}>
                    {!sel ? (
                      <div>
                        <div className="fin" style={{ fontSize: 18, color: C.green, marginBottom: 10 }}>Zones</div>
                        {zones.length === 0 ? <div style={{ fontSize: 13, color: C.cement }}>No zones yet. Auto-draft or add one, then click a box to edit it.</div>
                          : zones.map((z) => (
                            <div key={z.id} onClick={() => setSelected(z.id)} style={{ display: "flex", gap: 8, alignItems: "center", padding: "8px 6px", borderBottom: `1px solid ${C.celadonTint}`, cursor: "pointer" }}>
                              <span style={{ width: 11, height: 11, borderRadius: 2, background: VIABILITY[z.viability].color, flexShrink: 0 }} />
                              <span style={{ fontSize: 13, color: C.darkGreen, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{z.label}</span>
                            </div>
                          ))}
                      </div>
                    ) : (
                      <div>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
                          <div className="fin" style={{ fontSize: 18, color: C.green }}>Edit zone</div>
                          <button onClick={() => setSelected(null)} style={{ border: "none", background: "transparent", color: C.cement, cursor: "pointer", fontSize: 18 }}>×</button>
                        </div>
                        <Field label="Label"><input value={sel.label} onChange={(e) => updateZone(sel.id, { label: e.target.value })} style={inp} /></Field>
                        <Field label="EV viability">
                          <div style={{ display: "flex", gap: 6 }}>
                            {Object.keys(VIABILITY).map((k) => (
                              <button key={k} onClick={() => updateZone(sel.id, { viability: k })} style={{ flex: 1, padding: "7px 4px", fontSize: 12, fontWeight: 600, borderRadius: 4, cursor: "pointer", fontFamily: "inherit", border: `1.5px solid ${VIABILITY[k].color}`, background: sel.viability === k ? VIABILITY[k].color : "#fff", color: sel.viability === k ? "#fff" : VIABILITY[k].color }}>{VIABILITY[k].label}</button>
                            ))}
                          </div>
                        </Field>
                        <Field label="Controlling party"><input value={sel.controllingParty} onChange={(e) => updateZone(sel.id, { controllingParty: e.target.value })} style={inp} /></Field>
                        <Field label="Approval needed / notes"><textarea value={sel.approval} onChange={(e) => updateZone(sel.id, { approval: e.target.value })} rows={3} style={{ ...inp, resize: "vertical" }} /></Field>
                        <button onClick={() => removeZone(sel.id)} style={{ marginTop: 6, background: "transparent", color: C.red, border: `1px solid ${C.red}`, padding: "7px 14px", borderRadius: 4, fontSize: 13, cursor: "pointer", fontFamily: "inherit" }}>Delete zone</button>
                      </div>
                    )}
                  </div>
                </div>
                <button onClick={() => setStep(2)} style={{ marginTop: 20, background: C.green, color: "#fff", border: "none", padding: "12px 24px", borderRadius: 4, fontWeight: 600, fontSize: 14, cursor: "pointer", fontFamily: "inherit" }}>Next: save property →</button>
              </div>
            )}
            <input ref={planRef} type="file" accept="application/pdf,image/png,image/jpeg,image/webp" style={{ display: "none" }} onChange={(e) => e.target.files[0] && onPickPlan(e.target.files[0])} />
          </div>
        )}

        {step === 2 && (
          <div style={{ maxWidth: 560 }}>
            <div className="fin" style={{ fontSize: 22, color: C.green, marginBottom: 14 }}>Step 3 — Save the property</div>
            <div style={{ background: "#fff", border: `1px solid ${C.celadonTint}`, borderRadius: 6, padding: 20 }}>
              <div style={{ fontSize: 14, color: C.darkGrey, marginBottom: 16 }}>
                Saving includes: {analysis ? "the written analysis" : "no analysis"}{imgSrc ? ", the site-plan map" : ""}{zones.length ? `, and ${zones.length} zone(s)` : ""}.
              </div>
              <Field label="Property name"><input value={propName} onChange={(e) => setPropName(e.target.value)} placeholder="e.g. The Sunset Esplanade" style={inp} /></Field>
              <Field label="Address (optional)"><input value={propAddr} onChange={(e) => setPropAddr(e.target.value)} placeholder="City, State" style={inp} /></Field>
              <button onClick={doSave} disabled={saving || !supabaseReady} style={{ width: "100%", marginTop: 8, background: supabaseReady ? C.green : C.celadonTint, color: "#fff", border: "none", padding: "12px", borderRadius: 4, fontWeight: 600, fontSize: 15, cursor: supabaseReady && !saving ? "pointer" : "not-allowed", fontFamily: "inherit" }}>{saving ? "Saving…" : "💾 Save to property library"}</button>
              {notice && <button onClick={resetAll} style={{ width: "100%", marginTop: 10, background: "transparent", color: C.green, border: `1px solid ${C.green}`, padding: "11px", borderRadius: 4, fontWeight: 600, fontSize: 14, cursor: "pointer", fontFamily: "inherit" }}>Start a new property</button>}
            </div>
          </div>
        )}
      </div>

      <div style={{ textAlign: "center", padding: 20, color: C.cement, fontSize: 11 }}>
        Created by Chris Rubio · Preliminary analysis only — not legal advice. Confirm all findings against the executed REA with counsel.
      </div>
    </div>
  );
}

const inp = { width: "100%", padding: "8px 10px", borderRadius: 4, border: `1px solid ${C.celadonTint}`, fontFamily: "inherit", fontSize: 13, marginTop: 4 };
function Field({ label, children }) { return <div style={{ marginBottom: 12 }}><label style={{ fontSize: 12, fontWeight: 600, color: C.darkGrey }}>{label}</label>{children}</div>; }
function hexA(hex, a) { const n = parseInt(hex.slice(1), 16); return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`; }

function MultiUpload({ label, hint, files, inputRef, onAdd, onRemove }) {
  const has = files.length > 0;
  return (
    <div>
      <label style={{ display: "block", fontWeight: 600, fontSize: 13, color: C.darkGrey, marginBottom: 6 }}>{label}</label>
      <div onClick={() => inputRef.current.click()} style={{ border: `2px dashed ${has ? C.sage : C.celadonTint}`, borderRadius: 4, padding: 18, cursor: "pointer", background: has ? C.celadonTint + "22" : "transparent", textAlign: "center" }}>
        <div style={{ fontSize: 14, color: has ? C.green : C.darkGrey, fontWeight: has ? 600 : 400 }}>{has ? `Add another (${files.length} added)` : "Tap to upload"}</div>
        <div style={{ fontSize: 11, color: C.cement, marginTop: 4 }}>{hint}</div>
      </div>
      {has && (
        <div style={{ marginTop: 8 }}>
          {files.map((f, i) => (
            <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, padding: "6px 10px", background: "#fff", border: `1px solid ${C.celadonTint}`, borderRadius: 4, marginBottom: 6 }}>
              <span style={{ fontSize: 13, color: C.green, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}><span style={{ color: C.cement, marginRight: 6 }}>{i + 1}.</span>{f.name}</span>
              <button onClick={(e) => { e.stopPropagation(); onRemove(i); }} style={{ border: "none", background: "transparent", color: C.red, cursor: "pointer", fontSize: 16, lineHeight: 1, padding: "0 4px" }}>×</button>
            </div>
          ))}
        </div>
      )}
      <input ref={inputRef} type="file" accept="application/pdf" multiple style={{ display: "none" }} onChange={(e) => { if (e.target.files.length) onAdd(Array.from(e.target.files)); e.target.value = ""; }} />
    </div>
  );
}

function Section({ title, num, children }) {
  return (
    <div style={{ marginTop: 20 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, borderBottom: `2px solid ${C.green}`, paddingBottom: 6, marginBottom: 12 }}>
        <span style={{ color: C.sage, fontSize: 12 }}>{num}</span>
        <h2 className="fin" style={{ fontSize: 20, color: C.green, margin: 0, fontWeight: 400 }}>{title}</h2>
      </div>
      {children}
    </div>
  );
}
function Pill({ text, color }) { return <span style={{ background: color, color: "#fff", fontSize: 11, fontWeight: 600, padding: "2px 9px", borderRadius: 20, whiteSpace: "nowrap" }}>{text}</span>; }
function Card({ children }) { return <div style={{ background: "#fff", border: `1px solid ${C.celadonTint}`, borderRadius: 4, padding: 14, marginBottom: 10 }}>{children}</div>; }
const vColor = (v) => (v === "Yes" ? C.green : v === "Conditional" ? C.amber : C.red);
const dColor = (d) => (d === "Low" ? C.sage : d === "Medium" ? C.amber : C.red);
const rColor = (t) => (t === "Permitted" ? C.green : t === "Silent" ? C.cement : t === "Restricted" ? C.amber : C.red);

function AnalysisReport({ data }) {
  return (
    <div>
      <Section title="Property Summary" num="01">
        <p style={{ fontSize: 15, lineHeight: 1.6, color: C.darkGrey }}>{data.propertySummary}</p>
        {data.documentsReviewed?.length > 0 && (
          <div style={{ marginTop: 10, padding: 12, background: C.celadonTint + "33", borderRadius: 4, borderLeft: `3px solid ${C.sage}` }}>
            <div style={{ fontSize: 11, color: C.darkGrey, letterSpacing: 1, marginBottom: 6 }}>DOCUMENTS REVIEWED</div>
            {data.documentsReviewed.map((d, i) => <div key={i} style={{ fontSize: 13, color: C.darkGrey, padding: "2px 0" }}>• {d}</div>)}
          </div>
        )}
      </Section>
      {data.parties?.length > 0 && <Section title="Controlling Parties" num="02">{data.parties.map((p, i) => <Card key={i}><div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}><strong style={{ color: C.green, fontSize: 14 }}>{p.name}</strong><Pill text={p.role} color={C.sage} /></div><div style={{ fontSize: 13, color: C.darkGrey, marginTop: 6 }}>{p.controlsAreas}</div></Card>)}</Section>}
      {data.controlZones?.length > 0 && <Section title="Control Zones & EV Viability" num="03">{data.controlZones.map((z, i) => <Card key={i}><div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "center" }}><strong style={{ color: C.midnight, fontSize: 14 }}>{z.zone}</strong><Pill text={"EV: " + z.evViable} color={vColor(z.evViable)} /></div><div style={{ fontSize: 12, color: C.cement, marginTop: 4 }}>Controlled by: {z.controllingParty}</div><div style={{ fontSize: 13, color: C.darkGrey, marginTop: 6 }}>{z.rationale}</div>{z.constraints && <div style={{ fontSize: 12, color: C.orange, marginTop: 6 }}>⚠ {z.constraints}</div>}</Card>)}</Section>}
      {data.approvalMatrix?.length > 0 && <Section title="Approval Matrix" num="04">{data.approvalMatrix.map((a, i) => <Card key={i}><div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "center" }}><strong style={{ color: C.green, fontSize: 14 }}>{a.action}</strong><Pill text={a.difficulty + " effort"} color={dColor(a.difficulty)} /></div><div style={{ fontSize: 13, color: C.darkGrey, marginTop: 6 }}><strong>Approval required:</strong> {a.approvalRequired}</div><div style={{ fontSize: 12, color: C.cement, marginTop: 4 }}>Basis: {a.basis}</div></Card>)}</Section>}
      {data.evRestrictions?.length > 0 && <Section title="EV-Relevant REA Language" num="05">{data.evRestrictions.map((r, i) => <Card key={i}><div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}><Pill text={r.type} color={rColor(r.type)} /><strong style={{ color: C.darkGreen, fontSize: 13 }}>{r.topic}</strong></div><div style={{ fontSize: 13, color: C.darkGrey, marginTop: 6 }}>{r.detail}</div></Card>)}</Section>}
      {data.recommendedZones?.length > 0 && <Section title="Recommended Zones" num="06"><div style={{ background: C.green, borderRadius: 4, padding: 16 }}>{data.recommendedZones.map((z, i) => <div key={i} style={{ display: "flex", gap: 12, padding: "7px 0", borderBottom: i < data.recommendedZones.length - 1 ? `1px solid ${C.sage}` : "none" }}><span style={{ color: C.accent, fontWeight: 700 }}>{String(i + 1).padStart(2, "0")}</span><span style={{ color: "#fff", fontSize: 13, lineHeight: 1.5 }}>{z}</span></div>)}</div></Section>}
      <div className="layout" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginTop: 20 }}>
        {data.risks?.length > 0 && <div><h3 className="fin" style={{ color: C.red, fontSize: 16, fontWeight: 400, margin: "0 0 8px" }}>Risks & Unknowns</h3>{data.risks.map((r, i) => <div key={i} style={{ fontSize: 13, color: C.darkGrey, padding: "5px 0", borderBottom: `1px solid ${C.celadonTint}` }}>• {r}</div>)}</div>}
        {data.nextSteps?.length > 0 && <div><h3 className="fin" style={{ color: C.green, fontSize: 16, fontWeight: 400, margin: "0 0 8px" }}>Next Steps</h3>{data.nextSteps.map((s, i) => <div key={i} style={{ fontSize: 13, color: C.darkGrey, padding: "5px 0", borderBottom: `1px solid ${C.celadonTint}` }}>{i + 1}. {s}</div>)}</div>}
      </div>
    </div>
  );
}
