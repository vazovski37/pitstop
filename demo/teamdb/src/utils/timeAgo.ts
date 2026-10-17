const UNITS: [name: string, ms: number][] = [
  ["year", 365 * 86_400_000],
  ["month", 30 * 86_400_000],
  ["day", 86_400_000],
  ["hour", 3_600_000],
  ["minute", 60_000],
];

/** "3 hours ago", "1 day ago", or "just now" for anything under a minute. */
export function timeAgo(date: Date, now = new Date()): string {
  const elapsed = now.getTime() - date.getTime();
  for (const [name, ms] of UNITS) {
    const count = Math.floor(elapsed / ms);
    if (count >= 1) return `${count} ${name}${count === 1 ? "" : "s"} ago`;
  }
  return "just now";
}
