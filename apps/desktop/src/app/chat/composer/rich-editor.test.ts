import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { rememberDesktopCommandsCatalog } from '@/lib/desktop-slash-commands'

import { insertInlineRefsIntoEditor } from './inline-refs'
import {
  caretOffsetInEditor,
  caretRevealScrollTop,
  composerPlainText,
  copyComposerSelectionWithoutCaretSentinel,
  deleteSelectionInEditor,
  insertComposerContentsAtCaret,
  normalizeComposerEditorDom,
  placeCaretAtOffset,
  placeCaretEnd,
  refChipElement,
  renderComposerContents,
  replaceBeforeCaret,
  RICH_INPUT_SLOT
} from './rich-editor'
import { placeCaretAtEnd } from './test-utils'

const WEBKIT_USER_AGENT =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1'

const CHROMIUM_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'

function useUserAgent(userAgent: string) {
  Object.defineProperty(navigator, 'userAgent', { configurable: true, value: userAgent })
}

beforeEach(() => {
  useUserAgent(CHROMIUM_USER_AGENT)
  rememberDesktopCommandsCatalog({
    commands: { '/goal': { argument_mode: 'mixed', desktop: null } }
  })
})

afterEach(() => {
  useUserAgent(CHROMIUM_USER_AGENT)
  rememberDesktopCommandsCatalog(undefined)
})

describe('renderComposerContents', () => {
  it('renders refs and raw text without interpreting user text as HTML', () => {
    const editor = document.createElement('div')
    editor.dataset.slot = RICH_INPUT_SLOT

    renderComposerContents(editor, '@file:`<img src=x onerror=alert(1)>` <b>raw</b>')

    expect(editor.querySelector('img')).toBeNull()
    expect(editor.querySelector('b')).toBeNull()
    expect(editor.textContent).toContain('<img src=x onerror=alert(1)>')
    expect(editor.textContent).toContain('<b>raw</b>')
    expect(composerPlainText(editor)).toBe('@file:`<img src=x onerror=alert(1)>` <b>raw</b>')
  })

  it('omits the caret sentinel from copied text and HTML', () => {
    useUserAgent(WEBKIT_USER_AGENT)
    const editor = document.createElement('div')
    editor.dataset.slot = RICH_INPUT_SLOT
    document.body.append(editor)
    renderComposerContents(editor, 'one\n')

    const range = document.createRange()
    range.selectNodeContents(editor)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)

    const setData = vi.fn()
    const preventDefault = vi.fn()

    const event = {
      clipboardData: { setData },
      preventDefault
    } as unknown as ClipboardEvent

    expect(copyComposerSelectionWithoutCaretSentinel(editor, event)).toBe(true)
    expect(preventDefault).toHaveBeenCalledOnce()
    expect(setData).toHaveBeenNthCalledWith(1, 'text/plain', 'one\n')
    expect(setData).toHaveBeenNthCalledWith(2, 'text/html', expect.not.stringContaining('data-composer-caret-sentinel'))

    selection.removeAllRanges()
    editor.remove()
  })

  it('hydrates a committed leading slash command back to its pill', () => {
    // Text-hydration parity with @ refs: a re-render from serialized text
    // (draft restore, undo, the trigger commit fallback) must not demote a
    // committed no-arg command chip to plain text.
    const editor = document.createElement('div')
    editor.dataset.slot = RICH_INPUT_SLOT

    renderComposerContents(editor, '/some-skill @folder:`Desktop` ')

    const pill = editor.querySelector('[data-slash-kind]')

    expect(pill?.getAttribute('data-ref-text')).toBe('/some-skill')
    expect(editor.querySelector('[data-ref-kind="folder"]')).not.toBeNull()
    expect(composerPlainText(editor)).toBe('/some-skill @folder:`Desktop` ')
  })

  it('keeps a still-typed leading slash token as editable text', () => {
    const editor = document.createElement('div')
    editor.dataset.slot = RICH_INPUT_SLOT

    // No trailing whitespace — not committed yet.
    renderComposerContents(editor, '/some-skil')

    expect(editor.querySelector('[data-slash-kind]')).toBeNull()
    expect(composerPlainText(editor)).toBe('/some-skil')
  })

  it('keeps an arg-taking command as text — its tail may be uncommitted prose', () => {
    const editor = document.createElement('div')
    editor.dataset.slot = RICH_INPUT_SLOT

    renderComposerContents(editor, '/goal ship the redesign')

    expect(editor.querySelector('[data-slash-kind]')).toBeNull()
    expect(composerPlainText(editor)).toBe('/goal ship the redesign')
  })

  it('adds a non-serialized caret sentinel after a trailing newline', () => {
    useUserAgent(WEBKIT_USER_AGENT)
    const editor = document.createElement('div')
    editor.dataset.slot = RICH_INPUT_SLOT
    document.body.append(editor)

    renderComposerContents(editor, 'one\n')

    const sentinel = editor.querySelector('[data-composer-caret-sentinel]')

    expect(sentinel).not.toBeNull()
    expect(composerPlainText(editor)).toBe('one\n')

    placeCaretEnd(editor)

    expect(caretOffsetInEditor(editor)).toBe(4)
    expect(window.getSelection()?.anchorNode).toBe(editor)
    expect(window.getSelection()?.anchorOffset).toBe(editor.childNodes.length - 1)

    placeCaretAtOffset(editor, 4)

    expect(window.getSelection()?.anchorNode).toBe(editor)
    expect(window.getSelection()?.anchorOffset).toBe(editor.childNodes.length - 1)

    editor.remove()
  })

  it('does not add a WebKit caret sentinel in Chromium', () => {
    useUserAgent(CHROMIUM_USER_AGENT)
    const editor = document.createElement('div')
    editor.dataset.slot = RICH_INPUT_SLOT

    renderComposerContents(editor, 'one\n')

    expect(composerPlainText(editor)).toBe('one\n')
    expect(editor.querySelector('[data-composer-caret-sentinel]')).toBeNull()
  })
})

