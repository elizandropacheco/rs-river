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
const SAT_ROOT = "https://cdn.star.nesdis.noaa.gov/GOES19";
const GEO = `${SAT_ROOT}/ABI/SECTOR/ssa/GEOCOLOR`;
// GLM = Geostationary Lightning Mapper: densidade de raios dos últimos minutos.
const GLM = `${SAT_ROOT}/GLM/SECTOR/ssa/EXTENT3`;
// "anim"/"glmanim" = loops animados (~14 MB) — só sob demanda, cache maior.
const SAT_KINDS = {
  900: { url: `${GEO}/900x540.jpg`, type: "image/jpeg", ttl: 10 * 60 * 1000, timeout: 30000 },
  1800: { url: `${GEO}/1800x1080.jpg`, type: "image/jpeg", ttl: 10 * 60 * 1000, timeout: 30000 },
  anim: { url: `${GEO}/GOES19-SSA-GEOCOLOR-900x540.gif`, type: "image/gif", ttl: 20 * 60 * 1000, timeout: 90000 },
  glm: { url: `${GLM}/900x540.jpg`, type: "image/jpeg", ttl: 5 * 60 * 1000, timeout: 30000 },
  glmanim: { url: `${GLM}/GOES19-SSA-EXTENT3-900x540.gif`, type: "image/gif", ttl: 15 * 60 * 1000, timeout: 90000 },
};
const satCache = new Map(); // kind -> { at, buf, type, lastModified }

export async function fetchSatellite(kind) {
  const k = SAT_KINDS[kind];
  if (!k) return null;
  const hit = satCache.get(kind);
  if (hit && Date.now() - hit.at < k.ttl) return hit;
  try {
    const res = await fetchWithTimeout(k.url, k.type, k.timeout);
    const buf = Buffer.from(await res.arrayBuffer());
    const entry = { at: Date.now(), buf, type: k.type, lastModified: res.headers.get("last-modified") };
    satCache.set(kind, entry);
    return entry;
  } catch (e) {
    console.warn("[goes] falha ao buscar satélite:", e.message);
    return hit || null; // melhor imagem velha que nenhuma
  }
}

/* ---------------- previsão de vazão (Open-Meteo Flood API · GloFAS/Copernicus) ----
   Vazão do rio (m³/s) por coordenada: 7 dias passados + 30 de previsão. É o
   dado PREDITIVO do painel — antecipa a cheia antes de o nível subir.
   O modelo atualiza 1x/dia, então cache de 6 h basta. */
const FLOOD_TTL = 6 * 60 * 60 * 1000;
const floodCache = new Map(); // slug -> { at, data }

export async function fetchFlood(station) {
  const hit = floodCache.get(station.slug);
  if (hit && Date.now() - hit.at < FLOOD_TTL) return hit.data;
  const url = "https://flood-api.open-meteo.com/v1/flood" +
    `?latitude=${station.lat}&longitude=${station.lng}` +
    "&daily=river_discharge&past_days=7&forecast_days=30";
  const daily = (await fetchJson(url))?.daily;
  if (!daily?.time) return hit?.data || null;
  const days = daily.time
    .map((t, i) => ({ t, v: daily.river_discharge?.[i] ?? null }))
    .filter((d) => d.v != null);
  if (!days.length) return hit?.data || null;
  const data = { unit: "m³/s", days };
  floodCache.set(station.slug, { at: Date.now(), data });
  return data;
}

/* ---------------- chuva medida (INMET · apitempo) ----------------
   Estações automáticas oficiais: escolhemos a mais próxima de cada cidade
   (1x/dia) e somamos a chuva horária de hoje. Dado MEDIDO, não previsto. */
const INMET_LIST_TTL = 24 * 60 * 60 * 1000;
const INMET_DATA_TTL = 30 * 60 * 1000;
let inmetStations = { at: 0, list: [] };
const inmetNearest = new Map(); // slug -> { code, name, dist }
const inmetRainCache = new Map(); // code -> { at, data }

const hav = (a, b, c, d) => {
  const r = (x) => (x * Math.PI) / 180;
  const s = Math.sin(r(c - a) / 2) ** 2 + Math.cos(r(a)) * Math.cos(r(c)) * Math.sin(r(d - b) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(s));
};

let inmetLoading = null; // trava: os 4 workers do crawler chegam juntos aqui
async function loadInmetStations() {
  if (Date.now() - inmetStations.at < INMET_LIST_TTL && inmetStations.list.length) return;
  if (inmetLoading) return inmetLoading;
  inmetLoading = doLoadInmetStations().finally(() => { inmetLoading = null; });
  return inmetLoading;
}
async function doLoadInmetStations() {
  const all = await fetchJson("https://apitempo.inmet.gov.br/estacoes/T");
  const rs = (all || []).filter((e) => e.SG_ESTADO === "RS" && e.CD_SITUACAO === "Operante");
  if (!rs.length) return;
  inmetStations = { at: Date.now(), list: rs };
  for (const st of STATIONS) {
    let best = null;
    for (const e of rs) {
      const d = hav(st.lat, st.lng, parseFloat(e.VL_LATITUDE), parseFloat(e.VL_LONGITUDE));
      if (!best || d < best.dist) best = { code: e.CD_ESTACAO, name: e.DC_NOME, dist: +d.toFixed(0) };
    }
    if (best) inmetNearest.set(st.slug, best);
  }
  console.log(`[inmet-tempo] ${rs.length} estações automáticas no RS mapeadas`);
}

