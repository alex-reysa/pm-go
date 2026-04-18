# Claude Executor Adapter

This package will adapt the Claude Agent SDK to the control-plane contracts.

Responsibilities:

- translate task contracts into executor requests
- enforce allowed file scopes, commands, and budget metadata
- return structured outputs and audit metadata
- keep executor-specific details out of orchestration packages

Add a broader executor abstraction only after Claude-first execution is stable.

