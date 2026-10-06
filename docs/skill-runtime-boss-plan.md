# Second Screen 自学习任务系统实施规划

本方案面向 Second Screen 的研发与验收：建立稳定的桌面任务运行底座，让每个业务任务以独立 Skill 调用；首次通过已有流程或模型探索完成操作，同一批次内立即复用，稳定后不再逐动作请求模型，失败时只修复受影响的步骤。

用户已确认首版范围：macOS 优先，采集当前账号已可查看的 BOSS 简历；原始附件可下载时保存附件，否则明确保存为页面采集件。本文依据 2026 年 10 月 4 日读取的当前工作区和参考项目编写，描述的是待实施方案，不代表相关功能已经交付。参考项目按业务路径已验证可执行处理；Windows 上的成功不能代替 macOS 后台能力验证。

**一 交付目标与边界**

最终用户只需提供岗位、数量和目录。系统自动准备窗口、找到候选人、获取简历、保存结果、记录进度并结束会话。首次登录和验证码需要用户完成，之后可恢复原任务。

首版交付以下完整闭环：

1. 一个独立的 boss-resumes Skill，包含任务说明、机器可校验的配置、业务工作流和流程种子。
2. 通用 Task Runtime，负责会话、批次、流程执行、学习、恢复、产物与状态。
3. macOS BOSS 适配器，操作全部经 Second Screen 执行。
4. 同批次的第二位候选人即可尝试回放，成功三次后将该流程提升为稳定版本。
5. 熟练流程在关闭语义分析时可断开模型服务执行；界面异常才允许按预算调用模型修复。
6. 文件和候选人一一关联，重启可续跑，数量不足、部分采集、同步失败均有明确结果。

首版不包含主动打招呼、求简历、自动回复、岗位发布、付费解锁、多账号并行及无人值守验证码处理。这些可后续作为独立 Skill 或显式能力扩展。打开会话可能改变已读状态，应写入任务说明。

默认采集模式为 available：原始附件优先，无法下载则采集已展示页面。original-only 模式只计入验证通过的原始附件，不以截图补足数量。页面采集件与原始附件始终保留独立类型；屏数上限停止不能算全文采集完成。

**二 现有代码与可复用资产**

| 当前代码 | 已有能力 | 本次处理 |
| --- | --- | --- |
| Sources/SecondScreen/AgentScreens.swift | 屏幕生命周期、应用启动、窗口绑定、尺寸管理 | 保留，扩展会话所需状态与能力查询 |
| Sources/SecondScreen/ControlServer.swift | App 通过 Unix Socket 接收请求 | 保留低层控制，不在 App 主线程运行任务循环 |
| Sources/SecondScreenCore/InputEngine.swift | 元素/坐标操作、窗口范围检查、输入反馈 | 作为全部操作入口，补快照版本与动作验证接口 |
| Sources/SecondScreenCore/BackgroundInput.swift、FocusGuard.swift | 后台事件、焦点保护 | 复用，按 BOSS 页面逐项实测 |
| Sources/SecondScreenCore/ControlProtocol.swift | CLI 与 App 协议 | 增量扩展，旧命令继续可用 |
| Sources/TarsAgent/Agent.swift、Planner.swift | 视觉探索、动作解析、提交限制 | 复用为受限探索器，输出结构化执行记录 |
| Sources/TarsAgent/Procedure.swift、Learning.swift | 按控件学习、参数替换、回放失败转模型 | 保留旧行为，通过适配层接入新流程格式 |
| agents/boss/src/setup.ts | --auto、独立 Socket、1440×900 屏幕、启动及接管策略 | 提取成通用会话管理，保留已有 BOSS 助手接口 |
| agents/boss/src/store.ts | 原子写 JSON、已处理记录、记录启动 PID | 不直接承担新任务账本，新增事务型存储 |
| agents/boss/src/boss.ts、parse.ts、chat.ts | BOSS 控件操作、会话和候选人信息解析 | 提炼 BOSS 适配器与脱敏测试素材 |
| windows/src 与 windows/tests | C# 桌面控制及测试 | 首版保持兼容，后续适配共用 Runtime |

当前 BOSS 助手已经能自动准备环境，不能将这部分重复当成从零开发。其已处理标记在处理前写入，适合现有防重复策略，但不能作为新简历任务的完成证据；新任务必须文件验证并提交账本后才记完成。

这里的独立实例是 Second Screen App 的独立控制实例与 Socket，不表示已经创建独立的 BOSS 登录环境。首版沿用当前 BOSS 登录状态；屏幕分离不提供进程、账号或文件系统隔离。

当前 AgentCommand 会在运行前读取模型配置，即使可能全程回放。因此“无模型密钥也能回放”需要新增路径或延迟初始化，不能仅靠 --no-learn 等现有选项达成。

当前 Procedure 主要在一次 instruction 完成后保存，并且不保存无法关联控件的纯坐标操作。它没有完整的批次游标、文件产物事务和模板定位流程。新方案需补这些能力，而不是将现有学习机制直接视为完整任务系统。

参考项目位置：/Users/kevinshi/Documents/Code/Deeptalent/boss_pc-master。

