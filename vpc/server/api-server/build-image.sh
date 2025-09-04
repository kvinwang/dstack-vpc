#!/bin/bash
set -e

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

# Build the image
echo "Building Docker image..."
docker build -t kvin/dstack-vpc-api-server:latest .

# Push the image if --push flag is set
if [ "$PUSH_IMAGE" = true ]; then
    echo "Pushing image to Docker Hub..."
    docker push kvin/dstack-vpc-api-server:latest
    echo "Image pushed successfully!"
else
    echo "Image built locally. To push to Docker Hub, use:"
    echo "  docker push kvin/dstack-vpc-api-server:latest"
    echo "Or run this script with --push flag"
fi
