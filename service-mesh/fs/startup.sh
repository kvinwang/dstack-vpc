#!/bin/bash
set -e

if [ -z "$GATEWAY_DOMAIN" ]; then
    for url in $(jq -r '.gateway_urls[]' /dstack/.host-shared/.sys-config.json); do
        echo "Trying gateway URL: $url"
        if GATEWAY_DOMAIN=$(curl -k -s --max-time 10 "$url/prpc/Info" | jq -r '"\(.base_domain):\(.external_port)"' 2>/dev/null) && [ "$GATEWAY_DOMAIN" != "null:null" ] && [ -n "$GATEWAY_DOMAIN" ]; then
            echo "Successfully connected to gateway: $GATEWAY_DOMAIN"
            break
        else
            echo "Failed to connect to $url"
            GATEWAY_DOMAIN=""
        fi
    done
fi

if [ -z "$GATEWAY_DOMAIN" ]; then
    echo "ERROR: Could not connect to any gateway URL"
    exit 1
fi

cat >/etc/dstack/dstack-mesh.toml <<EOF
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
if ! curl -s --unix-socket /var/run/dstack.sock 'http://localhost/GetTlsKey?subject=localhost&usage_server_auth=true&usage_client_auth=true' >/tmp/server_response.json; then
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

if [ "$LOAD_MISSING_MODULES" = "yes" ]; then
    echo "Loaded netfilter modules:"
    lsmod | grep -E "(nf_|xt_|x_tables)" | awk '{print $1}' | sort
    echo "Loading netfilter kernel modules..."
    MODULES=(
        "xt_mark"
        "xt_connmark"
    )
    for module in "${MODULES[@]}"; do
        echo "Loading module: $module"
        if insmod /lib/extra-modules/$module.ko 2>/dev/null; then
            echo "Successfully loaded: $module"
        else
            echo "Failed to load module: $module (may already be loaded, built-in, or unavailable)"
        fi
    done

    echo "Module loading completed."
fi

echo "GATEWAY_DOMAIN=$GATEWAY_DOMAIN"
echo "BACKEND: ${BACKEND}"

if [ -z "$BACKEND" ]; then
    rm -rf /etc/nginx/conf.d/server-proxy.conf || true
else
    envsubst '${BACKEND}' < /etc/nginx/templates/server-proxy.conf.template > /etc/nginx/conf.d/server-proxy.conf
fi

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
