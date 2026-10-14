import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { PageShell } from "@/components/layout/page-shell";
import { SignInForm } from "@/components/passwords/sign-in-form";
import { useTranslation } from "@/lib/i18n";
import { signInRequestQueryOptions } from "@/lib/passwords/queries";

/**
 * The private sign-in form, on a page of its own.
 *
 * Its own route, outside the chat layout, because this is where a link sent to Slack, SMS or a phone
 * lands: a person can answer a Bot that is working unattended without opening its conversation, and
 * nothing typed here is ever part of one.
 */
export const Route = createFileRoute("/_authed/sign-in/$requestId")({
  component: SignInPage,
});

function SignInPage() {
  const { t } = useTranslation();
  const { requestId } = Route.useParams();
  const request = useQuery(signInRequestQueryOptions(requestId));
  return (
    <PageShell
      title={
        request.data
          ? t("Sign in to {{origin}}", { origin: request.data.origin })
          : t("Sign in")
      }
      description={
        request.data?.reason ??
        t(
          "Your Bot needs to be signed in to continue. What you enter here goes to its browser, not to the conversation.",
        )
      }
    >
      <SignInForm requestId={requestId} />
    </PageShell>
  );
}
