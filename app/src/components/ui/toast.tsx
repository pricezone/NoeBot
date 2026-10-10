import { Toast } from "@base-ui/react/toast";

import { cn } from "@/lib/utils";

/**
 * A short confirmation that something happened where nothing on screen shows it: a conversation
 * id copied to the clipboard is the first, since the clipboard has no look of its own.
 *
 * One manager for the whole app, created at module scope, so `toast()` can be called from an event
 * handler anywhere without a hook — and called harmlessly where no `<Toaster />` is mounted, such
 * as a test rendering a single row, which simply shows nothing. The `<Toaster />` is mounted once,
 * in the app shell (`routes/_authed/_app.tsx`).
 *
 * Not for failures. A refusal is said where the person was looking, next to what refused (see the
 * row's own alert in `app-sidebar/channel.tsx`), because a toast in a corner is easy to miss and
 * gone before it can be reread.
 */
const toastManager = Toast.createToastManager();

/** Say one short thing, for a few seconds. */
export function toast(title: string) {
  toastManager.add({ title, timeout: 2500 });
}

export function Toaster() {
  return (
    <Toast.Provider toastManager={toastManager}>
      <Toast.Portal>
        <Toast.Viewport className="pointer-events-none fixed inset-x-0 bottom-6 z-[60] flex flex-col items-center gap-2 px-4 outline-none">
          <ToastList />
        </Toast.Viewport>
      </Toast.Portal>
    </Toast.Provider>
  );
}

function ToastList() {
  const { toasts } = Toast.useToastManager();
  return toasts.map((item) => (
    <Toast.Root
      key={item.id}
      toast={item}
      className={cn(
        "pointer-events-auto rounded-full bg-foreground px-4 py-2 text-[14px] text-background shadow-lg",
        "transition duration-150 ease-out data-ending-style:translate-y-2 data-ending-style:opacity-0 data-starting-style:translate-y-2 data-starting-style:opacity-0",
      )}
    >
      <Toast.Content>
        <Toast.Title />
      </Toast.Content>
    </Toast.Root>
  ));
}
