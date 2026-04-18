# Worker App

This package will host the Temporal worker runtime.

Primary responsibilities:

- register workflow implementations
- register activity implementations
- connect to shared services such as persistence, MCP clients, and executor adapters
- emit telemetry and durable execution events

The worker is the runtime entrypoint for orchestration, not a place to define product contracts.

