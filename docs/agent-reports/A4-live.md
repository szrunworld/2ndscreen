# A4 真实集成跟进报告

## 范围

基于集成提交 `151b134`（含 A4 原版 `0fcf102`、A5/A8）。只改 `agents/boss/src/resumes/**`、`packages/task-runtime/tests/boss-resumes.test.ts` 与本报告。未接触真实 BOSS、桌面或 `/tmp/2ndscreen-p0` 原始数据；所用的真实形状全部来自协调者给的脱敏说明。没有合并、没有推送，没有使用子代理。

分支 szrunworld/ss-a4-live：
- `5fd791a`：三处修正与回归测试。
- 本报告单独提交。

## 1. 在线简历顶部：用表头姓名替代 BOSS 标志

**问题（P0）**：`topMarkerVisible` 要求在顶部 20% 的 OCR 中出现 `boss直聘`，但 BOSS 1.7.4 的在线简历 AXImage 顶部是头像、姓名、活跃状态，然后是个人摘要，没有标志。所以 `topConfirmed` 永远为假，任何简历都不可能完整。

**现在的规则**：`topConfirmed = 上滚稳定 && 起点探测 && 表头姓名`，三者缺一不可。

1. **上滚稳定**（不变）：向上滚动直到一次滚动不再改变内容区。
2. **起点探测**（新增，与末端探测对称）：从顶部画面向下滚一步必须改变内容；再向上滚回必须与顶部画面相同；再向上一步必须不变。探测画面不保存。探测最后一屏就是保存的第一页。
3. **表头姓名**（新增，`headerShowsName`）：在第一页 OCR 中，有一行满足以下全部条件：
   - 规范化后（NFKC、去空白、全角括号、小写）**恰好等于**传入的候选人姓名；或等于“姓名 + 活跃状态”（`HEADER_ACTIVITY`：刚刚活跃/今日活跃/昨日活跃/本周活跃/本月活跃/半年内活跃/N日(天/周/月)内活跃/在线），以防 OCR 把同一行合并；
   - 该行顶边在内容区顶边以下 `headerMaxPt`（默认 120 pt）之内，按截图实测的像素/点换算，不假设缩放；
   - 该行左边在截图宽度 60% 以内（头像之后）；
   - **它之上没有任何其他文字行**（以其他行的垂直中心是否高于姓名行顶边判断；同一行右侧的活跃状态不算在上方）；顶边被裁掉的边框行（底边不超过内容区顶边）不计入。

所以：姓名只出现在正文中、出现在别的文字下方、出现在更长的一行里（如“陈一的项目经历”）、跟着非活跃状态的字（如“陈一刚刚”）、位于表头带以下或页面右侧，都不算。姓名是参数，代码里没有写死。

**身份**：`captureOnlineResume` 中“覆盖层 AX 无姓名时用简历文字确认身份”的后备，原来是第一页任意位置包含姓名，现在改为同一个 `headerShowsName`。注意，工作流的 `open_resume` 本身仍要求覆盖层侧栏的 AX 文本恰好是姓名，否则返回 `resume_identity_unconfirmed`，所以走工作流时表头后备不会放宽身份；只有直接调用 `captureOnlineResume` 才会用到后备。

**不变的部分**：两个独立的底部信号（页脚声明 + 末端控制探测）、未展开/拼接缺口/页数上限都判为部分采集、`contentRoi` 右侧 8 pt 滚动条与顶部 1 pt 边框行（2x 下 x0 y2 1452×1694）都未改。

**接口变化**：
- 删除 `TOP_MARKER`、`topMarkerVisible`。
- 新增导出 `HEADER_ACTIVITY`、`HeaderBand`、`headerBand(shot, limits)`、`headerShowsName(ocr, name, band)`。
- `CaptureLimits` 新增 `headerMaxPt`（默认 120）。
- `metadata.json`：`identity.resumeName` 改名为 `identity.resumeHeaderName`；新增 `top: { upScrollStable, startProbe, headerName, headerMaxPt }`（只有布尔值和数字，不含姓名）；顶部未确认时 `problems` 增加 `top_unconfirmed: up_scroll_kept_moving | start_probe_failed | header_name_not_first_row`。
- 每次采集多 3 次滚动和 3 张截图（起点探测）。

**约束与需要 P0 核对的地方**：
- 120 pt 和左侧 60% 是按“头像 + 姓名在最上方”的形状定的保守值，没有真实坐标。请协调者用 P0 的脱敏几何确认姓名行顶边距离内容区顶边多少 pt、x 起点在哪。
- 若真实 OCR 在姓名上方读出其他文字（例如头像上的徽章字），或姓名与活跃状态以外的字合并成一行，表头会判为不成立，结果是部分采集，不会误判为完整。
- 一屏就能装下的简历：向下滚动不改变内容，起点探测失败，`topConfirmed` 为假。这与原有“一屏简历不判完整”的规则一致（末端探测本来就要求有过滚动）。

## 2. select_source：不改路线，只区分诊断

