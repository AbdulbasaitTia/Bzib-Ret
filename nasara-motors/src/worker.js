// Nasara Motors — Cloudflare Worker (API + image serving).
// Static pages are served from /public by Cloudflare's asset handler.
// Bindings: DB (D1), PHOTOS (KV, photos stored as values).
// Free KV limits: 1 GB storage, 1,000 writes/day; photos are compressed in the browser first.
// Secrets: ADMIN_PASSWORD, SESSION_SECRET, RESEND_API_KEY (for inquiry emails).
// Vars: INQUIRY_EMAIL (where inquiry emails go), INQUIRY_FROM (optional sender).

const SESSION_DAYS = 14;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // KV allows up to 25 MB per value
const IMAGE_TYPES = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
const LOGIN_LIMIT = 8; // failed attempts per 15 minutes per IP
const LOGIN_WINDOW = 15 * 60;
const DEFAULT_INQUIRY_EMAIL = "Iddrisdecons@gmail.com";
const DEFAULT_INQUIRY_FROM = "Nasara Motors <onboarding@resend.dev>";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith("/api/")) return await api(request, env, url, ctx);
      if (url.pathname.startsWith("/img/")) return await serveImage(request, env, url);
      return env.ASSETS.fetch(request);
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message }, err.status);
      console.error(err);
      return json({ error: "Something went wrong" }, 500);
    }
  },
};

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

// ---------- Routing ----------
async function api(request, env, url, ctx) {
  const p = url.pathname;
  const m = request.method;

  // Basic CSRF guard: state-changing requests must come from this site.
  if (m !== "GET" && m !== "HEAD") {
    const origin = request.headers.get("origin");
    if (origin && origin !== url.origin) throw new HttpError(403, "Bad origin");
  }

  // Public
  if (p === "/api/bikes" && m === "GET") return json({ bikes: await listBikes(env) }, 200, { "cache-control": "no-cache" });
  const one = p.match(/^\/api\/bikes\/([\w-]{1,64})$/);
  if (one && m === "GET") {
    const bike = await getBike(env, one[1]);
    if (!bike) throw new HttpError(404, "Not found");
    return json({ bike });
  }
  if (p === "/api/settings" && m === "GET") return json({ settings: await getSettings(env) }, 200, { "cache-control": "no-cache" });
  if (p === "/api/inquiries" && m === "POST") return createInquiry(request, env, ctx, url);
  // "Sell your bike" is switched off: Nasara Motors only sells brand new bikes.

  // Auth
  if (p === "/api/login" && m === "POST") return login(request, env);
  if (p === "/api/logout" && m === "POST") return json({ ok: true }, 200, { "set-cookie": cookie("", 0) });
  if (p === "/api/me" && m === "GET") return json({ admin: await isAdmin(request, env) });

  // Admin
  if (p.startsWith("/api/admin/")) {
    if (!(await isAdmin(request, env))) throw new HttpError(401, "Please log in");
    if (p === "/api/admin/overview" && m === "GET") return adminOverview(env);
    if (p === "/api/admin/bikes" && m === "POST") return saveBike(request, env, null);
    const b = p.match(/^\/api\/admin\/bikes\/([\w-]{1,64})$/);
    if (b && m === "PUT") return saveBike(request, env, b[1]);
    if (b && m === "DELETE") return deleteBike(env, b[1]);
    const s = p.match(/^\/api\/admin\/bikes\/([\w-]{1,64})\/status$/);
    if (s && m === "POST") return setStatus(request, env, s[1]);
    if (p === "/api/admin/upload" && m === "POST") return uploadImages(request, env, "bikes");
    if (p === "/api/admin/hero" && m === "POST") return uploadHero(request, env);
    const di = p.match(/^\/api\/admin\/inquiries\/([\w-]{1,64})$/);
    if (di && m === "DELETE") { await env.DB.prepare("DELETE FROM inquiries WHERE id=?").bind(di[1]).run(); return json({ ok: true }); }
    const ds = p.match(/^\/api\/admin\/sell\/([\w-]{1,64})$/);
    if (ds && m === "DELETE") return deleteSell(env, ds[1]);
  }
  throw new HttpError(404, "Not found");
}

// ---------- Bikes ----------
function rowToBike(r) {
  return { ...r, featured: !!r.featured, images: safeArray(r.images) };
}
function safeArray(s) { try { const a = JSON.parse(s); return Array.isArray(a) ? a : []; } catch { return []; } }

