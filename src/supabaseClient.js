import { createClient } from "@supabase/supabase-js";

// These come from your Netlify environment variables (VITE_ prefix = exposed to
// the browser, which is correct for the Supabase URL and the ANON key — the anon
// key is safe to ship; your database is protected by Row Level Security).
const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabaseReady = Boolean(url && anonKey);

export const supabase = supabaseReady ? createClient(url, anonKey) : null;

// ---- Data helpers ----

export async function saveProperty({ name, address, imageBlob, imageType, zones }) {
  if (!supabaseReady) throw new Error("Supabase is not configured.");

  // 1. upload the site-plan image to Storage
  const ext = (imageType && imageType.split("/")[1]) || "png";
  const path = `${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
  const up = await supabase.storage.from("site-plans").upload(path, imageBlob, { contentType: imageType });
  if (up.error) throw up.error;
  const { data: pub } = supabase.storage.from("site-plans").getPublicUrl(path);
  const imageUrl = pub.publicUrl;

  // 2. property row
  const prop = await supabase.from("properties").insert({ name, address }).select().single();
  if (prop.error) throw prop.error;

  // 3. map row
  const map = await supabase.from("site_maps").insert({ property_id: prop.data.id, image_url: imageUrl }).select().single();
  if (map.error) throw map.error;

  // 4. zone rows
  if (zones.length) {
    const rows = zones.map((z) => ({
      map_id: map.data.id, label: z.label, viability: z.viability,
      controlling_party: z.controllingParty, approval: z.approval,
      x: z.x, y: z.y, w: z.w, h: z.h,
    }));
    const zr = await supabase.from("zones").insert(rows);
    if (zr.error) throw zr.error;
  }
  return prop.data;
}

export async function listProperties() {
  if (!supabaseReady) return [];
  const { data, error } = await supabase
    .from("properties")
    .select("id, name, address, created_at, site_maps(id, image_url)")
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data || [];
}

export async function loadProperty(propertyId) {
  if (!supabaseReady) throw new Error("Supabase is not configured.");
  const { data: maps, error: me } = await supabase
    .from("site_maps").select("id, image_url").eq("property_id", propertyId).order("created_at", { ascending: false }).limit(1);
  if (me) throw me;
  const map = maps && maps[0];
  if (!map) return { imageUrl: null, zones: [] };
  const { data: zones, error: ze } = await supabase
    .from("zones").select("*").eq("map_id", map.id);
  if (ze) throw ze;
  return {
    imageUrl: map.image_url,
    zones: (zones || []).map((z) => ({
      id: z.id, label: z.label, viability: z.viability,
      controllingParty: z.controlling_party || "", approval: z.approval || "",
      x: z.x, y: z.y, w: z.w, h: z.h,
    })),
  };
}
