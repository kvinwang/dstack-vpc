# DStack Service Mesh

A Rust-based service mesh proxy that provides automated mutual authentication for trusted HTTP communication between DStack CVMs (Confidential Virtual Machines). This component ensures secure communication by leveraging TLS certificates issued by dstack-kms with embedded app-id identifiers.

## Overview

The DStack Service Mesh enables secure CVM-to-CVM communication by:
- Using client/server TLS certificates issued by dstack-kms
- Extracting and validating app-id from certificate embedded metadata
- Only allowing communication between CVMs under the same KMS
- Validating remote CVMs using KMS root certificate
- Converting HTTP to HTTPS with automatic app-id authentication

## Architecture

### Authentication Mechanism

The service mesh implements a dual-component authentication system:

**Server-Side Authentication**
- Receives client certificates from nginx via headers (`x-client-cert`, `x-client-verify`)
- Validates certificates against dstack-kms root CA
- Extracts app-id from certificate metadata
- Passes authenticated app-id to backend services via `x-dstack-app-id` header

**Client-Side Proxy**
- Converts HTTP requests to HTTPS with mTLS
- Uses dstack-kms issued client certificates for authentication
- Routes requests based on app-id specified in `x-dstack-target-app` header
- Ensures target CVM has matching app-id authorization

*Note: Due to current Rust reqwest client limitations, certificate app-id validation occurs after the HTTP response is received, meaning request payloads are transmitted before verification completes. This is mitigated by ZT-HTTPS domain certificate protection and will be fixed in future versions.*

## Usage Example

Server side compose:
```yaml
services:
  dstack-mesh:
    image: kvin/dstack-mesh@sha256:<hash>
    volumes:
      - /var/run/dstack.sock:/var/run/dstack.sock:ro
      - /dstack:/dstack
    environment:
      - MESH_BACKEND=backend-app:8080
    restart: unless-stopped

  backend-app:
    image: your-backend-app-image@sha256:<hash>
    restart: unless-stopped
```

Client side compose:
```yaml
services:
  dstack-mesh:
    image: kvin/dstack-mesh@sha256:<hash>
    volumes:
      - /var/run/dstack.sock:/var/run/dstack.sock:ro
      - /dstack:/dstack
    restart: unless-stopped
  test-client:
    image: your-test-client-image@sha256:<hash>
    restart: unless-stopped
```

Test the service mesh with curl:

```bash
# Get your app ID (When no x-dstack-target-app given, the API is a proxy to dstack guest agent)
APP_ID=$(curl -s http://dstack-mesh/info | jq -r .app_id)

# Make a request to another CVM service, confidentially
curl -H "x-dstack-target-app: $APP_ID" http://dstack-mesh/api/data
```

For complete setup example, see `example/docker-compose.yml`.
