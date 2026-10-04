# A9 原生显示器创建卡住主线程：修复报告

## 范围

工作区 `ss-a4-live`：先合入集成分支 `szrunworld/ss-runtime-integration`（快进到 `3dfd8d7`），没有改集成分支和原始检出。

改动文件：
- `Sources/SecondScreenCore/VirtualDisplay.swift`
- `Sources/SecondScreenCore/DisplayLayout.swift`
- `Sources/SecondScreen/AgentScreens.swift`
- 新增 `Sources/SecondScreenCore/DisplayConfigurator.swift`、`Sources/SecondScreenCore/DisplaySleep.swift`
- 新增测试 `Tests/SecondScreenCoreTests/DisplayConfiguratorTests.swift`、`DisplaySleepTests.swift`

我没有运行任何真实显示器、GUI、BOSS 或 WindowServer 操作，没有读 P0 私有产物，没有重启或杀进程，没有改 TS 运行时，也没有启动子代理。所有实机证据来自主线的消息。

## 诊断

调用链：
1. 控制 socket 的处理线程用 `ControlServer.runOnMain` 等待主线程回答。
2. `AgentScreens.create`（`@MainActor`）构造 `VirtualDisplay`。
3. 构造函数里 `apply` 同步调用 `selectSystemMode`。
4. 后者在主线程上执行 `CGBeginDisplayConfiguration` … `CGCompleteDisplayConfiguration`。

P0 的采样显示它阻塞在 `SLSCompleteDisplayConfigurationWithOption`。主线程一旦卡住，之后所有控制请求都卡住：后面 6 秒的稳定循环根本跑不到，CLI 在 socket 超时。此外，原来的 0.2 秒重试（最多 30 次）每次都会开启一个新事务，排在卡住的那个后面。`DisplayLayout.place`（创建时的稳定循环和 `keepArrangement`）同样在主线程上同步完成配置事务。

主线追加的证据（按原样，不扩大）：
- 卡住时的读数：物理显示器 1、2 在线但不活动；`pmset` 显示 UserIsActive 0，且没有 PreventUserIdleDisplaySleep 断言。最近一次探测中只有虚拟显示器 355 是活动的，352 不活动。**卡住期间没有采集 `CGDisplayIsAsleep`。**
- `caffeinate -u -t 5` 之后，残留显示器 352/355 立即消失。
- 5 秒的短唤醒在创建之前就过期了，创建仍然超时；改用持续唤醒（`caffeinate -u -d -t 600`）之后，挂起的请求完成，随后创建也通过。
- 唤醒状态下，集成后的 app 基线通过：创建约 1.4 s，调整大小约 0.5 s。
- 序列号互不相同，没有观察到冲突。

结论：唤醒与清理、请求完成高度相关，**支持“显示器睡眠时 WindowServer 不完成显示配置事务”这一假设，但不能证明它是所有卡住的唯一根因**。确定的一点是：主线程上同步调用这个事务，会把一个事务的阻塞放大成整个 app 无响应。最初加的“跳过已在线序列号”和“列出残留显示器”两项改动，因缺乏证据，已按协调者要求撤回。

## 修复

### 1. 配置事务离开主线程，单飞，不排队（`DisplayConfigurator`）

- 进程内共享一个串行后台队列。`submit(label, work)` 只在没有未完成事务时才提交，否则返回 `.busy(Pending)`，并**丢弃**这次工作，绝不排队。所以一个卡住的事务后面不会堆积调用。
- `pending` 和 `stalled(longerThan:)` 报告未完成事务的标签和开始时间。已经开始的事务无法取消，代码和消息里都不声称取消。
- `VirtualDisplay` 的模式选择改为 `ModeSelection`：
  - 读取模式列表和执行切换都在 configurator 上完成；
  - 最多 30 次尝试，遇到 busy 也算花掉一次，不排队；
  - 已稳定时停止；
  - 用代数（generation）守卫，新的 `apply` 或 `deinit` 会让旧循环停下；
  - 切换事务开始前再检查一次代数，已释放的显示器不会被配置。
  - `deinit` 只在锁内自增计数，不等待任何事务。
- `DisplayLayout.place` 把原点调整事务交给 configurator；busy 时这一轮跳过并返回 false（与“已请求重排”的返回值相同）。调用方本来就是按轮重试的循环：创建时的稳定循环 6 秒，`keepArrangement` 30 轮、要求连续 3 次稳定。所以布局恢复的语义保留，只是不再阻塞主线程。

