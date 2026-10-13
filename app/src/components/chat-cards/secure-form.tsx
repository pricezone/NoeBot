import { IconEye, IconEyeOff, IconLock, IconWorld } from "@tabler/icons-react";
import { type ReactNode, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { type UiStrings, useUiStrings } from "@/lib/i18n/strings";
import { cn } from "@/lib/utils";

/**
 * The pieces every sensitive request in a conversation is drawn with: a sign-in, a one-time code, a
 * value the Bot must not see, a form, a request to take over the browser. One look for all of them,
 * the one Grok Bot uses: a compact row in the Bot's column with the site's icon, a title, "Secure
 * Form" and an Open pill; a centred dialog with the same header, labelled fields, a lock note naming
 * the host the values go to, and a Continue pill that stays disabled until the form is complete.
 *
 * Presentation only. Where a value goes, and that it never reaches the model, is each caller's
 * business (the sign-in form posts to the passwords service, a secret to the computer's own route).
 */

/** The pill every primary action in these cards uses. */
export const PILL_CLASS = "h-10 rounded-full px-5 text-[15px] font-medium";

/** The site's icon on a square tile, or a globe when there is none. */
export function SecureFormIcon({
  icon,
  fallback,
  className,
}: {
  /** A data URL read by the Bot's browser. Never a remote URL: the page must not fetch it. */
  icon?: string;
  fallback?: ReactNode;
  className?: string;
}) {
  const safe = icon?.startsWith("data:image/") ? icon : undefined;
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-background/70 text-muted-foreground dark:bg-muted",
        className,
      )}
    >
      {safe ? (
        <img alt="" className="size-8 object-contain" src={safe} />
      ) : (
        (fallback ?? <IconWorld className="size-5" />)
      )}
    </span>
  );
}

export type SecureFormState =
  | "open"
  | "preparing"
  | "submitted"
  | "expired"
  | "cancelled"
  | "failed";

/** The word for each way a request ends, in the conversation's language. */
const STATE_WORDS: Record<
  Exclude<SecureFormState, "open">,
  (ui: UiStrings) => string
> = {
  preparing: (ui) => ui.preparing,
  submitted: (ui) => ui.submitted,
  expired: (ui) => ui.expired,
  cancelled: (ui) => ui.cancelled,
  failed: (ui) => ui.notCompleted,
};

/**
 * The row in the conversation. While it is waiting on the person it offers Open; once answered it
 * says how it ended, in green when the values went in.
 */
export function SecureFormRow({
  title,
  subtitle,
  icon,
  fallbackIcon,
  state,
  onOpen,
  openLabel,
  doneLabel,
  children,
}: {
  title: string;
  subtitle?: string;
  icon?: string;
  fallbackIcon?: ReactNode;
  state: SecureFormState;
  onOpen?: () => void;
  openLabel?: string;
  /** The word for a finished request when "Submitted" is not what happened. */
  doneLabel?: string;
  /** A short line under the row: why it did not complete, say. */
  children?: ReactNode;
}) {
  const ui = useUiStrings();
  return (
    <div
      className="my-1 flex max-w-md flex-col gap-2 rounded-2xl bg-muted p-3 dark:bg-card"
      data-slot="secure-form-row"
      data-state={state}
    >
      <div className="flex items-center gap-3">
        <SecureFormIcon fallback={fallbackIcon} icon={icon} />
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium text-[15px] text-foreground">
            {title}
          </p>
          <p className="truncate text-muted-foreground text-sm">
            {subtitle ?? ui.secureForm}
          </p>
        </div>
        {state === "open" ? (
          <Button
            className={PILL_CLASS}
            onClick={onOpen}
            type="button"
            variant="secondary"
          >
            {openLabel ?? ui.open}
          </Button>
        ) : (
          <span
            className={cn(
              "shrink-0 px-2 font-medium text-sm",
              state === "submitted"
                ? "text-emerald-500"
                : "text-muted-foreground",
            )}
          >
            {state === "submitted" && doneLabel
              ? doneLabel
              : STATE_WORDS[state](ui)}
          </span>
        )}
      </div>
      {children ? (
        <div className="px-1 text-muted-foreground text-sm">{children}</div>
      ) : null}
    </div>
  );
}

