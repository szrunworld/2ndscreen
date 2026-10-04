# 交接：设备与执行器管理页（交给服务器端 / ATS 门户）

日期：2026-10-04。用户决定：设备管理、登录、执行记录等管理页放在服务器端，Monitor 不再自建控制台（原任务 I1、I2 撤销）；时间路线 A——Monitor 先独立运行，ATS 到 P2 时再把指令来源切换为 ATS 的渠道任务（channel_task）。

建议位置：ATS 门户中"渠道 / 执行器"管理（ATS 已有 `channel_account`，设计里规划了 `channel_task` 与执行器）。后端暂用 Monitor 的薄桥接服务（`monitor/server`），接口定义见 `monitor/contracts/openapi.yaml` 与 `docs/monitor/api.md`；ATS 定义执行器契约后再迁移。

## 一、页面需求

只放设备与执行相关信息，不放任何候选人业务（候选人、流程、简历、总览归 ATS）。

| 页面 | 内容 | 接口 |
| --- | --- | --- |
| 设备列表 | 名称、模式（本机 / 独立设备）、在线状态（90 秒无心跳为离线）、最近心跳、绑定的运营与 BOSS 账号、当前动作、待执行 / 待回传数、最近异常 | `GET /devices`、`GET /devices/{id}` |
| 新增设备 | 选模式、选绑定的运营与 BOSS 账号 → 生成一次性注册码；页面显示安装命令 `monitor install --enrollment-code <码>` | `POST /device-enrollments` |
| 设备详情 | 暂停 / 恢复、吊销令牌、确认账户绑定 | `POST /devices/{id}:pause`、`:resume`、`:revoke`、`PUT /devices/{id}/account-binding` |
| 登录（仅独立设备） | "设备需要登录"卡片：渲染二维码、倒计时，过期显示"等待刷新"不显示旧码；查看记录；需要人工输入时（短信验证码等）的输入框，只在 `can_fill=true` 时可填 | `GET /devices/{id}/login-qr`（410=过期）、`GET /devices/{id}/login-qr/views`、`POST /input-requests/{id}/response` |
| 执行记录 | 时间、动作、目标、执行状态、回传状态；"结果待确认"只给"重新检查界面状态 / 人工确认已发送 / 停止"，**不提供重试** | `GET /commands`、`GET /commands/{id}`、`POST /commands/{id}:recheck`、`:confirm-sent`、`:cancel` |
| 搜索（可选） | 提交关键词、查看当前页快照；三种结局（有结果 / 确认无结果 / 无法读取）分开展示；不能从结果发起问候 | `POST /search-runs`、`GET /search-runs/{id}` |

线框参考：claude.ai 画布"招聘 Monitor 线框图"中的"连接与策略""执行记录""搜索"三页与本机状态窗口；候选人流程与总览两页作废（归 ATS）。

## 二、绑定流程

```
管理员在门户：新增设备 → 选模式 → 选运营与 BOSS 账号 → 生成一次性注册码
在 Mac 上：monitor install --enrollment-code XXXX（检查权限等前提，注册设备，令牌存 keychain）
设备出现在列表、在线 → 管理员确认账户绑定 → 开始领取指令
独立设备：开机自启；未登录时二维码出现在门户，账号本人手机扫码
```

## 三、客户端保留

- 本机状态窗口：模式、账户、BOSS 客户端状态、当前动作、待执行 / 待回传、最近异常；"暂停并归还窗口"（本机模式）/"暂停自动操作"（独立设备）；"打开控制台"链接。
- 离线时本机仍显示"离线，暂停领取指令"。

## 四、Monitor 服务端里不再扩展、待 ATS 接手后移除的部分

`/cases*`、`/overview`、`/accounts/{id}/policy`（任务 F2，冻结）；`/resume-documents*`、`/mail-messages*`、`/mail-verifications`（随邮件接入交接，见 handover-mail-ingestion.md）。设备、指令、事件、登录接力、搜索接口保留，作为执行器桥接。
