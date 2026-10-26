import React, { useState, useRef, useCallback, useEffect } from "react";
import { supabaseReady, saveProperty, listProperties, loadProperty } from "./supabaseClient";
import * as pdfjsLib from "pdfjs-dist";
import pdfWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url";
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker;

const CBRE_LOGO = "/CBRE_logo.png";

// Load a PDF into a pdf.js document.
async function loadPdf(file) {
  const buf = await file.arrayBuffer();
  return pdfjsLib.getDocument({ data: buf }).promise;
}
// Render one PDF page to a PNG data URL at a given scale.
async function renderPdfPage(pdf, pageNum, scale) {
  const page = await pdf.getPage(pageNum);
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
  return canvas.toDataURL("image/png");
}
// Turn a data URL into a Blob (for uploading the rendered page to Supabase).
function dataURLtoBlob(dataURL) {
  const [head, body] = dataURL.split(",");
  const mime = head.match(/:(.*?);/)[1];
  const bin = atob(body);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

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

export default function App() {
  const [imgSrc, setImgSrc] = useState(null);
  const [imgType, setImgType] = useState(null);
  const [imgBlob, setImgBlob] = useState(null);
  const [zones, setZones] = useState([]);
  const [selected, setSelected] = useState(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [library, setLibrary] = useState([]);
  const [propName, setPropName] = useState("");
  const [propAddr, setPropAddr] = useState("");
  const [pdfPages, setPdfPages] = useState(null);
  const fileRef = useRef();
  const stageRef = useRef();
  const drag = useRef(null);

  useEffect(() => { refreshLibrary(); }, []);
  const refreshLibrary = async () => {
    if (!supabaseReady) return;
    try { setLibrary(await listProperties()); } catch (e) { /* non-fatal */ }
  };

  const onPick = async (file) => {
    if (!file) return;
    setError(""); setZones([]); setSelected(null); setImgSrc(null); setPdfPages(null);

    if (file.type === "application/pdf") {
      setLoading(true);
      try {
        const pdf = await loadPdf(file);
        const thumbs = [];
        const n = Math.min(pdf.numPages, 30);
        for (let i = 1; i <= n; i++) thumbs.push(await renderPdfPage(pdf, i, 0.5));
        if (thumbs.length === 1) {
          await choosePage(pdf, 1);
        } else {
          setPdfPages({ pdf, thumbs });
        }
      } catch (e) {
        setError("Couldn't read that PDF: " + e.message + ". Try exporting the site-plan page to an image instead.");
      } finally { setLoading(false); }
      return;
    }

    setImgBlob(file);
    setImgType(file.type);
    const url = await new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(file); });
    setImgSrc(url);
  };

  // Render the chosen PDF page full-size; it becomes the map surface, and its
  // blob is what gets uploaded to Supabase on save.
  const choosePage = async (pdf, pageNum) => {
    setLoading(true);
    try {
      const url = await renderPdfPage(pdf, pageNum, 2.0);
      setImgSrc(url);
      setImgType("image/png");
      setImgBlob(dataURLtoBlob(url));
      setPdfPages(null);
    } catch (e) {
      setError("Couldn't render that page: " + e.message);
    } finally { setLoading(false); }
  };

  const autoDraft = async () => {
    if (!imgSrc) return;
    setError(""); setLoading(true);
    try {
      const b64 = imgSrc.split(",")[1];
      const resp = await fetch("/api/draft-zones", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imageBase64: b64, mediaType: imgType }),
      });
      const data = await resp.json();
      if (data.error) throw new Error(data.error.message || data.error);
      const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
      const parsed = JSON.parse(text.replace(/```json|```/g, "").trim());
      setZones((parsed.zones || []).map((z) => ({
        id: newId(), label: z.label || "Zone",
        viability: VIABILITY[z.viability] ? z.viability : "Conditional",
        controllingParty: z.controllingParty || "Unknown — confirm in REA",
        approval: z.approval || "",
        x: clamp(z.x), y: clamp(z.y), w: clamp(z.w, 0.05), h: clamp(z.h, 0.05),
      })));
    } catch (e) {
      setError("Couldn't auto-draft zones: " + e.message + ". You can still add zones manually.");
    } finally { setLoading(false); }
  };

  const updateZone = (id, patch) => setZones((zs) => zs.map((z) => (z.id === id ? { ...z, ...patch } : z)));
  const removeZone = (id) => { setZones((zs) => zs.filter((z) => z.id !== id)); setSelected(null); };
  const addZone = () => {
    const z = { id: newId(), label: "New zone", viability: "Conditional", controllingParty: "Unknown — confirm in REA", approval: "", x: 0.35, y: 0.4, w: 0.3, h: 0.18 };
    setZones((zs) => [...zs, z]); setSelected(z.id);
  };

  const onPointerDown = (e, id, mode) => {
    e.stopPropagation();
    const rect = stageRef.current.getBoundingClientRect();
    const z = zones.find((x) => x.id === id);
    drag.current = { id, mode, startX: e.clientX, startY: e.clientY, orig: { ...z }, rect };
    setSelected(id);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
  };
  const onPointerMove = useCallback((e) => {
    const d = drag.current; if (!d) return;
    const dx = (e.clientX - d.startX) / d.rect.width, dy = (e.clientY - d.startY) / d.rect.height;
    if (d.mode === "move") {
      updateZone(d.id, { x: Math.max(0, Math.min(1 - d.orig.w, d.orig.x + dx)), y: Math.max(0, Math.min(1 - d.orig.h, d.orig.y + dy)) });
    } else {
      updateZone(d.id, { w: Math.max(0.05, Math.min(1 - d.orig.x, d.orig.w + dx)), h: Math.max(0.05, Math.min(1 - d.orig.y, d.orig.h + dy)) });
    }
  }, []);
  const onPointerUp = useCallback(() => {
    drag.current = null;
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
  }, []);

  const doSave = async () => {
    if (!supabaseReady) { setError("Supabase isn't configured yet — add your VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY env vars."); return; }
    if (!propName.trim()) { setError("Give the property a name before saving."); return; }
    if (!imgBlob) { setError("This map was opened from the library. Re-upload the site plan to save a new version."); return; }
    setError(""); setNotice(""); setSaving(true);
    try {
      await saveProperty({ name: propName.trim(), address: propAddr.trim(), imageBlob: imgBlob, imageType: imgType, zones });
      setNotice(`Saved "${propName.trim()}" to the property library.`);
      refreshLibrary();
    } catch (e) {
      setError("Save failed: " + (e.message || e) + ". Check your Supabase setup and that the schema SQL has been run.");
    } finally { setSaving(false); }
  };

  const openProperty = async (p) => {
    setError(""); setNotice(""); setLoading(true);
    try {
      const { imageUrl, zones: zs } = await loadProperty(p.id);
      if (!imageUrl) { setError("That property has no saved map image."); return; }
      setImgSrc(imageUrl); setImgBlob(null); setImgType(null);
      setZones(zs); setSelected(null);
      setPropName(p.name); setPropAddr(p.address || "");
    } catch (e) {
      setError("Couldn't open that property: " + (e.message || e));
    } finally { setLoading(false); }
  };

  const sel = zones.find((z) => z.id === selected);

  return (
    <div style={{ fontFamily: "'Calibre','Inter',Tahoma,sans-serif", background: C.paper, minHeight: "100vh", color: C.darkGreen }}>
      <style>{`
        * { box-sizing: border-box; }
        .fin { font-family: 'Financier Display','Playfair Display',Times,serif; }
        .lbl { font-family: 'Calibre','Inter',Tahoma,sans-serif; }
        .zone { position:absolute; border:2px solid; cursor:move; }
        .handle { position:absolute; right:-6px; bottom:-6px; width:12px; height:12px; background:#fff; border:2px solid ${C.darkGreen}; border-radius:2px; cursor:nwse-resize; }
        @media (max-width:980px){ .layout { grid-template-columns:1fr !important; } }
        button:focus-visible, input:focus-visible, textarea:focus-visible { outline:3px solid ${C.accent}; outline-offset:2px; }
      `}</style>

      <div style={{ background: C.darkGreen, padding: "20px 24px" }}>
        <div style={{ maxWidth: 1280, margin: "0 auto", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <img src={CBRE_LOGO} alt="CBRE" style={{ height: 32 }} />
          <div className="lbl" style={{ color: C.celadon, fontSize: 11, letterSpacing: 2 }}>EV INFRASTRUCTURE SOLUTIONS</div>
        </div>
      </div>

      <div style={{ background: C.green, padding: "32px 24px", borderBottom: `3px solid ${C.accent}` }}>
        <div style={{ maxWidth: 1280, margin: "0 auto" }}>
          <div className="lbl" style={{ color: C.accent, fontSize: 12, letterSpacing: 3, marginBottom: 12 }}>INTERACTIVE SITE MAP</div>
          <h1 className="fin" style={{ color: C.white, fontSize: 40, margin: 0, fontWeight: 500 }}>EV Siting Map</h1>
          <p style={{ color: C.celadonTint, margin: "10px 0 0", fontSize: 16, maxWidth: 680 }}>
            Upload a site plan, let AI draft the charging zones, adjust them, and save each property to your team library.
          </p>
        </div>
      </div>

      <div style={{ maxWidth: 1280, margin: "0 auto", padding: "28px 24px" }}>
        {!supabaseReady && (
          <div style={{ marginBottom: 20, padding: 14, background: C.wheatTint, border: `1px solid ${C.wheat}`, borderRadius: 4, fontSize: 14, color: C.darkGrey }}>
            <strong>Running without a database.</strong> You can draft and edit maps, but Save is disabled until you add your Supabase keys (see the README). Everything else works.
          </div>
        )}

        {/* Property library */}
        {supabaseReady && library.length > 0 && !imgSrc && (
          <div style={{ marginBottom: 24 }}>
            <div className="fin" style={{ fontSize: 20, color: C.green, marginBottom: 12 }}>Property library</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 12 }}>
              {library.map((p) => (
                <div key={p.id} onClick={() => openProperty(p)}
                  style={{ background: "#fff", border: `1px solid ${C.celadonTint}`, borderRadius: 6, overflow: "hidden", cursor: "pointer" }}>
                  {p.site_maps && p.site_maps[0] && (
                    <img src={p.site_maps[0].image_url} alt="" style={{ width: "100%", height: 110, objectFit: "cover", display: "block" }} />
                  )}
                  <div style={{ padding: 12 }}>
                    <div style={{ fontWeight: 600, fontSize: 14, color: C.green }}>{p.name}</div>
                    {p.address && <div style={{ fontSize: 12, color: C.cement, marginTop: 2 }}>{p.address}</div>}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {pdfPages ? (
          <div>
            <div className="fin" style={{ fontSize: 20, color: C.green, marginBottom: 6 }}>Choose the site-plan page</div>
            <div className="lbl" style={{ fontSize: 12, color: C.cement, marginBottom: 16 }}>Click the page that shows the site plan (e.g. the Exhibit page).</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: 14 }}>
              {pdfPages.thumbs.map((t, i) => (
                <div key={i} onClick={() => choosePage(pdfPages.pdf, i + 1)}
                  style={{ cursor: "pointer", border: `1px solid ${C.celadonTint}`, borderRadius: 6, overflow: "hidden", background: "#fff" }}>
                  <img src={t} alt={"page " + (i + 1)} style={{ width: "100%", display: "block" }} />
                  <div className="lbl" style={{ fontSize: 11, color: C.darkGrey, textAlign: "center", padding: "6px 0" }}>Page {i + 1}</div>
                </div>
              ))}
            </div>
            <button onClick={() => setPdfPages(null)}
              style={{ marginTop: 16, background: "transparent", color: C.cement, border: "none", fontSize: 13, cursor: "pointer", fontFamily: "inherit", textDecoration: "underline" }}>
              Cancel
            </button>
          </div>
        ) : !imgSrc ? (
          <div onClick={() => !loading && fileRef.current.click()}
            style={{ border: `2px dashed ${C.celadonTint}`, borderRadius: 6, padding: 64, textAlign: "center", cursor: loading ? "default" : "pointer", background: C.white }}>
            <div className="fin" style={{ fontSize: 22, color: C.green }}>{loading ? "Reading your file…" : "Upload a site plan"}</div>
            <div className="lbl" style={{ fontSize: 12, color: C.cement, marginTop: 8 }}>PDF, PNG, or JPG · the site plan or an exhibit page</div>
          </div>
        ) : (
          <div>
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center", marginBottom: 16 }}>
              <button onClick={autoDraft} disabled={loading}
                style={{ background: loading ? C.cement : C.green, color: "#fff", border: "none", padding: "11px 20px", borderRadius: 4, fontWeight: 600, fontSize: 14, cursor: loading ? "default" : "pointer", fontFamily: "inherit" }}>
                {loading ? "Analyzing…" : "✨ Auto-draft zones with AI"}
              </button>
              <button onClick={addZone}
                style={{ background: "#fff", color: C.green, border: `1px solid ${C.green}`, padding: "11px 20px", borderRadius: 4, fontWeight: 600, fontSize: 14, cursor: "pointer", fontFamily: "inherit" }}>
                + Add zone
              </button>
              <button onClick={() => { setImgSrc(null); setZones([]); setSelected(null); setPropName(""); setPropAddr(""); }}
                style={{ background: "transparent", color: C.cement, border: "none", padding: "11px 8px", fontSize: 13, cursor: "pointer", fontFamily: "inherit", textDecoration: "underline" }}>
                Start over
              </button>
              <div style={{ flex: 1 }} />
              <div style={{ display: "flex", gap: 14, alignItems: "center" }}>
                {Object.entries(VIABILITY).map(([k, v]) => (
                  <div key={k} style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    <span style={{ width: 13, height: 13, borderRadius: 3, background: v.color, opacity: 0.25, border: `2px solid ${v.color}` }} />
                    <span style={{ fontSize: 12, color: C.darkGrey }}>{v.label}</span>
                  </div>
                ))}
              </div>
            </div>

            {error && <div style={{ marginBottom: 16, padding: 12, background: "#FBEAEA", color: C.red, borderRadius: 4, fontSize: 14, border: `1px solid ${C.red}` }}>{error}</div>}
            {notice && <div style={{ marginBottom: 16, padding: 12, background: C.celadonTint + "44", color: C.green, borderRadius: 4, fontSize: 14, border: `1px solid ${C.sage}` }}>{notice}</div>}

            <div className="layout" style={{ display: "grid", gridTemplateColumns: "1fr 360px", gap: 20, alignItems: "start" }}>
              <div ref={stageRef} onClick={() => setSelected(null)}
                style={{ position: "relative", borderRadius: 6, overflow: "hidden", border: `1px solid ${C.celadonTint}`, background: "#000", lineHeight: 0 }}>
                <img src={imgSrc} alt="site plan" style={{ width: "100%", display: "block" }} draggable={false} />
                {zones.map((z) => {
                  const v = VIABILITY[z.viability]; const isSel = z.id === selected;
                  return (
                    <div key={z.id} className="zone" onPointerDown={(e) => onPointerDown(e, z.id, "move")}
                      style={{ left: `${z.x * 100}%`, top: `${z.y * 100}%`, width: `${z.w * 100}%`, height: `${z.h * 100}%`,
                        borderColor: v.color, background: hexA(v.color, isSel ? 0.34 : 0.2),
                        boxShadow: isSel ? `0 0 0 2px ${C.darkGreen}` : "none", zIndex: isSel ? 5 : 1 }}>
                      <div className="lbl" style={{ position: "absolute", top: 0, left: 0, transform: "translateY(-100%)", background: v.color, color: "#fff", fontSize: 11, fontWeight: 600, padding: "2px 7px", whiteSpace: "nowrap", lineHeight: 1.4 }}>{z.label}</div>
                      <div className="handle" onPointerDown={(e) => onPointerDown(e, z.id, "resize")} />
                    </div>
                  );
                })}
              </div>

              <div style={{ background: "#fff", border: `1px solid ${C.celadonTint}`, borderRadius: 6, padding: 18 }}>
                {!sel ? (
                  <div>
                    <div className="fin" style={{ fontSize: 18, color: C.green, marginBottom: 10 }}>Zones</div>
                    {zones.length === 0 ? (
                      <div style={{ fontSize: 13, color: C.cement }}>No zones yet. Auto-draft or add one, then click a box to edit it.</div>
                    ) : zones.map((z) => (
                      <div key={z.id} onClick={() => setSelected(z.id)}
                        style={{ display: "flex", gap: 8, alignItems: "center", padding: "8px 6px", borderBottom: `1px solid ${C.celadonTint}`, cursor: "pointer" }}>
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
                          <button key={k} onClick={() => updateZone(sel.id, { viability: k })}
                            style={{ flex: 1, padding: "7px 4px", fontSize: 12, fontWeight: 600, borderRadius: 4, cursor: "pointer", fontFamily: "inherit",
                              border: `1.5px solid ${VIABILITY[k].color}`, background: sel.viability === k ? VIABILITY[k].color : "#fff", color: sel.viability === k ? "#fff" : VIABILITY[k].color }}>
                            {VIABILITY[k].label}
                          </button>
                        ))}
                      </div>
                    </Field>
                    <Field label="Controlling party"><input value={sel.controllingParty} onChange={(e) => updateZone(sel.id, { controllingParty: e.target.value })} style={inp} /></Field>
                    <Field label="Approval needed / notes"><textarea value={sel.approval} onChange={(e) => updateZone(sel.id, { approval: e.target.value })} rows={3} style={{ ...inp, resize: "vertical" }} /></Field>
                    <button onClick={() => removeZone(sel.id)}
                      style={{ marginTop: 6, background: "transparent", color: C.red, border: `1px solid ${C.red}`, padding: "7px 14px", borderRadius: 4, fontSize: 13, cursor: "pointer", fontFamily: "inherit" }}>Delete zone</button>
                  </div>
                )}

                {/* Save to library */}
                <div style={{ marginTop: 20, paddingTop: 16, borderTop: `1px dashed ${C.celadonTint}` }}>
                  <div className="lbl" style={{ fontSize: 11, letterSpacing: 1, color: C.darkGrey, marginBottom: 8 }}>SAVE TO PROPERTY LIBRARY</div>
                  <input value={propName} onChange={(e) => setPropName(e.target.value)} placeholder="Property name" style={{ ...inp, marginTop: 0, marginBottom: 8 }} />
                  <input value={propAddr} onChange={(e) => setPropAddr(e.target.value)} placeholder="Address (optional)" style={{ ...inp, marginTop: 0, marginBottom: 10 }} />
                  <button onClick={doSave} disabled={saving || !supabaseReady}
                    style={{ width: "100%", background: supabaseReady ? C.green : C.celadonTint, color: "#fff", border: "none", padding: "11px", borderRadius: 4, fontWeight: 600, fontSize: 14, cursor: supabaseReady && !saving ? "pointer" : "not-allowed", fontFamily: "inherit" }}>
                    {saving ? "Saving…" : "💾 Save property"}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        <input ref={fileRef} type="file" accept="application/pdf,image/png,image/jpeg,image/webp" style={{ display: "none" }}
          onChange={(e) => e.target.files[0] && onPick(e.target.files[0])} />
      </div>

      <div className="lbl" style={{ textAlign: "center", padding: 20, color: C.cement, fontSize: 11 }}>
        Created by Chris Rubio · AI zone placement is a starting draft — always adjust to the real plan. Not legal advice.
      </div>
    </div>
  );
}

const inp = { width: "100%", padding: "8px 10px", borderRadius: 4, border: `1px solid ${C.celadonTint}`, fontFamily: "inherit", fontSize: 13, marginTop: 4 };
function Field({ label, children }) {
  return <div style={{ marginBottom: 12 }}><label style={{ fontSize: 12, fontWeight: 600, color: C.darkGrey }}>{label}</label>{children}</div>;
}
function hexA(hex, a) { const n = parseInt(hex.slice(1), 16); return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`; }
