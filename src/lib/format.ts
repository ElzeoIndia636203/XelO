const IST = 'Asia/Kolkata';

export function formatDateIst(input: string | Date): string {
  const d = typeof input === 'string' ? new Date(input) : input;
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: IST,
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(d);
}

export function formatTimeIst(input: string | Date): string {
  const d = typeof input === 'string' ? new Date(input) : input;
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: IST,
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  }).format(d);
}

export function formatDateTimeIst(input: string | Date): string {
  return `${formatDateIst(input)}, ${formatTimeIst(input)}`;
}

export function todayIso(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: IST,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const year = parts.find((p) => p.type === 'year')?.value ?? '1970';
  const month = parts.find((p) => p.type === 'month')?.value ?? '01';
  const day = parts.find((p) => p.type === 'day')?.value ?? '01';
  return `${year}-${month}-${day}`;
}
