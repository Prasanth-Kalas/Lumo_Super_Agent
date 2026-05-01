#!/usr/bin/env node

if (
  process.env.NODE_ENV === "production" &&
  process.env.LUMO_WEB_DISABLE_AUTH_GATE === "1"
) {
  console.error(
    "auth_gate_disabled_in_production: unset LUMO_WEB_DISABLE_AUTH_GATE before building for production",
  );
  process.exit(1);
}
