import type { RuntimeModel } from "../copilot";

/**
 * The one model call the router makes, kept apart from the routing logic so that logic stays a pure
 * function the tests drive without a network. This reuses the deployment's own model and key — the
 * same ones the built-in coworkers answer on — so a router is never a second thing to configure.
 *
 * It throws on a missing key or a bad response on purpose: the router treats a throw as "not sure"
 * and lands on the default, so failure here is a soft landing, not an error a person sees.
 */
export function createModelCompleter(deps: {
  model: RuntimeModel;
  resolveApiKey: () => Promise<string | null>;
}): (prompt: string, signal?: AbortSignal) => Promise<string> {
  return async (prompt: string, signal?: AbortSignal) => {
    signal?.throwIfAborted();
    const key = await deps.resolveApiKey();
    signal?.throwIfAborted();
    if (!key) throw new Error("no model key");
    const anthropic = deps.model.provider === "anthropic";
    const response = await fetch(
      anthropic
        ? anthropicMessagesUrl(process.env)
        : chatCompletionsUrl(process.env),
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(anthropic
            ? { "x-api-key": key, "anthropic-version": "2023-06-01" }
            : { authorization: `Bearer ${key}` }),
        },
        body: JSON.stringify({
          model: deps.model.defaultModel,
          /*
           * No temperature.
           *
           * It was zero, for a router that answers the same way twice. Reasoning models refuse the
           * setting outright — "Unsupported value: 'temperature' does not support 0 with this model.
           * Only the default (1) value is supported" — and this call treats a throw as "not sure", so
           * every routing decision quietly became the default coworker and the roster was never
           * consulted. A question naming Google Drive went to a Bot holding no Drive tools, which is
           * the exact failure the roster exists to prevent, and nothing said so.
           *
           * Omitted rather than set per model, because a list of which models accept it is a list that
           * goes stale. `response_format` and a prompt that asks for one object keep the answer tight,
           * and the confidence floor still sends an unsure match to the default.
           */
          ...(anthropic
            ? { max_tokens: 1024 }
            : { response_format: { type: "json_object" } }),
          messages: [{ role: "user", content: prompt }],
        }),
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(10_000)])
          : AbortSignal.timeout(10_000),
      },
    );
    if (!response.ok)
      throw new Error(`router model answered ${response.status}`);
    const body = (await response.json()) as {
      choices?: { message?: { content?: unknown } }[];
      content?: { type?: string; text?: unknown }[];
    };
    const content = anthropic
      ? body.content
          ?.filter(
            (block) => block.type === "text" && typeof block.text === "string",
          )
          .map((block) => block.text)
          .join("") || undefined
      : body.choices?.[0]?.message?.content;
    if (typeof content !== "string")
      throw new Error("router model returned no text");
    return content;
  };
}

/**
 * Where this deployment's `/chat/completions` actually is.
 *
 * `/v1` USED TO BE APPENDED UNCONDITIONALLY, and that was wrong for every deployment that set the
 * variable. `.env.example` and `docs/configuration.md` both document it with the version in it
 * (`https://gateway.internal/v1`), because that is the shape the AI SDK wants: it takes `baseURL`
 * verbatim and asks for `/chat/completions` under it, which is how the built-in Bots reach the same
 * endpoint. Appending here produced `/v1/v1/chat/completions`, so on a gateway — the entire reason
 * the variable exists — every call from this function 404'd.
 *
 * That failure was invisible, which is the worst part. The router treats a throw as "not sure" and
 * lands on the default coworker, so a deployment behind a gateway silently stopped routing and
 * nothing anywhere said why. Tool selection reads through the same function and would have failed
 * the same way, offering the whole catalogue on the deployments most likely to have a big one.
 *
 * So the version segment is added only when the configured URL does not already end in one, and the
 * unset case keeps the public API's own `https://api.openai.com/v1`.
 */
export function chatCompletionsUrl(
  environment: Record<string, string | undefined>,
): string {
  const base = (environment.OPENAI_BASE_URL?.trim() || "https://api.openai.com")
    // A trailing slash is the difference between `/v1` and `/v1/`, and no more than that.
    .replace(/\/+$/, "");
  return /\/v\d+$/.test(base)
    ? `${base}/chat/completions`
    : `${base}/v1/chat/completions`;
}

/** Native Anthropic endpoint, accepting the same versioned base URL as the runtime. */
export function anthropicMessagesUrl(
  environment: Record<string, string | undefined>,
): string {
  const base = (
    environment.ANTHROPIC_BASE_URL?.trim() || "https://api.anthropic.com"
  ).replace(/\/+$/, "");
  return /\/v\d+$/.test(base) ? `${base}/messages` : `${base}/v1/messages`;
}

