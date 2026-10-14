# 贡献指南

[English](CONTRIBUTING.md) | 简体中文

感谢你帮助改进 pi-wechat-assistant。较大的改动请先通过 issue 说明问题与预期行为，便于讨论范围。

## 开发环境

开发时使用 Node.js 22 和 npm，与 CI 保持一致。包声明的运行时最低版本为 Node.js 20.3.0；开发 CI 不覆盖所有支持的 Node.js 版本。

```bash
git clone https://github.com/shenjiecode/pi-wechat-assistant.git
cd pi-wechat-assistant
npm ci
npm run check
```

Pi 直接加载 TypeScript 入口。开发本扩展无需单独构建，也无需生成 `dist/` 目录。

## 检查命令

| 命令 | 用途 |
| --- | --- |
| `npm run check` | 源码类型检查、测试与 npm 包内容检查 |
| `npm run typecheck` | 检查运行时 TypeScript 源码 |
| `npm test` | 运行全部测试 |
| `npm run test:watch` | 开发时持续运行测试 |
| `npm run typecheck:pi` | 检查七个版本的 Pi API 类型兼容性 |
| `npm run check:package` | 检查发布文件列表，不生成压缩包 |

兼容性检查首次运行会下载已发布的类型声明，并缓存到 `node_modules/.cache/pi-wechat-compat/`。它不会替换已安装依赖，也不能代替微信实际收发验证。

例如，使用 `npm test -- tests/messaging/message.test.ts` 运行单个测试。`tests/integration/` 中的集成测试通过根目录公开入口加载扩展，并模拟 Pi 和微信依赖。

## 代码组织

目录职责和运行流程见[架构说明](architecture.zh.md)。测试放在对应领域目录；涉及多个模块的行为放在 `tests/integration/`。

沿用现有风格：TypeScript、ESM、两空格缩进、单引号、不加分号。TypeScript 的相对导入使用 `.js` 后缀以匹配 Node16 模块解析。Pi 导入尽量保持为类型导入，以兼容两个受支持的包命名空间。

保持改动聚焦。行为变化应补充回归测试，面向用户的说明变化应同步更新两份 README，不要提交生成文件、收到的文件、凭据或日志。编辑器配置见 `.editorconfig`；目前未通过格式化器或 lint 工具强制检查格式。

项目概览的英文版保存在 `README.md`，简体中文版保存在 `README.zh.md`。详细说明统一放在 `docs/`，英文命名为 `name.md`，中文命名为 `name.zh.md`。请同步维护语言切换链接和两个语言版本，入口见[文档目录](README.zh.md)。

## Issue 与 PR

Issue、PR 的说明、评论、回复及评审意见采用整体双语格式：先写完整英文，再在下方写完整的对应中文，不按段落或小节交替排列。Issue、PR 模板也遵循此结构。说明文档不适用这项交流规则，按上文约定拆分为独立的语言文件。请礼貌交流，提供复现步骤、环境版本和实际执行的验证。

提交 PR 前运行 `npm run check` 和 `npm run typecheck:pi`。CI 在 Linux 和 Windows 上执行主要检查，并在 Linux 上执行 Pi 兼容性检查。手动验证与自动化测试应分别说明。

敏感问题请参阅[安全说明](SECURITY.zh.md)。

## 发布

维护者更新 `package.json` 和 `package-lock.json` 中的版本，在 `CHANGELOG.md` 中添加对应的 `## [x.y.z]` 节，并在创建发布标签前运行上述两项检查。发布工作流会校验标签、重新执行检查、发布到 npm，并从更新记录创建 GitHub Release。发布及推送标签应经过明确的发布决定。
