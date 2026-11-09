import { useStore } from '@nanostores/react'
import { useEffect, useState } from 'react'

import type { GatewayRequester } from '@/app/contrib/types'
import { $connectionWires } from '@/store/connection-wire'
import { $enterToSendConfig, enterToSendOwnerKey, normalizeEnterToSend } from '@/store/enter-to-send'
import { $activeGatewayProfile } from '@/store/profile'
import { $connection, $gatewayState, knownSessionOwner, ownerLookupSessionRows } from '@/store/session'
import { requestForSessionProfile } from '@/store/session-request-router'
import { sessionTileOwnerRoute } from '@/store/session-states'

export function useEnterToSend({
  sessionId,
  storedSessionId,
  requestGateway
}: {
  sessionId: string | null
  storedSessionId: string | null
  requestGateway: GatewayRequester
}): boolean | null {
  const config = useStore($enterToSendConfig)
  const connection = useStore($connection)
  const profile = useStore($activeGatewayProfile)
  const gatewayState = useStore($gatewayState)
  // A public connection's wire is known only at its gateway.ready; re-read ownership then.
  useStore($connectionWires)

  const route = storedSessionId
    ? (sessionTileOwnerRoute(storedSessionId) ?? knownSessionOwner(ownerLookupSessionRows(), storedSessionId))
    : undefined

  const connectionId = route && typeof route === 'object' ? route.connectionId : connection?.connectionId
  const ownerProfile = route && typeof route === 'object' ? route.profile : route || profile
  const targetProfile = route && typeof route === 'object' ? route.targetProfile : undefined
  const owner = enterToSendOwnerKey(connectionId, targetProfile || ownerProfile)
  const configured = config?.owner === owner && config.connection === connection ? config.enabled : null

  const [loaded, setLoaded] = useState<{
    owner: string
    connection: typeof connection
    sessionId: string
    enabled: boolean
  } | null>(null)

  useEffect(() => {
    if (configured !== null || !sessionId || gatewayState !== 'open') {
      return
    }

    let cancelled = false
    const ownerRoute = connectionId ? { connectionId, profile: ownerProfile, targetProfile } : ownerProfile
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    let attempts = 0

    const load = () => {
      attempts += 1
      void requestForSessionProfile<{ value?: unknown }>(ownerRoute, requestGateway, 'config.get', {
        key: 'desktop.enter_to_send',
        session_id: sessionId
      })
        .then(result => {
          if (!cancelled) {
            setLoaded({ owner, connection, sessionId, enabled: normalizeEnterToSend(result?.value) })
          }
        })
        .catch(() => {
          if (!cancelled) {
            if (attempts < 3) {
              retryTimer = setTimeout(load, 1000 * attempts)
            } else {
              // Older gateways reject unknown keys; retain the default after retries finish.
              setLoaded({ owner, connection, sessionId, enabled: true })
            }
          }
        })
    }

    load()

    return () => {
      cancelled = true
      clearTimeout(retryTimer)
    }
  }, [
    configured,
    connection,
    connectionId,
    gatewayState,
    owner,
    ownerProfile,
    requestGateway,
    sessionId,
    targetProfile
  ])

  if (configured !== null) {
    return configured
  }

  if (loaded?.owner === owner && loaded.connection === connection && loaded.sessionId === sessionId) {
    return loaded.enabled
  }

  // Leave Enter available for a newline while this session's preference is unresolved.
  return sessionId && gatewayState === 'open' ? null : true
}
