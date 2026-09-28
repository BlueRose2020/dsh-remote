# 内部实现与开发

给要改这个插件的人：卡片是怎么画出来的、Agent 能用哪些工具、测试怎么跑，
以及哪些坑已经踩过了。

## 卡片是怎么实现的

浏览器半是**手写**的 `lib/client.js`，没有构建步骤：

```js
window.__ModuleLoader__.load({ id: 'dsh-plugin-remote', factory: (require) => { … } })
```

宿主把每个插件包的 `dsh.client` 声明（在 `package.json` 里，`platform: 'web'`）变成一个
`/plugins/??…` 的 combo bundle，所以这个文件会被**原样**提供出去 —— 只要能通过
`require('react')`（react 在平台种子表里）就不需要打包器。卡片通过
`ctx.settingsScope.bind({ namespace })` 读同一份设置，用 `ctx.slots.inject('settings.plugin.item', …)`
注册进 `key = 命名空间` 的 keyed slot；头像 chip 注册在会话标题栏的
`conversation.session.header.utilities`（`order: 1000`，所以排在「本地打开」和别的插件右边）。
配置页不占新槽位：它是 chip 自己渲染的一层 fixed 覆盖层，这样模式的表单不用去改 Host 的设置
schema。会话树的数据直接用槽位给的 `useSessions` / `useWorkspaces` 标准 props，**不跟宿主来回
RPC**；"点一行切目标"就是往设置里写 `pinSessionId`，和聊天里的 `#use` 写同一个字段。
`tools/client-half-check.mjs` 用假的 loader + 假 react（按组件分格子的 hook 模型）把这条路径
离线测了一遍（注册、slot key、开关写入、面板、配置页、会话树点选、模式表单、命名空间不可用时
渲染空）。
**不许跨插件 import 组件**（客户端的 purity gate），所以卡片没复用
`PluginCard` 的样式，ui 上是自己画的；要更像原生就再引 `@deepseek-ai/dsh-client-ui-primitives`。

## 工具（Agent 可调）

| 工具 | 用途 |
|---|---|
| `remote_notify` | 主动给用户发消息（报错、卡住、长任务完成） |
| `remote_screenshot` | 截屏发给用户，可只截某个窗口 |
| `remote_status` | 查看各通道连接状态与目标会话 |

## 开发

```bash
npm install                        # 唯一一个开发依赖：ws（下面几个 Node 工具用它起 mock 服务器）
node --check lib/index.js
node tools/onebot-e2e.mjs         # OneBot 全链路，对着 mock 服务器跑，不需要 NapCat
node tools/card-check.mjs         # 卡片渲染：Markdown 子集、头像头栏、缺头像/空文本的降级
node tools/ratelimit-check.mjs    # 限流：超限丢弃并提示一次
node tools/bridge-reconnect-check.mjs  # 杀掉 bridge 子进程，验证插件自愈
node tools/smoke.mjs              # 微信通道冒烟（默认不发真消息，要发加 --send）
node tools/client-half-check.mjs  # 浏览器半：卡片注册、slot key、开关写入（不需要浏览器）
python tools/path_check.py        # 卡片里的路径：省略规则、run 切分、只在分隔符处换行
node tools/ui-preview.mjs --out "$DSH_HOME/logs"   # 把真实组件渲染成图（双主题），不用重启
python tools/passivity_check.py --cycles 4   # 后台读屏不碰桌面（在 poll 前后各测一次焦点/光标）
node tools/inbound-check.mjs      # 独立进程验证入站：真发一条微信，看会不会转成会话 prompt
python tools/passivity_check.py --close-chat-first   # 证明轮询不碰电脑（不开窗、不动焦点和鼠标）
python tools/image_clipboard_check.py  # 验证发图用的剪贴板 CF_DIB 往返（不发任何消息）
python tools/bridge_orphan_check.py    # 验证父进程死后 bridge 会自己退出（重启不泄漏进程）
python tools/live-check.py         # 探测「正在运行的实例」是哪个版本（旧版本会明确报出来）
python tools/drive.py '[{"id":1,"cmd":"status"}]'   # 直接戳 bridge
dsh --profile web --dump-config   # 看插件行在 profile 里组合成了什么
```

