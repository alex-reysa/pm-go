# Infrastructure Notes

Local development infrastructure should be kept minimal for V1.

Required services:

- Postgres
- Temporal server
- Temporal UI
- OpenTelemetry collector

Later additions:

- Docker sandboxing for untrusted repos
- remote executor runners
- stronger isolation and secret-scoped execution

