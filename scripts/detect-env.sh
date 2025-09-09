#!/bin/bash

get_container_id() {
    if [ -f /proc/1/cgroup ]; then
        grep -o 'docker/[^/]*' /proc/1/cgroup | head -1 | cut -d'/' -f2
    fi
}

DSTACK_CONTAINER_ID=$(get_container_id)
DSTACK_CONTAINER_IMAGE_ID=$(docker inspect $DSTACK_CONTAINER_ID --format='{{.Image}}')
SYS_CONFIG=$(docker run --rm --name dstack-get-syscfg -v /dstack:/dstack $DSTACK_CONTAINER_IMAGE_ID cat /dstack/.host-shared/.sys-config.json 2>/dev/null)

if [ -z "$DSTACK_GATEWAY_DOMAIN" ]; then
    for url in $(jq -r '.gateway_urls[]' <<< "$SYS_CONFIG"); do
        echo "Trying gateway URL: $url"
        if DSTACK_GATEWAY_DOMAIN=$(curl -k -s --max-time 10 --retry 2 --retry-delay 1 --retry-max-time 30 "$url/prpc/Info" | jq -r '"\(.base_domain):\(.external_port)"' 2>/dev/null) && [ "$DSTACK_GATEWAY_DOMAIN" != "null:null" ] && [ -n "$DSTACK_GATEWAY_DOMAIN" ]; then
            echo "Successfully connected to gateway: $DSTACK_GATEWAY_DOMAIN"
            break
        else
            echo "Failed to connect to $url"
            DSTACK_GATEWAY_DOMAIN=""
        fi
    done
fi

if [ -z "$DSTACK_GATEWAY_DOMAIN" ]; then
    echo "ERROR: Could not connect to any gateway URL"
    exit 1
fi

DSTACK_COMPOSE_PROJECT=$(docker inspect $DSTACK_CONTAINER_ID --format='{{index .Config.Labels "com.docker.compose.project"}}')
DSTACK_CONTAINER_NETWORK=$(docker inspect $DSTACK_CONTAINER_ID --format='{{range $k, $v := .NetworkSettings.Networks}}{{$k}}{{end}}')
DSTACK_SERVICE_NAME=$(docker inspect $DSTACK_CONTAINER_ID --format='{{index .Config.Labels "com.docker.compose.service"}}')

mkdir -p /etc/dstack
cat >/etc/dstack/env <<EOF
export DSTACK_GATEWAY_DOMAIN=$DSTACK_GATEWAY_DOMAIN
export DSTACK_CONTAINER_ID=$DSTACK_CONTAINER_ID
export DSTACK_CONTAINER_NETWORK=$DSTACK_CONTAINER_NETWORK
export DSTACK_CONTAINER_IMAGE_ID=$DSTACK_CONTAINER_IMAGE_ID
export DSTACK_COMPOSE_PROJECT=$DSTACK_COMPOSE_PROJECT
export DSTACK_SERVICE_NAME=$DSTACK_SERVICE_NAME
EOF
cat /etc/dstack/env

docker run --rm --name dstack-copy-files -d -v /dstack:/dstack $DSTACK_CONTAINER_IMAGE_ID \
    sh -c "mkdir -p /dstack/.dstack-service && tail -f /dev/null"
docker cp /etc/dstack/env dstack-copy-files:/dstack/.dstack-service/env
docker cp /etc/headscale/config.yaml dstack-copy-files:/dstack/.dstack-service/headscale_config.yaml
docker cp /scripts/vpc-node-entry.sh dstack-copy-files:/dstack/.dstack-service/vpc-node-entry.sh
docker rm -f dstack-copy-files
