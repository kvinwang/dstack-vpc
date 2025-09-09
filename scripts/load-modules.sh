#!/bin/bash

echo "Loading netfilter kernel modules..."
MODULES=(
    "xt_mark"
    "xt_connmark"
)
for module in "${MODULES[@]}"; do 
    # Check if module is already loaded
    if lsmod | grep -q "^$module "; then
        echo "Module already loaded: $module"
        continue
    fi
    
    # Check if module file exists
    if [ ! -f "/lib/extra-modules/$module.ko" ]; then
        echo "Error: Module file not found: /lib/extra-modules/$module.ko"
        continue
    fi
    
    # Try to load the module
    if insmod /lib/extra-modules/$module.ko 2>/dev/null; then
        echo "Successfully loaded: $module"
    else
        echo "Failed to load module: $module (may already be loaded, built-in, or unavailable)"
    fi
done

echo "Module loading completed."