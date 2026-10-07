#!/bin/sh
set -eu

mkdir -p /app/data /app/logs
chown -R node:node /app/data /app/logs

# The Docker daemon creates the bind-mounted Runtime directory as root on a
# new host. Make the durable project workspace writable by the Web user while
# keeping broad system paths out of the automatic chown path.
runtime_root=${CODEX_RUNTIME_HOST_ROOT:-}
case "$runtime_root" in
  /*|/)
    case "$runtime_root" in
      /|/bin|/boot|/dev|/etc|/home|/lib|/lib64|/proc|/root|/run|/sbin|/sys|/usr|/var) ;;
      *) mkdir -p "$runtime_root" 2>/dev/null || true; chown node:node "$runtime_root" 2>/dev/null || true ;;
    esac
    ;;
esac

# The Web container is self-bootstrapping.  The first invocation creates a
# one-time setup token and generated secrets; later invocations load the
# encrypted runtime configuration before Next.js imports Prisma or providers.
node /app/scripts/runtime-bootstrap.mjs --init

# Build the short-lived Codex sandbox image ahead of the first Assistant turn.
# This is deliberately best-effort so an unavailable Docker socket cannot make
# the setup page or ordinary Web features unusable.
if [ -f /app/scripts/ensure-codex-runtime-image.mjs ]; then
  node /app/scripts/ensure-codex-runtime-image.mjs || true
fi
chown -R node:node /app/data

docker_socket=/var/run/docker.sock
if [ -S "$docker_socket" ] && command -v stat >/dev/null 2>&1 \
  && command -v getent >/dev/null 2>&1 \
  && command -v groupadd >/dev/null 2>&1 \
  && command -v usermod >/dev/null 2>&1; then
  docker_socket_gid=$(stat -c '%g' "$docker_socket")
  docker_group=$(getent group "$docker_socket_gid" | cut -d: -f1 || true)
  if [ -z "$docker_group" ]; then
    docker_group=wao-docker
    groupadd --gid "$docker_socket_gid" "$docker_group"
  fi
  usermod --append --groups "$docker_group" node
fi

if command -v gosu >/dev/null 2>&1; then
  exec gosu node node /app/scripts/runtime-bootstrap.mjs "$@"
fi
# Debian's base image normally includes `su`; this keeps Web startup usable
# when the optional gosu package could not be downloaded during an offline
# image build.
if command -v su >/dev/null 2>&1; then
  exec su -s /bin/sh node -c 'exec "$@"' sh node /app/scripts/runtime-bootstrap.mjs "$@"
fi
echo "gosu and su are unavailable; starting Web as the image user" >&2
exec node /app/scripts/runtime-bootstrap.mjs "$@"
