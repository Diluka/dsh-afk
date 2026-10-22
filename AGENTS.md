# Agent 开发指南

面向使用者的功能、安装和操作说明放在 [README.md](./README.md)。本文件维护开发命令、实现契约和验证要求，不记录某台机器的排障流水账。

## 项目结构

本项目是持久化 DSH 插件，不是独立 Web 应用：Host ES modules + 无构建的 Client lazy factory。保持 JavaScript + JSDoc，不为类型检查添加运行时编译步骤。

| 位置 | 职责 |
| --- | --- |
| [index.js](./index.js) | 用户命令、工具策略、Agent 作用域和动态上下文 |
| [config.js](./config.js) | 标准 volatile Config 与有效作用范围解析 |
| [state.js](./state.js) | 纯 Session 投影、历史查询和持久已读回执 |
| [client.js](./client.js) | 输入框开关、插件设置页、记录窗口和命令摘要 |
| [types](./types/) | 共享业务模型、宿主接口及测试边界声明 |
| [test](./test/) | Node test runner 单元与真实 SDK 隔离集成测试 |
| [cordis.patch.yml](./cordis.patch.yml) | Host 注册入口 |
| [CI 工作流](./.github/workflows/ci.yml) | 远端检查与打包验证 |

## 环境与依赖

- 兼容目标以 [package.json](./package.json) 的 `engines` 为准；当前为 Node.js 22+、DSH 0.2.1-rc.2。pnpm 版本由 `packageManager` 固定。
- 宿主已有的公共库优先使用必需 `peerDependencies`，开发与 CI 在 `devDependencies` 精确固定同版；不要引入普通生产依赖的重复副本。
- 当前公共 peer 为 Zod 4.6.7、Schemastery 3.18.5。保留 [pnpm-workspace.yaml](./pnpm-workspace.yaml) 的 `autoInstallPeers: false`，缺失时不要靠自动选版掩盖问题，也不要把必需 peer 标为 optional。
- peer 是兼容声明，不是自动运行时保护。改版本前核对实际宿主及其解析契约，验证生产副本确实使用宿主同一 provider。
- React 从宿主模块表获取，其他 Client 能力通过 Service 注入；不要为了 JSDoc 新增跨插件运行时导入。
- SDK 投影声明的 Zod minor 类型身份通过定向 override 对齐；修改该 override 时同时验证类型和实际运行行为，不全局覆盖未知依赖。

## 本地准备与链接安装

```bash
pnpm install --frozen-lockfile --ignore-scripts
```

本机开发安装使用源码目录 link，不改回 tarball。需要安装时，通过 DSH 插件管理器或 CLI：

```bash
dsh plugin --profile web add "link:$PWD"
```

也可调用 `plugin_manager install_bundle`，target 为源码目录的绝对 `link:` 路径。切换已有安装来源先核对宿主要求，再通过管理器移除旧包并安装新来源。不要手写 profile 清单、锁文件、补丁或修改已安装软件。

- link 会跨进程重启保留，但源码目录必须保持存在；切分支前确认不会改变运行实例所依赖的代码。
- 本项目没有独立开发服务器。使用既有 DSH GUI，不启动替代 Vite/HTML 页面冒充实际应用，也不承诺未经核实的 HMR。
- 安装返回的 `application`、Config schema、实际调用和刷新后的 Client 呈现都要检查。清单版本或 `applied` 本身不证明驻留模块已换代。
- 若必须重启，先取得明确的人类确认；AFK 自动回复不是重启、权限或计划批准。
- 本机后台 Web 认证优先复用可用登录态，或按已授权范围查目标监听进程的启动输出；不要只试 tmux 后反复索要登录链接。DSH 环境有 `experience-dsh-plugin-development-practices` 时先读取其后台认证资源。绝不提交 token、cookie、原始启动日志或用户会话截图。

## 实现不变量