### 2. 显示器睡眠前置条件和保持（`DisplaySleep` / `DisplayWork`，按协调者选择的方案 B）

- 睡眠判定（`DisplaySleep.state`）基于**在线**显示器而不只是活动显示器：
  - 至少有一个在线物理显示器，且全部 `CGDisplayIsAsleep` → `asleep`；
  - 有一个物理显示器醒着，或者没有物理显示器 → `awake`（无头是有意支持的）；
  - 在线列表读不出来 → `unknown`，不当作“无头”的证明；
  - 只有 2ndscreen 的虚拟显示器（vendor 0x3256 / product 2）不计入，其他软件显示器按物理计。
- 创建、`screen resize`、以及按窗口适配的自动调整大小，都经由 `DisplayWork.run`，依次执行：
  1. **等待未完成的配置事务**：有事务未完成时，以 50 ms 轮询等待，不阻塞线程，最多 2 秒。仍未完成就拒绝（`configurationPending`），消息写明标签、已等待的秒数和“无法取消”。这样构造函数和 `apply` 不会在任何未完成事务期间运行，正常的短事务（如上一次移除后的布局恢复）会被等过去。
  2. **检查睡眠状态**：`asleep` 拒绝，消息说明 macOS 在显示器睡眠时不会完成配置，建议操作者自行用 `caffeinate -u -d -t 600` 唤醒并保持；`unknown` 也拒绝，并附上原因。
  3. **取得断言** `kIOPMAssertionTypePreventUserIdleDisplaySleep`：系统不给就拒绝（`assertionUnavailable`），因为没有它就无法提供承诺的防睡眠。
  4. **持有断言后再查一次睡眠状态**：断言不会唤醒在两次检查之间睡着的显示器，所以这时睡着也拒绝，并释放断言。
  5. 执行工作；正常返回或抛错都会释放断言（`defer`）。
- 每一种拒绝都发生在创建显示器或启动任何原生事务之前。
- **从不唤醒**显示器：不调用 declare user activity，不会从后台点亮用户的屏幕。主线的显式唤醒是单独的操作。
- 创建因模式未稳定而失败时，消息里会附上仍未完成的配置事务（如有），并说明无法取消。

### 3. 显示器对象在事务期间的所有权

模式切换事务开始前会检查代数；同时以弱引用取得 `CGVirtualDisplay` 并在事务期间持有，事务返回后，最后一个引用在主队列上释放。这样，事务进行中即使 `VirtualDisplay` 被释放，被配置的显示器也不会在事务中途消失，`CGVirtualDisplay` 也不会在后台线程上析构。代价是：事务卡住时，被移除的屏幕要等事务返回才真正消失。

### 4. 等待引入的重入：创建、调整大小只作用于同一个屏幕对象

评审指出：`DisplayWork` 最多会等 2 秒，期间主 actor 可以处理别的请求。原先 `create` 在等待前检查数量和名字，`createDisplay` 在等待后直接构造显示器，于是两个同名请求（或争最后一个名额的两个请求）都能通过检查。修正（只在 `AgentScreens` 里加重入保护，另有一个纯函数）：

- 新增 `AgentScreenAdmission.failure`（Core），统一检查数量上限、名字（空、重名、`2ndscreen`）和 owner 进程是否存活。`create` 在等待前查一次；`createDisplay` 在等待后、构造显示器前**再查一次**。从这次复查到 `screens.append` 之间没有任何挂起点：构造和换序列号都是同步的。
- 屏幕按**对象身份**而不是名字处理：
  - 新增 `remove(_ screen:)`，只移除这个对象。它已经不在了就什么都不做，即使有别的屏幕用了同一个名字。
  - 创建失败时的清理和显示器的 `onTerminate` 都改为按身份移除。每次换序列号的尝试各有一个弱引用盒子，只有最终选中的那个显示器的盒子会指向屏幕；被丢弃的显示器即使之后被 macOS 终止，也不会移除任何屏幕。
  - `remove(named:)` 只保留给按名字的 `destroy`，以及过期回收（它拿到的是当前列表里的对象）。
