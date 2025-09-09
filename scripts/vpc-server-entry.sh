#!/bin/bash
set -e

source /scripts/functions.sh

API_KEY_FILE="/data/api_key"

ensure_env_exists() {
  if [ -z "${!1}" ]; then
    echo "ERROR: $1 is not set, it is required for VPC server"
    exit 1
  fi
}

ensure_env_exists "DSTACK_MESH_CONTAINER_NAME"
ensure_env_exists "VPC_SERVER_CONTAINER_NAME"

HS="${VPC_SERVER_CONTAINER_NAME:-dstack-vpc-server}"

echo "Waiting for headscale to be ready..."
until docker exec $HS headscale users list >/dev/null 2>&1; do
  echo "Waiting for headscale..."
  sleep 2
done

echo "Creating default user if not exists..."
docker exec $HS headscale users create default 2>/dev/null || true

if [ -f "$API_KEY_FILE" ]; then
  echo "Using existing API key from $API_KEY_FILE"
  API_KEY=$(cat "$API_KEY_FILE")
else
  echo "Generating new API key..."
  API_KEY=$(docker exec $HS headscale apikeys create --expiration 90y)

  if [ -z "$API_KEY" ]; then
    echo "Failed to generate API key"
    exit 1
  fi

  echo "$API_KEY" >"$API_KEY_FILE"
  echo "API key generated and saved to $API_KEY_FILE"
fi

export HEADSCALE_API_KEY="$API_KEY"
export HEADSCALE_INTERNAL_URL="http://${HS}:8080"
export DSTACK_MESH_URL="http://${DSTACK_MESH_CONTAINER_NAME}"

healthcheck_url "http://127.0.0.1:$PORT/health"
exec vpc-api-server
