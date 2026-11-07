FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .
RUN npm run build

ENV NODE_ENV=production
# Puertos estándar del panel: 80 (HTTP) y 443 (HTTPS con el certificado montado
# en /app/certs). PORT se puede forzar con `-e PORT=...` si el 80 está ocupado.
ENV PORT=80
ENV TVLISTER_TLS_DIR=/app/certs
EXPOSE 80 443

CMD ["node", "--no-warnings", "server/index.js"]
