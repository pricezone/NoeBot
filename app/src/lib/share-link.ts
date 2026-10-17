import { useQuery } from "@tanstack/react-query";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";

/**
 * A Share link that opens on ANY Noë Bot instance, not only this one.
 *
 * Every instance is its own address, so a link copied from one is a dead end for anybody whose
 * Bots live on another. Where the deployment runs on a platform (`shareBase`, from
 * `/api/capabilities`), the link goes through it instead:
 *
 *     https://<platform>/api/noebot/share?to=<encodeURIComponent(in-app path + search)>
 *
 * and the platform sends the reader on to their own instance at that path (signing them in on the
 * way, or to the Noë Bot page when they have none). Without a platform it is this deployment's own
 * address: `<origin><path>`.
 *
 * `path` is the in-app address, starting with `/`: `/marketplace?tab=apps&plugin=55647425`.
 */
export function shareLinkFor(
  path: string,
  shareBase: string | undefined,
  origin: string,
): string {
  if (!shareBase) return `${origin}${path}`;
  return `${shareBase.replace(/\/+$/, "")}/api/noebot/share?to=${encodeURIComponent(path)}`;
}

/** `shareLinkFor` with this deployment's platform and origin filled in. */
export function useShareLink(): (path: string) => string {
  const capabilities = useQuery(deploymentCapabilitiesQueryOptions());
  return (path) =>
    shareLinkFor(path, capabilities.data?.shareBase, window.location.origin);
}
