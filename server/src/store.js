// Armazenamento simples em arquivo JSON (sem dependências externas).
// Guarda o snapshot atual de cada estação + a série histórica de elevação
// que vai sendo acumulada a cada ciclo do crawler (persistida em disco).
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");
const FILE = path.join(DATA_DIR, "history.json");

// Limite de pontos guardados por estação. Com leituras a cada ~15 min,
// 9000 pontos cobrem ~90 dias — espaço para popular bastante histórico.
const MAX_POINTS = 9000;

let db = { snapshots: {}, history: {} };

// Timestamp canônico "YYYY-MM-DDTHH:MM" (sem segundos). Sem isso o mesmo
// instante gravado como ...T08:30 e ...T08:30:00 vira DOIS pontos, e as duas
// séries acabam intercaladas no gráfico.
export const canonT = (t) => String(t).replace(/T(\d{2}:\d{2}):\d{2}$/, "T$1");

// Normaliza + deduplica uma série (mantém o último valor de cada timestamp).
function normalizeSeries(list) {
  const byT = new Map();
  for (const p of list || []) {
    if (!p || p.v == null || !p.t) continue;
    byT.set(canonT(p.t), p.v);
  }
  return [...byT.entries()]
    .map(([t, v]) => ({ t, v }))
    .sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
}

export function load() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(FILE)) {
      db = JSON.parse(fs.readFileSync(FILE, "utf8"));
      db.snapshots ||= {};
      db.history ||= {};
      // migra históricos antigos (timestamps com segundos / duplicados)
      for (const slug of Object.keys(db.history)) {
        db.history[slug] = normalizeSeries(db.history[slug]);
      }
    }
  } catch (e) {
    console.error("[store] falha ao carregar:", e.message);
  }
  return db;
}

let saveTimer = null;
export function persist() {
  clearTimeout(saveTimer);
  // debounce de escrita em disco
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(FILE, JSON.stringify(db));
    } catch (e) {
      console.error("[store] falha ao salvar:", e.message);
    }
  }, 400);
}

export function getSnapshot(slug) {
  return db.snapshots[slug];
}

export function allSnapshots() {
  return db.snapshots;
}

export function getHistory(slug) {
  return db.history[slug] || [];
}

// Registra o snapshot atual. O histórico é mantido pelo crawler via
// mergeSeries (série oficial do nivelguaiba), então aqui só guardamos o snapshot.
export function record(slug, snapshot) {
  db.snapshots[slug] = snapshot;
  persist();
}

// Mescla uma série [{t, v}] no histórico da estação: atualiza pontos
// existentes (mesmo timestamp) e insere novos, mantendo ordem e limite.
// É idempotente — re-buscar a série a cada ciclo não duplica pontos.
export function mergeSeries(slug, points) {
  if (!points || !points.length) return;
  const hist = (db.history[slug] ||= []);
  const idx = new Map(hist.map((p, i) => [p.t, i]));
  for (const p of points) {
    if (!p || p.v == null || !p.t) continue;
    const t = canonT(p.t);
    const i = idx.get(t);
    if (i == null) { hist.push({ t, v: p.v }); idx.set(t, hist.length - 1); }
    else hist[i].v = p.v;
  }
  hist.sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
  if (hist.length > MAX_POINTS) hist.splice(0, hist.length - MAX_POINTS);
  persist();
}

// Semeia o histórico com os pontos recentes vindos do site (uma vez).
export function seedHistory(slug, points) {
  const hist = (db.history[slug] ||= []);
  if (hist.length > 0) return;
  for (const p of points) hist.push({ t: canonT(p.t), v: p.v });
}
