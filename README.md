# dsh-afk

DSH Web 的离开模式，可选**按会话单独（默认）或当前 profile 全局统一**。输入框权限设置右侧提供 AFK 开关及当前会话的「记录」按钮；作用范围、模式和自动应答语位于 **插件 → AFK · 会话离开模式 → 详情页**。新安装默认按会话独立、AFK 关闭。

## 使用

1. 打开插件列表中的 AFK 详情页，在「设置作用范围」中选择「按会话单独」或「全局统一」，点击「应用范围」。
2. 按会话模式下选择目标会话、编辑模式/回复后保存；页面优先选中主视图保留的会话。全局模式下只编辑一份共享配置，输入框开关显示「AFK · 全局」，其开关、模式和回复对当前 Host/profile 的所有现有及未来会话生效。全局配置初始关闭，不自动复制某个会话的配置。
3. 离开前打开输入框旁的 AFK 开关；回来后关闭。模式和应答语不从输入框弹出。切回按会话模式后，各会话原来的配置保持不变；全局配置也保留供再次选择。
4. 点击 AFK 开关旁的「记录」打开**无蒙层、不阻塞主界面**的轻量窗口。记录**当前会话全部 `ask_user_question` 提问**，不受 AFK 是否开启影响。默认只看未读；点击每条记录的「已读」后从默认列表隐藏，切到「全部」仍能回看。已读状态随会话持久保存，刷新不会恢复未读。
5. 每页 20 批，最新优先；一批对应一次工具调用，可能包含多个问题。切换会话时关闭原窗口并取消旧请求，记录与已读状态不会串到别的会话。插件详情页只放设置，不展示记录。

### 两种模式

- **自动应答（默认）**：当 Agent 发起新的 `ask_user_question` 时，逐题返回空的选项选择和配置的自定义回复，让 Agent 在既有授权范围内自行判断。兼容当前 DSH 的普通与 timed ask。回复固定附加 `[AFK 自动应答 / not human approval]` 标识；不会伪装成人类选择了推荐项。
- **禁用提问**：在当前 Agent 的工具视图中屏蔽继承的 `ask_user_question`，并用工具 guard 阻止执行。没有发出的提问自然没有记录；若仍收到旧模型上下文发出的调用，其尝试和失败结果仍会记录。自定义插件若在 Agent 自有层注册同名工具，可能无法隐藏，但 guard 仍会阻止它执行。

### 自动应答语

默认：

> 用户暂时不在，请在既有授权范围内自行选择最优方式继续；需要明确授权的操作请保留，等待用户回来确认。

可修改为 1–2000 个字符的非空白文本。配置保持原样，发送时另加固定 AFK 标识。旧记录保存**当时实际返回的完整文本**，修改配置不会覆盖旧回复。

## 边界

- 只接管 `ask_user_question`，**不自动批准权限、不批准计划、不放宽安全策略**；其他工具和提问服务保持原有行为。
- 按会话模式中新会话/fork 默认关闭，恢复会话重建原本地配置；全局模式中包括新会话/fork 都读取当前统一配置。不同 Host/profile 不共享这份设置。
- 全局 scope/global 配置由标准 Settings/ConfigEditor 持久保存并实时镜像，无轮询；不会覆盖本地 Session 配置。全局写入使用独立的 Settings 权限与 revision，不借用某个 Session 的命令权限。
- 仅影响开启后新派发的提问，不接管已经在等待的旧问题；切模式也不会取消已在运行的提问。
- 记录来自现有 Session 的命令和工具事件，兼顾 native、PTC 子派发与已入场的晚到回复。所有有效 ask 调用都会记录，AFK 只决定是否自动应答/禁用工具，不决定是否记录。自然语言回复里的问号不视作结构化提问。
- 已读只是隐藏于默认列表，不删除原始记录。已读回执通过现有命令/工具结果日志保存；并发标记只会增加已读，不会将已读变回未读。没有另建全局问答数据库，也没有轮询或扫描整个日志的前端逻辑。
- v0.2.0 会重建旧会话的记录投影，因此旧日志中 AFK 未开启时的提问也会补入档案，首次显示为未读。
- 本地设置和记录沿用宿主 Session 的保存/恢复与保留周期；删除会话也会删除对应档案，全局 profile 配置则独立保留。不能将 Session 尚未刷盘时的意外断电视为已保证持久化。
- AFK 不是循环执行器，不会让已经结束的任务自动重启。

