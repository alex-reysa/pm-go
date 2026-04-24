-- Add optional auto-approve flag to plans. When true, phases whose tasks are
-- all low-risk can be approved without a human gate, letting the orchestrator
-- skip the manual approval signal and proceed directly to execution.
ALTER TABLE "plans" ADD COLUMN "auto_approve_low_risk" boolean;
