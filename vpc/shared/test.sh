#!/bin/bash
set -e

echo "Testing VPC Phase 1 implementation (Go)..."

cd vpc-server
echo "Starting headscale server..."
docker-compose up -d

echo "Waiting for services to start..."
sleep 20

# Wait for headscale to be ready
echo "Waiting for headscale API..."
until curl -s http://localhost:8080/health >/dev/null 2>&1; do
  sleep 2
done

# Create default user
echo "Creating headscale user..."
docker exec headscale headscale --config /etc/headscale/config.yaml users create default || true

echo "Testing service mesh..."
until curl -s http://localhost:80/health >/dev/null 2>&1; do
  sleep 2
done
echo "Service mesh is ready"

echo "Testing API server through mesh..."
until curl -s http://localhost:8000/health >/dev/null 2>&1; do
  sleep 2
done
echo "API server is ready"

# Test bootstrap endpoint directly (bypassing service mesh for testing)
echo "Testing bootstrap endpoint directly..."
echo "Docker-compose explicitly sets ALLOWED_APPS=any, testing with any app-id..."
curl -H "x-dstack-app-id: test-app-123" \
  "http://localhost:8000/api/bootstrap?instance_id=instance0&node_type=mongodb&node_name=mongo-0"

echo ""
echo "Testing nodes endpoint (no auth required)..."
curl "http://localhost:8000/api/nodes?node_type=mongodb"

cd ../vpc-node
echo "Testing bootstrap agent..."
INSTANCE_UUID=test-node NODE_NAME=test-mongo HEADSCALE_DOMAIN=localhost:8091 docker-compose run --rm bootstrap-agent

echo "Phase 1 test completed successfully"

curl -X POST http://headscale:8080/api/v1/preauthkey -H 'Content-Type: application/json' -H 'Authorization: Bearer qmnf0qD.K2FfCeBJqM1F6x8RL4EJSSRNNVrNekl6' -d '{"user":"1","reusable":true,"ephemeral":false,"expiration":"2025-09-04T15:47:30Z"}'