| 参考实现 | 可迁移内容 | 迁移边界 |
| --- | --- | --- |
| core/cv_locator.py | 模板缓存、局部搜索、多尺度匹配、最近位置缓存 | 输入改为 Second Screen 截图，输出仅为定位结果 |
| core/ocr_helper.py | OCR 预处理、局部区域识别、结构化文字框 | 按需启用；不直接调用全屏截图或鼠标 |
| boss_job_publisher_v3.py 的相对位置逻辑 | 窗口相对区域、点击后验证、模板回退 | Windows 模板与尺寸必须重新标定，不能直接当 Mac 配置 |
| boss_recommender_v1.py | 候选人遍历、在线简历文本、身份提示、截图和去重思路 | 拆出采集路径，不绑定打招呼成功 |
| boss_message_handlerv3.py | 在线/附件简历分支、识别索取确认框、附件预览文字 | 首版遇索取请求取消或停下，不发送请求 |
| SQLite 与 API 回传逻辑 | 候选人记录字段、结果协议、回传顺序 | 新账本区分本地成功与远端确认 |

源码核对的重要边界：_capture_resume_long_screenshot 使用截图滚动并拼接，推荐路径中在 greeted 后调用；_capture_attachment_resume_dump 主要读取附件预览文字。不能据此宣称已有经过验证的原始 PDF 下载能力。首阶段必须单独核实 Mac 客户端是否存在可用下载入口。

**三 总体实现原理**

采用四层结构：

    Skill 任务定义与业务工作流
                 ↓
    Task Runtime 批次执行 学习 恢复 产物管理
                 ↓
    Desktop Adapter 与受限 Agent 探索器
                 ↓
    Second Screen 屏幕 窗口 截图 辅助功能 后台输入

底层固定的是 TaskSession 及控制契约。窗口 PID、windowID 允许重建，不能作为永久身份。应用弹窗属于同一会话的窗口集合；每次动作解析当前目标并验证归属。

执行路径优先级为：已验证流程 → 本地重新定位与有限恢复 → 模型探索或修复。观察不等于调用模型：辅助功能读取、图像匹配、局部 OCR、文件检查都在本地完成。

首版采用 TypeScript 实现跨平台任务 Runtime，理由是现有 agents/boss 已用 TypeScript，任务编排、文件管理与数据库不应分别在 Swift 和 C# 重写。macOS 系统能力继续用 Swift，视觉模型探索复用 TarsAgent。

新增探索桥接命令，让 Runtime 调用现有 Agent 并获得 JSONL 事件、执行轨迹和候选流程。Bridge 内运行的 Agent 已执行动作，Runtime 只接收并验证结果，不再重复执行轨迹。Bridge 与普通 Runtime 执行共享会话租约，任何时刻只有一个动作执行者。

本地视觉能力采取可替换 provider：第一阶段优先辅助功能；确有缺口时，提取参考项目的纯图像匹配代码到常驻 Python worker，使用固定版本环境和 JSONL 协议。worker 只接受指定图片和区域，返回匹配框/OCR，不拥有桌面输入权限。避免每个动作启动 Python 或重新加载 OCR 模型。

本方案不要求复制参考项目的 FastAPI、轮询和生产入口。首版通过本地 Runtime 提供任务控制；远端集成独立追加。

**四 独立 Skill 的组织方式**

Skill 同时包含可供 Agent 阅读的 SKILL.md 和可供程序执行的结构化任务包。SKILL.md 不负责逐步驱动鼠标；它解析用户目标并调用一次任务入口，后续循环由 Runtime 完成。

建议目录如下，除既有目录外均为规划新增：

    packages/task-runtime/src/
      contracts.ts        TaskSpec Session Observation ActionResult
      daemon.ts           本地任务控制与 worker 管理
      session.ts          应用租约 窗口重绑定 屏幕回收
      runner.ts           状态机 批次循环 检查点
      procedures.ts       流程加载 执行 版本与可信度
      learning.ts         轨迹归纳与候选流程验证
      recovery.ts         本地恢复及模型预算
      artifacts.ts        文件验证 原子归档 索引
      store.ts            SQLite 事务与迁移
      telemetry.ts        耗时 路由 模型调用与 token
      adapters/second-screen.ts
      adapters/vision-worker.ts
    agents/boss/src/resumes/
      workflow.ts         业务状态图和工作单元
      pages.ts            页面分类与定位器
      candidates.ts       遍历 身份与去重
      capture.ts          在线与附件采集
      validators.ts       成功与完整性检查
    skills/boss-resumes/
      SKILL.md
      task.json
      procedures/         随包发布的初始流程
      profiles/macos/     页面区域 模板 尺寸配置
    tools/vision-worker/
    Sources/ScreenCLI/TaskCommand.swift
    Sources/ScreenCLI/AgentBridge.swift
    contracts/task-runtime/
    tests/task-runtime/
    docs/skill-runtime-boss-plan.md

单独增加 Runtime 的 package.json 与锁文件，明确 Node 运行版本并打包分发，避免依赖用户全局 npx 或隐式工作目录。SQLite 驱动在技术验证阶段选定并锁版本；提供新机安装与迁移测试。若使用原生扩展，发布物必须覆盖目标 Apple Silicon/Intel 架构或明确首版支持范围。

