import { NoeBotAvatar } from "@/components/noe-bot/noe-bot-avatar";

/**
 * A coworker's avatar, announced once, by name.
 *
 * Kept under its old name so the places that draw a coworker did not change; what it draws is now
 * Noë Bot's terminal face from the brand guide rather than an abstract generated pattern.
 */
export function AbstractAvatar({
  name,
  seed,
  size = 40,
}: {
  name: string;
  seed: string;
  size?: number;
}) {
  return <NoeBotAvatar seed={seed} name={name} size={size} />;
}
