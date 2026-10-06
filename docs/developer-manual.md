# AutoLandscape 开发者手册

## 1. 交接范围与基线

面向维护前端、Cloudflare Worker与计算服务器的开发者。依据修改日志、017后端和019前端交付代码整理。当前部署可能含手工调整，发布前须与实际源码比对，不用本文默认值覆盖现场配置。

架构：静态前端调用Worker；Worker使用D1维护任务与AI准入状态；计算服务器领取、复核和执行SaddleScape任务；可选私有R2保存结果。AI提供解释和受限建议，不直接批准计算。本文不假装已经取得fat01计算端源码。

边界：012论文检索候选没有并入当前基线；独立澄清额度已取消。R2尚未开启。并发、频率和项目额度实现完成且本地验证，三个线上边界验收暂缓。019会话管理只在浏览器端，不是服务器令牌撤销。

## 2. 环境变量与绑定

密钥使用Secret，不写入仓库、前端config.js或日志。布尔开关按代码严格比较字符串`true`，不是任意非空值。

| 名称 | 类型 | 当前代码默认/范围 | 作用 |
|---|---|---|---|
| AI_ENABLED | 文本 | 仅`true`开启 | 主AI功能开关 |
| AI_BASE_URL | 文本 | 必填HTTPS基础地址 | 主模型地址，程序追加`/chat/completions` |
| AI_MODEL | 文本 | 必填 | 主模型名，不在文档固定某供应商型号 |
| AI_API_KEY | Secret | 必填 | 主模型凭据 |
| AI_DAILY_LIMIT | 文本数字 | 默认20，范围1–100 | 每用户UTC日主模型次数；早期现场曾配置5，不等于当前固定值 |
| AI_CHAT_MAX_TOKENS | 文本数字 | 默认2400，整数256–8192 | 普通回答输出预算 |
| AI_DRAFT_MAX_TOKENS | 文本数字 | 默认3200，整数256–8192 | 生成结构化建议输出预算 |
| AI_ROUTER_ENABLED | 文本 | 默认关闭，仅`true`开启 | 请求范围分流；关闭也关闭该分流违规门禁 |
| AI_ROUTER_BASE_URL | 文本 | 开启分流时必填HTTPS基础地址 | 分流模型地址，不带账号、查询或片段 |
| AI_ROUTER_MODEL | 文本 | 开启分流时必填 | 分流模型名 |
| AI_ROUTER_API_KEY | Secret | 开启分流时必填 | 分流凭据，可与主模型独立配置 |
| AI_ROUTER_PROVIDER | 文本 | 默认openai，可选openai/deepseek | 分流请求格式；deepseek分支关闭thinking |
| AI_ROUTER_VIOLATION_LIMIT | 文本数字 | 默认10，整数0–1000 | 仅deny累积，超过阈值暂停当日AI |
| AI_ROUTER_GLOBAL_DAILY_LIMIT | 文本数字 | 默认200，范围1–100000 | 全项目UTC日分流准入次数 |
| AI_REQUESTS_PER_MINUTE | 文本数字 | 默认6，整数1–60 | 每用户自然分钟受理上限 |
| AI_GLOBAL_DAILY_LIMIT | 文本数字 | 默认200，整数1–100000 | 全项目UTC日主模型准入次数 |
| ALLOWED_ORIGINS | 文本 | 默认https://hisdpackage.github.io | 逗号分隔允许网页来源，影响CORS |
| DB | D1绑定 | 必需 | 权威任务、额度、租约与调用日志 |
| RESULTS | 私有R2绑定 | 可选，目前未启用 | 结果文件上传与下载 |

范围来自当前代码的裁剪与取整逻辑，不是配置非法值时一定报错；建议显式填写合法整数，不用空字符串或超范围值测试默认回退。供应商需支持实际token上限。

停用的旧变量：`AI_ROUTER_DAILY_LIMIT`不再限制个人正常分流尝试；`AI_ROUTER_CLARIFY_DAILY_LIMIT`不再读取。旧`ai_router_clarifications`数据可以保留，当前不读写。不删除历史表来“修复”计数。

主请求关闭thinking是已交付的DeepSeek接入选择，切换供应商前需核对请求兼容性，不能仅改模型名就保证可用。

## 3. 运行时固定值与前端配置

| 项目 | 当前值/行为 | 修改注意 |
|---|---|---|
| 分流超时 | 8秒 | 无有效决策时停止，不自动放行主模型 |
| 主模型超时 | 60秒 | 上游取消信号不保证供应商未计费 |
| AI前端等待 | 90秒 | 仅`/v1/ai/chat`使用该时限 |
| 其他前端请求 | `config.js`的requestTimeoutMs，交付基线45000ms | 不影响AI单独90秒 |
| 前端状态刷新 | activeRefreshMs/idleRefreshMs，基线5秒/30秒 | 隐藏页面降频；不是进度百分比 |
| AI单用户租约 | 120秒 | finally按lease_id释放，极端旧调用超过期限可能重叠 |
| 计算任务租约 | Worker LEASE_MS 180000ms | 与AI租约不同，不互相替代 |
| 草案与模型历史 | 最近8条消息，每条最多3000字符 | 输入过长会截取，不宣称完整上下文记忆 |
| AI请求体 | 64KB | 草案另有16KB UTF-8上限 |
| 任务JSON导入 | 前端30000字节上限 | 不等于AI草案发送上限 |
| 会话空闲 | 前端30分钟 | 普通刷新、轮询与响应不延长 |