task.json 的概念配置如下，字段和命令均为待实现接口：

    {
      "schemaVersion": 1,
      "id": "boss.collect-resumes",
      "version": "1.0.0",
      "platforms": ["macos"],
      "application": "com.zhipin.www",
      "windowProfile": "boss-macos-1440x900",
      "workflow": "boss-resumes-v1",
      "inputSchema": "collect-resumes-input-v1",
      "capabilities": ["ui.read", "ui.navigate", "resume.capture", "artifact.write"],
      "submitAllowed": false,
      "foregroundAllowed": false,
      "learning": {"promoteAfterSuccesses": 3},
      "defaults": {"captureMode": "available", "analysis": "off"}
    }

任务参数必须包括岗位匹配条件、成功数量目标、输出目录、来源范围、采集模式；可选浏览上限、截止时间、模型预算、接管已有应用、结束后保留窗口。相同岗位名称有多个匹配时要求选择，不直接取第一项。

独立 Skill 表示独立入口、版本和配置，不保证独立 BOSS 进程/账号。单实例应用可能只有一个可用进程，同账号任务默认串行。Plugin 分发可后续打包 Skill 与工具，不进入首版关键路径。

**五 会话与窗口管理**

复用 setup.ts 的 side instance 与 1440×900 逻辑，但将固定值变成 profile：记录逻辑尺寸、实际窗口内容区、HiDPI 比例、应用版本、语言、主题、页面缩放和 profile 版本。初始化时读取真实值，不能仅相信启动参数。

坐标持久化为窗口内容区或稳定锚点的相对坐标。macOS 全局 points、截图 pixels 与模型归一化坐标显式转换；新增/删除显示器后重新读 frame。窗口大小固定仍不能保证列表内容和布局固定，动态行始终重新定位身份。

启动步骤：

1. 校验任务参数、输出目录可写性、所需权限、运行组件和应用可用性。
2. 获取 account/app 会话租约。旧消息助手与新简历任务也必须遵守同一租约，禁止同时操作同一 BOSS。
3. 启动或连接 Second Screen side instance；复用或创建符合 profile 的屏幕。
4. 启动 BOSS，或接管用户显式允许的已有实例。只凭历史 PID 不够，核对 bundle、进程启动时间与窗口归属。
5. 等待主窗口和可识别起始页面，处理加载窗口替换，检查截图有效且对应正确屏幕。
6. 登录失效则进入 waiting_user，保存任务。用户登录并恢复后再次绑定与校验。
7. 会话准备完毕才开始获取候选人。

将当前永不过期屏幕改为有管理者的生命周期：Runtime heartbeat、租约期限和可续期空闲超时配合使用。owner-pid 应指向长期 worker 而非发命令即退出的 CLI。崩溃后允许屏幕回收，恢复时可重建。

结束时按策略释放或保留窗口，不关闭用户原本运行的应用。窗口被用户主动移走时暂停，不不断抢回；恢复由显式 resume 或已约定的恢复策略触发。

**六 BOSS 端到端流程**

首个垂直闭环从已有会话中可查看的简历开始，复用当前 parse.ts/chat.ts。随后补推荐列表和岗位筛选作为同一个 Skill 的不同来源适配器，复用相同的获取、验证、保存与去重链路。

| 工作单元 | 输入 | 成功条件 | 常见分支 |
| --- | --- | --- | --- |
| select_source | 岗位与来源 | 正确列表已显示，岗位被确认 | 无岗位、重名、登录态丢失 |
| enumerate_candidates | 当前列表观察 | 得到候选人引用与下一步游标 | 虚拟列表、加载中、无更多 |
| open_candidate | 当前候选人引用 | 详情身份与列表引用匹配 | 行重排、弹窗、窗口重建 |
| open_resume | 候选人详情 | 在线或附件预览已打开 | 无附件、索取确认框 |
| acquire_resume | 模式及目标目录 | 原始文件或采集页通过验证 | 下载超时、空白截图、不完整 |
| persist_candidate | 已验证产物 | 原子归档并提交账本 | 磁盘满、路径冲突、身份不明 |
| return_to_list | 已知返回状态 | 列表标志恢复 | 回到错误页面、弹窗未关 |
| advance_list | 当前列表指纹 | 出现新候选人或确认到末尾 | 滚动无效、重复页、网络延迟 |

候选人循环由程序驱动：当前页识别 → 排除已完成 → 逐个处理 → 重新观察 → 前进。不得在长时间操作后继续使用旧元素 index 或旧列表行坐标。没有更多、浏览上限、截止时间、目标已达成都是显式终止原因。

第一页成功后，第二位即使用刚保存的工作单元。遇到另一种简历类型时学习一个新分支，而不是使所有旧流程失效。任意分支恢复后重新确认候选人身份，避免将 A 的文件记到 B 名下。

无附件时，available 模式切到可见在线简历；original-only 标记 unavailable 并继续。弹出求简历确认框时不点击确认；参考项目中此分支的识别逻辑可复用。

**七 自学习流程与零模型执行**

学习对象是有入口、出口和成功条件的工作单元，例如 open_resume、capture_visible_resume、return_to_list。首版由 Skill 显式定义这些边界，模型学习边界内的操作，避免在开放式长轨迹中错误猜测任务结构。跨任务自动发现全新业务工作单元放到后续版本。

