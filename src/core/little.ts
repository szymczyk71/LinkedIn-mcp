/**
 * Format "little" pola commentary w Posts API (learn.microsoft.com/linkedin/marketing/community-management/shares/little-text-format):
 * znaki zastrzeżone  | { } @ [ ] ( ) < > # \ * _ ~  trzeba poprzedzić ukośnikiem, żeby były zwykłym tekstem.
 *
 * Zasada: treść ma się ukazać dokładnie tak, jak w podglądzie, więc escapujemy wszystkie znaki zastrzeżone
 * z jednym wyjątkiem - "#słowo" na początku słowa zostaje hashtagiem (HashtagElement: '#' SINGLE_WORD),
 * bo tak zachowuje się LinkedIn przy ręcznym pisaniu posta. "C#" albo "# " to zwykły tekst.
 * Wzmianki (@[Nazwa](urn)) nie są tworzone - "@" zawsze jest tekstem.
 */

const RESERVED = /[|{}@[\]()<>#\\*_~]/g;
const WORD_CHAR = /[\p{L}\p{N}]/u;

export function escapeLittle(text: string): string {
  return text.replace(RESERVED, (ch: string, offset: number) => {
    if (ch === '#') {
      const next = text.slice(offset + 1, offset + 3);
      const prev = offset > 0 ? text.slice(Math.max(0, offset - 2), offset) : '';
      const startsWord = !prev || !WORD_CHAR.test([...prev].pop() ?? '');
      if (startsWord && WORD_CHAR.test([...next][0] ?? '')) return '#';
    }
    return '\\' + ch;
  });
}

/** Hashtagi, które LinkedIn rozpozna (do podglądu). */
export function extractHashtags(text: string): string[] {
  const out: string[] = [];
  const re = /(^|[^\p{L}\p{N}])#([\p{L}\p{N}]+)/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push(m[2]!);
  return out;
}
