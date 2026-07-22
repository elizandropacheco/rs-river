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
import { crawlAll } from "./crawler.js";
import { WSHub } from "./ws.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8080;
const INTERVAL_MIN = Number(process.env.CRAWL_INTERVAL_MIN || 5);
const PUBLIC = path.join(__dirname, "..", "public");

store.load();

// Popula com o seed na primeira execução para a dashboard abrir cheia.
function ensureSeed() {
  const today = new Date().toISOString().slice(0, 10);
  for (const st of STATIONS) {
    if (store.getSnapshot(st.slug)) continue;
    const s = SEED[st.slug];
    if (!s) continue;
    const level = s.level, flood = st.flood, r = level / flood;
    const status = r >= 1 ? "inundacao" : r >= 0.9 ? "alerta" : r >= 0.75 ? "atencao" : "normal";
    store.seedHistory(st.slug, s.history.map(([t, v]) => ({ t: `${today}T${t}:00`, v })));
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
  ".ico": "image/x-icon", ".png": "image/png", ".webmanifest": "application/manifest+json",
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(body);
}

function serveStatic(req, res) {
  let urlPath = decodeURIComponent(req.url.split("?")[0]);
  if (urlPath === "/") urlPath = "/index.html";
  let filePath = path.join(PUBLIC, path.normalize(urlPath).replace(/^(\.\.[/\\])+/, ""));
  if (!filePath.startsWith(PUBLIC)) return sendJson(res, 403, { error: "forbidden" });

  fs.readFile(filePath, (err, data) => {
    if (err) {
      // SPA fallback -> index.html
      const idx = path.join(PUBLIC, "index.html");
      if (fs.existsSync(idx)) {
        res.writeHead(200, { "Content-Type": MIME[".html"] });
        return res.end(fs.readFileSync(idx));
      }
      res.writeHead(404); return res.end("Not found");
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const url = req.url.split("?")[0];

  if (url === "/api/health") return sendJson(res, 200, { ok: true, stations: STATIONS.length });
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