async function listBikes(env) {
  const { results } = await env.DB.prepare("SELECT * FROM bikes ORDER BY created_at DESC").all();
  return results.map(rowToBike);
}
async function getBike(env, id) {
  const r = await env.DB.prepare("SELECT * FROM bikes WHERE id=?").bind(id).first();
  return r ? rowToBike(r) : null;
}

function str(v, max, required = false, label = "Field") {
  const s = String(v ?? "").trim();
  if (required && !s) throw new HttpError(400, `${label} is required`);
  if (s.length > max) throw new HttpError(400, `${label} is too long`);
  return s;
}
function num(v, min, max, label, nullable = true) {
  if (v === null || v === undefined || v === "") {
    if (nullable) return null;
    throw new HttpError(400, `${label} is required`);
  }
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new HttpError(400, `${label} is not valid`);
  return n;
}

async function saveBike(request, env, id) {
  const body = await request.json().catch(() => { throw new HttpError(400, "Bad request"); });
  const images = Array.isArray(body.images) ? body.images : [];
  if (images.length > 12) throw new HttpError(400, "Up to 12 photos per bike");
  for (const k of images) if (typeof k !== "string" || !/^bikes\/[\w-]+\.(jpg|png|webp)$/.test(k)) throw new HttpError(400, "Bad photo");
  const status = body.status === "sold" ? "sold" : "available";
  const b = {
    name: str(body.name, 100, true, "Name"),
    model: str(body.model, 100, false, "Model"),
    year: num(body.year, 1950, 2035, "Year"),
    price: num(body.price, 0, 100_000_000, "Price", false),
    old_price: num(body.old_price, 0, 100_000_000, "Old price"),
    engine: str(body.engine, 40, false, "Engine"),
    category: str(body.category, 40, false, "Category") || "Commuter",
    condition: str(body.condition, 40, false, "Condition") || "Brand new",
    colour: str(body.colour, 60, false, "Colour"),
    city: str(body.city, 60, false, "City") || "Accra",
    description: str(body.description, 2000, false, "Description"),
    status,
    featured: body.featured === false ? 0 : 1,
    images: JSON.stringify(images),
  };
  if (id) {
    const existing = await getBike(env, id);
    if (!existing) throw new HttpError(404, "Bike not found");
    await env.DB.prepare(
      "UPDATE bikes SET name=?,model=?,year=?,price=?,old_price=?,engine=?,category=?,condition=?,colour=?,city=?,description=?,status=?,featured=?,images=? WHERE id=?"
    ).bind(b.name, b.model, b.year, b.price, b.old_price, b.engine, b.category, b.condition, b.colour, b.city, b.description, b.status, b.featured, b.images, id).run();
    // Remove photos that were taken off this bike.
    const removed = existing.images.filter((k) => !images.includes(k));
    await deletePhotos(env, removed);
    return json({ ok: true, id });
  }
  const newId = slugId(b.name);
  await env.DB.prepare(
    "INSERT INTO bikes (id,name,model,year,price,old_price,engine,category,condition,colour,city,description,status,featured,images) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
  ).bind(newId, b.name, b.model, b.year, b.price, b.old_price, b.engine, b.category, b.condition, b.colour, b.city, b.description, b.status, b.featured, b.images).run();
  return json({ ok: true, id: newId });
}

function slugId(name) {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "bike";
  return `${base}-${crypto.randomUUID().slice(0, 6)}`;
}

async function setStatus(request, env, id) {
  const body = await request.json().catch(() => ({}));
  const status = body.status === "sold" ? "sold" : "available";
  await env.DB.prepare("UPDATE bikes SET status=? WHERE id=?").bind(status, id).run();
  return json({ ok: true });
}

async function deleteBike(env, id) {
  const bike = await getBike(env, id);
  if (!bike) throw new HttpError(404, "Bike not found");
  await env.DB.prepare("DELETE FROM bikes WHERE id=?").bind(id).run();
  await deletePhotos(env, bike.images);
  return json({ ok: true });
}

// ---------- Images ----------
async function storeImage(env, folder, file) {
  if (!(file instanceof File)) throw new HttpError(400, "Bad file");
  const ext = IMAGE_TYPES[file.type];
  if (!ext) throw new HttpError(400, "Photos must be JPG, PNG or WebP");
  if (file.size > MAX_IMAGE_BYTES) throw new HttpError(400, "Photo too large (max 8 MB)");
  const key = `${folder}/${crypto.randomUUID()}.${ext}`;
  await env.PHOTOS.put(key, await file.arrayBuffer(), { metadata: { contentType: file.type } });
  return key;
}

async function deletePhotos(env, keys) {
  for (const k of keys || []) if (k) await env.PHOTOS.delete(k);
}

