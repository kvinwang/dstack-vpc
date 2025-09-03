FROM ubuntu:24.04

# Install runtime dependencies
RUN apt-get update && apt-get install -y \
    ca-certificates \
    libssl3 \
    wget \
    curl \
    jq \
    nginx \
    supervisor \
    gettext-base \
    && rm -rf /var/lib/apt/lists/*

# Create necessary directories
RUN mkdir -p /var/run/dstack \
    /etc/dstack \
    /etc/ssl/certs \
    /etc/ssl/private \
    /var/log/supervisor \
    /var/log/nginx \
    /scripts

# Copy the pre-built binary
COPY target/release/dstack-mesh /usr/local/bin/dstack-mesh
RUN chmod +x /usr/local/bin/dstack-mesh

# Copy configuration files
COPY service-mesh/fs/nginx.conf.template /etc/nginx/nginx.conf.template
COPY service-mesh/fs/supervisord.conf /etc/supervisor/conf.d/supervisord.conf

# Copy scripts
COPY service-mesh/fs/startup.sh /scripts/startup.sh
RUN chmod +x /scripts/startup.sh

# Expose ports
EXPOSE 80 443 8091 8092

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
    CMD wget --quiet --tries=1 --spider http://localhost:8091/health || exit 1

# Set environment variables
ENV BACKEND=localhost:8080
ENV RUST_LOG=info

# Entry point
ENTRYPOINT ["/bin/bash", "-c", "/scripts/startup.sh"]