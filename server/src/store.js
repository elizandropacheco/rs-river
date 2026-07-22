// Armazenamento simples em arquivo JSON (sem dependências externas).
// Guarda o snapshot atual de cada estação + a série histórica de elevação
// que vai sendo acumulada a cada ciclo do crawler (persistida em disco).
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");
const FILE = path.join(DATA_DIR, "history.json");

// Limite de pontos guardados por estação (aprox. 30 dias a cada 15 min).
const MAX_POINTS = 3000;

let db = { snapshots: {}, history: {} };

export function load() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(FILE)) {
      db = JSON.parse(fs.readFileSync(FILE, "utf8"));
      db.snapshots ||= {};
      db.history ||= {};
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

// Registra o snapshot atual e adiciona um ponto na série histórica,
// evitando duplicar o mesmo timestamp.
export function record(slug, snapshot) {
  db.snapshots[slug] = snapshot;
  const hist = (db.history[slug] ||= []);
  const t = snapshot.ts;
  const last = hist[hist.length - 1];
  if (!last || last.t !== t) {
    hist.push({ t, v: snapshot.level });
    if (hist.length > MAX_POINTS) hist.splice(0, hist.length - MAX_POINTS);
  } else {
    last.v = snapshot.level;
  }
  persist();
}

// Semeia o histórico com os pontos recentes vindos do site (uma vez).
export function seedHistory(slug, points) {
  const hist = (db.history[slug] ||= []);
  if (hist.length > 0) return;
  for (const p of points) hist.push(p);
}