describe('replaceBeforeCaret across split text nodes', () => {
  it('replaces a token that Chromium fragmented into multiple text nodes', () => {
    const editor = document.createElement('div')
    editor.dataset.slot = RICH_INPUT_SLOT
    editor.contentEditable = 'true'
    document.body.append(editor)
    editor.append(document.createTextNode('see @Desk'), document.createTextNode('top/'))

    const caret = document.createRange()
    caret.setStart(editor.lastChild!, 4)
    caret.collapse(true)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(caret)

    const fragment = document.createDocumentFragment()
    fragment.append(refChipElement('folder', '`Desktop`'), document.createTextNode(' '))

    // Token `@Desktop/` (9 chars) spans both text nodes.
    expect(replaceBeforeCaret(editor, 9, fragment)).toBe(true)
    expect(composerPlainText(editor)).toBe('see @folder:`Desktop` ')

    editor.remove()
  })

  it('refuses when a chip interrupts the span — the token is not contiguous text', () => {
    const editor = document.createElement('div')
    editor.dataset.slot = RICH_INPUT_SLOT
    editor.contentEditable = 'true'
    document.body.append(editor)
    editor.append(document.createTextNode('a'), refChipElement('file', '`x`'), document.createTextNode('bc'))

    const caret = document.createRange()
    caret.setStart(editor.lastChild!, 2)
    caret.collapse(true)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(caret)

    expect(replaceBeforeCaret(editor, 5, document.createDocumentFragment())).toBe(false)
    expect(composerPlainText(editor)).toBe('a@file:`x`bc')

    editor.remove()
  })
})

