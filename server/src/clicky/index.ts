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
 * See docs/clicky-mode.md.
 */
import type { Hono, MiddlewareHandler } from "hono";
import type { AgentProfileStore } from "../agents/profile-store";
import type { AuditStore } from "../audit";
import type { MobileLinkedInput } from "../auth/signin-handoff";
import type { AppVariables } from "../auth/guards";
import type {
  ComputerControlEvent,
  ComputerGateway,
} from "../computer/gateway";
import type { HeadlessWait } from "../computer/headless-tools";
import type { DeploymentConfig } from "../config";
import type { RuntimeModel } from "../copilot";
import type { Database } from "../db/client";
import type { UserPreferencesStore } from "../user-preferences";

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
  /** Starts timers and the NOTIFY listener. */
  start(): Promise<void>;
  stop(): Promise<void>;
};

/** Whether Clicky is switched on for this deployment (`CLICKY_MODE`, on unless `off`). */
export function clickyEnabled(environment: NodeJS.ProcessEnv): boolean {
  const value = environment.CLICKY_MODE?.trim().toLowerCase();
  return !(value === "off" || value === "false" || value === "0");
}

export function createClickyWiring(_deps: ClickyDependencies): ClickyWiring {
  const enabled = clickyEnabled(process.env);
  return {
    enabled,
    computerRoutes: () => undefined,
    mobileRoutes: () => undefined,
    onControlEvent: () => {},
    onWaiting: () => {},
    onRunBusy: () => {},
    onViewerInput: () => {},
    onMobileLinked: async () => {
      throw new Error("Linking a phone is not available on this deployment.");
    },
    start: async () => {},
    stop: async () => {},
  };
}
