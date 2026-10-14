import { randomUUID } from "node:crypto";
import {
  type SignInAttempt,
  signInResultForBot,
} from "../../../shared/sign-in-guidance";
import { type AuditStore, recordAuditEvent } from "../audit";
import type { ActionActor, ComputerGateway } from "../computer/gateway";
import type { SignInFillResult } from "../computer/schema";
import { decryptSecret, encryptSecret } from "../credentials";
import { sameSite } from "./site";
import {
  originOf,
  type PasswordStore,
  type SavedLoginView,
  type SignInMethod,
  SignInRefusedError,
  type SignInRequestRecord,
  type SignInRequestView,
  type SignInStatus,
} from "./types";

/**
 * The private sign-in request and the Passwords vault.
 *
 * A Bot calls `computer_request_sign_in` with a site. That opens a request here and nothing else: the
 * Bot learns a request id, the person is sent to a form that is not part of the conversation, and the
 * turn waits. The form answers one of four ways:
 *
 *  - typed: a username and password (and a code, when the site asks) go from the form to this
 *    service to the Bot's computer, which types them into the page itself;
 *  - saved: the person picks one of their saved logins for exactly this site. Choosing it in the form
 *    IS the confirmation Dot requires for using a saved login on a new sign-in: nothing here fills a
 *    saved login without that request from its owner;
 *  - takeover: the person takes the Bot's browser and signs in by hand;
 *  - cancel.
 *
 * The computer says how the page answered a typed login (`SignInFillResult.outcome`), and each answer
 * has its own path here:
 *  - signed-in: the request is signed in;
 *  - error: the site refused it. The request reopens, so the person can correct a mistyped password
 *    in the form that is still open, which shows the site's own message;
 *  - code-requested: the login went in and the site now wants a one-time code. The request ends, and
 *    the Bot is told to ask again on that page, where the form asks for the code alone;
 *  - push-approval: the site waits for the person to approve it on their phone. The request waits
 *    with it (up to five minutes), reading the page through the probe until it moves on, and the
 *    person's Continue reads it at once;
 *  - captcha: a security check only a person can pass. The person is handed the browser.
 *
 * Whatever happens, the Bot is told the outcome and never the credential. The audit rows say which
 * site, which request and how it was answered; they carry no username, password or code.
 */
export type SignInService = ReturnType<typeof createSignInService>;

export type SignInServiceDependencies = {
  store: PasswordStore;
  gateway: Pick<ComputerGateway, "signIn" | "requestHelp"> &
    Partial<Pick<ComputerGateway, "probeSignIn">>;
  /** The deployment's KEY_ENCRYPTION_KEY, the same one `credentials.ts` encrypts under. */
  encryptionKey: string;
  auditStore?: AuditStore;
  /**
   * The administrator's "password manager" switch, asked on every use. Absent means on.
   *
   * The admin capability toggles are a separate module; this is the seam they wire: when it answers
   * false, saved logins are neither offered nor saved, and the private form still works for typing a
   * login once.
   */
  passwordManagerEnabled?: (ownerUserId: string) => Promise<boolean>;
  /** Tell the owner there is a sign-in waiting, on their delivery channels. */
  notify?: (request: SignInRequestRecord) => Promise<void>;
  /** A request reached a final state. Resumes an unattended turn that was waiting on it. */
  onResolved?: (request: SignInRequestRecord) => Promise<void>;
  /** How long a request stays open. */
  ttlMs?: number;
  /** How long a site's approval on the person's phone is waited for. */
  approvalWaitMs?: number;
  /** How often the page is read while it waits for that approval. */
  approvalPollMs?: number;
};

const DEFAULT_TTL_MS = 15 * 60_000;
const APPROVAL_WAIT_MS = 5 * 60_000;
const APPROVAL_POLL_MS = 3_000;
const OPEN: readonly SignInStatus[] = ["pending", "taken_over"];
/**
 * How long one attempt may hold a request in `filling`. Past the computer's own sign-in backstop
 * (75s), so a live attempt is never reopened under itself; a server that died mid-fill leaves the
 * request this long and no longer.
 */
const FILLING_LEASE_MS = 120_000;
const FINAL: readonly SignInStatus[] = [
  "signed_in",
  "failed",
  "cancelled",
  "expired",
];
/** How many origins within one site a login may move on through. */
const MAX_MOVES = 2;

export function isFinalSignIn(status: SignInStatus) {
  return FINAL.includes(status);
}

/**
 * What the Bot is told when a request ends. The only thing about a sign-in that reaches a model.
 * Built in `shared/sign-in-guidance.ts`, so the open chat tells it the same.
 */
export function signInToolResult(request: SignInRequestRecord) {
  return signInResultForBot(request);
}

/**
 * A string with every credential it could contain removed.
 *
 * Belt and braces: nothing on the fill path is supposed to echo a value, but an error message from a
 * page or a browser is not something this module wrote, and it is about to be stored and shown.
 */
function scrub(text: string, secrets: (string | undefined)[]): string {
  let out = text;
  for (const secret of secrets) {
    if (!secret || secret.length < 3) continue;
    // As typed, and as a URL or a GET form would have encoded it.
    const encoded = encodeURIComponent(secret);
    for (const form of new Set([secret, encoded, encoded.replace(/%20/g, "+")]))
      out = out.split(form).join("[hidden]");
  }
  return out.slice(0, 500);
}