/** One look at a screen: a system prompt, the words, and one picture. */
export type VisionRequest = {
  system: string;
  text: string;
  /**
   * A JPEG, base64, without the `data:` prefix. Absent when the picture could not be taken in time:
   * the look goes ahead on the words alone.
   */
  image?: string;
  signal?: AbortSignal;
  /** The answer's text as it arrives, a piece at a time. Not called on the Anthropic path. */
  onText?: (chunk: string) => void;
};

/**
 * How long a look may go without a word from the model, while it is being asked and while it
 * answers: a model that is still writing is waited for, one that has gone quiet is not.
 */
export const VISION_IDLE_MS = 12_000;
/** How long one look may take at most, however steadily it answers. */
export const VISION_TOTAL_MS = 30_000;

/**
 * A signal for one model call: the caller's, the overall cap, and the quiet one. `progress()` is
 * called whenever the model says anything, and restarts the quiet clock; `done()` stops both.
 */
export function visionDeadline(
  outer: AbortSignal | undefined,
  options: { idleMs?: number | null; totalMs?: number } = {},
) {
  const controller = new AbortController();
  const totalMs = options.totalMs ?? VISION_TOTAL_MS;
  const idleMs = options.idleMs === undefined ? VISION_IDLE_MS : options.idleMs;
  const total = setTimeout(
    () =>
      controller.abort(
        new Error(`the model took longer than ${Math.round(totalMs / 1000)} s`),
      ),
    totalMs,
  );
  let idle: ReturnType<typeof setTimeout> | undefined;
  const progress = () => {
    if (idleMs === null) return;
    if (idle) clearTimeout(idle);
    idle = setTimeout(
      () =>
        controller.abort(
          new Error(
            `the model said nothing for ${Math.round(idleMs / 1000)} s`,
          ),
        ),
      idleMs,
    );
  };
  progress();
  return {
    signal: outer
      ? AbortSignal.any([outer, controller.signal])
      : controller.signal,
    /** Why it was given up, when it was ours and not the caller's. */
    reason: () =>
      controller.signal.aborted ? (controller.signal.reason as Error) : null,
    progress,
    done() {
      clearTimeout(total);
      if (idle) clearTimeout(idle);
    },
  };
}

/** An HTTP failure, with the start of what the model's server said about it. */
async function answeredError(response: Response): Promise<Error> {
  const said = (await response.text().catch(() => ""))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
  return new Error(
    `vision model answered ${response.status}${said ? `: ${said}` : ""}`,
  );
}

/**
 * How long one look's answer may be: room for a walkthrough of eight steps, each with a point and a
 * box, and a proposal beside it. An answer cut off is not JSON, and reads as a failed look.
 */
export const VISION_MAX_TOKENS = 1600;

/**
 * A model call that looks at a picture: Clicky's, the companion beside a Bot's screen.
 *
 * The deployment's own model and key, like `createModelCompleter`, unless `CLICKY_MODEL` names a
 * faster one on the same provider. It asks for one JSON object. On the OpenAI-compatible path the
 * answer streams (`onText`), so the person sees Clicky's words arrive rather than waiting for all of
 * them; the usage chunk at the end is asked for so a gateway that meters by it sees the call. The
 * Anthropic path is the Messages API with an image block, answered whole.
 *
 * Throws on a missing key, an HTTP failure, a timeout or an empty answer: the caller turns any of
 * them into Clicky's "I couldn't look at the screen" and the person can try again.
 */
