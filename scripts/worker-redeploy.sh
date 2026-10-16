#!/bin/sh
# Re-deploy the web-only Temporal worker after rebuilding waoowaoo-web:local:
#   1. derives a new immutable build ID from the image digest,
#   2. updates TEMPORAL_WORKER_BUILD_ID in .env,
#   3. recreates the compose-managed worker (registers the new build),
#   4. promotes the new build as the deployment's current version so new
#      workflow executions route to it.
# Usage: sh scripts/worker-redeploy.sh [image]
set -eu

image=${1:-waoowaoo-web:local}
project_dir=$(cd "$(dirname "$0")/.." && pwd)
env_file=$project_dir/.env
deployment_name=${TEMPORAL_WORKER_DEPLOYMENT_NAME:-waoowaoo}
namespace=${TEMPORAL_NAMESPACE:-waoowaoo}
temporal_address=${TEMPORAL_ADDRESS:-127.0.0.1:7233}

new_build_id=$(docker image inspect "$image" --format '{{.Id}}' | cut -c8-21)
case "$new_build_id" in
  *[!0-9a-f]*|'') echo "cannot derive a build ID from image $image" >&2; exit 1 ;;
esac
echo "new worker build ID: $new_build_id (from $image)"

if [ -f "$env_file" ] && grep -q '^TEMPORAL_WORKER_BUILD_ID=' "$env_file"; then
  sed -i "s/^TEMPORAL_WORKER_BUILD_ID=.*/TEMPORAL_WORKER_BUILD_ID=$new_build_id/" "$env_file"
else
  { [ -f "$env_file" ] || touch "$env_file"
    echo "TEMPORAL_WORKER_BUILD_ID=$new_build_id" >> "$env_file"; }
fi

cd "$project_dir"
docker compose -f docker-compose.yml -f docker-compose.web.yml up -d worker

echo "waiting for the worker to register build ID $new_build_id ..."
attempt=1
while [ "$attempt" -le 60 ]; do
  registered=$(
    docker run --rm --network host temporalio/admin-tools:1.31.2 \
      temporal worker deployment describe --name "$deployment_name" \
      --namespace "$namespace" --address "$temporal_address" -o json 2>/dev/null \
      | python3 -c 'import json,sys
d=json.load(sys.stdin)
print(any(v.get("BuildID") == sys.argv[1] for v in d.get("versionSummaries", [])))' "$new_build_id" || true
  )
  if [ "$registered" = "True" ]; then
    break
  fi
  attempt=$((attempt + 1))
  [ "$attempt" -le 60 ] && sleep 2
done
if [ "$registered" != "True" ]; then
  echo "the worker did not register the new build ID in time; check: docker logs waoowaoo-worker" >&2
  exit 1
fi

docker run --rm --network host temporalio/admin-tools:1.31.2 \
  temporal worker deployment set-current-version \
  --deployment-name "$deployment_name" --build-id "$new_build_id" \
  --namespace "$namespace" --address "$temporal_address" -y

echo "done: deployment '$deployment_name' now runs build ID $new_build_id"
