#!/bin/bash
source /scripts/functions.sh

gen-dstack-mesh() {
  if [ "${DSTACK_VPC_SERVER_ENABLED}" == "true" ]; then
    DSTACK_VPC_SERVER_API="dstack-vpc-api-server:8000"
    DSTACK_VPC_SERVER_NAME="dstack-vpc-server"
  else
    DSTACK_VPC_SERVER_API=""
    DSTACK_VPC_SERVER_NAME=""
  fi
  cat <<EOF
  $MESH_CONTAINER_NAME:
    image: ${DSTACK_CONTAINER_IMAGE_ID}
    container_name: ${MESH_CONTAINER_NAME}
    restart: on-failure
    ports:
      - "8089:443"
    volumes:
      - /var/run/dstack.sock:/var/run/dstack.sock
      - /var/run/docker.sock:/var/run/docker.sock
      - /dstack/.dstack-service:/etc/dstack
      - vpc_shared:/vpc/0:ro
    privileged: true
    environment:
      - DSTACK_MESH_BACKEND=${DSTACK_MESH_BACKEND}
      - DSTACK_VPC_SERVER_API=${DSTACK_VPC_SERVER_API}
      - DSTACK_VPC_SERVER_NAME=${DSTACK_VPC_SERVER_NAME}
      - RUST_LOG=error
    networks:
      - project
    command: /scripts/mesh-serve.sh
EOF
}

gen-vpc-server() {
  if [ "${DSTACK_VPC_SERVER_ENABLED}" != "true" ]; then
    return
  fi
  cat <<EOF
  $VPC_SERVER_CONTAINER_NAME:
    image: $DSTACK_CONTAINER_IMAGE_ID
    container_name: $VPC_SERVER_CONTAINER_NAME
    restart: on-failure
    ports:
      - "8080:8080"
    volumes:
      - vpc_server_data:/var/lib/headscale
      - /dstack/.dstack-service/headscale:/etc/headscale
    command: headscale serve
    healthcheck:
      test: ["CMD", "headscale", "users", "list"]
    networks:
      - project
  $VPC_API_SERVER_CONTAINER_NAME:
    image: $DSTACK_CONTAINER_IMAGE_ID
    container_name: $VPC_API_SERVER_CONTAINER_NAME
    restart: on-failure
    environment:
      - ALLOWED_APPS=${DSTACK_VPC_ALLOWED_APPS}
      - PORT=8000
      - GIN_MODE=release
      - VPC_SERVER_CONTAINER_NAME=$VPC_SERVER_CONTAINER_NAME
      - DSTACK_MESH_CONTAINER_NAME=$MESH_CONTAINER_NAME
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - vpc_api_server_data:/data
    command: /scripts/vpc-server-entry.sh
    depends_on:
      - $VPC_SERVER_CONTAINER_NAME
    networks:
      - project
  headscale-monitor:
    image: $DSTACK_CONTAINER_IMAGE_ID
    container_name: dstack-headscale-monitor
    restart: on-failure
    logging:
      driver: "json-file"
      options:
        max-size: "10m"
        max-file: "3"
    environment:
      - VPC_SERVER_CONTAINER_NAME=$VPC_SERVER_CONTAINER_NAME
      - MONITOR_INTERVAL=10
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
    command: /scripts/monitor-headscale.sh
    depends_on:
      - $VPC_SERVER_CONTAINER_NAME
    networks:
      - project
EOF
}