export function createVisionCompleter(deps: {
  model: RuntimeModel;
  resolveApiKey: () => Promise<string | null>;
  environment?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  /** The quiet and overall limits; `VISION_IDLE_MS` and `VISION_TOTAL_MS` unless a test says. */
  deadlines?: { idleMs?: number; totalMs?: number };
}): (request: VisionRequest) => Promise<string> {
  const environment = deps.environment ?? process.env;
  const send = deps.fetchImpl ?? fetch;
  return async (request) => {
    request.signal?.throwIfAborted();
    const key = await deps.resolveApiKey();
    request.signal?.throwIfAborted();
    if (!key) throw new Error("no model key");
    const model = environment.CLICKY_MODEL?.trim() || deps.model.defaultModel;
    // The Anthropic path answers whole, so only the overall cap applies to it.
    const deadline = visionDeadline(request.signal, {
      idleMs:
        deps.model.provider === "anthropic"
          ? null
          : (deps.deadlines?.idleMs ?? VISION_IDLE_MS),
      ...(deps.deadlines?.totalMs ? { totalMs: deps.deadlines.totalMs } : {}),
    });
    try {
      return await ask(model, key, request, deadline);
    } catch (error) {
      // Ours (the model went quiet, or took too long): said as such, not as "operation timed out".
      const ours = deadline.reason();
      if (ours && !request.signal?.aborted) throw ours;
      throw error;
    } finally {
      deadline.done();
    }
  };

  async function ask(
    model: string,
    key: string,
    request: VisionRequest,
    deadline: ReturnType<typeof visionDeadline>,
  ): Promise<string> {
    const { signal } = deadline;
    if (deps.model.provider === "anthropic") {
      const response = await send(anthropicMessagesUrl(environment), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": key,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model,
          max_tokens: VISION_MAX_TOKENS,
          system: request.system,
          messages: [
            {
              role: "user",
              content: [
                ...(request.image
                  ? [
                      {
                        type: "image",
                        source: {
                          type: "base64",
                          media_type: "image/jpeg",
                          data: request.image,
                        },
                      },
                    ]
                  : []),
                { type: "text", text: request.text },
              ],
            },
          ],
        }),
        signal,
      });
      if (!response.ok) throw await answeredError(response);
      const body = (await response.json()) as {
        content?: { type?: string; text?: unknown }[];
      };
      const text = body.content
        ?.filter(
          (block) => block.type === "text" && typeof block.text === "string",
        )
        .map((block) => block.text)
        .join("");
      if (!text) throw new Error("vision model returned no text");
      return text;
    }

    const response = await send(chatCompletionsUrl(environment), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model,
        response_format: { type: "json_object" },
        stream: true,
        stream_options: { include_usage: true },
        messages: [
          { role: "system", content: request.system },
          {
            role: "user",
            content: [
              { type: "text", text: request.text },
              ...(request.image
                ? [
                    {
                      type: "image_url",
                      image_url: {
                        url: `data:image/jpeg;base64,${request.image}`,
                      },
                    },
                  ]
                : []),
            ],
          },
        ],
      }),
      signal,
    });
    if (!response.ok) throw await answeredError(response);
    deadline.progress();
    const text = await readChatStream(
      response,
      request.onText,
      deadline.progress,
      signal,
    );
    if (!text) throw new Error("vision model returned no text");
    return text;
  }
}

/**
 * The text of a streamed chat completion: `data:` lines of JSON chunks, each carrying a piece of the
 * answer in `choices[0].delta.content`, ending with `data: [DONE]`. A server that ignored `stream`
 * and answered with one ordinary JSON body is read as that instead.
 */
export async function readChatStream(
  response: Response,
  onText?: (chunk: string) => void,
  /** Anything at all arrived: the model is still there. */
  onProgress?: () => void,
  /** Stops the read where it is, whether or not the body itself heeds the request's signal. */
  signal?: AbortSignal,
): Promise<string> {
  const type = response.headers.get("content-type") ?? "";
  if (!response.body || type.includes("application/json")) {
    const body = (await response.json().catch(() => null)) as {
      choices?: { message?: { content?: unknown } }[];
    } | null;
    const content = body?.choices?.[0]?.message?.content;
    const text = typeof content === "string" ? content : "";
    if (text) onText?.(text);
    return text;
  }
  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  let pending = "";
  let text = "";
  const line = (raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed.startsWith("data:")) return;
    const data = trimmed.slice(5).trim();
    if (!data || data === "[DONE]") return;
    let chunk: { choices?: { delta?: { content?: unknown } }[] };
    try {
      chunk = JSON.parse(data);
    } catch {
      return;
    }
    const piece = chunk.choices?.[0]?.delta?.content;
    if (typeof piece === "string" && piece) {
      text += piece;
      onText?.(piece);
    }
  };
  const stopped = signal
    ? new Promise<never>((_resolve, reject) => {
        const stop = () => {
          reject(signal.reason ?? new Error("The read was stopped."));
          void reader.cancel().catch(() => undefined);
        };
        if (signal.aborted) stop();
        else signal.addEventListener("abort", stop, { once: true });
      })
    : undefined;
  stopped?.catch(() => undefined);
  for (;;) {
    const { value, done } = await (stopped
      ? Promise.race([reader.read(), stopped])
      : reader.read());
    if (done) break;
    onProgress?.();
    pending += decoder.decode(value, { stream: true });
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const raw of lines) line(raw);
  }
  // A read cut short is not an answer, however much of one had arrived.
  if (signal?.aborted)
    throw signal.reason ?? new Error("The read was stopped.");
  pending += decoder.decode();
  if (pending) line(pending);
  return text;
}
