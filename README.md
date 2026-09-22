# dsh-pages

DSH 内置 RSS 阅读器：Docker 数据层（RSSHub + wewe-rss）+ DSH 插件（`packages/reader`）。

## 当前状态（✅ P4 知识库收官）

- [x] P0：RSSHub(:1200) + we-mp-rss(:8001) 容器化运行
- [x] P1：三栏阅读器（订阅/抓取/未读/全文/图片代理/深色模式内联色中和）真实宿主验证通过
- [x] P2：10 个 agent 工具（reader_* × 6 + kb_* × 4）经 `agent/created` per-agent 注入，子代理实测通过
- [x] P3：星标 / 关键词过滤 / OPML 批量导入
- [x] 公众号：weread_mp 扫码授权 → 全文 + mmbiz 图片代理实测 200
- [x] P4 知识库：📚 视图（搜索/详情/笔记）+ 文章 📥 收藏 + 日报 📨 归档 + `kb_save/search/read/list` 工具，子代理检索实测通过
- [x] P5 安全与可靠性加固：两层 HTML 消毒 / per-record 存储 / 星标豁免裁剪 / 刷新防重入 / 真宿主探针
- [x] P6 信息架构重构：两个空间一个舞台——「阅读/知识库」分段切换、订阅与知识库分离导航、共享持久阅读舞台（文章↔笔记推栈往返）、未读/全部/星标分段视图、SVG 图标与 toast 轻提示；纯 client.js，UI 状态 localStorage 持久化
- [ ] 可选后续：qdrant + embedding 语义检索（关键词检索不够用时）；接 dsh-schedule 定时日报

## 插件开发约定（血泪教训）

- **运行时形态**：当前桌面壳的已安装 bundle **没有 `harness`/`host` 内建符号**，client↔host 通信走同源 HTTP 路由（`webServer.register` + 浏览器 fetch），参照 `im-channel` 等已装插件
- **cordis 严格上下文**：`ctx.x` 访问未声明注入的属性会直接抛错——服务一律走 `inject` 声明，探测性访问必须整条 try/catch
- **`ctx.inject` 回调只在顶层有效**：嵌套 inject 的回调会静默丢失（不执行也不报错）——多个服务分多个顶层 inject，跨作用域共享用模块级变量赋值
- **静态 `export const inject` 决定挂载顺序**：运行时 `ctx.inject` 回调对**尚未挂载**的服务同样静默丢弃——用到的服务全部写进静态 inject（范式：im-channel `['agents','tools']`），加载器会等服务齐了再启动插件
- **webServer 前缀路由不带尾斜杠**：匹配规则是 `pathname === prefix || startsWith(prefix + '/')`，注册 `/reader-api/` 会让所有子路径 404；正确是 `/reader-api`
- **存储域单元名规则** `/^[a-z][a-z0-9_]*$/`（连字符/大写非法），表名同规则
- **存储域选 per-record 布局**：single 布局每次 `put` 都把整个单元 JSON 全量重写落盘（全文 HTML 下是灾难级写放大），声明 `layout: 'per-record'` 一记录一文件；`compatibleVersions` 也只对 per-record 生效
- **远程 HTML 进 innerHTML 前必须消毒**；纯文本渲染必须先整体转义再恢复结构（`kbRender` 先 escape 再链接化）——CSS `!important` 中和解决的是审美不是安全
- **`apply()` 绝不抛错**：装载期异常会拖死整个宿主；入口必须顶层 try/catch 兜底
- **link 插件依赖自持**：改动 `packages/reader` 后先在该目录 `npm install`，再 `node ../scripts/smoke-reader.mjs` 干跑验证，最后才重启宿主
- **host 代码改动需重启 DSH Desktop 生效**；**client bundle 在宿主激活时被一次性快照**（`dsh-client-modules` 读源码算 rev 进内存，路径 `/plugins/<id>/client.js?rev=`）——改 `client.js` 后必须重启宿主（或让 HMR 发布新 rev），**只按 F5 拿不到新源码**；"改了样式没生效"优先怀疑页面还在用旧快照，而不是样式写错
- **槽位是功能性契约，不是空白留白**：single 型槽位（如 `sidebar.workspaces.directoryFlow` =「添加工作区」入口）被第二家注入会拖垮整个 web boot 且零报错零日志——加页面的正确姿势是 `sidebar.panellist` 图标 + `main` 面板（list 型槽位多占合法，参照 reader）；挂载失败面板会把错误吞成摘要，细节要从 `window.__DSH_BOOT__` 的 bundle URL（404 = 批内任一 client.js 缺失）和「对照实例 A/B 实验」里挖

## 安全模型（两层 HTML 消毒）

订阅内容是远程不可信输入，渲染管线两层防御：

1. **服务端正则快滤**（`packages/reader/index.js` `sanitizeHtml`，所有 `/reader-api/item` 响应出口生效）：删除 script/iframe/svg/form 等危险容器、`on*/style/data-*` 等属性；URL 属性（href/src/poster）实体解码 + 控制字符剥离后做协议白名单（http/https/mailto/相对地址，src 另放行 `data:image/*`），防 `&#106;avascript:`、`java\tscript:` 变体；懒加载 `data-src` 先迁移为 `src` 再清理
2. **客户端 DOMParser 白名单重建**（`packages/reader/client.js` `sanitizeArticleHtml`，`dangerouslySetInnerHTML` 前最后一道）：用浏览器解析器按标签/属性白名单重建 DOM，解析器差异由浏览器语义兜底；外链统一 `target=_blank + rel=noopener noreferrer`

