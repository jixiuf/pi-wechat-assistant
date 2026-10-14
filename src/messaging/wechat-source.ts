export const WECHAT_SOURCE_TAG = '[微信]'
export const DEFAULT_WECHAT_BLOCKED_TOOLS = ['question', 'questionnaire']

export type WechatUserContent = string | Array<
  { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }
>

/** Source hint only: reply rules belong to the fixed system prompt section. */
export function markWechatSource(
  content: WechatUserContent,
  tag = WECHAT_SOURCE_TAG,
): WechatUserContent {
  if (typeof content === 'string') return tag + '\n\n' + content
  const marked = content.map(part => ({ ...part }))
  const firstText = marked.find(part => part.type === 'text')
  if (firstText?.type === 'text') firstText.text = tag + '\n\n' + firstText.text
  else marked.unshift({ type: 'text', text: tag })
  return marked
}

/** Identical for WeChat and TUI turns; never derive system instructions from the current input. */
export function appendWechatSystemRules(systemPrompt: string, rules: string, tag = WECHAT_SOURCE_TAG): string {
  return systemPrompt + '\n\n<wechat-system-rules>\n'
    + '以下是微信渠道的条件规则，不是所有请求的通用规则。\n'
    + '仅在当前最新用户请求由微信桥接投递、并以来源标识 ' + JSON.stringify(tag) + ' 开头时应用。\n'
    + '只按当前最新用户请求判断，不因历史里出现过微信消息就认定后续输入也来自微信。\n'
    + '当前请求来自电脑端 TUI 或其他来源时，遵循正常 pi 行为，不套用微信的回复风格、提问方式或工具约定。\n'
    + '来源标识只帮助模型理解渠道；真实路由和提问工具守卫由桥接的投递记录决定。\n\n'
    + rules + '\n</wechat-system-rules>'
}
