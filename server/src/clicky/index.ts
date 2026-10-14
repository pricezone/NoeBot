/**
 * Clicky Mode on the server: one object the rest of the server talks to.
 *
 * `server/src/index.ts` builds this once and hands it its seams: the gateway's handover events,
 * in-run suspensions, runs starting and ending, the person's clicks on the live viewer, a phone being
 * linked. `app.ts` mounts its routes. Everything else (sessions, the model call, guardrails, actions,
 * activation, the event hub) lives beside this file, so the server's hot files carry only one line
 * per seam and an upstream merge touches as little of Clicky as possible.
 *
 * Every seam is fire-and-forget from the caller's side: Clicky failing must never cost a handover, a
 * run, a frame or a sign-in. `enabled` is false when `CLICKY_MODE=off`; the routes are then not
 * mounted and every seam is a no-op.
 *
 * See docs/clicky-mode-plan.md.
 */
import { randomUUID } from "node:crypto";
import type { Hono, MiddlewareHandler } from "hono";
import { and, gt, inArray } from "drizzle-orm";
import type {
  ClickyNotice,
  ClickySession,
  ClickyTrigger,
  ClickyTriggerKind,
} from "../../../shared/clicky";
import type { Locale } from "../../../shared/i18n/locales";
import { clickyPreferencesOf } from "../../../shared/user-preferences";
import { computerAccessCheck } from "../agents/computer-access";
import type { AgentProfileStore } from "../agents/profile-store";
import type { AuditStore } from "../audit";
import { type AppVariables, createRoleRepository } from "../auth/guards";
import type { MobileLinkedInput } from "../auth/signin-handoff";
import type {
  ComputerControlEvent,
  ComputerGateway,
} from "../computer/gateway";
import type { HeadlessWait } from "../computer/headless-tools";
import type { DeploymentConfig } from "../config";
import type { RuntimeModel } from "../copilot";
import type { Database } from "../db/client";
import { sessions as authSessions } from "../db/schema";
import type { ExpoPushTransport } from "../delivery/push";
import { interfaceLocaleOf } from "../i18n/bot-language";
import { serverText } from "../i18n/server-text";
import { createMobileWiring, type MobileWiring } from "../mobile";
import { createVisionCompleter, type VisionRequest } from "../routing/model";
import type { UserPreferencesStore } from "../user-preferences";
import { createClickyActions } from "./actions";
import { createClickyActivation, type NeedsYou } from "./activation";
import { createClickyBrain } from "./brain";
import {
  type ClickyActivityListener,
  createClickyHub,
  notifyClickyActivity,
  startClickyActivityListener,
} from "./hub";
import { createClickyRoutes } from "./routes";
import type { ClickyGuideInput } from "./schema";
import { createSocketSessions } from "./socket-sessions";
import { type ClickyPreferences, createClickyService } from "./service";
import { type ClickyStore, createClickyStore } from "./store";

export type ClickyDependencies = {
  config: DeploymentConfig;
  database: Database;
  /** For LISTEN/NOTIFY, so every replica hears every session change. */
  databaseUrl: string;
  /** The computers. Absent, there is nothing for Clicky to guide on, and only phones are linked. */
  gateway?: ComputerGateway;
  auditStore: AuditStore;
  agentProfileStore: AgentProfileStore;
  userPreferences: UserPreferencesStore;
  /** The deployment's own model and key, for Clicky's look-and-answer calls. */
  model: RuntimeModel;
  resolveApiKey: () => Promise<string | null>;
  /** Native push, for "Noë Bot needs you" on the person's linked phones. Absent sends nothing. */
  push?: ExpoPushTransport;
  /** Where sessions are kept. Absent, the database, announced to every replica through NOTIFY. */
  store?: ClickyStore;
  /** The linked phones. Absent, built on the database. */
  mobile?: MobileWiring;
  /** Who may use a Bot's computer. Absent, the computer routes' own check, with the person's role. */
  canUseComputer?: (userId: string, botId: string) => Promise<boolean>;
  /** The model call, for a test. Absent, the deployment's model (`CLICKY_MODEL` to choose another). */
  complete?: (request: VisionRequest) => Promise<string>;
  environment?: NodeJS.ProcessEnv;
};

type AppRoutes = Hono<{ Variables: AppVariables }>;

