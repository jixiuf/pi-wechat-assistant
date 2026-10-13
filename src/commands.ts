// ============================================================================
// TUI 命令处理（/wechat login/start/stop/status/...）
// ============================================================================

import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from '@mariozechner/pi-coding-agent'
import { debugLog, isDebugEnabled } from './logger.js'
import {
  acquireLock,
  clearCredentials,
  clearContextTokens,
  clearTransportState,
  getCredentialsPath,
  getQrCode,
  loadConfig,
  loadCredentials,
  pollQrStatus,
  releaseLock,
  saveConfig,
  saveCredentials,
} from './auth.js'
import { WeixinClient, SessionExpiredError } from './client.js'
import { MessageQueue, getImageBatchWaitMs, getImageMaxBytes } from './queue.js'
import { renderQrCode, formatError } from './utils.js'
import { QR_POLL_INTERVAL_MS, QR_MAX_REFRESH } from './constants.js'

type Ctx = ExtensionContext | ExtensionCommandContext

export interface CommandDeps {
  pi: ExtensionAPI
  getClient: () => WeixinClient | null
  setClient: (c: WeixinClient | null) => void
  loadClient: () => Promise<WeixinClient | null>
  isRunning: () => boolean
  setRunning: (v: boolean) => void
  getPollAbort: () => AbortController | null
  setPollAbort: (c: AbortController | null) => void
  queue: MessageQueue
  lock: () => Promise<{ success: boolean; message: string }>
  unlock: () => Promise<void>
  stopBridge: (options?: { releaseLock?: boolean }) => Promise<void>
  pollMessages: (client: WeixinClient) => Promise<void>
  latestCtx: () => Ctx | null
  setLatestCtx: (ctx: Ctx) => void
  updateStatusBar: () => void
  notify: (message: string, level: 'info' | 'warning' | 'error') => void
  disposeClient: () => Promise<void>
}

async function cmdLogin(args: string, ctx: Ctx, deps: CommandDeps): Promise<void> {
  deps.setLatestCtx(ctx)
  const force = args.split(/\s+/).includes('--force')
  if (!force) {
    const cached = await deps.loadClient()
    if (cached) {
      deps.notify(`已加载本地微信凭证: ${getCredentialsPath()}`, 'info')
      return
    }
  }
  if (deps.isRunning()) await deps.stopBridge({ releaseLock: true })

  // 强制重新登录时清除旧身份的会话和长轮询状态。
  if (force) {
    await deps.disposeClient()
    await Promise.all([clearContextTokens(), clearTransportState()])
  }

  let currentBaseUrl: string | undefined

  try {
    const qr = await getQrCode(currentBaseUrl)
    const qrText = await renderQrCode(qr.url)
    deps.notify(`请用微信扫码登录：\n\n${qrText}\n\n二维码链接：${qr.url}`, 'info')

    let lastStatus: string | null = null
    let refreshCount = 0

    while (true) {
      await new Promise(r => setTimeout(r, QR_POLL_INTERVAL_MS))
      const result = await pollQrStatus(qr.token, currentBaseUrl)

      if (result.redirectHost) {
        currentBaseUrl = `https://${result.redirectHost}`
        debugLog(`重定向到: ${currentBaseUrl}`)
      }

      if (result.status === lastStatus) continue
      lastStatus = result.status

      if (result.status === 'scaned') { deps.notify('已扫码，请在手机上确认登录', 'info'); continue }

      if (result.status === 'confirmed' && result.credentials) {
        await saveCredentials(result.credentials)
        const newClient = await WeixinClient.create(result.credentials)
        deps.setClient(newClient)
        deps.notify('微信登录成功 ✅', 'info')
        deps.updateStatusBar()
        return
      }

      if (result.status === 'expired') {
        refreshCount++
        if (refreshCount >= QR_MAX_REFRESH) {
          deps.notify(`二维码多次过期，请重新执行 /wechat login`, 'error')
          return
        }
        deps.notify(`二维码已过期，正在刷新 (${refreshCount}/${QR_MAX_REFRESH})...`, 'info')
        const newQr = await getQrCode(currentBaseUrl)
        qr.token = newQr.token
        const newQrText = await renderQrCode(newQr.url)
        deps.notify(`请重新扫码：\n\n${newQrText}\n\n二维码链接：${newQr.url}`, 'info')
        lastStatus = null
      }

      if (result.status === 'scaned_but_redirect') continue
    }
  } catch (error) {
    deps.notify(`微信登录失败: ${formatError(error)}`, 'error')
  }
}