每个流程版本至少存储：

| 字段 | 用途 |
| --- | --- |
| skill/version、unit、platform、appVersion、profile | 限定适用环境 |
| parameters 与 bindings | 候选人引用、路径等变化值，避免硬编码人名 |
| preconditions、postconditions | 入口与结果的可执行检查 |
| steps 与 locator alternatives | 动作、定位方式、局部回退 |
| expectedState 与 timeout | 下一状态及有界等待 |
| effectClass | read / navigation / artifact / external-submit |
| evidence | 成功检查结果及脱敏的定位依据 |
| status、successes、failures、parentVersion | 可信度、修复来源与回滚 |

状态为 seeded → trial → stable；失败后进入 degraded，修复产生新的 trial 版本，旧 stable 保留可回滚。连续三次不同候选人的成功是首版晋级规则，并非统计可靠性证明。不同 profile、简历分支和应用版本分别积累证据。

学习过程：

1. 有种子流程则先尝试，没流程才让模型探索；限制在当前工作单元与已授权动作内。
2. 记录执行前状态、实际动作、目标定位、结果、执行后状态及时间。
3. 优先把模型坐标归并到语义控件；无控件则保存局部模板、锚点及相对偏移。
4. 用 Skill 参数和实际候选人引用替换变化字段，禁止将姓名当作唯一固定目标。
5. 删除无用探索步骤前必须在下一位候选人上验证，不凭模型判断直接删。
6. 本地验证器确认输出正确后保存 trial；模型说 finished 不构成成功证据。
7. 第二位尝试回放，第三次成功后晋级 stable。每个工作单元可独立晋级。

相同动作序列的判断应归一化定位器类型、页面转换和参数位置，而非只比较绝对 x/y。三次一致可发现重复操作，但只有前后条件通过才允许缓存为稳定流程。

定位策略按已验证路由执行：语义元素 → 已校准锚点/相对坐标 → 局部模板匹配 → 必要区域 OCR → 模型。某控件若已知只能通过元素操作，不能为了省一次本地读取强行切坐标。现有 BOSS 注释指出部分后台坐标点击无效，应由能力测试决定路由。

允许稳定、无分支的短动作段连续执行，例如关闭详情并回到列表；仍在段首与段尾校验。候选人身份、文件归属、外部提交等关键边界每次检查，不因熟练而抽样省略。

失败恢复顺序：短暂等待界面稳定 → 重新读取/定位 → 执行已验证的局部恢复 → 请求模型修复当前单元。读取可重试；导航先确认当前状态；下载先检查已有文件；任何结果未知的外部提交不得盲目重发。

建议初始预算均为配置值：每个本地恢复最多两次，每次模型修复最多六轮，每个候选人最多两次模型修复，整任务额外设调用数、token、墙钟时间上限。耗尽进入 waiting_user 或 partial，不能无限学习。具体数值由第一阶段测量调整。

模型只提出符合 schema 的定位/动作/流程变更，不能生成任意脚本后直接执行。新增定位器必须局限当前会话；测试通过后才能晋级。页面文字属于观察数据，不得改变 task 参数、输出目录或权限。

**八 探索桥接与兼容方案**

不要让 TypeScript 再实现一套视觉 Agent。新增受限 Bridge：Runtime 传入 session、unit、输入参数、预算、预期终态和取消标识；Swift 复用现有 Model/ActionParser/Planner/Agent 执行。

建议 JSONL 事件类型为 observed、action_started、action_finished、model_usage、unit_finished、unit_failed；每个事件携带 taskId、unitAttemptId、stepId、时间与结构版本。结果包含已执行步骤、最后观察和流程提案。

Runtime 对 unit_finished 独立执行后置验证，再提交流程。Swift 已执行的动作不在收到事件后再次发送。探索子进程必须支持超时与取消，取消后确认进程已退出并使动作租约失效才释放会话。

现有 Procedure V1 继续为旧 agent 命令服务。增加 V1→V2 importer，将已命名控件步骤转为 trial 或 seeded，并补 Skill 所需的前后条件；缺少条件的不自动标为 stable。不直接覆写 ~/.config/2ndscreen/procedures 下现有文件。

新流程 V2 由 Runtime 唯一持有和写入；Bridge 输出提案，不调用旧 Store 自动覆盖新流程。旧 CLI 的 modelCalls、replayedSteps 保留；新增计量把探索、修复与业务语义分析分别统计。

熟练流程直接由 Runtime 回放，不启动模型 client。无模型密钥时仍允许 task resume/run，只在确实需要探索时报告 waiting_user/model_unavailable。

**九 简历文件交付与身份关联**

原始附件分支：先确认真实下载入口和允许的后台路由。对每个候选人使用唯一 staging 目录；保存对话框指定路径时关联同一会话。若只能进入公共 Downloads，记录操作前快照，结合新文件、时间、文件元信息与候选人证据匹配；不确定就标记 ambiguous，不选择“最新 PDF”直接归档。

