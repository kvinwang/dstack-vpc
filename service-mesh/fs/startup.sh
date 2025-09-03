#!/bin/bash
set -e

GATEWAY_DOMAIN=$(curl -k -s $(jq -r '.gateway_urls[0]' /dstack/.host-shared/.sys-config.json)/prpc/Info | jq -r '"\(.base_domain):\(.external_port)"')
# TODO: remove fixed
GATEWAY_DOMAIN=${GATEWAY_DOMAIN:-fixed/127.0.0.1:443}
echo "GATEWAY_DOMAIN=$GATEWAY_DOMAIN"
echo "BACKEND: ${BACKEND}"

echo "Using nginx configuration..."
envsubst '${BACKEND}' < /etc/nginx/nginx.conf.template > /etc/nginx/nginx.conf

cat > /etc/dstack/dstack-mesh.toml <<EOF
[client]
address = "0.0.0.0"
port = 8091

[auth]
address = "0.0.0.0"
port = 8092

[agent]
socket = "/var/run/dstack.sock"
gateway_domain = "${GATEWAY_DOMAIN}"

[tls]
cert_file = "/etc/ssl/certs/server.crt"
key_file = "/etc/ssl/private/server.key"
ca_file = "/etc/ssl/certs/ca.crt"
EOF

echo "Generating server certificate using dstack.sock HTTP API..."
if ! curl -s --unix-socket /var/run/dstack.sock 'http://localhost/GetTlsKey?subject=localhost&usage_server_auth=true&usage_client_auth=true' > /tmp/server_response.json; then
    echo "Failed to generate certificates - dstack.sock may not be available"
    exit 1
fi

echo "Extracting server key and certificates..."
jq -r '.key' /tmp/server_response.json > /etc/ssl/private/server.key
jq -r '.certificate_chain[]' /tmp/server_response.json > /etc/ssl/certs/server.crt
jq -r '.certificate_chain[-1]' /tmp/server_response.json > /etc/ssl/certs/ca.crt

echo "Setting file permissions..."
chmod 644 /etc/ssl/private/server.key /etc/ssl/certs/server.crt /etc/ssl/certs/ca.crt

echo "Certificate generation completed!"
rm -f /tmp/server_response.json

echo "Starting supervisor to manage all services..."
exec /usr/bin/supervisord -c /etc/supervisor/conf.d/supervisord.conf