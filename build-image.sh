#!/bin/bash

IMAGE_NAME="kvin/dstack-service"
PUSH_IMAGE=false

while [[ $# -gt 0 ]]; do
    case "$1" in
        --push)
            PUSH_IMAGE=true
            shift
            ;;
        -t)
            IMAGE_NAME="$2"
            shift 2
            ;;
        *)
            echo "Unknown argument: $1"
            exit 1
            ;;
    esac
done

THIS_DIR=$(cd "$(dirname "$0")" && pwd)

docker build "$THIS_DIR" -t "$IMAGE_NAME"

if [ "$PUSH_IMAGE" = true ]; then
    echo "Pushing image to Docker Hub..."
    docker push "$IMAGE_NAME"
    echo "Image pushed successfully!"
else
    echo "Image built locally. To push to Docker Hub, use:"
    echo "  docker push $IMAGE_NAME"
    echo "Or run this script with --push flag"
fi