/**
 * A page's address as the Bot may be told it: origin and path only. The query and the fragment go,
 * because a login form sent by GET puts what was typed there (percent-encoded, which an exact match
 * would miss), and the path is decoded and scrubbed as well.
 */
function pageForBot(url: string, secrets: (string | undefined)[]) {
  try {
    const parsed = new URL(url);
    let path = parsed.pathname;
    try {
      path = decodeURIComponent(path);
    } catch {
      // A path that does not decode is scrubbed as it is.
    }
    return scrub(`${parsed.origin}${path}`, secrets);
  } catch {
    return undefined;
  }
}

/** What the person reads when the site refused what they typed. */
function refusedWords(pageMessage: string | undefined) {
  return pageMessage
    ? `Wrong password or code. The site says: “${pageMessage}”`
    : "Wrong password or code. The site did not accept it.";
}

function hostOf(origin: string) {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

export function createSignInService(deps: SignInServiceDependencies) {
  const { store, gateway, auditStore } = deps;
  const ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS;
  const approvalWaitMs = deps.approvalWaitMs ?? APPROVAL_WAIT_MS;
  const approvalPollMs = deps.approvalPollMs ?? APPROVAL_POLL_MS;
  const managerOn = async (owner: string) =>
    deps.passwordManagerEnabled ? deps.passwordManagerEnabled(owner) : true;
  /**
   * What the probe read for each open request: which fields the page wants, the site's icon, and the
   * site the Bot named when the form was elsewhere; and, once something was sent, how the page
   * answered. In memory only, beside the row rather than in it: it is presentation, it expires with
   * the request, and losing it on a restart only means the form shows its default fields and a globe.
   */
  type Remembered = {
    form?: "login" | "username" | "code";
    icon?: string;
    requestedOrigin?: string;
    title?: string;
    usernameLabel?: string;
    passwordLabel?: string;
    codeLabel?: string;
    attempt?: SignInAttempt;
    /** The origin the person was asked about before the login went on to another site. */
    movedFrom?: string;
    until: number;
  };
  const probed = new Map<string, Remembered>();
  const probeOf = (id: string) => {
    const entry = probed.get(id);
    if (entry && entry.until < Date.now()) {
      probed.delete(id);
      return undefined;
    }
    return entry;
  };
  const remember = (id: string, patch: Partial<Remembered>) => {
    probed.set(id, {
      ...(probeOf(id) ?? { until: Date.now() + ttlMs }),
      ...patch,
    });
  };
  /** Requests whose site waits for approval on the person's phone, and until when. */
  const approvals = new Map<string, { owner: string; until: number }>();
  /**
   * Requests this process is typing a login into right now. A fill holds its request from its claim
   * to its last answer, and nothing here reopens it under the fill (an expired lease read by a
   * poll), so a second fill, or a Cancel that does not stop the first, cannot happen in this process;
   * across processes the lease is renewed before every request to the computer, so it never runs out
   * under a live call.
   */
  const active = new Set<string>();

  async function audit(
    eventType:
      | "computer.sign_in_requested"
      | "computer.sign_in_completed"
      | "computer.sign_in_failed"
      | "computer.sign_in_cancelled"
      | "password.saved"
      | "password.deleted",
    actor: ActionActor,
    targetType: "computer" | "password",
    targetId: string,
    payload: Record<string, unknown>,
  ) {
    if (!auditStore) return;
    await recordAuditEvent(auditStore, {
      eventType,
      targetType,
      targetId,
      initiator: actor.initiator,
      ...(actor.userId ? { actorUserId: actor.userId } : {}),
      payload: { actor: actor.id, ...payload },
    });
  }

  /** The request, with an expired one closed on the way past. */
  async function load(owner: string, id: string) {
    const request = await store.request(owner, id);
    if (!request)
      throw new SignInRefusedError("There is no such sign-in request.", 404);
    if (
      request.status === "filling" &&
      !active.has(id) &&
      request.fillingUntil !== null &&
      request.fillingUntil <= new Date()
    ) {
      approvals.delete(id);
      const reopened = await store.transition(owner, id, ["filling"], {
        status: "pending",
        fillingUntil: null,
        outcome: "The last sign-in attempt did not finish. Try again.",
      });
      if (reopened) return load(owner, id);
      return (await store.request(owner, id)) ?? request;
    }
    if (OPEN.includes(request.status) && request.expiresAt <= new Date()) {
      const expired = await store.transition(owner, id, OPEN, {
        status: "expired",
        outcome: `Nobody signed in to ${request.origin} before the request expired. Do not ask for the login another way.`,
        resolvedAt: new Date(),
      });
      if (expired) {
        await resolved(expired);
        return expired;
      }
      return (await store.request(owner, id)) ?? request;
    }
    return request;
  }

  async function resolved(request: SignInRequestRecord) {
    approvals.delete(request.id);
    if (!deps.onResolved) return;
    const { attempt, movedFrom } = probeOf(request.id) ?? {};
    try {
      await deps.onResolved({
        ...request,
        ...(attempt ? { attempt } : {}),
        ...(movedFrom ? { movedFrom } : {}),
      });
    } catch (error) {
      // The outcome is recorded either way; a turn that could not be resumed is reported, not hidden.
      console.error(
        JSON.stringify({
          type: "sign-in-resume-failed",
          request: request.id,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  async function view(
    request: SignInRequestRecord,
  ): Promise<SignInRequestView> {
    const passwordManager = await managerOn(request.ownerUserId);
    const logins = passwordManager
      ? await store.logins(request.ownerUserId, request.origin)
      : [];
    const {
      continuation: _continuation,
      ownerUserId: _owner,
      ...rest
    } = request;
    const { until: _until, ...probe }: Partial<Remembered> =
      probeOf(request.id) ?? {};
    const approval = approvals.get(request.id);
    return {
      ...rest,
      passwordManager,
      savedLogins: logins.map((login) => ({
        id: login.id,
        username: login.username,
      })),
      ...Object.fromEntries(
        Object.entries(probe).filter(([, value]) => value !== undefined),
      ),
      ...(approval && request.status === "filling"
        ? { approvalUntil: new Date(approval.until).toISOString() }
        : {}),
    };
  }

  /** Save a login the site accepted, when the person asked to. */
  async function saveAccepted(
    owner: string,
    id: string,
    actor: ActionActor,
    origin: string,
    credential: { username?: string; password?: string },
  ) {
    if (!credential.username || !credential.password) return;
    const saved = await store.saveLogin({
      ownerUserId: owner,
      origin,
      username: credential.username,
      encryptedPassword: await encryptSecret(
        deps.encryptionKey,
        credential.password,
      ),
    });
    await audit("password.saved", actor, "password", saved.id, {
      site: origin,
      login: saved.id,
      request: id,
    });
  }

  /** A security check after the login: the person is handed the browser to pass it. */
  async function handOver(
    owner: string,
    id: string,
    actor: ActionActor,
    request: SignInRequestRecord,
  ) {
    const state = await gateway.requestHelp(
      request.botId,
      actor,
      `Pass the security check on ${hostOf(request.origin)} to finish signing in`,
      request.toolCallId ?? undefined,
    );
    return store.transition(owner, id, ["filling"], {
      status: "taken_over",
      fillingUntil: null,
      controlRequestId: state.request?.id ?? null,
      outcome:
        "The site showed a security check after the login. Pass it in the Bot's browser, then say you are done.",
    });
  }

  /** The login went in and the site now asks for a one-time code: the Bot asks again for it. */
  async function codeNext(owner: string, id: string, method: SignInMethod) {
    const current = await store.request(owner, id);
    const done = await store.transition(owner, id, ["filling"], {
      status: "failed",
      method,
      fillingUntil: null,
      outcome: `The login for ${current?.origin ?? "the site"} went in, and the site now asks for a one-time code. Call computer_request_sign_in again on this page now: the person will be asked for the code alone.`,
      resolvedAt: new Date(),
    });
    if (done) await resolved(done);
    return done;
  }

  /** Signed in: recorded, audited, and the Bot told. */
  async function signedIn(
    owner: string,
    id: string,
    actor: ActionActor,
    method: SignInMethod,
    page: string | undefined,
    extra: Record<string, unknown> = {},
  ) {
    const current = await store.request(owner, id);
    const done = await store.transition(owner, id, ["filling"], {
      status: "signed_in",
      method,
      fillingUntil: null,
      outcome: `Signed in to ${current?.origin ?? "the site"}${page ? `; the page is now ${page}` : ""}.`,
      resolvedAt: new Date(),
    });
    if (!done) return null;
    await audit("computer.sign_in_completed", actor, "computer", done.botId, {
      bot: done.botId,
      request: id,
      site: done.origin,
      method,
      ...extra,
    });
    await resolved(done);
    return done;
  }

  /**
   * Read the page of a request whose site waits for approval on the person's phone, and settle the
   * request once it has moved on: signed in, refused (back to the form), a code next, or a security
   * check. Past the wait, it ends with the approval that never came. Null while it still waits.
   *
   * The background watch and the person's Continue both call this; the transitions only ever move a
   * request out of `filling` once, so a race between them settles it once.
   */
  async function readApproval(
    owner: string,
    id: string,
    actor: ActionActor,
  ): Promise<SignInRequestRecord | null> {
    const waiting = approvals.get(id);
    const request = await store.request(owner, id);
    if (!waiting || !request || request.status !== "filling") {
      approvals.delete(id);
      return request;
    }
    let probe:
      | Awaited<ReturnType<NonNullable<typeof gateway.probeSignIn>>>
      | undefined;
    try {
      probe = await gateway.probeSignIn?.(request.botId);
    } catch {
      probe = undefined;
    }
    /*
     * Only the approved site's page answers this sign-in. A page that left it while waiting (another
     * tab came forward, the browser went somewhere else) cannot say the person approved anything:
     * the wait ends there, and the Bot is told to look for itself rather than told it is signed in.
     */
    if (probe?.origin && !sameSite(request.origin, probe.origin)) {
      approvals.delete(id);
      remember(id, { attempt: undefined });
      const left = await store.transition(owner, id, ["filling"], {
        status: "failed",
        fillingUntil: null,
        outcome: `While the person was asked to approve the sign-in on their phone, the page left ${request.origin} for ${probe.origin}. Take a fresh snapshot to see whether the sign-in went through before acting on it.`,
        resolvedAt: new Date(),
      });
      if (left) {
        await audit("computer.sign_in_failed", actor, "computer", left.botId, {
          bot: left.botId,
          request: id,
          site: left.origin,
          failure: "The page left the site while waiting for the approval.",
        });
        await resolved(left);
      }
      return left ?? (await store.request(owner, id));
    }
    const method = request.method ?? "typed";
    const outcome = probe?.check?.outcome;
    if (!outcome || outcome === "push-approval") {
      if (Date.now() < waiting.until) return null;
      approvals.delete(id);
      const done = await store.transition(owner, id, ["filling"], {
        status: "failed",
        fillingUntil: null,
        outcome: `${request.origin} asked the person to approve the sign-in on their phone or in an app, and no approval came within ${Math.round(approvalWaitMs / 60_000)} minutes. Tell them, and offer to ask again.`,
        resolvedAt: new Date(),
      });
      if (done) {
        await audit("computer.sign_in_failed", actor, "computer", done.botId, {
          bot: done.botId,
          request: id,
          site: done.origin,
          failure: "No approval arrived on the person's phone in time.",
        });
        await resolved(done);
      }
      return done ?? (await store.request(owner, id));
    }
    approvals.delete(id);
    // The credential is long gone, so nothing could scrub a page's message of it: none is kept.
    remember(id, {
      attempt: {
        ...probeOf(id)?.attempt,
        outcome,
      },
    });
    if (outcome === "signed-in")
      return (
        (await signedIn(owner, id, actor, method, undefined, {
          approved: true,
        })) ?? (await store.request(owner, id))
      );
    if (outcome === "code-requested")
      return (await codeNext(owner, id, method)) ?? store.request(owner, id);
    if (outcome === "captcha")
      return (
        (await handOver(owner, id, actor, request).catch(() => null)) ??
        (await store.transition(owner, id, ["filling"], {
          status: "pending",
          fillingUntil: null,
          outcome:
            "The site showed a security check. Sign in by hand to pass it.",
        })) ??
        (await store.request(owner, id))
      );
    const reopened = await store.transition(owner, id, ["filling"], {
      status: "pending",
      fillingUntil: null,
      outcome: refusedWords(undefined),
    });
    return reopened ?? (await store.request(owner, id));
  }

  /** Read the page again and again while its site waits for the person's approval. */
  function watchApproval(owner: string, id: string, actor: ActionActor) {
    approvals.set(id, { owner, until: Date.now() + approvalWaitMs });
    const tick = async () => {
      if (!approvals.has(id)) return;
      try {
        const settled = await readApproval(owner, id, actor);
        if (settled && settled.status !== "filling") return;
      } catch (error) {
        console.error(
          JSON.stringify({
            type: "sign-in-approval-check-failed",
            request: id,
            error: error instanceof Error ? error.name : "UnknownError",
          }),
        );
      }
      if (approvals.has(id)) setTimeout(tick, approvalPollMs).unref?.();
    };
    setTimeout(tick, approvalPollMs).unref?.();
  }

  /**
   * The login went on to another site than the one the person was shown: nothing is typed there.
   * The request goes back to the form, for the new host, with the page read afresh for its fields
   * and icon (the Bot's title and labels were for the other site), and the person decides there.
   * Returns the refusal the person sees; the Bot is told, when the request ends, that they were
   * asked again for the new host.
   */
  async function askAgainOn(
    claimed: SignInRequestRecord,
    to: string,
    actor: ActionActor,
    method: SignInMethod,
    loginId: string | undefined,
  ) {
    const { ownerUserId: owner, id } = claimed;
    let probe:
      | Awaited<ReturnType<NonNullable<typeof gateway.probeSignIn>>>
      | undefined;
    try {
      probe = await gateway.probeSignIn?.(claimed.botId);
    } catch {
      probe = undefined;
    }
    const fresh = probe?.origin === to ? probe : undefined;
    const host = hostOf(to);
    const before = probeOf(id);
    probed.set(id, {
      requestedOrigin: before?.requestedOrigin ?? claimed.origin,
      movedFrom: claimed.origin,
      form: fresh && fresh.form !== "none" ? fresh.form : "login",
      ...(fresh?.icon ? { icon: fresh.icon } : {}),
      title: `Sign in to ${host}`,
      until: before?.until ?? Date.now() + ttlMs,
    });
    const words =
      method === "saved"
        ? `The sign-in went on to ${host}. A saved login is only typed into the site it was saved for: enter the login for ${host} to carry on.`
        : `The sign-in went on to ${host}, a different site from ${hostOf(claimed.origin)}. Nothing was typed there. Check it is where you meant to sign in, and enter the login for ${host}.`;
    const reopened = await store.transition(owner, id, ["filling"], {
      origin: to,
      status: "pending",
      fillingUntil: null,
      outcome: words,
    });
    await audit("computer.sign_in_failed", actor, "computer", claimed.botId, {
      bot: claimed.botId,
      request: id,
      site: to,
      method,
      movedFrom: claimed.origin,
      ...(loginId ? { savedLogin: loginId } : {}),
      failure:
        "The sign-in went on to another site; the person is asked again for it.",
    });
    return new SignInRefusedError(words, reopened ? 409 : 400);
  }

  /**
   * The form turned out to be in a frame on a page of another site, which nothing is typed into.
   * The request ends, and the Bot is told to open the frame's own address as a page and ask again.
   */
  async function frameElsewhere(
    claimed: SignInRequestRecord,
    actor: ActionActor,
    method: SignInMethod,
    address: string,
  ) {
    const { ownerUserId: owner, id } = claimed;
    remember(id, { attempt: undefined });
    const done = await store.transition(owner, id, ["filling"], {
      status: "failed",
      method,
      fillingUntil: null,
      outcome: `The sign-in form is inside a frame on a page of another site, and a login is never typed into a frame another site controls, so nothing was typed. Open ${address} with computer_navigate as a page of its own, then call computer_request_sign_in again.`,
      resolvedAt: new Date(),
    });
    if (!done)
      throw new SignInRefusedError(
        "This sign-in request was closed while it was being entered.",
        409,
      );
    await audit("computer.sign_in_failed", actor, "computer", done.botId, {
      bot: done.botId,
      request: id,
      site: done.origin,
      method,
      failure: "The form is in a frame on another site's page; nothing typed.",
    });
    await resolved(done);
    return done;
  }

  /**
   * Type a login into the Bot's browser, and record how it went.
   *
   * The credential lives in this function's arguments and the requests to the computer. It is not
   * put on the row, the audit payload, the outcome or any thrown error.
   */
  async function fill(
    owner: string,
    id: string,
    actor: ActionActor,
    credential: { username?: string; password?: string; code?: string },
    method: "typed" | "saved",
    extra: { loginId?: string; save?: boolean },
  ): Promise<SignInRequestRecord> {
    const request = await load(owner, id);
    if (request.status !== "pending" || active.has(id))
      throw new SignInRefusedError(
        request.status === "filling" || active.has(id)
          ? "This sign-in is already being entered."
          : "This sign-in request is no longer open.",
        409,
      );
    // Refused before anything is typed: discovering this after the site accepted the login left the
    // request in `filling` for good.
    const saving =
      method === "typed" && extra.save === true && !!credential.username;
    if (saving && !(await managerOn(owner)))
      throw new SignInRefusedError(
        "Saving passwords is turned off for this workspace.",
        403,
      );
    const claimed = await store.transition(owner, id, ["pending"], {
      status: "filling",
      fillingUntil: new Date(Date.now() + FILLING_LEASE_MS),
    });
    if (!claimed)
      throw new SignInRefusedError(
        "This sign-in is already being entered.",
        409,
      );
    active.add(id);
    try {
      return await enter(claimed, actor, credential, method, extra, saving);
    } finally {
      active.delete(id);
    }
  }

  /** The claimed request's login, typed and answered. Only `fill` calls it, holding the request. */
  async function enter(
    claimed: SignInRequestRecord,
    actor: ActionActor,
    credential: { username?: string; password?: string; code?: string },
    method: "typed" | "saved",
    extra: { loginId?: string; save?: boolean },
    saving: boolean,
  ): Promise<SignInRequestRecord> {
    const { ownerUserId: owner, id } = claimed;
    const secrets = [credential.password, credential.username, credential.code];
    const fields = (form: "login" | "code") =>
      form === "code"
        ? { ...(credential.code ? { code: credential.code } : {}) }
        : {
            ...(credential.username ? { username: credential.username } : {}),
            ...(credential.password ? { password: credential.password } : {}),
            ...(credential.code ? { code: credential.code } : {}),
          };
    let origin = claimed.origin;
    let result: SignInFillResult | undefined;
    let failure: string | undefined;
    let crossed: string | undefined;
    let closed = false;
    let framed: string | undefined;
    try {
      result = await gateway.signIn(claimed.botId, {
        origin,
        ...fields("login"),
      });
      /*
       * A LOGIN THAT MOVES ON. A username step can send the browser to another origin for the
       * password (the site's own login host, or an identity provider). The computer types nothing on
       * an origin it was not given and reports where the login went (`movedTo`) instead.
       *
       * The person agreed to this login going to the site they were shown, and no further. A move
       * within that same site (`www.example.com` to `login.example.com`, see site.ts) continues with
       * the same login, the request now naming the origin it reached, which the form shows and the
       * audit records. A move to ANY other site stops here: the typed values are dropped, never
       * forwarded, and the form opens again for the new host, so the person sees where a login would
       * go and types it there or not at all. A saved login never moves: it is typed only into the
       * origin it was saved for.
       */
      for (
        let moves = 0;
        result.movedTo && !result.error && moves < MAX_MOVES;
        moves++
      ) {
        const to = originOf(result.movedTo.origin);
        if (method === "saved" || !sameSite(claimed.origin, to)) {
          crossed = to;
          break;
        }
        // The lease renewed with the move, and nothing more typed if the request was closed meanwhile
        // (the person cancelled, or it expired).
        const movedOn = await store.transition(owner, id, ["filling"], {
          origin: to,
          fillingUntil: new Date(Date.now() + FILLING_LEASE_MS),
        });
        if (!movedOn) {
          closed = true;
          break;
        }
        if (!probeOf(id)?.requestedOrigin)
          remember(id, { requestedOrigin: origin });
        origin = to;
        result = await gateway.signIn(claimed.botId, {
          origin,
          ...fields(result.movedTo.form),
        });
      }
      framed = result.openFrame;
      // A move to another site, a request closed under the fill, or a form in another site's frame
      // is answered below, typing nothing more.
      if (crossed || closed || framed) failure = undefined;
      else if (result.movedTo)
        failure =
          "The sign-in kept moving to other pages. Sign in by hand to finish.";
      else if (result.error) failure = scrub(result.error, secrets);
      else if (!result.submitted)
        failure = "The sign-in form could not be submitted.";
      else if (result.outcome === "error")
        failure = refusedWords(
          result.pageMessage
            ? scrub(result.pageMessage, secrets).slice(0, 200)
            : undefined,
        );
      else if (
        !result.outcome &&
        credential.password &&
        result.passwordFieldVisible
      )
        failure =
          "The site still shows a password field, so the login was probably not accepted.";
    } catch (error) {
      failure = scrub(
        error instanceof Error
          ? error.message
          : "The Bot's computer did not respond.",
        secrets,
      );
    }
    if (closed)
      throw new SignInRefusedError(
        "This sign-in request was closed while it was being entered.",
        409,
      );
    if (framed)
      return frameElsewhere(claimed, actor, method, scrub(framed, secrets));
    const page = result?.url ? pageForBot(result.url, secrets) : undefined;
    const pageMessage = result?.pageMessage
      ? scrub(result.pageMessage, secrets).slice(0, 200)
      : undefined;
    const rememberDevice = result?.rememberDeviceLeftUnchecked
      ? { rememberDeviceLeftUnchecked: true }
      : {};
    const moved =
      origin !== claimed.origin ? { movedFrom: claimed.origin } : {};
    if (crossed)
      throw await askAgainOn(claimed, crossed, actor, method, extra.loginId);
    if (failure) {
      if (
        result?.outcome === "error" ||
        (!result?.outcome && result?.passwordFieldVisible)
      )
        remember(id, {
          attempt: {
            outcome: "error",
            ...(pageMessage ? { pageMessage } : {}),
            ...rememberDevice,
          },
        });
      // Back to pending, so the person can correct a mistyped password. The Bot keeps waiting.
      const reopened = await store.transition(owner, id, ["filling"], {
        status: "pending",
        fillingUntil: null,
        outcome: failure,
      });
      await audit("computer.sign_in_failed", actor, "computer", claimed.botId, {
        bot: claimed.botId,
        request: id,
        site: origin,
        method,
        ...moved,
        ...(extra.loginId ? { savedLogin: extra.loginId } : {}),
        failure,
      });
      throw new SignInRefusedError(failure, reopened ? 409 : 400);
    }
    const outcome = result?.outcome ?? "signed-in";
    remember(id, { attempt: { outcome, ...rememberDevice } });
    if (method === "saved" && extra.loginId)
      await store.touchLogin(owner, extra.loginId);
    /*
     * The site accepted the password when it signed in, asked for a code next, or waits for an
     * approval on the phone, so that is when a requested save happens. Recorded, and the Bot told,
     * BEFORE the save: a save that fails afterwards must not leave the request stuck with the turn
     * waiting on it.
     */
    let done: SignInRequestRecord | null;
    if (outcome === "captcha") {
      done = await handOver(owner, id, actor, claimed).catch(() => null);
      if (!done) {
        const reopened = await store.transition(owner, id, ["filling"], {
          status: "pending",
          fillingUntil: null,
          outcome:
            "The site showed a security check. Sign in by hand to pass it.",
        });
        if (reopened) done = reopened;
      }
    } else if (outcome === "code-requested") {
      done = await codeNext(owner, id, method);
    } else if (outcome === "push-approval") {
      // Still being entered, for as long as the site waits for the person's phone.
      done = await store.transition(owner, id, ["filling"], {
        method,
        fillingUntil: new Date(Date.now() + approvalWaitMs + 60_000),
        outcome:
          "Waiting for the person to approve the sign-in on their phone.",
      });
      if (done) {
        if (gateway.probeSignIn) watchApproval(owner, id, actor);
        else {
          // Nothing can read the page while it waits, so the Bot is told now.
          done =
            (await store.transition(owner, id, ["filling"], {
              status: "failed",
              fillingUntil: null,
              outcome: `${done.origin} asks the person to approve the sign-in on their phone. Wait for them, take a snapshot, and carry on once the page has moved on.`,
              resolvedAt: new Date(),
            })) ?? done;
          if (isFinalSignIn(done.status)) await resolved(done);
        }
      }
    } else {
      done = await signedIn(owner, id, actor, method, page, {
        ...moved,
        ...(extra.loginId ? { savedLogin: extra.loginId } : {}),
      });
    }
    if (!done)
      throw new SignInRefusedError(
        "This sign-in request was closed while it was being entered.",
        409,
      );
    if (outcome === "code-requested")
      await audit("computer.sign_in_failed", actor, "computer", done.botId, {
        bot: done.botId,
        request: id,
        site: done.origin,
        method,
        ...moved,
        failure: "The site asks for a one-time code next.",
      });
    // A security check can stand in front of a password the site has not checked yet: no save then.
    if (saving && outcome !== "captcha") {
      try {
        // Under the origin the person was shown and agreed to, never one the login moved on to.
        await saveAccepted(owner, id, actor, claimed.origin, credential);
      } catch (error) {
        console.error(
          JSON.stringify({
            type: "password-save-failed",
            request: id,
            error: error instanceof Error ? error.name : "UnknownError",
          }),
        );
        throw new SignInRefusedError(
          "Your login went in, but it could not be saved. Save it again from Passwords.",
          // The request has moved on; only the optional save did not happen.
          409,
        );
      }
    }
    return done;
  }

  return {
    /** A Bot asking. Returns the record; the caller decides how the turn waits on it. */
    async request(input: {
      ownerUserId: string;
      botId: string;
      site: string;
      reason?: string;
      actor: ActionActor;
      threadId?: string;
      toolCallId?: string;
      continuation?: Record<string, unknown>;
      /** Send it to the owner's delivery channels. Unattended turns do; the open chat need not. */
      notify?: boolean;
      /** How the Bot titles the form and labels its fields, shown as given (trimmed, short). */
      title?: string;
      usernameLabel?: string;
      passwordLabel?: string;
      codeLabel?: string;
    }): Promise<SignInRequestRecord> {
      const requested = originOf(input.site);
      let origin = requested;
      /*
       * LOOK BEFORE ASKING. A Bot that asks on a page with no form on it (still on the service's
       * description page, before its "Sign in" button) had the person type a password into a form
       * that could only fail. The computer reads the page first: no form, and the Bot is told to open
       * the sign-in page and ask again; a form on another origin than the one named (a site that sends
       * its logins to an identity provider), and the request is for where the form really is, which
       * is the host the person is shown before typing. A computer that cannot be asked leaves today's
       * behaviour: the named origin, checked again at fill time.
       */
      let probe:
        | Awaited<ReturnType<NonNullable<typeof gateway.probeSignIn>>>
        | undefined;
      if (gateway.probeSignIn) {
        try {
          probe = await gateway.probeSignIn(input.botId);
        } catch {
          probe = undefined;
        }
      }
      if (probe?.form === "none")
        throw new SignInRefusedError(
          `There is no sign-in form on ${probe.host || "the page you have open"} yet. Open the site's sign-in page first (its own "Sign in" or "Log in" button, in whatever language the site uses), wait for the login fields to show, then ask again.`,
          409,
        );
      /*
       * A FORM IN ANOTHER SITE'S FRAME. The page around a frame controls it and can swap what it
       * holds between being read and being typed into, so the computer never types a login into a
       * frame on a page of another site. Nobody is asked for one: the Bot opens the frame's own
       * address as a page and asks again there.
       */
      if (probe?.frameUrl)
        throw new SignInRefusedError(
          `The sign-in form on ${hostOf(probe.url)} is inside a frame from ${probe.host || "another site"}, a different site, and a login is never typed into a frame another site controls. Open ${probe.frameUrl} with computer_navigate as a page of its own, then call computer_request_sign_in again.`,
          409,
        );
      if (probe?.origin) origin = probe.origin;
      const request = await store.createRequest({
        id: randomUUID(),
        ownerUserId: input.ownerUserId,
        botId: input.botId,
        origin,
        reason: input.reason?.trim().slice(0, 500) || null,
        threadId: input.threadId ?? null,
        toolCallId: input.toolCallId ?? null,
        continuation: input.continuation ?? null,
        expiresAt: new Date(Date.now() + ttlMs),
      });
      const short = (value: string | undefined, max: number) =>
        value?.trim().slice(0, max) || undefined;
      const shown = {
        title: short(input.title, 80),
        usernameLabel: short(input.usernameLabel, 40),
        passwordLabel: short(input.passwordLabel, 40),
        codeLabel: short(input.codeLabel, 60),
      };
      probed.set(request.id, {
        ...(probe ? { form: probe.form } : {}),
        ...(probe?.icon ? { icon: probe.icon } : {}),
        ...(origin !== requested ? { requestedOrigin: requested } : {}),
        ...shown,
        until: Date.now() + ttlMs,
      });
      await audit(
        "computer.sign_in_requested",
        input.actor,
        "computer",
        input.botId,
        {
          bot: input.botId,
          request: request.id,
          site: origin,
          ...(request.reason ? { reason: request.reason } : {}),
        },
      );
      if (input.notify && deps.notify) {
        try {
          await deps.notify(request);
        } catch (error) {
          console.error(
            JSON.stringify({
              type: "sign-in-notify-failed",
              request: request.id,
              error: error instanceof Error ? error.message : String(error),
            }),
          );
        }
      }
      return request;
    },

    async get(owner: string, id: string) {
      return view(await load(owner, id));
    },

    /** The raw record, for the resume path. Never returned by a route. */
    record: load,

    async pending(owner: string) {
      return Promise.all((await store.pendingRequests(owner)).map(view));
    },

    async submit(
      owner: string,
      id: string,
      actor: ActionActor,
      input: {
        username?: string;
        password?: string;
        code?: string;
        save?: boolean;
      },
    ) {
      // A page that asks for a one-time code alone takes the code without a password.
      if (!input.password && !input.code)
        throw new SignInRefusedError(
          probeOf(id)?.form === "code"
            ? "Enter the code."
            : "Enter the password for this site.",
        );
      return view(
        await fill(owner, id, actor, input, "typed", {
          save: input.save === true,
        }),
      );
    },

    /** The person confirming one of their saved logins for this sign-in. */
    async useSaved(
      owner: string,
      id: string,
      actor: ActionActor,
      input: { loginId: string; code?: string },
    ) {
      if (!(await managerOn(owner)))
        throw new SignInRefusedError(
          "Saved passwords are turned off for this workspace.",
          403,
        );
      const request = await load(owner, id);
      const login = await store.login(owner, input.loginId);
      // Exactly this origin. A login saved for one site is never offered to, or typed into, another.
      if (!login || login.origin !== request.origin)
        throw new SignInRefusedError(
          "That saved login is not for this site.",
          404,
        );
      const password = await decryptSecret(
        deps.encryptionKey,
        login.encryptedPassword,
      );
      return view(
        await fill(
          owner,
          id,
          actor,
          {
            username: login.username,
            password,
            ...(input.code ? { code: input.code } : {}),
          },
          "saved",
          { loginId: login.id },
        ),
      );
    },

    /**
     * The person saying they approved the sign-in on their phone: the page is read now rather than
     * at the next poll. A page still waiting leaves the request waiting.
     */
    async continueApproval(owner: string, id: string, actor: ActionActor) {
      const request = await load(owner, id);
      if (request.status !== "filling" || !approvals.has(id))
        throw new SignInRefusedError(
          "This sign-in is not waiting for an approval.",
          409,
        );
      await readApproval(owner, id, actor);
      return view(await load(owner, id));
    },

    /** Sign in by hand instead: hand the person the Bot's browser. */
    async takeOver(owner: string, id: string, actor: ActionActor) {
      const request = await load(owner, id);
      if (request.status !== "pending")
        throw new SignInRefusedError(
          "This sign-in request is no longer open.",
          409,
        );
      const state = await gateway.requestHelp(
        request.botId,
        actor,
        `Sign in to ${request.origin}${request.reason ? `: ${request.reason}` : ""}`,
        request.toolCallId ?? undefined,
      );
      const next = await store.transition(owner, id, ["pending"], {
        status: "taken_over",
        controlRequestId: state.request?.id ?? null,
      });
      if (!next)
        throw new SignInRefusedError(
          "This sign-in request is no longer open.",
          409,
        );
      return view(next);
    },

    /** After a takeover: the person says they are signed in. */
    async finishTakeover(owner: string, id: string, actor: ActionActor) {
      const done = await store.transition(owner, id, ["taken_over"], {
        status: "signed_in",
        method: "takeover",
        outcome:
          "The person signed in by hand. Take a fresh snapshot before acting on the page.",
        resolvedAt: new Date(),
      });
      if (!done)
        throw new SignInRefusedError(
          "Take over the browser before finishing.",
          409,
        );
      await audit("computer.sign_in_completed", actor, "computer", done.botId, {
        bot: done.botId,
        request: id,
        site: done.origin,
        method: "takeover",
      });
      await resolved(done);
      return view(done);
    },

    async cancel(owner: string, id: string, actor: ActionActor) {
      const current = await load(owner, id);
      // A request waiting on the person's phone can be declined too, and so can one being typed:
      // the fill then types nothing more (it renews its hold on the request before every step).
      const from: readonly SignInStatus[] =
        approvals.has(id) || active.has(id) ? [...OPEN, "filling"] : OPEN;
      const done = await store.transition(owner, id, from, {
        status: "cancelled",
        fillingUntil: null,
        outcome: `The person chose not to sign in to ${current.origin}. Do not ask for the login another way.`,
        resolvedAt: new Date(),
      });
      if (!done)
        throw new SignInRefusedError(
          "This sign-in request is no longer open.",
          409,
        );
      await audit("computer.sign_in_cancelled", actor, "computer", done.botId, {
        bot: done.botId,
        request: id,
        site: done.origin,
      });
      await resolved(done);
      return view(done);
    },

    async logins(owner: string): Promise<{
      passwordManager: boolean;
      logins: SavedLoginView[];
    }> {
      const passwordManager = await managerOn(owner);
      const rows = await store.logins(owner);
      return {
        passwordManager,
        logins: rows.map(
          ({ encryptedPassword: _secret, ownerUserId: _owner, ...rest }) =>
            rest,
        ),
      };
    },

    async deleteLogin(owner: string, id: string, actor: ActionActor) {
      const login = await store.login(owner, id);
      if (!login || !(await store.deleteLogin(owner, id)))
        throw new SignInRefusedError("There is no such saved login.", 404);
      await audit("password.deleted", actor, "password", id, {
        site: login.origin,
        login: id,
      });
      return { deleted: true };
    },
  };
}
