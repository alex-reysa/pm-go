-- Runs once on fresh Postgres volume creation (mounted at
-- /docker-entrypoint-initdb.d/). Creates the integration-test database
-- referenced by DATABASE_URL_TEST in .env.example. The Drizzle round-trip
-- test in packages/db/test/round-trip.test.ts uses this database when the
-- env var is set, falling back to skip otherwise.
--
-- If the volume pmgo_postgres already exists from a prior `docker:up`,
-- Postgres will NOT re-run this script. Create the database manually:
--   docker exec pm-go-postgres-1 createdb -U pmgo pm_go_test

CREATE DATABASE pm_go_test OWNER pmgo;
