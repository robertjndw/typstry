/**
 * Runs async tasks one after another, in the order they were queued. A
 * failing task is logged under `label` and does not stop the ones after it.
 */
export function createSerialQueue(
  label: string,
): (task: () => Promise<void>) => Promise<void> {
  let tail: Promise<void> = Promise.resolve();
  return (task) => {
    tail = tail.then(task).catch((error: unknown) => {
      console.error(label, error);
    });
    return tail;
  };
}