`tools/onebot-e2e.mjs` 覆盖 209 项：连接、动作回执、单好友自动发现、白名单拦截陌生人、
`#status/#help/#sessions/#tree/#reply/#use/#ws/#ws new/#new/#clear/#shot/#stop/#again/#auth/#lock`、派活转发、
**按名字选工作区与会话（`#ws 秋招`、`#use beta`，以及"不像路径的名字"必须被拒绝而不是建成目录）**、
轮次汇报（含 **`#img on` 时汇报与通知都以图片送达**）、**截图的屏幕选择**、
**多会话手感（`#sessions` 按最近活动排序并带相对时间、`#reply <话>` 发给最后发言的会话且**不改目标**、
裸 `#reply` 切过去、提问卡住时指令照样能用、提问结束后仍能正常作答）**、
**可视化树（最近活跃的编号列表 + 分叉树 + 工作区树都画出来、分叉嵌在父会话下、
标出当前目标与活跃时间、且只用等宽字体里确定有的字符）**、
**聊天回答提问（编号选择 / 越界编号当自定义 / 自由文本 / 不带 `#` 的裸回答 / `#stop` 仍能打断 / `#>` `#<` `#q2` 切题 / `#submit` 跳题交卷 /
桌面端先答也算 / 取消时按 aborted 结算）**、**管理员密码只用在完全权限上（`accessGate: off` 免密、`all` 才门控全部指令）**、
**工作模式（`#mode list` 列出并标记当前、切换、受限模式拒绝表外命令但放行自然语言、`#mode default` 回全功能、未知模式报错、
模式自己的表单存进 `modeData`、`prompt` 按表单值渲染后注入系统提示词、切走就清空）**、
**设置命名空间（模式按钮的清单、页面写 `pinSessionId` 能移动聊天里的目标、聊天改目标会镜像回去）**、
**投递方式 `#deliver queue|steer`（含 steer 被拒时自动退回排队）**、
**汇报范围（只汇报远程派活 / 目标会话每一轮都汇报）**、**来源标签（工作区 - 会话名）**、进度兜底、系统提示词注入、本地轮次不汇报、非目标会话不汇报、
状态持久化、**已关闭会话的恢复与派活**、**工作区新建**、权限预设与 `r/w/f` 简写（含密码门）、
前缀过滤、群白名单、工具注册与调用、附件收集，外加一条静态检查：
**分发器里出现的每个指令别名都必须在 `COMMAND_WORDS` 里**（授权门靠它区分"指令"和"密码"）。

> 夹具里有一个**真的（很小的）设置服务**，所以上面那两条"设置命名空间"的用例是真的走了
> `register` → `get` → `watch` → `update` 全程。它抓到了一个只有真跑才看得见的 bug：
> 注册回调在 `apply()` 期间就调用 `modeList()`，而它依赖的 `const` 声明在文件更下面 ——
> 时序死区抛错、被 try 吞掉，整个设置命名空间静默消失（卡片没了、面板也读不到东西）。

`tools/card-check.mjs` 覆盖 22 项：自带头像存在且是正方形 PNG、纯文本卡片仍然成立、
Markdown 子集（标题变大、代码围栏画成面板）、长文本换行不变宽、头像头栏更高但不更宽、
**TAB / `│` 分隔的表格行（含单行表、两格行、与普通段落混排）**、
头像文件缺失/空文本时的降级、CLI 的 `WxH` 契约。

`tools/path_check.py` 覆盖 14 项：路径省略（保留盘符与最后两段、超长单段、POSIX、`0` 关闭）、
路径 run 的切分（`#命令` 不受影响、`https://` 不误判）、以及"只在分隔符处换行"的原子性。

`tools/client-half-check.mjs` 覆盖 72 项：浏览器半（`lib/client.js`）在假 loader + 假 react 下
离线渲染一遍（hook 单元格按组件分开，`children` 也照 React 的约定放进 `props.children`，
否则"组件其实什么都没渲染"也会通过）—— 设置卡片与**标题栏头像 chip** 的 slot 注册与排序、
开关写入、模式按钮写 `mode`、面板、**配置页**（通用页写昵称/密码/投递方式、会话树点选写
`pinSessionId`、取消锁定、模式表单写 `modeData`、模式页说明文字）、命名空间不可用时两边都渲染空，
外加**裁剪坐标换算**（居中/放大/拖动/越界夹紧/竖图）、`relativeTime` 的逐值断言，以及
**树与折叠**（层级用"祖先分隔线"而不是字符画、哪些行有可用箭头、折起来子树消失且只影响那一棵树、
`+n` 计数、藏了当前目标时那一行补 `← 当前`、**再点一下就展开**、**点缩进 gutter 也能折且不会误切目标**、
工作区整行可点、全部折叠/展开、折叠不动目标、**折叠状态跨标签存活**）。

