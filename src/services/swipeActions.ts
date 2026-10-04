import type { Thread } from "@/stores/threadStore";
import type { SwipeAction } from "@/utils/swipeActions";
import {
  archiveThread,
  trashThread,
  markThreadRead,
  starThread,
  spamThread,
} from "@/services/emailActions";

/**
 * Runs a swipe action on one thread through the normal action layer, so the
 * undo toast, the optimistic update and the offline queue all apply.
 * `snooze` is not handled here: it needs a time, so the card opens the dialog.
 */
export async function runSwipeAction(action: SwipeAction, thread: Thread): Promise<void> {
  const { accountId, id } = thread;
  switch (action) {
    case "trash":
      await trashThread(accountId, id, []);
      break;
    case "archive":
      await archiveThread(accountId, id, []);
      break;
    case "toggleRead":
      await markThreadRead(accountId, id, [], !thread.isRead);
      break;
    case "star":
      await starThread(accountId, id, [], !thread.isStarred);
      break;
    case "spam":
      await spamThread(accountId, id, [], !thread.labelIds.includes("SPAM"));
      break;
    default:
      break;
  }
}