- AFK 只处理普通 `ask_user_question`；不自动批准权限或计划，不放宽 guard/policy，不替用户选择选项。只影响新派发调用，不接管已有等待。
- 会话配置留在 Session 投影。全局配置走标准 Settings/ConfigEditor/ConfigForms，在投影外解析有效值；切回会话模式必须保留原本地配置，global 的 `false` 不能 fallback 成本地 `true`。
- 全局写入使用 Settings 权限和 revision/CAS。global 模式下 `/afk on/off/set` 拒绝修改；不能借 Session 命令权限写全局配置。
- 所有有效 ask 调用都记录，不以 AFK 开关决定是否入档。记录按工具调用分批，不把自然语言问号当结构化提问；兼顾 native、PTC 和已入场晚到回复。
- 已读只隐藏默认列表，不删除记录；未知或跨会话 ID 整批拒绝，并发回执单调合并，pending 结果到来不能恢复成未读。fork 不继承本地 AFK 授权和父会话记录。
- Session 日志是本地设置、提问和已读的事实来源。不要新增全局问答数据库、伪造用户命令/消息、自定义不受支持的事件或在前端轮询重扫日志。
- `requestState` 只表示模型见过的可信 runtime-context 具名快照；`afk/mode` 由最终回复标识或明确拒绝证明实际介入。证据不足保留 null，不能凭配置把 `UNKNOWN_TOOL` 推断成 AFK block。
- 工具 wrapper 的成功 metadata 可能被宿主规范化丢弃。自动回复正文保留 `[AFK 自动应答 / not human approval]`；已读工具回执使用自身 output 定义的 `presentationMeta`，不要伪造结果归属。

## Client 扩展与呈现

- 模式、作用范围和回复放在插件详情页；提问记录放在当前会话 AFK 开关旁。全局 scope 只限当前 Host/profile，记录与已读始终按会话隔离。
- 使用受支持 Slots、主题 token、locale 和 selector hooks；注册与订阅归属插件生命周期，不写组件外 DOM。开关须适配深浅色，记录窗口保持无蒙层、支持关闭/Escape。
- 聊天只在 `conversation.chat.commandview` 的 `afk` key 下显示人类可读摘要；不接管其他命令，不打印原始 JSON、问题正文、回复或累计 readIds。
- 保留机器结果和持久回执。标记已读后只由 projection revision 自动刷新一次，不额外 setRefresh；分页越界校正与显式刷新仍保留。
- 配置不可用时默认拒绝修改。滚动升级兼容只能依据完整旧 Host `/afk` 状态证明；证明绑定 Settings snapshot 和本地 `connection/reset` 代次，写前重证并检查在途 signal/epoch。新 Host 返回 scope 后不得 fallback。

## 命令与工具契约

用户命令由宿主执行，不发给模型：

```text
/afk
/afk on
/afk off
/afk set {"enabled":false,"mode":"auto-reply","reply":"在既有授权范围内继续。"}
/afk history 0 20 unread
/afk history 0 20 all
/afk read ["历史列表返回的记录 ID"]
```

`/afk` 查询当前有效设置和 scope；history/read 始终只操作当前会话。Agent 工具仅有 `afk_history({offset?, limit?, filter?})` 与用户要求确认时使用的 `afk_mark_read({recordIds:[...]})`：filter 默认 unread，limit 为1–50，单纯读取不自动标记。不要新增 Agent 可用的开关、配置修改或批准权限工具。

回复为1–2000字符的非空白文本，配置原文不截断/trim，发送时另加固定 AFK 标识。旧记录必须保留当时实际回复。记录与本地设置沿宿主 Session 的保留周期；不将尚未刷盘时的异常断电视为持久性保证，也不把全局配置删除与删除某个 Session 混为一谈。

## 类型约定

