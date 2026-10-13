import { useEffect, useState } from "react";
import { ToolLine } from "@/components/channels/tool-line";
import { AttachmentLightbox } from "@/components/channels/chat-transcript";
import { readPageFrame } from "@/lib/computers/screen";
import { hostOf } from "./secure-form";

/**
 * The Bot showing the person its screen: a picture of the page, in the conversation.
 *
 * Grok Bot posts the preview of a form as a screenshot before it asks whether to submit it, so the
 * decision is made on the page itself. This is that picture. It is kept on the server under the
 * tool call (`show-screen.ts`), so it is the same picture after a reload and in every tab, and a
 * click opens it full size in the transcript's lightbox.
 */

/** Pictures already read in this tab, so scrolling a long transcript does not fetch them again. */
const FRAMES = new Map<string, { frame: string; url: string } | null>();

export function ScreenShown({
  computerId,
  toolCallId,
  caption,
  result,
  running,
}: {
  computerId: string;
  toolCallId?: string;
  caption?: string;
  result: unknown;
  running: boolean;
}) {
  const outcome = readOutcome(result);
  const [frame, setFrame] = useState(() =>
    toolCallId ? FRAMES.get(toolCallId) : undefined,
  );

  useEffect(() => {
    if (!toolCallId || outcome?.ok !== true || frame !== undefined) return;
    let current = true;
    void readPageFrame(computerId, toolCallId).then((stored) => {
      const kept = stored ? { frame: stored.frame, url: stored.url } : null;
      FRAMES.set(toolCallId, kept);
      if (current) setFrame(kept);
    });
    return () => {
      current = false;
    };
  }, [computerId, toolCallId, outcome?.ok, frame]);

  if (running && !outcome) {
    return <ToolLine label="Showing you the screen" running />;
  }
  if (!outcome || outcome.ok === false) {
    return (
      <ToolLine detail={outcome?.reason} failed label="Showed you the screen" />
    );
  }
  const host = hostOf(frame?.url ?? outcome.url) ?? outcome.url;
  const label = caption?.trim() || `The screen at ${host}`;
  if (frame === null) {
    return (
      <ToolLine
        detail="The picture is no longer kept."
        label={`Showed you ${host}`}
      />
    );
  }
  return (
    <figure className="my-2 w-full max-w-2xl overflow-hidden rounded-2xl border border-border bg-card">
      {frame ? (
        <AttachmentLightbox
          className="w-full rounded-none"
          filename={label}
          url={`data:image/png;base64,${frame.frame}`}
        >
          <img
            alt={label}
            className="block h-auto w-full"
            src={`data:image/png;base64,${frame.frame}`}
          />
        </AttachmentLightbox>
      ) : (
        <div
          aria-label="Loading the picture"
          className="aspect-[16/10] w-full animate-pulse bg-muted"
          role="img"
        />
      )}
      <figcaption className="flex min-w-0 items-baseline gap-2 px-4 py-2.5 text-sm">
        {caption?.trim() ? (
          <span className="min-w-0 truncate font-medium">{caption.trim()}</span>
        ) : null}
        <span className="shrink-0 truncate text-muted-foreground">{host}</span>
      </figcaption>
    </figure>
  );
}

/** The tool's own result, as the handler returned it or as the transcript stored it (a string). */
function readOutcome(
  result: unknown,
): { ok: true; url: string } | { ok: false; reason?: string } | undefined {
  let value = result;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  if (!value || typeof value !== "object") return undefined;
  const { ok, url, reason } = value as Record<string, unknown>;
  if (ok === true && typeof url === "string") return { ok: true, url };
  if (ok === false)
    return {
      ok: false,
      ...(typeof reason === "string" ? { reason } : {}),
    };
  return undefined;
}
