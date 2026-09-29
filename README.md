<p align="center"><img src="横幅.png" width="100%" alt="用 QQ 或微信远程指挥 DeepSeek Harness"></p>

# dsh-remote — 远程通道

用手机上的聊天软件远程指挥 DeepSeek Harness：**选工作区 → 派活 → 收汇报（含截图）**。

这是一个 **DSH 插件**：它挂在 DSH 的服务和事件上（会话、工作区、Agent 生命周期、工具注册），
命令、权限、状态都由它管；"消息怎么进出"交给可插拔的**传输层**。

```
┌────────────────┐  用户消息   ┌──────────────────────────────┐
│  传输层         │ ─────────► │  DSH                         │
│  onebot（QQ）   │            │  sessionController / agents   │
│  wechat-local   │ ◄───────── │  workspaceRegistry           │
└────────────────┘  汇报/截图   └──────────────────────────────┘
```

| 想知道什么 | 看哪 |
|---|---|
| 怎么装，QQ / 微信 怎么接上 | [`docs/install.md`](docs/install.md) |
| 每条指令、卡片、问答、分叉的完整说明 | [`docs/usage.md`](docs/usage.md) |
| 全部配置项和默认值 | [`docs/configuration.md`](docs/configuration.md) |
| 改代码、跑测试、已知限制 | [`docs/internals.md`](docs/internals.md) |

## 1. 能做什么

| 能力 | 说明 |
|---|---|
| 远程派活 | 聊天里的消息作为**用户消息**进入选定的会话 |
| 自动汇报 | 每轮结束把回答推回手机，开头是 `工作区 - 会话名` |
| 会话管理 | 列出、切换、新建、恢复、分叉、停止 |
| 工作区管理 | 选定或新建工作区，修「未分组」的会话 |
| 截图与附件 | `#shot` 截桌面（可选窗口），QQ 通道能收附件 |
| 远程答问 | 在手机上回 Agent 的选择题或自由文本提问 |
| 可视化会话树 | 工作区、分叉、子代理一屏看完，直接切目标 |
| 工作模式 | 一套命令 + 投递方式 + 系统提示词，`#mode` 切换 |
| Agent 主动通知 | `remote_notify` 工具，报进度或异常 |
| 双通道 | QQ 与微信可同时开，通知广播到所有就绪通道 |

## 2. 手机上怎么用

命令不用背：发 `#help`，插件当场渲染一张卡片发给你。

<p align="center"><img src="docs/help-card.png" width="430" alt="在聊天里发 #help 得到的卡片"></p>

三条规矩：

- **普通文本直接进当前会话**，不用加前缀：`帮我检查项目测试，完成后截图`
- **`#` 只用于管理命令**（`#status` / `#use` / `#stop` / `#img` …）。所以正常说话不会
  因为写了 "status" 就被当成命令；老写法 `#任务内容` 仍然兼容
- **Agent 反过来问你时，你发的消息就是答案**：带不带 `#` 都算，`1` 和 `#1` 都是选第 1 项，
  `#submit` 提前交卷

## 3. 安装