// Dados horários do apitempo hoje exigem token gratuito (solicite ao INMET e
// defina INMET_TOKEN). Sem token tentamos a rota aberta — se ela voltar a
// funcionar, o recurso liga sozinho; enquanto 204/erro, fica oculto.
export async function fetchInmetRain(station) {
  try {
    await loadInmetStations();
    const near = inmetNearest.get(station.slug);
    if (!near) return null;
    const hit = inmetRainCache.get(near.code);
    if (hit && Date.now() - hit.at < INMET_DATA_TTL) return hit.data;
    const day = new Date().toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
    const tok = process.env.INMET_TOKEN;
    const url = tok
      ? `https://apitempo.inmet.gov.br/token/estacao/${day}/${day}/${near.code}/${tok}`
      : `https://apitempo.inmet.gov.br/estacao/${day}/${day}/${near.code}`;
    const rows = await fetchJson(url);
    if (!Array.isArray(rows) || !rows.length) return hit?.data || null;
    let rain = 0, got = false;
    for (const r of rows) {
      const v = parseFloat(r.CHUVA);
      if (Number.isFinite(v)) { rain += v; got = true; }
    }
    const last = rows[rows.length - 1] || {};
    const data = {
      station: near.name, code: near.code, distKm: near.dist,
      rainToday: got ? +rain.toFixed(1) : null,
      temp: parseFloat(last.TEM_INS) || null,
      humidity: parseFloat(last.UMD_INS) || null,
      hour: last.HR_MEDICAO || null,
    };
    inmetRainCache.set(near.code, { at: Date.now(), data });
    return data;
  } catch (e) {
    return inmetRainCache.get(inmetNearest.get(station.slug)?.code)?.data || null;
  }
}

/* ---------------- pluviômetros do CEMADEN ----------------
   A API pública (PED) exige token gratuito: cadastre-se em ped.cemaden.gov.br
   e defina CEMADEN_EMAIL + CEMADEN_PASSWORD (ou CEMADEN_TOKEN) no ambiente.
   Sem credenciais o recurso fica desligado, sem erro. */
const CEMADEN_DATA_TTL = 30 * 60 * 1000;
let cemadenTok = { at: 0, token: process.env.CEMADEN_TOKEN || null };
const cemadenCache = new Map(); // ibge -> { at, data }

async function cemadenToken() {
  if (process.env.CEMADEN_TOKEN) return process.env.CEMADEN_TOKEN;
  const email = process.env.CEMADEN_EMAIL, password = process.env.CEMADEN_PASSWORD;
  if (!email || !password) return null;
  if (cemadenTok.token && Date.now() - cemadenTok.at < 50 * 60 * 1000) return cemadenTok.token;
  const res = await fetch("https://sgaa.cemaden.gov.br/SGAA/rest/controle-token/tokens", {
    method: "POST", headers: { "Content-Type": "application/json", "User-Agent": UA },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error("login CEMADEN falhou: HTTP " + res.status);
  const j = await res.json();
  cemadenTok = { at: Date.now(), token: j?.token || j?.access_token || null };
  return cemadenTok.token;
}

export const cemadenEnabled = () =>
  !!(process.env.CEMADEN_TOKEN || (process.env.CEMADEN_EMAIL && process.env.CEMADEN_PASSWORD));

export async function fetchCemadenRain(station) {
  if (!cemadenEnabled() || !station.ibge) return null;
  const hit = cemadenCache.get(station.ibge);
  if (hit && Date.now() - hit.at < CEMADEN_DATA_TTL) return hit.data;
  try {
    const token = await cemadenToken();
    if (!token) return null;
    const res = await fetch(
      `https://sws.cemaden.gov.br/PED/rest/pcds/dados_pcd?codibge=${station.ibge}`,
      { headers: { token, Accept: "application/json", "User-Agent": UA } },
    );
    if (!res.ok) throw new Error("HTTP " + res.status);
    const body = await res.json();
    // formato defensivo: aceita array de medições {chuva|valorMedida, datahora}
    const rows = Array.isArray(body) ? body : body?.dados || body?.pcds || [];
    let rain24 = 0, got = false, stationName = null;
    const cutoff = Date.now() - 24 * 3600 * 1000;
    for (const r of rows) {
      const ts = Date.parse(r.datahora || r.dataHora || r.timestamp || "");
      const v = parseFloat(r.chuva ?? r.valorMedida ?? r.valor);
      if (Number.isFinite(v) && (!Number.isFinite(ts) || ts >= cutoff)) { rain24 += v; got = true; }
      stationName ||= r.nomeestacao || r.nomeEstacao || r.estacao || null;
    }
    const data = got ? { rain24h: +rain24.toFixed(1), station: stationName } : null;
    cemadenCache.set(station.ibge, { at: Date.now(), data });
    return data;
  } catch (e) {
    console.warn(`[cemaden] ${station.slug}: ${e.message}`);
    return hit?.data || null;
  }
}

/* ---------------- radar de chuva (RainViewer) ----------------
   Frames do radar composto (2 h passadas + 30 min de previsão). Os tiles são
   carregados direto do CDN deles pelo navegador; aqui só cacheamos o índice. */
let radarFrames = { at: 0, data: null };
export async function fetchRadarFrames() {
  if (radarFrames.data && Date.now() - radarFrames.at < 60 * 1000) return radarFrames.data;
  try {
    const j = await fetchJson("https://api.rainviewer.com/public/weather-maps.json");
    const data = {
      host: j.host,
      past: (j.radar?.past || []).map((f) => ({ time: f.time, path: f.path })),
      nowcast: (j.radar?.nowcast || []).map((f) => ({ time: f.time, path: f.path })),
    };
    radarFrames = { at: Date.now(), data };
    return data;
  } catch (e) {
    console.warn("[radar] falha ao buscar frames:", e.message);
    return radarFrames.data;
  }
}
