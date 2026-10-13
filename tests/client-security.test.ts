// ============================================================================
// 测试: 微信客户端只能接收扫码凭证绑定用户的消息
// ============================================================================

import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  apiGetUpdates: vi.fn(),
  sendMessage: vi.fn(),
  notifyStart: vi.fn(),
  notifyStop: vi.fn(),
  loadContextTokens: vi.fn(),
  saveContextTokensThrottled: vi.fn(),
  loadCursor: vi.fn(),
  saveCursor: vi.fn(),
  loadSeenIds: vi.fn(),
  saveSeenIds: vi.fn(),
}))

vi.mock('../src/api.js', async () => ({
  ...await vi.importActual<typeof import('../src/api.js')>('../src/api.js'),
  getUpdates: mocks.apiGetUpdates,
  getConfig: vi.fn(),
  sendMessage: mocks.sendMessage,
  notifyStart: mocks.notifyStart,
  notifyStop: mocks.notifyStop,
  sendTyping: vi.fn(),
  getUploadUrl: vi.fn(),
  uploadToCdn: vi.fn(),
  sendMediaMessage: vi.fn(),
  isSessionExpired: vi.fn(() => false),
}))

vi.mock('../src/auth.js', () => ({
  loadContextTokens: mocks.loadContextTokens,
  saveContextTokensThrottled: mocks.saveContextTokensThrottled,
  flushContextTokens: vi.fn().mockResolvedValue(undefined),
  loadCursor: mocks.loadCursor,
  saveCursor: mocks.saveCursor,
  loadSeenIds: mocks.loadSeenIds,
  saveSeenIds: mocks.saveSeenIds,
}))

import { WeixinClient } from '../src/client.js'
import { ApiError } from '../src/api.js'

const credentials = {
  token: 'token',
  baseUrl: 'https://example.test',
  accountId: 'bot',
  userId: 'bound-user',
}

function rawMessage(messageId: string, fromUserId: string) {
  return {
    message_type: 1,
    message_id: messageId,
    from_user_id: fromUserId,
    to_user_id: 'bot',
    context_token: `context-${messageId}`,
    create_time_ms: Date.now(),
    item_list: [{ type: 1, text_item: { text: 'hello' } }],
  }
}