export type ClickyWiring = {
  readonly enabled: boolean;
  /**
   * Mounted inside the computer router, after its `/:botId/*` guard, so every Clicky route is
   * already scoped to a Bot the person may use: `/api/computers/:botId/clicky/...`.
   */
  computerRoutes(): AppRoutes | undefined;
  /**
   * `/api/mobile/...`: a person's linked phones. Always there, Clicky or not: the phone app is the
   * whole of Noë Bot on a phone.
   */
  mobileRoutes(
    requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
  ): AppRoutes | undefined;
  /** A handover moment, from the gateway (`onControlEvent`). */
  onControlEvent(event: ComputerControlEvent): void;
  /** An in-run tool suspended its run, waiting on the person (`onWaiting` in index.ts). */
  onWaiting(input: { userId: string; botId: string; wait: HeadlessWait }): void;
  /** A run took or gave back a thread's lock. */
  onRunBusy(input: {
    threadId: string;
    busy: boolean;
    userId?: string;
    agentId?: string;
  }): void;
  /**
   * A message the person's live viewer sent toward the computer (raw JSON as relayed), with the size
   * of the last frame that viewer was sent, so a click can be placed on Clicky's normalized screen.
   */
  onViewerInput(input: {
    userId: string;
    botId: string;
    raw: string;
    frame?: { width: number; height: number };
  }): void;
  /** A phone was linked through the HyperNoesis app; records it and answers its id. Always works. */
  onMobileLinked(input: MobileLinkedInput): Promise<{ deviceId: string }>;
  /**
   * The Bot's `computer_guide_person`, run on the server: installs its walkthrough on the person's
   * Clicky, pointed at the elements its refs name.
   */
  guide(input: { userId: string; botId: string } & ClickyGuideInput): Promise<{
    session: ClickySession;
    pointed: number;
    missing: string[];
    /** Why the walkthrough was not installed: Clicky was busy acting. */
    rejected?: ClickyNotice;
  }>;
  /** Starts timers and the NOTIFY listener. */
  start(): Promise<void>;
  stop(): Promise<void>;
};

/** Whether Clicky is switched on for this deployment (`CLICKY_MODE`, on unless `off`). */
export function clickyEnabled(environment: NodeJS.ProcessEnv): boolean {
  const value = environment.CLICKY_MODE?.trim().toLowerCase();
  return !(value === "off" || value === "false" || value === "0");
}

/**
 * Where the person clicked on the live screen, normalized, from a viewer's raw input message: only a
 * mouse button going down, and only with the size of the frame it was placed on. Everything else (a
 * pointer moving, a key, text) is not Clicky's business and is left unparsed.
 */
export function viewerClick(
  raw: string,
  frame: { width: number; height: number } | undefined,
): { x: number; y: number } | null {
  if (!frame || !(frame.width > 0 && frame.height > 0)) return null;
  // Cheap first: most of what a viewer sends is the pointer moving.
  if (!raw.includes('"pressed"') || !raw.includes('"mouse"')) return null;
  let message: unknown;
  try {
    message = JSON.parse(raw);
  } catch {
    return null;
  }
  const value = message as Record<string, unknown> | null;
  if (
    value?.type !== "mouse" ||
    value.event !== "pressed" ||
    typeof value.x !== "number" ||
    typeof value.y !== "number" ||
    !Number.isFinite(value.x) ||
    !Number.isFinite(value.y)
  )
    return null;
  return {
    x: Math.min(1, Math.max(0, value.x / frame.width)),
    y: Math.min(1, Math.max(0, value.y / frame.height)),
  };
}

/** The fixed line a phone's lock screen shows: what kind of help, never the Bot's own words. */
const NEEDS_YOU_BODY: Record<ClickyTriggerKind, string> = {
  takeover: "Noë Bot needs your help on its computer.",
  sign_in: "Noë Bot needs you to sign in.",
  secret: "Noë Bot needs you to enter a password or a code.",
  challenge: "Noë Bot needs you to finish a check on a website.",
  approval: "Noë Bot needs you to do a step yourself.",
  person: "Open Clicky to see what to do.",
  follow_up: "Open Clicky to see what to do.",
};

/**
 * What "Noë Bot needs you" says on the person's phone: a title and a fixed line for the kind of help,
 * in their language. Never the Bot's own words, which are written by a model that may have read a
 * hostile page, and would sit on a lock screen for anybody to read; those stay in the app.
 */
export function needsYouText(
  trigger: Pick<ClickyTrigger, "kind">,
  locale: Locale | null,
): { title: string; body: string } {
  return {
    title: serverText(locale, "Noë Bot needs you"),
    body: serverText(locale, NEEDS_YOU_BODY[trigger.kind]),
  };
}

export function createClickyWiring(deps: ClickyDependencies): ClickyWiring {
  const environment = deps.environment ?? process.env;
  // The phones, always: linking one never depends on Clicky or on a computer.
  const mobile =
    deps.mobile ??
    createMobileWiring({
      database: deps.database,
      auditStore: deps.auditStore,
      agentProfileStore: deps.agentProfileStore,
      config: deps.config,
    });
  const gateway = deps.gateway;
  const enabled = Boolean(gateway) && clickyEnabled(environment);
  const clicky = gateway && enabled ? buildClicky(deps, gateway, mobile) : null;
  let listener: ClickyActivityListener | undefined;

  return {
    enabled,
    computerRoutes() {
      return clicky?.routes();
    },
    mobileRoutes(requireUser) {
      return mobile.routes(requireUser);
    },
    onControlEvent(event) {
      clicky?.onControlEvent(event);
    },
    onWaiting(input) {
      clicky?.activation.onWaiting(input);
    },
    onRunBusy(input) {
      clicky?.activation.onRunBusy(input);
    },
    onViewerInput({ userId, botId, raw, frame }) {
      if (!clicky) return;
      const at = viewerClick(raw, frame);
      if (at) clicky.service.personInput(userId, botId, at);
    },
    onMobileLinked(input) {
      return mobile.onMobileLinked(input);
    },
    async guide({ userId, botId, ...input }) {
      if (!clicky)
        throw new Error("Clicky is not available on this deployment.");
      // The run's person, on this Bot's computer: the same question the computer routes ask.
      if (!(await clicky.canUseComputer(userId, botId)))
        throw new Error("This person cannot use that Bot's computer.");
      return clicky.service.guide(userId, botId, input);
    },
    async start() {
      if (!clicky) return;
      clicky.service.start();
      clicky.sessions.start();
      if (!deps.store)
        listener = await startClickyActivityListener(
          deps.databaseUrl,
          clicky.hub,
        );
    },
    async stop() {
      clicky?.service.stop();
      clicky?.sessions.stop();
      await listener?.stop();
      listener = undefined;
    },
  };
}

