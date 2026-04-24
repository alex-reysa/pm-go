export interface RuntimeCapabilities {
  streamJson: boolean;
  structuredOutput: boolean;
  mcpTools: boolean;
}

export interface RuntimeAdapter {
  name: string;
  cliCommand: string;
  detectAvailable(): Promise<boolean>;
  detectVersion(): Promise<string | null>;
  capabilities: RuntimeCapabilities;
}

export interface DetectedRuntime {
  adapter: RuntimeAdapter;
  version: string;
}
