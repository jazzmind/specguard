# The SpecGuard team server, for the sandbox. Build context is the repository root:
#   docker build -f deploy/sandbox/Dockerfile .
#
# Node 24 honours HTTP(S)_PROXY for `fetch` when NODE_USE_ENV_PROXY=1, which the artifact puller needs if the
# sandbox reaches GitHub through a proxy.

# Stage 1: compile TypeScript
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
# The `prepare` script compiles on install, before the sources are copied; compile explicitly below instead.
RUN npm ci --ignore-scripts
COPY src ./src
RUN npx tsc

# Stage 2: production image
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production \
    NODE_USE_ENV_PROXY=1 \
    SPECGUARD_HOST=0.0.0.0 \
    SPECGUARD_DATA_DIR=/tmp/specguard-data
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist ./dist

EXPOSE 4317
# Run as non-root.
USER node
CMD ["node", "dist/cli/index.js", "server"]
