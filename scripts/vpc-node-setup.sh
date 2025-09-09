#!/bin/bash
set -e

if [ -z "$DSTACK_MESH_URL" ]; then
    echo "ERROR: DSTACK_MESH_URL is not set"
    exit 1
fi

echo "Fetching instance info from dstack-mesh..."
echo "curl -v $DSTACK_MESH_URL/info"
INFO=$(curl -s $DSTACK_MESH_URL/info)
INSTANCE_ID=$(jq -r .instance_id <<<"$INFO")
echo "INSTANCE_ID: $INSTANCE_ID"

if [ "$VPC_SERVER_APP_ID" = "self" ]; then
    VPC_SERVER_APP_ID=$(jq -r .app_id <<<"$INFO")
fi

echo "Instance ID: $INSTANCE_ID"
echo "VPC Server App ID: $VPC_SERVER_APP_ID"

RESPONSE=$(curl -s -H "x-dstack-target-app: $VPC_SERVER_APP_ID" -H "Host: dstack-vpc-server" \
    "$DSTACK_MESH_URL/api/register?instance_id=$INSTANCE_ID&node_name=$NODE_NAME")

PRE_AUTH_KEY=$(jq -r .pre_auth_key <<<"$RESPONSE")
SHARED_KEY=$(jq -r .shared_key <<<"$RESPONSE")
VPC_SERVER_URL=$(jq -r .server_url <<<"$RESPONSE")

if [ -z "$PRE_AUTH_KEY" ] || [ -z "$SHARED_KEY" ] || [ -z "$VPC_SERVER_URL" ]; then
echo "Error: Missing required fields in response"
echo "Response: $RESPONSE"
exit 1
fi

echo "$PRE_AUTH_KEY" > /shared/pre_auth_key
echo "$SHARED_KEY" > /shared/shared_key
echo "$VPC_SERVER_URL" > /shared/server_url

echo "VPC setup completed"