describe('normalizeComposerEditorDom', () => {
  it.each([
    [6, 6],
    [2, 12],
    [12, 2]
  ])('preserves selection %i → %i inside a native block wrapper', (anchor, focus) => {
    const editor = document.createElement('div')
    editor.dataset.slot = RICH_INPUT_SLOT
    editor.contentEditable = 'true'
    const wrapper = document.createElement('div')
    const text = document.createTextNode('still typing here')
    wrapper.append(text)
    editor.append(wrapper)
    document.body.append(editor)
    const selection = window.getSelection()!
    selection.setBaseAndExtent(text, anchor, text, focus)

    try {
      normalizeComposerEditorDom(editor)

      expect(composerPlainText(editor)).toBe('still typing here')
      expect(selection.anchorNode).toBe(text)
      expect(selection.anchorOffset).toBe(anchor)
      expect(selection.focusNode).toBe(text)
      expect(selection.focusOffset).toBe(focus)
    } finally {
      editor.remove()
    }
  })

  it('leaves another editor’s selection alone when normalizing a background draft', () => {
    const foreground = document.createElement('div')
    const text = document.createTextNode('foreground draft')
    foreground.append(text)
    const background = document.createElement('div')
    background.dataset.slot = RICH_INPUT_SLOT
    const wrapper = document.createElement('p')
    wrapper.textContent = 'background draft'
    background.append(wrapper)
    document.body.append(foreground, background)
    const selection = window.getSelection()!
    selection.setBaseAndExtent(text, 10, text, 3)

    try {
      normalizeComposerEditorDom(background)

      expect(composerPlainText(background)).toBe('background draft')
      expect(selection.anchorNode).toBe(text)
      expect(selection.anchorOffset).toBe(10)
      expect(selection.focusNode).toBe(text)
      expect(selection.focusOffset).toBe(3)
    } finally {
      foreground.remove()
      background.remove()
    }
  })

  it('unwraps a single insertHTML wrapper div so plain text stays one line', () => {
    const editor = document.createElement('div')
    editor.dataset.slot = RICH_INPUT_SLOT
    editor.innerHTML = '<div><span data-ref-text="@file:`src/foo.ts`" contenteditable="false">foo.ts</span> </div>'

    normalizeComposerEditorDom(editor)

    expect(composerPlainText(editor)).toBe('@file:`src/foo.ts` ')
    expect(editor.querySelector(':scope > div')).toBeNull()
  })

  it('removes a trailing br after a ref chip', () => {
    const editor = document.createElement('div')
    editor.dataset.slot = RICH_INPUT_SLOT
    editor.append(refChipElement('file', '`src/foo.ts`'), document.createElement('br'))

    normalizeComposerEditorDom(editor)

    expect(composerPlainText(editor)).toBe('@file:`src/foo.ts`')
    expect(editor.querySelector('br')).toBeNull()
  })

  it('preserves a live caret anchored in an empty direct text node', () => {
    const editor = document.createElement('div')
    editor.dataset.slot = RICH_INPUT_SLOT
    editor.contentEditable = 'true'
    document.body.append(editor)

    const leadingLitter = document.createTextNode('')
    const caretContainer = document.createTextNode('')
    const trailingLitter = document.createTextNode('')
    editor.append(leadingLitter, refChipElement('file', '`src/foo.ts`'), caretContainer, trailingLitter)

    const caret = document.createRange()
    caret.setStart(caretContainer, 0)
    caret.collapse(true)

    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(caret)

    normalizeComposerEditorDom(editor)

    expect(leadingLitter.isConnected).toBe(false)
    expect(trailingLitter.isConnected).toBe(false)
    expect(caretContainer.isConnected).toBe(true)
    expect(editor.contains(selection.getRangeAt(0).startContainer)).toBe(true)
    expect(selection.getRangeAt(0).startContainer).toBe(caretContainer)
    expect(composerPlainText(editor)).toBe('@file:`src/foo.ts`')

    selection.removeAllRanges()
    editor.remove()
  })
})