## 4. AI请求路径与计数

`/v1/ai/chat`支持mode=chat/draft，要求allow_external=true，可选context与job_id。草案模式禁止job_id。前端目前无附件上传、论文检索或历史会话后台接口。

当前流程：身份与开关 → 每用户频率/租约 → 消息及上下文校验 → 可选分流 → 主模型个人预占/项目准入 → 调用元数据记录 → 模型调用 → 响应与草案校验 → 成功返回或失败退款 → 租约释放。

频率准入在消息校验之前，包括无效输入、deny与失败，不退款。无效消息不会占个人主额度。这两个规则不矛盾。

| 路由结果 | 主模型 | 个人主次数 | 违规 | 项目分流次数 |
|---|---|---|---|---|
| allow | 调用 | 预占一次，部分失败退回 | 不增加 | 已准入则增加 |
| clarify | 调用，最多3个关键澄清问题 | 与allow相同 | 不增加 | 已准入则增加 |
| deny | 不调用 | 不增加 | 有效deny增加至阈值+1封顶 | 已准入则增加 |
| 分流错误/超时 | 不调用 | 不增加 | 不增加 | 已准入不退 |
| 已暂停/频率或并发拦截 | 不调用 | 不增加 | 不增加 | 模型前门禁拦截不增加 |

所有每日计数使用UTC日期，北京时间08:00换日。违规默认第1–10次计数拒绝，第11次暂停；10次后相关请求仍可用。没有独立澄清次数。

主模型项目计数是**准入尝试**，成功/失败不退，甚至准入后的日志插入失败也保留。分流先于项目主额度检查，因此主项目额度耗尽时仍可能消耗分流。网站个人次数退款不等于供应商退款。

主要错误：AI_BUSY/AI_RATE_LIMIT为429；AI_ADMISSION_DB停止准入；AI_CALL_LOG_DB阻止对应模型发出；AI_ROUTER_*说明分类阶段失败；AI_OUTPUT_LIMIT拒绝截断草案；AI_REFUND_FAILED需管理员核对。

普通文本不再使用12000字符截断。返回finish_reason和output_truncated；length时普通回答附提示，不自动续写。草案length不解析/应用。前端停止等待时不能推断服务已结束或退款成功。

## 5. D1迁移、调用记录与查看

| 表 | 用途 |
|---|---|
| ai_usage | 用户主模型每日used |
| ai_router_usage | 当前使用global范围分流次数，旧user记录不再用于限制 |
| ai_router_violations | 用户每日deny次数 |
| ai_request_admission | owner唯一，window_id/used/lease_id/lease_until实现准入 |
| ai_project_usage | 项目主模型每日准入used |
| ai_call_log | router/main元数据，每条id，同请求共用request_id |

部署先执行与当前版本匹配的迁移，再发布Worker。017迁移包含016准入表的CREATE IF NOT EXISTS，但不代替更早的基础任务/主额度/分流表迁移。保留历史数据，不执行无关DROP。

日志记录owner、stage、模型、格式、时间、HTTP状态、finish_reason、token及错误码；不保存问题、上下文、回答、密钥、接口URL或完整供应商响应。缺失usage记NULL，不估算费用。

- started可能在途、异常终止或更新失败。
- response_received仅表示HTTP成功且JSON可解析，不表示结构化内容合法或答案正确。
- 主模型routing_decision为空正常，decision属于router记录。
- 调用前日志插入失败停止模型；调用后更新失败只记脱敏错误，不覆盖已经获得的回答。

管理员在D1查看，当前没有浏览器管理员日志API：

```sql
SELECT datetime(started_at/1000,'unixepoch','+8 hours') AS beijing,
       request_id, owner, stage, model, status, http_status,
       duration_ms, routing_decision, finish_reason, total_tokens, error_code
FROM ai_call_log
ORDER BY started_at DESC LIMIT 30;
```

```sql
SELECT request_id, stage, status, routing_decision, total_tokens
FROM ai_call_log
WHERE request_id = '替换为查询得到的请求编号'
ORDER BY started_at;
```

```sql
SELECT day, used FROM ai_project_usage
WHERE day = strftime('%Y-%m-%d','now');
```

分流开启时allow/clarify通常两条router/main，deny仅router。日志关联验证已见线上样本；高并发、频率与项目耗尽线上验收仍待办。

## 6. 上下文与草案协议

草案快照从网页JSON读取，与模板下拉选择分别标记。服务器只保留允许顶层字段，并把最新快照与当前提问放在历史之后。context_receipt直接回显model_id/dimension/target_index；/v1/me中ai_context_version=2用于兼容判断。

