<div align="center">
  <img src="assets/avatars/default.png" width="104" alt="dsh-remote logo">
  <h1>dsh-remote</h1>
  <p><strong>用 QQ 或微信，在手机上远程指挥 DeepSeek Harness。</strong></p>
  <p>选择工作区、派发任务、回答提问，并接收执行结果与桌面截图。</p>

  <p>
    <a href="LICENSE"><img alt="License" src="https://img.shields.io/github/license/BlueRose2020/dsh-remote?style=flat-square"></a>
    <img alt="Version" src="https://img.shields.io/badge/version-0.1.0-2563eb?style=flat-square">
    <img alt="Platform" src="https://img.shields.io/badge/platform-DeepSeek%20Harness-111827?style=flat-square">
    <img alt="Channels" src="https://img.shields.io/badge/channels-QQ%20%7C%20WeChat-16a34a?style=flat-square">
  </p>

  <p>
    <a href="#2-使用">使用</a> ·
    <a href="#3-安装">安装</a> ·
    <a href="docs/usage.md">使用指南</a> ·
    <a href="docs/configuration.md">配置参考</a> ·
    <a href="docs/internals.md">开发文档</a>
  </p>

  <img src="横幅.png" width="100%" alt="通过 QQ 或微信远程指挥 DeepSeek Harness">
</div>

---

## 1. 能力

| 能力 | 说明 |
|---|---|
| 远程派活 | 聊天消息作为用户消息进入选定会话 |
| 自动汇报 | 每轮结束推送回答，标注工作区与会话名 |
| 会话管理 | 列出、切换、新建、恢复、分叉、停止 |
| 工作区管理 | 选定或新建工作区，修复未分组会话 |
| 截图与附件 | 截取桌面或指定窗口；QQ 通道可接收附件 |
| 远程答问 | 在聊天里回答 Agent 的提问 |
| 会话树 | 查看工作区、分叉与子代理，直接切换目标 |
| 工作模式 | 按场景配置命令、投递方式与系统提示词 |
| 主动通知 | Agent 通过 `remote_notify` 上报进度与异常 |
| 双通道 | QQ 与微信可同时启用，通知广播至所有就绪通道 |

## 2. 使用

普通文本直接进入当前会话：

```text
帮我检查项目测试，完成后截图
```

`#` 仅用于管理命令，例如 `#status`、`#use`、`#stop`。原有 `#任务内容` 写法仍然可用。

在聊天里发送 `#help` 得到完整命令卡片：

<p align="center"><img src="docs/help-card.png" width="430" alt="dsh-remote help card"></p>

Agent 提问时，回复编号、`#编号` 或自由文本；`#submit` 提交。

## 3. 安装

1. **插件市场**：安装 [dsh-market](https://github.com/dsh-market/dsh-market)，在 **设置 → 插件市场** 搜索 `dsh-remote`。

2. **官方命令**：

   ```bash
   dsh plugin --profile web add github:BlueRose2020/dsh-remote
   ```

   包内的 `dsh.bundle` 会被识别：依赖装入 profile，包名写入 `dsh.profile.bundles`。

3. **手动放置源码**：仓库放至 `$DSH_HOME/profiles/plugins/dsh-remote`；将
   [`cordis.patch.yml`](cordis.patch.yml) 的 `insert` 合并进
   `$DSH_HOME/profiles/web/cordis.patch.yml`，并把 `name` 改为
   `../plugins/dsh-remote/lib/index.js`。

Python 依赖：

```bash
pip install -r requirements.txt
```

重启 DSH，在 **设置 → 插件 → 远程通道** 启用通道。NapCat 与微信 bridge 的配置见
[`docs/install.md`](docs/install.md)。

## 4. 传输层

| | `onebot` · QQ | `wechat-local` · 微信 |
|---|---|---|
| 原理 | OneBot 11 协议，本地 WebSocket | 截图 OCR 读，剪贴板写 |
| 准确性 | 协议级文本，精确 | 受 OCR 影响，长文本与代码易错 |
| 桌面干扰 | 无 | 读取不干扰；发送时短暂占用键鼠 |
| 建议场景 | 日常使用 | 无法使用 QQ 时 |

两个通道可同时启用：通知广播至所有就绪通道，回复返回消息来源通道。

## 5. 安全默认值

- 群消息默认全部忽略，需显式加入 `groupAllowFrom`
- QQ 私聊白名单依次取 `privateAllowFrom`、`ownerId`、唯一好友；均未配置时放开并告警
- 限流 `maxCommandsPerMinute` 默认每分钟 20 条，超限丢弃并提示一次
- 管理员密码仅用于提升权限与开启指令门
- 微信发送前校验当前窗口为文件传输助手
- `wechat.passive` 默认开启：轮询只读屏幕内容，不切换窗口

`#status` 显示可发指令的账号与当前权限。

## 6. 常用配置

配置写在挂载项的 `config` 下，网页面板中的值优先。

| 配置项 | 默认 | 说明 |
|---|---|---|
| `transports` | `[wechat-local]` | `onebot`、`wechat-local`，可同时启用 |
| `commandPrefix` | `#` | 管理命令前缀；普通文本不使用前缀 |
| `onebot.ownerId` | 空 | 通知目标；留空则采用唯一好友 |
| `reportOnlyRemoteTurns` | `true` | 仅汇报远程触发的轮次 |
| `reportWithScreenshot` | `false` | 每条汇报附带桌面截图 |
| `screenshotMonitor` | `primary` | 截取 `primary`、`all` 或显示器序号 |
| `imageReplies` | `true` | 信息类回复使用图片卡片 |
| `avatar` | 空 | 卡片头像路径；`-` 不显示头像 |
| `accessGate` | `off` | `all` 表示所有指令都需先授权 |
| `debugLog` | 空 | JSONL 追踪日志路径 |

其余字段、工作模式与通道参数见 [`docs/configuration.md`](docs/configuration.md)。

## 7. 开发

```bash
npm install                      # 仅为测试安装 ws；运行期由 DSH 提供
npm test                         # 语法检查、卡片、浏览器端、限流、端到端
node tools/ui-preview.mjs        # 生成双主题 UI 预览图
python tools/path_check.py       # 路径换行与省略规则
```

修改 `lib/*.js` 或 `bridge/*.py` 后需重启 DSH；配置为热加载。
实现细节、测试范围与已知限制见 [`docs/internals.md`](docs/internals.md)，
市场收录条目见 [`docs/market-entry.yml`](docs/market-entry.yml)。

## 8. 许可

[MIT](LICENSE) © BlueRose2020
