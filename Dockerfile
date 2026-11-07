FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
# O processo roda como o usuário "node" (uid 1000); a pasta data/ montada precisa ser dele: chown 1000:1000 data
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget -qO- http://127.0.0.1:3000/api/config >/dev/null || exit 1
CMD ["node", "server.js"]
