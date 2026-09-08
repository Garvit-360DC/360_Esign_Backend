import { createApp } from "./app";
import { connectDb } from "./config/database";
import { env } from "./config/env";
import { logger } from "./config/logger";

async function main() {
  await connectDb();
  const app = createApp();
  app.listen(env.PORT, () => {
    logger.info(`x360-esign listening on port ${env.PORT}`);
  });
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : "Failed to start";
  logger.error(message, { stack: err instanceof Error ? err.stack : undefined });
  process.exit(1);
});
