// Coletor do nivelguaiba.com.br usando os endpoints JSON públicos do próprio
// site (mesma fonte, muito mais estável que raspar o HTML):
//   • /<slug>.json / .7days.json / .30days.json / .90days.json  → série de nível
//   • /<slug>.weather.json                                        → chuva/previsão
// A cota de inundação e o recorde histórico são estáveis e vêm dos metadados
// (stations.js) / seed. A tendência (cm/h) é calculada sobre a série.
//
// Estratégia de histórico: na primeira coleta (histórico raso) busca uma série
// longa para POPULAR dados passados; nos ciclos seguintes busca só os últimos
// 7 dias e mescla (dedup por timestamp) — barato e autocorretivo.

import { STATIONS, BASE_URL } from "./stations.js";
import { SEED } from "./seed.js";
import * as store from "./store.js";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0 Safari/537.36";

// Faixa usada para popular o histórico na primeira coleta: 7days|30days|90days.
const SEED_RANGE = process.env.HISTORY_SEED_RANGE || "30days";
// Abaixo deste nº de pontos o histórico é considerado "raso" e busca a série longa.
const SEED_MIN_POINTS = 700; // ~7 dias a cada 15 min

// Converte "21.34" ou "21,34" para número respeitando os dois formatos.
function parseNumber(raw) {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (s.includes(",") && s.includes(".")) s = s.replace(/\./g, "").replace(",", ".");
  else s = s.replace(",", ".");
  const v = parseFloat(s.replace(/[^\d.-]/g, ""));
  return Number.isFinite(v) ? v : null;
}

function statusFor(level, flood) {
  if (level == null || !flood) return "normal";
  const r = level / flood;
  if (r >= 1) return "inundacao";
  if (r >= 0.9) return "alerta";
  if (r >= 0.75) return "atencao";
  return "normal";
}

async function fetchJson(url) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "application/json", "Accept-Language": "pt-BR" },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return await res.json();
  } finally {
    clearTimeout(to);
  }
}

// "2026-07-16 10:30" -> "2026-07-16T10:30"
const normTs = (k) => String(k).replace(" ", "T");

// Remove quedas bruscas (falha de sensor / dropout, ex.: 20 m → 0,02 m).
// Usa a mediana de uma janela ao redor de cada ponto: como a mediana ignora
// alguns valores ruins, pega até dropouts consecutivos, sem cortar subidas
// reais (numa cheia a mediana da janela acompanha o nível).
function despike(pts) {
  if (pts.length < 7) return pts;
  const vals = pts.map((p) => p.v);
  const W = 12; // ±12 pontos (~6 h)
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    const lo = Math.max(0, i - W), hi = Math.min(pts.length - 1, i + W);
    const win = vals.slice(lo, hi + 1).sort((a, b) => a - b);
    const med = win[Math.floor(win.length / 2)];
    if (med > 0 && pts[i].v < 0.4 * med) continue; // dropout: descarta
    out.push(pts[i]);
  }
  return out.length ? out : pts;
}

// Objeto {timestamp: nível} -> [{t, v}] ordenado, ignorando leituras inválidas.
function seriesToPoints(obj) {
  if (!obj || typeof obj !== "object") return [];
  const pts = [];
  for (const [k, v] of Object.entries(obj)) {
    const val = typeof v === "number" ? v : parseNumber(v);
    if (val != null && val > 0 && val < 100) pts.push({ t: normTs(k), v: val });
  }
  pts.sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
  return despike(pts);
}

// Tendência em cm/h a partir da série (usa uma janela de ~1h para suavizar).
function computeRate(points) {
  if (!points || points.length < 2) return null;
  const last = points[points.length - 1];
  const lastMs = Date.parse(last.t);
  if (Number.isNaN(lastMs)) return null;
  let ref = points[points.length - 2];
  for (let i = points.length - 2; i >= 0; i--) {
    ref = points[i];
    if (lastMs - Date.parse(ref.t) >= 55 * 60 * 1000) break;
  }
  const hours = (lastMs - Date.parse(ref.t)) / 3.6e6;
  if (!(hours > 0)) return null;
  return +(((last.v - ref.v) * 100) / hours).toFixed(1);
}

// weather.json -> chuva de hoje, previsão de hoje e acumulado da semana.
function parseWeather(arr) {
  if (!Array.isArray(arr)) return null;
  const num = (v) => (typeof v === "number" ? v : parseNumber(v));
  const hoje = arr.find((x) => x && x.type === "HOJE");
  const fc = arr.filter((x) => x && x.type === "FORECAST");
  const today = hoje ? num(hoje.rain) : fc[0] ? num(fc[0].rain) : null;
  const forecast = fc[0] ? num(fc[0].rain) : today;
  const week = fc.slice(0, 7).reduce((s, x) => s + (num(x.rain) || 0), 0);
  return { today, forecast, week: fc.length ? +week.toFixed(1) : null };
}

export async function crawlStation(station) {
  const prev = store.getSnapshot(station.slug) || {};
  const seed = SEED[station.slug] || {};
  const base = `${BASE_URL}/${station.slug}`;

  let level = null, rate = null, rain = null, ok = false;
  try {
    // 1) série de nível — longa na 1ª vez (popular histórico), depois só 7 dias
    const deep = store.getHistory(station.slug).length < SEED_MIN_POINTS;
    let series = await fetchJson(`${base}.${deep ? SEED_RANGE : "7days"}.json`).catch(() => null);
    if (!series) series = await fetchJson(`${base}.json`).catch(() => null);
    const pts = seriesToPoints(series || {});
    if (pts.length) {
      store.mergeSeries(station.slug, pts);
      level = pts[pts.length - 1].v;
      ok = true;
    }
    // 2) tendência sobre a série já consolidada
    rate = computeRate(store.getHistory(station.slug));

    // 3) chuva / previsão
    rain = parseWeather(await fetchJson(`${base}.weather.json`).catch(() => null));
  } catch (e) {
    console.warn(`[crawler] ${station.slug}: ${e.message} (usando dados anteriores/seed)`);
  }

  // mescla: coletado > snapshot anterior > seed > metadado fixo
  const flood = pick(prev.flood, seed.flood, station.flood);
  const lvl = pick(level, prev.level, seed.level);

  const snapshot = {
    slug: station.slug,
    city: station.city,
    river: station.river,
    lat: station.lat,
    lng: station.lng,
    level: lvl,
    flood,
    status: statusFor(lvl, flood),
    rate: pick(rate, prev.rate, seed.rate, 0),
    record: prev.record || seed.record || null,
    rain: {
      today: pick(rain?.today, prev.rain?.today, seed.rain?.today, 0),
      forecast: pick(rain?.forecast, prev.rain?.forecast, seed.rain?.forecast, 0),
      week: pick(rain?.week, prev.rain?.week, seed.rain?.week, 0),
    },
    marginToFlood: flood != null && lvl != null ? +(flood - lvl).toFixed(2) : null,
    ts: nowIso(),
    live: ok,
    url: base,
  };

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
