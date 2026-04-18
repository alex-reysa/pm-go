# Orchestrator

This package will host application services that coordinate planning, execution, review, and integration.

Core service boundaries:

- `PlanService`
- `TaskService`
- `ReviewLoopService`
- `MergeService`
- `PolicyGateService`

These services should compose workflows and persistence; they should not embed executor-specific logic.

