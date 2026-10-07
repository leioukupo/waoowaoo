#!/bin/sh
set -eu

mkdir -p /app/.next /app/data /app/logs
chown node:node /app/.next /app/data /app/logs

# The dependencies volume is seeded from the root-owned image layer. Prisma
# regenerates only its own client directories during schema initialization;
# keep the rest of node_modules immutable to the unprivileged dev process.
for prisma_directory in /app/node_modules/.prisma /app/node_modules/@prisma/client; do
  if [ -e "$prisma_directory" ]; then
    chown -R node:node "$prisma_directory"
  fi
done

runtime_root=${CODEX_RUNTIME_HOST_ROOT:-}
if [ -n "$runtime_root" ]; then
  case "$runtime_root" in
    /*) ;;
    *) echo "CODEX_RUNTIME_HOST_ROOT must be an absolute path" >&2; exit 1 ;;
  esac
  mkdir -p "$runtime_root"
  chown node:node "$runtime_root"
fi

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
  exec gosu node "$@"
fi
if command -v su >/dev/null 2>&1; then
  exec su -s /bin/sh node -c 'exec "$@"' sh "$@"
fi
echo "gosu and su are unavailable; starting development Web as the image user" >&2
exec "$@"
