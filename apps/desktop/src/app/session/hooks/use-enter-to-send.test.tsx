import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { $connectionWires } from '@/store/connection-wire'
import { $enterToSendConfig, enterToSendOwnerKey, normalizeEnterToSend } from '@/store/enter-to-send'
import { $activeGatewayProfile } from '@/store/profile'
import { $connection, $gatewayState } from '@/store/session'

import { useEnterToSend } from './use-enter-to-send'

vi.mock('@/store/session-request-router', () => ({
  isSessionOwnerRoute: (owner: unknown) =>
    typeof owner === 'object' && owner !== null && 'profile' in (owner as object),
  requestForSessionProfile: (
    _owner: unknown,
    request: (method: string, params: unknown) => Promise<unknown>,
    method: string,
    params: unknown
  ) => request(method, params)
}))

afterEach(() => {
  cleanup()
  $enterToSendConfig.set(null)
  $activeGatewayProfile.set('default')
  $gatewayState.set('closed')
  $connection.set(null)
  $connectionWires.set({})
})

it('uses the matching profile config and keeps it separate from the busy-input policy', () => {
  const connection = { connectionId: 'remote', mode: 'remote', wsUrl: 'wss://remote.example/api/ws' }
  $connection.set(connection as never)
  $activeGatewayProfile.set('work')
  $enterToSendConfig.set({ owner: enterToSendOwnerKey('remote', 'work'), connection, enabled: false })
  const request = vi.fn()

  const hook = renderHook(() =>
    useEnterToSend({ sessionId: 'session', storedSessionId: null, requestGateway: request })
  )

  expect(hook.result.current).toBe(false)
  expect(request).not.toHaveBeenCalled()
})

it('keeps Enter-to-send disabled while the session preference is loading', () => {
  $connection.set({ connectionId: 'remote', mode: 'remote', wsUrl: 'wss://remote.example/api/ws' } as never)
  $gatewayState.set('open')
  const request = vi.fn(() => new Promise<never>(() => {}))

  const hook = renderHook(() =>
    useEnterToSend({ sessionId: 'session', storedSessionId: null, requestGateway: request })
  )

  expect(hook.result.current).toBeNull()
  expect(request).toHaveBeenCalledWith('config.get', {
    key: 'desktop.enter_to_send',
    session_id: 'session'
  })
})

it('loads the preference for a session owner when the active profile cache does not match', async () => {
  $connection.set({ connectionId: 'remote', mode: 'remote', wsUrl: 'wss://remote.example/api/ws' } as never)
  $gatewayState.set('open')
  const request = vi.fn().mockResolvedValue({ value: 'false' })

  const hook = renderHook(() =>
    useEnterToSend({ sessionId: 'session', storedSessionId: null, requestGateway: request })
  )

  await waitFor(() => expect(hook.result.current).toBe(false))
  expect(request).toHaveBeenCalledWith('config.get', {
    key: 'desktop.enter_to_send',
    session_id: 'session'
  })
})

it('uses the default when an older gateway rejects the setting key', async () => {
  vi.useFakeTimers()

  try {
    $connection.set({ connectionId: 'remote', mode: 'remote', wsUrl: 'wss://remote.example/api/ws' } as never)
    $gatewayState.set('open')
    const request = vi.fn().mockRejectedValue(new Error('unknown config key'))

    const hook = renderHook(() =>
      useEnterToSend({ sessionId: 'session', storedSessionId: null, requestGateway: request })
    )

    await act(async () => {
      await vi.runAllTimersAsync()
    })

    expect(hook.result.current).toBe(true)
    expect(request).toHaveBeenCalledTimes(3)
  } finally {
    vi.useRealTimers()
  }
})

it('defaults missing values to enabled and accepts quoted false values', () => {
  expect(normalizeEnterToSend(undefined)).toBe(true)
  expect(normalizeEnterToSend('false')).toBe(false)
  expect(normalizeEnterToSend('maybe')).toBe(false)
  expect(normalizeEnterToSend(0)).toBe(false)
  expect(normalizeEnterToSend([])).toBe(false)
  expect(normalizeEnterToSend({})).toBe(false)
  expect(normalizeEnterToSend('yes')).toBe(true)
})
