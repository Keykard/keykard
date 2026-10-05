/**
 * One money operation per line at a time. "Pay now", the scheduler (statements, grace retries, default), money
 * arriving at a repayment address and collateral changes all read a line, move money, then write the line back.
 * Run concurrently on the same line they act on stale numbers and collect twice. Every entry point takes this
 * lock and RE-READS the line inside it. The servicer is a single process, so an in-process queue is enough.
 * Never call withLine from inside another withLine for the same line (it would wait on itself).
 */
const tails = new Map<string, Promise<void>>()

export async function withLine<T>(lineId: number | string | bigint, fn: () => Promise<T>): Promise<T> {
  const k = String(lineId)
  const prev = tails.get(k) ?? Promise.resolve()
  let release!: () => void
  const mine = new Promise<void>((r) => (release = r))
  const tail = prev.then(() => mine)
  tails.set(k, tail)
  await prev
  try {
    return await fn()
  } finally {
    release()
    if (tails.get(k) === tail) tails.delete(k)
  }
}
