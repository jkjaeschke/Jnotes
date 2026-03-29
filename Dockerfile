# Build
FROM node:22-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json

RUN npm ci

COPY packages/shared packages/shared
COPY apps/api apps/api
COPY apps/web apps/web

# Required for Google Sign-In in the built SPA (same value as GOOGLE_CLIENT_ID at runtime).
ARG VITE_GOOGLE_CLIENT_ID=""
ENV VITE_GOOGLE_CLIENT_ID=$VITE_GOOGLE_CLIENT_ID

RUN npm run build --workspace=@freenotes/web
RUN npm run build --workspace=@freenotes/api

# Runtime
FROM node:22-bookworm-slim AS runtime
WORKDIR /app/apps/api
ENV NODE_ENV=production
ENV STATIC_DIR=/app/apps/web/dist

COPY --from=build /app/package.json /app/package-lock.json /app/
COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/apps/api/package.json ./
COPY --from=build /app/apps/api/dist ./dist
COPY --from=build /app/apps/web/dist /app/apps/web/dist

EXPOSE 3000
CMD ["node", "dist/index.js"]
