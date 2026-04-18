# Integration Engine

This package will own deterministic merge order and milestone validation.

Rules:

- merge order follows dependency edges, never completion time
- implementers do not merge their own work
- targeted validation runs after each merge
- broader integration validation runs at defined milestones

