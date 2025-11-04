FROM rust:1.86-alpine AS rust-builder
RUN apk add --no-cache musl-dev
RUN rustup target add x86_64-unknown-linux-musl
WORKDIR /build
COPY service-mesh/ /build/service-mesh/
WORKDIR /build/service-mesh
RUN cargo build --release --target x86_64-unknown-linux-musl

FROM golang:1.21-alpine AS go-builder
WORKDIR /build
COPY vpc-api-server/ /build/
RUN go mod init vpc-api-server || true
RUN go get github.com/gin-gonic/gin
RUN CGO_ENABLED=0 GOOS=linux go build -a -o vpc-api-server main.go

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
    socat \
    kmod

RUN curl -fsSL https://get.docker.com | sh
RUN usermod -aG docker root


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

COPY --from=go-builder /build/vpc-api-server /usr/local/bin/vpc-api-server
RUN chmod +x /usr/local/bin/vpc-api-server

COPY --from=ko-builder /build/netfilter-modules/*.ko /lib/extra-modules/

COPY configs/nginx.conf /etc/nginx/nginx.conf
COPY configs/nginx-client-proxy.conf /etc/nginx/conf.d/client-proxy.conf
COPY configs/nginx-server-proxy.conf.template /etc/nginx/templates/server-proxy.conf.template
COPY configs/supervisord.conf /etc/supervisor/conf.d/supervisord.conf
COPY configs/headscale_config.yaml /etc/headscale/config.yaml
COPY scripts /scripts
RUN chmod +x /scripts/*.sh

EXPOSE 80 443 8091 8092

HEALTHCHECK --start-period=5m --timeout=20s CMD /scripts/healthcheck.sh

ENTRYPOINT ["/scripts/entrypoint.sh"]
CMD ["/scripts/auto-entry.sh"]
