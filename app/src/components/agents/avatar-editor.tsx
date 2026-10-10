import { useMutation } from "@tanstack/react-query";
import { AVATAR_COLORS } from "../../../../shared/avatar";
import { hairlineClassName } from "@/components/noe-bot/hairline";
import { NoeBotAvatar } from "@/components/noe-bot/noe-bot-avatar";
import { NoeBotFace } from "@/components/noe-bot/noe-bot-face";
import {
  avatarLook,
  EXPRESSIONS,
  type Expression,
} from "@/components/noe-bot/pixel-art";
import { Button } from "@/components/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import {
  type AvatarChoiceInput,
  setAgentAvatarMutationOptions,
} from "@/lib/agents/mutations";
import type { AgentProfile } from "@/lib/agents/queries";
import { cn } from "@/lib/utils";
import { queryClient } from "@/query-client";

/** "unimpressed" as "Unimpressed": the expression's name, as a label a person reads. */
function expressionLabel(expression: Expression): string {
  return expression[0]?.toUpperCase() + expression.slice(1);
}

/** A group's name, drawn the way an `ItemTitle` is, as the legend that names the group. */
const LEGEND = "mb-3 text-sm leading-snug font-medium";

/**
 * The selected swatch or face: a ring in the text colour, set off from the swatch by the popup's
 * own colour so it reads on the near-black and the light grey alike.
 */
const SELECTED =
  "aria-pressed:ring-2 aria-pressed:ring-foreground aria-pressed:ring-offset-2 aria-pressed:ring-offset-popover";

/**
 * How a Bot looks, chosen: its avatar large, the palette's colours, and the guide's fifteen
 * expressions, each drawn on the colour it would be worn with.
 *
 * A click is the whole of a change, so it saves on the spot — there is no draft worth holding and
 * no Save to forget, the same reasoning as the visibility select. While the write is on its way
 * the preview already shows what was clicked, read from the mutation's own variables rather than
 * patched into the cache; the profile takes over once the server has answered and the roster, the
 * detail and every avatar drawn from them have been refetched.
 *
 * Who may change it is the server's verdict (`canEditAvatar`). Without it the section still shows
 * the avatar and says why it cannot be changed, rather than offering swatches that would bounce.
 */
export function AvatarEditor({
  agentId,
  profile,
}: {
  agentId: string;
  profile: AgentProfile;
}) {
  const setAvatar = useMutation(setAgentAvatarMutationOptions(queryClient));
  const pending = setAvatar.isPending ? setAvatar.variables?.choice : undefined;
  const color =
    pending?.avatarColor !== undefined
      ? pending.avatarColor
      : profile.avatarColor;
  const expression =
    pending?.avatarExpression !== undefined
      ? pending.avatarExpression
      : profile.avatarExpression;
  const look = avatarLook({ seed: profile.avatarSeed, color, expression });
  const chosen = color !== null || expression !== null;

  const choose = (choice: AvatarChoiceInput) =>
    setAvatar.mutate({ agentId, choice });

  return (
    <>
      <div className="flex flex-col items-center gap-3 py-2">
        <NoeBotAvatar
          color={color}
          expression={expression}
          name={`${profile.name}'s avatar`}
          seed={profile.avatarSeed}
          size={112}
        />
      </div>

      <div className="flex flex-col gap-2">
        <Item variant="muted">
          <ItemContent>
            <ItemTitle>Avatar</ItemTitle>
            <ItemDescription className="line-clamp-none">
              {!profile.canEditAvatar
                ? profile.systemOwned
                  ? "Ships with this deployment. Only an administrator can change how it looks."
                  : "Only its owner or an administrator can change how it looks."
                : chosen
                  ? "The same everywhere it appears, in light mode and dark."
                  : "Picked from its name. Choose a color and an expression to make it its own."}
            </ItemDescription>
          </ItemContent>
          {profile.canEditAvatar && chosen ? (
            <ItemActions>
              <Button
                onClick={() =>
                  choose({ avatarColor: null, avatarExpression: null })
                }
                size="sm"
                variant="outline"
              >
                Reset
              </Button>
            </ItemActions>
          ) : null}
        </Item>

        {profile.canEditAvatar ? (
          <>
            <Item variant="muted">
              <ItemContent>
                <fieldset className="min-w-0">
                  <legend className={LEGEND}>Color</legend>
                  <div className="flex flex-wrap gap-2.5">
                    {AVATAR_COLORS.map((scheme) => (
                      <button
                        aria-label={scheme.label}
                        aria-pressed={
                          look.scheme.background === scheme.background
                        }
                        className={cn(
                          "size-8 rounded-full border border-transparent outline-none transition-shadow focus-visible:ring-3 focus-visible:ring-ring/50",
                          hairlineClassName(scheme.background, "border"),
                          SELECTED,
                        )}
                        key={scheme.background}
                        onClick={() => {
                          if (scheme.background !== profile.avatarColor)
                            choose({ avatarColor: scheme.background });
                        }}
                        style={{ backgroundColor: scheme.background }}
                        type="button"
                      />
                    ))}
                  </div>
                </fieldset>
              </ItemContent>
            </Item>

            <Item variant="muted">
              <ItemContent>
                <fieldset className="min-w-0">
                  <legend className={LEGEND}>Expression</legend>
                  <div className="grid grid-cols-5 justify-items-start gap-2.5">
                    {EXPRESSIONS.map((candidate) => (
                      <button
                        aria-label={expressionLabel(candidate)}
                        aria-pressed={look.expression === candidate}
                        className={cn(
                          "flex size-11 items-center justify-center rounded-full border border-transparent outline-none transition-shadow focus-visible:ring-3 focus-visible:ring-ring/50",
                          hairlineClassName(look.scheme.background, "border"),
                          SELECTED,
                        )}
                        key={candidate}
                        onClick={() => {
                          if (candidate !== profile.avatarExpression)
                            choose({ avatarExpression: candidate });
                        }}
                        style={{
                          backgroundColor: look.scheme.background,
                          color: look.scheme.ink,
                        }}
                        title={expressionLabel(candidate)}
                        type="button"
                      >
                        <NoeBotFace face={candidate} size={30} />
                      </button>
                    ))}
                  </div>
                </fieldset>
              </ItemContent>
            </Item>
          </>
        ) : null}
      </div>

      {setAvatar.error ? (
        <p className="text-sm text-destructive" role="alert">
          {setAvatar.error.message}
        </p>
      ) : null}
    </>
  );
}
