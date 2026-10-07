/**
 * A function that applies each call's argument in the order the calls were made, one at a time.
 *
 * For input arriving over a socket. Bun hands a websocket handler the next message without waiting
 * for an async handler to finish, so two messages whose handling awaits different things finish in
 * whichever order those things settle: a key's "down" that awaits the page lands after its "up" that
 * does not. Each call here waits for the one before it. A call that fails is reported to its caller
 * and does not stop the next.
 */
export function inOrder<T>(
  apply: (item: T) => Promise<void>,
): (item: T) => Promise<void> {
  let last: Promise<void> = Promise.resolve();
  return (item) => {
    const next = last.then(() => apply(item));
    last = next.catch(() => undefined);
    return next;
  };
}
