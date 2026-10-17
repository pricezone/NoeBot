import { cn } from "@/lib/utils";

/**
 * The three apps the "Connect apps" pill falls back on, at their published colours.
 *
 * Drawn inline for the reason `auth/provider-logo.tsx` gives: a mark that arrives over the
 * network can be missing exactly when the button has to read as a promise, and the sidebar is on
 * every screen. Each sits in the same square so the sidebar's circles and the Marketplace's tiles
 * line up; `className` sizes it, the default being the tile's 16px.
 */
type LogoProps = { className?: string };

/** Gmail's M: the red and the four colours of the envelope, on Google's published geometry. */
export function GmailLogo({ className }: LogoProps) {
  return (
    <svg
      aria-hidden="true"
      className={cn("size-4", className)}
      focusable="false"
      viewBox="0 0 48 48"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M4 38V13.5l20 15 20-15V38a3 3 0 0 1-3 3h-6V22l-11 8.25L13 22v19H7a3 3 0 0 1-3-3Z"
        fill="#EA4335"
      />
      <path
        d="M4 13.5V11a3 3 0 0 1 4.8-2.4L13 11.7V22L4 13.5Z"
        fill="#C5221F"
      />
      <path
        d="M44 13.5V11a3 3 0 0 0-4.8-2.4L35 11.7V22l9-8.5Z"
        fill="#C5221F"
      />
      <path d="M13 22V11.7l11 8.25 11-8.25V22l-11 8.25L13 22Z" fill="#FBBC04" />
      <path d="M13 11.7 24 19.95 35 11.7 24 3.5 13 11.7Z" fill="#34A853" />
      <path d="M13 22v19H7a3 3 0 0 1-3-3V13.5L13 22Z" fill="#4285F4" />
    </svg>
  );
}

/** Notion's N on its page: black on white in the light theme, inverted in the dark. */
export function NotionLogo({ className }: LogoProps) {
  return (
    <svg
      aria-hidden="true"
      className={cn("size-4 text-foreground", className)}
      focusable="false"
      viewBox="0 0 48 48"
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect fill="currentColor" height="40" rx="7" width="40" x="4" y="4" />
      <path
        d="M14 15.5h6.2L28.6 29V15.5H34v17h-6.2L19.4 19v13.5H14v-17Z"
        fill="var(--background)"
      />
    </svg>
  );
}

/** Google Drive's triangle, at the three published colours. */
export function GoogleDriveLogo({ className }: LogoProps) {
  return (
    <svg
      aria-hidden="true"
      className={cn("size-4", className)}
      focusable="false"
      viewBox="0 0 48 48"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="M17.6 6h12.8l13.3 23H30.4L17.6 6Z" fill="#FFC107" />
      <path d="m4.3 29 6.4-11L24 41H9.5L4.3 29Z" fill="#1FA463" />
      <path d="M43.7 29 38.5 41H9.5l6.4-11h27.8Z" fill="#4285F4" />
      <path d="M17.6 6 4.3 29l6.4-11L24 18 17.6 6Z" fill="#0F9D58" />
      <path d="M30.4 29 24 18l-6.4 11h12.8Z" fill="#2684FC" />
    </svg>
  );
}

/**
 * The fixed trio, in the order the pill shows them, keyed the way this deployment names each app:
 * Gmail is the Marketplace plugin, Notion and Google Drive the catalogue's own entries.
 */
export const FEATURED_APP_LOGOS: readonly {
  key: string;
  title: string;
  Logo: (props: LogoProps) => React.JSX.Element;
}[] = [
  { key: "45893410", title: "Gmail", Logo: GmailLogo },
  { key: "notion", title: "Notion", Logo: NotionLogo },
  { key: "google-drive", title: "Google Drive", Logo: GoogleDriveLogo },
];
