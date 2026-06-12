# Codevertise marketplace server.
#
#   docker build -t codevertise .
#   docker run -p 4021:4021 -v codevertise-data:/data \
#     -e DB_PATH=/data/codevertise.db \
#     -e PAYMENTS_MODE=x402 -e PAY_TO_ADDRESS=0xYourTreasury \
#     codevertise
#
# node:22-slim (not alpine): better-sqlite3 ships glibc prebuilds.
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/server/package.json packages/server/
COPY packages/sdk/package.json packages/sdk/
COPY packages/agent-bidder/package.json packages/agent-bidder/
COPY packages/cli-demo/package.json packages/cli-demo/
COPY packages/claude-code/package.json packages/claude-code/
COPY packages/webapp/package.json packages/webapp/
RUN npm ci
COPY . .
RUN npm run build --workspace @codevertise/server

FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app /app
# Pre-create the volume mountpoint owned by node, so named volumes
# inherit writable ownership instead of root's.
RUN mkdir /data && chown node:node /data
USER node
EXPOSE 4021
HEALTHCHECK --interval=30s --timeout=3s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT??4021)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "packages/server/dist/index.js"]
