#!/bin/sh
# SessionStart: one short status block for a project that uses SpecGuard; silent otherwise and never fails the session.
[ -f .specguard/config.json ] || exit 0
"$(dirname "$0")/../bin/specguard" check 2>/dev/null | head -8
exit 0
