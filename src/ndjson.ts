export function toNdjson(items: ReadonlyArray<unknown>): string {
  return items.map((item) => JSON.stringify(item)).join('\n') + '\n';
}
