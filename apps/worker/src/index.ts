import { NativeConnection, Worker } from "@temporalio/worker";
import { createDb } from "@pm-go/db";
import { createSpecIntakeActivities } from "./activities/spec-intake.js";

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  const temporalAddress = process.env.TEMPORAL_ADDRESS ?? "localhost:7233";
  const taskQueue = process.env.TEMPORAL_TASK_QUEUE ?? "pm-go-worker";

  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }

  const db = createDb(databaseUrl);
  const connection = await NativeConnection.connect({ address: temporalAddress });

  const worker = await Worker.create({
    connection,
    namespace: process.env.TEMPORAL_NAMESPACE ?? "default",
    taskQueue,
    workflowsPath: new URL("./workflows/index.js", import.meta.url).pathname,
    activities: createSpecIntakeActivities({ db }),
  });

  process.on("SIGINT", () => worker.shutdown());
  process.on("SIGTERM", () => worker.shutdown());

  await worker.run();
}

main().catch((err) => {
  console.error("worker failed:", err);
  process.exit(1);
});
