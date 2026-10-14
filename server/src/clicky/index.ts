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
import type { ClickyNotice, ClickySession } from "../../../shared/clicky";
import { clickyPreferencesOf } from "../../../shared/user-preferences";
import { computerAccessCheck } from "../agents/computer-access";
import type { AgentProfileStore } from "../agents/profile-store";
import { type AuditStore, PERSON_INITIATOR, recordAuditEvent } from "../audit";
import type { AppVariables } from "../auth/guards";
import type { MobileLinkedInput } from "../auth/signin-handoff";
import type {
  ComputerControlEvent,
  ComputerGateway,
} from "../computer/gateway";
import type { HeadlessWait } from "../computer/headless-tools";
import type { DeploymentConfig } from "../config";
import type { RuntimeModel } from "../copilot";
import type { Database } from "../db/client";
import type { ExpoPushTransport } from "../delivery/push";
import { interfaceLocaleOf } from "../i18n/bot-language";
import { serverText } from "../i18n/server-text";
import { createMobileRoutes } from "../mobile/routes";
import {
  createMobileDeviceStore,
  type MobileDeviceStore,
} from "../mobile/store";
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
import { type ClickyPreferences, createClickyService } from "./service";
import { type ClickyStore, createClickyStore } from "./store";

export type ClickyDependencies = {
  config: DeploymentConfig;
  database: Database;
  /** For LISTEN/NOTIFY, so every replica hears every session change. */
  databaseUrl: string;
  gateway: ComputerGateway;
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
  /** The linked phones. Absent, the database. */
  mobileStore?: MobileDeviceStore;
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
  /** `/api/mobile/...`: a person's linked phones. */
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
  /** A phone was linked through the HyperNoesis app; records it and answers its id. */
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

export function createClickyWiring(deps: ClickyDependencies): ClickyWiring {
  const environment = deps.environment ?? process.env;
  const enabled = clickyEnabled(environment);
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
    const clicky = clickyPreferencesOf(stored);
    return {
      locale,
      guidance: clicky.clickyGuidance,
      actionPolicy: clicky.clickyActionPolicy,
      autoActivate: clicky.clickyAutoActivate,
    };
  };
  const service = createClickyService({
    store,
    hub,
    preferences,
    gateway: deps.gateway,
    brain: createClickyBrain({
      gateway: deps.gateway,
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
      gateway: deps.gateway,
      auditStore: deps.auditStore,
    }),
    auditStore: deps.auditStore,
  });
  const mobileStore =
    deps.mobileStore ?? createMobileDeviceStore(deps.database);

  /** "Noë Bot needs you" on the phones paired with this Bot's computer, or with none in particular. */
  const needsYou: NeedsYou = async ({ userId, botId, trigger }) => {
    const push = deps.push;
    if (!push) return;
    const tokens = await mobileStore.pushTokens(userId, botId);
    if (tokens.length === 0) return;
    const locale = await localeOf(userId);
    await Promise.all(
      tokens.map((token) =>
        push
          .send({
            token,
            kind: "clicky",
            botId,
            title: serverText(locale, "Noë Bot needs you"),
            body:
              trigger.reason ??
              serverText(locale, "Open Clicky to see what to do."),
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
  const activation = createClickyActivation({ service, needsYou });

  let routes: AppRoutes | undefined;
  let listener: ClickyActivityListener | undefined;

  return {
    enabled,
    computerRoutes() {
      if (!enabled) return undefined;
      routes ??= createClickyRoutes({ service, hub });
      return routes;
    },
    mobileRoutes(requireUser) {
      if (!enabled) return undefined;
      return createMobileRoutes({
        store: mobileStore,
        requireUser,
        canUseComputer: computerAccessCheck(deps.agentProfileStore),
        auditStore: deps.auditStore,
      });
    },
    onControlEvent(event) {
      if (enabled) activation.onControlEvent(event);
    },
    onWaiting(input) {
      if (enabled) activation.onWaiting(input);
    },
    onRunBusy(input) {
      if (enabled) activation.onRunBusy(input);
    },
    onViewerInput({ userId, botId, raw, frame }) {
      if (!enabled) return;
      const at = viewerClick(raw, frame);
      if (at) service.personInput(userId, botId, at);
    },
    async onMobileLinked(input) {
      if (!enabled)
        throw new Error("Linking a phone is not available on this deployment.");
      const { deviceId, reused } = await mobileStore.link(input);
      await recordAuditEvent(deps.auditStore, {
        eventType: "mobile.device_linked",
        targetType: "person",
        targetId: input.userId,
        actorUserId: input.userId,
        initiator: PERSON_INITIATOR,
        payload: {
          deviceId,
          platform: input.device.platform,
          // Linking again after a day takes the same phone's row back; a new phone is a new row.
          linkedAgain: reused,
        },
      }).catch(() => undefined);
      return { deviceId };
    },
    guide({ userId, botId, ...input }) {
      if (!enabled)
        return Promise.reject(
          new Error("Clicky is not available on this deployment."),
        );
      return service.guide(userId, botId, input);
    },
    async start() {
      if (!enabled) return;
      service.start();
      if (!deps.store)
        listener = await startClickyActivityListener(deps.databaseUrl, hub);
    },
    async stop() {
      service.stop();
      await listener?.stop();
      listener = undefined;
    },
  };
}
