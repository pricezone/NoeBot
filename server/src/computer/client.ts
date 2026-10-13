import type { HandoffRequest } from "../../../shared/computer-control";
import type { NavigateResult } from "./schema";
import { checkNavigationTarget } from "./target";

/**
 * A page the Bot opened did not arrive before the navigation deadline.
 *
 * Not a missing element (nothing about refs is wrong) and not an unavailable computer (the computer
 * answered; the site did not). Its own class so the route can say so with its own status, and the
 * Bot is told to try again or try another page rather than to take a snapshot or wait for repairs.
 */
export class NavigationTimeoutError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "NavigationTimeoutError";
  }
}

/** The computer did not accept or answer a request. */
export class ComputerUnavailableError extends Error {
  constructor(
    reason: string,
    /**
     * Nothing answered at the address at all (the connection was refused), so the request cannot
     * have done anything there and asking the provider again and resending is safe.
     */
    readonly neverConnected = false,
  ) {
    super(reason);
    this.name = "ComputerUnavailableError";
  }
}

/**
 * A person pressed Stop and the action was aborted mid-flight.
 *
 * A subclass of `ComputerUnavailableError` on purpose: everything downstream that catches an
 * unavailable computer to tell the model still catches this unchanged. What it adds is a type the
 * gateway can see, so the audit row it writes is `computer.action_stopped` rather than
 * `computer.action_failed` -- a stop is not an outage, and a count of failures that includes every
 * Stop reports one where there was none.
 */
export class ComputerStoppedError extends ComputerUnavailableError {
  constructor(reason: string) {
    super(reason);
    this.name = "ComputerStoppedError";
  }
}

/** The requested element is not on the current page. */
export class ElementNotFoundError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "ElementNotFoundError";
  }
}

/**
 * Why an action on an element that IS on the page did not work.
 *
 * Covered (and by what), disabled, not a field you can type into, hidden, off-screen, slow, no such
 * option, no dialog to answer: each has its own next step, which the message says, and none of them
 * is "take a fresh snapshot", which is what every one of them used to be told. Answered 422 by the
 * routes: the request was understood and the page would not take it.
 */
export type ElementStateError = Error & {
  name: "ElementStateError";
  /** The computer's word for it: `covered`, `disabled`, `wrong_tool`, ... */
  problem: string;
  /** The tool that fits the element, when the Bot used the wrong one. */
  useTool?: string;
  /** A drop-down's options, so the Bot can choose one. */
  options?: string[];
  /** What is in front of the element, with the refs of its buttons where the snapshot has them. */
  coveredBy?: {
    label: string;
    consent: boolean;
    buttons: Array<{ name: string; ref?: string }>;
  };
};

export function elementStateError(
  reason: string,
  problem: string,
  extra: Pick<ElementStateError, "useTool" | "options" | "coveredBy"> = {},
): ElementStateError {
  return Object.assign(new Error(reason), {
    name: "ElementStateError" as const,
    problem,
    ...extra,
  });
}

export function isElementStateError(
  error: unknown,
): error is ElementStateError {
  return error instanceof Error && error.name === "ElementStateError";
}

/**
 * The site, not the computer, failed: its name does not resolve, it refused the connection, its
 * certificate is bad, the network rules blocked it. The computer is fine, so this is never an
 * unavailable computer (503), which sent the Bot waiting for a repair that was never coming.
 */
export type SiteError = Error & {
  name: "SiteError";
  problem: string;
  code?: string;
};

export function siteError(
  reason: string,
  problem: string,
  code?: string,
): SiteError {
  return Object.assign(new Error(reason), {
    name: "SiteError" as const,
    problem,
    ...(code ? { code } : {}),
  });
}

export function isSiteError(error: unknown): error is SiteError {
  return error instanceof Error && error.name === "SiteError";
}

/** What a page paused on a JavaScript dialog is showing. */
export type PageDialog = {
  type: "alert" | "confirm" | "prompt" | "beforeunload";
  message: string;
  defaultValue?: string;
  dismissed?: true;
};

/**
 * The page is paused on a dialog, so nothing else can run until `computer_dialog` answers it.
 * Answered 409, like the other "do something else first" conditions, with the dialog in the body.
 */
export type DialogOpenError = Error & {
  name: "DialogOpenError";
  dialog: PageDialog;
};

export function dialogOpenError(
  reason: string,
  dialog: PageDialog,
): DialogOpenError {
  return Object.assign(new Error(reason), {
    name: "DialogOpenError" as const,
    dialog,
  });
}

