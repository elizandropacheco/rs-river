# Imagem única: backend Node nativo (crawler + API + WebSocket) que também
# serve o front React. Sem `npm install` — nenhuma dependência externa,
# então o build é rápido e não depende de registries além da imagem base.
FROM node:20-alpine

WORKDIR /app

# Backend
COPY server/package.json ./package.json
COPY server/src ./src

# Front (servido estaticamente pelo backend em ./public)
COPY web ./public

ENV NODE_ENV=production \
    PORT=8080 \
    CRAWL_INTERVAL_MIN=5 \
    DATA_DIR=/app/data

RUN mkdir -p /app/data

EXPOSE 8080
VOLUME ["/app/data"]

# Healthcheck simples batendo na API
HEALTHCHECK --interval=30s --timeout=4s --start-period=5s --retries=3 \
  CMD wget -qO- http://localhost:8080/api/health || exit 1

CMD ["node", "src/index.js"]
