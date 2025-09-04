# DStack VPC

Virtual Private Cloud using Headscale VPN for secure DStack node networking.

## Architecture

**VPC Server**: Headscale VPN control plane + bootstrap API running in CVM for distributing shared credentials via service mesh
**VPC Nodes**: Tailscale client + your services (MongoDB example) running in CVMs
**Network**: Encrypted WireGuard tunnels with MagicDNS (*.dstack.internal)

## Deployment

Deploy to dstack platform using the compose files:

**VPC Server**: Deploy `vpc/server/docker-compose.yml` to dstack
- Optional: Set `ALLOWED_APPS=app-id1,app-id2,app-id3` (defaults to "any" for non-production)
- Note the app-id after deployment, use it as `VPC_SERVER_APP_ID` for nodes

**MongoDB Nodes**: Deploy `vpc/nodes/mongodb.yml` to dstack
- Set `MONGO_IND=0` for primary node
- Set `MONGO_IND=1,2,3...` for secondary nodes
- Set `VPC_SERVER_APP_ID=<headscale-server-app-id>`

**App Nodes**: Deploy `vpc/nodes/mongo-app.yml` to dstack (demo app that connects to MongoDB cluster)
- Set `APP_IND=0,1,2...` for each app instance
- Set `VPC_SERVER_APP_ID=<headscale-server-app-id>`

## Bootstrap Process

1. **Agent** fetches shared keyfile from VPC server via service mesh (same key distributed to all DB and app nodes)
2. **Tailscale** connects using pre-auth key
3. **Services** communicate via internal domains (mongodb-0.dstack.internal)
4. **MongoDB** automatically forms replica set with shared keyfile
   - Primary node (mongodb-0) initializes replica set
   - Creates admin user with password derived from keyfile
   - Apps connect using same keyfile-derived password

## Network

- **VPN Range**: 100.64.0.0/10
- **DNS**: 100.100.100.100 (MagicDNS)
- **Domain**: dstack.internal
- **Security**: WireGuard encryption + mTLS service mesh
