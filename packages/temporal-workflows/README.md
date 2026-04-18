# Temporal Workflows

This package will hold the durable workflow implementations and workflow registration.

Guidelines:

- keep workflow code deterministic
- keep side effects inside activities
- model stop conditions explicitly
- treat signals and queries as part of the external control-plane contract