- 每次 await 之后都确认屏幕仍在登记中（`isRegistered`，身份比较）：
  - **创建**：稳定循环之后、`keepArrangement` 之后各查一次。屏幕已被销毁（名字可能已被新屏幕占用）时，返回 “the screen … was destroyed while it was being created”，不会报告成功，也不会返回新屏幕的信息。
  - **`screen resize`**：等待之后，调用 `apply` 之前查一次，不在就返回 “… was destroyed or replaced before the resize finished”；`apply` 失败时也区分是被销毁还是 macOS 没切换。
  - **按窗口自动调整大小**：等待之后不在登记中就不调用 `apply`；结束后不在就不再摆放窗口；`resizing` 标志始终会复位。
  - **`apply`**：稳定循环之后不在登记中就返回 false，也不触发 `onResize`。`isSettled` 读的是显示器最新一次的请求，所以 `apply` 还要求显示器当前的模式和 HiDPI 仍是本次请求的值；被更新的调整大小取代时返回 false，`screen resize` 报 “another request resized the screen to … before this resize finished”，不会报成功。
  - **创建成功前**：稳定之后、`keepArrangement` 之后都确认模式和 HiDPI 仍是请求值。若期间被别的请求改了大小，返回 “was created but another request resized it … it still exists”，屏幕保留，由改它的那个请求负责其大小。

限制：
- 这些保护只针对 `AgentScreens` 自己的 await 点。
- `launch`、`moveWindows` 等其他异步路径没有改：它们拿到的是 `ScreenInfo`（显示器 ID），并不持有 `Screen` 对象。
- App target 没有测试 target。重入回归是用 Core 中的模型（`AgentScreenAdmissionTests`）证明的：它使用真实的 `DisplayWork` 等待和真实的 `AgentScreenAdmission`，结构与 `create` 相同。`AgentScreens` 本身的行为需要主线做并发实测。

## 保证与限制

保证：
- 主线程上不再调用 `CGCompleteDisplayConfiguration`（模式选择和布局恢复两处都已移走）。
- 同一时刻进程内最多一个配置事务；未完成时，新的模式或布局请求被拒绝而不是排队。
- 创建和调整大小只在没有未完成事务（最多等 2 秒）、显示器未睡眠且状态可读、断言已取得、持有后复查仍醒着的情况下才开始；否则给出原因并立即返回，不创建显示器、不启动原生事务。
- 断言的生命周期严格限于一次创建或调整大小，所有退出路径都会释放。

限制（不夸大）：
- **已经开始的事务不可取消**；它卡多久，configurator 就 busy 多久。期间的模式和布局请求都被拒绝，新建会在 2 秒后被拒绝。
- **断言只覆盖创建或调整大小本身**。创建返回后，仍在 configurator 上卡住的事务、尚未用完的模式选择重试，都不在断言覆盖范围内。
- **其他原生调用仍在主线程，且可能阻塞**：`CGVirtualDisplay(descriptor:)`、`CGVirtualDisplay.apply(settings)`、显示器对象释放，以及 `CGDisplayCopyAllDisplayModes`、`CGDisplayBounds` 等只读调用。这些调用是否有界没有任何保证。本修复不承诺所有原生调用有界。
- 睡眠判定把 2ndscreen 以外的虚拟或软件显示器（例如别的 app 的 `CGVirtualDisplay`、Sidecar）当作物理显示器。它们一般醒着，所以结果偏向“不算睡眠”（继续执行）。
- 睡眠前置条件来自上述相关性证据，不是已证明的唯一根因；在显示器醒着时，事务仍可能因其他原因卡住，这种情况只能靠单飞、2 秒等待和明确消息兜底。
- 代数复查**无法撤销已经开始的原生事务**：复查只决定是否开始；开始之后，迟到的释放或调整大小要等它返回才生效。
- 布局事务使用提交时算好的原点，不持有显示器对象；若它在某个显示器移除之后才执行，可能作用于被系统复用的 ID。这需要恰好落在移除和复用之间，概率很低，但不能排除。
- 布局恢复可能被丢弃：`keepArrangement` 最多 30 轮（约 3 秒），configurator 一直 busy 时每轮都跳过，最终放弃，不再恢复用户的排列；创建时的稳定循环同理。这时屏幕可能停在 macOS 挪动后的位置。
- 在后台队列上调用 Quartz Display Services 的线程安全性，Apple 文档没有明确限制，也没有明确保证。需要主线实机确认。
- 残留虚拟显示器的清理：没有使用任何私有的删除接口。按主线证据，它们在唤醒后由系统自行回收。

