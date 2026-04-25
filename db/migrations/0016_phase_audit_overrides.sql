-- v0.8.2 Task 2.2: Operator override surface for phase audits.
--
-- Adds a first-class override trail to phase_audit_reports so operators
-- can mark a `blocked` audit as accepted (with a non-empty reason)
-- through `POST /phases/:phaseId/override-audit` instead of issuing a
-- direct UPDATE on the phases row. The columns are nullable; absence
-- means "no override applied", presence means "override of record".

ALTER TABLE "phase_audit_reports" ADD COLUMN "override_reason" text;
ALTER TABLE "phase_audit_reports" ADD COLUMN "overridden_by" text;
ALTER TABLE "phase_audit_reports" ADD COLUMN "overridden_at" timestamp with time zone;
