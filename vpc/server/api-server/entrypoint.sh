#!/bin/bash
set -e

API_KEY_FILE="/data/api_key"

echo "Waiting for headscale to be ready..."
until docker exec headscale headscale users list >/dev/null 2>&1; do
  echo "Waiting for headscale..."
  sleep 2
done

echo "Creating default user if not exists..."
docker exec headscale headscale users create default 2>/dev/null || true

if [ -f "$API_KEY_FILE" ]; then
  echo "Using existing API key from $API_KEY_FILE"
  API_KEY=$(cat "$API_KEY_FILE")
else
  echo "Generating new API key..."
  API_KEY=$(docker exec headscale headscale apikeys create --expiration 90y)

  if [ -z "$API_KEY" ]; then
    echo "Failed to generate API key"
    exit 1
  fi

  echo "$API_KEY" >"$API_KEY_FILE"
  echo "API key generated and saved to $API_KEY_FILE"
fi

export HEADSCALE_API_KEY="$API_KEY"
exec ./api-server
