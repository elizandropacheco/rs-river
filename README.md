<p align="center">
  <img src="https://guerreirosdohumaita.com.br/wp-content/uploads/2024/05/icon-guerreiros-preto.png" alt="Guerreiros do Humaitá" width="130"/>
</p>

<h1 align="center">🌊 RS River · Monitoramento dos Rios da Bacia do Guaíba</h1>

<p align="center">
  <b>Um projeto <a href="https://guerreirosdohumaita.com.br">Guerreiros do Humaitá</a></b><br/>
  <i>"O Povo pelo Povo!"</i>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/stack-React%20%2B%20Node%20%2B%20Docker-38bdf8" alt="stack"/>
  <img src="https://img.shields.io/badge/dados-SGB%2FCPRM%20%2B%20ANA-60a5fa" alt="fontes"/>
  <img src="https://img.shields.io/badge/tempo%20real-WebSocket-a78bfa" alt="realtime"/>
</p>

---

## 💧 Por que este projeto existe

Em maio de 2024, a maior enchente da história do Rio Grande do Sul devastou a
região metropolitana de Porto Alegre. O bairro **Humaitá** foi um dos mais
atingidos — e foi ali que nasceram os **Guerreiros do Humaitá**, uma entidade
humanitária de voluntários especializada em **resgates, logística e distribuição
de doações**, que já salvou mais de 500 animais e atua desde a linha de frente
até a organização das ajudas por todo o Estado.

Quando um rio sobe, **cada minuto conta**. A diferença entre uma evacuação
tranquila e um resgate de emergência costuma estar em enxergar a subida do nível
*antes* que ela vire tragédia. As informações oficiais existem, mas estão
espalhadas por várias estações, páginas e formatos.

O **RS River** reúne tudo isso em **uma única tela**: o nível de **todos os rios
da Bacia do Guaíba**, em tempo real, com a cota de inundação de cada ponto, a
velocidade de subida, o histórico de elevação e alertas visuais claros. A ideia é
dar às equipes de resgate, à Defesa Civil comunitária e à população uma
**ferramenta de consciência situacional** — simples de abrir, rápida de ler e que
se atualiza sozinha — para **antecipar decisões e proteger vidas**.

> ⚠️ Este painel é uma ferramenta de apoio à decisão. **Não substitui os canais
> oficiais da Defesa Civil (telefone 199).** Em emergência, ligue 193 (Bombeiros).

---

## ✨ O que o painel mostra

Tudo numa dashboard estilo **Grafana**, escura, com efeitos visuais e atualização
automática:

- **14 estações** monitoradas na mesma tela (cobertura completa da fonte) — Porto
  Alegre, Lajeado, Encantado, Muçum, Roca Sales, São Sebastião do Caí, Taquara,
  Gravataí, Bom Retiro do Sul, Cachoeira do Sul, Dona Francisca, Rio Pardo, São
  Leopoldo e Feliz.
- **Mapa da bacia** sobre o contorno do Rio Grande do Sul, com as estações
  georreferenciadas e **setas indicando o sentido da correnteza** (montante →
  jusante) até o Delta do Jacuí, o Guaíba e a Lagoa dos Patos.
- **Nível atual** de cada rio, com contador animado e **coluna d'água** que se
  enche conforme a proximidade da cota de inundação.
- **Tendência em tempo real** (cm/h) — se o rio está subindo ou baixando e quão
  rápido.
- **Margem para transbordo** — quantos metros faltam (ou quantos já passou) da
  cota de inundação, com destaque em vermelho quando ultrapassa.
- **Histórico de elevação** de cada rio em um gráfico SVG, incluindo a linha da
  cota de inundação.
- **Recorde histórico** e **dados de chuva** (hoje, previsão do dia e acumulado
  de 7 dias) em cada card.
- **Alertas visuais**: cards em *Inundação* ganham brilho pulsante vermelho;
  *Alerta* e *Atenção* têm cores próprias; ordenação automática por risco.
- **Tempo real via WebSocket** — os cards se atualizam sozinhos, sem recarregar.
- **Filtros e busca** por status, cidade ou rio, e um **modal** com o histórico
  completo e todas as estatísticas de cada estação.

---

## 🚀 Como rodar