async function cmdStart(_args: string, ctx: Ctx, deps: CommandDeps): Promise<void> {
  deps.setLatestCtx(ctx)
  const activeClient = await deps.loadClient()
  if (!activeClient) { deps.notify('未找到微信凭证，请先执行 /wechat login', 'error'); return }
  if (deps.isRunning()) { deps.notify('微信桥接已经在运行', 'info'); return }
  const lockResult = await deps.lock()
  if (!lockResult.success) { deps.notify(lockResult.message, 'error'); return }
  deps.setRunning(true)
  const pollAbort = new AbortController()
  deps.setPollAbort(pollAbort)
  deps.notify('微信桥接已启动 📱', 'info')
  deps.updateStatusBar()
  void deps.pollMessages(activeClient).finally(() => {
    if (deps.getPollAbort()?.signal.aborted) deps.setPollAbort(null)
  }).catch(error => deps.notify(`微信轮询异常退出: ${formatError(error)}`, 'error'))
}

async function cmdStop(_args: string, ctx: Ctx, deps: CommandDeps): Promise<void> {
  deps.setLatestCtx(ctx)
  await deps.stopBridge({ releaseLock: true })
  deps.notify('微信桥接已停止', 'info')
  deps.updateStatusBar()
}

async function cmdStatus(_args: string, ctx: Ctx, deps: CommandDeps): Promise<void> {
  deps.setLatestCtx(ctx)
  const activeClient = deps.getClient()
  const config = await loadConfig()
  const lines = [
    `运行状态: ${deps.isRunning() ? '✅ 运行中' : '⏸ 已停止'}`,
    `登录凭据: ${activeClient ? '已加载（有效性由接口验证）' : '未加载'}`,
    `消息发送凭据: ${activeClient?.hasContextToken ? '已保存（不代表仍有效）' : '未获取（发送时尝试不携带此凭据）'}`,
    `最近发送: ${!activeClient?.lastSend ? '尚未尝试' : `${activeClient.lastSend.success ? 'API 返回成功（不代表已读）' : '失败: ' + activeClient.lastSend.error} @ ${activeClient.lastSend.at}`}`,
    `双向同步: ${config.bidirectionalSync !== false ? '开启' : '关闭（仅微信任务回复）'}`,
    `账号 ID: ${activeClient?.accountId ?? '-'}`,
    `用户 ID: ${activeClient?.userId ?? '-'}`,
    `排队消息: ${deps.queue.pending}`,
    `凭证路径: ${getCredentialsPath()}`,
    `自动启动: ${config.autoStart ? '已开启' : '已关闭'}`,
    `图片合并等待: ${getImageBatchWaitMs()}ms`,
    `图片上限: ${Math.round(getImageMaxBytes() / 1024 / 1024)}MB`,
  ]
  deps.notify(lines.join('\n'), 'info')
}

async function cmdLogout(_args: string, ctx: Ctx, deps: CommandDeps): Promise<void> {
  deps.setLatestCtx(ctx)
  await deps.stopBridge({ releaseLock: true })
  await deps.disposeClient()
  await Promise.all([
    clearCredentials(),
    clearContextTokens(),
    clearTransportState(),
  ])
  deps.setClient(null)
  deps.queue.lastWechatUser = null
  deps.notify(`已清除微信凭证: ${getCredentialsPath()}`, 'info')
  deps.updateStatusBar()
}

