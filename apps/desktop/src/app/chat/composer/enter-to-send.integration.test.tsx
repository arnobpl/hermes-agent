// @vitest-environment jsdom
import { AssistantRuntimeProvider, type ThreadMessageLike, useExternalStoreRuntime } from '@assistant-ui/react'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { HermesGateway } from '@/hermes'
import { I18nProvider } from '@/i18n'
import { mainComposerScope } from '@/store/composer'
import { clearQueuedPrompts, getQueuedPrompts } from '@/store/composer-queue'
import { $enterToSendConfig, enterToSendOwnerKey } from '@/store/enter-to-send'
import { $activeGatewayProfile } from '@/store/profile'
import { $connection, $gatewayState } from '@/store/session'

import {
  caretOffsetInEditor,
  composerPlainText,
  placeCaretEnd,
  renderComposerContents,
  RICH_INPUT_SLOT
} from './rich-editor'
import type { ChatBarState } from './types'

import { ChatBar } from './index'

const CHROMIUM_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'

function setUserAgent(userAgent: string) {
  Object.defineProperty(navigator, 'userAgent', { configurable: true, value: userAgent })
}

function useWebKitUserAgent() {
  setUserAgent(
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1'
  )
}

beforeEach(() => {
  setUserAgent(CHROMIUM_USER_AGENT)
})

afterEach(() => {
  cleanup()
  setUserAgent(CHROMIUM_USER_AGENT)
  $activeGatewayProfile.set('default')
  $connection.set(null)
  $gatewayState.set('idle')
  $enterToSendConfig.set(null)
  mainComposerScope.clear()
  clearQueuedPrompts('enter-to-send-test')
})

const state: ChatBarState = {
  model: { canSwitch: false, model: '', provider: '' },
  tools: { enabled: false, label: '' },
  voice: { enabled: false, active: false }
}

function configureEnterToSend(enabled: boolean, gatewayState: 'connecting' | 'open') {
  const connection = $connection.get()
  const profile = $activeGatewayProfile.get()

  $gatewayState.set(gatewayState)
  $enterToSendConfig.set({
    owner: enterToSendOwnerKey(connection?.connectionId, profile),
    connection,
    enabled
  })
}

function Harness({
  busy = false,
  disabled,
  freshDraftKey,
  gateway = null,
  onSubmit
}: {
  busy?: boolean
  disabled: boolean
  freshDraftKey?: string
  gateway?: HermesGateway | null
  onSubmit: (text: string) => Promise<boolean>
}) {
  const runtime = useExternalStoreRuntime({
    convertMessage: (message: ThreadMessageLike) => message,
    isRunning: false,
    messages: [] as ThreadMessageLike[],
    onNew: async () => {}
  })

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <MemoryRouter>
        <I18nProvider configClient={null} initialLocale="en">
          <ChatBar
            busy={busy}
            disabled={disabled}
            freshDraftKey={freshDraftKey}
            gateway={gateway}
            onCancel={vi.fn()}
            onSubmit={onSubmit}
            state={state}
          />
        </I18nProvider>
      </MemoryRouter>
    </AssistantRuntimeProvider>
  )
}

function completionGateway(): HermesGateway {
  return {
    request: vi.fn(async (method: string) => {
      if (method === 'complete.path') {
        return { items: [] }
      }

      if (method === 'commands.catalog') {
        return { categories: [], pairs: [] }
      }

      return {}
    })
  } as unknown as HermesGateway
}

function editorIn(container: HTMLElement) {
  return container.querySelector<HTMLElement>(`[data-slot="${RICH_INPUT_SLOT}"]`)!
}

function setEditorTextAndCaret(editor: HTMLElement, text: string) {
  editor.textContent = text

  const range = editor.ownerDocument.createRange()
  range.setStart(editor.firstChild!, text.length)
  range.collapse(true)

  const selection = editor.ownerDocument.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
}

async function openAtCompletions(container: HTMLElement, editor: HTMLElement, text: string) {
  setEditorTextAndCaret(editor, text)

  await act(async () => {
    fireEvent.input(editor)
    fireEvent.keyUp(editor, { key: '@' })
  })

  await vi.waitFor(() => expect(container.textContent).toContain('@file:'))
}

async function pressEnter(editor: HTMLElement, modifier: 'none' | 'ctrl' | 'meta' = 'none') {
  const event = new KeyboardEvent('keydown', {
    bubbles: true,
    cancelable: true,
    ctrlKey: modifier === 'ctrl',
    key: 'Enter',
    metaKey: modifier === 'meta'
  })

  await act(async () => {
    editor.dispatchEvent(event)
  })

  return event
}

