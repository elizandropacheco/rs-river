// Meteorologia e alertas, direto das FONTES ORIGINAIS (sem dependências):
//   • Avisos meteorológicos — API oficial do INMET (apiprevmet3.inmet.gov.br)
//   • Previsão do tempo 7 dias por estação — Open-Meteo (open-meteo.com)
//   • Imagem de satélite GOES-19 GEOCOLOR — NOAA/NESDIS STAR, que opera os
//     satélites GOES (cdn.star.nesdis.noaa.gov), setor sul da América do Sul.
import { STATIONS } from "./stations.js";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0 Safari/537.36";

async function fetchWithTimeout(url, accept, ms = 25000) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: accept, "Accept-Language": "pt-BR" },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return res;
  } finally {
    clearTimeout(to);
  }
}
const fetchJson = async (url) => (await fetchWithTimeout(url, "application/json")).json();

/* ---------------- avisos do INMET ----------------
   A API devolve {hoje:[], futuro:[]} com, por aviso, a lista completa de
   municípios ("Cidade - UF (geocode)"). Casamos por nome normalizado + UF,
   sem depender de geocodes hardcoded. */
const INMET_URL = "https://apiprevmet3.inmet.gov.br/avisos/ativos";

const norm = (s) =>
  String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();

// "Abelardo Luz - SC (4200101),Aceguá - RS (4300034),..." -> Set("acegua|rs", ...)
function parseMunicipios(str) {
  const set = new Set();
  for (const part of String(str || "").split(",")) {
    const m = part.match(/^(.+?)\s*-\s*([A-Z]{2})\s*\(/);
    if (m) set.add(`${norm(m[1])}|${m[2].toLowerCase()}`);
  }
  return set;
}

let alerts = { updatedAt: null, list: [] }; // avisos que atingem o RS
let alertsBySlug = new Map(); // slug -> [ids compactos]

export async function refreshAlerts() {
  try {
    const raw = await fetchJson(INMET_URL);
    const all = [...(raw.hoje || []), ...(raw.futuro || [])];
    const list = [];
    const bySlug = new Map(STATIONS.map((s) => [s.slug, []]));

    for (const a of all) {
      if (a.encerrado) continue;
      if (!String(a.estados || "").includes("Rio Grande do Sul")) continue;
      const munis = parseMunicipios(a.municipios);
      const slugs = STATIONS.filter((s) => munis.has(`${norm(s.city)}|rs`)).map((s) => s.slug);
      const item = {
        id: a.id,
        evento: a.descricao || "Aviso meteorológico",
        severidade: a.severidade || "",
        cor: /^#[0-9a-fA-F]{6}$/.test(a.aviso_cor || "") ? a.aviso_cor : "#FFFE00",
        inicio: a.inicio || null,
        fim: a.fim || null,
        riscos: Array.isArray(a.riscos) ? a.riscos : [],
        instrucoes: Array.isArray(a.instrucoes) ? a.instrucoes : [],
        cidades: slugs, // estações monitoradas dentro do aviso
      };
      list.push(item);
      for (const sl of slugs) bySlug.get(sl).push({
        id: item.id, evento: item.evento, severidade: item.severidade, cor: item.cor, fim: item.fim,
      });
    }
    // mais severo primeiro (Grande Perigo > Perigo > Perigo Potencial),
    // tanto na lista global quanto na lista de cada estação (o card mostra o 1º)
    const rank = (s) => (/grande/i.test(s) ? 0 : /^perigo$/i.test(String(s).trim()) ? 1 : 2);
    list.sort((x, y) => rank(x.severidade) - rank(y.severidade));
    for (const arr of bySlug.values()) arr.sort((x, y) => rank(x.severidade) - rank(y.severidade));
    alerts = { updatedAt: new Date().toISOString(), list };
    alertsBySlug = bySlug;
    console.log(`[inmet] ${list.length} aviso(s) ativos no RS (${[...bySlug.values()].filter((v) => v.length).length} estações atingidas)`);
  } catch (e) {
    console.warn("[inmet] falha ao buscar avisos:", e.message);
  }
  return alerts;
}

export const getAlerts = () => alerts;
export const alertsFor = (slug) => alertsBySlug.get(slug) || [];

/* ---------------- previsão do tempo (Open-Meteo) ----------------
   7 dias por estação: condição (código WMO), mín/máx, chuva e probabilidade.
   Previsão muda devagar — cache de 30 min por estação. */
const FC_TTL = 30 * 60 * 1000;
const fcCache = new Map(); // slug -> { at, data }

export async function fetchForecast(station) {
  const hit = fcCache.get(station.slug);
  if (hit && Date.now() - hit.at < FC_TTL) return hit.data;
  const url = "https://api.open-meteo.com/v1/forecast" +
    `?latitude=${station.lat}&longitude=${station.lng}` +
    "&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max" +
    "&timezone=America%2FSao_Paulo&forecast_days=7";
  const day = (await fetchJson(url))?.daily;
  if (!day?.time) return hit?.data || null;
  const data = day.time.map((t, i) => ({
    date: t,
    code: day.weather_code?.[i] ?? null,
    tmax: day.temperature_2m_max?.[i] ?? null,
    tmin: day.temperature_2m_min?.[i] ?? null,
    rain: day.precipitation_sum?.[i] ?? null,
    prob: day.precipitation_probability_max?.[i] ?? null,
  }));
  fcCache.set(station.slug, { at: Date.now(), data });
  return data;
}

/* ---------------- satélite GOES-19 (NOAA/NESDIS STAR) ----------------
   URLs estáveis "sempre a mais recente" por tamanho. Proxy com cache de
   10 min: os clientes batem no nosso servidor, não na NOAA. */
const SAT_SIZES = { 900: "900x540", 1800: "1800x1080" };
const SAT_TTL = 10 * 60 * 1000;
const satCache = new Map(); // size -> { at, buf, lastModified }

export async function fetchSatellite(size) {
  const dim = SAT_SIZES[size];
  if (!dim) return null;
  const hit = satCache.get(size);
  if (hit && Date.now() - hit.at < SAT_TTL) return hit;
  try {
    const res = await fetchWithTimeout(
      `https://cdn.star.nesdis.noaa.gov/GOES19/ABI/SECTOR/ssa/GEOCOLOR/${dim}.jpg`,
      "image/jpeg", 30000,
    );
    const buf = Buffer.from(await res.arrayBuffer());
    const entry = { at: Date.now(), buf, lastModified: res.headers.get("last-modified") };
    satCache.set(size, entry);
    return entry;
  } catch (e) {
    console.warn("[goes] falha ao buscar satélite:", e.message);
    return hit || null; // melhor imagem velha que nenhuma
  }
}
