import { Link, router } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import {
  Button,
  Pressable,
  RefreshControl,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import { api, type Conversation } from "../src/api";
import { authClient, serverUrl, signIn, signInEnterprise } from "../src/auth";
import { getLocale, useLocale, useT } from "../src/i18n";
import { LOCALE_LABELS, LOCALES, type Locale } from "../src/i18n/locales";
import { chooseLocale, settleSignedInLocale } from "../src/i18n/sync";
import { registerPush, unregisterPush } from "../src/notifications";
import { useLoad } from "../src/use-load";
export default function Home() {
  const { data: session, isPending } = authClient.useSession();
  const t = useT();
  const locale = useLocale();
  const [offered, setOffered] = useState<Locale[]>(["en"]);
  const [localeNote, setLocaleNote] = useState("");
  const [error, setError] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [pushRegistered, setPushRegistered] = useState(false);
  const [older, setOlder] = useState<Conversation[]>([]);
  const [olderCursor, setOlderCursor] = useState<string | null | undefined>();
  // Once per sign-in: the language this person chose here or on the web, and which ones are offered.
  // biome-ignore lint/correctness/useExhaustiveDependencies: settle for whoever is signed in now
  useEffect(() => {
    if (!session) return;
    let live = true;
    void settleSignedInLocale().then((locales) => {
      if (live) setOffered(locales);
    });
    return () => {
      live = false;
    };
  }, [session?.user.id]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: reload for whoever is signed in now, not the previous person
  useEffect(() => {
    setOlder([]);
    setOlderCursor(undefined);
    setPushRegistered(false);
  }, [session?.user.id]);
  const loadOptions = useCallback(
    () =>
      api<{
        authProviders?: ("google" | "microsoft" | "okta")[];
        ssoConfigured?: boolean;
      }>("/api/capabilities"),
    [],
  );
  const options = useLoad(loadOptions, !session);
  // biome-ignore lint/correctness/useExhaustiveDependencies: reload for whoever is signed in now, not the previous person
  const loadConversations = useCallback(
    () =>
      api<{ conversations: Conversation[]; nextCursor: string | null }>(
        "/api/delivery/conversations",
      ),
    [session?.user.id],
  );
  const conversations = useLoad(loadConversations, Boolean(session));
  const nextCursor =
    olderCursor === undefined ? conversations.data?.nextCursor : olderCursor;
  const allConversations = Array.from(
    new Map(
      [...(conversations.data?.conversations ?? []), ...older].map((item) => [
        item.id,
        item,
      ]),
    ).values(),
  );
  async function act(work: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : t("Could not complete this action."),
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <ScrollView
      contentContainerStyle={{ padding: 20, gap: 16 }}
      refreshControl={
        <RefreshControl
          refreshing={conversations.pending}
          onRefresh={() => {
            void conversations.refresh();
          }}
        />
      }
    >
      <Text style={{ fontSize: 24, fontWeight: "600" }}>
        {session
          ? t("Welcome, {{name}}", {
              name: session.user.name ?? session.user.email,
            })
          : t("Sign in to OpenBot")}
      </Text>
      <Text>{serverUrl}</Text>
      {(error || options.error || conversations.error) && (
        <Text accessibilityRole="alert" style={{ color: "#b42318" }}>
          {error || options.error || conversations.error}
        </Text>
      )}
      {!session ? (
        <View style={{ gap: 12 }}>
          <Text>
            {isPending
              ? t("Checking your session…")
              : t("Continue with your organization account.")}
          </Text>
          {options.data?.authProviders?.map((provider) => (
            <Button
              key={provider}
              disabled={busy}
              title={t("Sign in with {{provider}}", { provider })}
              onPress={() => {
                void act(async () => {
                  await signIn(provider);
                  router.replace("/");
                });
              }}
            />
          ))}
          {options.data?.ssoConfigured && (
            <>
              <TextInput
                accessibilityLabel={t("Work email")}
                placeholder={t("Work email")}
                keyboardType="email-address"
                autoCapitalize="none"
                value={email}
                onChangeText={setEmail}
                style={{ borderWidth: 1, padding: 12 }}
              />
              <Button
                disabled={busy || !email}
                title={t("Continue with organization")}
                onPress={() => {
                  void act(() => signInEnterprise(email));
                }}
              />
            </>
          )}
        </View>
      ) : (
        <>
          <Link href="/approvals" style={{ fontSize: 18, color: "#2563eb" }}>
            {t("Questions and approvals")}
          </Link>
          <Link href="/bots" style={{ fontSize: 18, color: "#2563eb" }}>
            {t("Bots, routines and computers")}
          </Link>
          <Link href="/memory" style={{ fontSize: 18, color: "#2563eb" }}>
            {t("Memory")}
          </Link>
          <Button
            disabled={busy}
            title={
              pushRegistered
                ? t("Notifications enabled")
                : t("Enable notifications")
            }
            onPress={() => {
              void act(async () => {
                await registerPush();
                setPushRegistered(true);
              });
            }}
          />
          <Text style={{ fontSize: 20, fontWeight: "600" }}>
            {t("Conversations")}
          </Text>
          {allConversations.map((conversation) => (
            <Link
              key={conversation.id}
              href={{
                pathname: "/conversation",
                params: { channelId: conversation.id },
              }}
              style={{ paddingVertical: 12, color: "#2563eb" }}
            >
              {conversation.name}
              {conversation.active ? "" : t(" (inactive)")}
            </Link>
          ))}
          {nextCursor && (
            <Button
              title={t("Older conversations")}
              disabled={busy}
              onPress={() => {
                void act(async () => {
                  const page = await api<{
                    conversations: Conversation[];
                    nextCursor: string | null;
                  }>(
                    `/api/delivery/conversations?cursor=${encodeURIComponent(nextCursor)}`,
                  );
                  setOlder((items) => [...items, ...page.conversations]);
                  setOlderCursor(page.nextCursor);
                });
              }}
            />
          )}
          {allConversations.length === 0 && (
            <Text>
              {t(
                "No conversations yet. Create one in OpenBot on your computer.",
              )}
            </Text>
          )}
          {/* Shown once this deployment offers another language, or this phone already speaks one. */}
          {(offered.length > 1 || locale !== "en") && (
            <View accessibilityRole="radiogroup" style={{ gap: 8 }}>
              <Text style={{ fontSize: 18, fontWeight: "600" }}>
                {t("Language")}
              </Text>
              <View style={{ flexDirection: "row", gap: 8 }}>
                {LOCALES.map((option) => (
                  <Pressable
                    key={option}
                    accessibilityRole="radio"
                    accessibilityState={{ checked: option === locale }}
                    accessibilityLanguage={option}
                    disabled={busy}
                    onPress={() => {
                      setLocaleNote("");
                      void chooseLocale(option).then((saved) => {
                        if (!saved && getLocale() === option)
                          setLocaleNote(t("Saved on this phone only."));
                      });
                    }}
                    style={{
                      borderWidth: option === locale ? 2 : 1,
                      borderColor: option === locale ? "#2563eb" : "#9ca3af",
                      borderRadius: 8,
                      paddingVertical: 10,
                      paddingHorizontal: 14,
                    }}
                  >
                    <Text>
                      {option === locale ? "✓ " : ""}
                      {LOCALE_LABELS[option]}
                    </Text>
                  </Pressable>
                ))}
              </View>
              {localeNote ? (
                <Text style={{ color: "#6b7280" }}>{localeNote}</Text>
              ) : null}
            </View>
          )}
          <Button
            disabled={busy}
            title={t("Sign out")}
            onPress={() => {
              void act(async () => {
                await unregisterPush();
                const result = await authClient.signOut();
                if (result.error)
                  throw new Error(
                    result.error.message ?? t("Could not sign out."),
                  );
              });
            }}
          />
        </>
      )}
    </ScrollView>
  );
}
