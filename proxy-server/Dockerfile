FROM node:20-alpine

WORKDIR /app

# Zero dependencies — only stdlib used. Copy package.json first for layer cache.
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY server.js ./

EXPOSE 3000

# Personal-use container: run as root so it can mkdir /var/data/voice-sync
# in the bind-mounted host volume without UID/GID gymnastics.
CMD ["node", "server.js"]
