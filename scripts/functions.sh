
MESH_CONTAINER_NAME="dstack-service-mesh"

healthcheck_cmd() {
    local cmd=$1
    cat >/var/run/dstack-healthcheck.sh <<EOF
$cmd || exit 1
EOF
    chmod +x /var/run/dstack-healthcheck.sh
}

healthcheck_url() {
    local url=$1
    healthcheck_cmd "wget --quiet --tries=1 $url"
}
