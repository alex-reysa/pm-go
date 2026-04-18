# Web App

This package will host the Next.js operator UI.

Primary responsibilities:

- render plan graphs, task state, review findings, and merge queue state
- expose operator controls for approvals, retries, and policy decisions
- subscribe to durable event streams from the control-plane API

Do not place orchestration logic here. The UI is a consumer of workflow state, not the owner of it.

