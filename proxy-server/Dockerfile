FROM node:20-alpine

WORKDIR /app

# Zero dependencies — only stdlib used. Copy package.json first for layer cache.
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY server.js ./

EXPOSE 3000

# Run as non-root for safety.
RUN addgroup -S app && adduser -S -G app app && chown -R app:app /app
USER app

CMD ["node", "server.js"]
