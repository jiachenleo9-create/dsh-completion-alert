# dsh-completion-alert · DSH 任务完成提醒

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）用的小插件：**任务跑完时，如果你没在看 DSH 窗口，它会"叮"一声，并在屏幕右下角弹出一张置顶小卡片；点一下卡片，DSH 主界面就回到最前，并自动切到刚完成的那次会话。**

![右下角置顶卡片](docs/card-preview.png)

> 仓库地址（复制这一行即可安装）：`https://github.com/jiachenleo9-create/dsh-completion-alert`
>
> **平台：仅 Windows**（macOS 会在下文说明：能装上，但不会有提醒）。许可：MIT。无需编译，无需联网（提示音是插件自己合成的）。

---

## 它到底解决什么问题

DSH 跑长任务时，你通常会切去干别的事。任务结束时你既听不到、也看不到——这个插件补上这一环：

| 什么时候提醒 | 提醒长什么样 |
| --- | --- |
| 任务完成 | 「叮」+ 绿条卡片：`任务已完成` + 会话标题 |
| 出错 / 被阻断 / 达到输出上限 | 红条或琥珀条卡片，文案不同 |
| **有工具在等你批准** | 蓝条卡片：`需要你审批` + **是哪个工具、要执行什么**（例如命令原文） |
| **Agent 提问后卡住** | 紫条卡片：`需要你回答` + 问题原文 |

而且：**你正在看 DSH 窗口时它完全不打扰你**（浏览器端持续上报窗口焦点，前台时静默）。

---

## 安装

三种方式，任选一种。**方式一最简单**。

### 方式一：在 DSH 里粘贴链接（推荐）

1. 打开 DeepSeek Harness；
2. 左侧点「**插件**」；
3. 右上角点「**添加插件**」；
4. 把下面这一行原样粘进去，安装：

   ```
   https://github.com/jiachenleo9-create/dsh-completion-alert
   ```

5. 安装完成后**重启一次 DeepSeek Harness**；
6. 想确认成功：浏览器打开 `http://127.0.0.1:19387/completion-alert/ping`，看到 `{"ok":true,...}` 就对了。

### 方式二：下载 ZIP + 双击脚本（不会命令行也能用）

1. 打开仓库页面，点绿色 **Code** 按钮 → **Download ZIP**；
2. 解压到一个你不会删的文件夹（比如 `D:\dsh-completion-alert`）；
3. 在该文件夹里按住 `Shift` + 右键 → 「**在此处打开 PowerShell 窗口**」，粘贴回车：

   ```powershell
   powershell -ExecutionPolicy Bypass -File .\install.ps1
   ```

4. 看到 `Installed.` 后**重启 DeepSeek Harness**。

脚本做的事：把插件放进 DSH 的 profile（`plugins\` + `node_modules\` 链接），并登记进插件清单——所以它也会出现在「插件」页的「**已安装**」分组里，可以随时开关。

### 方式三：命令行

```powershell
git clone https://github.com/jiachenleo9-create/dsh-completion-alert.git
cd dsh-completion-alert
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

> 卸载：`install.ps1 -Uninstall`，或在「插件」页里直接移除。

---

## 装上之后是什么样

- 任务完成 → 右下角弹卡片（**9 秒**后自动消失，点 ✕ 可立刻关掉）；
- 审批 / 提问 → 卡片停留 **20 秒**（人可能不在机器前）；
- 卡片**不会抢走你的输入焦点**（正在打字也不会被打断）；
- **点卡片** → DSH 窗口被唤出（即使之前被关进托盘/最小化），并自动切到那次会话；
- DSH 正在前台时 → 不响、不弹。

状态色条：完成=绿、审批=蓝、提问=紫、出错/阻断=红、其它=琥珀。

---

## 配置（可选）

在 DSH profile 目录的 `cordis.patch.yml` 里按 id 覆盖；改完刷新页面或重启应用：

```yaml
- id: completion-alert
  name: 'dsh-completion-alert'
  config:
    enabled: true            # 总开关
    onlyWhenUnfocused: true  # 只在主界面不在最前时提醒（核心行为）
    sound: true              # 播放"叮"
    popup: true              # 弹出右下角卡片
    popupSeconds: 9          # 完成卡片自动关闭秒数（3–120）
    corner: br               # 位置：br 右下 / bl 左下 / tr 右上 / tl 左上
    notifyOnAbort: false     # 用户手动停止的任务是否也提醒
    approvalAlerts: true     # 有工具等待批准时提醒（卡片写明审批内容）
    approvalSeconds: 20      # 审批卡片存活秒数
    questionAlerts: true     # Agent 提问并卡住时提醒
    questionSeconds: 20      # 提问卡片存活秒数
    minGapMs: 5000           # 两张卡片之间的最小间隔
    debounceMs: 1200         # Agent 停止后的稳定等待，避免误报
```

只想要声音、不要卡片：`popup: false, sound: true`。不想被审批打断：`approvalAlerts: false`。