### Com Docker (recomendado)

Pré-requisito: **Docker Desktop** instalado e aberto.

```bash
cd rs-river
docker compose up --build
```

Abra **http://localhost:8080**

- Segundo plano: `docker compose up -d --build`
- Parar: `docker compose down`

### Sem Docker

Precisa apenas de **Node 18+** (o projeto **não tem nenhuma dependência** a
instalar):

```bash
cd server
cp -r ../web ./public
node src/index.js        # http://localhost:8080
```

---

## ⚙️ Configuração

| Variável             | Padrão | Descrição                            |
|----------------------|--------|--------------------------------------|
| `PORT`               | 8080   | Porta do servidor                    |
| `CRAWL_INTERVAL_MIN` | 5      | Minutos entre cada coleta            |
| `DATA_DIR`           | ./data | Onde o histórico é persistido        |

---

## 🧠 Como funciona

```
┌──────────────┐   coleta a cada N min     ┌────────────────────┐
│  crawler.js  │ ────────────────────────▶ │ nivelguaiba.com.br │
└──────┬───────┘   endpoints JSON públicos  └────────────────────┘
       │  /<slug>.7days.json  → série de nível
       │  /<slug>.30days.json → popula histórico (1ª coleta)
       │  /<slug>.weather.json → chuva/previsão   (fonte: SGB/CPRM + ANA)
       ▼
┌──────────────┐   REST /api/*  +  WebSocket /ws   ┌──────────────┐
│  histórico   │ ────────────────────────────────▶ │  React (SPA) │
│  (em disco)  │                                   │  dashboard   │
└──────────────┘                                   └──────────────┘
```

- **Backend** (`server/`): Node puro, **sem dependências externas** (usa apenas
  `http`, `crypto` e o `fetch` nativo). Serve a API REST, o WebSocket de tempo
  real e o front estático.
- **Crawler** (`server/src/crawler.js`): consome os **endpoints JSON públicos** do
  próprio nivelguaiba (mesma fonte oficial SGB/CPRM + ANA, muito mais estável que
  raspar HTML). Pega a série de nível (`.7days.json`), a chuva (`.weather.json`),
  calcula a tendência (cm/h) sobre a série e remove picos de sensor (dropouts). A
  cota de inundação e o recorde são estáveis e vêm dos metadados/seed; qualquer
  campo indisponível mantém o último valor conhecido.
- **Histórico populado + acumulado**: na primeira coleta busca uma série longa
  (`.30days.json`, configurável via `HISTORY_SEED_RANGE`) para já abrir com dados
  passados; nos ciclos seguintes mescla os últimos dias em `./data` (dedup por
  timestamp), mantendo a série de elevação completa e autocorretiva.
- **Frontend** (`web/`): React carregado como ES module (**sem etapa de build**),
  com gráficos SVG feitos à mão. Requer internet para carregar o React (o app já
  depende de internet para o crawler).

---

## 📁 Estrutura

```
rs-river/
├── docker-compose.yml
├── Dockerfile
├── README.md
├── server/
│   ├── package.json
│   └── src/
│       ├── index.js         # servidor HTTP + WebSocket + agendador
│       ├── crawler.js       # coleta e parsing das estações
│       ├── stations.js      # estações monitoradas + metadados
│       ├── seed.js          # snapshot inicial (fallback offline)
│       ├── store.js         # persistência do histórico
│       └── ws.js            # WebSocket mínimo (RFC 6455)
└── web/
    ├── index.html
    ├── styles.css
    └── app.js               # dashboard React
```

---

## 📊 Fontes de dados

Os dados são coletados automaticamente de
[nivelguaiba.com.br](https://nivelguaiba.com.br), que por sua vez consolida a
telemetria do **SGB/CPRM** (Serviço Geológico do Brasil) e da **ANA** (Agência
Nacional de Águas), atualizada a cada ~15 minutos.

---

## 🤝 Contribua com os Guerreiros do Humaitá

Este painel é uma iniciativa de apoio às operações. Conheça o trabalho, faça uma
doação ou seja voluntário em **[guerreirosdohumaita.com.br](https://guerreirosdohumaita.com.br)**.

<p align="center"><i>Feito com 💙 para quem está na linha de frente.</i></p>
