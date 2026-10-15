# The SpecGuard team server, for the sandbox. Build context is the repository root:
#   docker build .
#
# Node 20, like the other sandbox apps, so the base image is one the sandbox already has. (Node 24 would also honour
# HTTP(S)_PROXY for `fetch` via NODE_USE_ENV_PROXY=1, which the artifact puller needs if GitHub is only reachable
# through a proxy; add that when it is needed.)

# Stage 1: compile TypeScript
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
# The `prepare` script compiles on install, before the sources are copied; compile explicitly below instead.
RUN npm ci --ignore-scripts
COPY src ./src
RUN npx tsc

# Stage 2: production image
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production \
    SPECGUARD_HOST=0.0.0.0 \
    SPECGUARD_DATA_DIR=/tmp/specguard-data
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist ./dist

EXPOSE 4317
# Run as non-root.
USER node
CMD ["node", "dist/cli/index.js", "server"]
