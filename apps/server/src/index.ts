import { loadConfig } from './config.js';
import { warnIfModelUnavailable } from './llm/provider.js';
import { createServer } from './server.js';

async function main(): Promise<void> {
  const cfg = loadConfig();
  const { close } = await createServer({ cfg });

  console.log(`[carryover] listening on :${cfg.port}`);
  console.log(`[carryover] public URL: ${cfg.publicBaseUrl}`);
  console.log(`[carryover] brain endpoint: ${cfg.publicBaseUrl}/brain/v1/chat/completions`);

  void warnIfModelUnavailable(cfg);

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[carryover] ${signal} received, ending calls and shutting down...`);
    close()
      .then(() => process.exit(0))
      .catch((err: unknown) => {
        console.error('[carryover] shutdown failed', err);
        process.exit(1);
      });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err: unknown) => {
  console.error('[carryover] failed to start', err);
  process.exit(1);
});
