import { checkWorkerHealth } from "@race-calendar/utils";
try {
  process.exit(checkWorkerHealth(process.env.WORKER_HEALTH_FILE) ? 0 : 1);
} catch {
  process.exit(1);
}
