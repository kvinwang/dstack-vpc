FROM rust:1.86-alpine AS rust-builder

RUN apk add --no-cache musl-dev

RUN rustup target add x86_64-unknown-linux-musl
WORKDIR /build
COPY service-mesh/ /build/service-mesh/
WORKDIR /build/service-mesh
RUN cargo build --release --target x86_64-unknown-linux-musl

FROM alpine AS ko-builder
RUN apk add --no-cache wget jq bash squashfs-tools
WORKDIR /build
COPY ./extract-modules.sh /build/
RUN ./extract-modules.sh

FROM ubuntu:24.04
RUN apt-get update && apt-get install -y \
    ca-certificates \
    wget \
    curl \
    jq \
    nginx \
    supervisor \
    gettext-base \
    && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /var/run/dstack \
    /etc/dstack \
    /etc/ssl/certs \
    /etc/ssl/private \
    /var/log/supervisor \
    /var/log/nginx \
    /scripts \
    /lib/extra-modules

COPY --from=rust-builder /build/service-mesh/target/x86_64-unknown-linux-musl/release/dstack-mesh /usr/local/bin/dstack-mesh
RUN chmod +x /usr/local/bin/dstack-mesh

COPY --from=ko-builder /build/netfilter-modules/*.ko /lib/extra-modules/

COPY fs/nginx.conf /etc/nginx/nginx.conf
COPY fs/client-proxy.conf /etc/nginx/conf.d/client-proxy.conf
COPY fs/server-proxy.conf.template /etc/nginx/templates/server-proxy.conf.template
COPY fs/supervisord.conf /etc/supervisor/conf.d/supervisord.conf
COPY fs/startup.sh /scripts/startup.sh
RUN chmod +x /scripts/startup.sh

EXPOSE 80 443 8091 8092

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
    CMD wget --quiet --tries=1 --spider http://localhost:8091/health || exit 1

ENV BACKEND=localhost:8080
ENV RUST_LOG=info

ENTRYPOINT ["/bin/bash", "-c", "/scripts/startup.sh"]
