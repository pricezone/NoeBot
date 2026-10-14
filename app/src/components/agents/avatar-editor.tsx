import { AvatarChooser } from "@/components/agents/avatar-chooser";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import type { AgentProfile } from "@/lib/agents/queries";
import { useTranslation } from "@/lib/i18n";

/**
 * The Profile section of a Bot's dialog: its avatar, large, and a word on who may change it.
 *
 * The avatar itself is the control — the same `AvatarChooser` the bot panel and the Bot's page
 * open from a click on the face — so a look is changed the same way wherever the Bot is seen.
 */
export function AvatarEditor({
  agentId,
  profile,
}: {
  agentId: string;
  profile: AgentProfile;
}) {
  const { t } = useTranslation();
  const chosen =
    profile.avatarColor !== null || profile.avatarExpression !== null;
  return (
    <>
      <div className="flex flex-col items-center gap-3 py-2">
        <AvatarChooser agentId={agentId} profile={profile} size={112} />
      </div>
      <Item variant="muted">
        <ItemContent>
          <ItemTitle>{t("Avatar")}</ItemTitle>
          <ItemDescription className="line-clamp-none">
            {!profile.canEditAvatar
              ? profile.systemOwned
                ? t(
                    "Ships with this deployment. Only an administrator can change how it looks.",
                  )
                : t(
                    "Only its owner or an administrator can change how it looks.",
                  )
              : chosen
                ? t(
                    "Click the avatar to change its expression or color. The same everywhere it appears, in light mode and dark.",
                  )
                : t(
                    "Picked from its name. Click the avatar to choose a color and an expression and make it its own.",
                  )}
          </ItemDescription>
        </ItemContent>
      </Item>
    </>
  );
}