async function uploadImages(request, env, folder) {
  const form = await request.formData();
  const files = form.getAll("photos");
  if (!files.length || files.length > 12) throw new HttpError(400, "Choose 1 to 12 photos");
  const keys = [];
  for (const f of files) keys.push(await storeImage(env, folder, f));
  return json({ keys });
}

async function uploadHero(request, env) {
  const form = await request.formData();
  const key = await storeImage(env, "site", form.get("photo"));
  const old = await env.DB.prepare("SELECT value FROM settings WHERE key='hero'").first();
  await env.DB.prepare("INSERT INTO settings (key,value) VALUES ('hero',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(key).run();
  if (old?.value) await deletePhotos(env, [old.value]);
  return json({ ok: true, key });
}

async function serveImage(request, env, url) {
  const key = decodeURIComponent(url.pathname.slice(5));
  if (!/^(bikes|site|sell)\/[\w-]+\.(jpg|png|webp)$/.test(key)) return new Response("Not found", { status: 404 });
  // Photos people send with "Sell your bike" are private: admin only.
  const isPrivate = key.startsWith("sell/");
  if (isPrivate && !(await isAdmin(request, env))) return new Response("Not found", { status: 404 });
  const { value, metadata } = await env.PHOTOS.getWithMetadata(key, { type: "stream", cacheTtl: 86400 });
  if (!value) return new Response("Not found", { status: 404 });
  const headers = new Headers();
  headers.set("content-type", metadata?.contentType || "image/webp");
  headers.set("etag", `"${key.split("/")[1]}"`);
  headers.set("cache-control", isPrivate ? "private, no-store" : "public, max-age=31536000, immutable");
  headers.set("x-content-type-options", "nosniff");
  return new Response(value, { headers });
}

// ---------- Settings ----------
async function getSettings(env) {
  const { results } = await env.DB.prepare("SELECT key, value FROM settings WHERE key IN ('hero')").all();
  return Object.fromEntries(results.map((r) => [r.key, r.value]));
}

// ---------- Public forms ----------
async function createInquiry(request, env, ctx, url) {
  const body = await request.json().catch(() => { throw new HttpError(400, "Bad request"); });
  if (body.website) return json({ ok: true }); // honeypot: bots fill hidden field
  const bikeId = body.bike_id ? str(body.bike_id, 64) : null;
  const inquiry = {
    name: str(body.name, 100, true, "Name"),
    phone: str(body.phone, 30, true, "Phone"),
    message: str(body.message, 1000),
  };
  await env.DB.prepare("INSERT INTO inquiries (id,bike_id,name,phone,message) VALUES (?,?,?,?,?)")
    .bind(crypto.randomUUID(), bikeId, inquiry.name, inquiry.phone, inquiry.message).run();
  // Email the shop in the background; the inquiry is already saved even if email fails.
  const send = emailInquiry(env, inquiry, bikeId, url.origin).catch((err) => console.error("Inquiry email failed:", err));
  if (ctx?.waitUntil) ctx.waitUntil(send); else await send;
  return json({ ok: true });
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

async function emailInquiry(env, inquiry, bikeId, origin) {
  if (!env.RESEND_API_KEY) { console.warn("RESEND_API_KEY not set: inquiry email skipped"); return; }
  const to = env.INQUIRY_EMAIL || DEFAULT_INQUIRY_EMAIL;
  const bike = bikeId ? await getBike(env, bikeId) : null;
  const bikeLabel = bike ? [bike.name, bike.model].filter(Boolean).join(" ") : "";
  const subject = `New inquiry${bikeLabel ? ` — ${bikeLabel}` : ""} from ${inquiry.name}`;
  const rows = [
    ["Name", inquiry.name],
    ["Phone", inquiry.phone],
    ["Bike", bikeLabel],
    ["Website", origin],
    ["Message", inquiry.message],
  ].filter(([, v]) => v);
  const text = rows.map(([k, v]) => `${k}: ${v}`).join("\n");
  const html = `<h2>New inquiry on Nasara Motors</h2><table cellpadding="6">${rows
    .map(([k, v]) => `<tr><td><b>${escapeHtml(k)}</b></td><td>${escapeHtml(v).replace(/\n/g, "<br>")}</td></tr>`)
    .join("")}</table>`;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ from: env.INQUIRY_FROM || DEFAULT_INQUIRY_FROM, to: [to], subject, text, html }),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
}

