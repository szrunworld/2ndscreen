# A4 跟进：命令派生钩子、会话表头分片、简历表头装饰符

## 范围

分支 `szrunworld/ss-a4-live`，在已被接受的 `04b4362` 之上。只改 `packages/task-runtime/src/adapters/second-screen.ts` 与其测试、`agents/boss/src/resumes/**`、`packages/task-runtime/tests/boss-resumes.test.ts` 和本报告。没有修改旧版 `agents/boss/src/chat.ts`、A7 的 actors/bootstrap/registry 或 A6 文件。全部为合成数据，没有接触真实 GUI、BOSS 或 P0 原始路径。没有推送，没有合并用户分支。

| 提交 | 内容 |
|---|---|
| `161f492` | 1. 命令派生钩子（单独提交，已通知 A7 与主线） |
| `8011998` | 2. 会话表头分片姓名；3. 简历表头 `◎` 前缀 |
| 本报告 | 文档 |

## 1. createCommandRunner 派生钩子（`161f492`）

最初我发给 A7 的是更丰富的方案（token、beforeSpawn 等）。协调者批准了 A7 的精简接口（`msg_9cc2f48aaa35` / `msg_5b1d527d6d8c`），我改为按该接口实现，并保留了“返回 promise 视为失败”和钩子失败的安全处理：

```ts
export interface CommandSpawn { pid: number; file: string; spawnedAfterMs: number; spawnedBeforeMs: number }
export function createCommandRunner(options?: { onSpawn?: (s: CommandSpawn) => void; onSettled?: (s: CommandSpawn) => void; now?: () => number }): CommandRunner;
```

- 不传参数时行为与以前完全相同（现有 runner 测试未改）。
- `spawnedAfterMs` / `spawnedBeforeMs` 分别紧贴 `spawn()` 之前和之后取 `now()`（默认 `Date.now`）。
- `onSpawn`：只要子进程有 pid 就同步调用，在 runner 返回 promise 之前完成；子进程是独立进程组的组长（detached），pgid = pid。抛错或返回 thenable 时，立即对整个组发 SIGKILL，并每 20 ms 重发直到子进程关闭（fork 之后、setsid 之前组还不存在，单次 kill 可能落空），然后以 `RuntimeError io` 拒绝，details 为 `{pid, pgid}`。调用方的预先登记保持未解决。
- `onSettled`：子进程 close 之后、resolve/reject 之前调用一次（被钩子失败杀掉的子进程也会调用）。它不代表组已经结束：测试证明后台 `sleep` 在 `onSettled` 时仍在组内。抛错或返回 thenable 时以 io 拒绝；如果已有超时、取消或 onSpawn 失败，以先发生的为准。不会出现未处理的异常。
- 程序没能启动（没有 pid，例如 ENOENT）时不调用任何钩子，仍返回 `capability_missing`。

测试（真实子进程，只用临时目录）：
- 钩子顺序，以及 onSpawn 在 promise 返回前已运行。
- 报告的 pid 就是实际运行的 shell；时间值来自注入的 `now`。
- 无钩子时行为不变。
- 正常退出时组内仍有后代。
- onSpawn 抛错或返回 promise：2 秒内拒绝，组长和后代都已消失，onSettled 恰好调用一次。
- 启动失败时不调用钩子。
- onSettled 抛错或被拒绝的 promise 都转为 io 拒绝；超时优先于 onSettled 失败。
- 连续运行 3 次都稳定。

A7 已确认对接（`szrunworld/ss-a7` 的 `4d6088c`，`ActorRegistry.commandHooks()`），SHA 已直接发给 A7 的 dispatch `ctx_2b089034efec` 和协调者。

## 2. 会话表头分片姓名（`pages.ts`）

问题（P0）：真实三字姓名在会话表头里是三个相邻的单字 AXStaticText，窗口相对坐标为 (531,23,22,24)、(553,23,22,24)、(575,23,22,24)；列表行里的姓名是完整的一段，位于 (192,162,42,15)。旧版 `chat()` 取表头最左边的元素，只得到第一个字，结果正确打开的行也因姓名不符被拒。