export function isDialogOpenError(error: unknown): error is DialogOpenError {
  return error instanceof Error && error.name === "DialogOpenError";
}

/**
 * A computer's error as one plain sentence: no Playwright "Call log", no colour codes.
 *
 * The computer already summarises its own errors; this is for one that has not been redeployed, so
 * the raw log never reaches the model or a person reading the transcript.
 */
export function summariseComputerError(detail: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: colour codes are control characters.
  let text = detail.replace(/\u001b\[[0-9;]*m/g, "");
  const log = text.search(/\n\s*(?:Call log:|=+ logs =+)/i);
  if (log >= 0) text = text.slice(0, log);
  return text
    .replace(/^(?:locator|page|frame|elementHandle)\.[A-Za-z]+:\s*/, "")
    .trim();
}

/** The navigation target is not permitted. */
export class NavigationRefusedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "NavigationRefusedError";
  }
}

/** The computer refused access to a path outside its workspace. */
export class WorkspaceRefusedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "WorkspaceRefusedError";
  }
}

/** The workspace request names a path or value that cannot be used. */
export class WorkspaceRequestError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "WorkspaceRequestError";
  }
}

/** The workspace has no file at the requested path. */
export class WorkspaceNotFoundError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "WorkspaceNotFoundError";
  }
}

/** The requested workspace file is larger than the download limit. */
export class WorkspaceTooLargeError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "WorkspaceTooLargeError";
  }
}

/** Raw bytes and their size, kept as a stream until the caller sends them onward. */
export type ComputerDownload = {
  body: ReadableStream<Uint8Array>;
  bytes: number;
};

/** The page changed after the caller received its element references. */
export class StaleSnapshotError extends Error {
  constructor(
    reason: string,
    readonly snapshotRequired = false,
  ) {
    super(reason);
    this.name = "StaleSnapshotError";
  }
}

/**
 * A person has the wheel, so the Bot's action was not carried out.
 *
 * Its own condition rather than a stale snapshot, though both arrive as 409, because what the caller
 * should do next is the opposite in each case. Stale refs mean take a fresh snapshot and go again;
 * this means stop and leave the browser to the person holding it. Told apart by the flag the computer
 * puts on the body, which is the only thing in the response that distinguishes them.
 */
export class HumanHasControlError extends Error {
  constructor(
    reason: string,
    readonly requestId?: string,
    readonly handoff?: HandoffRequest,
  ) {
    super(reason);
    this.name = "HumanHasControlError";
  }
}

/** Invalid, unknown, or superseded handoff identity is distinct from page freshness. */
export class HandoffRequestError extends Error {
  constructor(
    reason: string,
    readonly status: 400 | 404 | 409,
  ) {
    super(reason);
    this.name = "HandoffRequestError";
  }
}

/**
 * Transport options used inside the computer gateway.
 *
 * This is an internal seam. Application code uses ComputerGateway and does not
 * use this interface directly.
 */
