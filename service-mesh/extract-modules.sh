#!/bin/bash

set -e

# Configuration
DSTACK_VERSION="0.5.4.1"
DSTACK_URL="https://github.com/Dstack-TEE/meta-dstack/releases/download/v${DSTACK_VERSION}/dstack-${DSTACK_VERSION}.tar.gz"
TEMP_DIR="/tmp/dstack-netfilter-$$"

echo "Extracting netfilter modules from dstack v${DSTACK_VERSION}..."

BUILD_DIR="$(pwd)"
MODULES_DIR="${BUILD_DIR}/netfilter-modules"
mkdir -p "${MODULES_DIR}"
mkdir -p "${TEMP_DIR}"
cd "${TEMP_DIR}"

wget -q --show-progress "${DSTACK_URL}" -O "dstack.tar.gz"
tar -xzf dstack.tar.gz

cd "dstack-${DSTACK_VERSION}"
ROOTFS_SIZE=$(jq -r '.cmdline' metadata.json | sed -n 's/.*dstack\.rootfs_size=\([0-9]*\).*/\1/p')

echo "Parsed rootfs size: $ROOTFS_SIZE bytes"
if [ -z "$ROOTFS_SIZE" ] || [ "$ROOTFS_SIZE" = "0" ]; then
    echo "Error: Could not parse rootfs size from metadata.json"
    echo "Cmdline content:"
    jq -r '.cmdline' metadata.json
    exit 1
fi

dd if=rootfs.img.verity of=rootfs.squashfs bs=1M count=$(($ROOTFS_SIZE / 1048576 + 1)) 2>/dev/null
truncate -s $ROOTFS_SIZE rootfs.squashfs

unsquashfs -q -d mnt rootfs.squashfs

if [[ -d "mnt/lib/modules/6.9.0-dstack/kernel/net/netfilter" ]]; then
    echo "Copying modules to temporary directory..."
    for module in mnt/lib/modules/6.9.0-dstack/kernel/net/netfilter/*.ko; do
        if [[ -f "$module" ]]; then
            cp -v "$module" "${MODULES_DIR}/"
        fi
    done
    MODULE_COUNT=$(ls -1 mnt/lib/modules/6.9.0-dstack/kernel/net/netfilter/*.ko 2>/dev/null | wc -l)
    echo "Extracted $MODULE_COUNT netfilter modules to ${MODULES_DIR}/"
else
    echo "Error: netfilter modules not found"
    exit 1
fi

cd /
rm -rf "${TEMP_DIR}"

echo "Netfilter modules ready for Docker build in netfilter-modules/"