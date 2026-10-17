/** Durable, request-scoped browser handoff shared by the computer, API, and app. */
export type HandoffStatus =
  | "waiting"
  | "taken"
  | "completed"
  | "cancelled"
  | "expired"
  | "interrupted";
export type HandoffSource =
  | "model"
  | "cloudflare"
  | "visible-challenge"
  | "manual";
export type HandoffRequest = {
  id: string;
  toolCallId?: string;
  reason: string;
  source: HandoffSource;
  status: HandoffStatus;
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
  finishedAt?: string;
  interruption?: string;
  /**
   * Who took it: the person's id, recorded by the computer, so every server process can tell who
   * holds the computer, not only the one that handled the take.
   */
  takenBy?: string;
};
export type ComputerControlState = {
  holder: "bot" | "human";
  since: string;
  requested: boolean;
  reason?: string;
  request?: HandoffRequest;
  transitioning: boolean;
  resumeSnapshotRequired: boolean;
  secretWanted?: string;
  secretRef?: string;
  secretSnapshotId?: number;
  /**
   * How the most recent secret request ended, so the Bot is told the truth: the value landed in the
   * field, nobody entered it in time, it was cancelled, or the field had gone by the time it came.
   * Never the value.
   */
  lastSecret?: { label: string; outcome: SecretOutcome; at: string };
};
export type SecretOutcome = "supplied" | "expired" | "cancelled" | "field-gone";
export type RequestHelpInput = { reason: string; toolCallId?: string };
export type ControlRequestInput = { requestId: string };
export type BrowserChallenge = {
  kind: "cloudflare" | "visible-challenge";
  reason: string;
  requestId: string;
};
