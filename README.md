# DStack VPC

> **Experimental:** Features are still maturing, test coverage is limited, and breaking changes are likely. Treat any production use as high risk.

Secure Virtual Private Cloud for DStack using Headscale VPN and service mesh.

## Components

- **Service Mesh** (`service-mesh/`): mTLS authentication between CVMs
- **VPC** (`vpc/`): Headscale VPN control plane + MongoDB cluster node example

## Building Docker Image

To build the `dstack-service` Docker image:

```bash
# Build locally with default image name (kvin/dstack-service)
./build-image.sh

# Build with custom name and push
./build-image.sh -t your-registry/dstack-service --push
```

The Docker image includes:
- **dstack-mesh**: Rust-based service mesh for mTLS authentication
- **vpc-api-server**: Go-based VPC API server
- **Headscale**: VPN control plane
- **Nginx**: Reverse proxy and load balancer
- **Supervisor**: Process management

## Using dstack-service

1. Build the image as described above, or pull the published `kvin/dstack-service` image.
2. Mount the host’s `/var/run/docker.sock` into the container (see `examples/docker-compose.yaml`) so the automation can talk to the Docker engine.
3. Configure the environment variables below and run `docker compose up -d` to launch the service mesh, optional VPC server, and sample workloads.

Environment variables:

| Variable | Default | Description |
| --- | --- | --- |
| `LOAD_MISSING_MODULES` | `true` | Loads `xt_mark`, `xt_connmark`, and related netfilter modules from the image onto the host. Required when running DStack versions earlier than 0.5.4; set to `false` once the modules are present on the host. |
| `MESH_BACKEND` | '' | Address of the server-side application to which the service mesh proxies traffic (for example `backend-app:8080`). |
| `VPC_SERVER_ENABLED` | `false` | Enables the Headscale control plane and VPC API server. Requires `VPC_ALLOWED_APPS` when set to `true`. |
| `VPC_ALLOWED_APPS` | _(required when VPC is enabled)_ | Comma-separated list of application IDs allowed to access the VPC control plane; use `any` to allow all. |
| `VPC_SERVER_APP_ID` | _(required when VPC or node setup is enabled)_ | Application ID of the VPC server inside the DStack gateway. Needed when `VPC_SERVER_ENABLED=true` or `VPC_NODE_NAME` is provided. |
| `VPC_SERVER_PORT` | `8080` | Exposed port for Headscale. Keep it in sync with your published port mapping. |
| `VPC_NODE_NAME` | _(empty)_ | When set, the stack bootstraps a Tailscale node with this name via the generated VPC node containers. |

Quick check: run `docker compose -f examples/docker-compose.yaml up` to start the sample backend (`backend-app`) and test client (`test-client`). The client pulls its `app_id` from `/info` and sends a request through the mesh to verify the mTLS and VPC paths.

See the [README](examples/mongo-cluster/README.md) for how to deploy a MongoDB cluster inside a DStack VPC.
