import { describe, expect, it, vi } from 'vitest'
import type { Connection } from '@/domain/connection'
import { connectionProblem } from './ConnectionDetailPage'
import { buildConversations, contactLabel } from '../components/MessagesWorkspace'
import type { TimelineMessage } from '../api/messagesApi'

const connection = (readiness: Connection['readiness'] = null) => ({ readiness }) as Connection

describe('connectionProblem', () => {
  it('offers relinking a closed WhatsApp session but not one owned by another Gateway', () => {
    const relink = vi.fn()
    const closed = connectionProblem(connection(), { connected: false, state: 'close', providerSession: { state: 'close', statusReason: 401, at: '' }, lastActivityAt: null, lastHeartbeatAt: null }, { relink })
    expect(closed?.title).toBe('WhatsApp sin sesión')
    closed?.action?.run()
    expect(relink).toHaveBeenCalled()
    expect(connectionProblem(connection(), { connected: false, managedElsewhere: true, lastActivityAt: null, lastHeartbeatAt: null }, { relink })?.action).toBeUndefined()
    expect(connectionProblem(connection(), { connected: true, lastActivityAt: null, lastHeartbeatAt: null }, { relink })).toBeNull()
  })

  it('asks to reauthorize an expired or expiring Instagram token', () => {
    const authorize = vi.fn()
    expect(connectionProblem(connection({ state: 'expired', ready: false }), null, { authorize })).toMatchObject({ tone: 'critical', action: { label: 'Reautorizar' } })
    expect(connectionProblem(connection({ state: 'ready', ready: true, tokenExpiry: 'expiring' }), null, { authorize })?.tone).toBe('warning')
    expect(connectionProblem(connection({ state: 'ready', ready: true, tokenExpiry: 'valid' }), null, { authorize })).toBeNull()
  })
})

describe('buildConversations', () => {
  const message = (id: string, direction: 'inbound' | 'outbound', contact: string, timestamp: number, extra: Partial<TimelineMessage> = {}) =>
    ({ id, direction, timestamp, text: id, sender: direction === 'inbound' ? contact : 'me', recipient: direction === 'inbound' ? 'me' : contact, status: null, contactName: null, ...extra }) as TimelineMessage

  it('groups by counterpart, newest first, keeping the contact name and failed count', () => {
    const conversations = buildConversations([
      message('a1', 'inbound', '5491111@s.whatsapp.net', 1, { contactName: 'Ana' }),
      message('b1', 'inbound', '5492222@s.whatsapp.net', 2),
      message('a2', 'outbound', '5491111@s.whatsapp.net', 3, { status: 'failed' }),
    ])
    expect(conversations.map((item) => [item.contact, item.name, item.count, item.failed, item.last.id])).toEqual([
      ['5491111@s.whatsapp.net', 'Ana', 2, 1, 'a2'],
      ['5492222@s.whatsapp.net', null, 1, 0, 'b1'],
    ])
    expect(contactLabel('5491122334455@s.whatsapp.net')).toBe('+5491122334455')
    expect(contactLabel('120363@g.us')).toBe('Grupo')
  })
})
