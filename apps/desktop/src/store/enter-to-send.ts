import { atom } from 'nanostores'

export function enterToSendOwnerKey(connectionId?: string | null, profile?: string | null): string {
  return JSON.stringify([connectionId ?? '', profile?.trim() || 'default'])
}

export function normalizeEnterToSend(value: unknown): boolean {
  if (value == null) {
    return true
  }

  if (typeof value === 'string') {
    return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase())
  }

  if (Array.isArray(value)) {
    return value.length > 0
  }

  if (typeof value === 'object') {
    return Object.keys(value).length > 0
  }

  return Boolean(value)
}

// A profile-scoped backend config snapshot, separate from busy-turn routing.
export const $enterToSendConfig = atom<{ owner: string; connection: unknown; enabled: boolean } | null>(null)
