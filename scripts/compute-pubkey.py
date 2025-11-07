#!/usr/bin/env python3
"""
Compute Curve25519 public key from private key for Tailscale node keys.
Usage: echo "privkey:hex..." | python3 compute-pubkey.py
"""

import sys
import hashlib


def curve25519_public_from_private(private_bytes):
    """
    Compute Curve25519 public key from private key.
    This is a simplified implementation using the standard algorithm.
    """
    # Curve25519 base point
    _9 = bytes([9] + [0] * 31)

    # Clamp the private key as per Curve25519 spec
    private = bytearray(private_bytes)
    private[0] &= 248
    private[31] &= 127
    private[31] |= 64

    # Use nacl library if available, otherwise return error
    try:
        from nacl.bindings import crypto_scalarmult_base
        public = crypto_scalarmult_base(bytes(private))
        return public
    except ImportError:
        # Fallback: try cryptography library
        try:
            from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey
            private_key = X25519PrivateKey.from_private_bytes(bytes(private))
            public_key = private_key.public_key()
            return public_key.public_bytes_raw()
        except ImportError:
            print(
                "Error: Neither PyNaCl nor cryptography library is available", file=sys.stderr)
            print(
                "Install with: pip install PyNaCl  or  pip install cryptography", file=sys.stderr)
            sys.exit(1)


def main():
    # Read private key from stdin
    line = sys.stdin.read().strip()

    if not line.startswith('privkey:'):
        print("Error: Input must start with 'privkey:'", file=sys.stderr)
        sys.exit(1)

    # Extract hex part
    hex_key = line[8:]  # Remove 'privkey:' prefix

    try:
        # Convert hex to bytes
        private_bytes = bytes.fromhex(hex_key)

        if len(private_bytes) != 32:
            print(
                f"Error: Private key must be 32 bytes, got {len(private_bytes)}", file=sys.stderr)
            sys.exit(1)

        # Compute public key
        public_bytes = curve25519_public_from_private(private_bytes)

        # Format as Tailscale nodekey
        public_hex = public_bytes.hex()
        print(f"nodekey:{public_hex}")

    except ValueError as e:
        print(f"Error: Invalid hex string: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
