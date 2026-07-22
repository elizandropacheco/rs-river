import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { createRoot } from "react-dom/client";
import htm from "htm";

const html = htm.bind(React.createElement);

/* ---------------- helpers ---------------- */
const STATUS_LABEL = { normal: "Normal", atencao: "Atenção", alerta: "Alerta", inundacao: "Inundação" };
const STATUS_COLOR = { normal: "#22c55e", atencao: "#eab308", alerta: "#f97316", inundacao: "#ef4444" };
const STATUS_ORDER = { inundacao: 0, alerta: 1, atencao: 2, normal: 3 };

const fmt = (n, d = 2) => (n == null || Number.isNaN(n) ? "—" : Number(n).toFixed(d));
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

/* ---------------- gráfico de área (SVG) ---------------- */
function AreaChart({ points, color, height = 64, flood }) {
  const data = (points || []).map((p) => p.v).filter((v) => v != null);
  if (data.length < 2) {
    return html`<div style=${{ height, display: "flex", alignItems: "center", justifyContent: "center", color: "#5b6884", fontSize: 12 }}>coletando histórico…</div>`;
  }
  const W = 300, H = height, pad = 4;
  let min = Math.min(...data), max = Math.max(...data);
  if (flood != null) max = Math.max(max, flood);
  if (max - min < 0.001) { max += 0.5; min -= 0.5; }
  const rng = max - min;
  const x = (i) => pad + (i / (data.length - 1)) * (W - pad * 2);
  const y = (v) => pad + (1 - (v - min) / rng) * (H - pad * 2);
  const line = data.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const area = `${line} L${x(data.length - 1).toFixed(1)},${H - pad} L${x(0).toFixed(1)},${H - pad} Z`;
  const gid = "g" + Math.abs(hashStr(color + data.length + min));
  const floodY = flood != null ? y(flood) : null;
  const last = data[data.length - 1];
  return html`
    <svg viewBox=${`0 0 ${W} ${H}`} preserveAspectRatio="none">
      <defs>
        <linearGradient id=${gid} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stop-color=${color} stop-opacity="0.45"/>
          <stop offset="100%" stop-color=${color} stop-opacity="0"/>
        </linearGradient>
      </defs>
      ${floodY != null && floodY > 0 && floodY < H
        ? html`<line x1="0" x2=${W} y1=${floodY} y2=${floodY} stroke="#f87171" stroke-width="1" stroke-dasharray="4 4" opacity="0.7"/>`
        : null}
      <path d=${area} fill=${`url(#${gid})`}/>
      <path d=${line} fill="none" stroke=${color} stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
      <circle cx=${x(data.length - 1)} cy=${y(last)} r="3.2" fill=${color}>
        <animate attributeName="r" values="3.2;5;3.2" dur="1.8s" repeatCount="indefinite"/>
      </circle>
    </svg>`;
}
function hashStr(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h; }

/* ---------------- card ---------------- */
function StationCard({ st, points, color, onOpen, index }) {
  const level = useCountUp(st.level, 700);
  const pct = st.flood ? Math.min(100, Math.max(2, (st.level / st.flood) * 100)) : 0;
  const rate = st.rate || 0;
  const trendClass = rate > 0.2 ? "up" : rate < -0.2 ? "down" : "flat";
  const trendIcon = rate > 0.2 ? "▲" : rate < -0.2 ? "▼" : "▬";
  return html`
    <div class=${`card st-${st.status}`} style=${{ "--riv": color, animationDelay: `${index * 45}ms` }} onClick=${() => onOpen(st)}>
      <div class="accent"></div>
      <div class="card-head">
        <div>
          <div class="city">${st.city}</div>
          <div class="river"><span class="rdot"></span>${st.river}</div>
        </div>
        <div class=${`badge ${st.status}`}>${STATUS_LABEL[st.status]}</div>
      </div>

      <div class="metric-row">
        <div class="level">${fmt(level)}<span class="u">m</span></div>
        <div class=${`trend ${trendClass}`}>${trendIcon} ${fmt(Math.abs(rate), 1)} cm/h</div>
      </div>

      <div class="gauge">
        <div class="tube" title="Nível vs cota de inundação">
          <div class="fill" style=${{ height: pct + "%" }}></div>
          ${st.flood ? html`<div class="flood-line" style=${{ bottom: "100%" }}></div>` : null}
        </div>
        <div class="g-meta">
          <div class="row"><span>Cota de inundação</span><b>${fmt(st.flood)} m</b></div>
          <div class="row"><span>Margem p/ transbordo</span>
            <b style=${{ color: st.marginToFlood != null && st.marginToFlood <= 0 ? "#f87171" : "#4ade80" }}>
              ${st.marginToFlood != null ? (st.marginToFlood > 0 ? `${fmt(st.marginToFlood)} m` : `+${fmt(-st.marginToFlood)} m acima`) : "—"}
            </b></div>
          <div class="row"><span>Ocupação da cota</span><b class="pct" style=${{ color }}>${fmt(pct, 0)}%</b></div>
        </div>
      </div>

      <div class="spark">
        <span class="lbl">Histórico de elevação</span>
        <${AreaChart} points=${points} color=${color} flood=${st.flood}/>
      </div>

      <div class="facts">
        <div class="fact"><span class="k">Recorde histórico</span>
          <span class="v">${st.record ? `${fmt(st.record.level)} m` : "—"}</span>
          <span class="v small">${st.record?.date ? new Date(st.record.date).toLocaleDateString("pt-BR") : ""}</span>
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
        <span>toque para detalhes →</span>
      </div>
    </div>`;
}

/* ---------------- modal ---------------- */
function Modal({ st, points, color, onClose }) {
  useEffect(() => {
    const h = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);
  const data = points || [];
  const vals = data.map((p) => p.v);
  const minV = vals.length ? Math.min(...vals) : 0;
  const maxV = vals.length ? Math.max(...vals) : 0;
  return html`
    <div class="modal-bg" onClick=${onClose}>
      <div class="modal" style=${{ position: "relative" }} onClick=${(e) => e.stopPropagation()}>
        <div class="close"><button class="x" onClick=${onClose}>×</button></div>
        <h2>${st.city}</h2>
        <div class="sub">
          <span class="rdot" style=${{ width: 9, height: 9, borderRadius: "50%", background: color, display: "inline-block" }}></span>
          ${st.river} · <span style=${{ color: STATUS_COLOR[st.status], fontWeight: 700 }}>${STATUS_LABEL[st.status]}</span>
          · atualizado ${relTime(st.ts)}
        </div>
        <div class="big-chart">
          <div style=${{ fontSize: 12, color: "#8ea3c6", marginBottom: 8 }}>
            Histórico de elevação (${data.length} leituras) — linha tracejada = cota de inundação
          </div>
          <div style=${{ height: 180 }}>
            <${AreaChart} points=${data} color=${color} flood=${st.flood} height=${180}/>
          </div>
        </div>
        <div class="stat-grid">
          ${statBox("Nível atual", `${fmt(st.level)} m`)}
          ${statBox("Cota de inundação", `${fmt(st.flood)} m`)}
          ${statBox("Tendência", `${st.rate > 0 ? "+" : ""}${fmt(st.rate, 1)} cm/h`)}
          ${statBox("Margem p/ transbordo", st.marginToFlood != null ? (st.marginToFlood > 0 ? `${fmt(st.marginToFlood)} m` : `${fmt(st.marginToFlood)} m`) : "—")}
          ${statBox("Recorde histórico", st.record ? `${fmt(st.record.level)} m` : "—")}
          ${statBox("Mín / Máx (série)", `${fmt(minV)} / ${fmt(maxV)} m`)}
          ${statBox("Chuva hoje", `${fmt(st.rain?.today, 1)} mm`)}
          ${statBox("Chuva 7 dias", `${fmt(st.rain?.week, 1)} mm`)}
        </div>
        <a class="srclink" href=${st.url} target="_blank" rel="noopener">🔗 Ver fonte no nivelguaiba.com.br</a>
      </div>
    </div>`;
}
function statBox(k, v) {
  return html`<div class="stat"><div class="k">${k}</div><div class="v">${v}</div></div>`;
}

/* ---------------- topbar ---------------- */
function Topbar({ stations, updatedAt, connected, intervalMin }) {
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
        ${chip(STATUS_COLOR.inundacao, counts.inundacao, "Inundação")}
        ${chip(STATUS_COLOR.alerta, counts.alerta, "Alerta")}
        ${chip(STATUS_COLOR.atencao, counts.atencao, "Atenção")}
        ${chip(STATUS_COLOR.normal, counts.normal, "Normal")}
      </div>
      <div class=${`live ${connected ? "" : "off"}`}>
        <span class="pulse"></span>
        <div>
          <div style=${{ fontWeight: 700, color: connected ? "#4ade80" : "#94a3b8" }}>${connected ? "AO VIVO" : "reconectando…"}</div>
          <div style=${{ fontSize: 11 }}>${updatedAt ? "atualizado " + relTime(updatedAt) : `ciclo a cada ${intervalMin} min`}</div>
        </div>
      </div>
    </div>`;
}
function chip(color, n, label) {
  return html`<div class="chip"><span class="dot" style=${{ background: color }}></span><b>${n}</b> ${label}</div>`;
}

/* ---------------- app ---------------- */
function App() {
  const { stations, history, meta, updatedAt, connected } = useLiveData();
  const [sort, setSort] = useState("risk");
  const [filter, setFilter] = useState("all");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(null);

  const colorFor = useCallback((riv) => meta.rivers?.[riv] || "#38bdf8", [meta]);

  const view = useMemo(() => {
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
      <${Topbar} stations=${stations} updatedAt=${updatedAt} connected=${connected} intervalMin=${meta.intervalMin}/>

      <div class="controls">
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
          ${segBtn(filter, setFilter, "normal", "Normal")}
        </div>
        <input class="search" placeholder="🔎 buscar cidade ou rio…" value=${q} onInput=${(e) => setQ(e.target.value)}/>
      </div>

      <div class="grid">
        ${view.map((st, i) => html`
          <${StationCard} key=${st.slug} st=${st} index=${i}
            points=${history[st.slug]} color=${colorFor(st.river)} onOpen=${(s) => setOpen(s.slug)}/>
        `)}
      </div>
      ${view.length === 0 ? html`<div style=${{ textAlign: "center", color: "#5b6884", padding: 40 }}>Nenhuma estação para este filtro.</div>` : null}

      <div class="footer">
        Dados coletados automaticamente de <a href="https://nivelguaiba.com.br" target="_blank" rel="noopener">nivelguaiba.com.br</a>
        (fontes SGB/CPRM e ANA) · atualização a cada ${meta.intervalMin} min · o histórico de elevação é acumulado localmente.<br/>
        Painel para acompanhamento — não substitui os alertas oficiais da Defesa Civil (telefone 199).<br/>
        Um projeto <a href="https://guerreirosdohumaita.com.br" target="_blank" rel="noopener">Guerreiros do Humaitá</a> · <i>O Povo pelo Povo!</i> 💙
      </div>

      ${openSt ? html`<${Modal} st=${openSt} points=${history[openSt.slug]} color=${colorFor(openSt.river)} onClose=${() => setOpen(null)}/>` : null}
    </div>`;
}
function segBtn(cur, set, val, label) {
  return html`<button class=${cur === val ? "on" : ""} onClick=${() => set(val)}>${label}</button>`;
}

const rootEl = document.getElementById("root");
rootEl.dataset.mounted = "1";
createRoot(rootEl).render(html`<${App}/>`);