describe('WeixinClient sender authorization', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.sendMessage.mockReset().mockResolvedValue({ ret: 0 })
    mocks.loadContextTokens.mockResolvedValue({ lastUserId: null, tokens: {} })
    mocks.loadCursor.mockResolvedValue('')
    mocks.loadSeenIds.mockResolvedValue(new Set<string>())
    mocks.saveCursor.mockResolvedValue(undefined)
    mocks.saveSeenIds.mockResolvedValue(undefined)
  })

  it('drops an unbound sender before caching context or producing a message', async () => {
    mocks.apiGetUpdates.mockResolvedValue({
      get_updates_buf: 'cursor-1',
      msgs: [rawMessage('attacker-message', 'other-user')],
    })
    const client = await WeixinClient.create(credentials)

    await expect(client.getUpdates()).resolves.toEqual([])
    expect(client.lastActiveUserId).toBeNull()
    expect(client.getKnownUsers()).toEqual([])
    expect(mocks.saveContextTokensThrottled).not.toHaveBeenCalled()
    expect(mocks.saveSeenIds).not.toHaveBeenCalled()
  })

  it('accepts the user bound to the QR-login credential', async () => {
    mocks.apiGetUpdates.mockResolvedValue({
      get_updates_buf: 'cursor-1',
      msgs: [rawMessage('owner-message', 'bound-user')],
    })
    const client = await WeixinClient.create(credentials)

    const messages = await client.getUpdates()

    expect(messages).toHaveLength(1)
    expect(messages[0].userId).toBe('bound-user')
    expect(client.lastActiveUserId).toBe('bound-user')
    expect(client.getKnownUsers()).toEqual(['bound-user'])
    expect(mocks.saveContextTokensThrottled).toHaveBeenCalledWith({
      lastUserId: 'bound-user',
      tokens: { 'bound-user': 'context-owner-message' },
    })
  })

  it('restores only context belonging to the currently bound user', async () => {
    mocks.loadContextTokens.mockResolvedValue({
      lastUserId: 'other-user',
      tokens: {
        'bound-user': 'owner-context',
        'other-user': 'stale-context',
      },
    })

    const client = await WeixinClient.create(credentials)

    expect(client.lastActiveUserId).toBeNull()
    expect(client.getKnownUsers()).toEqual(['bound-user'])
  })

  it('attempts sending to the bound user without requiring a first inbound message', async () => {
    const client = await WeixinClient.create(credentials)
    await client.sendText(credentials.userId, 'hello')
    expect(mocks.sendMessage).toHaveBeenCalledWith(credentials.baseUrl, credentials.token, credentials.userId, 'hello', undefined)
    expect(client.hasContextToken).toBe(false)
    expect(client.lastSend?.success).toBe(true)
  })

  it('sends text verbatim without trimming code indentation or trailing newlines', async () => {
    const client = await WeixinClient.create(credentials)
    const verbatim = '  const x = 1;\n\n'
    await client.sendText(credentials.userId, verbatim)
    expect(mocks.sendMessage).toHaveBeenCalledWith(credentials.baseUrl, credentials.token, credentials.userId, verbatim, undefined)
    await expect(client.sendText(credentials.userId, '   ')).rejects.toThrow('Message text cannot be empty')
  })

  it('records lifecycle notification results for diagnostics', async () => {
    const client = await WeixinClient.create(credentials)
    mocks.notifyStart.mockRejectedValueOnce(new ApiError('start failed', { status: 503 }))
    await expect(client.notifyStart()).rejects.toThrow('start failed')
    expect(client.lastLifecycle.start).toMatchObject({ success: false, error: 'start failed', httpStatus: 503 })
    await client.notifyStop()
    expect(client.lastLifecycle.stop).toMatchObject({ success: true })
  })

  it('uses restored context and retries once without it only on ret=-2', async () => {
    mocks.loadContextTokens.mockResolvedValue({ lastUserId: null, tokens: { 'bound-user': 'cached' } })
    mocks.sendMessage.mockRejectedValueOnce(new ApiError('prepare failed', { status: 200, code: -2 }))
    const client = await WeixinClient.create(credentials)
    await client.sendText(credentials.userId, 'hello')
    expect(mocks.sendMessage.mock.calls.map(call => call[4])).toEqual(['cached', undefined])
    expect(client.lastSend?.success).toBe(true)
  })

  it('does not retry ambiguous network errors and records the failed attempt', async () => {
    mocks.loadContextTokens.mockResolvedValue({ lastUserId: null, tokens: { 'bound-user': 'cached' } })
    mocks.sendMessage.mockRejectedValueOnce(new Error('network timeout'))
    const client = await WeixinClient.create(credentials)
    await expect(client.sendText(credentials.userId, 'hello')).rejects.toThrow('network timeout')
    expect(mocks.sendMessage).toHaveBeenCalledTimes(1)
    expect(client.lastSend).toMatchObject({ success: false, error: 'network timeout' })
  })

  it('limits fallback to one retry and preserves the final rejection', async () => {
    mocks.loadContextTokens.mockResolvedValue({ lastUserId: null, tokens: { 'bound-user': 'cached' } })
    mocks.sendMessage.mockRejectedValue(new ApiError('prepare failed', { status: 200, code: -2 }))
    const client = await WeixinClient.create(credentials)
    await expect(client.sendText(credentials.userId, 'hello')).rejects.toThrow('prepare failed')
    expect(mocks.sendMessage).toHaveBeenCalledTimes(2)
    expect(client.lastSend?.success).toBe(false)
  })

  it('rejects outbound delivery to an unbound user even without context', async () => {
    const client = await WeixinClient.create(credentials)
    await expect(client.sendText('other-user', 'hello')).rejects.toThrow('只能发送给扫码绑定用户')
    expect(mocks.sendMessage).not.toHaveBeenCalled()
  })

  it('notifies lifecycle with the saved bot credentials', async () => {
    const client = await WeixinClient.create(credentials)
    await client.notifyStart()
    await client.notifyStop()
    expect(mocks.notifyStart).toHaveBeenCalledWith(credentials.baseUrl, credentials.token)
    expect(mocks.notifyStop).toHaveBeenCalledWith(credentials.baseUrl, credentials.token)
  })
})
