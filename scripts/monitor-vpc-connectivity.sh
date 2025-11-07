#!/bin/bash
# Monitor VPC node connectivity and generate metrics
set -e

METRICS_FILE="${METRICS_FILE:-/shared/vpc_connectivity_metrics.txt}"
LOG_PREFIX="[VPC Connectivity Monitor]"
PING_TIMEOUT="${PING_TIMEOUT:-2}"
PING_COUNT="${PING_COUNT:-3}"
CHECK_INTERVAL="${CHECK_INTERVAL:-60}"
VPC_CLIENT_CONTAINER="${VPC_CLIENT_CONTAINER:-dstack-vpc-client}"

log() {
	echo "$LOG_PREFIX $*"
}

check_node_offline() {
	# Check if this node has been replaced by checking Self.Active and InEngine status
	# A replaced node will have Active=false, InMagicSock=false, InEngine=false
	local status_json=$(docker exec "$VPC_CLIENT_CONTAINER" tailscale status --json 2>/dev/null)
	local backend_state=$(echo "$status_json" | jq -r '.BackendState // "unknown"')
	local self_active=$(echo "$status_json" | jq -r '.Self.Active // false')
	local in_engine=$(echo "$status_json" | jq -r '.Self.InEngine // false')
	local in_magicsock=$(echo "$status_json" | jq -r '.Self.InMagicSock // false')
	local machine_key=$(echo "$status_json" | jq -r '.Self.PublicKey // "unknown"')
	local hostname=$(echo "$status_json" | jq -r '.Self.HostName // "unknown"')
	local ip=$(echo "$status_json" | jq -r '.Self.TailscaleIPs[0] // "unknown"')

	# Check if node is inactive (likely replaced)
	if [ "$backend_state" = "Running" ] && [ "$self_active" = "false" ] && [ "$in_engine" = "false" ]; then
		log "⚠️  CRITICAL: Node is inactive!"
		log "   Backend State: $backend_state"
		log "   Self.Active: $self_active"
		log "   Self.InEngine: $in_engine"
		log "   Self.InMagicSock: $in_magicsock"
	fi

	# Check for other abnormal states
	if [ "$backend_state" != "Running" ]; then
		log "⚠️  WARNING: Node is not in Running state!"
		log "   Backend State: $backend_state"
		log "   Action: Check Tailscale/Headscale connectivity"
	fi
}

print_node_info() {
	# Print current node information at startup
	local machine_key=$(docker exec "$VPC_CLIENT_CONTAINER" tailscale status --json 2>/dev/null | jq -r '.Self.PublicKey // "unknown"')
	local hostname=$(docker exec "$VPC_CLIENT_CONTAINER" tailscale status --json 2>/dev/null | jq -r '.Self.HostName // "unknown"')
	local ip=$(docker exec "$VPC_CLIENT_CONTAINER" tailscale status --json 2>/dev/null | jq -r '.Self.TailscaleIPs[0] // "unknown"')

	log "Node Information:"
	log "   Hostname: $hostname"
	log "   IP: $ip"
	log "   Machine Key: $machine_key"
}

get_node_list() {
	# Get all nodes from tailscale status via docker exec
	# Return hostname only (will be resolved via DNS)
	docker exec "$VPC_CLIENT_CONTAINER" tailscale status --json 2>/dev/null | jq -r '.Peer[] | select(.HostName != "") | .HostName' 2>/dev/null || echo ""
}

ping_node() {
	local hostname="$1"
	local count="$2"
	local timeout="$3"

	# Try native ping using hostname
	if ping -c "$count" -W "$timeout" "$hostname" >/dev/null 2>&1; then
		echo "success"
	else
		echo "failed"
	fi
}

tailscale_ping_node() {
	local hostname="$1"

	# Try tailscale ping via docker exec using hostname
	if docker exec "$VPC_CLIENT_CONTAINER" tailscale ping --c 3 --timeout 2s "$hostname" >/dev/null 2>&1; then
		echo "success"
	else
		echo "failed"
	fi
}

