#!/bin/sh
set -eu

# Build the project-scoped Codex runtime image before starting Web. The Web
# container only starts short-lived runtime containers on demand; prebuilding
# this image keeps that request path independent from npm/Dockerfile builds.

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH= cd -- "$script_dir/.." && pwd)

runtime_image=${CODEX_RUNTIME_BUILD_IMAGE:-waoowaoo-codex-runtime:local}
runtime_dockerfile=${CODEX_RUNTIME_DOCKERFILE:-Dockerfile.codex-runtime}
runtime_context=${CODEX_RUNTIME_BUILD_CONTEXT:-$repo_root}

case "$runtime_image" in
  ''|*[[:space:]]*)
    echo "CODEX_RUNTIME_BUILD_IMAGE must be a non-empty image reference without whitespace" >&2
    exit 1
    ;;
esac

case "$runtime_dockerfile" in
  /*) dockerfile_path=$runtime_dockerfile ;;
  *) dockerfile_path=$repo_root/$runtime_dockerfile ;;
esac

if [ ! -f "$dockerfile_path" ]; then
  echo "Codex runtime Dockerfile does not exist: $dockerfile_path" >&2
  exit 1
fi

echo "Building Codex runtime image $runtime_image"
docker_build() {
  DOCKER_BUILDKIT="${DOCKER_BUILDKIT:-1}" docker build "$@"
}
if [ -n "${CODEX_CLI_VERSION:-}" ]; then
  docker_build \
    --build-arg "CODEX_CLI_VERSION=$CODEX_CLI_VERSION" \
    --file "$dockerfile_path" \
    --tag "$runtime_image" \
    "$runtime_context"
else
  docker_build \
    --file "$dockerfile_path" \
    --tag "$runtime_image" \
    "$runtime_context"
fi
echo "Codex runtime image is ready: $runtime_image"