文件验证包括存在、大小稳定、无临时下载后缀、类型与内容头相符、可解析、非空；PDF 用解析器检查页数等，不只看扩展名。对外部存储目录的符号链接/路径解析进行归一化，拒绝候选人名称产生路径穿越。原始文件保持原字节，使用哈希记录版本。

页面采集分支：定位简历滚动容器，回顶并确认，截取实际内容区，按可观察进度滚动。保留每页原图和文字，去除固定头部并基于重叠内容拼接。参考项目固定裁掉 8% 的拼接方式可作为启发，但不能当作完整性保证。

触底确认需要滚动位置/底部标志/内容终止等组合证据。连续图片相同也可能是滚动失效，所以达到重复阈值仅触发检查，不能自动宣称全文完成。达到安全屏数上限、拼接缺口、滚动无效都标记 partial_capture，并保留分屏证据。

身份采用内部 candidate_id 与 source_ref 分离：可见稳定平台标识优先；无标识时组合岗位、姓名、教育/经历提示和详情证据，记录 identity_confidence。OCR 推导哈希不是官方 ID，同名或信息冲突不得强制合并。候选人身份与简历内容哈希分别去重，同一候选人可以有新版简历。

建议交付目录：

    输出目录/任务编号/
      manifest.json
      index.csv
      candidates/内部候选人编号/
        metadata.json
        original/            原始附件 如可获取
        captured/pages/      页面采集原图
        captured/resume.png  验证通过的拼接图
        resume.txt
      failures.json

metadata 至少记录岗位、来源、候选人引用、产物类型、完整性状态、获取时间、文件哈希与流程版本。默认仅采集和保存，不调用模型总结简历；需要分析时作为独立开关或 Skill，只对新增内容按哈希分析一次。

**十 持久化与恢复**

SQLite 存放任务账本，图片和文件保存在用户输出目录。建议数据库位于 ~/Library/Application Support/2ndscreen/tasks/tasks.db，流程位于同级 procedures；由配置统一解析，不能依赖仓库位置。

最小表集合：

| 表 | 关键字段 |
| --- | --- |
| tasks | id、skill/version、input、status、phase、goal、counts、deadline、error |
| sessions | id、app/account scope、socket、process identity、window profile、lease expiry |
| work_items | task、candidate ref、status、attempt、last completed unit、identity confidence |
| artifacts | item、kind、path、hash、validation、completeness |
| procedures | skill/unit/profile、version、status、definition、success/failure counters |
| events | task/item/step、event type、time、result、evidence reference |
| outbox | 可选远端目标、payload、idempotency key、retry、ack |

任务状态 queued → running → succeeded / partial / failed / cancelled；可中途进入 paused 或 waiting_user 再恢复。running 的 phase 为 preparing、learning、executing、repairing、finalizing。取消请求先置 cancelling，worker 停止动作后置 cancelled。

单条 work item 使用 discovered → processing → acquired → validated → committed；另有 unavailable、failed、ambiguous。只有 committed 计入成功数量。任务达到 requested_count 才是目标达成；来源耗尽但数量不足为 partial，输出 termination_reason=source_exhausted。

成功计数还必须满足采集模式要求：available 接受已验证的原始附件或完整页面采集件，original-only 仅接受原始附件。partial_capture 可以保存为诊断产物，但不进入成功数量。已提交文件后返回列表失败时，保留该候选人的 committed 状态，将会话阶段置为 repairing；恢复导航后继续下一位，不重复下载已完成的文件。

任务绑定 BOSS 账号范围，而不是当前 Codex 账号。准备与恢复时检查可见的 BOSS 账号标识；无法可靠识别时使用本地显式绑定，并在登录变化后要求重新确认。候选人引用和去重键包含该范围。账号改变后不沿用旧任务游标或候选人账本；脱敏后的通用流程可以复用，但需重新验证适用性。

归档顺序：写入 staging → 验证 → 同一输出文件系统原子改名 → 数据库事务提交 artifact/item → 重建导出索引。文件系统与数据库不可能做单一原子事务，因此启动时对账：已归档未入库的按 manifest/hash 补入，已入库但文件缺失的重新验证，临时文件不算完成。日志和索引能由数据库重建。

任务执行采用可重试的至少一次处理；本地文件通过幂等键实现不重复归档，不宣称任意 GUI 外部副作用具有 exactly-once。取消或崩溃后从最后 committed 的候选人继续，对 processing 项先核对当前页面与文件再决定恢复位置。

任务控制进程与 worker 分离，GUI 会话锁与状态/数据库短事务分离。心跳、status、cancel 不等待长时间 GUI 操作。重启时用进程身份和租约发现孤儿任务，转为可恢复状态，不直接报告成功。

**十一 任务入口与观测**

下列为规划中的统一命令，不是当前可执行命令：

    2ndscreen task run boss.collect-resumes --job "前端工程师" --limit 20 --output "$HOME/招聘/前端" --mode available
    2ndscreen task status TASK_ID
    2ndscreen task pause TASK_ID
    2ndscreen task resume TASK_ID
    2ndscreen task cancel TASK_ID
    2ndscreen task artifacts TASK_ID
    2ndscreen task inspect-procedure PROCEDURE_ID

run 校验后返回 taskId，后台 worker 继续。status 提供目标数、浏览数、成功数、跳过/失败数、当前阶段、等待原因、模型预算与产物位置。MCP 增加对应 task 工具，并返回任务资源链接；菜单栏后续显示进度、暂停和接手入口。

