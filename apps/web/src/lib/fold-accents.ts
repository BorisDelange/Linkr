/** Letters NFD leaves whole: ligatures and stroked letters have no base + mark form. */
const LETTERS: Record<string, string> = {
  œ: 'oe', Œ: 'OE', æ: 'ae', Æ: 'AE', ß: 'ss', ẞ: 'SS', ø: 'o', Ø: 'O',
  đ: 'd', Đ: 'D', ł: 'l', Ł: 'L', þ: 'th', Þ: 'TH', ð: 'd', Ð: 'D', ı: 'i',
}
const LETTER = new RegExp(`[${Object.keys(LETTERS).join('')}]`, 'g')

/**
 * The text with its accents dropped — "Décédés cœur" → "Decedes coeur" — for
 * names that must be ASCII (aliases, file names, anchors) yet stay readable.
 */
export function foldAccents(text: string): string {
  return text.normalize('NFD').replace(/\p{Mn}/gu, '').replace(LETTER, (c) => LETTERS[c])
}
