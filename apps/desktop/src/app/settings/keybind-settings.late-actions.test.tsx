/**
 * A keybind action contributed AFTER the settings tab mounts must appear in
 * the map. Same class as the late plugin-route bug (#109063): the component
 * subscribed to `useContributions(KEYBINDS_AREA)` but discarded the snapshot
 * and called the impure `allKeybindActions()` in render, so the React
 * Compiler memoized the list without the subscription as an input. Uses the
 * real registry + hook under the compiler-enabled vitest ui project.
 */
import { act, cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { registry } from '@/contrib/registry'
import { I18nProvider } from '@/i18n'
import { KEYBINDS_AREA } from '@/lib/keybinds/actions'
import { $enterToSendConfig, enterToSendOwnerKey } from '@/store/enter-to-send'
import { $activeGatewayProfile } from '@/store/profile'
import { $connection } from '@/store/session'

import { KeybindSettings } from './keybind-settings'

afterEach(() => {
  cleanup()
  $enterToSendConfig.set(null)
  $activeGatewayProfile.set('default')
  $connection.set(null)
})

describe('KeybindSettings', () => {
  it('lists an action whose keybind registers after mount', () => {
    render(
      <I18nProvider configClient={null} initialLocale="en">
        <KeybindSettings />
      </I18nProvider>
    )
    expect(screen.queryByText('Late Plugin Action')).toBeNull()

    let dispose = () => {}
    act(() => {
      dispose = registry.register({
        area: KEYBINDS_AREA,
        id: 'late-plugin:action',
        data: { id: 'late-plugin:action', label: 'Late Plugin Action', category: 'view', run: () => {} }
      })
    })

    expect(screen.getByText('Late Plugin Action')).toBeTruthy()

    act(() => dispose())
  })

  it('hides Enter-send shortcuts when disabled and keeps the newline and queue shortcuts', () => {
    const connection = { connectionId: 'current', mode: 'remote' }
    $connection.set(connection as never)
    $activeGatewayProfile.set('work')
    $enterToSendConfig.set({
      owner: enterToSendOwnerKey('current', 'work'),
      connection,
      enabled: false
    })

    render(
      <I18nProvider configClient={null} initialLocale="en">
        <KeybindSettings />
      </I18nProvider>
    )

    expect(screen.queryByText('Send message')).toBeNull()
    expect(screen.queryByText('Steer the running turn')).toBeNull()
    const newlineRow = screen.getByText('Insert newline').parentElement!
    expect(within(newlineRow).getByLabelText('↵')).toBeTruthy()
    expect(screen.getByText('Queue message')).toBeTruthy()
  })

  it('hides Enter-send shortcuts for a stale profile snapshot', () => {
    const connection = { connectionId: 'current', mode: 'remote' }
    $connection.set(connection as never)
    $activeGatewayProfile.set('work')
    $enterToSendConfig.set({
      owner: enterToSendOwnerKey('current', 'previous'),
      connection,
      enabled: true
    })

    render(
      <I18nProvider configClient={null} initialLocale="en">
        <KeybindSettings />
      </I18nProvider>
    )

    expect(screen.queryByText('Send message')).toBeNull()
    expect(screen.queryByText('Steer the running turn')).toBeNull()
    expect(screen.getByText('Insert newline')).toBeTruthy()
    expect(screen.getByText('Queue message')).toBeTruthy()
  })

  it('hides Enter-send shortcuts for a stale connection snapshot', () => {
    const connection = { connectionId: 'current', mode: 'remote' }
    $connection.set(connection as never)
    $activeGatewayProfile.set('work')
    $enterToSendConfig.set({
      owner: enterToSendOwnerKey('current', 'work'),
      connection: { ...connection },
      enabled: true
    })

    render(
      <I18nProvider configClient={null} initialLocale="en">
        <KeybindSettings />
      </I18nProvider>
    )

    expect(screen.queryByText('Send message')).toBeNull()
    expect(screen.queryByText('Steer the running turn')).toBeNull()
    expect(screen.getByText('Insert newline')).toBeTruthy()
    expect(screen.getByText('Queue message')).toBeTruthy()
  })

  it('shows Enter-send shortcuts for the matching enabled profile', () => {
    const connection = { connectionId: 'current', mode: 'remote' }
    $connection.set(connection as never)
    $activeGatewayProfile.set('work')
    $enterToSendConfig.set({
      owner: enterToSendOwnerKey('current', 'work'),
      connection,
      enabled: true
    })

    render(
      <I18nProvider configClient={null} initialLocale="en">
        <KeybindSettings />
      </I18nProvider>
    )

    expect(screen.getByText('Send message')).toBeTruthy()
    expect(screen.getByText('Steer the running turn')).toBeTruthy()
  })
})
