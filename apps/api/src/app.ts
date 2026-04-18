import { Hono } from "hono";
import {
  createSpecDocumentsRoute,
  type SpecDocumentsRouteDeps
} from "./routes/spec-documents.js";

export function createApp(deps: SpecDocumentsRouteDeps) {
  const app = new Hono();
  app.get("/health", (c) => c.json({ status: "ok" }));
  app.route("/spec-documents", createSpecDocumentsRoute(deps));
  return app;
}
