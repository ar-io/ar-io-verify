/**
 * Bounded concurrency primitive — runs at most `concurrency` async tasks at once.
 *
 * Returns a function that wraps a task. The wrapper resolves with the task's
 * value (or rejects with its error) once a slot is available and the task
 * completes. Slots are released regardless of success/failure.
 */
export function createLimit(concurrency: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let active = 0;
  const queue: Array<() => void> = [];

  const next = (): void => {
    if (active >= concurrency) return;
    const head = queue.shift();
    if (!head) return;
    active++;
    head();
  };

  return <T>(fn: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      queue.push(() => {
        fn()
          .then(resolve, reject)
          .finally(() => {
            active--;
            next();
          });
      });
      next();
    });
}