describe('insertInlineRefsIntoEditor', () => {
  it('inserts chips without wrapper divs or spurious newlines', () => {
    const editor = document.createElement('div')
    editor.dataset.slot = RICH_INPUT_SLOT

    insertInlineRefsIntoEditor(editor, ['@file:`src/foo.ts`'])

    expect(editor.querySelector(':scope > div')).toBeNull()
    expect(composerPlainText(editor)).toBe('@file:`src/foo.ts` ')
  })

  it('separates a chip from the word the caret sits after', () => {
    const editor = document.createElement('div')
    editor.dataset.slot = RICH_INPUT_SLOT
    editor.append(document.createTextNode('review'))
    document.body.append(editor)
    placeCaretAtEnd(editor)

    expect(insertInlineRefsIntoEditor(editor, ['@file:`src/a.ts`'])).toBe('review @file:`src/a.ts` ')

    editor.remove()
  })

  it('does not double the space when one is already there', () => {
    const editor = document.createElement('div')
    editor.dataset.slot = RICH_INPUT_SLOT
    editor.append(document.createTextNode('review '))
    document.body.append(editor)
    placeCaretAtEnd(editor)

    expect(insertInlineRefsIntoEditor(editor, ['@file:`src/a.ts`'])).toBe('review @file:`src/a.ts` ')

    editor.remove()
  })
})