`tools/ui-preview.mjs` 覆盖 17 项，并且是**看图**用的：它不需要 DSH、不需要 React、不联网 ——
用一个 80 行的迷你渲染器把这个插件**真实的组件**（同一个 bundle，`require('react')` 换成
迷你实现）渲染成 HTML，再套上 `ensureStyles()` **真正注入的那段 CSS**（用假 `document` 截获），
最后交给系统自带的 Chrome/Edge `--headless --screenshot` 出图：

```bash
node tools/ui-preview.mjs --out "$DSH_HOME/logs"
# → ui-preview-light.png / ui-preview-dark.png：头像面板、配置页三个标签、折叠后的树、头像裁剪，双主题并排
```

> 为什么值得有：客户端的改动本来只有"重启 + 刷新 + 人眼"这一条验证路径，而重启是操作者的决定
> （见下面「改代码之后必须重启」）。静态预览把"界面长什么样"变成**重启之前**就能看的图，也顺手抓住了两个只有真渲染
> 才会暴露的问题 —— 迷你渲染器的 `createElement` 一开始没把 children 放进 `props.children`，
> 于是共享的 `Field` 包装器渲染成空；以及 hook 单元格不按组件分格子时，三个标签会拍成同一张图。

> 测试夹具一律使用**真实的 DSH 数据结构**（例如 `SessionEvent` 是
> `{ type, seq, time, data }`，负载在 `data` 里）。第 6 轮就是因为夹具编成了错误的
> 内联形状，把一个"汇报永不触发"的 bug 藏了整整几轮 —— 夹具的保真度和断言本身一样重要。

## 改代码之后必须重启

DSH 会热加载 **profile 补丁**，所以改 `cordis.patch.yml` 的配置立刻生效；
但 **Node 的 ESM 模块按 URL 缓存**，`lib/*.js` 改动后运行中的实例不会重新读文件，
只重启「实例」不重载「模块」。所以：

| 改了什么 | 需要做什么 |
|---|---|
| `cordis.patch.yml` 里的配置 | 保存即生效 |
| `lib/*.js`、`bridge/*.py` | 重启一次 `dsh web` |

重启助手（会顺带确认新服务能应答）：

```bash
python tools/restart-dsh.py --dry-run   # 先看它会停掉哪个进程、从哪个目录重启
python tools/restart-dsh.py             # 停掉端口上的 dsh web 并重新拉起
python tools/restart-dsh.py --log $DSH_HOME/logs/dsh-web.log   # 顺便留下新实例的启动输出
```

> `--log` 值得加：`dsh web` 启动时会打印**带鉴权 token 的 URL**，那是没有已登录浏览器时唯一能
> 打开或探测界面的入口（平时它进了 DEVNULL，重启后就找不回来了）。日志里那行 URL 可以直接
> `Start-Process` 打开，或用来 `Invoke-WebRequest` 验证 combo bundle 是不是新代码。

从 DSH 内部（也就是我自己在跑的那个进程里）重启时，用这个包装脚本：

```powershell
powershell -File tools/restart-and-verify.ps1                # 什么也不做，只说明它想干什么（退出码 2）
powershell -File tools/restart-and-verify.ps1 -Force          # 12 秒后重启，然后自动验证
powershell -File tools/restart-and-verify.ps1 -Force -DelaySeconds 0   # 立刻
```

> **必须显式给 `-Force`**：重启会把所有活着的会话（包括发起它的这一轮）连同正在跑的工具调用
> 一起丢掉，所以它不是"改完代码的自然收尾"，而是操作者的一个决定。默认行为是**打印它会做什么
> 然后退出 2**，避免哪天顺手又重启一次。