job_id按owner权限查询，只取状态、时间、提交配置三字段、有限telemetry/错误/summary及最多10个节点。提交配置目前不含完整预算/validation，不能让模型用编辑框预算替代该任务预算。文本会限长并明确截断；不读取R2、图片或完整文件。

受限草案字段：

| 字段 | 类型与范围 |
|---|---|
| project.name | 文本1–120，不能仅空白 |
| project.description | 文本0–3000 |
| objective.target_index | 整数0–dimension |
| objective.initial_point | 长度=dimension的有限数数组 |
| objective.perturbation_radius | 数值0<值≤10 |
| solver.timestep | 数值0<值≤10 |
| solver.tolerance | 数值0<值≤1 |
| solver.max_iterations | 整数1–1000000 |
| solver.seed | 整数0–2147483647 |
| validation.residual_threshold | 数值0<值≤1 |
| resources.walltime_seconds | 数值0.1–3600 |
| resources.memory_mb | 整数128–8192 |
| resources.cpu_threads | 整数1–4 |

这只是Worker的建议范围，计算服务器还可能限制cpu_threads≤2等。AI不能据此承诺服务器接受。

模型输出message与changes，程序从原草案克隆并校验，拒绝未知/重复字段、非法值和额外属性；系统定义须与公开模板相符、算法保持模板方法。不让模型重写整份规格。应用前比对生成时JSON与表单快照，已变化则拒绝覆盖。参数校验不证明收敛。

## 7. 前端与会话

- index.html：工作台、帮助、表单、任务详情，保留原核心ID。
- app.js：API与生命周期、导航、AI、当前标签页会话。
- render.js：Markdown、公式、链接协议、代码复制和HTML清洗。
- vendor：本地Marked、DOMPurify、KaTeX及字体许可证。
- config.js：用户现有API和刷新配置，替换包不覆盖。

019存储键为autolandscape.session.v1，保留token/lastActivity/chat。30分钟空闲超期、手动退出、HTTP401清除；普通刷新先验证用户与模板，恢复单聊天。用户真实交互延长期限，轮询和返回不延长。AI同意、任务选择、未保存配置与候选建议不持久化。不要将其描述为后端鉴权时效或跨设备会话。

epoch隔离退出后的迟到响应；任务刷新绑定请求时选中ID，避免旧任务覆盖新任务。无选中任务时普通对话不发job_id，本轮提示未选任务；该提示是模型数据，不是自动读取能力。

渲染raw HTML转义，DOMPurify清洗，KaTeX trust=false，仅允许HTTP(S)/锚点链接，不自动加载外部图片。剪贴板要求HTTPS/localhost。CSP允许当前API来源；改API时同时改connect-src，不能只改config.js。

## 8. 任务与结果保持的约束

AI不提交或批准任务。创建/重启保留Idempotency-Key，确认发送reviewed与plan_hash。方案一小时后过期。退出或关闭页面不取消计算；中断不自动重试。

export-record只导出详情快照。最近日志是log_tail，本次样本6000字符，后端最终telemetry还有总大小限制。完整日志应写独立文件，不增大telemetry到无界。

结果上传须有效活动租约；RESULTS关闭返回R2_DISABLED。单文件1字节–8MiB，当前Worker总量128MiB且少于40项，计算端/任务预算可能更严格。文件名和SHA-256受校验，同名内容不可变；前端下载按hash检查，分块ZIP合并再验完整包。私有文件通过任务owner接口下载，不要求公开桶。

计算端源码尚未取得，不能确认日志文件名、目录和上传列表。旧任务终态不能经原接口直接补传；需管理员单独方案。

## 9. 发布与文档维护

文档源放仓库docs；公开用户手册HTML/PDF/Markdown副本放frontend/docs。Pages当前只发布frontend，所以只放根docs不会自动公开。

网页帮助相对链接`./docs/user-manual.html`与`./docs/user-manual.pdf`，适配仓库Pages子路径。完整手册可从根docs修改后使用tools/build-manual.cjs重新生成。根docs的开发者、交接、演示文档不会由当前Pages工作流自动发布。

交付的网页帮助只改index.html，不替换用户API配置和后端。先合并文件，执行文档构建/链接检查，提交main等待现有Pages工作流完成。无GitHub连接时提供合并包，不声称已经推送。

## 10. 维护与回归重点

一项行为变更至少核对相关对象、额度路径与用户确认：普通/草案模式、附带/未附带、无任务/有任务、非法输入、deny/clarify、主失败、会话退出/过期以及模板边界。

完成基础流程再做线上准入边界。不要为演示耗尽真实额度，也不自动重试模型。性能排查先用同输入/实现/计时范围作对照，再分阶段测量，避免通过改变算法精度“优化”耗时。

全部剩余项目见同目录change-summary-and-todos.md。知识增强、论文检索和微调区分记录；未审核回答不可成为经验库事实。
