export function workerIdleDelay(emptyPolls: number): number {
  return Math.min(15000, 1000 * 2 ** Math.min(4, Math.max(0, emptyPolls)));
}
