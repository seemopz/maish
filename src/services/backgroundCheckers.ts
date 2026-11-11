/**
 * Factory for creating background interval checkers.
 * Provides consistent start/stop/error handling for periodic tasks.
 */
export interface BackgroundChecker {
  start(): void;
  stop(): void;
}

export function createBackgroundChecker(
  name: string,
  checkFn: () => Promise<void>,
  intervalMs: number = 60_000,
): BackgroundChecker {
  let interval: ReturnType<typeof setInterval> | null = null;
  // A run slower than the interval must not overlap the next one.
  let running = false;

  const run = async () => {
    if (running) return;
    running = true;
    try {
      await checkFn();
    } catch (err) {
      console.error(`[${name}] check failed:`, err);
    } finally {
      running = false;
    }
  };

  return {
    start() {
      if (interval) return;
      run();
      interval = setInterval(run, intervalMs);
    },
    stop() {
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
    },
  };
}