**方式一：插件市场**——装好 [dsh-market](https://github.com/dsh-market/dsh-market) 后，
**设置 → 插件市场** 搜 `dsh-remote`，一键安装。

**方式二：官方命令**（市场里还没有时用这个）

```bash
dsh plugin --profile web add github:BlueRose2020/dsh-remote
```

命令会识别包里的 `dsh.bundle`：依赖装进 profile，`dsh-remote` 也自动加进
`$DSH_HOME/profiles/web/package.json` 的 `dsh.profile.bundles`。

**方式三：手动放源码**（要改代码时用）——仓库放到 `$DSH_HOME/profiles/plugins/dsh-remote`，
把 [`cordis.patch.yml`](cordis.patch.yml) 的 `insert` 合并进 `$DSH_HOME/profiles/web/cordis.patch.yml`，
并把 `name:` 换成入口文件路径 `../plugins/dsh-remote/lib/index.js`。

Python 依赖三种方式都要：

```bash
pip install -r requirements.txt
```

最后重启一次 DSH（新装的 bundle 属于启动时组合的层；市场会给出重启提示），
打开 **设置 → 插件 → 远程通道** 启用通道。NapCat / OneBot / 微信 bridge 的完整配置见
[`docs/install.md`](docs/install.md)。

## 4. 传输层

| | `onebot`（QQ） | `wechat-local`（微信） |
|---|---|---|
| 原理 | OneBot 11 协议，本地 WebSocket | 截图 OCR 读 + 剪贴板粘贴写 |
| 准确性 | 高（协议级，文字精确） | 中（OCR 有误差，长文本/代码易错） |
| 桌面干扰 | 无 | 读取不干扰（`wechat.passive` 默认开）；**发送会短暂占用键鼠** |
| 建议 | **首选** | 备用，只在你离开电脑时开 |

两个通道可同时开：通知广播到所有就绪通道，回复走消息来源的那个通道。

## 5. 安全默认值

这个插件能间接让 DSH 在你机器上执行操作，所以默认值偏保守：

- **群消息默认全部忽略**，必须显式加进 `groupAllowFrom`
- **QQ 私聊有一个推导出来的白名单**（空 ≠ 任何人）：配了 `privateAllowFrom` / `ownerId` 就用它，
  否则只有一个好友就用那个好友，都没有就放开但每次告警
- **限流** `maxCommandsPerMinute`（默认 20），超了丢弃并提示一次
- **管理员密码只用在需要权限的地方**（提升到完全权限、开指令门），普通指令不需要
- **微信发送前会 OCR 确认当前窗口是文件传输助手**，否则拒发
- **`wechat.passive`（默认开）**：轮询只读屏幕上已有的内容，不切窗口、不动鼠标

`#status` 会告诉你当前谁能发指令、当前权限是什么。

## 6. 常用配置

写在挂载项的 `config:` 下；网页面板里的值优先。

| 配置项 | 默认 | 说明 |
|---|---|---|
| `transports` | `[wechat-local]` | `onebot` / `wechat-local`，可同时开 |
| `commandPrefix` | `#` | 管理命令前缀；普通文本不需要前缀 |
| `onebot.ownerId` | 空 | 通知目标；留空则用「只有一个好友」自动发现 |
| `reportOnlyRemoteTurns` | `true` | 只汇报远程触发的轮次，网页端自己的对话不推手机 |
| `reportWithScreenshot` | `false` | 每条汇报附带桌面截图（要图用 `#shot`） |
| `screenshotMonitor` | `primary` | 截哪块屏：`primary` / `all` / 序号 |
| `imageReplies` | `true` | 信息类回复出图；`#img on/off` 在聊天里改 |
| `avatar` | 空 | 卡片头像；`-` 表示不画头像 |
| `accessGate` | `off` | `all` 表示所有指令都要先授权 |
| `debugLog` | 空 | 追加式 JSONL 追踪，排查"命令被吞了"时开 |

其余字段、工作模式、通道参数见 [`docs/configuration.md`](docs/configuration.md)。

## 7. 开发

```bash
npm install                      # 只为测试装 ws（运行期它由 DSH 提供）
npm test                         # 语法检查 + 卡片 + 浏览器半 + 限流 + 端到端
node tools/ui-preview.mjs        # 出双主题 UI 预览图，不用重启
python tools/path_check.py       # 卡片里的路径换行 / 省略规则
```

改 `lib/*.js` 或 `bridge/*.py` 后要重启 DSH 才生效（配置是热加载的）。
实现细节、测试范围、重启规则和已知限制见 [`docs/internals.md`](docs/internals.md)；
上架插件市场的收录条目在 [`docs/market-entry.yml`](docs/market-entry.yml)。

## 8. 许可

[MIT](LICENSE) © BlueRose2020
