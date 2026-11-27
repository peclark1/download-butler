export function concurrency(value = 3) {
  if (!Number.isSafeInteger(value) || value < 0) throw Error('Enter a whole number of 0 or greater.');
  return value;
}
export function availableSlots(limit, active, queued) {
  return limit === 0 ? queued : Math.min(queued, Math.max(0, limit - active));
}
