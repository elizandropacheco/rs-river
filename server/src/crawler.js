// Crawler do nivelguaiba.com.br
// Estratégia em camadas para ser resiliente a mudanças de layout:
//   1) tenta achar JSON embutido (__NEXT_DATA__ / dados estruturados)
//   2) cai para extração por regex sobre o texto (rótulos em português)
//   3) qualquer campo não encontrado mantém o valor anterior / seed
// O valor mais importante (nível atual) tem várias estratégias de captura.

import { STATIONS, BASE_URL } from "./stations.js";
import { SEED } from "./seed.js";
import * as store from "./store.js";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0 Safari/537.36";

// Converte "21.34" ou "21,34" para número respeitando os dois formatos.
function parseNumber(raw) {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (s.includes(",") && s.includes(".")) s = s.replace(/\./g, "").replace(",", ".");
  else s = s.replace(",", ".");
  const v = parseFloat(s.replace(/[^\d.-]/g, ""));
  return Number.isFinite(v) ? v : null;
}

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&aacute;/gi, "á").replace(/&atilde;/gi, "ã").replace(/&ccedil;/gi, "ç")
    .replace(/\s+/g, " ")
    .trim();
}

function statusFor(level, flood) {
  if (level == null || !flood) return "normal";
  const r = level / flood;
  if (r >= 1) return "inundacao";
  if (r >= 0.9) return "alerta";
  if (r >= 0.75) return "atencao";
  return "normal";
}

// --- estratégia 2: regex sobre o texto -----------------------------------
function parseFromText(text, station) {
  const out = {};

  // Cota de inundação
  const cota = text.match(/cota\s+de\s+inunda[çc][ãa]o[:\s]*([\d.,]+)/i);
  if (cota) out.flood = parseNumber(cota[1]);

  // Taxa de subida/descida (cm/h)
  const rate = text.match(/([-−]?\s*[\d.,]+)\s*cm\s*\/?\s*h(?:ora)?/i);
  if (rate) {
    let v = parseNumber(rate[1].replace("−", "-"));
    if (/desc|baix|caindo/i.test(text.slice(Math.max(0, rate.index - 30), rate.index))) v = -Math.abs(v);
    out.rate = v;
  }

  // Pico / recorde histórico + data
  const rec = text.match(/(?:pico\s+hist[oó]rico|recorde|maior\s+n[ií]vel)[^\d]{0,40}([\d.,]+)\s*m[^\d]{0,12}(\d{2}\/\d{2}\/\d{4})/i);
  if (rec) out.record = { level: parseNumber(rec[1]), date: brToIso(rec[2]) };

  // Precipitação
  const choveu = text.match(/choveu\s+hoje[:\s]*([\d.,]+)\s*mm/i);
  if (choveu) out.rainToday = parseNumber(choveu[1]);
  const prev = text.match(/previs[ãa]o\s+hoje[:\s]*([\d.,]+)\s*mm/i);
  if (prev) out.rainForecast = parseNumber(prev[1]);
  const week = text.match(/(?:7\s*dias|pr[oó]ximos\s+7)[^\d]{0,40}?([\d.,]+)\s*mm/i);
  if (week) out.rainWeek = parseNumber(week[1]);

  // Histórico recente: pares HH:MM + nível
  const pairs = [];
  const re = /(\d{1,2}:\d{2})\s+([\d]{1,3}[.,]\d{1,2})(?!\d)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const t = m[1];
    const v = parseNumber(m[2]);
    if (v != null && v >= 0 && v < 60) pairs.push([t.padStart(5, "0"), v]);
  }
  // remove duplicados de horário mantendo a ordem
  const seen = new Set();
  out.history = pairs.filter(([t]) => (seen.has(t) ? false : (seen.add(t), true)));

  // Nível atual: última leitura do histórico (mais confiável),
  // senão número + m no <title>/topo.
  if (out.history.length) out.level = out.history[out.history.length - 1][1];

  return out;
}

function brToIso(br) {
  const [d, mo, y] = br.split("/");
  return `${y}-${mo}-${d}`;
}

