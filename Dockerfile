# syntax=docker/dockerfile:1

# ==================== Docker CLI used by the Web runtime manager ====================
FROM docker:27.5.1-cli@sha256:851f91d241214e7c6db86513b270d58776379aacc5eb9c4a87e5b47115e3065c AS docker-cli

# ==================== Shared glibc/OpenSSL base ====================
FROM node:22-bookworm-slim AS base

# Prisma generation must detect the same OpenSSL ABI used at runtime, while
# Temporal's native bridge requires glibc rather than Alpine/musl.
RUN rm -f /etc/apt/apt.conf.d/docker-clean
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    sh -ec 'apt-get -o Acquire::Retries=1 -o Acquire::http::Timeout=10 -o Acquire::https::Timeout=10 update \
      && apt-get -o Acquire::Retries=1 -o Acquire::http::Timeout=10 -o Acquire::https::Timeout=10 install -y --no-install-recommends ca-certificates openssl \
      || echo "Optional OpenSSL packages unavailable; using the node base image" >&2'

# ==================== Stage 1: Dependencies ====================
FROM base AS deps
WORKDIR /app

ARG DEPLOYMENT_EDITION=self-hosted
ENV DEPLOYMENT_EDITION=$DEPLOYMENT_EDITION

# The root lockfile is the complete self-hosted dependency set. Cloud-only
# packages have their own lockfile under ee/ and are installed only for a Cloud
# build. Copying the source here keeps the ee/ input optional: an exported OSS
# tree with ee/ physically absent still builds this same Dockerfile.
COPY . .
# ffmpeg-ffprobe-static's install script downloads its release binaries from
# GitHub. On networks where GitHub is unreachable, point it at a local mirror
# (the script honors this base URL natively); empty keeps the GitHub default.
ARG FFMPEG_FFPROBE_STATIC_BASE_URL=
ENV FFMPEG_FFPROBE_STATIC_BASE_URL=$FFMPEG_FFPROBE_STATIC_BASE_URL
RUN --mount=type=cache,target=/root/.npm \
    npm ci --prefer-offline
RUN --mount=type=cache,target=/root/.npm \
    if [ "$DEPLOYMENT_EDITION" = "cloud" ]; then \
      npm ci --prefix ee --prefer-offline --ignore-scripts; \
    fi

# ==================== Local container development ====================
FROM deps AS development

ENV NODE_ENV=development

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    sh -ec 'apt-get -o Acquire::Retries=1 -o Acquire::http::Timeout=10 -o Acquire::https::Timeout=10 update \
      && apt-get -o Acquire::Retries=1 -o Acquire::http::Timeout=10 -o Acquire::https::Timeout=10 install -y --no-install-recommends gosu tini \
      || echo "Optional gosu/tini packages unavailable; entrypoint fallbacks will be used" >&2'

COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
# CLI >= 25 routes `docker build` through the buildx plugin; carry the plugins
# along so in-container builds work.
COPY --from=docker-cli /usr/local/libexec/docker/cli-plugins/ /usr/libexec/docker/cli-plugins/
COPY --chown=root:root docker/development/entrypoint.sh /usr/local/bin/waoowaoo-dev-entrypoint
RUN chmod 0755 /usr/local/bin/waoowaoo-dev-entrypoint

ENTRYPOINT ["/usr/local/bin/waoowaoo-dev-entrypoint"]

# ==================== Stage 2: Build ====================
FROM deps AS builder
RUN npm run build
RUN if [ "$DEPLOYMENT_EDITION" = "self-hosted" ]; then rm -rf /app/ee; fi

# ==================== Stage 3: Production ====================
FROM base AS runner
WORKDIR /app

ARG DEPLOYMENT_EDITION=self-hosted
ENV NODE_ENV=production
ENV DEPLOYMENT_EDITION=$DEPLOYMENT_EDITION
LABEL com.waoowaoo.deployment-edition=$DEPLOYMENT_EDITION

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    sh -ec 'apt-get -o Acquire::Retries=1 -o Acquire::http::Timeout=10 -o Acquire::https::Timeout=10 update \
      && apt-get -o Acquire::Retries=1 -o Acquire::http::Timeout=10 -o Acquire::https::Timeout=10 install -y --no-install-recommends gosu tini \
      || echo "Optional gosu/tini packages unavailable; entrypoint fallbacks will be used" >&2'

# Web and Temporal Worker run from this exact build snapshot. Self-hosted
# builder output has ee/ removed before this copy; Cloud output retains the EE
# source and its separately locked node_modules for the TypeScript Worker.
COPY --chown=node:node --from=builder /app ./

# The Web process starts one short-lived, restricted Codex container only while
# a project is active. The Docker daemon remains a host concern; this image only
# carries the client used by the Runtime Session Manager. CLI >= 25 routes
# `docker build` through the buildx plugin, so the plugins travel with it.
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker-cli /usr/local/libexec/docker/cli-plugins/ /usr/libexec/docker/cli-plugins/

RUN mkdir -p /app/data /app/logs \
    && touch /app/.env \
    && chown -R node:node /app/data /app/logs /app/.env

COPY --chown=root:root docker-entrypoint.sh /usr/local/bin/waoowaoo-entrypoint
RUN chmod 0755 /usr/local/bin/waoowaoo-entrypoint

EXPOSE 3000

ENTRYPOINT ["/usr/local/bin/waoowaoo-entrypoint"]
CMD ["npm", "run", "start:next"]
