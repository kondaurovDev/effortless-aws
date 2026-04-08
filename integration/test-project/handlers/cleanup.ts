// Implement your cron handler here.
import { createHandler } from "./cleanup.gen";

export const handler = createHandler(async ({ orders }) => {
  // This runs on schedule
  console.log("Cron tick");
});