run_network_diagnostics() {
	log "All nodes failed ping test, running network diagnostics..."

	# Get tailscale status via docker exec
	log "Tailscale status:"
	docker exec "$VPC_CLIENT_CONTAINER" tailscale status

	# Get tailscale netcheck
	log "Network check results:"
	docker exec "$VPC_CLIENT_CONTAINER" tailscale netcheck

	# Get route information from VPC client container
	log "Route information:"
	docker exec "$VPC_CLIENT_CONTAINER" ip route show

	# Check if tailscaled is running properly
	log "Tailscale debug info:"
	docker exec "$VPC_CLIENT_CONTAINER" tailscale debug prefs
}

write_metrics() {
	local success_count="$1"
	local failed_count="$2"
	local total_count="$3"
	local timestamp="$4"

	# Write Prometheus-style metrics
	cat >"$METRICS_FILE" <<EOF
# HELP vpc_node_connectivity_success Number of nodes successfully pinged
# TYPE vpc_node_connectivity_success gauge
vpc_node_connectivity_success $success_count

# HELP vpc_node_connectivity_failed Number of nodes that failed ping
# TYPE vpc_node_connectivity_failed gauge
vpc_node_connectivity_failed $failed_count

# HELP vpc_node_connectivity_total Total number of nodes checked
# TYPE vpc_node_connectivity_total gauge
vpc_node_connectivity_total $total_count

# HELP vpc_node_connectivity_last_check_timestamp Unix timestamp of last check
# TYPE vpc_node_connectivity_last_check_timestamp gauge
vpc_node_connectivity_last_check_timestamp $timestamp
EOF
}

log "Starting VPC connectivity monitor..."

# Wait for VPC client container to be ready
log "Waiting for VPC client container to be ready..."
until docker exec "$VPC_CLIENT_CONTAINER" tailscale status >/dev/null 2>&1; do
	log "Waiting for VPC client container and Tailscale..."
	sleep 5
done
log "VPC client container and Tailscale are ready"

# Main monitoring loop
while true; do
	# Print node info at startup
	print_node_info

	check_node_offline

	log "Starting connectivity check..."

	node_list=$(get_node_list)

	if [ -z "$node_list" ]; then
		log "No nodes found in VPC network"
		write_metrics 0 0 0 "$(date +%s)"
		sleep "$CHECK_INTERVAL"
		continue
	fi

	success_count=0
	failed_count=0
	total_count=0

	# Use process substitution to avoid subshell issue with pipe
	while read -r hostname; do
		if [ -z "$hostname" ]; then
			continue
		fi

		total_count=$((total_count + 1))

		log "Checking node: $hostname"

		# Try native ping first using hostname
		result=$(ping_node "$hostname" "$PING_COUNT" "$PING_TIMEOUT")

		if [ "$result" = "success" ]; then
			log "  ✓ Native ping successful: $hostname"
			success_count=$((success_count + 1))
		else
			log "  ✗ Native ping failed: $hostname"

			# Try tailscale ping as fallback (for logging only)
			ts_result=$(tailscale_ping_node "$hostname")
			if [ "$ts_result" = "success" ]; then
				log "  ℹ Tailscale ping successful (but native failed): $hostname"
			else
				log "  ✗ Tailscale ping also failed: $hostname"
			fi

			failed_count=$((failed_count + 1))
		fi
	done <<< "$node_list"

	log "Connectivity check complete: $success_count/$total_count nodes reachable (failed: $failed_count)"

	# Write metrics
	timestamp=$(date +%s)
	write_metrics "$success_count" "$failed_count" "$total_count" "$timestamp"

	# If all nodes failed, run diagnostics
	if [ "$failed_count" -eq "$total_count" ] && [ "$total_count" -gt 0 ]; then
		run_network_diagnostics
	fi

	log "Next check in ${CHECK_INTERVAL} seconds"
	sleep "$CHECK_INTERVAL"
done
