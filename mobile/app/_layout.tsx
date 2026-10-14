import * as Notifications from "expo-notifications";
import { router, Stack } from "expo-router";
import { useEffect, useRef } from "react";
import { authClient } from "../src/auth";
import { bootLocale, useT } from "../src/i18n";
import { notificationDestination } from "../src/links";

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});
export default function Layout() {
  const { data: session } = authClient.useSession();
  const t = useT();
  // The language chosen on this phone before, from the first screen on.
  useEffect(() => {
    void bootLocale();
  }, []);
  const pending = useRef<unknown>(null);
  const handled = useRef<string | null>(null);
  useEffect(() => {
    const open = (response: Notifications.NotificationResponse) => {
      const id = response.notification.request.identifier;
      if (handled.current === id) return;
      pending.current = response.notification.request.content.data;
      if (session) {
        const destination = notificationDestination(pending.current);
        if (destination) router.push(destination);
        handled.current = id;
        pending.current = null;
      }
    };
    const last = Notifications.getLastNotificationResponse();
    if (last) open(last);
    const subscription =
      Notifications.addNotificationResponseReceivedListener(open);
    return () => subscription.remove();
  }, [session]);
  return (
    <Stack screenOptions={{ headerBackTitle: t("Back") }}>
      <Stack.Screen name="index" options={{ title: "OpenBot" }} />
      <Stack.Screen
        name="conversation"
        options={{ title: t("Conversation") }}
      />
      <Stack.Screen name="approvals" options={{ title: t("Approval inbox") }} />
      <Stack.Screen name="bots" options={{ title: t("Bots") }} />
      <Stack.Screen name="bot" options={{ title: t("Bot") }} />
      <Stack.Screen name="computer" options={{ title: t("Computer") }} />
      <Stack.Screen name="routine" options={{ title: t("Routine") }} />
      <Stack.Screen name="memory" options={{ title: t("Memory") }} />
      <Stack.Screen name="rules" options={{ title: t("Custom rules") }} />
      <Stack.Screen name="plugins" options={{ title: t("Plugins") }} />
    </Stack>
  );
}
