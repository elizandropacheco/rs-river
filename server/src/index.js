// Servidor único, SEM dependências externas (só Node nativo):
//   - API REST em /api/*
//   - WebSocket em /ws (tempo real)
//   - serve o front estático de ./public
//   - agenda o crawler a cada CRAWL_INTERVAL_MIN minutos
import http from "http";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

import { STATIONS, RIVER_COLORS } from "./stations.js";
import { SEED } from "./seed.js";
import * as store from "./store.js";
import * as settings from "./settings.js";
import { crawlAll } from "./crawler.js";
import { WSHub } from "./ws.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8080;
const INTERVAL_MIN = Number(process.env.CRAWL_INTERVAL_MIN || 5);
const PUBLIC = path.join(__dirname, "..", "public");

store.load();
settings.load();

// Popula com o seed na primeira execução para a dashboard abrir cheia.
function ensureSeed() {
  const today = new Date().toISOString().slice(0, 10);
  for (const st of STATIONS) {
    if (store.getSnapshot(st.slug)) continue;
    const s = SEED[st.slug];
    if (!s) continue;
    const level = s.level, flood = st.flood, r = level / flood;
    const status = r >= 1 ? "inundacao" : r >= 0.9 ? "alerta" : r >= 0.75 ? "atencao" : "normal";
    // NÃO semeia histórico: o crawler traz ~30 dias reais logo no 1º ciclo.
    // Semear com os horários do seed criava pontos fantasmas no fim da série
    // (horários que ainda não têm leitura real), distorcendo gráfico e tendência.
    store.record(st.slug, {
      slug: st.slug, city: st.city, river: st.river, lat: st.lat, lng: st.lng,
      level, flood, status, rate: s.rate, record: s.record, rain: s.rain,
      marginToFlood: +(flood - level).toFixed(2),
      ts: new Date().toISOString(), live: false, url: `https://nivelguaiba.com.br/${st.slug}`,
    });
  }
}
ensureSeed();

let lastRun = null;

// ---- roteamento simples --------------------------------------------------
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml",
  ".ico": "image/x-icon", ".png": "image/png", ".webp": "image/webp",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".xml": "application/xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8", ".webmanifest": "application/manifest+json",
};

// Cache: HTML sempre revalida (mudanças de GTM/SEO valem na hora); imagens
// aguentam 1 dia; js/css 5 min (não há fingerprint nos nomes).
const CACHE_BY_EXT = {
  ".html": "no-cache",
  ".png": "public, max-age=86400", ".jpg": "public, max-age=86400",
  ".jpeg": "public, max-age=86400", ".webp": "public, max-age=86400",
  ".svg": "public, max-age=86400", ".ico": "public, max-age=86400",
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(body);
}

// "SSR parcial" para SEO: o HTML do index sai do servidor já com os níveis
// atuais (texto real e fresco para o Googlebot e para IA/AI Overviews, sem
// depender da renderização de JS). A SPA substitui tudo ao montar.
const escHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const SSR_STATUS = { normal: "normal", atencao: "em atenção", alerta: "em alerta", inundacao: "em INUNDAÇÃO" };
function ssrLevelsHtml() {
  const snaps = Object.values(store.allSnapshots());
  if (!snaps.length) return "";
  const fmtBR = (n) => (n == null ? "—" : Number(n).toFixed(2).replace(".", ","));
  const items = snaps
    .slice()
    .sort((a, b) => a.city.localeCompare(b.city, "pt"))
    .map((s) => {
      const cota = s.flood != null ? ` (cota de inundação: ${fmtBR(s.flood)} m)` : "";
      return `<li><strong>${escHtml(s.city)}</strong> — ${escHtml(s.river)}: <strong>${fmtBR(s.level)} m</strong>, ${SSR_STATUS[s.status] || s.status}${cota}</li>`;
    })
    .join("\n        ");
  const when = new Date().toLocaleString("pt-BR", {
    timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit",
  });
  return `<ul class="about-levels">\n        ${items}\n      </ul>\n      <p class="about-updated">Leituras publicadas em ${when} (horário de Brasília) — os valores acima se atualizam automaticamente no painel.</p>`;
}

function sendHtml(res, html, code = 200) {
  let out = html.includes("<!--SSR:NIVEIS-->") ? html.replace("<!--SSR:NIVEIS-->", ssrLevelsHtml()) : html;
  res.writeHead(code, { "Content-Type": MIME[".html"], "Cache-Control": CACHE_BY_EXT[".html"] });
  res.end(settings.injectGtm(out));
}