观测至少区分 ui_model_calls、repair_model_calls、analysis_model_calls、input/output tokens、截图数量、本地 OCR 次数、回放单元数和耗时。模型服务不提供 token usage 时标记 unknown，不能填 0；模型调用次数仍精确记录。

关键成本验收看“稳定批次无异常时 ui_model_calls=0”，不以平均 token 低掩盖每一步仍请求模型。每个模型调用必须能追溯到 missing_procedure 或具体失败原因。

**十二 故障策略**

| 故障 | 处理与恢复位置 |
| --- | --- |
| 主窗口/PID 替换 | 重绑定、重读 frame/profile，从当前工作单元入口恢复 |
| 屏幕丢失 | 保存检查点、重建屏幕、验证截图与目标窗口，不沿用旧坐标 |
| 列表重排或候选人失踪 | 重新枚举并按身份匹配，找不到标记 unavailable |
| 后台滚动无效 | 尝试已验证替代路由，仍失败则暂停；不静默使用真实鼠标 |
| 登录失效/验证码 | waiting_user，保留已完成文件；不让模型持续尝试 |
| 模板与控件均失配 | 限额模型修复当前单元，成功后生成新 trial 版本 |
| 下载超时/归属不明 | 对账 staging，保留证据，不将未知文件标记成功 |
| 磁盘满 | 停止新增采集，报告可恢复存储故障 |
| 模型不可用 | stable 流程继续；确需探索的项目暂停或按策略跳过 |
| 远端 500/超时 | 本地文件保留，outbox 重试；同步状态单独报告 |
| 用户暂停/取消 | 检查点落盘，停止发新动作；取消确认前等待动作执行者退出 |

首版 foregroundAllowed=false。如果 Mac 的某个必需页面无法后台操作，第一阶段就应报告能力缺口；可选择只支持已验证分支，或后续增加用户明确启用的前台模式，不能把前台操作包装成后台成功。

**十三 实施拆解与顺序**

以下工期为单名熟悉仓库的工程师的工程估算，不是承诺；不含等待账号、测试设备及第三方客户端不可用时间。按依赖串行推进约 45–66 人日。P0 后依据真实能力矩阵重估，最先获得可运行闭环，再加入泛化学习。

| 阶段 | 工作包与预计投入 | 依赖 | 完成标志 |
| --- | --- | --- | --- |
| P0 能力验证 3–5 日 | Mac 页面调查、滚动/截图/附件下载实测、参考流程映射、脱敏 fixtures | 无 | 明确可支持来源、产物类型、后台路线与阻断项 |
| P1 最小端到端 5–7 日 | 复用 Setup，已有会话→单份简历→文件验证→归档 | P0 | 一条命令正确获取并归档至少一份可查看简历 |
| P2 批次与账本 6–8 日 | Task Runtime、SQLite、列表循环、身份、幂等、进度、暂停取消 | P1 | 无模型的已编排流程处理一批候选人，崩溃续跑不重复归档 |
| P3 同批次学习 8–12 日 | Bridge、结构化轨迹、流程 V2、前后条件、trial/stable、局部修复 | P2 | 第一份探索，第二份回放，熟练批次零 UI 模型调用 |
| P4 采集覆盖 6–9 日 | 推荐来源、岗位选择、长页完整性、附件分支、虚拟列表、异常页 | P3 | 声明支持的分支通过矩阵测试，缺失项明确报告 |
| P5 交付与可靠性 5–7 日 | Skill 包、task CLI/MCP、安装打包、日志脱敏、长期运行与恢复验收 | P4 | 新环境可安装，一次调用完成已约定首版范围 |
| P6 远端系统 4–6 日 | 导出协议、outbox、幂等补传、服务端契约测试 | P5 | 本地完成与远端完成可分别追踪，断网恢复可补传 |
| P7 Windows 适配 8–12 日 | 共用 Runtime、Windows profile/UIA 路由、Bridge 或等价接口 | P5 | 同一业务契约通过 Windows 验收 |

macOS 首版到 P5 约 33–48 人日。P6/P7 是完整路线的后续扩展，不阻塞用户指定的 macOS 本地闭环。若 P0 证实下载入口不可用，available 模式仍可交付页面采集；original-only 能力明确不可用，不伪装完成。

**P0 的具体执行顺序**

P0 先回答“Mac 上哪些步骤确实可执行”，完成后才确定 P1 的首条采集路线。以下均为待执行任务；本次规划仅完成源码核对，没有进行这些桌面实测。