---

## 出问题了怎么办

| 现象 | 处理 |
| --- | --- |
| 完全没反应 | 打开 `http://127.0.0.1:19387/completion-alert/ping`。没有 `ok` 说明宿主端没装载：确认已重启 DSH，且插件出现在「插件」页 |
| `ping` 里 `hasClientReport: false` | 浏览器端没起来：刷新 DSH 页面 |
| 想立刻看效果 | `curl http://127.0.0.1:19387/completion-alert/test`（无视前台状态直接弹一张）；`?kind=approval` / `?kind=question` 预览另外两种样式 |
| 点了卡片窗口没出来 | 需要包含「隐藏窗口唤出」的版本：更新到最新代码（`install.ps1` 重跑一次）并重启 DSH |
| 想看日志 | 卡片会把过程写到 `%TEMP%\dsh-completion-alert\card.log`，关键行是 `reveal ... visible=... raised=...` |

---

## 已知限制

### macOS / Linux 用户请注意

**这个插件目前只在 Windows 上会提醒。** 在 macOS（以及 Linux）上：

- 插件**可以正常安装、正常加载**，DSH 不会报错，`http://127.0.0.1:19387/completion-alert/ping` 也会返回 `ok`；
- 但到"弹卡片 + 响铃"这一步时会安静地跳过（宿主端日志里会写 `implemented for Windows only; skipping`），**你收不到任何提醒**。

原因是提醒的最后一层用了 Windows 原生能力：置顶卡片是 PowerShell + WinForms 窗口，窗口唤出用 Win32 API。核心逻辑（任务完成/审批/提问的判定、焦点门控、安装与加载）本身是跨平台的。

移植到 macOS 的工作量不大——只需重写"弹窗 + 发声"这一层（用一个等价的 JXA/Cocoa 脚本替换 `assets/notify.ps1`，宿主端加一个平台分支，约 300 行），其余代码原样复用。只是我手上没有 Mac，无法实测，所以暂未提供。有 Mac 环境的欢迎提 PR。

### 其它

- 卡片出现约有 1–2 秒延迟（PowerShell 进程启动 + C# 辅助类编译）。
- 点击后的会话定位依赖 DSH 页面存活；页面已关闭时只保留"唤起窗口"。
- 宿主端（`lib/index.js`）改动需要重启 DSH；浏览器端（`lib/client.js`）刷新页面即可。
- 不占用系统通知通道，因此不受 Windows「专注助手 / 通知设置」影响。

---

## 给开发者

无构建步骤：`lib/index.js`（宿主端）与 `lib/client.js`（浏览器端）都是手写 ESM，客户端半使用 DSH 的 `window.__ModuleLoader__.load({ id, factory })` 懒加载 CJS 约定。

```
dsh-completion-alert/
├─ package.json        # dsh.bundle + dsh.client 声明
├─ cordis.patch.yml    # bundle 层：插入 completion-alert 这一行
├─ lib/index.js        # 宿主端：agent/status、approval/asked、user-questions/request、
│                      #          焦点状态、HTTP 路由、调度卡片
├─ lib/client.js       # 浏览器端：上报焦点、轮询"认领"、切会话
├─ assets/notify.ps1   # 右下角置顶卡片（WinForms + Win32 唤出/置顶）
├─ docs/               # 截图
├─ install.ps1         # 安装 / 卸载
├─ LICENSE             # MIT
└─ README.md
```

用到的 DSH 接口（均来自官方包，未打补丁）：

- 宿主：`ctx.on('agent/status')`、`ctx.on('session/event')` 的 `approval/asked`、`ctx.waterfall('user-questions/request')` 观察者、`ctx.webServer.register()`；
- 浏览器：`ctx.remote.$on('api-session/status')`、`ctx.get('uiWorkspace').openSession()`、`document.hasFocus()` / `visibilityState`；
- 会话事件：`turn/end`（原因分类）、`session/title`、`tool/call`（审批内容摘要）。

## 参考与致谢

做之前先扫了一遍 DSH 插件生态，以下几点思路来自这些 MIT 项目的公开实现（代码为本仓库重写，未复制 GPL 项目）：

- [dsh-thinking-notifier](https://github.com/6-debug-6/dsh-thinking-notifier)——用 PowerShell 做真正的置顶无边框角标窗口；
- [Favio8/dsh-plugins](https://github.com/Favio8/dsh-plugins)——宿主端 `agent/status` 判定任务结束 + 合成提示音 + 右下角卡片；
- [Mvyvn/dsh-desktop-notify](https://github.com/Mvyvn/dsh-desktop-notify)（GPL-3.0，仅参考设计）——"焦点时静音"的做法；
- [TelosmaYLX/dsh-session-notify](https://github.com/TelosmaYLX/dsh-session-notify)——`turn/end` 原因分类与失焦/聚焦分流。

## 许可

MIT，见 [LICENSE](LICENSE)。