async function pressBeforeInput(editor: HTMLElement, inputType: string) {
  const event = new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType })

  await act(async () => {
    editor.dispatchEvent(event)
  })

  return event
}

async function pressShiftEnterBeforeInput(editor: HTMLElement, inputType: string) {
  const keydown = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter', shiftKey: true })
  const beforeInput = new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType })

  await act(async () => {
    editor.dispatchEvent(keydown)
    editor.dispatchEvent(beforeInput)
  })

  return { beforeInput, keydown }
}

async function pressProcessKeyEnterBeforeInput(editor: HTMLElement, inputType: string) {
  const keydown = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter' })
  Object.defineProperty(keydown, 'keyCode', { value: 229 })
  const beforeInput = new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType })

  await act(async () => {
    editor.dispatchEvent(keydown)
    editor.dispatchEvent(beforeInput)
  })

  return { beforeInput, keydown }
}

async function pressCompositionCommitEnterBeforeInput(editor: HTMLElement, inputType: string) {
  const compositionStart = new CompositionEvent('compositionstart', { bubbles: true })
  const compositionEnd = new CompositionEvent('compositionend', { bubbles: true })
  const keydown = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter' })
  Object.defineProperty(keydown, 'keyCode', { value: 229 })
  Object.defineProperty(keydown, 'timeStamp', { value: compositionEnd.timeStamp - 5 })
  const beforeInput = new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType })

  await act(async () => {
    editor.dispatchEvent(compositionStart)
    editor.dispatchEvent(compositionEnd)
    editor.dispatchEvent(keydown)
    editor.dispatchEvent(beforeInput)
  })

  return { beforeInput, keydown }
}

