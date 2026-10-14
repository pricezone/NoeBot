import { IconRefresh } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import {
  PageEmpty,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import { useBotNames } from "@/lib/agents/bot-names";
import {
  DID_NOT_HAPPEN_EVENT_TYPES,
  eventTypeFilter,
  outcomeOf,
  REFUSED_EVENT_TYPES,
} from "@/lib/audit/outcome";
import { auditEventsQueryOptions } from "@/lib/audit/queries";
import { silenceOf } from "@/lib/audit/silence";
import { i18n, msg, useTranslation } from "@/lib/i18n";
import { intlLocale } from "@/lib/i18n/format";

/**
 * Read surface for policy, computer, component, MCP, and credential audit events.
 */
export const Route = createFileRoute("/_authed/_app/admin/audit")({
  component: AuditPage,
});

/** One row as the API returns it. */
type AuditEvent = {
  id: string;
  actorUserId: string | null;
  /** Absent on a deployment that has not migrated yet. */
  initiatorKind?: string;
  initiatorId?: string | null;
  eventType: string;
  targetType: string;
  targetId: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
};

/*
 * The saved views, built from the same lists the row label and colour are decided by.
 *
 * Written out by hand here and again below, they had already drifted: a refusal on one list and not
 * the other is a row drawn as "Allowed" or a row missing from the view somebody clicks to ask what
 * this deployment refused. See `@/lib/audit/outcome`, which is now the only place either question is
 * answered.
 */
const FILTERS = [
  { label: msg("Everything"), search: "" },
  {
    label: msg("Computer actions"),
    search: "?eventType=computer.action_allowed",
  },
  { label: msg("Blocked"), search: eventTypeFilter(REFUSED_EVENT_TYPES) },
  {
    label: msg("Did not happen"),
    search: eventTypeFilter(DID_NOT_HAPPEN_EVENT_TYPES),
  },
  {
    label: msg("Nobody watching"),
    search: "?initiatorKind=routine,handoff,responsibility,memory",
  },
] as const;

function AuditPage() {
  const { t } = useTranslation("admin");
  const [search, setSearch] = useState<string>(FILTERS[0].search);
  const events = useQuery(auditEventsQueryOptions(search));
  const rows = (events.data?.events ?? []) as AuditEvent[];
  const nameFor = useBotNames();

  return (
    /*
     * THE ONE WIDE PAGE IN ADMIN, and the one that keeps a table. Five columns of short values is
     * what a log is; rows of prose would make every entry a paragraph and the scanning this page
     * exists for impossible. It takes the same header and the same type scale as everything else,
     * and differs only where the content forces it to.
     */
    <PageShell
      action={
        <Button onClick={() => events.refetch()} size="sm" variant="ghost">
          <IconRefresh />
          {t("Refresh")}
        </Button>
      }
      description={t(
        "Every action a Bot took, and every one this deployment's policy refused.",
      )}
      title={t("Audit")}
      width="wide"
    >
      <PageSection>
        <div className="flex flex-wrap gap-2">
          {FILTERS.map((filter) => (
            <Button
              key={t(filter.label)}
              onClick={() => setSearch(filter.search)}
              size="sm"
              type="button"
              /* The fill is the state, as on every other set of switches in the app. */
              variant={search === filter.search ? "default" : "outline"}
            >
              {filter.label}
            </Button>
          ))}
        </div>

        {events.isPending ? null : events.isError ? (
          <p className="mt-4 text-destructive text-sm" role="alert">
            {t("The audit trail could not be loaded.")}
          </p>
        ) : rows.length === 0 ? (
          <PageEmpty>{t("No events match this filter yet.")}</PageEmpty>
        ) : (
          <div className="mt-4 overflow-x-auto rounded-lg border border-border bg-card">
            <table className="w-full text-left text-sm">
              <thead className="text-muted-foreground text-xs uppercase">
                <tr className="border-border border-b">
                  <th className="px-4 py-2 font-medium">{t("When")}</th>
                  <th className="px-4 py-2 font-medium">{t("What")}</th>
                  <th className="px-4 py-2 font-medium">{t("On")}</th>
                  <th className="px-4 py-2 font-medium">{t("Bot")}</th>
                  <th className="px-4 py-2 font-medium">{t("Started by")}</th>
                  <th className="px-4 py-2 font-medium">{t("Decision")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((event) => (
                  <Row event={event} key={event.id} nameFor={nameFor} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </PageSection>
    </PageShell>
  );
}

function StartedBy({
  event,
  nameFor,
}: {
  event: AuditEvent;
  nameFor: (botId: string) => string;
}) {
  const { t } = useTranslation("admin");
  if (event.initiatorKind === "routine") {
    return (
      <span
        className="font-medium text-amber-600 dark:text-amber-500"
        title={event.initiatorId ?? undefined}
      >
        {t("A routine")}
      </span>
    );
  }
  if (event.initiatorKind === "handoff") {
    return (
      <span
        className="font-medium text-amber-600 dark:text-amber-500"
        title={event.initiatorId ?? undefined}
      >
        {event.initiatorId
          ? t("Handed on by {{value}}", { value: nameFor(event.initiatorId) })
          : t("Handed on")}
      </span>
    );
  }
  if (
    event.initiatorKind === "responsibility" ||
    event.initiatorKind === "memory"
  ) {
    return (
      <span
        className="font-medium text-amber-600 dark:text-amber-500"
        title={event.initiatorId ?? undefined}
      >
        {event.initiatorKind === "memory"
          ? t("A memory source")
          : t("A responsibility")}
      </span>
    );
  }
  if (event.initiatorKind === "deployment") {
    return (
      <span className="text-muted-foreground">{t("This deployment")}</span>
    );
  }
  return <span className="text-muted-foreground">{t("A person")}</span>;
}

function Row({
  event,
  nameFor,
}: {
  event: AuditEvent;
  nameFor: (botId: string) => string;
}) {
  const { t } = useTranslation("admin");
  const payload = event.payload ?? {};
  const decision = (payload.decision ?? {}) as {
    allowed?: boolean;
    mode?: string;
    rule?: string | null;
    carriedOut?: boolean;
  };
  const element = payload.element as
    | { role?: string; name?: string }
    | string
    | undefined;
  const outcome = outcomeOf(event.eventType);
  const refused = outcome === "refused";
  const stalled = event.eventType === "agent.stream_stalled";
  /*
   * Three different things, and the difference is what somebody comes to this row to find out.
   *
   * A person naming a coworker, the router matching one, and the router giving up and using the
   * default are not the same event, and one label covering all three would make the row worth less
   * than the reason line under it. Nothing here is a refusal, so none of them take the refusal
   * colour.
   */
  const routed =
    event.eventType === "channel.routed"
      ? payload.viaMention === true
        ? i18n.t("The person chose this coworker")
        : payload.fallback === true
          ? i18n.t("Sent to the default coworker")
          : i18n.t("Sent to the coworker it is for")
      : null;
  // Allowed by policy but not carried out. A stalled turn belongs in the same family: the Bot was
  // asked and the answer never arrived. Colour is how this table is read, and a row left in the
  // muted foreground reads as "Allowed", which a turn nobody ever got an answer to was not.
  const failed = outcome === "did-not-happen";
  const silence = stalled ? silenceOf(payload) : null;

  return (
    <tr className="border-border border-t align-top">
      <td className="whitespace-nowrap px-4 py-2 text-muted-foreground">
        {new Date(event.createdAt).toLocaleTimeString(intlLocale())}
      </td>
      <td className="px-4 py-2 font-medium">
        {/* Strip the internal computer tool namespace for display. */}
        {typeof payload.action === "string"
          ? payload.action.replace("computer_", "")
          : event.eventType}
      </td>
      <td className="px-4 py-2">
        {/*
         * A routing row's subject is the coworker it went to, and it is the only thing on the row
         * worth reading. Its target type is `agent`, which is not a named target because everywhere
         * else an agent id appears it belongs in the Bot column; here nothing acted, so there is no
         * Bot and the target is all there is. Rendered through `nameFor` so it reads as the name on
         * the roster rather than the immutable id.
         */}
        {event.eventType === "channel.routed" && event.targetId ? (
          <span title={event.targetId}>{nameFor(event.targetId)}</span>
        ) : /*
         * A discovery row's subject is the narrowing itself, so the numbers are the subject. A
         * reader asking "why did it not call the tool" needs to see that eleven of thirty were
         * offered before anything else on the row means anything.
         */
        event.eventType === "mcp.tools_discovered" ? (
          <span className="font-mono text-xs">
            {typeof payload.offered === "number" &&
            typeof payload.granted === "number"
              ? t("{{offered}} of {{granted}} tools", {
                  offered: payload.offered,
                  granted: payload.granted,
                })
              : "-"}
          </span>
        ) : /* Named targets and file paths are the audit subject before page elements. */
        NAMED_TARGETS.has(event.targetType) && event.targetId ? (
          <span className="font-mono text-xs">
            {event.targetId}
            {typeof payload.function === "string" ? (
              <span className="text-muted-foreground">
                {" "}
                · {payload.function}
              </span>
            ) : null}
          </span>
        ) : typeof payload.file === "string" ? (
          <span className="font-mono text-xs">{payload.file}</span>
        ) : typeof payload.command === "string" ? (
          // The command is the subject of its own row, the way a path is for a file action.
          <span className="font-mono text-xs">{payload.command}</span>
        ) : typeof element === "object" && element?.name ? (
          <span>
            {element.name}
            {element.role ? (
              <span className="text-muted-foreground"> ({element.role})</span>
            ) : null}
          </span>
        ) : typeof element === "string" ? (
          <span className="text-muted-foreground">{element}</span>
        ) : (
          <span className="text-muted-foreground">-</span>
        )}
        {/* Page host is meaningful only for browser actions, not workspace file actions. */}
        {typeof payload.file !== "string" &&
        typeof payload.command !== "string" &&
        typeof payload.page === "string" &&
        payload.page ? (
          <div className="text-xs text-muted-foreground">
            {hostOf(payload.page)}
          </div>
        ) : null}
      </td>
      <td className="px-4 py-2 text-muted-foreground">
        {typeof payload.bot === "string" ? (
          // Keep the immutable bot id available even when names collide.
          <span title={payload.bot}>{nameFor(payload.bot)}</span>
        ) : (
          "-"
        )}
      </td>
      <td className="px-4 py-2">
        <StartedBy event={event} nameFor={nameFor} />
      </td>
      <td className="px-4 py-2">
        <span
          className={
            refused
              ? "font-medium text-destructive"
              : failed
                ? "font-medium text-amber-600 dark:text-amber-500"
                : "text-muted-foreground"
          }
        >
          {routed ??
            (DECISIONS[event.eventType]
              ? t(DECISIONS[event.eventType] as string)
              : undefined) ??
            (refused
              ? i18n.t("Blocked")
              : failed
                ? i18n.t("Did not happen")
                : i18n.t("Allowed"))}
        </span>
        {/* Refusal reasons mirror the conversation-facing reason. */}
        {(event.eventType === "component.refused" ||
          event.eventType === "component.function_refused" ||
          event.eventType === "mcp.call_rejected") &&
        typeof payload.reason === "string" ? (
          <div className="mt-0.5 text-xs text-muted-foreground">
            {payload.reason}
          </div>
        ) : null}
        {/*
         * Why this run was offered what it was, which is the only part of a discovery row that
         * cannot be worked out from the numbers. "Nothing declared" and "selector unavailable" both
         * offer everything and mean entirely different things about the deployment.
         */}
        {event.eventType === "mcp.tools_discovered" &&
        typeof payload.reason === "string" ? (
          <div className="mt-0.5 text-xs text-muted-foreground">
            {t(DISCOVERY_REASONS[payload.reason] ?? payload.reason)}
            {Array.isArray(payload.skills) && payload.skills.length > 0
              ? `: ${payload.skills.join(", ")}`
              : ""}
          </div>
        ) : null}
        {event.eventType === "mcp.callback_refused" &&
        typeof payload.refusal === "string" ? (
          <div className="mt-0.5 text-xs text-muted-foreground">
            {payload.refusal}
          </div>
        ) : null}
        {/*
         * Why the conversation went where it went, which is the whole reason the row is written.
         * Without it a routing row says "Allowed" and names nobody, which is indistinguishable from
         * a row that failed to write.
         */}
        {event.eventType === "channel.routed" &&
        typeof payload.reason === "string" ? (
          /*
           * A width rather than a max-width, because the table lays itself out from its content and
           * a max-width on a block inside a cell does not constrain that. A router's reason is a
           * sentence a model wrote, not a rule name, and left unbounded in the last column it
           * pushes the table wider than the page and the end of the sentence goes off the edge,
           * where nobody scrolls to find it.
           */
          <div className="mt-0.5 w-[22rem] break-words text-xs text-muted-foreground">
            {payload.reason}
          </div>
        ) : null}
        {event.eventType === "bot.declined" &&
        typeof payload.reason === "string" ? (
          <div className="mt-0.5 text-xs text-muted-foreground">
            {payload.reason}
            <span className="italic">{t(", reported by the Bot itself")}</span>
          </div>
        ) : null}
        {failed && typeof payload.failure === "string" ? (
          <div className="mt-0.5 text-xs text-muted-foreground">
            {payload.failure}
          </div>
        ) : null}
        {/*
         * The two numbers the stall row is worth reading for. Without them every stalled turn looks
         * the same, and the difference between an endpoint that dies halfway through an answer and
         * one that never begins is the difference between a slow Bot and a dead one.
         */}
        {silence ? (
          <div className="mt-0.5 text-xs text-muted-foreground">{silence}</div>
        ) : null}
        {/* Show concrete policy rules, but suppress the uninformative default `true` allow rule. */}
        {decision.rule && decision.rule !== "true" ? (
          <div className="mt-0.5 font-mono text-xs text-muted-foreground">
            {decision.rule}
          </div>
        ) : null}
        {decision.mode === "dry-run" &&
        decision.allowed === false &&
        decision.carriedOut ? (
          <div className="text-xs text-muted-foreground">
            {t("dry-run: recorded, not enforced")}
          </div>
        ) : null}
      </td>
    </tr>
  );
}

/**
 * Target types whose id is a name worth putting on screen.
 *
 * Anything else falls through to the element or file subject.
 */
/**
 * Why a run was offered the tools it was, in words rather than in the slug the server writes.
 *
 * Every one of these looks the same from outside: the Bot was handed some tools. The distinction is
 * the difference between a deployment that narrowed on purpose, one that has never declared a skill,
 * and one whose selector could not be reached, and only the last is a fault.
 */
const DISCOVERY_REASONS: Record<string, string> = {
  "under-floor": msg("Few enough tools to offer them all"),
  "nothing-declared": msg("No skill declares any of these tools"),
  unavailable: msg("Could not choose, so all were offered"),
  "nothing-chosen": msg("No skill applied, so all were offered"),
  selected: msg("Chosen by skill"),
};

const NAMED_TARGETS = new Set([
  "component",
  "mcp_tool",
  "mcp_server",
  "skill",
  "credential",
]);

const DECISIONS: Record<string, string> = {
  "bot.declined": msg("The Bot declined"),
  // Not a refusal, so not the refusal colour: nothing was blocked. The Bot was asked and never
  // answered, which is the same complaint as an action that was allowed and then did not happen.
  "agent.stream_stalled": msg("The Bot stopped responding"),
  "computer.policy_loaded": msg("Boundary at start-up"),
  "computer.isolation_loaded": msg("Isolation at start-up"),
  "computer.control_taken": msg("A person took the wheel"),
  "computer.control_released": msg("The wheel was handed back"),
  "computer.help_requested": msg("The Bot asked for help"),
  "computer.secret_requested": msg("The Bot asked for a secret"),
  "computer.secret_supplied": msg("A person supplied a secret"),
  "computer.reset": msg("The computer was reset"),
  "computer.updated": msg("The computer was updated"),
  "computer.stopped": msg("A person pressed stop"),

  "component.granted": msg("Granted to this Bot"),
  "component.revoked": msg("Taken away from this Bot"),
  "component.published": msg("Published, so every Bot may use it"),
  "component.unpublished": msg("Unpublished, so no Bot may use it"),
  "component.draft_saved": msg("Draft saved, not yet published"),
  "component.refused": msg("Refused"),
  "component.function_granted": msg("May read this"),
  "component.function_revoked": msg("May no longer read this"),
  "component.function_called": msg("Read real data"),
  "component.function_refused": msg("Refused"),
  // A function failure is execution failure, not a policy refusal.
  "component.function_failed": msg("Could not be read"),

  // Not a call and not a decision: the tools this run was allowed to see. Worded so nobody reads it
  // as permission, which it is not — everything named was already granted.
  "mcp.tools_discovered": msg("Tools offered for one run"),
  "mcp.call_succeeded": msg("Called on this Bot's behalf"),
  "mcp.call_rejected": msg("Blocked"),
  "mcp.call_failed": msg("The server did not answer"),
  // Not "Blocked": nothing about the Bot was judged, because nothing proved which Bot it was.
  "mcp.callback_refused": msg("Could not prove which Bot it was"),

  "configuration.changed": msg("Configuration changed"),
  "credential.created": msg("Credential saved"),
};

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
