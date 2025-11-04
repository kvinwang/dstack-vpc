#!/bin/bash
source /scripts/functions.sh
healthcheck url "http://127.0.0.1:80/health"

source /etc/dstack/env

DSTACK_MESH_SERVER_NAME=${DSTACK_MESH_SERVER_NAME:-_}

cat <<EOF > /etc/dstack/dstack-mesh.toml
[client]
enabled = true
address = "0.0.0.0"
port = 8091

[auth]
enabled = true
address = "0.0.0.0"
port = 8092

[dstack]
gateway_domain = "${DSTACK_GATEWAY_DOMAIN}"

[tls]
cert_file = "/etc/ssl/certs/server.crt"
key_file = "/etc/ssl/private/server.key"
ca_file = "/etc/ssl/certs/ca.crt"
EOF

echo "Generating server certificate using dstack.sock HTTP API..."
CERT_URL='http://localhost/GetTlsKey?subject=localhost&usage_server_auth=true&usage_client_auth=true'

docker rm -f dstack-get-tls-key 2>/dev/null || true
if ! docker run --rm --name dstack-get-tls-key -v /var/run/dstack.sock:/var/run/dstack.sock $DSTACK_CONTAINER_IMAGE_ID \
    curl -s --unix-socket /var/run/dstack.sock $CERT_URL >/tmp/server_response.json;
then
    echo "Failed to generate certificates - dstack.sock may not be available"
    exit 1
fi

echo "Extracting server key and certificates..."
jq -r '.key' /tmp/server_response.json >/etc/ssl/private/server.key
jq -r '.certificate_chain[]' /tmp/server_response.json >/etc/ssl/certs/server.crt
jq -r '.certificate_chain[-1]' /tmp/server_response.json >/etc/ssl/certs/ca.crt

echo "Setting file permissions..."
chmod 644 /etc/ssl/private/server.key /etc/ssl/certs/server.crt /etc/ssl/certs/ca.crt

echo "Certificate generation completed!"
rm -f /tmp/server_response.json

echo "DSTACK_GATEWAY_DOMAIN=$DSTACK_GATEWAY_DOMAIN"
echo "DSTACK_MESH_BACKEND: ${DSTACK_MESH_BACKEND}"

render_config() {
    local config_name=$1
    local backend=$2
    local server_name=$3
    local config_file="/etc/nginx/conf.d/${config_name}.conf"

    if [ -z "$backend" ]; then
        rm -rf "$config_file" || true
    else
        BACKEND="$backend" \
        SERVER_NAME="$server_name" \
            envsubst '${BACKEND} ${SERVER_NAME}' < /etc/nginx/templates/server-proxy.conf.template > "$config_file"

        echo "${config_name}.conf:"
        cat "$config_file"
    fi
}

render_config "backend" "$DSTACK_MESH_BACKEND" "$DSTACK_MESH_SERVER_NAME"
render_config "vpc-server" "$DSTACK_VPC_SERVER_API" "$DSTACK_VPC_SERVER_NAME"

echo "Testing nginx configuration..."
if nginx -t 2>/dev/null; then
    echo "Nginx configuration is valid"
else
    echo "ERROR: Nginx configuration test failed!"
    nginx -t
    exit 1
fi


echo "Starting supervisor to manage all services..."
exec /usr/bin/supervisord -c /etc/supervisor/conf.d/supervisord.conf