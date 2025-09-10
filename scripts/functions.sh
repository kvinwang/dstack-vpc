
MESH_CONTAINER_NAME="dstack-service-mesh"
VPC_CLIENT_CONTAINER_NAME="dstack-vpc-client"
VPC_API_SERVER_CONTAINER_NAME="dstack-vpc-api-server"
VPC_SERVER_CONTAINER_NAME="dstack-vpc-server"

HEALTHCHECK_SCRIPT="/var/run/dstack-healthcheck.sh"

healthcheck_cmd() {
    local cmd=$1
    cat >$HEALTHCHECK_SCRIPT <<EOF
$cmd || exit 1
EOF
    chmod +x $HEALTHCHECK_SCRIPT
}

healthcheck_cmd_append() {
    local cmd=$1
    cat >>$HEALTHCHECK_SCRIPT <<EOF
$cmd || exit 1
EOF
}

healthcheck() {
    local append=false
    
    # Check for -a flag
    if [ "$1" = "-a" ]; then
        append=true
        shift
    fi
    
    local kind=$1
    local arg=$2
    
    # Build the command based on kind
    case $kind in
        container)
            local cmd="[ \"\$(docker inspect --format='{{.State.Health.Status}}' $arg 2>/dev/null)\" = \"healthy\" ]"
            ;;
        url)
            local cmd="wget --quiet --tries=1 --spider '$arg'"
            ;;
        cmd)
            shift # Remove 'cmd'
            local cmd="$*" # Everything else is the command
            ;;
        *)
            echo "Usage: healthcheck [-a] container|url|cmd <args>"
            return 1
            ;;
    esac
    
    # Use existing functions
    if [ "$append" = true ]; then
        healthcheck_cmd_append "$cmd"
    else
        healthcheck_cmd "$cmd"
    fi
}