async function cmdConfig(args: string, ctx: Ctx, deps: CommandDeps): Promise<void> {
  deps.setLatestCtx(ctx)
  const [key, value] = args.trim().split(/\s+/)
  const config = await loadConfig()
  if (!key) {
    deps.notify([
      `自动启动: ${config.autoStart ? '已开启' : '已关闭'}`,
      `双向同步: ${config.bidirectionalSync !== false ? '已开启（默认）' : '已关闭'}`,
      `微信 /tools: ${config.allowRemoteTools ? '已开启' : '已关闭（/wechat remotetools on 开启）'}`,
      `图片合并等待: ${getImageBatchWaitMs()}ms`,
      `图片上限: ${Math.round(getImageMaxBytes() / 1024 / 1024)}MB`,
      '', '用法:', '/wechat config bidirectional on|off', '/wechat config image-wait 8000', '/wechat config image-max 50',
    ].join('\n'), 'info')
    return
  }
  if (key === 'bidirectional') {
    if (value !== 'on' && value !== 'off') { deps.notify('用法: /wechat config bidirectional on|off', 'error'); return }
    config.bidirectionalSync = value === 'on'
    await saveConfig(config)
    deps.notify(`双向同步已${config.bidirectionalSync ? '开启' : '关闭'}`, 'info')
    return
  }
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric <= 0) { deps.notify('配置值必须是正数', 'error'); return }
  if (key === 'image-wait') {
    config.imageBatchWaitMs = Math.min(Math.max(Math.round(numeric), 0), 60_000)
  } else if (key === 'image-max') {
    config.imageMaxBytes = Math.round(numeric * 1024 * 1024)
  } else {
    deps.notify('未知配置项。支持: bidirectional, image-wait, image-max', 'error')
    return
  }
  await saveConfig(config)
  deps.notify('微信桥接配置已更新 ✅', 'info')
}

async function cmdAutostart(_args: string, ctx: Ctx, deps: CommandDeps): Promise<void> {
  deps.setLatestCtx(ctx)
  const config = await loadConfig()
  config.autoStart = !config.autoStart
  await saveConfig(config)
  deps.notify(`自动启动已${config.autoStart ? '开启 ✅' : '关闭 ❌'}`, 'info')
}

async function cmdRemoteTools(args: string, ctx: Ctx, deps: CommandDeps): Promise<void> {
  deps.setLatestCtx(ctx)
  const config = await loadConfig()
  const arg = args.trim().toLowerCase()
  if (arg === 'on' || arg === 'off') {
    config.allowRemoteTools = arg === 'on'
  } else if (arg === '') {
    config.allowRemoteTools = !config.allowRemoteTools
  } else {
    deps.notify('用法: /wechat remotetools on|off（无参数则切换）', 'error')
    return
  }
  await saveConfig(config)
  deps.notify(`微信端 /tools 已${config.allowRemoteTools ? '开启 ✅（注意：微信消息将可修改本机工具权限）' : '关闭 ❌'}`, 'info')
}

export function registerCommands(pi: ExtensionAPI, deps: CommandDeps): void {
  pi.registerCommand('wechat', {
    description: '微信桥接管理：login | start | stop | status | config | logout | autostart | remotetools',
    handler: async (args, ctx) => {
      const [sub, ...rest] = args.trim().split(/\s+/)
      const restArgs = rest.join(' ')
      const help = [
        '/wechat login             扫码登录',
        '/wechat login --force     强制重新扫码',
        '/wechat start             启动桥接',
        '/wechat stop              停止桥接',
        '/wechat status            查看状态',
        '/wechat config            查看/设置配置',
        '/wechat logout            清除凭证并停止',
        '/wechat autostart         开关自动启动',
        '/wechat remotetools       开关微信端 /tools 命令（默认禁用）',
      ].join('\n')
      switch (sub) {
        case 'login': return cmdLogin(restArgs, ctx, deps)
        case 'start': return cmdStart(restArgs, ctx, deps)
        case 'stop': return cmdStop(restArgs, ctx, deps)
        case 'status': return cmdStatus(restArgs, ctx, deps)
        case 'config': return cmdConfig(restArgs, ctx, deps)
        case 'logout': return cmdLogout(restArgs, ctx, deps)
        case 'autostart': return cmdAutostart(restArgs, ctx, deps)
        case 'remotetools': return cmdRemoteTools(restArgs, ctx, deps)
        default: deps.notify(`未知子命令: ${sub || '(无)'}\n\n${help}`, 'warning')
      }
    },
  })
}
