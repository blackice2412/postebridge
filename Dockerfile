FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js ./
COPY lib ./lib
COPY scripts ./scripts
COPY public ./public

RUN mkdir -p /app/data

ENV NODE_ENV=production
ENV PORT=3847
ENV DATA_DIR=/app/data

VOLUME ["/app/data"]

EXPOSE 3847

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT}/login || exit 1

CMD ["node", "server.js"]
