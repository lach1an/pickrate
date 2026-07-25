/**
 * Run `tasks` with at most `limit` in flight, preserving result order.
 *
 * Deliberately dependency-free and deliberately small — the runner is the only
 * part of pickrate that costs money, so its scheduling should be readable at a
 * glance rather than delegated.
 */
export async function mapPool<T, R>(
  items: T[],
  limit: number,
  task: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  const width = Math.max(1, Math.min(limit, items.length));
  let next = 0;

  const workers = Array.from({ length: width }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await task(items[index]!, index);
    }
  });

  await Promise.all(workers);
  return results;
}
