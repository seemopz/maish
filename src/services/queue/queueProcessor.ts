import { createBackgroundChecker, type BackgroundChecker } from "../backgroundCheckers";
import { useUIStore } from "@/stores/uiStore";
import {
  getPendingOperations,
  updateOperationStatus,
  claimOperation,
  deleteOperation,
  incrementRetry,
  getPendingOpsCount,
  compactQueue,
  releaseExecutingOperations,
} from "../db/pendingOperations";
import { executeQueuedAction } from "../emailActions";
import { classifyError } from "@/utils/networkErrors";

const BATCH_SIZE = 50;

let checker: BackgroundChecker | null = null;
// Settles once rows left 'executing' by a previous run are back to 'pending'.
let released: Promise<void> | null = null;

async function processQueue(): Promise<void> {
  // Skip if offline
  if (!useUIStore.getState().isOnline) return;

  // A flush before the release would claim an operation the release then resets and sends twice
  await released;

  // Compact first to eliminate redundant ops
  await compactQueue();

  // Get pending operations
  const ops = await getPendingOperations(undefined, BATCH_SIZE);
  if (ops.length === 0) {
    await updatePendingCount();
    return;
  }

  for (const op of ops) {
    try {
      // Claim it; an undo commit may have taken the row in the meantime
      if (!(await claimOperation(op.id))) continue;

      // Parse params and execute
      const params = JSON.parse(op.params) as Record<string, unknown>;
      await executeQueuedAction(op.account_id, op.operation_type, params);

      // Success — delete from queue
      await deleteOperation(op.id);
    } catch (err) {
      const classified = classifyError(err);

      if (classified.isRetryable) {
        // Keep the row claimed while the error text is written; incrementRetry requeues it behind the backoff
        await updateOperationStatus(op.id, "executing", classified.message);
        await incrementRetry(op.id);
      } else {
        // Permanent failure
        await updateOperationStatus(op.id, "failed", classified.message);
      }
    }
  }

  await updatePendingCount();
}

async function updatePendingCount(): Promise<void> {
  const count = await getPendingOpsCount();
  useUIStore.getState().setPendingOpsCount(count);
}

export function startQueueProcessor(): void {
  if (checker) return;
  const instance = createBackgroundChecker("QueueProcessor", processQueue, 30_000);
  checker = instance;
  // Nothing is in flight yet, so a row still 'executing' is a send that was cut off.
  released = releaseExecutingOperations()
    .catch((err) => console.error("[QueueProcessor] release of executing operations failed:", err))
    .then(() => {
      if (checker === instance) instance.start();
    });
}

export function stopQueueProcessor(): void {
  checker?.stop();
  checker = null;
}

/**
 * Trigger an immediate queue flush (e.g., when coming back online).
 * Returns a promise that resolves when processing completes.
 */
export async function triggerQueueFlush(): Promise<void> {
  try {
    await processQueue();
  } catch (err) {
    console.error("[QueueProcessor] flush failed:", err);
  }
}