## 命令显示

聊天中的 AFK 命令行使用本插件专属 `conversation.chat.commandview` 呈现：显示简短状态、未读/总数或「已标记为已读」，不倾倒 JSON、问题正文、回复文本或完整 readIds。已加载且保留命令名的历史 AFK 行也会使用同一呈现，其他命令不受影响。原始结构化结果仍保存在 Session 日志/轨迹中，记录窗口和持久已读回执继续正常使用。

标记已读后，只由 Session projection 的 revision 推送触发自动重读，不再额外手动刷新一次；分页越界时仍做必要的页码校正。

## 用户命令与 Agent 工具

用户可使用输入框命令（不发给模型）：

```text
/afk
/afk on
/afk off
/afk set {"enabled":false,"mode":"auto-reply","reply":"用户暂时不在，请在既有授权范围内继续。"}
/afk history 0 20 unread
/afk history 0 20 all
/afk read ["由历史列表返回的记录 ID"]
```

全局模式下，`/afk on`、`off`、`set` 会明确拒绝：请用插件详情页或输入框的全局开关修改，防止将会话命令权限提升为全局设置权限。`/afk` 查询返回当前有效设置和 scope；history/read 在任一模式下仍只操作当前会话。

记录的 `requestState` 是模型实际见过的 runtime-context 快照，未知时为 null；`afk/mode` 只由最终回复/明确拒绝证明实际介入，普通回答为 false/null，其它证据不足的失败为 null/null。请求后切换设置时二者可以不同，不把配置快照伪装成 dispatch 瞬时状态。v3 投影自动从原日志重建这些字段。

Agent 可使用 `afk_history({offset?, limit?, filter?})` 查询记录（`filter` 默认 `unread`，`limit` 为 1–50），或在用户要求确认已读时使用 `afk_mark_read({recordIds:[...]})` 标记已读。两条路径与界面共享实现；读取列表本身不会自动标记已读。**没有 Agent 可用的启用 AFK、修改应答语或批准权限工具。**

## 安装

包为无构建的 Host ES module + Client lazy factory，无需额外构建步骤。

### 从 GitHub 安装

在 DSH 插件管理器中安装 `github:Diluka/dsh-afk`，或使用 CLI（将 `web` 换成你的目标 profile）：

```bash
dsh plugin --profile web add "github:Diluka/dsh-afk"
```

### 本地开发：目录链接安装

```bash
git clone https://github.com/Diluka/dsh-afk.git
cd dsh-afk
pnpm install --frozen-lockfile --ignore-scripts
dsh plugin --profile web add "link:$PWD"
```

也可通过 `plugin_manager install_bundle`，target 指定 `link:/absolute/path/to/dsh-afk`。切换已有安装来源时先通过插件管理器移除旧包，再安装目录链接；不要手动编辑 profile 清单、补丁或 node_modules。

链接会跨进程重启保留，但不等于任意源码变化都会自动刷新后台。开发目录必须保持存在，改动后的加载结果仍需在当前 Host 与刷新后的真实页面核对。tarball 仅作为可选分发/隔离测试制品，本地开发推荐使用目录链接。