/** The dialog the row opens: the same header, then whatever form the caller draws. */
export function SecureFormDialog({
  open,
  onOpenChange,
  title,
  subtitle,
  icon,
  fallbackIcon,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  subtitle?: string;
  icon?: string;
  fallbackIcon?: ReactNode;
  children: ReactNode;
}) {
  const ui = useUiStrings();
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-w-xl gap-6 rounded-3xl p-6">
        <div className="flex items-center gap-3 pr-10">
          <SecureFormIcon fallback={fallbackIcon} icon={icon} />
          <div className="min-w-0">
            <DialogTitle className="truncate font-medium text-[17px]">
              {title}
            </DialogTitle>
            <DialogDescription className="text-[15px]">
              {subtitle ?? ui.secureForm}
            </DialogDescription>
          </div>
        </div>
        {children}
      </DialogContent>
    </Dialog>
  );
}

/**
 * One labelled field. Passwords and codes are masked, with an eye to show what was typed; a code
 * field asks the keyboard for digits and the browser for the one-time code it may have received.
 */
export function SecureField({
  label,
  value,
  onChange,
  kind = "text",
  required = true,
  autoFocus,
  autoComplete,
  name,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  kind?: "text" | "password" | "code";
  required?: boolean;
  autoFocus?: boolean;
  autoComplete?: string;
  name?: string;
}) {
  const ui = useUiStrings();
  const id = useId();
  const [shown, setShown] = useState(false);
  const masked = kind !== "text";
  return (
    <div className="flex flex-col gap-2">
      <label className="text-[15px] text-foreground" htmlFor={id}>
        {label}
        {required ? <span aria-hidden="true">*</span> : null}
      </label>
      <div className="relative">
        <input
          autoCapitalize="none"
          autoComplete={
            autoComplete ??
            (kind === "password"
              ? "current-password"
              : kind === "code"
                ? "one-time-code"
                : "username")
          }
          autoCorrect="off"
          // biome-ignore lint/a11y/noAutofocus: the dialog exists to take this one value.
          autoFocus={autoFocus}
          className={cn(
            "h-12 w-full rounded-xl border border-input bg-background/40 px-4 text-[16px] text-foreground outline-none transition-[border-color,box-shadow] placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40",
            masked ? "pr-12" : null,
          )}
          id={id}
          inputMode={kind === "code" ? "numeric" : undefined}
          name={name}
          onChange={(event) => onChange(event.target.value)}
          required={required}
          spellCheck={false}
          type={masked && !shown ? "password" : "text"}
          value={value}
        />
        {masked ? (
          <button
            aria-label={shown ? ui.hideValue(label) : ui.showValue(label)}
            aria-pressed={shown}
            className="absolute top-1/2 right-3 flex size-8 -translate-y-1/2 items-center justify-center rounded-full text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/40"
            onClick={() => setShown((now) => !now)}
            type="button"
          >
            {shown ? (
              <IconEyeOff className="size-5" />
            ) : (
              <IconEye className="size-5" />
            )}
          </button>
        ) : null}
      </div>
    </div>
  );
}

/** The promise the dialog makes, naming where the values go. */
export function SecureNote({ host }: { host?: string }) {
  const ui = useUiStrings();
  return (
    <p className="flex items-start gap-2 text-muted-foreground text-sm">
      <IconLock aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      <span>{ui.lockNote(host)}</span>
    </p>
  );
}

/** The host of an origin, for the note and the default title. */
export function hostOf(origin: string | undefined): string | undefined {
  if (!origin) return undefined;
  try {
    return new URL(origin).host;
  } catch {
    return undefined;
  }
}