describe('insertComposerContentsAtCaret', () => {
  it('keeps a newline inserted into an empty placeholder as real content', () => {
    const editor = document.createElement('div')
    editor.dataset.slot = RICH_INPUT_SLOT
    document.body.append(editor)
    normalizeComposerEditorDom(editor)
    placeCaretEnd(editor)

    insertComposerContentsAtCaret(editor, '\n')

    expect(composerPlainText(editor)).toBe('\n')
    normalizeComposerEditorDom(editor)
    expect(composerPlainText(editor)).toBe('\n')

    renderComposerContents(editor, '\n')
    normalizeComposerEditorDom(editor)
    expect(composerPlainText(editor)).toBe('\n')

    editor.remove()
  })

  it('inserts multiline text as text nodes + br', () => {
    const editor = document.createElement('div')
    editor.dataset.slot = RICH_INPUT_SLOT
    document.body.append(editor)
    placeCaretAtEnd(editor)

    insertComposerContentsAtCaret(editor, 'one\ntwo\nthree')

    expect(editor.querySelectorAll('br').length).toBe(2)
    expect(composerPlainText(editor)).toBe('one\ntwo\nthree')

    editor.remove()
  })

  it('keeps repeated trailing newlines reachable and inserts text before the sentinel', () => {
    useUserAgent(WEBKIT_USER_AGENT)
    const editor = document.createElement('div')
    editor.dataset.slot = RICH_INPUT_SLOT
    document.body.append(editor)

    renderComposerContents(editor, 'typed text')
    placeCaretEnd(editor)
    insertComposerContentsAtCaret(editor, '\n')

    expect(composerPlainText(editor)).toBe('typed text\n')
    expect(editor.querySelectorAll('[data-composer-line-break]')).toHaveLength(1)
    expect(editor.querySelectorAll('[data-composer-caret-sentinel]')).toHaveLength(1)

    placeCaretEnd(editor)
    insertComposerContentsAtCaret(editor, '\n')

    expect(composerPlainText(editor)).toBe('typed text\n\n')
    expect(editor.querySelectorAll('[data-composer-line-break]')).toHaveLength(2)
    expect(editor.querySelectorAll('[data-composer-caret-sentinel]')).toHaveLength(1)
    expect(caretOffsetInEditor(editor)).toBe('typed text\n\n'.length)

    placeCaretEnd(editor)
    insertComposerContentsAtCaret(editor, 'next')

    expect(composerPlainText(editor)).toBe('typed text\n\nnext')
    expect(editor.querySelector('[data-composer-caret-sentinel]')).toBeNull()

    editor.remove()
  })

  it('does not keep a caret sentinel after the draft is cleared', () => {
    useUserAgent(WEBKIT_USER_AGENT)
    const editor = document.createElement('div')
    editor.dataset.slot = RICH_INPUT_SLOT
    document.body.append(editor)

    renderComposerContents(editor, 'typed text\n')
    editor.replaceChildren()
    normalizeComposerEditorDom(editor)

    expect(composerPlainText(editor)).toBe('')
    expect(editor.querySelector('[data-composer-caret-sentinel]')).toBeNull()

    editor.remove()
  })

  it('leaves native terminal line breaks under browser caret management', () => {
    useUserAgent(WEBKIT_USER_AGENT)
    const editor = document.createElement('div')
    editor.dataset.slot = RICH_INPUT_SLOT
    editor.append(document.createTextNode('one'), document.createElement('br'))
    document.body.append(editor)

    normalizeComposerEditorDom(editor)

    expect(composerPlainText(editor)).toBe('one\n')
    expect(editor.querySelector('[data-composer-caret-sentinel]')).toBeNull()

    editor.remove()
  })

  it('replaces the selected span', () => {
    const editor = document.createElement('div')
    editor.dataset.slot = RICH_INPUT_SLOT
    editor.textContent = 'abXYef'
    document.body.append(editor)

    const text = editor.firstChild!
    const selection = window.getSelection()!
    const range = document.createRange()

    range.setStart(text, 2)
    range.setEnd(text, 4)
    selection.removeAllRanges()
    selection.addRange(range)

    insertComposerContentsAtCaret(editor, 'cd')

    expect(composerPlainText(editor)).toBe('abcdef')

    editor.remove()
  })

  it('lands directives in the text as chips', () => {
    const editor = document.createElement('div')
    editor.dataset.slot = RICH_INPUT_SLOT
    document.body.append(editor)
    placeCaretAtEnd(editor)

    insertComposerContentsAtCaret(editor, 'read @url:`https://example.dev/a` now')

    expect(editor.querySelectorAll('[data-ref-kind="url"]').length).toBe(1)
    expect(composerPlainText(editor)).toBe('read @url:`https://example.dev/a` now')

    editor.remove()
  })

  // A directive typed by hand chips; the same directive pasted has to chip too,
  // or copy/pasting a prompt silently drops every command in it.
  it('chips a pasted slash command, including one that ends the paste', () => {
    const editor = document.createElement('div')
    editor.dataset.slot = RICH_INPUT_SLOT
    document.body.append(editor)
    placeCaretAtEnd(editor)

    insertComposerContentsAtCaret(editor, '/some-skill')

    expect(editor.querySelector('[data-slash-kind]')?.getAttribute('data-ref-text')).toBe('/some-skill')
    // Committed pills carry the trailing space the typed path appends, so a
    // later full re-render doesn't read the token as half-typed.
    expect(composerPlainText(editor)).toBe('/some-skill ')

    editor.remove()
  })

  it('chips a skill named mid-paste alongside a ref', () => {
    const editor = document.createElement('div')
    editor.dataset.slot = RICH_INPUT_SLOT
    document.body.append(editor)
    placeCaretAtEnd(editor)

    insertComposerContentsAtCaret(editor, 'clean @file:`a.ts` with /some-skill then ship')

    expect(editor.querySelectorAll('[data-slash-kind]').length).toBe(1)
    expect(editor.querySelectorAll('[data-ref-kind="file"]').length).toBe(1)
    expect(composerPlainText(editor)).toBe('clean @file:`a.ts` with /some-skill then ship')

    editor.remove()
  })

  it('leaves a pasted path alone — /usr/local is not a command', () => {
    const editor = document.createElement('div')
    editor.dataset.slot = RICH_INPUT_SLOT
    document.body.append(editor)
    placeCaretAtEnd(editor)

    insertComposerContentsAtCaret(editor, 'see /usr/local/bin and /goal ship it')

    expect(editor.querySelector('[data-slash-kind]')).toBeNull()
    expect(composerPlainText(editor)).toBe('see /usr/local/bin and /goal ship it')

    editor.remove()
  })

  it('does not chip a command pasted against a word — foo/clean is not a command', () => {
    const editor = document.createElement('div')
    editor.dataset.slot = RICH_INPUT_SLOT
    editor.textContent = 'foo'
    document.body.append(editor)
    placeCaretAtEnd(editor)

    insertComposerContentsAtCaret(editor, '/some-skill')

    expect(editor.querySelector('[data-slash-kind]')).toBeNull()
    expect(composerPlainText(editor)).toBe('foo/some-skill')

    editor.remove()
  })

  it('chips a command pasted right after an existing chip', () => {
    const editor = document.createElement('div')
    editor.dataset.slot = RICH_INPUT_SLOT
    editor.append(refChipElement('file', '`a.ts`'))
    document.body.append(editor)
    placeCaretAtEnd(editor)

    insertComposerContentsAtCaret(editor, '/some-skill')

    expect(editor.querySelector('[data-slash-kind]')).not.toBeNull()

    editor.remove()
  })
})

