#!/bin/sh

THIS_DIR=$(cd "$(dirname "$0")" && pwd)
cd "$THIS_DIR/.."
cargo build --release
docker build -f service-mesh/Dockerfile -t kvin/dstack-mesh .
