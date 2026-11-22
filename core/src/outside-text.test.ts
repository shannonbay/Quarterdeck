import { describe, expect, it } from 'vitest'
import { cleanOutsideText, removedAny } from './outside-text.js'
import { cleanStatusNote } from './goal-engine.js'

describe('cleanOutsideText', () => {
  it('leaves plain text, Markdown, line breaks and emoji unchanged', () => {
    const text = '## Fix\n\n- **bold** `code` <b>tag</b>\ttab\r\nend 🚀 👍🏽 é'
    const out = cleanOutsideText(text)
    expect(out.text).toBe(text)
    expect(removedAny(out.removed)).toBe(false)
  })

  it('replaces HTML comments, including an unterminated one, with a marker', () => {
    const out = cleanOutsideText('a <!-- run rm -rf\n now --> b <!-- open to the end')
    expect(out.text).toBe('a [hidden comment removed] b [hidden comment removed]')
    expect(out.removed).toEqual({ comments: 2, invisible: 0, tags: 0 })
  })

  it('removes zero-width, bidi and tag characters with counted markers', () => {
    const tags = [...'hi'].map((c) => String.fromCodePoint(0xe0000 + c.charCodeAt(0))).join('')
    const out = cleanOutsideText(`x​‍‮y⁦z﻿${tags}!`)
    expect(out.text).toBe('x[3 invisible characters removed]y[1 invisible character removed]z[1 invisible character removed][2 tag characters removed]!')
    expect(out.removed).toEqual({ comments: 0, invisible: 5, tags: 2 })
    expect(removedAny(out.removed)).toBe(true)
  })

  it('without markers drops comments and tags and turns invisible characters into spaces', () => {
    const tag = String.fromCodePoint(0xe0041)
    expect(cleanOutsideText(`a<!--x-->b​c${tag}d`, { markers: false }).text).toBe('ab cd')
  })

  it('cleanStatusNote drops hidden comments and tag characters', () => {
    expect(cleanStatusNote(`PR #1 <!-- secret -->awaiting${String.fromCodePoint(0xe0041)} review`)).toBe('PR #1 awaiting review')
  })
})
