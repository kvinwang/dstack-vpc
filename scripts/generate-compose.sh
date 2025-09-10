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
    restart: unless-stopped
    ports:
      - "443:443"
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
  dstack-vpc-server:
    image: headscale/headscale@sha256:404e3251f14f080e99093e8855a4a70062271ac7111153eb02a1f879f9f200c8
    container_name: dstack-vpc-server
    restart: unless-stopped
    ports:
      - "8080:8080"
    volumes:
      - vpc_server_data:/var/lib/headscale
      - /dstack/.dstack-service/headscale_config.yaml:/etc/headscale/config.yaml
    command: serve
    healthcheck:
      test: ["CMD", "headscale", "users", "list"]
    networks:
      - project
  dstack-vpc-api-server:
    image: ${DSTACK_CONTAINER_IMAGE_ID}
    restart: unless-stopped
    environment:
      - ALLOWED_APPS=${DSTACK_VPC_ALLOWED_APPS}
      - PORT=8000
      - GIN_MODE=release
      - VPC_SERVER_CONTAINER_NAME=dstack-vpc-server
      - DSTACK_MESH_CONTAINER_NAME=${MESH_CONTAINER_NAME}
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - vpc_api_server_data:/data
    command: /scripts/vpc-server-entry.sh
    depends_on:
      - dstack-vpc-server
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
  dstack-vpc-client:
    image: tailscale/tailscale@sha256:5bbcf89bb34fd477cae8ff516bddb679023f7322f1e959c0714d07c622444bb4
    restart: unless-stopped
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
      - /dstack/.dstack-service/vpc-node-entry.sh:/vpc-node-entry.sh
    environment:
      - NODE_NAME=${DSTACK_VPC_NODE_NAME}
      - TUN_DEV_NAME=tailscale1
    command: /vpc-node-entry.sh
    healthcheck:
      test: ["CMD", "tailscale", "status"]
    depends_on:
      vpc-node-setup:
        condition: service_completed_successfully
EOF
}

cat <<EOF
services:
$(gen-dstack-mesh)
$(gen-vpc-server)
$(gen-vpc-client)
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