import { useNavigate } from "@tanstack/react-router";
import { useHotkey } from "./use-hotkey";

/*
 * A `string`, not a literal: the Marketplace route is another work package's, and a literal the
 * route tree does not yet know would not type. Narrow it once the route exists.
 */
const MARKETPLACE_PATH: string = "/marketplace";

/**
 * The app-wide shortcuts, bound once for the whole signed-in app.
 *
 * Mounted in `_authed` rather than `_app`, so a person on settings or admin can start a chat
 * without first clicking back into the app frame. Renders nothing; it exists to be a component
 * because binding needs hooks and `_authed`'s route component is where the whole signed-in tree
 * hangs.
 */
export function AppHotkeys() {
  const navigate = useNavigate();

  // Same destination as the sidebar's + button: the new-channel composer.
  useHotkey("new-chat", () => {
    navigate({ to: "/channel/new" });
  });

  // The two modals, which the account menu and the Connect apps pill also open. Settings and the
  // Marketplace are routes, so opening one is a navigation and closing it goes back to whatever
  // the app shell remembered (lib/return-to.ts).
  useHotkey("settings", () => {
    navigate({ to: "/settings" });
  });
  useHotkey("marketplace", () => {
    navigate({ to: MARKETPLACE_PATH });
  });

  return null;
}
