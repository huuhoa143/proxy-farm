/** Folds text for accent- and case-insensitive search: "Đà Nẵng" → "da nang". */
export function normaliseSearch(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase();
}
