#!/bin/bash

IMAGE_NAME="kvin/dstack-mesh"

THIS_DIR=$(cd "$(dirname "$0")" && pwd)
cd "$THIS_DIR/.."
cargo build --release
docker build -f service-mesh/Dockerfile -t $IMAGE_NAME .

# Default values
PUSH_IMAGE=false
# Parse command line arguments
while [[ $# -gt 0 ]]; do
    case "$1" in
        --push)
            PUSH_IMAGE=true
            shift
            ;;
        *)
            echo "Unknown argument: $1"
            exit 1
            ;;
    esac
done

if [ "$PUSH_IMAGE" = true ]; then
    echo "Pushing image to Docker Hub..."
    docker push $IMAGE_NAME:latest
    echo "Image pushed successfully!"
else
    echo "Image built locally. To push to Docker Hub, use:"
    echo "  docker push $IMAGE_NAME:latest"
    echo "Or run this script with --push flag"
fi
