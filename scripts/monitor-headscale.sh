#!/bin/bash
# Monitor Headscale status and log changes
set -e

VPC_SERVER_CONTAINER_NAME="${VPC_SERVER_CONTAINER_NAME:-dstack-vpc-server}"
STATE_FILE="/tmp/headscale_state.json"
LOG_PREFIX="[Headscale Monitor]"

log() {
	echo "$(date -Iseconds) $LOG_PREFIX $*"
}

get_headscale_status() {
	local nodes routes users

	# Get nodes list (handle null/empty output)
	nodes=$(docker exec "$VPC_SERVER_CONTAINER_NAME" headscale nodes list --output json 2>/dev/null || echo "null")
	if [ "$nodes" = "null" ] || [ -z "$nodes" ]; then
		nodes="[]"
	fi

	# Get routes (handle null/empty output)
	routes=$(docker exec "$VPC_SERVER_CONTAINER_NAME" headscale routes list --output json 2>/dev/null || echo "null")
	if [ "$routes" = "null" ] || [ -z "$routes" ]; then
		routes="[]"
	fi

	# Get users (handle null/empty output)
	users=$(docker exec "$VPC_SERVER_CONTAINER_NAME" headscale users list --output json 2>/dev/null || echo "null")
	if [ "$users" = "null" ] || [ -z "$users" ]; then
		users="[]"
	fi

	# Combine into single JSON
	jq -n \
		--argjson nodes "$nodes" \
		--argjson routes "$routes" \
		--argjson users "$users" \
		'{
      timestamp: now | strftime("%Y-%m-%dT%H:%M:%S%z"),
      nodes: ($nodes // []),
      routes: ($routes // []),
      users: ($users // []),
      node_count: (($nodes // []) | length),
      route_count: (($routes // []) | length),
      user_count: (($users // []) | length)
    }'
}

compare_and_log() {
	local current="$1"
	local previous="$2"

	# Compare node count
	local curr_nodes=$(echo "$current" | jq -r '.node_count')
	local prev_nodes=$(echo "$previous" | jq -r '.node_count // 0')

	if [ "$curr_nodes" != "$prev_nodes" ]; then
		log "Node count changed: $prev_nodes -> $curr_nodes"
	fi

	# Compare route count
	local curr_routes=$(echo "$current" | jq -r '.route_count')
	local prev_routes=$(echo "$previous" | jq -r '.route_count // 0')

	if [ "$curr_routes" != "$prev_routes" ]; then
		log "Route count changed: $prev_routes -> $curr_routes"
	fi

	# Detect new/removed nodes (handle empty arrays)
	local new_nodes=$(echo "$current" | jq -r '.nodes[]?.name // empty' 2>/dev/null | sort)
	local old_nodes=$(echo "$previous" | jq -r '.nodes[]?.name // empty' 2>/dev/null | sort)

	if [ -n "$new_nodes" ] || [ -n "$old_nodes" ]; then
		local added=$(comm -13 <(echo "$old_nodes") <(echo "$new_nodes"))
		local removed=$(comm -23 <(echo "$old_nodes") <(echo "$new_nodes"))

		if [ -n "$added" ]; then
			log "New nodes added: $(echo $added | tr '\n' ' ')"
		fi

		if [ -n "$removed" ]; then
			log "Nodes removed: $(echo $removed | tr '\n' ' ')"
		fi
	fi

	# Detect online status changes (only if there are nodes)
	local node_names=$(echo "$current" | jq -r '.nodes[]?.name // empty' 2>/dev/null)
	if [ -n "$node_names" ]; then
		while IFS= read -r node_name; do
			[ -z "$node_name" ] && continue
			local curr_online=$(echo "$current" | jq -r --arg name "$node_name" '.nodes[]? | select(.name == $name) | .online // false' 2>/dev/null)
			local prev_online=$(echo "$previous" | jq -r --arg name "$node_name" '.nodes[]? | select(.name == $name) | .online // false' 2>/dev/null)

			if [ "$curr_online" != "$prev_online" ] && [ -n "$prev_online" ]; then
				log "Node '$node_name' status changed: online=$prev_online -> online=$curr_online"
			fi
		done <<< "$node_names"
	fi
}

log "Starting Headscale monitor..."

# Wait for headscale to be ready
log "Waiting for Headscale to be ready..."
until docker exec "$VPC_SERVER_CONTAINER_NAME" headscale users list >/dev/null 2>&1; do
	sleep 5
done
log "Headscale is ready"

# Main monitoring loop
while true; do
	current_state=$(get_headscale_status)

	if [ -f "$STATE_FILE" ]; then
		previous_state=$(cat "$STATE_FILE")
		compare_and_log "$current_state" "$previous_state"
	else
		log "Initial state captured: $(echo "$current_state" | jq -c '{node_count, route_count, user_count}')"
	fi

	# Save current state
	echo "$current_state" >"$STATE_FILE"

	# Sleep for monitoring interval (default 10 seconds)
	sleep "${MONITOR_INTERVAL:-10}"
done
