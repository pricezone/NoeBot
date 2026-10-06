import { IconArrowUpRight } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import {
  SettingsCard,
  SettingsRow,
  SettingsSection,
} from "@/components/ui/settings-rows";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";
import {
  formatCredits,
  type UsageWindow,
  usageQueryOptions,
} from "@/lib/usage/queries";

/**
 * What this deployment has spent, and where its subscription is managed.
 *
 * Two deployments, two pages. One metered by the platform that runs it has a meter to read: the
 * rolling week and month in credits and requests, and the balance left. One that brings its own
 * model key is billed by whoever issued that key, and the most honest thing this page can say is
 * so — a zero here would read as "free". Both keep the way to the billing page when the server
 * named one, because the subscription for the machine exists either way.
 *
 * The meter is read only on a metered deployment: `/api/usage` answers 404 on the other kind, and
 * an error card on a page that just explained why there is no meter would contradict itself.
 *
 * AND NEITHER PAGE IS DRAWN UNTIL THE SERVER HAS SAID WHICH DEPLOYMENT THIS IS. The branch used to
 * be "metered, else own key", with pending as the only wait — so a capabilities read that failed
 * (the first fetch and its one retry, while the server was restarting) was not pending, had no
 * data, and fell through to the own-key copy: a metered instance telling its owner that the model
 * is on some other provider's bill and that there is no billing page. Both false. A failed read
 * now says it failed and offers to read again, and the Billing section waits for an answer too,
 * since "no billing page to send you to" is a statement about what the server said, not about what
 * it failed to say.
 */
export function UsageSection() {
  const capabilities = useQuery(deploymentCapabilitiesQueryOptions());
  const metered = capabilities.data?.usage === true;
  const billingUrl = capabilities.data?.billingUrl;
  const usage = useQuery({ ...usageQueryOptions(), enabled: metered });

  return (
    <>
      {capabilities.isPending ? null : capabilities.isError ? (
        <SettingsSection label="Usage">
          <SettingsCard>
            <SettingsRow
              label="Billing could not be determined"
              description={capabilities.error.message}
              control={
                <Button
                  onClick={() => capabilities.refetch()}
                  size="sm"
                  variant="outline"
                >
                  Retry
                </Button>
              }
            />
          </SettingsCard>
        </SettingsSection>
      ) : metered ? (
        <SettingsSection label="Usage">
          {usage.isPending ? null : usage.error ? (
            <p className="text-destructive text-sm" role="alert">
              {usage.error.message}
            </p>
          ) : (
            <div className="grid gap-3 sm:grid-cols-3">
              <WindowCard label="This week" window={usage.data.week} />
              <WindowCard label="This month" window={usage.data.month} />
              <SettingsCard className="px-4 py-3">
                <p className="text-[13px] text-muted-foreground">Balance</p>
                <p className="text-[22px] font-semibold tabular-nums">
                  {formatCredits(usage.data.balance)}
                </p>
                <p className="text-[13px] text-muted-foreground">
                  credits left
                </p>
              </SettingsCard>
            </div>
          )}
        </SettingsSection>
      ) : (
        <SettingsSection label="Usage">
          <SettingsCard>
            <SettingsRow
              label="Billed by your own provider"
              description="This deployment runs on a model key of its own, so what the model costs is on that provider's bill and there is no meter to show here."
            />
          </SettingsCard>
        </SettingsSection>
      )}
      {capabilities.isSuccess ? (
        <SettingsSection label="Billing">
          <SettingsCard>
            <SettingsRow
              label="Manage billing"
              description={
                billingUrl
                  ? "Your plan, payment method and invoices, on the platform that runs this deployment."
                  : "This deployment has no billing page to send you to."
              }
              control={
                billingUrl ? (
                  <Button
                    render={
                      <a href={billingUrl} rel="noreferrer" target="_blank" />
                    }
                    size="sm"
                    variant="outline"
                  >
                    Manage billing
                    <IconArrowUpRight />
                  </Button>
                ) : undefined
              }
            />
          </SettingsCard>
        </SettingsSection>
      ) : null}
    </>
  );
}

function WindowCard({ label, window }: { label: string; window: UsageWindow }) {
  return (
    <SettingsCard className="px-4 py-3">
      <p className="text-[13px] text-muted-foreground">{label}</p>
      <p className="text-[22px] font-semibold tabular-nums">
        {formatCredits(window.credits)}
      </p>
      <p className="text-[13px] text-muted-foreground">
        credits ·{" "}
        {window.requests === 1 ? "1 request" : `${window.requests} requests`}
      </p>
    </SettingsCard>
  );
}
