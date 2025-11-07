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

diagnose_node_replacement() {
	# Check if node was replaced by comparing local vs Headscale node keys
	local status_json=$(docker exec "$VPC_CLIENT_CONTAINER" tailscale status --json 2>/dev/null)
	local headscale_node_key=$(echo "$status_json" | jq -r '.Self.PublicKey // "unknown"')

	# Extract local private key from state file
	local state_json=$(docker exec "$VPC_CLIENT_CONTAINER" cat /var/lib/tailscale/tailscaled.state 2>/dev/null)
	local current_profile=$(echo "$state_json" | jq -r '."_current-profile"' | base64 -d 2>/dev/null)
	local local_private_key=$(echo "$state_json" | jq -r ".\"$current_profile\"" 2>/dev/null | base64 -d 2>/dev/null | jq -r '.Config.PrivateNodeKey // "unknown"' 2>/dev/null)

	# Compute public key from local private key
	local computed_public_key=$(echo "$local_private_key" | python3 /scripts/compute-pubkey.py 2>/dev/null || echo "unknown")

	log ""
	log "=== Node Replacement Check ==="
	log "Headscale node key: $headscale_node_key"
	log "Computed local key: $computed_public_key"

	# Compare keys
	if [ "$computed_public_key" != "unknown" ] && [ "$computed_public_key" != "$headscale_node_key" ]; then
		log ""
		log "⚠️  CRITICAL: Node replacement detected!"
		log "Local node key does NOT match Headscale's registration."
		log "Another machine has registered with the same hostname and replaced this node."
		log ""
		log "Action: Take this node offline or restart it with a unique VPC_NODE_NAME."
		return 0
	elif [ "$computed_public_key" = "$headscale_node_key" ]; then
		log "Keys match - this is a network connectivity issue."
	else
		log "Unable to verify keys - check manually."
	fi

	log ""
	return 1
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

	# First check if this is due to node replacement
	if diagnose_node_replacement; then
		# Node replacement detected, no need for further diagnostics
		return
	fi

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
	print_node_info

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
	done <<<"$node_list"

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