/** Clicky itself: built only where it is switched on and there is a computer to guide on. */
function buildClicky(
  deps: ClickyDependencies,
  gateway: ComputerGateway,
  mobile: MobileWiring,
) {
  const environment = deps.environment ?? process.env;
  const store = deps.store ?? createClickyStore(deps.database);
  const hub = createClickyHub({
    load: (userId, botId) => store.load(userId, botId),
    // A store of the caller's own (a test) is one process: nothing to announce.
    ...(deps.store ? {} : { announce: notifyClickyActivity(deps.database) }),
  });
  const localeOf = async (userId: string) =>
    (await interfaceLocaleOf(
      () => deps.userPreferences.locale(userId),
      environment,
    )) ?? "en";
  const preferences = async (userId: string): Promise<ClickyPreferences> => {
    const [stored, locale] = await Promise.all([
      deps.userPreferences.read(userId).catch(() => undefined),
      localeOf(userId),
    ]);
    const settings = clickyPreferencesOf(stored);
    return {
      locale,
      guidance: settings.clickyGuidance,
      actionPolicy: settings.clickyActionPolicy,
      autoActivate: settings.clickyAutoActivate,
    };
  };
  /**
   * Whether this person may use this Bot's computer, asked the way the computer routes ask it, for
   * the paths that do not come through those routes: a handover event, a run's tool.
   */
  const roles = createRoleRepository(deps.database);
  const access = computerAccessCheck(deps.agentProfileStore);
  const canUseComputer =
    deps.canUseComputer ??
    (async (userId: string, botId: string) => {
      const held: string[] = await roles.rolesForUser(userId).catch(() => []);
      return access(
        { id: userId, role: held.includes("admin") ? "admin" : "user" },
        botId,
      );
    });
  /**
   * Who holds each computer, by person, as the handover events said: Clicky acts only while the
   * person it acts for is the one holding it.
   */
  const holders = new Map<string, string | null>();
  const service = createClickyService({
    store,
    hub,
    preferences,
    gateway,
    brain: createClickyBrain({
      gateway,
      complete:
        deps.complete ??
        createVisionCompleter({
          model: deps.model,
          resolveApiKey: deps.resolveApiKey,
          environment,
        }),
      newId: randomUUID,
    }),
    actions: createClickyActions({
      gateway,
      auditStore: deps.auditStore,
      holderOf: (botId) => holders.get(botId),
    }),
    auditStore: deps.auditStore,
  });

  /** "Noë Bot needs you" on the phones paired with this Bot's computer, or with none in particular. */
  const needsYou: NeedsYou = async ({ userId, botId, trigger }) => {
    const push = deps.push;
    if (!push) return;
    const tokens = await mobile.store.pushTokens(userId, botId);
    if (tokens.length === 0) return;
    const locale = await localeOf(userId);
    await Promise.all(
      tokens.map((token) =>
        push
          .send({
            token,
            kind: "clicky",
            botId,
            ...needsYouText(trigger, locale),
            ...(trigger.requestId ? { requestId: trigger.requestId } : {}),
          })
          .catch((error: unknown) =>
            console.warn(
              JSON.stringify({
                type: "clicky-push-failed",
                error: error instanceof Error ? error.message : String(error),
              }),
            ),
          ),
      ),
    );
  };
  const activation = createClickyActivation({
    service,
    needsYou,
    canUseComputer,
  });
  const sessions = createSocketSessions({
    alive: async (tokens) =>
      new Set(
        (
          await deps.database
            .select({ token: authSessions.token })
            .from(authSessions)
            .where(
              and(
                inArray(authSessions.token, tokens),
                gt(authSessions.expiresAt, new Date()),
              ),
            )
        ).map((row) => row.token),
      ),
  });
  mobile.onRevoked((token) => sessions.revoke(token));
  let routes: AppRoutes | undefined;

  return {
    service,
    hub,
    activation,
    sessions,
    canUseComputer,
    routes() {
      routes ??= createClickyRoutes({ service, hub, sessions });
      return routes;
    },
    onControlEvent(event: ComputerControlEvent) {
      if (event.type === "control_taken")
        holders.set(event.botId, event.userId ?? "");
      if (event.type === "control_released") holders.set(event.botId, null);
      activation.onControlEvent(event);
    },
  };
}
