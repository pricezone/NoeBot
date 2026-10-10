import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

/**
 * A small dialog that asks for one name: a new section, a section renamed, a Bot renamed.
 *
 * The three are the same question, so they are one dialog. `onSubmit` does the work and throws to
 * refuse; the refusal's sentence is shown under the field and the dialog stays open, because a
 * dialog that closes on a failed save reads as a save that worked. `validate` answers a sentence
 * for a name that should not be sent at all, or null.
 *
 * Mounted only while open, by the callers, so every opening starts from `initialName` rather than
 * from whatever was typed and abandoned last time.
 */
export function NameDialog({
  title,
  description,
  label,
  initialName = "",
  submitLabel,
  maxLength,
  validate,
  onSubmit,
  onClose,
}: {
  title: string;
  description?: string;
  /** The field's accessible name. */
  label: string;
  initialName?: string;
  submitLabel: string;
  maxLength?: number;
  validate?: (name: string) => string | null;
  onSubmit: (name: string) => Promise<void>;
  onClose: () => void;
}) {
  const [name, setName] = useState(initialName);
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const trimmed = name.trim();

  const submit = async () => {
    const refusal = trimmed ? (validate?.(trimmed) ?? null) : null;
    if (!trimmed || refusal) {
      setProblem(refusal);
      return;
    }
    setPending(true);
    setProblem(null);
    try {
      await onSubmit(trimmed);
    } catch (thrown) {
      setPending(false);
      setProblem(
        thrown instanceof Error ? thrown.message : "That did not save.",
      );
      return;
    }
    // Closing unmounts this dialog, so nothing is set after it.
    onClose();
  };

  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      open
    >
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? (
            <DialogDescription>{description}</DialogDescription>
          ) : null}
        </DialogHeader>
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <Input
            aria-invalid={problem ? true : undefined}
            aria-label={label}
            autoFocus
            maxLength={maxLength}
            onChange={(event) => setName(event.target.value)}
            value={name}
          />
          {problem ? (
            <p className="text-destructive text-sm" role="alert">
              {problem}
            </p>
          ) : null}
          <DialogFooter>
            <Button onClick={onClose} size="sm" type="button" variant="ghost">
              Cancel
            </Button>
            <Button disabled={pending || !trimmed} size="sm" type="submit">
              {pending ? "Saving…" : submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
