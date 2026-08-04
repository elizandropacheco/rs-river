// Nível dos rios DIRETO da telemetria oficial ANA/SGB, sem depender do
// nivelguaiba.com.br (que passa a ser só contingência no crawler):
//   1) HidroWebService (REST novo da ANA) — precisa de credencial gratuita
//      (cadastro no HidroWeb): ANA_IDENTIFICADOR + ANA_SENHA no ambiente.
//   2) SOAP antigo (telemetriaws1.ana.gov.br) — público e sem chave, porém
//      instável; usamos com timeout curto quando o REST não está configurado.
// Os códigos das estações são resolvidos automaticamente por proximidade
// (inventário telemétrico ⇒ estação mais próxima de cada cidade) e ficam
// persistidos em DATA_DIR/ana-stations.json — um sucesso vale para sempre.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { STATIONS } from "./stations.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");
const MAP_FILE = path.join(DATA_DIR, "ana-stations.json");

const UA = "Mozilla/5.0 (compatible; RSRiver/1.0; +https://guerreirosdohumaita.com.br)";
const SOAP = "https://telemetriaws1.ana.gov.br/ServiceANA.asmx";
const REST = "https://www.ana.gov.br/hidrowebservice";

const hasRest = () => !!(process.env.ANA_IDENTIFICADOR && process.env.ANA_SENHA);

async function req(url, headers = {}, ms = 30000) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA, ...headers }, signal: ctrl.signal });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return res;
  } finally {
    clearTimeout(to);
  }
}

const hav = (a, b, c, d) => {
  const r = (x) => (x * Math.PI) / 180;
  const s = Math.sin(r(c - a) / 2) ** 2 + Math.cos(r(a)) * Math.cos(r(c)) * Math.sin(r(d - b) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(s));
};

/* ---------------- token do HidroWebService ---------------- */
let restTok = { at: 0, token: null };
async function restToken() {
  if (!hasRest()) return null;
  if (restTok.token && Date.now() - restTok.at < 15 * 60 * 1000) return restTok.token;
  const res = await req(`${REST}/EstacoesTelemetricas/OAUth/v1`, {
    Identificador: process.env.ANA_IDENTIFICADOR,
    Senha: process.env.ANA_SENHA,
  }, 20000);
  const j = await res.json();
  const token = j?.items?.tokenautenticacao || j?.items?.token || null;
  if (!token) throw new Error("token ANA ausente na resposta");
  restTok = { at: Date.now(), token };
  return token;
}

/* ---------------- resolução dos códigos de estação ---------------- */
let mapping = null; // { slug: { code, name, dist } }
let extras = null; // réguas telemétricas da bacia ALÉM das 14 cidades

// Caixa que envolve a Bacia do Guaíba (com folga): réguas do inventário dentro
// dela viram pontos extras no mapa — mais densidade, mais realidade.
const BASIN_BBOX = { latMin: -30.8, latMax: -28.3, lngMin: -54.2, lngMax: -50.0 };

function loadMapping() {
  if (mapping) return mapping;
  try {
    if (fs.existsSync(MAP_FILE)) {
      const raw = JSON.parse(fs.readFileSync(MAP_FILE, "utf8"));
      // formato novo {mapping, extras}; formato antigo era o mapping direto
      if (raw.mapping) { mapping = raw.mapping; extras = raw.extras || null; }
      else mapping = raw;
    }
  } catch {}
  return mapping;
}

function persistMapping() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(MAP_FILE, JSON.stringify({ mapping, extras }, null, 2));
  } catch {}
}

// Extrai estações {code, name, lat, lng} do inventário (XML SOAP ou JSON REST).
function nearestFor(list) {
  const out = {};
  for (const st of STATIONS) {
    let best = null;
    for (const e of list) {
      if (!Number.isFinite(e.lat) || !Number.isFinite(e.lng)) continue;
      const d = hav(st.lat, st.lng, e.lat, e.lng);
      if (!best || d < best.dist) best = { code: e.code, name: e.name, dist: +d.toFixed(1) };
    }
    // >20 km da cidade = não é a régua daquele ponto; melhor cair no fallback
    if (best && best.dist <= 20) out[st.slug] = best;
  }
  return out;
}