它做三件事：**延迟**（让当前这一轮先把话说完，因为重启会杀掉发起它的进程）、
`restart-dsh.py --log`（留下新实例的启动输出）、
`verify-live.py`（把"新进程到底在跑哪一版"变成 PASS/FAIL 写进日志）。两个日志都在
`$DSH_HOME/logs/` 下；**服务器日志里有带 token 的 URL，当凭据看待**。

`python tools/verify-live.py --log $DSH_HOME/logs/dsh-web.log` 单独跑也可以。它验证的是：

- 页面能打开，而且是真壳（有 `__DSH_BOOT__`）；
- 这个插件的 combo bundle 真的被提供出去了，且里面含有当轮新增的标记（头像 chip、配置页、
  会话树、`pinSessionId` 写入路径、模式表单）；
- **宿主半**：`lib/index.js` 启动时会打印自己内容的 sha1 前 10 位（`build=xxxxxxxxxx`），
  脚本对磁盘上的文件算同一个哈希再去日志里找 —— 值相同才说明**运行中的进程读的是当前这一版**
  （这是从外部唯一诚实可靠的判断方式：ESM 按 URL 缓存，光看文件改了没有没有意义）。

想先排练一遍而不动正在用的服务：在另一个端口起个一次性的实例，然后

```bash
dsh web --port 3099 --no-open          # 一次性实例
python tools/restart-dsh.py --port 3099   # 只对 3099 做 kill + 重启 + 验证
```

助手本身已经用这种方式排练验证过：杀掉 → 从记录目录重新拉起 → 确认应答（鉴权拒绝也算
「服务已起」，不会误报失败）→ 退出码 0。

> **助手为什么默认不杀进程树。** `taskkill /T` 会连带整棵树。如果这个脚本是从 DSH 内部
> 启动的（工具调用、内嵌终端），那脚本自己就在那棵树里 —— 树杀会在重新拉起服务器之前
> 先把自己杀掉，留下一个彻底没有服务的机器。所以默认只杀监听端口那一个进程；
> 服务器的子进程会自己退出（bridge 的契约就是「读到 stdin EOF 就结束」，
> 用 `python tools/bridge_orphan_check.py` 验证过）。
> 想要老的树杀行为加 `--tree`；脚本检测到自己就在树里时会自动退回单进程杀并打印提示。

> **重启必须从原来的目录启动。** DSH 用 `process.cwd()` 作为 sandbox 的 workspaceRoot，
> 也用它决定 GUI 按哪个工作区分组会话 —— 从别的目录重启，你的会话列表会看起来是空的。
> 插件会把启动目录记进状态文件（`serverCwd`），助手读它来重启；
> **读不到就直接拒绝重启**（退出码 3），除非你显式给 `--cwd <目录>` 或 `--force-cwd`。

> 重启会中断正在跑的那一轮对话。重启后没有任何会话存活，
> 手机发来的指令靠「最后一次派活的会话」恢复（见
> [configuration.md](configuration.md#目标会话是怎么定的) 第 4 条）。

## 已知限制

- `wechat-local` 靠 OCR：代码、长英文、符号容易认错，**中文短指令最稳**；只能读到窗口里可见的消息
- `wechat-local` 发送（文字和图片）时会短暂抢焦点 —— 剪贴板粘贴的硬限制；**读取不抢**。
  所以它只适合在你离开电脑时启用，日常用 QQ
- 轮询间隔默认 5 秒，不是实时
- `onebot` 的目标账号必须是机器人登录的那个 QQ 的好友；群消息需显式加入 `groupAllowFrom`
- 微信回复偶尔会投递失败（窗口状态问题）。现在不会再静默：会打 warning，并写进 `debugLog`
- 你**正在用的那个实例**还跑着早先的模块（Node 的 ESM 缓存），重启后才是完整版；
  用 `python tools/live-check.py` 确认

## 验证到什么程度

真实 DSH 服务上的完整链路已经验证过（用一个独立实例 + `--patch` 覆盖层在另一个端口跑，
不影响你在用的会话）：真实工作区列表、真实建会话、把指令派给一个**已关闭的会话**并让它恢复执行、
真实 Agent 跑完一轮（会话日志 340 B → 15 KB）、回答按真实 `SessionEvent` 结构读出来并推回微信。
验证完已把环境完全还原（会话、补丁、状态文件、临时文件）。
