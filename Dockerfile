# Headless Scarlet engine: API and render workers.
# The local agent host (apps/agent) runs on each editor's machine, not here.

FROM node:22-bookworm-slim AS build
RUN corepack enable && corepack prepare pnpm@12.16.1 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json .npmrc ./
COPY packages ./packages
COPY apps ./apps
COPY skills ./skills
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @scarlet/server... build
RUN pnpm --filter @scarlet/server --prod deploy /out/server

FROM node:22-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg fonts-inter fonts-dejavu-core ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /out/server ./server
COPY --from=build /app/skills ./skills
ENV SCARLET_DATA=/data \
    SCARLET_HOST=0.0.0.0 \
    SCARLET_PORT=4000 \
    SCARLET_SKILLS_SEED=/app/skills \
    NODE_ENV=production
VOLUME ["/data"]
EXPOSE 4000
CMD ["node", "server/dist/cli.js"]
