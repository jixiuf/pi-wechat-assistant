// ============================================================================
// TUI 命令处理（/wechat login/start/stop/status/...）
// ============================================================================

import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from '@mariozechner/pi-coding-agent'
import { debugLog } from '../shared/logger.js'
import {
  clearCredentials,
  getCredentialsPath,
  getBridgeLockState,
  getQrCode,
  pollQrStatus,
  saveCredentials,
  requestHandoff,
} from '../bridge/auth.js'
import { WeixinClient, type ApiCallResult } from '../wechat/client.js'
import { MessageQueue } from '../bridge/queue.js'
import { renderQrCode, formatError } from '../shared/utils.js'
import { QR_POLL_INTERVAL_MS, QR_MAX_REFRESH } from '../shared/constants.js'
import type { WechatPrompt } from '../messaging/wechat-prompt.js'
import { describeBridgeLock } from '../bridge/bridge-lock.js'
import { cmdConfig, cmdAutostart, cmdRemoteTools, cmdPrompt } from './config-commands.js'
import { loadConfig } from '../bridge/config.js'
import { resolveImageBatchWaitMs, resolveImageMaxBytes } from '../bridge/config-values.js'
import { clearContextTokens, clearTransportState } from '../bridge/transport-state.js'

type Ctx = ExtensionContext | ExtensionCommandContext