// --- estratégia 1: JSON embutido -----------------------------------------
function parseFromJson(html) {
  try {
    const m = html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (!m) return null;
    const data = JSON.parse(m[1]);
    const found = {};
    const visit = (o) => {
      if (!o || typeof o !== "object") return;
      for (const [k, v] of Object.entries(o)) {
        const key = k.toLowerCase();
        if (typeof v === "number") {
          if (/(^|_)(nivel|level|cota_atual|leitura)/.test(key) && found.level == null) found.level = v;
          if (/inunda|cota_alerta|threshold/.test(key) && found.flood == null) found.flood = v;
        }
        if (typeof v === "object") visit(v);
      }
    };
    visit(data);
    return Object.keys(found).length ? found : null;
  } catch {
    return null;
  }
}

// Título da página costuma trazer "X.XX m - Cidade | Nível Guaíba"
function levelFromTitle(html) {
  const t = html.match(/<title>([^<]*)<\/title>/i);
  if (!t) return null;
  const m = t[1].match(/([\d]{1,3}[.,]\d{1,2})\s*m\b/);
  return m ? parseNumber(m[1]) : null;
}

async function fetchHtml(url) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA, "Accept-Language": "pt-BR" }, signal: ctrl.signal });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return await res.text();
  } finally {
    clearTimeout(to);
  }
}

export async function crawlStation(station) {
  const prev = store.getSnapshot(station.slug) || {};
  const seed = SEED[station.slug] || {};
  const url = `${BASE_URL}/${station.slug}`;

  let parsed = {};
  let ok = false;
  try {
    const html = await fetchHtml(url);
    const text = stripHtml(html);
    const json = parseFromJson(html) || {};
    const textData = parseFromText(text, station);
    const titleLevel = levelFromTitle(html);
    parsed = { ...textData, ...json };
    if (parsed.level == null && titleLevel != null) parsed.level = titleLevel;
    ok = parsed.level != null;
  } catch (e) {
    console.warn(`[crawler] ${station.slug}: ${e.message} (usando dados anteriores/seed)`);
  }

  // mescla: parsed > snapshot anterior > seed > metadado fixo
  const level = pick(parsed.level, prev.level, seed.level);
  const flood = pick(parsed.flood, prev.flood, seed.flood, station.flood);
  const record = parsed.record || prev.record || seed.record || null;
  const history = (parsed.history && parsed.history.length ? parsed.history : null);

  const snapshot = {
    slug: station.slug,
    city: station.city,
    river: station.river,
    lat: station.lat,
    lng: station.lng,
    level,
    flood,
    status: statusFor(level, flood),
    rate: pick(parsed.rate, seed.rate, 0),
    record,
    rain: {
      today: pick(parsed.rainToday, seed.rain?.today, 0),
      forecast: pick(parsed.rainForecast, seed.rain?.forecast, 0),
      week: pick(parsed.rainWeek, seed.rain?.week, 0),
    },
    marginToFlood: flood != null && level != null ? +(flood - level).toFixed(2) : null,
    ts: nowIso(),
    live: ok,
    url,
  };

  // semeia o histórico de longo prazo na primeira execução
  if (store.getHistory(station.slug).length === 0) {
    const src = history || seed.history || [];
    const today = new Date().toISOString().slice(0, 10);
    store.seedHistory(
      station.slug,
      src.map(([t, v]) => ({ t: `${today}T${t}:00`, v }))
    );
  }

  store.record(station.slug, snapshot);
  return snapshot;
}

function pick(...vals) {
  for (const v of vals) if (v != null && !(typeof v === "number" && Number.isNaN(v))) return v;
  return null;
}

function nowIso() {
  return new Date().toISOString();
}

// Roda um ciclo completo sobre todas as estações (com concorrência limitada).
export async function crawlAll(onEach) {
  const results = [];
  const queue = [...STATIONS];
  const workers = Array.from({ length: 4 }, async () => {
    while (queue.length) {
      const st = queue.shift();
      const snap = await crawlStation(st);
      results.push(snap);
      if (onEach) onEach(snap);
    }
  });
  await Promise.all(workers);
  return results;
}
