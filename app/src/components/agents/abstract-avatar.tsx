import type { AvatarColor, AvatarExpression } from "../../../../shared/avatar";
import { NoeBotAvatar } from "@/components/noe-bot/noe-bot-avatar";

/**
 * A coworker's avatar, announced once, by name.
 *
 * Kept under its old name so the places that draw a coworker did not change; what it draws is now
 * Noë Bot's terminal face from the brand guide rather than an abstract generated pattern, in the
 * colour and with the expression a person chose for it when they chose one.
 */
export function AbstractAvatar({
  name,
  seed,
  color,
  expression,
  size = 40,
}: {
  name: string;
  seed: string;
  color?: AvatarColor | null;
  expression?: AvatarExpression | null;
  size?: number;
}) {
  return (
    <NoeBotAvatar
      color={color}
      expression={expression}
      name={name}
      seed={seed}
      size={size}
    />
  );
}