| 顺序 | 执行内容 | 交付物和通过条件 |
| --- | --- | --- |
| 1 固定基线 | 记录 Git 提交、已有工作区差异、系统与应用版本、实际屏幕缩放；运行现有 Swift 与 BOSS 测试 | 基线报告区分原有失败与新增失败；不覆盖已有改动 |
| 2 验证环境 | 使用现有 Setup 建立 1440×900 屏幕，记录真实窗口内容区；验证连接、重绑及截图 | 两次重新启动 Second Screen 后均能识别目标窗口；BOSS 已有实例的接管行为符合参数 |
| 3 调查页面 | 从已有会话检查在线简历、已收到附件、无附件、索取弹窗和登录失效状态 | 支持矩阵列出每条路线的元素、截图、定位方式与限制；本地保存原始证据，仓库仅放脱敏样本 |
| 4 验证输入 | 在每个必要容器中测试元素点击、返回、滚动；同时记录用户前台应用与真实指针变化 | 必需动作有可重复成功的后台路由；事件发送成功但页面无变化视为失败 |
| 5 验证产物 | 分别尝试可用附件保存和在线简历分屏采集，核对身份、内容、首尾及输出文件 | 至少一条路线产出身份明确、内容完整、可验证的简历；附件不可下载时记录事实 |
| 6 决定首条路线 | 汇总失败与替代方式，选定 P1 范围和可用定位 provider | 形成能力矩阵、首条流程定义和未解决问题清单；按实测重新估算 P1–P5 |

能力矩阵每行记录 appVersion、profile、页面/容器、动作、定位器、成功检查、尝试次数、成功次数、焦点/指针变化和证据路径。每条必需路线至少做三次独立成功尝试，并包含一次重新绑定窗口后的尝试；这只是进入开发阶段的门槛，不等同于生产可靠性证明。

进入 P1 的条件是：已有会话来源中，至少一条完整采集路线能后台执行，并正确关联候选人与文件。若只能采集短页面，P1 明确限制为已确认完整的短页面，长页面仍列为缺口。若必要的打开、滚动或保存动作都没有可用后台路线，先处理该底层缺口并复测，不通过扩大模型调用掩盖失败。

P0 的计划产物为 docs/boss-macos-capabilities.md、docs/boss-macos-baseline.md，以及经过脱敏的页面夹具。产物只记录已执行的检查，不提前填入“通过”。基线记录应包含当前 HEAD 与工作区差异；本次核对的 HEAD 为 329e052，已有六个 Swift 文件未提交改动，实施时需重新读取而非假定工作区未变。

**十四 可直接创建的开发任务**

| 编号 | 具体改动 | 验收依据 |
| --- | --- | --- |
| T01 | 固定当前基线，记录现有未提交改动，整理 source-map 与支持矩阵 | 不覆盖用户改动；既有功能测试基线可复现 |
| T02 | 录制 Mac 登录、列表、详情、在线简历、附件预览、无附件等脱敏状态 | 每种状态有元素树、截图、尺寸及真实操作结果 |
| T03 | 新建 task-runtime 包与 schema；实现 SecondScreenAdapter | 参数错误提前失败，旧 CLI 继续兼容 |
| T04 | 抽取 Setup 为 SessionManager，并将旧助手接入应用租约 | 两个任务不能争抢同一 BOSS；用户窗口不被无授权移动 |
| T05 | 添加 observe 能力：快照 ID、窗口内容区、缩放、可选截图 | 元素引用过期后重新定位；跨显示器移动坐标正确 |
| T06 | 实现 BOSS 页面分类、已有会话候选人引用和单份采集 | 确认正确人、正确简历、正确文件 |
| T07 | 实现 ArtifactStore、文件验证、分屏采集、元数据与 index | 原始/采集件类型准确，失败文件不计成功 |
| T08 | 实现账本迁移、worker、状态机、cancel/pause 与恢复对账 | 故障注入后从检查点恢复，状态查询不中断 |
| T09 | 实现批次迭代、虚拟列表进度、去重与停止条件 | 多页任务不会遗漏已识别未完成项，不在重复页无限循环 |
| T10 | 提取纯视觉 worker，按 P0 缺口接入局部模板/OCR | 无全局输入调用，缓存与局部识别有效 |
| T11 | AgentBridge 输出带预算和取消的执行轨迹 | Runtime 不重复执行 Bridge 已执行的动作 |
| T12 | 定义 Procedure V2、V1 importer、定位器和检查器 | 老流程不被破坏，新流程可独立版本化 |
| T13 | 实现工作单元学习、参数化、晋级、降级与回滚 | 第二位可回放，第三次验证后晋级；错误归纳被拒绝 |
| T14 | 实现局部恢复和模型熔断 | 正常路径零调用，异常只修复当前单元，预算耗尽停止 |
| T15 | 增加推荐来源、岗位筛选和不同简历分支 | 支持矩阵每条路径有验收证据 |
| T16 | 新增 task CLI/MCP、独立 SKILL.md 与 task.json | 用户无需 screen/PID 即可发起、查询、恢复任务 |
| T17 | 构建安装包、固定依赖、迁移旧配置、补清理策略 | 干净环境可运行，旧 BOSS 回复助手保留行为 |
| T18 | 跑验收矩阵、模型断网测试、长批次和崩溃恢复 | 输出逐项验收报告、真实调用计数及已知限制 |
| T19 | 独立 RemoteSink 与 outbox | 网络失败不使本地文件丢失，不误报远端成功 |
| T20 | WindowsAdapter、Windows profiles 与共同契约测试 | Windows 页面素材不混入 Mac 流程缓存 |

T01–T02 属 P0；T03–T07 先做最小纵向路径，完整恢复落 P2；T10 仅在观测缺口确认后增加。T11–T14 是自学习核心。任务可以按代码职责分工，但表中不假定额外人员已投入。

