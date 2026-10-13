import { MissingSecretError, startWebhook } from "./server.js";

try {
  startWebhook();
} catch (err) {
  if (err instanceof MissingSecretError) {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  }
  throw err;
}
