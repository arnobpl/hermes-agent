/**
 * E2E chat tests — send a message and verify a response appears.
 *
 * Requires the full boot chain to complete (hermes serve + mock inference
 * provider). The mock server returns a canned reply, so we verify the
 * response text shows up in the chat transcript.
 *
 * Prerequisite: `pnpm run build` must have been run so dist/ exists.
 */

import { runDesktopChatSmoke } from '../../../tests-js/scripts/desktop-chat-smoke'
import { BLOCKING_CLARIFY_QUESTION, BLOCKING_CLARIFY_TRIGGER } from '../../../tests-js/scripts/mock-server'

import { type MockBackendFixture, setupMockBackend, waitForAppReady } from './fixtures'
import { expect, test } from './test'
import { expectVisualSnapshot } from './visual-snapshot'

let fixture: MockBackendFixture | null = null

type EnterObservation = {
  type: string
  inputType?: string
  key?: string
  shiftKey?: boolean
  defaultPrevented: boolean
  timeStamp: number
}

test.beforeAll(async () => {
  fixture = await setupMockBackend({ extraConfig: 'desktop:\n  enter_to_send: true\n' })
  await waitForAppReady(fixture!, 120_000)
})

test.afterAll(async () => {
  await fixture?.cleanup()
  fixture = null
})

test.describe('chat interaction with mock backend', () => {
  test('send a message and receive a response', async (): Promise<void> => {
    await runDesktopChatSmoke(fixture!.page, {
      mockUrl: fixture!.mockUrl,
      phase: 'installed',
      outDir: test.info().outputPath('desktop-chat')
    })
  })

  test('keeps native Shift+Enter newline after compositionend', async () => {
    const page = fixture!.page

    const composer = page
      .locator('[data-slot="composer-root"] [contenteditable="true"]')
      .filter({ visible: true })
      .first()

    await composer.fill('first line')
    await composer.evaluate(element => {
      const browserWindow = window as typeof window & {
        __enterToSendEvents?: EnterObservation[]
        __enterToSendAbortController?: AbortController
      }

      browserWindow.__enterToSendAbortController?.abort()
      const abortController = new AbortController()
      browserWindow.__enterToSendAbortController = abortController

      browserWindow.__enterToSendEvents = []

      for (const type of ['compositionend', 'keydown', 'beforeinput', 'input']) {
        document.addEventListener(
          type,
          event => {
            browserWindow.__enterToSendEvents?.push({
              type: event.type,
              inputType: event instanceof InputEvent ? event.inputType : undefined,
              key: event instanceof KeyboardEvent ? event.key : undefined,
              shiftKey: event instanceof KeyboardEvent ? event.shiftKey : undefined,
              defaultPrevented: event.defaultPrevented,
              timeStamp: event.timeStamp
            })
          },
          { signal: abortController.signal }
        )
      }

      element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
      const compositionEnd = new CompositionEvent('compositionend', { bubbles: true })
      Object.defineProperty(compositionEnd, 'timeStamp', { value: performance.now() + 30 })
      element.dispatchEvent(compositionEnd)
    })

    let events: EnterObservation[] = []

    try {
      await composer.press('Shift+Enter')

      await expect
        .poll(() => composer.evaluate(element => (element as HTMLElement).innerText))
        .toContain('first line\n')
      events = await page.evaluate(() => {
        const browserWindow = window as typeof window & { __enterToSendEvents?: EnterObservation[] }

        return browserWindow.__enterToSendEvents ?? []
      })
    } finally {
      await page
        .evaluate(() => {
          const browserWindow = window as typeof window & {
            __enterToSendEvents?: EnterObservation[]
            __enterToSendAbortController?: AbortController
          }

          browserWindow.__enterToSendAbortController?.abort()
          delete browserWindow.__enterToSendAbortController
          delete browserWindow.__enterToSendEvents
        })
        .catch(() => undefined)
      await composer.fill('').catch(() => undefined)
    }

    const compositionEnd = events.find(event => event.type === 'compositionend')
    const enterKeydown = events.find(event => event.type === 'keydown' && event.key === 'Enter')

    expect(compositionEnd).toBeDefined()
    expect(enterKeydown).toMatchObject({ shiftKey: true, defaultPrevented: false })
    expect(Math.abs(enterKeydown!.timeStamp - compositionEnd!.timeStamp)).toBeLessThanOrEqual(50)
    expect(events.find(event => event.type === 'beforeinput' && event.inputType === 'insertLineBreak')).toMatchObject({
      defaultPrevented: false
    })
    expect(events.some(event => event.type === 'input')).toBe(true)
  })

  test('screenshot of chat with messages', async () => {
    await expectVisualSnapshot(fixture!.page, { name: 'chat-with-messages', app: fixture!.app })
  })

  test('offers stop, steer, and queue actions while busy', async () => {
    const testInfo = test.info()
    const page = fixture!.page
    const composer = page.locator('[contenteditable="true"]').first()
    const primary = page.locator('[data-slot="composer-root"] button[type="submit"]')
    const queue = page.locator('[data-slot="composer-root"] button[aria-label="Queue message"]')

    await composer.click()
    await composer.type(BLOCKING_CLARIFY_TRIGGER)
    await page.keyboard.press('Enter')
    await page.getByText(BLOCKING_CLARIFY_QUESTION).waitFor({ state: 'visible', timeout: 30_000 })

    await expect(primary).toHaveAttribute('aria-label', 'Stop')

    await composer.click()
    await composer.type('please answer tersely')
    // Since "running is not busy" (3bc52fb9df) the primary keeps the Send
    // affordance mid-turn — steer is routed through the submit engine, not a
    // separate labeled button. Queue remains the explicit secondary action.
    await expect(primary).toHaveAttribute('aria-label', 'Send')
    await expect(queue).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('busy-composer-steer.png') })

    await queue.click()
    await expect(primary).toHaveAttribute('aria-label', 'Stop')
    await expect(queue).toHaveCount(0)
    await page.screenshot({ path: testInfo.outputPath('busy-composer-queue.png') })
    await expect(page.getByText('1 Queued')).toBeVisible()

    await primary.click()
    await expect(page.getByText('1 Queued — paused')).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('busy-composer-queue-paused.png') })
  })
})