async function createSellRequest(request, env) {
  const form = await request.formData();
  if (form.get("website")) return json({ ok: true });
  const files = form.getAll("photos").filter((f) => f instanceof File && f.size > 0);
  if (files.length > 5) throw new HttpError(400, "Up to 5 photos");
  const data = {
    name: str(form.get("name"), 100, true, "Name"),
    phone: str(form.get("phone"), 30, true, "Phone"),
    bike: str(form.get("bike"), 150, true, "Bike"),
    year: num(form.get("year"), 1950, 2035, "Year"),
    asking_price: num(form.get("asking_price"), 0, 100_000_000, "Asking price"),
    location: str(form.get("location"), 100),
  };
  const keys = [];
  for (const f of files) keys.push(await storeImage(env, "sell", f));
  await env.DB.prepare("INSERT INTO sell_requests (id,name,phone,bike,year,asking_price,location,photos) VALUES (?,?,?,?,?,?,?,?)")
    .bind(crypto.randomUUID(), data.name, data.phone, data.bike, data.year, data.asking_price, data.location, JSON.stringify(keys)).run();
  return json({ ok: true });
}

async function adminOverview(env) {
  const [inq, sell] = await Promise.all([
    env.DB.prepare("SELECT i.*, b.name AS bike_name, b.model AS bike_model FROM inquiries i LEFT JOIN bikes b ON b.id = i.bike_id ORDER BY i.created_at DESC LIMIT 200").all(),
    env.DB.prepare("SELECT * FROM sell_requests ORDER BY created_at DESC LIMIT 200").all(),
  ]);
  return json({
    inquiries: inq.results,
    sellRequests: sell.results.map((r) => ({ ...r, photos: safeArray(r.photos) })),
  });
}

async function deleteSell(env, id) {
  const r = await env.DB.prepare("SELECT photos FROM sell_requests WHERE id=?").bind(id).first();
  if (!r) throw new HttpError(404, "Not found");
  await env.DB.prepare("DELETE FROM sell_requests WHERE id=?").bind(id).run();
  const photos = safeArray(r.photos);
  await deletePhotos(env, photos);
  return json({ ok: true });
}

// ---------- Auth ----------
// One admin password (Cloudflare secret ADMIN_PASSWORD). Sessions are signed cookies.
function cookie(value, maxAge) {
  return `nm_session=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
}

async function hmac(env, data) {
  if (!env.SESSION_SECRET || !env.ADMIN_PASSWORD) throw new HttpError(500, "Admin login is not set up yet");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.SESSION_SECRET + "|" + env.ADMIN_PASSWORD), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function safeEqual(a, b) {
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

async function isAdmin(request, env) {
  if (!env.SESSION_SECRET || !env.ADMIN_PASSWORD) return false;
  const c = request.headers.get("cookie") || "";
  const m = c.match(/(?:^|;\s*)nm_session=([^;]+)/);
  if (!m) return false;
  const [exp, sig] = m[1].split(".");
  if (!exp || !sig || Number(exp) < Date.now() / 1000) return false;
  return safeEqual(sig, await hmac(env, `admin.${exp}`));
}

async function login(request, env) {
  if (!env.SESSION_SECRET || !env.ADMIN_PASSWORD) throw new HttpError(500, "Admin login is not set up yet");
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  const now = Math.floor(Date.now() / 1000);
  const rec = await env.DB.prepare("SELECT count, window_start FROM login_attempts WHERE ip=?").bind(ip).first();
  if (rec && now - rec.window_start < LOGIN_WINDOW && rec.count >= LOGIN_LIMIT) {
    throw new HttpError(429, "Too many attempts. Try again in 15 minutes.");
  }
  const body = await request.json().catch(() => ({}));
  const ok = safeEqual(String(body.password ?? ""), env.ADMIN_PASSWORD);
  if (!ok) {
    if (!rec || now - rec.window_start >= LOGIN_WINDOW) {
      await env.DB.prepare("INSERT INTO login_attempts (ip,count,window_start) VALUES (?,1,?) ON CONFLICT(ip) DO UPDATE SET count=1, window_start=excluded.window_start").bind(ip, now).run();
    } else {
      await env.DB.prepare("UPDATE login_attempts SET count=count+1 WHERE ip=?").bind(ip).run();
    }
    throw new HttpError(401, "Wrong password");
  }
  await env.DB.prepare("DELETE FROM login_attempts WHERE ip=?").bind(ip).run();
  const exp = now + SESSION_DAYS * 86400;
  const token = `${exp}.${await hmac(env, `admin.${exp}`)}`;
  return json({ ok: true }, 200, { "set-cookie": cookie(token, SESSION_DAYS * 86400) });
}