P0 报告：点击 AXStaticText `全部职位`（相对 155,29，52×16）和旁边 12×12 的 AXGroup 箭头（416,31）都返回 ok，但多次观察的 AX 树完全不变，结果 `job_options_not_shown`。

按要求没有加坐标后备，没有放宽职位匹配，也没有把已选职位当成已验证。已选职位的校验保持原样：筛选标签必须恰好等于任务职位，或等于本任务 `select_source` 唯一匹配出的选项；包含关系和歧义一律不接受。

唯一的改动：选项为空且点击后的树中每个元素（文字@位置）都在点击前出现过时，原因变为 `job_options_not_shown: the filter click changed nothing in the accessibility tree`，前缀不变，便于区分“点击无效”和“菜单出现但读不到选项”。

建议协调者探测（只读或一次性）：
1. 点击前后各截一张图：菜单是否在视觉上打开了而 AX 树没变？
2. 点击**之前**的树里是否已经有职位名（隐藏的菜单节点）？`optionsOf` 会排除点击前已在同一位置出现过的文字；如果菜单节点一直存在只是隐藏，打开后也会被判为“没有选项”。
3. 菜单是否在观察的窗口之外（单独的 AXWindow、弹出层、AXMenu），或角色是 AXMenuItem/AXButton/带 label 的 AXGroup，而不是 AXStaticText？
4. 会话的元素点击实际是 AXPress 还是真实指针事件？对 AXStaticText/AXGroup 的 AXPress 可能直接返回成功但什么也不做。可以只作为探测，对父 AXGroup 中心（相对 x140+151, y20+17，即 291,37）发一次指针点击。
5. 是否需要窗口先成为 key window（第一下只激活窗口），或需要悬停才展开。

拿到证据后再改路线；改的时候唯一/精确匹配规则不动。

## 3. open_candidate：等待会话表头加载完

**问题（P0）**：点击正确的行后，新页面已有 AXTextArea，被分类为 `conversation_detail`，但表头还没加载；`identify` 返回“表头无姓名”的歧义，`openCandidate` 的轮询把任何歧义都当成终止，返回 `identity_ambiguous`。稍后的新观察能正确匹配。

**修正**：`candidates.ts` 把四种“只是还没画完”的歧义集中为 `INCOMPLETE`，新增导出 `identityIncomplete(match)`：无会话、表头无姓名、会话无职位、只有姓名没有摘要和经历。`openCandidate` 的有界轮询（`openTimeoutMs`，默认 15 s）在页面不是会话、姓名不符、身份不完整时都继续等，只有匹配或无法靠等待消除的歧义（同名同岗、列表行无职位、列表中重复）才提前结束。超时时：最后一次观察仍是不完整身份就返回新的 `identity_incomplete`，否则仍是 `conversation_not_opened`（姓名一直不符时也是这个，与原测试一致）。不完整的身份从不被接受；`verifyUnit('open_candidate')` 对单次不完整观察仍判失败。

## 测试

新增或改写的回归（合成夹具，无真实数据）：
- 合成简历改为真实形状：去掉 `BOSS直聘` 标志行，第一行是姓名 + 同行右侧“刚刚活跃”，然后是摘要。原有完整采集、滚动条/边框 ROI（2x、3x）、各种部分采集的测试在新形状下全部通过。
- `headerShowsName` 单元测试：精确/规范化匹配、姓名与活跃状态合并、同行活跃状态在左侧、换一个候选人姓名、空姓名、更长行中的姓名、姓名后跟非活跃字、**正文中段重复出现的姓名**（其上有别人的表头）、姓名之上有其他文字、表头带以下、右侧、被裁边框行。
- 表头是别人、正文第二行恰好是本人姓名：`topConfirmed` 为假、部分采集、元数据记录 `header_name_not_first_row`；去掉覆盖层姓名后直接采集被拒为 `resume_identity_unconfirmed`；表头正确时直接采集完整。
- 起点探测：从 20 px 处打开且第一次上滚失效，姓名仍是第一行文字，但起点探测发现还能再往上，`topConfirmed` 为假，两个底部信号照常成立；从页面中段打开且滚动正常时能回到顶部并判完整。
- 异步表头：`headerDelayMs` 按真实时钟先无表头、再只有姓名和职位、最后全部出现；`open_candidate` 等到加载完才匹配（耗时 ≥ 55 ms，只点一次行）；单次空表头/只有姓名的观察被 `verifyUnit` 拒绝；一直不加载则 `identity_incomplete`；同名同岗即使表头延迟加载也仍是 `identity_ambiguous`。

运行结果：
- `packages/task-runtime`：`npm run typecheck` 通过；`npm test` 262 个，261 通过、1 跳过（原有）、0 失败。其中 `boss-resumes.test.ts` 39 个全部通过。
- `agents/boss`：`npm run typecheck` 通过；`npm test` 15 个全部通过。

## 未完成

- select_source 的真实打开路线：等协调者的 P0 证据。
- 表头带的 120 pt / 60% 和活跃状态词表需要用 P0 脱敏几何与 OCR 结果核对。
- 以上都没有在真实 BOSS 上运行过。
