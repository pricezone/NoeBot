import {
  DeliveryProviderError,
  type ProviderFetch,
  providerJson,
} from "./types";
/** The scheme the upstream OpenBot app registers, and the default where links point. */
export const DEFAULT_MOBILE_LINK_BASE = "openbotmobile://";

/**
 * Where a notification's link opens: `OPENBOT_MOBILE_LINK_BASE`, or the OpenBot app's scheme.
 *
 * A deployment whose phones are the HyperNoesis app points this at that app's own scheme, so a tap
 * opens the screen the notification is about instead of an app that is not installed. The base is
 * used as written with the screen's path appended (`<base>approvals?…`), so it ends in `//` or `/`.
 */
export function mobileLinkBase(
  environment: Record<string, string | undefined>,
): string {
  return (
    environment.OPENBOT_MOBILE_LINK_BASE?.trim() || DEFAULT_MOBILE_LINK_BASE
  );
}

/**
 * What a notification is about, and so which screen its link opens. `clicky` is Clicky Mode asking
 * the person to come to a Bot's computer (the Bot needs them for a sign-in, a code, a challenge).
 */
export type PushKind = "reply" | "question" | "approval" | "clicky";

const PUSH_PATHS: Record<PushKind, string> = {
  reply: "conversation",
  question: "approvals",
  approval: "approvals",
  clicky: "clicky",
};

export function createExpoPushTransport(
  config: {
    accessToken?: string;
    projectId?: string;
    fetch?: ProviderFetch;
    /** See `mobileLinkBase`. Absent, the OpenBot app's scheme. */
    linkBase?: string;
  } = {},
) {
  const wire = config.fetch ?? fetch;
  const linkBase = config.linkBase?.trim() || DEFAULT_MOBILE_LINK_BASE;
  async function call(method: "send" | "getReceipts", body: unknown) {
    let response: Response;
    try {
      response = await wire(`https://exp.host/--/api/v2/push/${method}`, {
        method: "POST",
        signal: AbortSignal.timeout(30_000),
        headers: {
          "content-type": "application/json",
          ...(config.accessToken
            ? { authorization: `Bearer ${config.accessToken}` }
            : {}),
        },
        body: JSON.stringify(body),
      });
    } catch {
      throw new DeliveryProviderError("Expo", "network_error", true);
    }
    return providerJson("Expo", response);
  }
  return {
    async send(
      input: {
        token: string;
        title: string;
        body: string;
        requestId?: string | null;
      } & (
        | { kind: "reply" | "question" | "approval"; channelId: string }
        /** Clicky: about a Bot's computer rather than a conversation. */
        | { kind: "clicky"; botId: string }
      ),
    ) {
      const path = PUSH_PATHS[input.kind];
      const about: Record<string, string> =
        input.kind === "clicky"
          ? { bot: input.botId }
          : { channelId: input.channelId };
      const query = new URLSearchParams({
        ...about,
        ...(input.requestId ? { requestId: input.requestId } : {}),
      });
      const result = await call("send", {
        to: input.token,
        title: input.title,
        body: Array.from(input.body).slice(0, 200).join(""),
        sound: "default",
        data: {
          ...(input.kind === "clicky"
            ? { botId: input.botId }
            : { channelId: input.channelId }),
          kind: input.kind,
          ...(input.requestId ? { requestId: input.requestId } : {}),
          url: `${linkBase}${path}?${query}`,
        },
      });
      const ticket = result.data;
      if (
        !ticket ||
        typeof ticket !== "object" ||
        Array.isArray(ticket) ||
        !("status" in ticket)
      )
        throw new DeliveryProviderError("Expo", "invalid_ticket");
      if (ticket.status === "error")
        throw new DeliveryProviderError(
          "Expo",
          "details" in ticket &&
            ticket.details &&
            typeof ticket.details === "object" &&
            "error" in ticket.details
            ? String(ticket.details.error)
            : "push_error",
        );
      if (!("id" in ticket) || typeof ticket.id !== "string")
        throw new DeliveryProviderError("Expo", "missing_ticket");
      return { id: ticket.id, status: "accepted" as const };
    },
    async receipt(id: string): Promise<{
      status: "delivered" | "failed" | "pending";
      error?: string;
      revokeDevice?: boolean;
    }> {
      const result = await call("getReceipts", { ids: [id] });
      const data = result.data;
      if (!data || typeof data !== "object" || !(id in data))
        return { status: "pending" };
      const receipt = (data as Record<string, unknown>)[id];
      if (!receipt || typeof receipt !== "object" || !("status" in receipt))
        throw new DeliveryProviderError("Expo", "invalid_receipt");
      if (receipt.status === "ok") return { status: "delivered" };
      const error =
        "details" in receipt &&
        receipt.details &&
        typeof receipt.details === "object" &&
        "error" in receipt.details
          ? String(receipt.details.error)
          : "receipt_error";
      return {
        status: "failed",
        error,
        revokeDevice: error === "DeviceNotRegistered",
      };
    },
  };
}
export type ExpoPushTransport = ReturnType<typeof createExpoPushTransport>;