describe('replaceBeforeCaret', () => {
  it('swaps the token before the caret and leaves the caret after the insert', () => {
    const editor = document.createElement('div')
    editor.dataset.slot = RICH_INPUT_SLOT
    editor.textContent = 'see foo'
    document.body.append(editor)

    const text = editor.firstChild!
    const selection = window.getSelection()!
    const range = document.createRange()

    range.setStart(text, 7)
    range.collapse(true)
    selection.removeAllRanges()
    selection.addRange(range)

    const fragment = document.createDocumentFragment()
    fragment.append(refChipElement('file', '`src/foo.ts`'), document.createTextNode(' '))

    expect(replaceBeforeCaret(editor, 3, fragment)).toBe(true)
    expect(composerPlainText(editor)).toBe('see @file:`src/foo.ts` ')
    expect(selection.getRangeAt(0).collapsed).toBe(true)

    editor.remove()
  })

  it('leaves the editor alone when the caret has no room for the token', () => {
    const editor = document.createElement('div')
    editor.dataset.slot = RICH_INPUT_SLOT
    editor.textContent = 'hi'
    document.body.append(editor)

    const selection = window.getSelection()!
    const range = document.createRange()

    range.setStart(editor.firstChild!, 2)
    range.collapse(true)
    selection.removeAllRanges()
    selection.addRange(range)

    const fragment = document.createDocumentFragment()
    fragment.append(document.createTextNode('x'))

    expect(replaceBeforeCaret(editor, 20, fragment)).toBe(false)
    expect(composerPlainText(editor)).toBe('hi')

    editor.remove()
  })
})

describe('deleteSelectionInEditor', () => {
  it('clears a non-collapsed range and leaves a collapsed caret', () => {
    const editor = document.createElement('div')
    editor.dataset.slot = RICH_INPUT_SLOT
    editor.textContent = 'hello world'
    document.body.append(editor)

    const selection = window.getSelection()!
    const range = document.createRange()

    range.selectNodeContents(editor)
    selection.removeAllRanges()
    selection.addRange(range)

    expect(deleteSelectionInEditor(editor)).toBe(true)
    expect(composerPlainText(editor)).toBe('')
    expect(selection.getRangeAt(0).collapsed).toBe(true)
    expect(deleteSelectionInEditor(editor)).toBe(false)

    editor.remove()
  })
})

describe('caret placement on a detached editor', () => {
  it('leaves the document selection alone instead of selecting into a detached node', () => {
    const attached = document.createElement('div')
    attached.textContent = 'visible composer'
    document.body.append(attached)
    placeCaretAtEnd(attached)

    const detached = document.createElement('div')
    detached.dataset.slot = RICH_INPUT_SLOT
    detached.textContent = 'unmounted composer'

    const selection = window.getSelection()
    const before = selection?.getRangeAt(0).startContainer

    expect(() => placeCaretEnd(detached)).not.toThrow()
    expect(() => placeCaretAtOffset(detached, 3)).not.toThrow()
    expect(selection?.rangeCount).toBe(1)
    expect(selection?.getRangeAt(0).startContainer).toBe(before)
    expect(detached.contains(selection?.anchorNode ?? null)).toBe(false)

    attached.remove()
  })
})

