export interface RegistryConfigAgent {
  key: string;
  enabled: boolean;
  /** Lumo-owned policy bit. Partner manifests cannot set this. */
  system?: boolean;
  base_url: string;
  /** Optional version pin (semver range). */
  version?: string;
}

export interface RegistryConfigFile {
  agents: RegistryConfigAgent[];
}

export function enabledRegistryAgents(config: RegistryConfigFile): RegistryConfigAgent[] {
  return config.agents.filter((agent) => agent.enabled);
}
