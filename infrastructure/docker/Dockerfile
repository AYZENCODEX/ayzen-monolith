FROM node:20-bookworm-slim AS build

WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
COPY services ./services
COPY artifacts ./artifacts
COPY lib ./lib
# Phase H8.3 — config/workflow/security.json (and the rest of config/) was
# never copied into the image at all, so packages/workflow/src/security-policy.mjs
# would always fall back to its built-in defaults in every real deployment,
# never the file an operator actually edits. Bundled read-only alongside
# the source directories above, same as everything else this image ships.
COPY config ./config

RUN pnpm install --frozen-lockfile

ARG APP_PATH
RUN if pnpm --filter "$APP_PATH" run build --if-present; then :; else \
      echo "Build failed for $APP_PATH" >&2; exit 1; \
    fi
RUN pnpm prune --prod

FROM node:20-bookworm-slim AS runtime

WORKDIR /app
RUN corepack enable && chown -R node:node /app

COPY --from=build --chown=node:node /app ./

ARG APP_PATH
ARG APP_VERSION=local
ARG APP_COMMIT=unknown
ENV NODE_ENV=production
ENV APP_PATH=${APP_PATH}
ENV APP_VERSION=${APP_VERSION}
ENV APP_COMMIT=${APP_COMMIT}
ENV APP_PORT=8080

LABEL org.opencontainers.image.title="AYZEN deployable" \
      org.opencontainers.image.version="${APP_VERSION}" \
      org.opencontainers.image.revision="${APP_COMMIT}" \
      org.opencontainers.image.source="https://github.com/ayzen/ayzen"

USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT ?? process.env.APP_PORT ?? 8080) + '/health').then(r => { if (!r.ok) process.exit(1) }).catch(() => process.exit(1))"

CMD ["sh", "-c", "pnpm --filter \"$APP_PATH\" start"]