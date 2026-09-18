# Single process: Hono serves the built client (dist/) and /api on one port.
FROM node:22-alpine
WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build

ENV NODE_ENV=production PORT=8787
EXPOSE 8787
# CFE meter readings live in /app/data — mount a volume there or they are lost.
CMD ["pnpm", "start"]