export type ComputerTransportOptions = {
  token?: string;
  allowPrivateHosts?: boolean;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

/** Internal HTTP interface used only by ComputerGateway. */
export interface ComputerTransport {
  call<T>(
    baseUrl: string,
    botId: string,
    path: string,
    init?: RequestInit,
    caller?: AbortSignal,
    /** Overrides the transport's own deadline for this one call. */
    timeoutMs?: number,
  ): Promise<T>;
  post<T>(
    baseUrl: string,
    botId: string,
    path: string,
    payload: unknown,
    caller?: AbortSignal,
    /** Overrides the transport's own deadline for this one call. */
    timeoutMs?: number,
  ): Promise<T>;
  navigate(
    baseUrl: string,
    botId: string,
    url: string,
    toolCallId?: string,
  ): Promise<NavigateResult>;
  download(
    baseUrl: string,
    botId: string,
    path: string,
    caller?: AbortSignal,
    timeoutMs?: number,
  ): Promise<ComputerDownload>;
}

/**
 * Send authenticated HTTP requests to one located agent-computer process.
 *
 * Lifecycle and location are deliberately absent. ComputerGateway owns those
 * operations through ComputerProvider.
 */
export function createComputerTransport(
  options: ComputerTransportOptions,
): ComputerTransport {
  const doFetch = options.fetchImpl ?? fetch;
  const defaultTimeoutMs = options.timeoutMs ?? 45_000;

  async function request(
    baseUrl: string,
    botId: string,
    path: string,
    init?: RequestInit,
    caller?: AbortSignal,
    timeoutMsOverride?: number,
  ): Promise<Response> {
    if (caller?.aborted) {
      throw new ComputerStoppedError("The action was stopped.");
    }

    /*
     * A browser action either happens in seconds or has gone wrong, so 45s is the right deadline for
     * it. A command is not that: the shell's own budget is 120s by default and up to 600s, and the
     * tool description tells the model to install packages. Giving up here first reported failure to
     * the person while the command carried on running to completion inside the container, and made
     * the shell's own limit unreachable. A caller with a longer limit of its own passes it in, and
     * this becomes the backstop rather than the limit.
     */
    const timeoutMs = timeoutMsOverride ?? defaultTimeoutMs;
    const target = baseUrl.replace(/\/$/, "");
    let response: Response;
    try {
      response = await doFetch(`${target}${path}`, {
        ...init,
        headers: {
          ...(init?.headers as Record<string, string> | undefined),
          "x-openbot-bot-id": botId,
          ...(options.token
            ? { "x-openbot-computer-token": options.token }
            : {}),
        },
        signal: caller
          ? AbortSignal.any([caller, AbortSignal.timeout(timeoutMs)])
          : AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      /*
       * The caller's own abort is answered first, and says what the check above the fetch says.
       *
       * The signal is handed to fetch precisely so a Stop can land mid-flight, and a fetch aborted
       * that way rejects with an AbortError, which is neither a TimeoutError nor a computer that is
       * not running. Both of the other answers are statements about the infrastructure, and this
       * message is not only read by the model: the gateway writes it into the action's audit row,
       * and the type below is what keeps that row a stop rather than an outage.
       */
      if (caller?.aborted) {
        throw new ComputerStoppedError("The action was stopped.");
      }
      const refused =
        (error as { code?: unknown } | null)?.code === "ConnectionRefused" ||
        /ECONNREFUSED|ConnectionRefused|Unable to connect/i.test(String(error));
      throw new ComputerUnavailableError(
        error instanceof Error && error.name === "TimeoutError"
          ? "The assistant's computer did not respond in time."
          : "The assistant's computer is not running.",
        refused,
      );
    }
    return response;
  }

  async function call<T>(
    baseUrl: string,
    botId: string,
    path: string,
    init?: RequestInit,
    caller?: AbortSignal,
    timeoutMsOverride?: number,
  ): Promise<T> {
    const response = await request(
      baseUrl,
      botId,
      path,
      init,
      caller,
      timeoutMsOverride,
    );
    const body = (await response.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!response.ok) {
      throwMappedError(response.status, body);
    }
    return body as T;
  }

  async function download(
    baseUrl: string,
    botId: string,
    path: string,
    caller?: AbortSignal,
    timeoutMs?: number,
  ): Promise<ComputerDownload> {
    const response = await request(
      baseUrl,
      botId,
      path,
      { method: "GET" },
      caller,
      timeoutMs,
    );
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as Record<
        string,
        unknown
      > | null;
      throwMappedError(response.status, body);
    }

    const length = response.headers.get("content-length");
    const bytes =
      length !== null && /^\d+$/.test(length) ? Number(length) : Number.NaN;
    if (!response.body || !Number.isSafeInteger(bytes) || bytes < 0) {
      throw new ComputerUnavailableError(
        "The assistant's computer returned an invalid file download.",
      );
    }
    return { body: response.body, bytes };
  }

  function post<T>(
    baseUrl: string,
    botId: string,
    path: string,
    payload: unknown,
    caller?: AbortSignal,
    timeoutMs?: number,
  ): Promise<T> {
    return call<T>(
      baseUrl,
      botId,
      path,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      },
      caller,
      timeoutMs,
    );
  }

  async function navigate(
    baseUrl: string,
    botId: string,
    url: string,
    toolCallId?: string,
  ): Promise<NavigateResult> {
    const verdict = checkNavigationTarget(url, {
      allowPrivateHosts: options.allowPrivateHosts,
    });
    if (!verdict.allowed) {
      throw new NavigationRefusedError(verdict.reason);
    }
    return post<NavigateResult>(baseUrl, botId, "/navigate", {
      url: verdict.url,
      ...(toolCallId ? { toolCallId } : {}),
    });
  }

  return { call, post, navigate, download };
}

/** Map agent-computer responses to errors that a caller can act on. */
function throwMappedError(
  status: number,
  body: Record<string, unknown> | null,
): never {
  const raw = typeof body?.error === "string" ? body.error : `HTTP ${status}`;
  if (
    body?.controlRequestError === true &&
    (status === 400 || status === 404 || status === 409)
  )
    throw new HandoffRequestError(raw, status);
  /*
   * A navigation that missed its deadline, read before the call log is cut away: it is the log that
   * says "page.goto". Not a missing element (nothing about refs is wrong) and not an unavailable
   * computer (the computer answered; the site did not).
   */
  if (/^page\.goto: Timeout \d+ms exceeded/i.test(raw))
    throw new NavigationTimeoutError(
      "The page did not load in time. Try it again, or try another page.",
    );
  const detail = summariseComputerError(raw);
  if (status === 409) {
    // The computer says which kind of 409 this is. Absent, it is the ordinary one.
    if (body?.humanHasControl === true) {
      throw new HumanHasControlError(
        detail,
        typeof body.requestId === "string" ? body.requestId : undefined,
        body.handoff && typeof body.handoff === "object"
          ? (body.handoff as HandoffRequest)
          : undefined,
      );
    }
    if (body?.dialog && typeof body.dialog === "object")
      throw dialogOpenError(detail, body.dialog as PageDialog);
    throw new StaleSnapshotError(detail, body?.snapshotRequired === true);
  }
  if (status === 422) {
    throw elementStateError(
      detail,
      typeof body?.problem === "string" ? body.problem : "unusable",
      {
        ...(typeof body?.useTool === "string" ? { useTool: body.useTool } : {}),
        ...(Array.isArray(body?.options)
          ? {
              options: (body.options as unknown[]).filter(
                (option): option is string => typeof option === "string",
              ),
            }
          : {}),
        ...(body?.coveredBy && typeof body.coveredBy === "object"
          ? { coveredBy: body.coveredBy as ElementStateError["coveredBy"] }
          : {}),
      },
    );
  }
  if (body?.siteError && typeof body.siteError === "object") {
    const site = body.siteError as { problem?: unknown; code?: unknown };
    throw siteError(
      detail,
      typeof site.problem === "string" ? site.problem : "network",
      typeof site.code === "string" ? site.code : undefined,
    );
  }
  if (status === 403) {
    throw new WorkspaceRefusedError(detail);
  }
  if (status === 400) {
    throw new WorkspaceRequestError(detail);
  }
  if (status === 404) {
    throw new WorkspaceNotFoundError(detail);
  }
  if (status === 413) {
    throw new WorkspaceTooLargeError(detail);
  }
  /*
   * An older computer's raw Playwright error about an element. The call log says which case it is:
   * a ref that never resolved is not on the page (take a fresh snapshot); one that resolved and then
   * could not be acted on is on the page and blocked, which a fresh snapshot does not fix.
   */
  if (/waiting for locator|aria-ref=/i.test(raw)) {
    const ref = raw.match(/aria-ref=([A-Za-z0-9_-]+)/)?.[1];
    const named = ref ? `Element ${ref}` : "That element";
    if (
      !/locator resolved to/i.test(raw) ||
      /not attached|detached|not connected/i.test(raw)
    )
      throw new ElementNotFoundError(
        `${named} is not on the page any more. Take a fresh snapshot and use the refs from it.`,
      );
    const covering = raw.match(
      /(<[a-z][^>]{0,120}>)[^\n]{0,80}?intercepts pointer events/i,
    );
    if (covering)
      throw elementStateError(
        `${named} is covered by ${covering[1]}, so a click would land on that instead. Close or answer what is in front of it, then try again.`,
        "covered",
      );
    if (/element is not enabled|element is disabled/i.test(raw))
      throw elementStateError(
        `${named} is disabled. It usually becomes available once the form's required fields are filled in.`,
        "disabled",
      );
    if (/element is not editable/i.test(raw))
      throw elementStateError(
        `${named} cannot be typed into. If it is a drop-down use computer_select; if it is a checkbox use computer_check.`,
        "not_editable",
      );
    if (/element is not visible/i.test(raw))
      throw elementStateError(
        `${named} is on the page but hidden. It may appear once a menu, tab or section is opened.`,
        "not_visible",
      );
    throw elementStateError(
      `${named} did not become ready in time. Read the page or take a screenshot to see what it is waiting for.`,
      "timeout",
    );
  }
  throw new ComputerUnavailableError(detail);
}
