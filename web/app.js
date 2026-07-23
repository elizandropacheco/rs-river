import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { createRoot } from "react-dom/client";
import htm from "htm";
import { RS, projRS } from "./rs-outline.js";

const html = htm.bind(React.createElement);

/* ---------------- helpers ---------------- */
const STATUS_LABEL = { normal: "Normal", atencao: "Atenção", alerta: "Alerta", inundacao: "Inundação" };
// Semáforo: verde → amarelo → laranja → vermelho, do mais tranquilo ao mais grave.
const STATUS_COLOR = { normal: "#22c55e", atencao: "#eab308", alerta: "#f97316", inundacao: "#ef4444" };
const STATUS_DESC = {
  normal: "Nível dentro da normalidade",
  atencao: "Nível subindo — acompanhar de perto",
  alerta: "Próximo da cota de inundação",
  inundacao: "Cota de inundação atingida",
};
const STATUS_ORDER = { inundacao: 0, alerta: 1, atencao: 2, normal: 3 };

const fmt = (n, d = 2) => (n == null || Number.isNaN(n) ? "—" : Number(n).toFixed(d));
const fmtDate = (iso) => {
  if (!iso) return "";
  const dt = new Date(iso);
  return isNaN(dt) ? "" : dt.toLocaleDateString("pt-BR");
};
const fmtTime = (iso) => {
  if (!iso) return "—";
  const dt = new Date(iso);
  if (isNaN(dt)) return iso;
  return dt.toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
};
const relTime = (iso) => {
  if (!iso) return "";
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "agora";
  if (s < 3600) return `há ${Math.floor(s / 60)} min`;
  if (s < 86400) return `há ${Math.floor(s / 3600)} h`;
  return `há ${Math.floor(s / 86400)} d`;
};

/* número que "conta" ao mudar */
function useCountUp(target, dur = 700) {
  const [val, setVal] = useState(target || 0);
  const prev = useRef(target || 0);
  useEffect(() => {
    const from = prev.current, to = target || 0, t0 = performance.now();
    let raf;
    const tick = (t) => {
      const p = Math.min(1, (t - t0) / dur);
      const e = 1 - Math.pow(1 - p, 3);
      setVal(from + (to - from) * e);
      if (p < 1) raf = requestAnimationFrame(tick);
      else prev.current = to;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target]);
  return val;
}

/* ---------------- data hook ---------------- */
function useLiveData() {
  const [stations, setStations] = useState([]);
  const [history, setHistory] = useState({});
  const [meta, setMeta] = useState({ rivers: {}, intervalMin: 5 });
  const [updatedAt, setUpdatedAt] = useState(null);
  const [connected, setConnected] = useState(false);

  const mergeStation = useCallback((snap) => {
    setStations((cur) => {
      const i = cur.findIndex((s) => s.slug === snap.slug);
      if (i === -1) return [...cur, snap];
      const next = cur.slice(); next[i] = snap; return next;
    });
  }, []);

  const loadHistory = useCallback(() => {
    fetch("/api/history").then((r) => r.json()).then((d) => setHistory(d.history || {})).catch(() => {});
  }, []);

  useEffect(() => {
    fetch("/api/meta").then((r) => r.json()).then(setMeta).catch(() => {});
    fetch("/api/stations").then((r) => r.json()).then((d) => {
      setStations(d.stations || []); setUpdatedAt(d.updatedAt);
    }).catch(() => {});
    loadHistory();

    let ws, alive = true, retry;
    const connect = () => {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      ws = new WebSocket(`${proto}://${location.host}/ws`);
      ws.onopen = () => setConnected(true);
      ws.onclose = () => { setConnected(false); if (alive) retry = setTimeout(connect, 3000); };
      ws.onerror = () => ws.close();
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type === "snapshot") { setStations(msg.stations); setUpdatedAt(msg.updatedAt); loadHistory(); }
          else if (msg.type === "update") { mergeStation(msg.station); }
        } catch {}
      };
    };
    connect();
    const poll = setInterval(loadHistory, 60000);
    return () => { alive = false; clearTimeout(retry); clearInterval(poll); if (ws) ws.close(); };
  }, [mergeStation, loadHistory]);

  return { stations, history, meta, updatedAt, connected };
}

/* ---------------- gráfico de área (SVG) ----------------
   Robusto: o <svg> preenche 100% do container (que define a altura),
   com preserveAspectRatio="none". Assim funciona igual no mini-card e
   no modal, sem estourar o layout. */