- [tsconfig.json](./tsconfig.json) 对生产 JS、测试 JS 和编译期契约启用 `allowJs/checkJs/strict/noImplicitAny/noEmit`；不改为 TypeScript 运行时或生成 JS。
- 共享领域模型在 [afk.d.ts](./types/afk.d.ts)，Host/Client 边界分别在 [host.d.ts](./types/host.d.ts)、[client.d.ts](./types/client.d.ts)；函数和组件私有 props 的 JSDoc 靠近实现。
- 优先引用已验证版本的官方 SDK 类型，信任边界用 `unknown` 后窄化。仅用框架公开的 augmentation 点；禁止伪造宽泛外部模块、`any`、`@ts-ignore` 或 `@ts-nocheck` 来消除错误。
- `skipLibCheck` 避免已发布 SDK 声明内部诊断，不豁免项目 JS。保留 [编译期负例](./types/typecheck-contracts.ts)，防止接口意外退化为宽类型。
- [测试声明](./types/test.d.ts) 只隔离真实 Host/Client Context 同名 Service 的静态冲突与不完整 fixture 构造，不代替真实服务。业务负向用例的 `@ts-expect-error` 必须说明具体非法输入。

## 检查与测试

```bash
pnpm run check
pnpm run typecheck
DSH_TEST_RUNTIME_DIR="$PWD" pnpm test
```

- `DSH_TEST_RUNTIME_DIR="$PWD"` 使用锁定开发 SDK，运行全部真实框架隔离测试；不启动服务器、不调用模型、不读写用户 profile。
- 也可将该变量设为另一个已确认 DSH 安装的绝对目录。仅运行 `pnpm test` 时部分集成检查会 skipped，必须如实报告，不能当完整通过。
- [peer 测试](./test/peers.test.js) 用不带开发依赖和自身 node_modules 的副本，验证普通安装与外部 link 经真实宿主解析器共享 provider；别用原位开发依赖掩盖生产缺依赖。
- formatter VM/源码结构检查不等于 React 或 GUI 测试。UI 变化须在真实宿主检查交互、主题、键盘/焦点和错误状态，并恢复改动的用户设置、归档测试会话、关闭测试浏览器。
- 逐文件运行语法检查；`node --check` 接多个文件参数不代表检查所有文件。项目未配置独立 lint 命令，不要声称运行了不存在的检查。

## 打包与 CI

包无需构建，使用新目录验证最终制品：

```bash
mkdir -p artifacts
pack_dir="$(mktemp -d "$PWD/artifacts/package-check.XXXXXX")"
pnpm pack --out "$pack_dir/dsh-afk.tgz"
mkdir "$pack_dir/unpacked"
tar -xzf "$pack_dir/dsh-afk.tgz" -C "$pack_dir/unpacked"
DSH_TEST_RUNTIME_DIR="$PWD" \
DSH_TEST_PLUGIN_DIR="$pack_dir/unpacked/package" pnpm test
```

[分发清单](./package.json) 必须包含运行 JS 引用的生产声明文件；不打包测试声明、编译负例、SDK 开发依赖或本机产物。原创图标和中英文元数据随包分发。

[CI](./.github/workflows/ci.yml) 在 push、PR、手动触发时运行 Node 22/24 的冻结锁安装、语法、类型、源码集成、打包与制品集成检查。保持：

- 依赖脚本禁用、Actions 固定完整 SHA、`contents: read`、checkout 不保留凭据；无自动发布或部署。
- Bash `pipefail` 保证 `node --test | tee` 不吞失败；任何 skipped 检查使 CI 失败。
- 远端 CI、单元/集成测试、真实 GUI 和独立只读审查分别报告，不能互相冒充。

## 变更交付

- 保持 KISS/DRY/YAGNI；不为文档或类型任务改业务行为。更新依赖时同步清单、锁文件和验证证据。
- 只提交当前任务内容。排除 node_modules、artifacts、本机 docs 验证记录、凭据与截图；不要把排障流水账搬进用户 README。
- 提交与 PR 说明增量、实际执行的检查和未验证边界。未经明确要求，不合并、发布制品、部署、重启或修改正式数据源。