## 测试（合成，无显示器）

`swift build` 通过；`swift test` 135 个全部通过，其中本任务新增 17 个（第 4 节的重入回归占 5 个），完整测试连跑 3 次都稳定。所有临时变异都已还原（源码中没有残留）。测试里卡住的信号量都用 `defer` 释放，断言失败也不会把队列留在阻塞状态。

`DisplayConfiguratorTests`：
- 卡住的事务（信号量模拟）不阻塞提交者。
- `pending` 和 `stalled` 使用注入的时钟。
- 卡住期间 20 次提交全部返回 busy，释放后一个也不会运行；之后可以正常提交。
- 完成回调运行时 configurator 已空闲。
- `step` 选择正确倍率的变体，未列出时返回 `notListed`。
- 模式选择：先未列出，再切换一次，稳定后停止；从未列出时，恰好用完尝试次数。
- 卡住期间，尝试被逐个花掉，不排队，释放后也不补跑。
- 代数变化（调整大小或释放）后，旧循环不再读取或切换。
- 变异检查：让 configurator 排队而不是拒绝，“卡住时不排队”的测试会失败。

`DisplaySleepTests`：
- 判定：P0 形状（物理 1、2 睡眠，虚拟 352/355 醒着）判为 `asleep`；有一个物理醒着、只有虚拟、空列表判为 `awake`；列表读不出判为 `unknown`。
- `asleep` 和 `unknown` 都拒绝：工作不运行，没有原生事务，不取得断言，消息正确。
- 第一次检查醒着、持有断言后睡着：拒绝，工作不运行，断言释放一次。
- 系统不给断言：拒绝，工作不运行，不释放。
- 未完成的事务在等待内返回时，工作在它返回后才运行；一直不返回时，在等待上限内拒绝，消息带标签和“无法取消”。
- 断言在执行期间持有，正常返回和抛错后都释放；两个并发运行各持各放。
- 变异检查：去掉持有后的复查，或者去掉等待，对应测试都会失败。

`AgentScreenAdmissionTests`（确定性：先让一个配置事务保持未完成，等两个请求都通过第一次检查、都在等待中，再放行）：
- 同名的两个并发创建：两个都通过了第一次检查，最终只创建一个，另一个得到 “already exists”。
- 争最后一个名额：只有一个成功，另一个得到 “at most 1 …”。
- owner 在等待期间退出：复查时拒绝，不创建。
- 对照：去掉复查时两个请求都会被加入，证明第一次检查本身不够。
- 准入规则本身：空名、`2ndscreen`、重名、上限、owner 已退出、当前进程存活。

## 主线安全探测步骤（只读或可逆，由主线执行）

1. 只读确认状态：
   - `pmset -g assertions`：看是否已有 `PreventUserIdleDisplaySleep`；
   - `system_profiler SPDisplaysDataType`：确认显示器是否睡眠；
   - 确认没有 SecondScreen 进程残留。
2. 用本分支构建 side instance。在显示器睡眠时执行 `2ndscreen screen create`。预期：立即失败，消息为 “the displays are asleep …”；app 仍然响应（`screen list` 立刻返回）；没有新的显示器。
3. 由操作者显式唤醒并保持：`caffeinate -u -d -t 600`（可逆，到时自动结束）。再次创建，预期成功。创建期间 `pmset -g assertions` 能看到 “2ndscreen: creating agent screen …”，返回后消失。
4. 若再次出现卡住：创建在 6 秒稳定循环后失败，消息带 “a display configuration … has been waiting on WindowServer … cannot be cancelled”；其间 `screen list` 等请求仍能返回。之后的创建和调整大小最多等 2 秒，然后以 “WindowServer has not finished a display configuration …” 拒绝。此时只需保持唤醒，等待事务返回，不要杀进程或删除显示器。
   - 注意：卡住发生在构造函数或 `CGVirtualDisplay.apply`（仍在主线程）里时，app 仍会整体无响应，属于已知限制。
5. 并发创建：在显示器醒着时，同时发两个同名的 `screen create --name X`，预期一个成功，另一个得到 “already exists”。再在第一个创建进行中 `screen destroy X`，预期那个创建返回 “was destroyed while it was being created”，不会报告成功。
6. 结束后 `screen destroy` 清理，再用 `pmset -g assertions` 确认断言已释放。