async function inventoryViaSoap() {
  const res = await req(`${SOAP}/ListaEstacoesTelemetricas?statusEstacoes=&origem=`, {}, 60000);
  const xml = await res.text();
  const list = [];
  const blocks = xml.split(/<Table[ >]/).slice(1);
  for (const b of blocks) {
    const g = (tag) => (b.match(new RegExp(`<${tag}>([^<]*)</${tag}>`, "i")) || [])[1];
    const code = g("CodEstacao"), lat = parseFloat(g("Latitude")), lng = parseFloat(g("Longitude"));
    if (code) list.push({ code: code.trim(), name: (g("NomeEstacao") || "").trim(), lat, lng });
  }
  return list;
}

async function inventoryViaRest() {
  const token = await restToken();
  if (!token) return null;
  const res = await req(
    `${REST}/EstacoesTelemetricas/HidroInventarioEstacoes/v1?Unidade%20Federativa=RIO%20GRANDE%20DO%20SUL`,
    { Authorization: `Bearer ${token}` }, 60000);
  const j = await res.json();
  const items = j?.items || [];
  return items.map((e) => ({
    code: String(e.codigoestacao ?? e.Codigo_Estacao ?? e.codigo ?? "").trim(),
    name: e.Estacao_Nome || e.nomeestacao || e.nome || "",
    lat: parseFloat(e.Latitude ?? e.latitude),
    lng: parseFloat(e.Longitude ?? e.longitude),
  })).filter((e) => e.code);
}

let resolving = null; // trava contra os 4 workers do crawler em paralelo
let lastFail = 0; // inventário fora do ar? espera 6 h antes de tentar de novo
export async function resolveStations() {
  if (loadMapping()) return mapping;
  if (Date.now() - lastFail < 6 * 60 * 60 * 1000) return null;
  if (resolving) return resolving;
  resolving = doResolve()
    .then((m) => { if (!m) lastFail = Date.now(); return m; })
    .finally(() => { resolving = null; });
  return resolving;
}

async function doResolve() {
  let list = null;
  if (hasRest()) list = await inventoryViaRest().catch((e) => { console.warn("[ana] inventário REST:", e.message); return null; });
  if (!list || !list.length) list = await inventoryViaSoap().catch((e) => { console.warn("[ana] inventário SOAP:", e.message); return null; });
  if (!list || !list.length) return null;
  mapping = nearestFor(list);
  const chosen = new Set(Object.values(mapping).map((m) => m.code));
  extras = list.filter((e) =>
    !chosen.has(e.code) &&
    Number.isFinite(e.lat) && Number.isFinite(e.lng) &&
    e.lat >= BASIN_BBOX.latMin && e.lat <= BASIN_BBOX.latMax &&
    e.lng >= BASIN_BBOX.lngMin && e.lng <= BASIN_BBOX.lngMax,
  ).slice(0, 60).map((e) => ({ code: e.code, name: e.name, lat: e.lat, lng: e.lng }));
  persistMapping();
  console.log(`[ana] ${Object.keys(mapping).length}/14 estações resolvidas + ${extras.length} réguas extras na bacia`);
  return mapping;
}

/* ---------------- réguas extras da bacia (densidade no mapa) ----------------
   Nível atual das réguas telemétricas da região além das 14 cidades. Só
   funciona quando a ANA está acessível — o mapa fica mais denso sozinho. */
let extrasData = { at: 0, list: [] };
let extrasRefreshing = null;

export function getExtraGauges() {
  return { updatedAt: extrasData.at ? new Date(extrasData.at).toISOString() : null, gauges: extrasData.list };
}

