import {
  claimScheduledEmail,
  getPendingScheduledEmails,
  requeueInterruptedScheduledEmails,
  updateScheduledEmailStatus,
} from "../db/scheduledEmails";
import { getEmailProvider } from "../email/providerFactory";
import { buildRawEmail, type EmailAttachment } from "@/utils/emailBuilder";
import { getAccount } from "../db/accounts";
import { createBackgroundChecker } from "../backgroundCheckers";

/**
 * Check for scheduled emails that are ready to be sent.
 */
let requeued = false;

async function checkScheduledEmails(): Promise<void> {
  // First run of this app start: nothing of ours is sending yet.
  // shortcut: a crash between the server accepting the mail and the "sent" update sends it twice; upgrade by checking Sent for its Message-ID if that shows up.
  if (!requeued) {
    await requeueInterruptedScheduledEmails();
    requeued = true;
  }
  const pending = await getPendingScheduledEmails();

  for (const email of pending) {
    try {
      const account = await getAccount(email.account_id);
      if (!account) {
        await updateScheduledEmailStatus(email.id, "failed");
        continue;
      }

      // Claim before sending: an overlapping run that lost the claim skips the row.
      if (!(await claimScheduledEmail(email.id))) continue;

      // Whichever provider the account uses. This used to ask for a Gmail
      // client outright, which an IMAP account has none of: the call threw,
      // the catch below could find no 5xx or network error in the message,
      // and the row was marked failed. The scheduled mail was dropped without
      // ever being sent.
      const provider = await getEmailProvider(email.account_id);

      // Parse attachments from JSON if present
      let attachments: EmailAttachment[] | undefined;
      if (email.attachment_paths) {
        try {
          attachments = JSON.parse(email.attachment_paths) as EmailAttachment[];
        } catch {
          console.warn(`Failed to parse attachment_paths for scheduled email ${email.id}`);
        }
      }

      const raw = buildRawEmail({
        from: account.email,
        to: email.to_addresses.split(",").map((a) => a.trim()),
        cc: email.cc_addresses
          ? email.cc_addresses.split(",").map((a) => a.trim())
          : undefined,
        bcc: email.bcc_addresses
          ? email.bcc_addresses.split(",").map((a) => a.trim())
          : undefined,
        subject: email.subject ?? "",
        htmlBody: email.body_html,
        threadId: email.thread_id ?? undefined,
        attachments,
      });

      await provider.sendMessage(raw, email.thread_id ?? undefined);
      await updateScheduledEmailStatus(email.id, "sent");
    } catch (err) {
      console.error(`Failed to send scheduled email ${email.id}:`, err);
      // Distinguish transient vs permanent errors
      const message = err instanceof Error ? err.message : String(err);
      const isTransient = message.includes("5") && /\b5\d{2}\b/.test(message)
        || message.toLowerCase().includes("network")
        || message.toLowerCase().includes("timeout")
        || message.toLowerCase().includes("econnrefused");
      // Revert to pending for transient errors (allows retry), mark failed for permanent
      await updateScheduledEmailStatus(email.id, isTransient ? "pending" : "failed");
    }
  }
}

/** Exposed for the tests; the checker itself runs on an interval. */
export const __checkScheduledEmailsForTest = checkScheduledEmails;

const scheduledSendChecker = createBackgroundChecker("ScheduledSend", checkScheduledEmails);
export const startScheduledSendChecker = scheduledSendChecker.start;
export const stopScheduledSendChecker = scheduledSendChecker.stop;