describe('normalizeComposerEditorDom — caret preservation', () => {
  it('re-establishes a caret anchored inside a removed phantom tail block', () => {
    const editor = document.createElement('div')
    editor.dataset.slot = RICH_INPUT_SLOT
    editor.contentEditable = 'true'
    editor.tabIndex = 0
    document.body.append(editor)
    editor.focus()

    expect(document.activeElement).toBe(editor)

    const text = document.createTextNode('hi')
    const tailBlock = document.createElement('div')

    tailBlock.append(document.createElement('br'))
    editor.append(text, tailBlock)

    const caret = document.createRange()
    caret.setStart(tailBlock, 0)
    caret.collapse(true)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(caret)

    normalizeComposerEditorDom(editor)

    expect(tailBlock.isConnected).toBe(false)
    expect(selection.isCollapsed).toBe(true)

    const range = selection.getRangeAt(0)
    expect(editor.contains(range.startContainer)).toBe(true)
    expect(range.startContainer).toBe(text)
    expect(range.startOffset).toBe(2)

    editor.remove()
  })

  it('leaves a still-valid selection untouched', () => {
    const editor = document.createElement('div')
    editor.dataset.slot = RICH_INPUT_SLOT
    editor.contentEditable = 'true'
    editor.tabIndex = 0
    document.body.append(editor)
    editor.focus()

    const br = document.createElement('br')
    editor.append(refChipElement('file', '`a.ts`'), br)

    const caret = document.createRange()
    caret.setStart(editor, 1)
    caret.collapse(true)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(caret)

    const offsetBefore = caretOffsetInEditor(editor)

    normalizeComposerEditorDom(editor)

    // The trailing <br> after a chip is gone — normalization did mutate — but
    // the selection was valid, so it must come through untouched.
    expect(editor.contains(br)).toBe(false)

    const range = selection.getRangeAt(0)
    expect(range.startContainer).toBe(editor)
    expect(range.startOffset).toBe(1)
    expect(caretOffsetInEditor(editor)).toBe(offsetBefore)

    editor.remove()
  })
})

describe('caretRevealScrollTop', () => {
  const viewport = { top: 100, bottom: 200 }

  it('leaves a visible caret alone', () => {
    expect(caretRevealScrollTop({ top: 120, bottom: 140 }, viewport, 50)).toBeNull()
  })

  it('scrolls down just far enough to show a caret below the viewport', () => {
    expect(caretRevealScrollTop({ top: 400, bottom: 420 }, viewport, 50)).toBe(270)
  })

  it('scrolls up just far enough to show a caret above the viewport', () => {
    expect(caretRevealScrollTop({ top: 60, bottom: 80 }, viewport, 50)).toBe(10)
  })
})

describe('caret reveal after programmatic inserts', () => {
  // jsdom has no layout: give the editor a 100px viewport and put every other
  // element (the caret probe) at `caretTop`, as a long insert would.
  function overflowingEditor(caretTop: number) {
    const editor = document.createElement('div')
    editor.dataset.slot = RICH_INPUT_SLOT
    document.body.append(editor)

    Object.defineProperty(editor, 'clientHeight', { configurable: true, value: 100 })
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const [top, bottom] = this === editor ? [0, 100] : [caretTop, caretTop + 20]

      return { bottom, height: bottom - top, left: 0, right: 0, top, width: 0, x: 0, y: top, toJSON: () => ({}) }
    })
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => {
      callback(0)

      return 0
    })

    return editor
  }

  afterEach(() => {
    vi.restoreAllMocks()
    document.body.replaceChildren()
  })

  it('scrolls a long paste so the caret after it is visible', () => {
    const editor = overflowingEditor(480)
    placeCaretAtEnd(editor)

    insertComposerContentsAtCaret(editor, Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n'))

    expect(editor.scrollTop).toBe(400)
    expect(editor.querySelectorAll('span').length).toBe(0)
    expect(composerPlainText(editor)).toContain('line 29')
  })

  it('scrolls to the caret when a repaint parks it at the end (voice transcript)', () => {
    const editor = overflowingEditor(300)

    renderComposerContents(editor, Array.from({ length: 30 }, (_, i) => `said ${i}`).join('\n'))
    placeCaretEnd(editor)

    expect(editor.scrollTop).toBe(220)
    expect(composerPlainText(editor)).toContain('said 29')
  })
})
