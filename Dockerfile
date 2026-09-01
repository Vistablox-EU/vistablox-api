# syntax=docker/dockerfile:1

# Prisma's client here (generator "prisma-client" + @prisma/adapter-pg) is
# driver-adapter-only: no native query-engine binary, so plain node:alpine
# works with no glibc/OpenSSL matching concerns.

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build
WORKDIR /app
COPY prisma.config.ts tsconfig.json tsconfig.build.json ./
COPY prisma ./prisma
COPY src ./src
RUN npm run build

FROM node:22-alpine AS runtime-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# --- migrate: runs `prisma migrate deploy`; needs the Prisma CLI (a
# devDependency) and the schema/migrations, so it reuses the build stage
# rather than the slimmer runtime-deps install.
FROM build AS migrate
CMD ["npm", "run", "db:migrate:deploy"]

# --- api: the HTTP server.
FROM node:22-alpine AS api
WORKDIR /app
ENV NODE_ENV=production
COPY --from=runtime-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
EXPOSE 3000
CMD ["node", "dist/server.js"]

# --- worker: the pg-boss scheduled-job process. Same image contents as
# api; only the entrypoint differs.
FROM node:22-alpine AS worker
WORKDIR /app
ENV NODE_ENV=production
COPY --from=runtime-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
CMD ["node", "dist/worker.js"]