- 已核对兼容版本：**DSH 0.2.1-rc.2**；其他版本未验证，清单采用精确版本门槛。
- 运行时公共库使用必需的 `peerDependencies`：Zod `4.6.7`（事件/命令验证）与 `@deepseek-ai/schemastery` `3.18.5`（标准 volatile Config），由 DSH 宿主提供并共享，不作为本插件的普通 `dependencies` 安装第二份。当前适配版本采用已验证的精确 peer 约束；升级宿主时需一并核验。peer 是兼容要求，是否拒绝缺失或不匹配仍取决于安装器/宿主校验，不能把声明本身当作运行时保护。
- 本地开发与 CI 在 `devDependencies` 中精确固定同版公共库及所需 SDK 声明。`autoInstallPeers: false` 保留，防止缺少 peer 时包管理器自行选择版本；这两项 peer 不标 optional，因为缺失时插件不能运行。Client 的 React 与其他服务由宿主模块表/注入提供，不新增运行时包副本。
- 安装后既要检查 application，也要以 Config schema 和真实调用确认后台换代；Web 页面刷新载入新 Client。若安装元数据已更新而 Host 仍驻留旧模块，需要先取得明确的人类重启确认，不能把 AFK 自动回复当同意，也不能只凭 applied 宣称功能生效。
- 新 Client 在作用范围配置不可用时默认禁用修改；只有只读 `/afk` 返回完整旧版状态且没有 scope 字段，才兼容保留旧后台会话开关。证明绑定 Settings snapshot 与连接代次，写入前还会重查；新 Host 的 scope 返回或连接重置会撤销旧证明。全局配置仍需真正加载新后台后才能使用。
- 图标为本包原创 SVG，按 MIT 分发。中英文插件管理器标题与说明包含在 `locale` 导出中。

## 检查

```bash
pnpm install --frozen-lockfile --ignore-scripts
pnpm run check
pnpm run typecheck
pnpm test

# 用锁文件中固定版本的真实 DSH SDK 运行全部集成测试（不启动 DSH 或访问用户 profile）。
DSH_TEST_RUNTIME_DIR="$PWD" pnpm test

# 可选：使用明确指定的现有 DSH 安装，运行隔离的真实 Cordis/Session/Tool/Commands 集成测试。
# 不启动服务器，不调用模型，不读取/修改真实 profile 的会话或设置。
DSH_TEST_RUNTIME_DIR=/absolute/path/to/@deepseek-ai/dsh pnpm test

# 可额外指定已打包解开的 package 目录，验证最终分发文件的 Host 边界。
DSH_TEST_RUNTIME_DIR=/absolute/path/to/@deepseek-ai/dsh \
DSH_TEST_PLUGIN_DIR=/absolute/path/to/unpacked/package pnpm test
```

未提供 `DSH_TEST_RUNTIME_DIR` 时，真实运行时集成测试明确标记 skipped，不将单元测试冒充运行时验证。

### JSDoc 与类型检查

源码保持 JavaScript，无编译产物。`tsconfig.json` 对 Host、Client 和测试开启 `allowJs`、`checkJs`、`strict`、`noImplicitAny` 与 `noEmit`。共享业务模型放在 `types/afk.d.ts`，Host/Client 的宿主边界与模块加载契约由相应声明文件描述；组件 props 与函数参数用靠近实现的 JSDoc 标注。框架类型优先引用固定版本 DSH 的官方声明，不为类型添加跨插件运行时导入。

TypeScript、Node/React 声明及 DSH SDK 只作为开发依赖；两项公共运行时库由必需 peer 声明，开发版本精确固定，插件没有普通生产依赖。由于已发布 SDK 的声明图本身不完整，`skipLibCheck` 仅避免逐行诊断声明文件内部；项目的 JavaScript 仍按严格模式完整检查。投影 SDK 的 Zod 声明通过定向 override 与本项目4.6.7对齐，避免相同 Zod 4 API 的 minor 类型身份冲突。

### GitHub Actions CI

每次 push、pull request 和手动触发都会在 Node.js 22 / 24 上运行冻结锁安装（禁用依赖脚本）、语法、JSDoc 类型检查、真实 SDK 集成测试和打包后集成测试。CI 使用锁定的开发 SDK 作为运行时锚点，不依赖机器上的全局 DSH，也不需要登录态、模型密钥或用户 profile；额外复制不含开发依赖及 node_modules 的生产插件，用真实宿主解析器验证普通安装与外部目录 link 都共享宿主 peer。只要出现 skipped 检查就失败。第三方 Actions 固定到完整 commit SHA，工作流仅授予 `contents: read`，不会发布 npm 包或部署插件。