知识库视图 `kbRender` 走纯文本通道：先整体 HTML 转义，再恢复标题/列表/链接结构——feed 标题里的尖括号不可能成为活标签。

- webServer 路由层无鉴权：`/reader-api` `/reader-media` 仅限本机回环使用，**勿把 webServer 绑定 0.0.0.0**
- 媒体代理：随机 secret 门禁 + 协议白名单防 SSRF；下载字节上限 15MB（content-length 缺失时按实际字节数兜底）；请求体上限 5MB

## 可靠性设计

- **存储**：`dsh_pages_reader` 为 per-record 布局（一记录一文件）。以新代码首开时由存储后端自动从旧 single 文件迁移（legacy bootstrap），旧 `storages/dsh_pages_reader.json` 原样保留，确认数据完整后可手动删除
- **留存**：每订阅保留最新 120 条，**星标条目无论多旧一律豁免裁剪**
- **刷新**：`refreshAll` 防重入（进行中再触发返回 `{skipped:true}`）+ 订阅间并发 4；抓取合并在存储域写链内用 `update` 原子完成，并发的已读/星标标记不会被覆盖
- **验证**：
  - `node scripts/smoke-reader.mjs`——mock 宿主干跑（严格上下文 + 合成敌意源 + 裁剪回归），前置 RSSHub 容器在 :1200
  - `node scripts/probe-host.mjs`——**真宿主契约探针**（只读端点形状 + 错误密钥 404 + 服务端消毒生效 + 订阅增删自清理），宿主重启加载新代码后跑一次；mock 测试防不住的宿主漂移靠它显式暴露
  - 工具平面：以新会话工具清单含 10 个 `reader_*`/`kb_*` 工具为准

## 启动 / 停止

```powershell
cd E:\Development\Code\nodejs\dsh\dsh-pages
docker compose up -d      # 启动
docker compose down       # 停止（数据保留在 ./data）
docker compose logs -f    # 看日志
```

## RSSHub（通用源）

- 地址：http://localhost:1200
- 路由文档：https://docs.rsshub.app/routes/
- 验证示例（已实测可用）：
  - 少数派 Matrix：<http://localhost:1200/sspai/matrix>
  - 36氪快讯：<http://localhost:1200/36kr/newsflashes>
  - B站热门：<http://localhost:1200/bilibili/popular/all>
  - 把路由路径拼在 `http://localhost:1200` 后面即为订阅地址
- 注意：部分路由需要额外配置才启用（如 GitHub Trending 需要 `GITHUB_ACCESS_TOKEN`），访问时会明确报错提示，详见 https://docs.rsshub.app/deploy/config

## we-mp-rss（微信公众号 · 现役方案）

- 背景：wewe-rss 的登录中转站（weread.111965.xyz）长期宕机且社区有项目衰退迹象，改用 [we-mp-rss](https://github.com/rachelos/we-mp-rss)
- 管理页：http://localhost:8001，默认凭据 `admin / admin@123`（可用环境变量 USERNAME/PASSWORD 覆盖）
- **采集模式：`weread_mp`（微信读书）**——compose 中 `GATHER.MODEL=weread_mp`，直连 weread.qq.com 无第三方中转，**普通微信扫码即可，无需自有公众号**（默认 app 模式需要名下有公众号，不要切回去）
- 授权入口：管理页顶部导航「微信读书」→ 扫码授权 → 手机上确认登录
- **硬限制**：微信读书已废弃文章列表接口，每次只取每号最新一篇、无历史回补；新文章随发布逐步积累
- feed 地址格式：`http://localhost:8001/feed/<MP_WXS_*>.<rss|atom|json>`，聚合源 `/feed/all.atom`
- 全文输出默认开启（RSS_FULL_CONTEXT=True）；Access Key 认证可用于程序化 API
- 教训记录：选采集方案**先核实授权前置条件**（是否要自有公众号/是否依赖第三方中转），再部署

## wewe-rss（微信公众号 · 已冻结，备用）

- 管理页：http://localhost:4000
- 登录授权码：见 `.env` 的 `WEWE_AUTH_CODE`
- 首次使用：
  1. 打开管理页，输入授权码登录
  2. 「账号管理」→ 添加账号 → **用微信扫码登录微信读书**（建议使用小号，cookie 过期后需重新扫码）
  3. 「公众号管理」→ 搜索并添加要订阅的公众号
  4. 「订阅源」中复制每个公众号的 feed 链接，或直接用聚合链接：
     - 全部更新：<http://localhost:4000/feeds/all.atom>
     - JSON 格式：<http://localhost:4000/feeds/all.json>
- feed 地址本身无需授权码，可直接交给阅读器/插件消费
- 更新频率：`docker-compose.yml` 中的 `CRON_EXPRESSION`（默认每 35 分钟）

## 已知注意事项

- 图片防盗链按站策略相反（已由插件图片代理适配）：微信 `mmbiz.qpic.cn` 必须**无** Referer；少数派 `cdnfile.sspai.com` 必须带主站 Referer；其余源先无 Referer、403 时退化为源站 Referer 重试
- wewe-rss 依赖微信读书接口，高频调用有风控概率；几十个号用默认频率即可
- **wewe-rss 的扫码登录依赖免费中转服务 `weread.111965.xyz`**，该服务偶有宕机（表现为二维码一直"加载中"），等其恢复后重试即可
- **安全提醒**：登录会话经由上述第三方闭源中转转发，社区有[信息安全争议](https://github.com/cooderl/wewe-rss/issues/385)——务必使用微信读书小号扫码，不要用主力微信
- RSSHub 公共路由质量参差，失效路由去 https://github.com/DIYgod/RSSHub/issues 查
