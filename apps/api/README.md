# API App

This package will host the Node control-plane API.

Primary responsibilities:

- accept spec intake requests
- expose plan, task, review, and merge endpoints
- stream durable event-log updates to the UI
- translate operator actions into Temporal workflow signals and commands

The API should stay thin. Durable orchestration belongs in workflows and application services, not request handlers.

