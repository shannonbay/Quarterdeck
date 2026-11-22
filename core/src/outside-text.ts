/**
 * Cleaning for text that comes from outside (issues, review comments, watch lines):
 * it can carry instructions a person never sees, so what a run reads should show
 * where something was hidden instead of passing it on.
 */

/** Control characters, zero-width and text-direction marks: they could hide or reorder what is shown. */
export function isHidden(code: number): boolean {
  return code < 0x20 || (code >= 0x7f && code <= 0x9f) || (code >= 0x200b && code <= 0x200f)
    || (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069)
}

/** Invisible in outside text: isHidden but keeping tabs and line breaks, plus word joiners and the BOM. */
function isInvisible(code: number): boolean {
  if (code === 0x09 || code === 0x0a || code === 0x0d) return false
  return isHidden(code) || (code >= 0x2060 && code <= 0x2064) || code === 0xfeff
}

/** Unicode tag characters (U+E0000 to U+E007F): invisible letters that can spell out text. */
function isTag(code: number): boolean {
  return code >= 0xe0000 && code <= 0xe007f
}

export interface CleanedText {
  text: string
  removed: { comments: number; invisible: number; tags: number }
}

/** True when cleaning removed anything. */
export function removedAny(removed: CleanedText['removed']): boolean {
  return removed.comments + removed.invisible + removed.tags > 0
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

/**
 * Drops HTML comments (an unterminated one runs to the end of the text),
 * invisible and text-direction characters, and tag characters, putting a
 * visible marker where each was, and counts what it removed. With markers
 * false (a one-line status), comments and tag characters go without a trace
 * and invisible characters become spaces.
 */
export function cleanOutsideText(text: string, { markers = true }: { markers?: boolean } = {}): CleanedText {
  const removed = { comments: 0, invisible: 0, tags: 0 }
  const noComments = text.replace(/<!--[\s\S]*?(?:-->|$)/g, () => {
    removed.comments++
    return markers ? '[hidden comment removed]' : ''
  })
  let out = ''
  let run = 0
  let runKind: 'invisible' | 'tags' | null = null
  const flush = () => {
    if (runKind && !markers) out += runKind === 'tags' ? '' : ' '
    else if (runKind) out += `[${plural(run, runKind === 'tags' ? 'tag character' : 'invisible character')} removed]`
    run = 0
    runKind = null
  }
  for (const c of noComments) {
    const code = c.codePointAt(0)!
    const kind = isTag(code) ? 'tags' : isInvisible(code) ? 'invisible' : null
    if (kind) {
      removed[kind]++
      if (runKind !== kind) flush()
      runKind = kind
      run++
    } else {
      flush()
      out += c
    }
  }
  flush()
  return { text: out, removed }
}