export async function refreshExtraGauges() {
  if (extrasRefreshing) return extrasRefreshing;
  if (Date.now() - extrasData.at < 30 * 60 * 1000) return extrasData.list;
  extrasRefreshing = (async () => {
    await resolveStations().catch(() => null);
    if (!extras?.length) return extrasData.list;
    const out = [];
    const queue = [...extras];
    const workers = Array.from({ length: 4 }, async () => {
      while (queue.length) {
        const e = queue.shift();
        let pts = null;
        if (hasRest()) pts = await seriesViaRest(e.code).catch(() => null);
        if (!pts || !pts.length) pts = await seriesViaSoap(e.code).catch(() => null);
        const last = pts?.[pts.length - 1];
        if (last) out.push({ code: e.code, name: e.name, lat: e.lat, lng: e.lng, level: last.v, t: last.t });
      }
    });
    await Promise.all(workers);
    if (out.length) {
      extrasData = { at: Date.now(), list: out };
      console.log(`[ana] ${out.length} réguas extras com leitura na bacia`);
    } else {
      extrasData.at = Date.now(); // cooldown mesmo vazio — ANA fora do ar
    }
    return extrasData.list;
  })().finally(() => { extrasRefreshing = null; });
  return extrasRefreshing;
}

/* ---------------- série de nível ---------------- */
// Aceita cm ou m: réguas oficiais reportam cm — convertemos para metros.
const toMeters = (v) => (v > 90 ? v / 100 : v);

// "04/08/2026 10:15:00" ou ISO -> "YYYY-MM-DDTHH:MM"
function canonDate(s) {
  const t = String(s || "").trim();
  let m = t.match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}:\d{2})/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}T${m[4]}`;
  m = t.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/);
  if (m) return `${m[1]}T${m[2]}`;
  return null;
}

async function seriesViaRest(code) {
  const token = await restToken();
  if (!token) return null;
  const day = (off) => {
    const d = new Date(Date.now() + off * 864e5);
    return d.toISOString().slice(0, 10);
  };
  const url = `${REST}/EstacoesTelemetricas/HidroinfoanaSerieTelemetricaAdotada/v1` +
    `?C%C3%B3digo%20da%20Esta%C3%A7%C3%A3o=${code}&Tipo%20Filtro%20Data=DATA_LEITURA` +
    `&Data%20de%20Busca%20(yyyy-MM-dd)=${day(0)}&Range%20Intervalo%20de%20busca=DIAS_7`;
  const res = await req(url, { Authorization: `Bearer ${token}` }, 30000);
  const j = await res.json();
  const items = j?.items || [];
  const pts = [];
  for (const it of items) {
    const t = canonDate(it.Data_Hora_Medicao ?? it.data_hora_medicao ?? it.DataHora);
    const raw = parseFloat(it.Cota_Adotada ?? it.cota_adotada ?? it.Nivel_Adotado ?? it.nivel);
    if (t && Number.isFinite(raw) && raw > 0) pts.push({ t, v: +toMeters(raw).toFixed(2) });
  }
  return pts;
}

async function seriesViaSoap(code) {
  const fmt = (d) => `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
  const fim = new Date(), ini = new Date(Date.now() - 7 * 864e5);
  const url = `${SOAP}/DadosHidrometeorologicos?codEstacao=${code}&dataInicio=${fmt(ini)}&dataFim=${fmt(fim)}`;
  const res = await req(url, {}, 25000);
  const xml = await res.text();
  const pts = [];
  const blocks = xml.split(/<DadosHidrometereologicos[ >]/).slice(1);
  for (const b of blocks) {
    const g = (tag) => (b.match(new RegExp(`<${tag}>([^<]*)</${tag}>`, "i")) || [])[1];
    const t = canonDate(g("DataHora"));
    const raw = parseFloat(g("NivelAdotado") ?? g("Nivel"));
    if (t && Number.isFinite(raw) && raw > 0) pts.push({ t, v: +toMeters(raw).toFixed(2) });
  }
  return pts;
}

// Série de nível dos últimos ~7 dias, em metros, na fonte oficial.
// null = ANA indisponível agora → o crawler cai para o fallback.
export async function fetchLevelSeries(station) {
  const map = await resolveStations().catch(() => null);
  const entry = map?.[station.slug];
  if (!entry) return null;
  let pts = null;
  if (hasRest()) pts = await seriesViaRest(entry.code).catch((e) => { console.warn(`[ana] REST ${station.slug}:`, e.message); return null; });
  if (!pts || pts.length < 2) pts = await seriesViaSoap(entry.code).catch(() => null);
  if (!pts || pts.length < 2) return null;
  pts.sort((a, b) => (a.t < b.t ? -1 : 1));
  return { code: entry.code, name: entry.name, points: pts };
}

export const anaConfigured = hasRest;