function AreaChart({ points, color, flood, axis = false }) {
  const series = (points || []).filter((p) => p && p.v != null);
  const data = series.map((p) => p.v);
  if (data.length < 2) {
    return html`<div class="chart-empty">coletando histórico…</div>`;
  }
  const W = 300, H = 100, pad = 5;
  let min = Math.min(...data), max = Math.max(...data);
  if (flood != null) max = Math.max(max, flood);
  // margem de respiro no topo/base para a linha não colar nas bordas
  const span0 = max - min || 1;
  min -= span0 * 0.08;
  max += span0 * 0.08;
  if (max - min < 0.05) { max += 0.5; min -= 0.5; }
  const rng = max - min;
  const x = (i) => pad + (i / (data.length - 1)) * (W - pad * 2);
  const y = (v) => pad + (1 - (v - min) / rng) * (H - pad * 2);
  const line = data.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const area = `${line} L${x(data.length - 1).toFixed(1)},${H - pad} L${x(0).toFixed(1)},${H - pad} Z`;
  const gid = "g" + Math.abs(hashStr(color + data.length + min.toFixed(2)));
  const floodY = flood != null ? y(flood) : null;
  const last = data[data.length - 1];
  const floodOn = floodY != null && floodY > pad && floodY < H - pad;
  return html`
    <svg class="area-chart" viewBox=${`0 0 ${W} ${H}`} preserveAspectRatio="none">
      <defs>
        <linearGradient id=${gid} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stop-color=${color} stop-opacity="0.42"/>
          <stop offset="100%" stop-color=${color} stop-opacity="0.02"/>
        </linearGradient>
      </defs>
      ${floodOn
        ? html`<line x1="0" x2=${W} y1=${floodY} y2=${floodY} stroke="#ef4444" stroke-width="1.2" stroke-dasharray="5 4" opacity="0.85" vector-effect="non-scaling-stroke"/>`
        : null}
      <path d=${area} fill=${`url(#${gid})`}/>
      <path d=${line} fill="none" stroke=${color} stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>
      <circle cx=${x(data.length - 1).toFixed(1)} cy=${y(last).toFixed(1)} r="3.4" fill=${color} vector-effect="non-scaling-stroke">
        <animate attributeName="r" values="3.4;6;3.4" dur="1.8s" repeatCount="indefinite"/>
      </circle>
    </svg>`;
}
function hashStr(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h; }

/* ---------------- card ---------------- */
function StationCard({ st, points, riverColor, onOpen, index }) {
  const level = useCountUp(st.level, 700);
  const stColor = STATUS_COLOR[st.status];
  const pct = st.flood ? Math.min(100, Math.max(2, (st.level / st.flood) * 100)) : 0;
  const rate = st.rate || 0;
  const trendClass = rate > 0.2 ? "up" : rate < -0.2 ? "down" : "flat";
  const trendIcon = rate > 0.2 ? "▲" : rate < -0.2 ? "▼" : "▬";
  return html`
    <div class=${`card st-${st.status}`}
         style=${{ "--riv": riverColor, "--st": stColor, animationDelay: `${index * 45}ms` }}
         onClick=${() => onOpen(st)}>
      <div class="accent"></div>
      <div class="card-head">
        <div class="head-txt">
          <div class="city">${st.city}</div>
          <div class="river"><span class="rdot"></span>${st.river}</div>
        </div>
        <div class=${`badge ${st.status}`}><span class="bdot"></span>${STATUS_LABEL[st.status]}</div>
      </div>

      <div class="metric-row">
        <div class="level">${fmt(level)}<span class="u">m</span></div>
        <div class=${`trend ${trendClass}`}>${trendIcon} ${fmt(Math.abs(rate), 1)} cm/h</div>
      </div>

      <div class="gauge">
        <div class="tube" title="Nível vs cota de inundação">
          <div class="fill" style=${{ height: pct + "%" }}></div>
          ${st.flood ? html`<div class="flood-line"></div>` : null}
        </div>
        <div class="g-meta">
          <div class="row"><span>Cota de inundação</span><b>${fmt(st.flood)} m</b></div>
          <div class="row"><span>Margem p/ transbordo</span>
            <b style=${{ color: st.marginToFlood != null && st.marginToFlood <= 0 ? "#f87171" : "#4ade80" }}>
              ${st.marginToFlood != null ? (st.marginToFlood > 0 ? `${fmt(st.marginToFlood)} m` : `+${fmt(-st.marginToFlood)} m acima`) : "—"}
            </b></div>
          <div class="row"><span>Ocupação da cota</span><b class="pct" style=${{ color: stColor }}>${fmt(pct, 0)}%</b></div>
        </div>
      </div>

      <div class="spark">
        <span class="lbl">Nível · últimas ${(points || []).length || "—"} leituras</span>
        <div class="spark-box">
          <${AreaChart} points=${points} color=${stColor} flood=${st.flood}/>
        </div>
      </div>

      <div class="facts">
        <div class="fact"><span class="k">Recorde histórico</span>
          <span class="v">${st.record ? `${fmt(st.record.level)} m` : "—"}</span>
          <span class="v small">${st.record?.date ? fmtDate(st.record.date) : ""}</span>
        </div>
        <div class="fact"><span class="k">Chuva hoje</span>
          <span class="v"><span class="rain-ico">💧</span> ${fmt(st.rain?.today, 1)} mm</span>
          <span class="v small">prev. ${fmt(st.rain?.forecast, 1)} mm</span>
        </div>
        <div class="fact"><span class="k">Previsão 7 dias</span>
          <span class="v">${fmt(st.rain?.week, 1)} mm</span>
        </div>
        <div class="fact"><span class="k">Leitura</span>
          <span class="v small">${fmtTime(st.ts)}</span>
        </div>
      </div>

      <div class="card-foot">
        <span>${st.live ? html`<span class="live-tag">● ao vivo</span>` : html`<span class="seed-tag">cache/seed</span>`}</span>
        <span class="tap-hint">toque para detalhes →</span>
      </div>
    </div>`;
}

/* ---------------- modal ---------------- */
function Modal({ st, points, riverColor, onClose }) {
  useEffect(() => {
    const h = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", h);
    document.body.style.overflow = "hidden";
    return () => { window.removeEventListener("keydown", h); document.body.style.overflow = ""; };
  }, [onClose]);

  const stColor = STATUS_COLOR[st.status];
  const data = (points || []).filter((p) => p && p.v != null);
  const vals = data.map((p) => p.v);
  const minV = vals.length ? Math.min(...vals) : null;
  const maxV = vals.length ? Math.max(...vals) : null;
  const first = data.length ? data[0].v : null;
  const lastV = data.length ? data[data.length - 1].v : st.level;
  const deltaSeries = first != null && lastV != null ? lastV - first : null;
  const pct = st.flood ? Math.min(100, Math.max(0, (st.level / st.flood) * 100)) : 0;
  const rate = st.rate || 0;
  const rateClass = rate > 0.2 ? "up" : rate < -0.2 ? "down" : "flat";

  const stat = (k, v, opts = {}) => html`
    <div class="stat" style=${opts.color ? { "--vc": opts.color } : null}>
      <div class="k">${k}</div>
      <div class=${`v${opts.color ? " tinted" : ""}`}>${v}</div>
      ${opts.sub ? html`<div class="v-sub">${opts.sub}</div>` : null}
    </div>`;

  return html`
    <div class="modal-bg" onClick=${onClose}>
      <div class=${`modal st-${st.status}`} style=${{ "--st": stColor, "--riv": riverColor }} onClick=${(e) => e.stopPropagation()}>
        <button class="x" onClick=${onClose} aria-label="Fechar">×</button>

        <div class="m-head">
          <div class=${`m-badge ${st.status}`}><span class="bdot"></span>${STATUS_LABEL[st.status]}</div>
          <h2>${st.city}</h2>
          <div class="sub">
            <span class="rdot" style=${{ background: riverColor }}></span>
            ${st.river} · atualizado ${relTime(st.ts)}
          </div>
          <div class="m-desc">${STATUS_DESC[st.status]}</div>
        </div>

        <div class="m-hero">
          <div class="hero-level">
            <div class="hl-num">${fmt(st.level)}<span>m</span></div>
            <div class=${`hl-trend ${rateClass}`}>
              ${rate > 0.2 ? "▲" : rate < -0.2 ? "▼" : "▬"} ${fmt(Math.abs(rate), 1)} cm/h
            </div>
          </div>
          <div class="hero-gauge">
            <div class="hg-top">
              <span>Ocupação da cota</span>
              <b style=${{ color: stColor }}>${fmt(pct, 0)}%</b>
            </div>
            <div class="hg-bar"><div class="hg-fill" style=${{ width: pct + "%" }}></div></div>
            <div class="hg-bot">
              <span>0 m</span>
              <span>cota ${fmt(st.flood)} m</span>
            </div>
          </div>
        </div>

        <div class="big-chart">
          <div class="bc-head">
            <span>Histórico de elevação · ${data.length} leituras</span>
            <span class="bc-legend">
              <span class="lg-item"><span class="lg-line" style=${{ background: stColor }}></span>nível</span>
              <span class="lg-item"><span class="lg-dash"></span>cota de inundação</span>
            </span>
          </div>
          <div class="modal-chart">
            <${AreaChart} points=${data} color=${stColor} flood=${st.flood} axis=${true}/>
          </div>
          <div class="bc-foot">
            <span>mín ${fmt(minV)} m</span>
            <span>máx ${fmt(maxV)} m</span>
          </div>
        </div>

        <div class="stat-grid">
          ${stat("Nível atual", `${fmt(st.level)} m`, { color: stColor })}
          ${stat("Cota de inundação", `${fmt(st.flood)} m`)}
          ${stat("Margem p/ transbordo",
            st.marginToFlood != null ? `${st.marginToFlood > 0 ? fmt(st.marginToFlood) : "+" + fmt(-st.marginToFlood)} m` : "—",
            { color: st.marginToFlood != null && st.marginToFlood <= 0 ? "#f87171" : "#4ade80",
              sub: st.marginToFlood != null && st.marginToFlood <= 0 ? "acima da cota" : "até transbordar" })}
          ${stat("Tendência", `${rate > 0 ? "+" : ""}${fmt(rate, 1)} cm/h`,
            { color: rate > 0.2 ? "#fb7185" : rate < -0.2 ? "#38bdf8" : null })}
          ${stat("Variação no período", deltaSeries != null ? `${deltaSeries >= 0 ? "+" : ""}${fmt(deltaSeries)} m` : "—",
            { sub: `${data.length} leituras` })}
          ${stat("Mín / Máx (série)", `${fmt(minV)} / ${fmt(maxV)} m`)}
          ${stat("Recorde histórico", st.record ? `${fmt(st.record.level)} m` : "—",
            { sub: st.record?.date ? fmtDate(st.record.date) : "" })}
          ${stat("Ocupação da cota", `${fmt(pct, 0)} %`, { color: stColor })}
          ${stat("Chuva hoje", `${fmt(st.rain?.today, 1)} mm`, { sub: `prev. ${fmt(st.rain?.forecast, 1)} mm` })}
          ${stat("Chuva 7 dias", `${fmt(st.rain?.week, 1)} mm`)}
          ${stat("Última leitura", fmtTime(st.ts), { sub: st.live ? "● ao vivo" : "cache/seed" })}
          ${stat("Situação", STATUS_LABEL[st.status], { color: stColor })}
        </div>

        <div class="m-links">
          <a class="srclink" href=${st.url} target="_blank" rel="noopener">🔗 Ver fonte no nivelguaiba.com.br</a>
          ${st.lat != null && st.lng != null
            ? html`<a class="srclink" href=${`https://www.google.com/maps?q=${st.lat},${st.lng}`} target="_blank" rel="noopener">📍 Ver no mapa</a>`
            : null}
        </div>
      </div>
    </div>`;
}

/* ---------------- mapa da bacia ----------------
   Mapa esquemático georreferenciado: as estações são projetadas pelas
   coordenadas reais (lat/lng) e os rios são desenhados ligando as estações
   na ordem de montante → jusante, com setas indicando o sentido da
   correnteza. Tudo converge para o Guaíba, em Porto Alegre. */
const GUAIBA = "portoalegre";
// Ordem de jusante (o último ponto está mais próximo da foz/Guaíba).
const FLOWS = [
  { river: "Rio Jacuí",     order: ["donafrancisca", "cachoeiradosul", "riopardo"] },
  { river: "Rio Taquari",   order: ["mucum", "encantado", "rocasales", "lajeado", "bomretirodosul"] },
  { river: "Rio Caí",       order: ["feliz", "saosebastiaodocai"] },
  { river: "Rio dos Sinos", order: ["taquara", "saoleopoldo"] },
  { river: "Rio Gravataí",  order: ["gravatai"] },
];

// Direção do rótulo por estação (posições são fixas), escolhida à mão para
// evitar sobreposição nos aglomerados. Fallback: lado com mais espaço.
const LABEL_DIR = {
  mucum: "right", encantado: "left", rocasales: "bottom", lajeado: "left", bomretirodosul: "left",
  donafrancisca: "right", cachoeiradosul: "bottom", riopardo: "top",
  feliz: "right", saosebastiaodocai: "right", saoleopoldo: "left",
  gravatai: "right", taquara: "bottom", portoalegre: "bottom",
};
function labelGeom(dir, r) {
  switch (dir) {
    case "left":   return { lx: -(r + 7), anchor: "end",    cityY: -3, lvlY: 11 };
    case "top":    return { lx: 0, anchor: "middle", cityY: -(r + 16), lvlY: -(r + 3) };
    case "bottom": return { lx: 0, anchor: "middle", cityY: r + 16, lvlY: r + 30 };
    default:       return { lx: r + 7, anchor: "start", cityY: -3, lvlY: 11 };
  }
}

// Curva suave (Catmull-Rom → Bézier): devolve os segmentos cúbicos, para que
// a linha E as setas usem exatamente a mesma geometria (setas alinhadas na curva).
function curveSegments(pts) {
  const segs = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || pts[i + 1];
    segs.push({
      p1, p2,
      c1: { x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6 },
      c2: { x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6 },
    });
  }
  return segs;
}
function pathFromSegments(segs) {
  if (!segs.length) return "";
  const f = (n) => n.toFixed(1);
  let d = `M${f(segs[0].p1.x)},${f(segs[0].p1.y)}`;
  for (const s of segs) d += ` C${f(s.c1.x)},${f(s.c1.y)} ${f(s.c2.x)},${f(s.c2.y)} ${f(s.p2.x)},${f(s.p2.y)}`;
  return d;
}
// Ponto e tangente da cúbica em t — a seta fica exatamente sobre a linha.
function bezAt(s, t) {
  const mt = 1 - t;
  const x = mt * mt * mt * s.p1.x + 3 * mt * mt * t * s.c1.x + 3 * mt * t * t * s.c2.x + t * t * t * s.p2.x;
  const y = mt * mt * mt * s.p1.y + 3 * mt * mt * t * s.c1.y + 3 * mt * t * t * s.c2.y + t * t * t * s.p2.y;
  const dx = 3 * mt * mt * (s.c1.x - s.p1.x) + 6 * mt * t * (s.c2.x - s.c1.x) + 3 * t * t * (s.p2.x - s.c2.x);
  const dy = 3 * mt * mt * (s.c1.y - s.p1.y) + 6 * mt * t * (s.c2.y - s.c1.y) + 3 * t * t * (s.p2.y - s.c2.y);
  return { x, y, ang: (Math.atan2(dy, dx) * 180) / Math.PI };
}

// Janelas de zoom sobre o mapa do RS.
const ZOOMS = {
  bacia: { X0: 1045, Y0: 590, VW: 900, VH: 482 },
  rs: { X0: -40, Y0: -40, VW: RS.W + 80, VH: RS.H + 80 },
};

function MapView({ stations, rivers, onOpen }) {
  // As estações são projetadas no MESMO espaço do contorno do RS (projRS),
  // então ficam georreferenciadas sobre o mapa do estado. A viewBox é uma
  // janela sobre esse mapa: enquadra a bacia + o litoral leste, mantendo os
  // pontos bem espaçados (mostrar o estado inteiro amontoaria tudo).
  const [zoom, setZoom] = useState("bacia");
  const coord = useMemo(() => {
    const c = {};
    for (const s of stations) if (s.lat != null && s.lng != null) c[s.slug] = projRS(s.lat, s.lng);
    return c;
  }, [stations]);

  if (Object.keys(coord).length < 2) return html`<div class="map-empty">Carregando mapa…</div>`;
  const { X0, Y0, VW, VH } = ZOOMS[zoom];
  // Ao afastar (RS inteiro) a viewBox cresce, então pinos/setas precisam
  // acompanhar para continuarem visíveis; os rótulos somem (não caberiam).
  const sc = VW / ZOOMS.bacia.VW;
  const detail = zoom === "bacia";
  const g = coord[GUAIBA];

  const riverEls = FLOWS.map((f) => {
    const nodes = f.order.map((sl) => coord[sl]).filter(Boolean);
    if (!nodes.length) return null;
    const full = g && f.order[f.order.length - 1] !== GUAIBA ? [...nodes, g] : nodes;
    if (full.length < 2) return null;
    const color = rivers[f.river] || "#38bdf8";
    const segs = curveSegments(full);
    return html`<g key=${f.river}>
      <path class="river-path" d=${pathFromSegments(segs)} stroke=${color}/>
      ${segs.map((s, i) => {
        if (Math.hypot(s.p2.x - s.p1.x, s.p2.y - s.p1.y) < 26 * sc) return null; // segmento curto
        const a = bezAt(s, 0.5);
        return html`<path key=${i} class="flow-arrow" d="M-6,-5 L7,0 L-6,5 Z" fill=${color}
          transform=${`translate(${a.x.toFixed(1)} ${a.y.toFixed(1)}) rotate(${a.ang.toFixed(1)}) scale(${sc.toFixed(2)})`}/>`;
      })}
    </g>`;
  });

  const markerEls = stations.filter((s) => coord[s.slug]).map((s) => {
    const c = coord[s.slug], col = STATUS_COLOR[s.status];
    const pct = s.flood ? s.level / s.flood : 0;
    const r = (5.5 + Math.max(0, Math.min(1.25, pct)) * 5) * sc;
    const dir = LABEL_DIR[s.slug] || (c.x > X0 + VW * 0.7 ? "left" : "right");
    const G = labelGeom(dir, r);
    return html`<g key=${s.slug} class=${`marker st-${s.status}`} transform=${`translate(${c.x.toFixed(1)} ${c.y.toFixed(1)})`}
        onClick=${() => onOpen(s.slug)} role="button" tabindex="0"
        onKeyDown=${(e) => (e.key === "Enter" || e.key === " ") && onOpen(s.slug)}>
      <title>${s.city} · ${fmt(s.level)} m (cota ${fmt(s.flood)} m)</title>
      ${s.status === "inundacao" ? html`<circle class="pulse-ring" r=${r} fill="none" stroke=${col} stroke-width=${2 * sc}>
        <animate attributeName="r" values=${`${r};${r + 11 * sc}`} dur="1.8s" repeatCount="indefinite"/>
        <animate attributeName="opacity" values="0.75;0" dur="1.8s" repeatCount="indefinite"/></circle>` : null}
      <circle class="m-halo" r=${r + 4 * sc} fill=${col}/>
      <circle class="m-dot" r=${r} fill=${col} stroke-width=${2.5 * sc}/>
      ${detail ? html`
        <text class="m-city" x=${G.lx} y=${G.cityY} text-anchor=${G.anchor}>${s.city}</text>
        <text class="m-lvl" x=${G.lx} y=${G.lvlY} text-anchor=${G.anchor}>
          <tspan fill=${col}>${fmt(s.level)} m</tspan>${s.flood != null ? html`<tspan class="m-cota"> · cota ${fmt(s.flood)} m</tspan>` : null}
        </text>` : null}
    </g>`;
  });

  return html`
    <div class="mapwrap">
      <div class="map-head">
        <div class="map-title">
          <h2>🗺️ Mapa da Bacia do Guaíba</h2>
          <p>Localização das estações, nível atual e o sentido da correnteza — <b>montante → jusante</b>. Toque num ponto para ver os detalhes.</p>
        </div>
        <div class="map-tools">
          <div class="map-zoom">
            <button class=${zoom === "bacia" ? "on" : ""} onClick=${() => setZoom("bacia")}>🔍 Bacia</button>
            <button class=${zoom === "rs" ? "on" : ""} onClick=${() => setZoom("rs")}>🗺️ RS inteiro</button>
          </div>
          <div class="map-legend">
            ${["inundacao", "alerta", "atencao", "normal"].map((k) => html`
              <span key=${k} class="lg"><span class="lgdot" style=${{ background: STATUS_COLOR[k] }}></span>${STATUS_LABEL[k]}</span>`)}
            <span class="lg"><span class="lgarrow">▸</span>sentido do rio</span>
          </div>
        </div>
      </div>

      <div class="map-canvas">
        <img class="map-logo" src="https://guerreirosdohumaita.com.br/wp-content/uploads/2024/05/logo-guerreiros-branco-1024x411.png" alt="Guerreiros do Humaitá" loading="lazy"/>
        <svg viewBox=${`${X0} ${Y0} ${VW} ${VH}`} class="map-svg" preserveAspectRatio="xMidYMid meet">
          <defs>
            <radialGradient id="guaibaGlow" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stop-color="#38bdf8" stop-opacity="0.45"/>
              <stop offset="100%" stop-color="#38bdf8" stop-opacity="0"/>
            </radialGradient>
          </defs>
          <path class="rs-outline" d=${RS.path}/>
          ${detail ? html`<text class="rs-lbl" x=${X0 + 150} y=${Y0 + 386}>RIO GRANDE DO SUL</text>` : null}
          ${g ? html`<ellipse cx=${g.x} cy=${g.y} rx=${130 * sc} ry=${78 * sc} fill="url(#guaibaGlow)"/>` : null}
          ${g && detail ? html`
            <line class="patos-line" x1=${g.x} y1=${g.y + 8} x2=${g.x} y2=${Y0 + VH - 92} stroke="#38bdf8"/>
            <path class="flow-arrow patos-arrow" d="M-6,-5 L7,0 L-6,5 Z" fill="#38bdf8"
              transform=${`translate(${g.x} ${Y0 + VH - 90}) rotate(90)`}/>
            <text class="water-lbl" x=${g.x} y=${Y0 + VH - 64} text-anchor="middle">Delta do Jacuí · Lago Guaíba → Lagoa dos Patos → Oceano Atlântico</text>` : null}
          ${riverEls}
          ${markerEls}
        </svg>
      </div>

      <${MapInfo}/>
    </div>`;
}

function MapInfo() {
  return html`
    <div class="map-info">
      <h3>Como os rios correm até o Guaíba</h3>
      <p>
        A <b>Região Hidrográfica do Guaíba</b> drena boa parte do nordeste do Rio Grande do Sul. O
        <b>Lago Guaíba</b> nasce em Porto Alegre, no <b>Delta do Jacuí</b>, da confluência de quatro grandes rios.
        Em volume de água, o <b>Jacuí</b> contribui com ~84,6%, o <b>dos Sinos</b> ~7,5%, o <b>Caí</b> ~5,2% e o
        <b>Gravataí</b> ~2,7%. Do delta, o Guaíba percorre ~50 km rumo ao sul até a <b>Lagoa dos Patos</b>, que
        deságua no Oceano Atlântico.
      </p>
      <ul class="flow-list">
        <li><span class="fdot" style=${{ background: "#60a5fa" }}></span>
          <b>Rio Jacuí</b> — principal rio da bacia. Corre de <b>oeste → leste</b>
          (Dona Francisca → Cachoeira do Sul → Rio Pardo) e recebe o Taquari-Antas e o Vacacaí antes do delta.</li>
        <li><span class="fdot" style=${{ background: "#f472b6" }}></span>
          <b>Rio Taquari-Antas</b> — desce da Serra rumo ao sul
          (Muçum → Encantado → Lajeado → Bom Retiro do Sul) e deságua no Jacuí.</li>
        <li><span class="fdot" style=${{ background: "#34d399" }}></span>
          <b>Rio Caí</b> — da encosta da serra para o sul (Feliz → São Sebastião do Caí), até o Guaíba.</li>
        <li><span class="fdot" style=${{ background: "#a78bfa" }}></span>
          <b>Rio dos Sinos</b> — desce a serra rumo ao sul (Taquara → São Leopoldo) e chega ao delta.</li>
        <li><span class="fdot" style=${{ background: "#fbbf24" }}></span>
          <b>Rio Gravataí</b> — atravessa a região metropolitana e deságua junto ao Guaíba, em Porto Alegre.</li>
      </ul>
      <p class="flow-note">
        💡 Como tudo converge para o Guaíba, uma cheia na cabeceira (ex.: no Taquari) sobe primeiro nas cidades a
        montante e só depois chega às cidades a jusante e ao Guaíba — por isso o sentido das setas ajuda a antecipar
        o que vem pela frente.
      </p>
      <p class="src">Fontes: SGB/CPRM (SACE), ANA e nivelguaiba.com.br · Região Hidrográfica do Guaíba.</p>
    </div>`;
}

/* ---------------- topbar ---------------- */
function Topbar({ stations, updatedAt, connected, intervalMin, filter, setFilter }) {
  const counts = useMemo(() => {
    const c = { inundacao: 0, alerta: 0, atencao: 0, normal: 0 };
    for (const s of stations) c[s.status] = (c[s.status] || 0) + 1;
    return c;
  }, [stations]);
  return html`
    <div class="topbar">
      <div class="brand">
        <a class="gh-logo" href="https://guerreirosdohumaita.com.br" target="_blank" rel="noopener" title="Guerreiros do Humaitá">
          <img src="https://guerreirosdohumaita.com.br/wp-content/uploads/2024/05/icon-guerreiros-preto.png" alt="Guerreiros do Humaitá"/>
        </a>
        <div>
          <h1>RS River · Bacia do Guaíba</h1>
          <p>Tempo real · <b>Guerreiros do Humaitá</b> · <i>O Povo pelo Povo!</i></p>
        </div>
      </div>
      <div class="spacer"></div>
      <div class="summary">
        ${chip("inundacao", counts.inundacao, "Inundação", filter, setFilter)}
        ${chip("alerta", counts.alerta, "Alerta", filter, setFilter)}
        ${chip("atencao", counts.atencao, "Atenção", filter, setFilter)}
        ${chip("normal", counts.normal, "Normal", filter, setFilter)}
      </div>
      <div class=${`live ${connected ? "" : "off"}`}>
        <span class="pulse"></span>
        <div>
          <div class="live-title">${connected ? "AO VIVO" : "reconectando…"}</div>
          <div class="live-sub">${updatedAt ? "atualizado " + relTime(updatedAt) : `ciclo a cada ${intervalMin} min`}</div>
        </div>
      </div>
    </div>`;
}
function chip(status, n, label, filter, setFilter) {
  const active = filter === status;
  const on = filter === status || filter === "all";
  return html`<button class=${`chip st-${status} ${active ? "active" : ""} ${on ? "" : "muted"}`}
      onClick=${() => setFilter(active ? "all" : status)} title=${`Filtrar por ${label}`}>
    <span class="dot"></span><b>${n}</b> ${label}
  </button>`;
}

/* ---------------- app ---------------- */
function App() {
  const { stations, history, meta, updatedAt, connected } = useLiveData();
  const [view, setView] = useState("painel");
  const [sort, setSort] = useState("risk");
  const [filter, setFilter] = useState("all");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(null);

  const colorFor = useCallback((riv) => meta.rivers?.[riv] || "#38bdf8", [meta]);

  const vlist = useMemo(() => {
    let arr = stations.slice();
    if (filter !== "all") arr = arr.filter((s) => s.status === filter);
    if (q.trim()) {
      const t = q.toLowerCase();
      arr = arr.filter((s) => s.city.toLowerCase().includes(t) || s.river.toLowerCase().includes(t));
    }
    arr.sort((a, b) => {
      if (sort === "risk") {
        const d = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
        if (d) return d;
        return (b.level / (b.flood || 1)) - (a.level / (a.flood || 1));
      }
      if (sort === "level") return (b.level || 0) - (a.level || 0);
      if (sort === "name") return a.city.localeCompare(b.city);
      if (sort === "rate") return (b.rate || 0) - (a.rate || 0);
      return 0;
    });
    return arr;
  }, [stations, filter, q, sort]);

  const openSt = open ? stations.find((s) => s.slug === open) || null : null;

  return html`
    <div class="app">
      <${Topbar} stations=${stations} updatedAt=${updatedAt} connected=${connected}
        intervalMin=${meta.intervalMin} filter=${filter} setFilter=${setFilter}/>

      <div class="controls">
        <div class="seg viewseg">
          ${segBtn(view, setView, "painel", "▦ Painel")}
          ${segBtn(view, setView, "mapa", "🗺️ Mapa")}
        </div>
        ${view === "painel" ? html`
          <div class="seg">
            ${segBtn(sort, setSort, "risk", "Risco")}
            ${segBtn(sort, setSort, "level", "Nível")}
            ${segBtn(sort, setSort, "rate", "Subindo")}
            ${segBtn(sort, setSort, "name", "A–Z")}
          </div>
          <div class="seg">
            ${segBtn(filter, setFilter, "all", "Todos")}
            ${segBtn(filter, setFilter, "inundacao", "Inundação")}
            ${segBtn(filter, setFilter, "alerta", "Alerta")}
            ${segBtn(filter, setFilter, "atencao", "Atenção")}
            ${segBtn(filter, setFilter, "normal", "Normal")}
          </div>
          <input class="search" placeholder="🔎 buscar cidade ou rio…" value=${q} onInput=${(e) => setQ(e.target.value)}/>
        ` : null}
      </div>

      ${view === "mapa"
        ? html`<${MapView} stations=${stations} rivers=${meta.rivers || {}} onOpen=${(sl) => setOpen(sl)}/>`
        : html`
          <div class="grid">
            ${vlist.map((st, i) => html`
              <${StationCard} key=${st.slug} st=${st} index=${i}
                points=${history[st.slug]} riverColor=${colorFor(st.river)} onOpen=${(s) => setOpen(s.slug)}/>
            `)}
          </div>
          ${vlist.length === 0 ? html`<div class="empty">Nenhuma estação para este filtro.</div>` : null}
        `}

      <div class="footer">
        Dados coletados automaticamente de <a href="https://nivelguaiba.com.br" target="_blank" rel="noopener">nivelguaiba.com.br</a>
        (fontes SGB/CPRM e ANA) · atualização a cada ${meta.intervalMin} min · o histórico de elevação é acumulado localmente.<br/>
        Painel para acompanhamento — não substitui os alertas oficiais da Defesa Civil (telefone 199).<br/>
        Um projeto <a href="https://guerreirosdohumaita.com.br" target="_blank" rel="noopener">Guerreiros do Humaitá</a> · <i>O Povo pelo Povo!</i> 💙
      </div>

      ${openSt ? html`<${Modal} st=${openSt} points=${history[openSt.slug]} riverColor=${colorFor(openSt.river)} onClose=${() => setOpen(null)}/>` : null}
    </div>`;
}
function segBtn(cur, set, val, label) {
  return html`<button class=${cur === val ? "on" : ""} onClick=${() => set(val)}>${label}</button>`;
}

const rootEl = document.getElementById("root");
rootEl.dataset.mounted = "1";
createRoot(rootEl).render(html`<${App}/>`);
