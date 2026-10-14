import { IconPencil } from "@tabler/icons-react";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { FACE_GROUPS, faceLabel } from "@/components/noe-bot/anim/catalog";
import {
  THEMED_INK_CLASS,
  THEMED_PALETTE,
} from "@/components/noe-bot/anim/palette";
import { hairlineClassName } from "@/components/noe-bot/hairline";
import { NoeBotAvatar } from "@/components/noe-bot/noe-bot-avatar";
import { NoeBotFace } from "@/components/noe-bot/noe-bot-face";
import { avatarLook, type Expression } from "@/components/noe-bot/pixel-art";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  type AvatarChoiceInput,
  setAgentAvatarMutationOptions,
} from "@/lib/agents/mutations";
import type { AgentProfile } from "@/lib/agents/queries";
import { useTranslation } from "@/lib/i18n";
import { useContentText } from "@/lib/i18n/content";
import { cn } from "@/lib/utils";
import { queryClient } from "@/query-client";
import { AVATAR_COLORS } from "../../../../shared/avatar";

/**
 * The selected swatch or face: a ring in the text colour, set off from the swatch by the popup's
 * own colour so it reads on the near-black and the light grey alike.
 */
const SELECTED =
  "aria-pressed:ring-2 aria-pressed:ring-foreground aria-pressed:ring-offset-2 aria-pressed:ring-offset-popover";

/**
 * How a Bot looks, chosen by clicking its avatar.
 *
 * The avatar is the control: a pencil appears over it on hover and focus, and a click opens the
 * chooser under it — every face the design draws, in its groups, drawn on the Bot's own colour,
 * then the palette's colours, with Reset in the corner. A click is the whole of a change, so it
 * saves on the spot; while the write is on its way the avatar already shows what was clicked, read
 * from the mutation's own variables rather than patched into the cache, and the profile takes over
 * once the server has answered and every avatar drawn from it has been refetched.
 *
 * Who may change it is the server's verdict (`canEditAvatar`). Without it this is the plain avatar,
 * and the caller says why beside it if that matters where it is shown.
 */
export function AvatarChooser({
  agentId,
  profile,
  size = 96,
  align = "center",
}: {
  agentId: string;
  profile: AgentProfile;
  size?: number;
  align?: "start" | "center" | "end";
}) {
  const { t } = useTranslation();
  const content = useContentText();
  const [open, setOpen] = useState(false);
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

  const avatar = (
    <NoeBotAvatar
      color={color}
      expression={expression}
      name={`${profile.name}'s avatar`}
      seed={profile.avatarSeed}
      size={size}
    />
  );

  if (!profile.canEditAvatar) return avatar;

  return (
    <Popover onOpenChange={setOpen} open={open}>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              aria-label={t("Edit avatar")}
              className="group/avatar relative rounded-lg outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
              nativeButton
            />
          }
        >
          {avatar}
          {/* A badge in the corner, not a disc over the character: nothing is drawn behind Noë Bot. */}
          <span
            aria-hidden="true"
            className="pointer-events-none absolute -right-1 -bottom-1 flex size-7 items-center justify-center rounded-full border border-border bg-popover text-foreground opacity-0 shadow-sm transition-opacity group-hover/avatar:opacity-100 group-focus-visible/avatar:opacity-100 data-[open]:opacity-100"
            data-open={open ? "" : undefined}
          >
            <IconPencil className="size-4" />
          </span>
        </TooltipTrigger>
        <TooltipContent>{t("Edit avatar")}</TooltipContent>
      </Tooltip>
      <PopoverContent
        align={align}
        aria-label={t("Avatar")}
        className="w-[min(22.5rem,calc(100vw-2rem))] p-4"
        sideOffset={10}
      >
        <div className="mb-3 flex items-center justify-between">
          <span className="text-sm font-medium">{t("Expression")}</span>
          <Button
            disabled={!chosen}
            onClick={() =>
              choose({ avatarColor: null, avatarExpression: null })
            }
            size="sm"
            variant="ghost"
          >
            {t("Reset")}
          </Button>
        </div>
        <fieldset className="flex max-h-72 flex-col gap-3 overflow-y-auto pr-1">
          <legend className="sr-only">{t("Expression")}</legend>
          {FACE_GROUPS.map((group) => (
            <div key={group.id}>
              <p className="mb-1.5 text-xs text-muted-foreground">
                {content(group.label)}
              </p>
              <div className="grid grid-cols-5 justify-items-start gap-2">
                {group.faces.map((candidate) => (
                  <FaceTile
                    candidate={candidate as Expression}
                    colour={look.scheme.background}
                    key={candidate}
                    onChoose={() => {
                      if (candidate !== profile.avatarExpression)
                        choose({ avatarExpression: candidate as Expression });
                    }}
                    pressed={look.expression === candidate}
                  />
                ))}
              </div>
            </div>
          ))}
        </fieldset>
        <fieldset className="mt-4 flex flex-wrap gap-2.5 border-t border-border pt-4">
          <legend className="sr-only">{t("Color")}</legend>
          {AVATAR_COLORS.map((scheme) => (
            <button
              aria-label={content(scheme.label)}
              aria-pressed={look.scheme.background === scheme.background}
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
        </fieldset>
        {setAvatar.error ? (
          <p className="mt-3 text-sm text-destructive" role="alert">
            {setAvatar.error.message}
          </p>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

/** One face, drawn in the Bot's colour with nothing behind it: still until the pointer or focus rests on it. */
function FaceTile({
  candidate,
  colour,
  pressed,
  onChoose,
}: {
  candidate: Expression;
  colour: string;
  pressed: boolean;
  onChoose: () => void;
}) {
  const content = useContentText();
  const [active, setActive] = useState(false);
  return (
    <button
      aria-label={content(faceLabel(candidate))}
      aria-pressed={pressed}
      className={cn(
        "flex size-11 items-center justify-center rounded-lg outline-none transition-colors hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50",
        THEMED_INK_CLASS,
        hairlineClassName(colour, "outline"),
        SELECTED,
      )}
      onBlur={() => setActive(false)}
      onClick={onChoose}
      onFocus={() => setActive(true)}
      onPointerEnter={() => setActive(true)}
      onPointerLeave={() => setActive(false)}
      style={{ color: colour }}
      title={content(faceLabel(candidate))}
      type="button"
    >
      <NoeBotFace
        active={active}
        face={candidate}
        palette={THEMED_PALETTE}
        props={false}
        size={36}
      />
    </button>
  );
}
