import { Client, Connection } from "@temporalio/client";

export interface TemporalClientConfig {
  address: string;
  namespace: string;
}

export async function createTemporalClient(
  config: TemporalClientConfig
): Promise<Client> {
  const connection = await Connection.connect({ address: config.address });
  return new Client({ connection, namespace: config.namespace });
}
