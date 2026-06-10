
FROM oven/bun:1 AS deps
WORKDIR /app
COPY package.json bun.lock ./
COPY apps/web/package.json apps/web/package.json
COPY apps/signal/package.json apps/signal/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN bun install --frozen-lockfile --ignore-scripts
FROM deps AS builder
WORKDIR /app
COPY . .
ARG VITE_SIGNAL_ORIGIN=
ARG VITE_TURN_URL=
ARG VITE_TURN_USERNAME=
ARG VITE_TURN_CREDENTIAL=
ENV VITE_SIGNAL_ORIGIN=${VITE_SIGNAL_ORIGIN}
ENV VITE_TURN_URL=${VITE_TURN_URL}
ENV VITE_TURN_USERNAME=${VITE_TURN_USERNAME}
ENV VITE_TURN_CREDENTIAL=${VITE_TURN_CREDENTIAL}
RUN bun run build

FROM nginx:alpine AS web
COPY docker/nginx-web.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]

FROM oven/bun:1 AS signal
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/apps/signal/dist/index.js /app/index.js
EXPOSE 3001
CMD ["bun", "/app/index.js"]
