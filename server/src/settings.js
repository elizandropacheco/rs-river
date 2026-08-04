// Configurações da plataforma (sem dependências externas), persistidas em
// DATA_DIR/settings.json — sobrevivem a deploys, como o histórico.
// Hoje guarda a gestão do Google Tag Manager; campos novos entram aqui.
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");
const FILE = path.join(DATA_DIR, "settings.json");

const DEFAULTS = {
  gtm: { containerId: "", enabled: false, updatedAt: null },
  adminToken: null, // gerado no primeiro boot se ADMIN_TOKEN não estiver no ambiente
};

let settings = structuredClone(DEFAULTS);

export function load() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(FILE)) {
      const raw = JSON.parse(fs.readFileSync(FILE, "utf8"));
      settings = { ...structuredClone(DEFAULTS), ...raw, gtm: { ...DEFAULTS.gtm, ...(raw.gtm || {}) } };
    }
  } catch (e) {
    console.error("[settings] falha ao carregar:", e.message);
  }
  // Token do admin: ADMIN_TOKEN do ambiente tem prioridade; sem ele, geramos
  // um aleatório uma única vez e mostramos no log para o operador guardar.
  if (!process.env.ADMIN_TOKEN && !settings.adminToken) {
    settings.adminToken = crypto.randomBytes(24).toString("base64url");
    persist();
    console.log(`[settings] ADMIN_TOKEN não definido — token gerado: ${settings.adminToken}`);
    console.log("[settings] use-o em /admin ou defina ADMIN_TOKEN no ambiente para fixar o seu.");
  }
  return settings;
}

function persist() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(settings, null, 2));
  } catch (e) {
    console.error("[settings] falha ao salvar:", e.message);
  }
}

export function adminToken() {
  return process.env.ADMIN_TOKEN || settings.adminToken || "";
}

// Comparação em tempo constante para não vazar o token por timing.
export function checkToken(candidate) {
  const real = adminToken();
  if (!real || !candidate) return false;
  const a = Buffer.from(String(candidate));
  const b = Buffer.from(real);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// IDs de contêiner GTM: "GTM-" + 6~10 alfanuméricos maiúsculos. A validação
// estrita também impede injeção de script via configuração.
export const GTM_ID_RE = /^GTM-[A-Z0-9]{4,12}$/;

export function getGtm() {
  return { ...settings.gtm };
}

export function setGtm({ containerId, enabled }) {
  const id = String(containerId || "").trim().toUpperCase();
  if (id && !GTM_ID_RE.test(id)) {
    return { error: "ID inválido — o formato é GTM-XXXXXXX (letras maiúsculas e números)." };
  }
  if (enabled && !id) {
    return { error: "Informe o ID do contêiner antes de ativar." };
  }
  settings.gtm = { containerId: id, enabled: !!enabled && !!id, updatedAt: new Date().toISOString() };
  persist();
  return { gtm: getGtm() };
}

// Snippets do GTM. Injetados pelo servidor em TODO HTML servido (painel
// público, admin e fallback da SPA) quando a tag está ativa.
// Carregamento ADIADO (primeira interação ou 3,5 s): scripts de terceiros na
// carga inicial degradam INP/LCP — Core Web Vitals que pesam no ranking. O
// dataLayer existe desde o início, então nenhum evento se perde: fica na fila
// e o GTM processa tudo ao carregar.
export function gtmHeadSnippet() {
  const { containerId, enabled } = settings.gtm;
  if (!enabled || !GTM_ID_RE.test(containerId)) return "";
  return (
    "<!-- Google Tag Manager (carregamento adiado p/ Core Web Vitals) -->\n" +
    '<link rel="preconnect" href="https://www.googletagmanager.com">\n' +
    "<script>window.dataLayer=window.dataLayer||[];(function(w,d,i){var done=false;" +
    "function go(){if(done)return;done=true;" +
    "w.dataLayer.push({'gtm.start':new Date().getTime(),event:'gtm.js'});" +
    "var f=d.getElementsByTagName('script')[0],j=d.createElement('script');" +
    "j.async=true;j.src='https://www.googletagmanager.com/gtm.js?id='+i;f.parentNode.insertBefore(j,f);}" +
    "var t=setTimeout(go,3500);" +
    "['pointerdown','keydown','touchstart','scroll'].forEach(function(e){" +
    "w.addEventListener(e,function(){clearTimeout(t);go();},{once:true,passive:true});});" +
    `})(window,document,'${containerId}');</script>\n` +
    "<!-- End Google Tag Manager -->"
  );
}

export function gtmBodySnippet() {
  const { containerId, enabled } = settings.gtm;
  if (!enabled || !GTM_ID_RE.test(containerId)) return "";
  return (
    "<!-- Google Tag Manager (noscript) -->\n" +
    `<noscript><iframe src="https://www.googletagmanager.com/ns.html?id=${containerId}"` +
    ' height="0" width="0" style="display:none;visibility:hidden"></iframe></noscript>\n' +
    "<!-- End Google Tag Manager (noscript) -->"
  );
}

// Injeta os snippets num HTML: head logo após <head> (o mais alto possível,
// como o Google recomenda) e noscript logo após <body>.
export function injectGtm(html) {
  const head = gtmHeadSnippet();
  if (!head) return html;
  const body = gtmBodySnippet();
  let out = String(html);
  out = out.includes("</title>")
    ? out.replace("</title>", "</title>\n" + head)
    : out.replace(/<head([^>]*)>/i, (m) => m + "\n" + head);
  out = out.replace(/<body([^>]*)>/i, (m) => m + "\n" + body);
  return out;
}