gen-vpc-client() {
  if [ -z "${DSTACK_VPC_NODE_NAME}" ]; then
    return
  fi
  cat <<EOF
  vpc-node-setup:
    image: ${DSTACK_CONTAINER_IMAGE_ID}
    environment:
      - NODE_NAME=${DSTACK_VPC_NODE_NAME}
      - VPC_SERVER_APP_ID=${DSTACK_VPC_SERVER_APP_ID}
      - DSTACK_MESH_URL=http://${MESH_CONTAINER_NAME}
    command: /scripts/vpc-node-setup.sh
    restart: "no"
    volumes:
      - vpc_shared:/shared
    depends_on:
      ${MESH_CONTAINER_NAME}:
        condition: service_healthy
    networks:
      - project
  $VPC_CLIENT_CONTAINER_NAME:
    image: tailscale/tailscale@sha256:5bbcf89bb34fd477cae8ff516bddb679023f7322f1e959c0714d07c622444bb4
    container_name: $VPC_CLIENT_CONTAINER_NAME
    restart: on-failure
    cap_add:
      - NET_ADMIN
      - SYS_MODULE
    devices:
      - /dev/net/tun:/dev/net/tun
    network_mode: host
    volumes:
      - vpc_shared:/shared:ro
      - vpc_node_data:/var/lib/tailscale
      - /var/run:/var/run
      - /dstack:/dstack
    environment:
      - NODE_NAME=${DSTACK_VPC_NODE_NAME}
      - TUN_DEV_NAME=tailscale1
    command: /dstack/.dstack-service/vpc-node-entry.sh
    healthcheck:
      test: ["CMD", "tailscale", "status"]
    depends_on:
      vpc-node-setup:
        condition: service_completed_successfully
  vpc-connectivity-monitor:
    image: ${DSTACK_CONTAINER_IMAGE_ID}
    container_name: dstack-vpc-connectivity-monitor
    restart: on-failure
    logging:
      driver: "json-file"
      options:
        max-size: "10m"
        max-file: "3"
    volumes:
      - vpc_shared:/shared
      - /var/run/docker.sock:/var/run/docker.sock
    environment:
      - METRICS_FILE=/shared/vpc_connectivity_metrics.txt
      - CHECK_INTERVAL=60
      - PING_TIMEOUT=2
      - PING_COUNT=3
      - VPC_CLIENT_CONTAINER=$VPC_CLIENT_CONTAINER_NAME
    dns:
      - 100.100.100.100
    dns_search:
      - dstack.internal
    command: /scripts/monitor-vpc-connectivity.sh
    networks:
      - project
EOF
}

gen-metrics-aggregator() {
  if [ "${DSTACK_VPC_METRICS_ENABLED}" != "true" ]; then
    return
  fi

  # Determine role based on what's enabled
  role="both"
  if [ "${DSTACK_VPC_SERVER_ENABLED}" = "true" ] && [ -z "${DSTACK_VPC_NODE_NAME}" ]; then
    role="server"
  elif [ "${DSTACK_VPC_SERVER_ENABLED}" != "true" ] && [ -n "${DSTACK_VPC_NODE_NAME}" ]; then
    role="client"
  fi

  # Build depends_on section
  depends_on=""
  if [ "$role" = "server" ] || [ "$role" = "both" ]; then
    depends_on="$depends_on
      $VPC_SERVER_CONTAINER_NAME:
        condition: service_healthy"
  fi
  if [ "$role" = "client" ] || [ "$role" = "both" ]; then
    depends_on="$depends_on
      $VPC_CLIENT_CONTAINER_NAME:
        condition: service_healthy"
  fi

  cat <<EOF
  metrics-aggregator:
    image: ${DSTACK_CONTAINER_IMAGE_ID}
    container_name: dstack-metrics-aggregator
    restart: on-failure
    ports:
      - "9090:9090"
    volumes:
      - vpc_shared:/shared:ro
      - /var/run/docker.sock:/var/run/docker.sock
    environment:
      - METRICS_PORT=9090
      - ROLE=$role
      - VPC_SERVER_CONTAINER=$VPC_SERVER_CONTAINER_NAME
      - VPC_CLIENT_CONTAINER=$VPC_CLIENT_CONTAINER_NAME
      - PING_METRICS_FILE=/shared/vpc_connectivity_metrics.txt
    command: node /scripts/metrics-aggregator.js
    depends_on:$depends_on
    networks:
      - project
EOF
}

cat <<EOF
services:
$(gen-dstack-mesh)
$(gen-vpc-server)
$(gen-vpc-client)
$(gen-metrics-aggregator)
volumes:
  vpc_server_data:
  vpc_api_server_data:
  vpc_shared:
  vpc_node_data:
networks:
  project:
    name: ${DSTACK_CONTAINER_NETWORK}
    external: true
EOF