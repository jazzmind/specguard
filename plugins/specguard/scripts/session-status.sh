#!/bin/sh
# SessionStart: one short status block for a project that uses SpecGuard; silent otherwise and never fails the session.
CLI="$(dirname "$0")/../bin/specguard"
if [ ! -f .specguard/config.json ]; then
  # No config in this folder. Specs may live in an overlay repo: ask the CLI, but only when an overlay is known at all
  # (a registry file, SPECGUARD_OVERLAY or SPECGUARD_CONFIG), so a project without overlays pays no CLI start-up.
  [ -n "$SPECGUARD_OVERLAY" ] || [ -n "$SPECGUARD_CONFIG" ] || [ -f "${XDG_CONFIG_HOME:-$HOME/.config}/specguard/overlays.json" ] || exit 0
  "$CLI" overlay resolve . --json 2>/dev/null | grep -q '"configured":true' || exit 0
fi
"$CLI" check 2>/dev/null | head -8
exit 0
