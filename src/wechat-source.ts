export const WECHAT_SOURCE_TAG = '[来源：微信]'
export const DEFAULT_WECHAT_BLOCKED_TOOLS = ['question', 'questionnaire']

export type WechatUserContent = string | Array<
  { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }
>

/** One marker and one snapshot of the reply rules per batch; never edit the system prompt. */
export function markWechatSource(
  content: WechatUserContent,
  rules: string | null = null,
  tag = WECHAT_SOURCE_TAG,
): WechatUserContent {
  const prefix = tag + (rules ? '\n\n<wechat-reply-rules>\n' + rules + '\n</wechat-reply-rules>' : '')
  if (typeof content === 'string') return prefix + '\n\n' + content
  const marked = content.map(part => ({ ...part }))
  const firstText = marked.find(part => part.type === 'text')
  if (firstText?.type === 'text') firstText.text = prefix + '\n\n' + firstText.text
  else marked.unshift({ type: 'text', text: prefix })
  return marked
}
