#!/bin/bash
set -e

source /scripts/functions.sh

PATH=/scripts:$PATH

detect-env.sh
source /etc/dstack/env

if [ "$LOAD_MISSING_MODULES" != "false" ]; then
    docker rm -f dstack-load-modules 2>/dev/null || true
    docker run --rm --name dstack-load-modules --privileged "$DSTACK_CONTAINER_IMAGE_ID" /scripts/load-modules.sh
fi

if [ "${VPC_SERVER_ENABLED}" == "true" ]; then
    if [ -z "${VPC_ALLOWED_APPS}" ]; then
        echo "ERROR: VPC_ALLOWED_APPS is not set, it is required for VPC server"
        exit 1
    fi
fi

if [ "${VPC_NODE_NAME}" != "" ]; then
    if [ -z "${VPC_SERVER_APP_ID}" ]; then
        echo "ERROR: VPC_SERVER_APP_ID is not set, it is required for VPC node"
        exit 1
    fi
fi

export DSTACK_MESH_BACKEND=${MESH_BACKEND}
export DSTACK_VPC_SERVER_ENABLED=${VPC_SERVER_ENABLED}
export DSTACK_VPC_SERVER_APP_ID=${VPC_SERVER_APP_ID}
export DSTACK_VPC_SERVER_PORT=${VPC_SERVER_PORT:-8080}
export DSTACK_VPC_NODE_NAME=${VPC_NODE_NAME}
export DSTACK_VPC_ALLOWED_APPS=${VPC_ALLOWED_APPS}

mkdir -p /tmp/dstack-service
cd /tmp/dstack-service
echo "Generating docker-compose.yml..."
/scripts/generate-compose.sh > docker-compose.yml
cat docker-compose.yml

socat TCP-LISTEN:80,fork TCP:$MESH_CONTAINER_NAME:80 &

healthcheck url "http://127.0.0.1:80/health"
if [ "${VPC_SERVER_ENABLED}" == "true" ]; then
    healthcheck -a container "${VPC_SERVER_CONTAINER_NAME}"
    healthcheck -a container "${VPC_API_SERVER_CONTAINER_NAME}"
fi
if [ "${VPC_NODE_NAME}" != "" ]; then
    healthcheck -a container "${VPC_CLIENT_CONTAINER_NAME}"
fi

docker compose up --remove-orphans --force-recreate
