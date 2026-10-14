/**
 * How a row of the account menu looks: links, the sign-out button, and the Language row that opens
 * its own small menu. One class, so the rows never drift apart, in its own module so the Language row
 * can share it without importing the menu that contains it.
 */
export const rowClassName =
  "flex h-11 w-full items-center gap-3 rounded-lg px-3 text-left text-[15px] text-foreground outline-none hover:bg-muted focus-visible:bg-muted data-popup-open:bg-muted [&_svg]:size-5 [&_svg]:shrink-0 [&_svg]:text-muted-foreground";
