export interface AuthGateGuardEnv {
  NODE_ENV?: string;
  LUMO_WEB_DISABLE_AUTH_GATE?: string;
}

const AUTH_GATE_DISABLED_ERROR =
  "auth_gate_disabled_in_production: LUMO_WEB_DISABLE_AUTH_GATE=1 cannot be used when NODE_ENV=production";

export function isProductionAuthGateBypass(env: AuthGateGuardEnv): boolean {
  return env.NODE_ENV === "production" && env.LUMO_WEB_DISABLE_AUTH_GATE === "1";
}

export function assertAuthGateNotDisabledInProduction(
  env: AuthGateGuardEnv = process.env,
): void {
  if (!isProductionAuthGateBypass(env)) return;
  throw new Error(AUTH_GATE_DISABLED_ERROR);
}

export { AUTH_GATE_DISABLED_ERROR };