export interface CommandDeps {
  pi: ExtensionAPI
  prepareBridge: () => Promise<void>
  preflightBridge: () => Promise<void>
  wechatPrompt: WechatPrompt
  getClient: () => WeixinClient | null
  setClient: (c: WeixinClient | null) => void
  loadClient: () => Promise<WeixinClient | null>
  isRunning: () => boolean
  setRunning: (v: boolean) => void
  setPollAbort: (c: AbortController | null) => void
  queue: MessageQueue
  lock: () => Promise<{ success: boolean; message: string }>
  stopBridge: (options?: { releaseLock?: boolean }) => Promise<void>
  pollMessages: () => Promise<void>
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
      if (!deps.isRunning()) await startBridge('', ctx, deps)
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
        if (!deps.isRunning()) await startBridge('', ctx, deps)
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

export async function startBridge(_args: string, ctx: Ctx, deps: CommandDeps, _interactive = true): Promise<void> {
  deps.setLatestCtx(ctx)
  if (deps.isRunning()) { deps.notify('微信桥接已经在运行', 'info'); return }
  const lockResult = await deps.lock()
  if (!lockResult.success) { deps.notify(lockResult.message, 'error'); return }
  // 必须交给统一启动路径（startPolling）：preflight → 恢复游标/已消费集 →
  // prepareBridge（resumeSending 重开发送 + 注册微信工具）→ notifyStart → gateway.connect。
  // 早前这里先 setRunning(true) 再调 pollMessages（=startPolling），而 startPolling 在
  // running 已为 true 时直接返回，导致 /wechat start 只是把状态标成运行、实际不轮询、
  // 不恢复发送（表现为「/wechat start 后仍收不到/发不出」）。
  await deps.pollMessages()
}

async function cmdStop(_args: string, ctx: Ctx, deps: CommandDeps): Promise<void> {
  deps.setLatestCtx(ctx)
  await deps.stopBridge({ releaseLock: true })
  deps.notify('微信桥接已停止', 'info')
  deps.updateStatusBar()
}

function describeApiResult(result: ApiCallResult | null | undefined, successLabel: string): string {
  if (!result) return '尚未尝试'
  const detail = result.success ? successLabel
    : `失败: ${result.error}${result.code !== undefined ? ` (code=${result.code})` : ''}`
  return `${detail} @ ${result.at}`
}

async function cmdStatus(_args: string, ctx: Ctx, deps: CommandDeps): Promise<void> {
  deps.setLatestCtx(ctx)
  const activeClient = deps.getClient()
  const config = await loadConfig()
  const lines = [
    '微信来源与回复约定: ' + (config.messageSourceTag?.enabled === false ? '已关闭' : '已开启（默认）'),
    '提示词位置: 系统提示词中的固定微信规则（仅作用于当前微信请求）',
    '微信模板: ' + deps.wechatPrompt.source,
    '用户模板路径: ' + deps.wechatPrompt.userPath,
    `运行状态: ${deps.isRunning() ? '✅ 运行中' : '⏸ 已停止'}`,
    `桥接锁: ${describeBridgeLock(await getBridgeLockState())}`,
    `登录凭据: ${activeClient ? '已加载（有效性由接口验证）' : '未加载'}`,
    `消息发送凭据: ${activeClient?.hasContextToken ? '已保存（不代表仍有效）' : '未获取（发送时尝试不携带此凭据）'}`,
    `最近发送: ${describeApiResult(activeClient?.lastSend, 'API 返回成功（不代表已读）')}`,
    ...(activeClient?.lastSend && !activeClient.lastSend.success && activeClient.lastSend.code === -2
      ? ['发送被拒提示: 微信要求新的用户活动，请先从微信发送一条消息，然后重试。']
      : []),
    `上线状态通知: ${describeApiResult(activeClient?.lastLifecycle?.start, 'API 返回成功（不代表客户端已更新）')}`,
    `下线状态通知: ${describeApiResult(activeClient?.lastLifecycle?.stop, 'API 返回成功（不代表客户端已更新）')}`,
    `双向同步: ${config.bidirectionalSync === true ? '开启' : '关闭（仅微信任务回复）'}`,
    `账号 ID: ${activeClient?.accountId ?? '-'}`,
    `用户 ID: ${activeClient?.userId ?? '-'}`,
    `排队消息: ${deps.queue.pending}`,
    `凭证路径: ${getCredentialsPath()}`,
    `自动启动: ${config.autoStart ? '已开启' : '已关闭'}`,
    `图片合并等待: ${resolveImageBatchWaitMs(config)}ms`,
    `图片上限: ${Math.round(resolveImageMaxBytes(config) / 1024 / 1024)}MB`,
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

export function registerCommands(pi: ExtensionAPI, deps: CommandDeps): void {
  pi.registerCommand('wechat', {
    description: '微信桥接管理：login | start | stop | status | prompt | config | logout | autostart | remotetools',
    handler: async (args, ctx) => {
      const [sub, ...rest] = args.trim().split(/\s+/)
      const restArgs = rest.join(' ')
      const help = [
        '/wechat login             扫码登录',
        '/wechat login --force     强制重新扫码',
        '/wechat start             启动桥接',
        '/wechat stop              停止桥接',
        '/wechat status            查看状态',
        '/wechat prompt show       查看微信回复模板',
        '/wechat prompt init       创建用户模板（不覆盖已有文件）',
        '/wechat prompt reload     重新加载模板',
        '/wechat config            打开设置窗口',
        '/wechat config show       查看配置文本',
        '/wechat logout            清除凭证并停止',
        '/wechat autostart         开关自动启动',
        '/wechat remotetools       开关微信端 /tools 命令（默认禁用）',
      ].join('\n')
      switch (sub) {
        case 'login': return cmdLogin(restArgs, ctx, deps)
        case 'start': return startBridge(restArgs, ctx, deps)
        case 'stop': return cmdStop(restArgs, ctx, deps)
        case 'status': return cmdStatus(restArgs, ctx, deps)
        case 'prompt': return cmdPrompt(restArgs, ctx, deps)
        case 'config': return cmdConfig(args.trim().slice(sub.length).trim(), ctx, deps)
        case 'logout': return cmdLogout(restArgs, ctx, deps)
        case 'autostart': return cmdAutostart(restArgs, ctx, deps)
        case 'remotetools': return cmdRemoteTools(restArgs, ctx, deps)
        default: deps.notify(`未知子命令: ${sub || '(无)'}\n\n${help}`, 'warning')
      }
    },
  })
}
