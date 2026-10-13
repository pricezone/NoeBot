import { tryClient } from "@/lib/client";

/**
 * One frame of a Bot's screen.
 *
 * Not a cached read. Frames are polled while somebody is watching and are stale the moment after
 * they arrive, so holding one in a query cache would mean serving a picture of a screen that has
 * since moved.
 */
export type Screenshot = {
  base64: string;
  width: number;
  height: number;
  capturedAt: string;
  /** `about:blank` when the browser has not been sent anywhere yet. Absent on older computers. */
  url?: string;
  /** A desktop frame is a JPEG. Absent, PNG. */
  format?: "png" | "jpeg";
};

/** The screen a computer draws, when it is a desktop rather than a page. */
export type Desktop = { width: number; height: number };

/** What `/status` tells the panel, read without starting the browser. */
export type ComputerStatusRead = {
  /** The desktop it draws, or `null` for a page (and for a computer that could not be asked). */
  desktop: Desktop | null;
  /**
   * Whether the Bot's browser is running. `undefined` when the computer could not say, which is
   * never read as stopped: only a computer that said so is drawn asleep.
   */
  browser?: "running" | "stopped";
};

/**
 * Whether this computer shows a desktop and whether its browser is running.
 *
 * Asked once per computer, not polled: a computer does not grow a desktop while somebody is
 * watching it, and the browser's state matters only for whether the panel opens asleep. A READ THAT
 * STARTS NOTHING, which is the point: a screenshot starts the browser, so a panel that asked one to
 * find out whether the browser was asleep would wake it. Unreachable is `{ desktop: null }`, and
 * the panel shows the page as it always has.
 */
export async function readComputerStatus(
  computerId: string,
): Promise<ComputerStatusRead> {
  try {
    const response = await tryClient(`/api/computers/${computerId}/status`);
    if (!response.ok) return { desktop: null };
    const body = (await response.json().catch(() => null)) as {
      desktop?: { width?: unknown; height?: unknown };
      browser?: unknown;
    } | null;
    const browser =
      body?.browser === "running" || body?.browser === "stopped"
        ? body.browser
        : undefined;
    const { width, height } = body?.desktop ?? {};
    const desktop =
      typeof width === "number" &&
      typeof height === "number" &&
      width > 0 &&
      height > 0
        ? { width, height }
        : null;
    return { desktop, ...(browser ? { browser } : {}) };
  } catch {
    return { desktop: null };
  }
}

/** Whether this computer shows a desktop, and how big it is. See `readComputerStatus`. */
export async function readDesktop(computerId: string): Promise<Desktop | null> {
  return (await readComputerStatus(computerId)).desktop;
}

/**
 * Read the current frame.
 *
 * Fails closed, and says why: the screen going unavailable is something the person watching needs
 * told, and it is not a reason to tear down the panel they are watching it in. The caller decides
 * whether to keep polling.
 */
export async function readScreenshot(
  computerId: string,
  { desktop = false }: { desktop?: boolean } = {},
): Promise<{ frame?: Screenshot; error?: string }> {
  const unavailable = "The screen is not available right now.";
  try {
    const response = await tryClient(
      `/api/computers/${computerId}/${desktop ? "desktop/screenshot" : "screenshot"}`,
    );
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as {
        error?: string;
      } | null;
      return { error: body?.error ?? unavailable };
    }
    return parseScreenshot(await response.json().catch(() => null));
  } catch {
    return { error: unavailable };
  }
}

function parseScreenshot(body: unknown): {
  frame?: Screenshot;
  error?: string;
} {
  const unavailable = "The screen is not available right now.";
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { error: unavailable };
  }
  const frame = (body as { frame?: unknown }).frame ?? body;
  if (!frame || typeof frame !== "object" || Array.isArray(frame)) {
    return { error: unavailable };
  }
  const { base64, width, height } = frame as {
    base64?: unknown;
    width?: unknown;
    height?: unknown;
  };
  // A mistyped frame used to reach `atob` in the viewer and throw there. Refused here instead.
  if (
    typeof base64 !== "string" ||
    !base64 ||
    typeof width !== "number" ||
    !Number.isFinite(width) ||
    width <= 0 ||
    typeof height !== "number" ||
    !Number.isFinite(height) ||
    height <= 0
  ) {
    return { error: unavailable };
  }
  return { frame: frame as Screenshot };
}

/** The frame a page was showing when a Bot opened it. */
export type PageFrame = { url: string; title: string | null; frame: string };

/**
 * What this turn had on screen when it opened its page, or nothing if it was never kept.
 *
 * Nothing here writes. The frame is taken on the server at the moment the navigation succeeds, which
 * is the only moment the screen is certainly showing the page that was asked for. Capturing it here
 * instead meant capturing it after the turn, from a computer other conversations are also driving,
 * and filing whatever it happened to show.
 */
export async function readPageFrame(
  computerId: string,
  toolCallId: string,
): Promise<PageFrame | null> {
  try {
    const response = await tryClient(
      `/api/computers/${computerId}/page-frame/${encodeURIComponent(toolCallId)}`,
    );
    if (!response.ok) return null;
    const body = (await response.json().catch(() => null)) as unknown;
    if (!body || typeof body !== "object" || Array.isArray(body)) return null;
    const frame = (body as { frame?: unknown }).frame;
    if (!frame || typeof frame !== "object" || Array.isArray(frame)) {
      return null;
    }
    const { frame: image } = frame as { frame?: unknown };
    if (typeof image !== "string" || !image) return null;
    return frame as PageFrame;
  } catch {
    // A missing picture is a smaller sentence, not a broken conversation.
    return null;
  }
}