**十五 测试和正式验收**

本轮规划不执行真实招聘操作；实现后的测试分为纯逻辑、脱敏回放、受控桌面与授权账号验收。

1. 纯逻辑测试：状态转换、schema、坐标转换、槽位绑定、身份冲突、幂等键、预算、终止原因和数据库迁移。
2. 脱敏回放：从参考项目提炼页面类别，在 Mac 重新采样；验证列表解析、简历分支、弹窗识别和长页拼接。不得用生产简历直接提交仓库。
3. 桌面夹具：构建模拟 BOSS 的测试窗口，包含延迟加载、重排、同名候选人、弹窗、失效窗口和下载中断。复用当前 Windows TestTarget 的测试组织经验。
4. 实际 BOSS 验收：由已登录账号在确认范围内采集，不发送消息；记录每种路由是否抢焦点、是否移动真实鼠标及获取结果。

| 验收场景 | 必须满足 |
| --- | --- |
| 从未学习的单元 | 有限模型探索后，外部验证通过才保存流程 |
| 同批次第二位 | 立即尝试第一次学会的流程，不需要重启任务 |
| 三次成功后 | 晋级 stable；成功计数来自不同工作项且检查通过 |
| 稳定 20 位夹具候选人 | analysis=off，无异常，ui_model_calls=0；模型不可达仍完成 |
| 真实批次 | 以声明可访问的候选人作为分母，全部 committed 文件关联正确；不能用不可访问项掩盖错误 |
| 页面发生变化 | 本地失败有证据，修复产生新版本；不重新处理已完成候选人 |
| 下载完成但提交账本前崩溃 | 恢复后对账，文件只归档一次 |
| 同名候选人 | 不因姓名相同覆盖文件或合并记录 |
| 滚动无效或长页截断 | 报 partial_capture，不宣称完整简历 |
| 用户工作同时进行 | 支持后台的分支不移动真实指针，不持续夺取焦点 |
| pause/cancel | 建议目标：控制请求两秒内得到受理；最多五秒停止发新动作，未完成 IO 有超时和取消状态 |
| 新环境安装 | 显式安装依赖和权限后可调用 Skill，无需手工配置 screen/PID |

时间指标为待验证目标，不是现有性能。P0 记录基线后定最终阈值；正确人、正确文件、无未授权提交和零模型稳定回放是首版硬性条件。

**十六 发布与后续扩展**

按 existing CLI 保持兼容的方式增量发布。新 task 命令可先用功能开关启用；回滚时停止新 worker，恢复前一版 Skill/profile/Procedure，保留账本和产物。数据库迁移必须先备份并有兼容检测，旧版本不能静默读取不兼容 schema。

流程知识分两层保存：随 Skill 发布的可移植种子，以及本机按环境学习的覆盖版本。学习结果默认只留本地；共享时剥离候选人资料、账号和绝对路径，保留通用模板及必要验证样本。Skill 的脚本安装属于受信代码发布；模型修复只允许变更受限数据定义。

后续独立 Skill 可包括 boss.request-resume、boss.reply、boss.publish-job、resume.analyze。共享 Session、ProcedureEngine 和 ArtifactStore，各自声明外部操作权限和输入输出。手机端和更广泛的自动发现工作单元在桌面闭环可靠后推进。

项目首先应交付的成果是：在已登录的 Mac BOSS 中，一次调用获得一份正确关联、可验证的简历产物。随后扩展为批次和恢复，再验证首次学习后连续处理时不调用模型。每个阶段都留下能运行的版本，以实际执行结果推动下一阶段。

**十七 代码依据与阅读入口**

Second Screen 源码相对本文件所在目录的上一级：

- [应用屏幕管理](../Sources/SecondScreen/AgentScreens.swift)
- [控制协议](../Sources/SecondScreenCore/ControlProtocol.swift)
- [输入执行](../Sources/SecondScreenCore/InputEngine.swift)
- [当前 Agent 配置入口](../Sources/ScreenCLI/AgentCommand.swift)
- [Agent 执行循环](../Sources/TarsAgent/Agent.swift)
- [现有流程格式](../Sources/TarsAgent/Procedure.swift)
- [学习与回放](../Sources/TarsAgent/Learning.swift)
- [BOSS 自动环境准备](../agents/boss/src/setup.ts)
- [BOSS 状态存储](../agents/boss/src/store.ts)
- [BOSS 操作与验证](../agents/boss/src/boss.ts)
- [BOSS 当前业务入口](../agents/boss/src/cli.ts)

参考项目关键函数：boss_recommender_v1.py 的 build_candidate_identity、_capture_resume_dump、_capture_resume_long_screenshot、_summarize_resume_info；boss_message_handlerv3.py 的 _capture_attachment_resume_dump、_capture_online_resume_dump、_dialog_has_request_resume_confirm；core/cv_locator.py 的 _cached_search_region、_multi_scale_locate；boss_job_publisher_v3.py 的 _expected_box_from_relative、_relative_click_with_validation。

本文没有将源码分析等同于运行验证。实际后台滚动、附件下载、页面全量采集与窗口缩放兼容性，均列入 P0/P4 的明确验证项。