修正：新增 `chatHeaderName(observation)`。`openChat` 仍调用旧版 `chat()` 读取摘要、经历和消息，只把 `candidate.name` 换成这个函数的结果：
- 候选片段：聊天区（相对 x ≥ 500）、相对 y < 50、高 ≥ 20 的非空 AXStaticText；排除只有私用区图标或空白的文字，以及活跃状态（`ACTIVITY_NOTE`，与简历表头共用同一词表，`HEADER_ACTIVITY` 现在是它的别名）。
- 所有片段必须在同一行：y 和高度与最左片段的差都不超过 3。
- 按 x 排序后必须首尾相接：后一片段的 x 减前一片段的右边缘，在 −1 到 2 之间。
- 姓名就是各片段按顺序拼接。一个完整的片段（原有形状）照常可用。
- 不同行、有空隙、有不相接的多余大字时不给姓名（`identify` 判为 ambiguous / 身份不完整），不去猜。之后的精确姓名比对不变。

测试：
- 三字逐字分片，`open_candidate` 通过，`identify` 匹配，`verifyUnit` 通过，`chatHeaderName` 返回完整姓名。
- 同一行带活跃状态和图标时仍能匹配。
- 以下情况都被拒绝，`verifyUnit` 也失败：
  - 第三个字留出 8 pt 空隙（ambiguous）；
  - 第三个字在另一行（ambiguous）；
  - 远处多出一个大字（ambiguous）；
  - 分片拼出的是另一个人（mismatch）；
  - 只有第一个字，即 P0 的旧现象（mismatch）。

## 3. 简历表头 `◎` 前缀（`capture.ts`）

问题（P0，已脱敏）：
- 第一条 OCR 行是 `◎ <姓名> 刚刚活跃`，姓名从下标 2 开始。
- 图像 1468×1750；该行 x 178.09、y 63.59、宽 340.92、高 45.78，上方没有其他行。
- 表头带：top 2、maxY 242、maxX 880。
- 原规则要求整行恰好是姓名（或姓名加活跃状态），所以被拒。

修正：新增 `HEADER_MARK = /^\s*◎\s*/`。只在行首去掉一个 `◎` 及其两侧空白，其他规则不变：
- 剩下的部分仍须恰好是姓名，或姓名加受限的活跃状态；
- 位置仍须在表头带内，且是最上面的一行；
- 不做“包含”匹配，也不去掉其他文字。

测试（按 P0 的几何构造）：
- 接受：`◎ 欧阳一 刚刚活跃`、`◎欧阳一刚刚活跃`、`◎ 欧阳一`、带多余空白和“今日活跃”的写法，以及不带符号的原形状。
- 拒绝：
  - 另一个人；
  - 含姓名的长句；
  - 不是活跃状态的后缀；
  - `◎◎`；
  - 其他符号 `★`；
  - 符号前有文字；
  - 符号和姓名之间有文字；
  - 符号在后面；
  - 位于表头带下方或右侧；
  - 上方还有别的行。
- 端到端（侧栏无姓名的真实形状）：`◎ 陈一` 下 `open_resume` 通过，`◎ 林二` 下失败。

## 结果

- `packages/task-runtime`：`npm run typecheck` 通过；全部 306 个测试，299 通过、7 跳过（原有，在其他文件）、0 失败。其中 `second-screen.test.ts` 25 个、`boss-resumes.test.ts` 54 个全部通过。
- `agents/boss`：`npm run typecheck` 通过；`npm test` 15 个全部通过。
- Swift 侧本轮没有改动。

## 剩余

- A7 在协调者同意后合入 `161f492`，并在 bootstrap 中接线。
- 真实 GUI 验收由主线完成：会话表头三字分片能匹配；`◎` 表头能使 `open_resume` 与采集的 `topConfirmed` 通过。
- 默认点击和无模型的脚本路线不变。