function serveStatic(req, res) {
  let urlPath = decodeURIComponent(req.url.split("?")[0]);
  if (urlPath === "/") urlPath = "/index.html";
  if (urlPath === "/admin" || urlPath === "/admin/") urlPath = "/admin.html";
  let filePath = path.join(PUBLIC, path.normalize(urlPath).replace(/^(\.\.[/\\])+/, ""));
  if (!filePath.startsWith(PUBLIC)) return sendJson(res, 403, { error: "forbidden" });

  fs.readFile(filePath, (err, data) => {
    if (err) {
      // Fallback da SPA: mostra o app, mas com status 404 — URLs inexistentes
      // não podem ser indexadas como duplicatas do index (soft-404).
      const idx = path.join(PUBLIC, "index.html");
      if (fs.existsSync(idx)) return sendHtml(res, fs.readFileSync(idx, "utf8"), 404);
      res.writeHead(404); return res.end("Not found");
    }
    const ext = path.extname(filePath).toLowerCase();
    // Todo HTML servido passa pela injeção do GTM — plataforma inteira coberta.
    if (ext === ".html") return sendHtml(res, data.toString("utf8"));
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Cache-Control": CACHE_BY_EXT[ext] || "public, max-age=300",
    });
    res.end(data);
  });
}

// ---- admin (gestão do Google Tag Manager) --------------------------------
function isAuthed(req) {
  const h = req.headers["authorization"] || "";
  const bearer = h.startsWith("Bearer ") ? h.slice(7) : "";
  return settings.checkToken(bearer || req.headers["x-admin-token"]);
}

function readBody(req, limit = 16 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { reject(new Error("payload muito grande")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function handleAdmin(req, res, url) {
  if (!isAuthed(req)) return sendJson(res, 401, { error: "token inválido" });
  if (url === "/api/admin/settings" && req.method === "GET") {
    return sendJson(res, 200, { gtm: settings.getGtm() });
  }
  if (url === "/api/admin/settings" && (req.method === "PUT" || req.method === "POST")) {
    let body;
    try { body = JSON.parse((await readBody(req)) || "{}"); }
    catch { return sendJson(res, 400, { error: "JSON inválido" }); }
    const gtm = body.gtm || body;
    const result = settings.setGtm({ containerId: gtm.containerId, enabled: gtm.enabled });
    if (result.error) return sendJson(res, 400, { error: result.error });
    console.log(`[admin] GTM atualizado: ${result.gtm.enabled ? result.gtm.containerId : "desativado"}`);
    return sendJson(res, 200, result);
  }
  return sendJson(res, 404, { error: "rota não encontrada" });
}

const server = http.createServer((req, res) => {
  const url = req.url.split("?")[0];

  if (url === "/api/health") return sendJson(res, 200, { ok: true, stations: STATIONS.length });
  if (url.startsWith("/api/admin/")) return void handleAdmin(req, res, url);
  if (url === "/api/meta") return sendJson(res, 200, { rivers: RIVER_COLORS, intervalMin: INTERVAL_MIN });
  if (url === "/api/stations") {
    const snaps = Object.values(store.allSnapshots());
    return sendJson(res, 200, { updatedAt: lastRun, count: snaps.length, stations: snaps });
  }
  if (url === "/api/history") {
    const out = {};
    for (const st of STATIONS) out[st.slug] = store.getHistory(st.slug);
    return sendJson(res, 200, { history: out });
  }
  let m = url.match(/^\/api\/stations\/([a-z0-9]+)\/history$/);
  if (m) return sendJson(res, 200, { slug: m[1], points: store.getHistory(m[1]) });
  m = url.match(/^\/api\/stations\/([a-z0-9]+)$/);
  if (m) {
    const snap = store.getSnapshot(m[1]);
    return snap ? sendJson(res, 200, snap) : sendJson(res, 404, { error: "estação não encontrada" });
  }
  if (url.startsWith("/api/")) return sendJson(res, 404, { error: "rota não encontrada" });

  if (fs.existsSync(PUBLIC)) return serveStatic(req, res);
  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("API online. Front ainda não construído (rode via Docker).");
});

// ---- WebSocket -----------------------------------------------------------
const hub = new WSHub();
server.on("upgrade", (req, socket) => {
  if (req.url.split("?")[0] !== "/ws") { socket.destroy(); return; }
  const conn = hub.handleUpgrade(req, socket);
  if (conn) conn.send(JSON.stringify({ type: "snapshot", stations: Object.values(store.allSnapshots()), updatedAt: lastRun }));
});

// ---- ciclo do crawler ----------------------------------------------------
let running = false;
async function runCycle() {
  if (running) return;
  running = true;
  const t0 = Date.now();
  try {
    const results = await crawlAll((snap) => hub.broadcast({ type: "update", station: snap }));
    lastRun = new Date().toISOString();
    const live = results.filter((r) => r.live).length;
    console.log(`[crawler] ciclo ok: ${results.length} estações (${live} ao vivo) em ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    hub.broadcast({ type: "snapshot", stations: results, updatedAt: lastRun });
  } catch (e) {
    console.error("[crawler] erro no ciclo:", e.message);
  } finally {
    running = false;
  }
}

server.listen(PORT, () => {
  console.log(`\n🌊  Rios Dashboard em http://localhost:${PORT}`);
  console.log(`    Coletando de nivelguaiba.com.br a cada ${INTERVAL_MIN} min\n`);
  runCycle();
  setInterval(runCycle, INTERVAL_MIN * 60 * 1000);
});
