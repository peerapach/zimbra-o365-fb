// Candidate mappings only; the deployed EWS/Graph parser still uses fixed profiles.
// Windows IDs refer to the reviewed geography, never a guessed current offset.
const candidates: Readonly<Record<string, string>> = Object.freeze({
  UTC: 'Etc/UTC',
  'Etc/UTC': 'Etc/UTC',
  'Asia/Bangkok': 'Asia/Bangkok',
  'SE Asia Standard Time': 'Asia/Bangkok',
  'Europe/London': 'Europe/London',
  'GMT Standard Time': 'Europe/London',
  'America/Los_Angeles': 'America/Los_Angeles',
  'Pacific Standard Time': 'America/Los_Angeles',
});

export function resolveCandidateZone(value: unknown): string {
  if (typeof value !== 'string' || !Object.hasOwn(candidates, value)) throw new RangeError('Unsupported candidate timezone');
  return candidates[value]!;
}