describe('ChatBar Enter-to-send setting', () => {
  it('inserts one newline when Enter is pressed in an empty draft', async () => {
    configureEnterToSend(false, 'open')
    const onSubmit = vi.fn(async (_text: string) => true)
    const { container } = render(<Harness disabled={false} onSubmit={onSubmit} />)
    const editor = editorIn(container)
    editor.focus()
    placeCaretEnd(editor)

    const enter = await pressEnter(editor)

    expect(enter.defaultPrevented).toBe(true)
    expect(composerPlainText(editor)).toBe('\n')
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('inserts a newline when disabled, including while the gateway is reconnecting', async () => {
    configureEnterToSend(false, 'connecting')
    const onSubmit = vi.fn(async (_text: string) => true)
    const { container } = render(<Harness disabled onSubmit={onSubmit} />)
    const editor = editorIn(container)
    setEditorTextAndCaret(editor, 'two lines')

    const enter = await pressEnter(editor)

    expect(editor.getAttribute('contenteditable')).toBe('true')
    expect(enter.defaultPrevented).toBe(true)
    expect(composerPlainText(editor)).toBe('two lines\n')
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('keeps repeated Enter newlines reachable after nonblank text', async () => {
    useWebKitUserAgent()
    configureEnterToSend(false, 'open')
    const onSubmit = vi.fn(async (_text: string) => true)
    const { container } = render(<Harness disabled={false} onSubmit={onSubmit} />)
    const editor = editorIn(container)
    setEditorTextAndCaret(editor, 'typed text')

    const firstEnter = await pressEnter(editor)

    expect(firstEnter.defaultPrevented).toBe(true)
    expect(composerPlainText(editor)).toBe('typed text\n')
    expect(editor.querySelectorAll('[data-composer-line-break]')).toHaveLength(1)
    expect(editor.querySelectorAll('[data-composer-caret-sentinel]')).toHaveLength(1)
    expect(caretOffsetInEditor(editor)).toBe('typed text\n'.length)

    const secondEnter = await pressEnter(editor)

    expect(secondEnter.defaultPrevented).toBe(true)
    expect(composerPlainText(editor)).toBe('typed text\n\n')
    expect(editor.querySelectorAll('[data-composer-line-break]')).toHaveLength(2)
    expect(editor.querySelectorAll('[data-composer-caret-sentinel]')).toHaveLength(1)
    expect(caretOffsetInEditor(editor)).toBe('typed text\n\n'.length)
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('cuts a trailing newline without copying the caret sentinel', async () => {
    useWebKitUserAgent()
    configureEnterToSend(false, 'open')
    const onSubmit = vi.fn(async (_text: string) => true)
    const { container } = render(<Harness disabled={false} onSubmit={onSubmit} />)
    const editor = editorIn(container)
    renderComposerContents(editor, 'typed text\n')

    const range = editor.ownerDocument.createRange()
    range.selectNodeContents(editor)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)

    const setData = vi.fn()
    const clipboardData = { setData } as unknown as DataTransfer
    const cut = new Event('cut', { bubbles: true, cancelable: true })
    Object.defineProperty(cut, 'clipboardData', { value: clipboardData })

    await act(async () => {
      editor.dispatchEvent(cut)
    })

    expect(cut.defaultPrevented).toBe(true)
    expect(setData).toHaveBeenNthCalledWith(1, 'text/plain', 'typed text\n')
    expect(setData).toHaveBeenNthCalledWith(2, 'text/html', expect.not.stringContaining('data-composer-caret-sentinel'))
    expect(composerPlainText(editor)).toBe('')
    expect(editor.querySelector('[data-composer-caret-sentinel]')).toBeNull()
    expect(onSubmit).not.toHaveBeenCalled()

    selection.removeAllRanges()
  })

  it('inserts a newline instead of accepting an open completion when disabled', async () => {
    configureEnterToSend(false, 'open')
    const onSubmit = vi.fn(async (_text: string) => true)

    const { container } = render(<Harness disabled={false} gateway={completionGateway()} onSubmit={onSubmit} />)

    const editor = editorIn(container)
    await openAtCompletions(container, editor, 'typed @')

    const enter = await pressEnter(editor)

    expect(enter.defaultPrevented).toBe(true)
    expect(composerPlainText(editor)).toBe('typed @\n')
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('inserts a Shift+Enter newline instead of accepting an open completion when disabled', async () => {
    configureEnterToSend(false, 'open')
    const onSubmit = vi.fn(async (_text: string) => true)

    const { container } = render(<Harness disabled={false} gateway={completionGateway()} onSubmit={onSubmit} />)

    const editor = editorIn(container)
    await openAtCompletions(container, editor, 'typed @')

    const { beforeInput, keydown } = await pressShiftEnterBeforeInput(editor, 'insertLineBreak')

    expect(keydown.defaultPrevented).toBe(false)
    expect(beforeInput.defaultPrevented).toBe(true)
    expect(composerPlainText(editor)).toBe('typed @\n')
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it.each(['insertParagraph', 'insertLineBreak'])(
    'handles native %s input when Enter-to-send is disabled',
    async inputType => {
      configureEnterToSend(false, 'open')
      const onSubmit = vi.fn(async (_text: string) => true)
      const { container } = render(<Harness disabled={false} onSubmit={onSubmit} />)
      const editor = editorIn(container)
      setEditorTextAndCaret(editor, 'typed text')

      const event = await pressBeforeInput(editor, inputType)

      expect(event.defaultPrevented).toBe(true)
      expect(composerPlainText(editor)).toBe('typed text\n')
      expect(onSubmit).not.toHaveBeenCalled()
    }
  )

  it('applies the disabled Enter policy to a process-key event', async () => {
    configureEnterToSend(false, 'open')
    const onSubmit = vi.fn(async (_text: string) => true)
    const { container } = render(<Harness disabled={false} onSubmit={onSubmit} />)
    const editor = editorIn(container)
    setEditorTextAndCaret(editor, 'typed text')

    const { beforeInput, keydown } = await pressProcessKeyEnterBeforeInput(editor, 'insertParagraph')

    expect(keydown.defaultPrevented).toBe(true)
    expect(beforeInput.defaultPrevented).toBe(true)
    expect(composerPlainText(editor)).toBe('typed text\n')
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it.each([false, true])('handles only one action when keydown is followed by beforeinput (send=%s)', async send => {
    configureEnterToSend(send, 'open')
    const onSubmit = vi.fn(async (_text: string) => true)
    const { container } = render(<Harness disabled={false} onSubmit={onSubmit} />)
    const editor = editorIn(container)
    setEditorTextAndCaret(editor, 'typed text')
    const keydown = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter' })

    const beforeInput = new InputEvent('beforeinput', {
      bubbles: true,
      cancelable: true,
      inputType: 'insertParagraph'
    })

    await act(async () => {
      editor.dispatchEvent(keydown)
      editor.dispatchEvent(beforeInput)
    })

    expect(keydown.defaultPrevented).toBe(true)
    expect(beforeInput.defaultPrevented).toBe(true)

    if (send) {
      await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
      expect(onSubmit.mock.calls[0]?.[0]).toBe('typed text')
    } else {
      expect(composerPlainText(editor)).toBe('typed text\n')
      expect(onSubmit).not.toHaveBeenCalled()
    }
  })

  it.each(['insertParagraph', 'insertLineBreak'])(
    'sends native %s input when Enter-to-send is enabled and no keydown was emitted',
    async inputType => {
      configureEnterToSend(true, 'open')
      const onSubmit = vi.fn(async (_text: string) => true)
      const { container } = render(<Harness disabled={false} onSubmit={onSubmit} />)
      const editor = editorIn(container)
      setEditorTextAndCaret(editor, 'hello')

      const event = await pressBeforeInput(editor, inputType)

      expect(event.defaultPrevented).toBe(true)
      await vi.waitFor(() => expect(onSubmit.mock.calls[0]?.[0]).toBe('hello'))
    }
  )

  it('preserves Shift+Enter when Enter-to-send is enabled', async () => {
    configureEnterToSend(true, 'open')
    const onSubmit = vi.fn(async (_text: string) => true)
    const { container } = render(<Harness disabled={false} onSubmit={onSubmit} />)
    const editor = editorIn(container)
    setEditorTextAndCaret(editor, 'hello')

    const { beforeInput, keydown } = await pressShiftEnterBeforeInput(editor, 'insertLineBreak')

    expect(keydown.defaultPrevented).toBe(false)
    expect(beforeInput.defaultPrevented).toBe(false)
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('preserves Shift+Enter newline input instead of accepting an open completion when enabled', async () => {
    configureEnterToSend(true, 'open')
    const onSubmit = vi.fn(async (_text: string) => true)

    const { container } = render(<Harness disabled={false} gateway={completionGateway()} onSubmit={onSubmit} />)

    const editor = editorIn(container)
    await openAtCompletions(container, editor, 'typed @')

    const { beforeInput, keydown } = await pressShiftEnterBeforeInput(editor, 'insertLineBreak')

    expect(keydown.defaultPrevented).toBe(false)
    expect(beforeInput.defaultPrevented).toBe(false)
    expect(composerPlainText(editor)).toBe('typed @')
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('sends on an uncorrelated process-key Enter when Enter-to-send is enabled', async () => {
    configureEnterToSend(true, 'open')
    const onSubmit = vi.fn(async (_text: string) => true)
    const { container } = render(<Harness disabled={false} onSubmit={onSubmit} />)
    const editor = editorIn(container)
    setEditorTextAndCaret(editor, 'hello')
    const { beforeInput, keydown } = await pressProcessKeyEnterBeforeInput(editor, 'insertParagraph')

    expect(keydown.defaultPrevented).toBe(true)
    expect(beforeInput.defaultPrevented).toBe(true)
    await vi.waitFor(() => expect(onSubmit.mock.calls[0]?.[0]).toBe('hello'))
  })

  it.each([false, true])('applies Enter policy after an IME commit (send=%s)', async send => {
    configureEnterToSend(send, 'open')
    const onSubmit = vi.fn(async (_text: string) => true)
    const { container } = render(<Harness disabled={false} onSubmit={onSubmit} />)
    const editor = editorIn(container)
    setEditorTextAndCaret(editor, 'typed text')

    const { beforeInput, keydown } = await pressCompositionCommitEnterBeforeInput(editor, 'insertParagraph')

    expect(keydown.defaultPrevented).toBe(!send)
    expect(beforeInput.defaultPrevented).toBe(true)
    expect(composerPlainText(editor)).toBe(send ? 'typed text' : 'typed text\n')
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it.each([false, true])('does not repeat a paragraph handled before the IME keydown (send=%s)', async send => {
    configureEnterToSend(send, 'open')
    const onSubmit = vi.fn(async (_text: string) => true)
    const { container } = render(<Harness disabled={false} onSubmit={onSubmit} />)
    const editor = editorIn(container)
    setEditorTextAndCaret(editor, 'typed text')
    const compositionStart = new CompositionEvent('compositionstart', { bubbles: true })
    const compositionEnd = new CompositionEvent('compositionend', { bubbles: true })

    const beforeInput = new InputEvent('beforeinput', {
      bubbles: true,
      cancelable: true,
      inputType: 'insertParagraph'
    })

    const keydown = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter' })
    Object.defineProperty(keydown, 'keyCode', { value: 229 })
    Object.defineProperty(keydown, 'timeStamp', { value: compositionEnd.timeStamp - 5 })

    await act(async () => {
      editor.dispatchEvent(compositionStart)
      editor.dispatchEvent(compositionEnd)
      editor.dispatchEvent(beforeInput)
      editor.dispatchEvent(keydown)
    })

    expect(beforeInput.defaultPrevented).toBe(true)
    expect(keydown.defaultPrevented).toBe(true)
    expect(composerPlainText(editor)).toBe(send ? 'typed text' : 'typed text\n')
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('does not repeat a deferred newline when paragraph input arrives after compositionend', async () => {
    configureEnterToSend(false, 'open')
    const onSubmit = vi.fn(async (_text: string) => true)
    const { container } = render(<Harness disabled={false} onSubmit={onSubmit} />)
    const editor = editorIn(container)
    setEditorTextAndCaret(editor, 'typed text')
    const compositionStart = new CompositionEvent('compositionstart', { bubbles: true })
    const compositionEnd = new CompositionEvent('compositionend', { bubbles: true })

    const keydown = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      isComposing: true,
      key: 'Enter'
    })

    await act(async () => {
      editor.dispatchEvent(compositionStart)
      editor.dispatchEvent(keydown)
      editor.dispatchEvent(compositionEnd)
      await new Promise(resolve => window.setTimeout(resolve, 0))
    })

    expect(composerPlainText(editor)).toBe('typed text\n')

    const beforeInput = new InputEvent('beforeinput', {
      bubbles: true,
      cancelable: true,
      inputType: 'insertParagraph'
    })

    Object.defineProperty(beforeInput, 'timeStamp', { value: compositionEnd.timeStamp + 5 })

    await act(async () => {
      editor.dispatchEvent(beforeInput)
    })

    expect(beforeInput.defaultPrevented).toBe(true)
    expect(composerPlainText(editor)).toBe('typed text\n')
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('consumes one mobile paragraph echo before handling a second Enter', async () => {
    configureEnterToSend(false, 'open')
    const onSubmit = vi.fn(async (_text: string) => true)
    const { container } = render(<Harness disabled={false} onSubmit={onSubmit} />)
    const editor = editorIn(container)
    setEditorTextAndCaret(editor, 'typed text')
    const compositionStart = new CompositionEvent('compositionstart', { bubbles: true })
    const compositionEnd = new CompositionEvent('compositionend', { bubbles: true })

    const composingEnter = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      isComposing: true,
      key: 'Enter'
    })

    await act(async () => {
      editor.dispatchEvent(compositionStart)
      editor.dispatchEvent(composingEnter)
      editor.dispatchEvent(compositionEnd)
    })

    const firstParagraph = new InputEvent('beforeinput', {
      bubbles: true,
      cancelable: true,
      inputType: 'insertParagraph'
    })

    const secondParagraph = new InputEvent('beforeinput', {
      bubbles: true,
      cancelable: true,
      inputType: 'insertParagraph'
    })

    Object.defineProperty(firstParagraph, 'timeStamp', { value: compositionEnd.timeStamp + 5 })
    Object.defineProperty(secondParagraph, 'timeStamp', { value: compositionEnd.timeStamp + 10 })

    await act(async () => {
      editor.dispatchEvent(firstParagraph)
      editor.dispatchEvent(secondParagraph)
    })

    expect(firstParagraph.defaultPrevented).toBe(true)
    expect(secondParagraph.defaultPrevented).toBe(true)
    expect(composerPlainText(editor)).toBe('typed text\n\n')
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('inserts the configured newline when composing paragraph input follows compositionend', async () => {
    configureEnterToSend(false, 'open')
    const onSubmit = vi.fn(async (_text: string) => true)
    const { container } = render(<Harness disabled={false} onSubmit={onSubmit} />)
    const editor = editorIn(container)
    setEditorTextAndCaret(editor, 'typed text')
    const compositionStart = new CompositionEvent('compositionstart', { bubbles: true })
    const compositionEnd = new CompositionEvent('compositionend', { bubbles: true })

    const beforeInput = new InputEvent('beforeinput', {
      bubbles: true,
      cancelable: true,
      inputType: 'insertParagraph',
      isComposing: true
    })

    Object.defineProperty(beforeInput, 'timeStamp', { value: compositionEnd.timeStamp + 5 })

    await act(async () => {
      editor.dispatchEvent(compositionStart)
      editor.dispatchEvent(compositionEnd)
      editor.dispatchEvent(beforeInput)
    })

    expect(beforeInput.defaultPrevented).toBe(true)
    expect(composerPlainText(editor)).toBe('typed text\n')
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it.each([false, true])(
    'applies the Enter policy when Safari keeps isComposing set after compositionend (send=%s)',
    async send => {
      configureEnterToSend(send, 'open')
      const onSubmit = vi.fn(async (_text: string) => true)
      const { container } = render(<Harness disabled={false} onSubmit={onSubmit} />)
      const editor = editorIn(container)
      setEditorTextAndCaret(editor, 'typed text')
      const compositionStart = new CompositionEvent('compositionstart', { bubbles: true })
      const compositionEnd = new CompositionEvent('compositionend', { bubbles: true })

      const keydown = new KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        isComposing: true,
        key: 'Enter'
      })

      Object.defineProperty(keydown, 'keyCode', { value: 229 })
      Object.defineProperty(keydown, 'timeStamp', { value: compositionEnd.timeStamp - 5 })

      const beforeInput = new InputEvent('beforeinput', {
        bubbles: true,
        cancelable: true,
        inputType: 'insertParagraph',
        isComposing: true
      })

      Object.defineProperty(beforeInput, 'timeStamp', { value: compositionEnd.timeStamp + 5 })

      await act(async () => {
        editor.dispatchEvent(compositionStart)
        editor.dispatchEvent(compositionEnd)
        editor.dispatchEvent(keydown)
        editor.dispatchEvent(beforeInput)
      })

      expect(keydown.defaultPrevented).toBe(!send)
      expect(beforeInput.defaultPrevented).toBe(true)
      expect(composerPlainText(editor)).toBe(send ? 'typed text' : 'typed text\n')
      expect(onSubmit).not.toHaveBeenCalled()
    }
  )

  it('does not let a deferred newline leak into a later composition when compositionend was missed', async () => {
    configureEnterToSend(false, 'open')
    const onSubmit = vi.fn(async (_text: string) => true)
    const { container } = render(<Harness disabled={false} onSubmit={onSubmit} />)
    const editor = editorIn(container)
    setEditorTextAndCaret(editor, 'typed text')

    const composingEnter = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      isComposing: true,
      key: 'Enter'
    })

    await act(async () => {
      editor.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
      editor.dispatchEvent(composingEnter)
      editor.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'a' }))
      editor.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))
    })

    expect(composerPlainText(editor)).toBe('typed text')
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('allows a distinct Enter immediately after the composition-confirming Enter', async () => {
    configureEnterToSend(false, 'open')
    const onSubmit = vi.fn(async (_text: string) => true)
    const { container } = render(<Harness disabled={false} onSubmit={onSubmit} />)
    const editor = editorIn(container)
    setEditorTextAndCaret(editor, 'typed text')
    const compositionStart = new CompositionEvent('compositionstart', { bubbles: true })
    const compositionEnd = new CompositionEvent('compositionend', { bubbles: true })

    const composingEnter = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      isComposing: true,
      key: 'Enter'
    })

    const composingBeforeInput = new InputEvent('beforeinput', {
      bubbles: true,
      cancelable: true,
      inputType: 'insertParagraph',
      isComposing: true
    })

    await act(async () => {
      editor.dispatchEvent(compositionStart)
      editor.dispatchEvent(composingEnter)
      editor.dispatchEvent(composingBeforeInput)
      editor.dispatchEvent(compositionEnd)
    })

    const secondEnter = await pressEnter(editor)

    expect(secondEnter.defaultPrevented).toBe(true)
    expect(composerPlainText(editor)).toBe('typed text\n\n')
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it.each([false, true])(
    'does not swallow a new process-key Enter after an active-composition Enter (send=%s)',
    async send => {
      configureEnterToSend(send, 'open')
      const onSubmit = vi.fn(async (_text: string) => true)
      const { container } = render(<Harness disabled={false} onSubmit={onSubmit} />)
      const editor = editorIn(container)
      setEditorTextAndCaret(editor, 'typed text')
      const compositionStart = new CompositionEvent('compositionstart', { bubbles: true })
      const compositionEnd = new CompositionEvent('compositionend', { bubbles: true })

      const firstEnter = new KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        isComposing: true,
        key: 'Enter'
      })

      const secondEnter = new KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        key: 'Enter'
      })

      Object.defineProperty(secondEnter, 'keyCode', { value: 229 })
      Object.defineProperty(secondEnter, 'timeStamp', { value: compositionEnd.timeStamp + 5 })

      await act(async () => {
        editor.dispatchEvent(compositionStart)
        editor.dispatchEvent(firstEnter)
        editor.dispatchEvent(compositionEnd)
        editor.dispatchEvent(secondEnter)
      })

      expect(secondEnter.defaultPrevented).toBe(true)

      if (send) {
        await vi.waitFor(() => expect(onSubmit.mock.calls[0]?.[0]).toBe('typed text'))
      } else {
        expect(composerPlainText(editor)).toBe('typed text\n\n')
        expect(onSubmit).not.toHaveBeenCalled()
      }
    }
  )

  it('keeps Ctrl+Enter queueing when pressed immediately after an IME composition', async () => {
    configureEnterToSend(false, 'open')
    clearQueuedPrompts('enter-to-send-test')
    const onSubmit = vi.fn(async (_text: string) => true)

    const { container } = render(
      <Harness busy disabled={false} freshDraftKey="enter-to-send-test" onSubmit={onSubmit} />
    )

    const editor = editorIn(container)
    setEditorTextAndCaret(editor, 'queue this')
    const compositionStart = new CompositionEvent('compositionstart', { bubbles: true })
    const compositionEnd = new CompositionEvent('compositionend', { bubbles: true })

    const composingEnter = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      isComposing: true,
      key: 'Enter'
    })

    const composingBeforeInput = new InputEvent('beforeinput', {
      bubbles: true,
      cancelable: true,
      inputType: 'insertParagraph',
      isComposing: true
    })

    await act(async () => {
      editor.dispatchEvent(compositionStart)
      editor.dispatchEvent(composingEnter)
      editor.dispatchEvent(composingBeforeInput)
      editor.dispatchEvent(compositionEnd)
    })

    const queue = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ctrlKey: true, key: 'Enter' })

    await act(async () => {
      editor.dispatchEvent(queue)
    })

    await vi.waitFor(() =>
      expect(getQueuedPrompts('enter-to-send-test').map(item => item.text)).toEqual(['queue this'])
    )
    expect(queue.defaultPrevented).toBe(true)
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('does not turn a composing Ctrl+Enter into a deferred newline', async () => {
    configureEnterToSend(false, 'open')
    const onSubmit = vi.fn(async (_text: string) => true)
    const { container } = render(<Harness busy disabled={false} onSubmit={onSubmit} />)
    const editor = editorIn(container)
    setEditorTextAndCaret(editor, 'typed text')

    const composingQueueChord = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
      isComposing: true,
      key: 'Enter'
    })

    const beforeInput = new InputEvent('beforeinput', {
      bubbles: true,
      cancelable: true,
      inputType: 'insertParagraph',
      isComposing: true
    })

    await act(async () => {
      editor.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
      editor.dispatchEvent(composingQueueChord)
      editor.dispatchEvent(beforeInput)
      editor.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))
    })

    expect(beforeInput.defaultPrevented).toBe(true)
    expect(composerPlainText(editor)).toBe('typed text')
    expect(getQueuedPrompts('enter-to-send-test')).toHaveLength(0)
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it.each([false, true])('applies Shift+Enter after compositionend (send=%s)', async send => {
    configureEnterToSend(send, 'open')
    const onSubmit = vi.fn(async (_text: string) => true)
    const { container } = render(<Harness disabled={false} onSubmit={onSubmit} />)
    const editor = editorIn(container)
    setEditorTextAndCaret(editor, 'typed text')
    const compositionEnd = new CompositionEvent('compositionend', { bubbles: true })

    const keydown = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      isComposing: true,
      key: 'Enter',
      shiftKey: true
    })

    const beforeInput = new InputEvent('beforeinput', {
      bubbles: true,
      cancelable: true,
      inputType: 'insertLineBreak',
      isComposing: true
    })

    Object.defineProperty(keydown, 'timeStamp', { value: compositionEnd.timeStamp + 5 })
    Object.defineProperty(beforeInput, 'timeStamp', { value: compositionEnd.timeStamp + 10 })

    await act(async () => {
      editor.dispatchEvent(compositionEnd)
      editor.dispatchEvent(keydown)
      editor.dispatchEvent(beforeInput)
    })

    expect(keydown.defaultPrevented).toBe(!send)
    expect(beforeInput.defaultPrevented).toBe(!send)
    expect(composerPlainText(editor)).toBe(send ? 'typed text' : 'typed text\n')
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it.each([false, true])('preserves Shift+Enter when compositionend follows keydown (send=%s)', async send => {
    configureEnterToSend(send, 'open')
    const onSubmit = vi.fn(async (_text: string) => true)
    const { container } = render(<Harness disabled={false} onSubmit={onSubmit} />)
    const editor = editorIn(container)
    setEditorTextAndCaret(editor, 'typed text')
    const compositionStart = new CompositionEvent('compositionstart', { bubbles: true })
    const compositionEnd = new CompositionEvent('compositionend', { bubbles: true })

    const keydown = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      isComposing: true,
      key: 'Enter',
      shiftKey: true
    })

    const beforeInput = new InputEvent('beforeinput', {
      bubbles: true,
      cancelable: true,
      inputType: 'insertLineBreak'
    })

    Object.defineProperty(beforeInput, 'timeStamp', { value: compositionEnd.timeStamp + 5 })

    await act(async () => {
      editor.dispatchEvent(compositionStart)
      editor.dispatchEvent(keydown)
      editor.dispatchEvent(compositionEnd)
      editor.dispatchEvent(beforeInput)
    })

    expect(keydown.defaultPrevented).toBe(false)
    expect(beforeInput.defaultPrevented).toBe(!send)
    expect(composerPlainText(editor)).toBe(send ? 'typed text' : 'typed text\n')
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it.each([false, true])('applies Enter policy after an active composition ends (send=%s)', async send => {
    configureEnterToSend(send, 'open')
    const onSubmit = vi.fn(async (_text: string) => true)
    const { container } = render(<Harness disabled={false} onSubmit={onSubmit} />)
    const editor = editorIn(container)
    setEditorTextAndCaret(editor, 'typed text')
    const compositionStart = new CompositionEvent('compositionstart', { bubbles: true })

    const keydown = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      isComposing: true,
      key: 'Enter'
    })

    const beforeInput = new InputEvent('beforeinput', {
      bubbles: true,
      cancelable: true,
      inputType: 'insertParagraph',
      isComposing: true
    })

    const compositionEnd = new CompositionEvent('compositionend', { bubbles: true })

    await act(async () => {
      editor.dispatchEvent(compositionStart)
      editor.dispatchEvent(keydown)
      editor.dispatchEvent(beforeInput)
      editor.dispatchEvent(compositionEnd)
    })

    expect(keydown.defaultPrevented).toBe(false)
    expect(beforeInput.defaultPrevented).toBe(true)
    expect(composerPlainText(editor)).toBe(send ? 'typed text' : 'typed text\n')
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('sends on Enter when enabled', async () => {
    configureEnterToSend(true, 'open')
    const onSubmit = vi.fn(async (_text: string) => true)
    const { container } = render(<Harness disabled={false} onSubmit={onSubmit} />)
    const editor = editorIn(container)
    editor.tabIndex = 0
    editor.focus()
    setEditorTextAndCaret(editor, 'hello')

    await act(async () => {
      fireEvent.input(editor)
    })

    const enter = await pressEnter(editor)

    expect(enter.defaultPrevented).toBe(true)
    await vi.waitFor(() => expect(onSubmit.mock.calls[0]?.[0]).toBe('hello'))
  })

  it('keeps Ctrl+Enter queueing while Enter-to-send is disabled', async () => {
    configureEnterToSend(false, 'open')
    clearQueuedPrompts('enter-to-send-test')
    const onSubmit = vi.fn(async (_text: string) => true)

    const { container } = render(
      <Harness busy disabled={false} freshDraftKey="enter-to-send-test" onSubmit={onSubmit} />
    )

    const editor = editorIn(container)
    editor.tabIndex = 0
    editor.focus()
    setEditorTextAndCaret(editor, 'follow up')

    await act(async () => {
      fireEvent.input(editor)
    })

    const enter = await pressEnter(editor, 'ctrl')

    expect(enter.defaultPrevented).toBe(true)
    await vi.waitFor(() => expect(getQueuedPrompts('enter-to-send-test').map(item => item.text)).toEqual(['follow up']))
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it.each(['ctrl', 'meta'] as const)('queues %s+Enter instead of accepting an open completion', async modifier => {
    configureEnterToSend(false, 'open')
    clearQueuedPrompts('enter-to-send-test')
    const onSubmit = vi.fn(async (_text: string) => true)

    const { container } = render(
      <Harness
        busy
        disabled={false}
        freshDraftKey="enter-to-send-test"
        gateway={completionGateway()}
        onSubmit={onSubmit}
      />
    )

    const editor = editorIn(container)
    await openAtCompletions(container, editor, 'typed @')

    const enter = await pressEnter(editor, modifier)

    expect(enter.defaultPrevented).toBe(true)
    await vi.waitFor(() => expect(getQueuedPrompts('enter-to-send-test').map(item => item.text)).toEqual(['typed @']))
    expect(onSubmit).not.toHaveBeenCalled()
  })
})
