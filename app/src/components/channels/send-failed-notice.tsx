import { cn } from "@/lib/utils";

/**
 * "Failed to send · Resend · Discard", drawn under the transcript when the last send was refused.
 *
 * There is no per-message failed state to hang this on: a send that fails never became a message,
 * and the composer puts the words straight back into the editor (see `submitDraft`'s `catch` in
 * `composer.tsx`). So this line is about the editor, not about a row in the transcript — Resend
 * submits what the editor holds again, and Discard empties it. Both are the person's call; nothing
 * here retries on its own.
 *
 * `role="alert"` because the failure is news that just happened, which is what an alert is for; the
 * two actions sit inside it so a screen reader hears the sentence and its remedies together.
 */
export function SendFailedNotice({
  onResend,
  onDiscard,
  className,
}: {
  onResend: () => void;
  onDiscard: () => void;
  className?: string;
}) {
  return (
    <div
      role="alert"
      className={cn(
        "flex items-center justify-end gap-4 px-3 pb-2 text-[13px]",
        className,
      )}
    >
      <span className="font-medium text-destructive">Failed to send</span>
      <button
        className="rounded-sm text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
        onClick={onResend}
        type="button"
      >
        Resend
      </button>
      <button
        className="rounded-sm text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
        onClick={onDiscard}
        type="button"
      >
        Discard
      </button>
    </div>
  );
}
