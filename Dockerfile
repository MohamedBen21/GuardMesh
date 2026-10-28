FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
COPY web ./web
RUN npm run build && npm prune --omit=dev
ENV NODE_ENV=production
CMD ["node", "dist/server.js"]
