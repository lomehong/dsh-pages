# dsh-pages

DSH 内置 RSS 阅读器：Docker 数据层（RSSHub + wewe-rss）+ DSH 插件（`packages/reader`）。

## 当前状态（✅ 全链路收官）

- [x] P0：RSSHub(:1200) + we-mp-rss(:8001) 容器化运行
- [x] P1：三栏阅读器（订阅/抓取/未读/全文/图片代理）真实宿主验证通过
- [x] P2：6 个 `reader_*` 工具经 `agent/created` per-agent 注入，子代理真实调用出日报
- [x] P3：星标 / 关键词过滤 / OPML 批量导入
- [x] 公众号：weread_mp 扫码授权 → 全文（最大 14 万字符）+ mmbiz 图片代理实测 200
- [ ] 定时日报（下一步可选）：接 dsh-schedule 每天自动出报

## 插件开发约定（血泪教训）

- **运行时形态**：当前桌面壳的已安装 bundle **没有 `harness`/`host` 内建符号**，client↔host 通信走同源 HTTP 路由（`webServer.register` + 浏览器 fetch），参照 `im-channel` 等已装插件
- **cordis 严格上下文**：`ctx.x` 访问未声明注入的属性会直接抛错——服务一律走 `inject` 声明，探测性访问必须整条 try/catch
- **`ctx.inject` 回调只在顶层有效**：嵌套 inject 的回调会静默丢失（不执行也不报错）——多个服务分多个顶层 inject，跨作用域共享用模块级变量赋值
- **静态 `export const inject` 决定挂载顺序**：运行时 `ctx.inject` 回调对**尚未挂载**的服务同样静默丢弃——用到的服务全部写进静态 inject（范式：im-channel `['agents','tools']`），加载器会等服务齐了再启动插件
- **webServer 前缀路由不带尾斜杠**：匹配规则是 `pathname === prefix || startsWith(prefix + '/')`，注册 `/reader-api/` 会让所有子路径 404；正确是 `/reader-api`
- **存储域单元名规则** `/^[a-z][a-z0-9_]*$/`（连字符/大写非法），表名同规则
- **`apply()` 绝不抛错**：装载期异常会拖死整个宿主；入口必须顶层 try/catch 兜底
- **link 插件依赖自持**：改动 `packages/reader` 后先在该目录 `npm install`，再 `node ../scripts/smoke-reader.mjs` 干跑验证，最后才重启宿主
- **host 代码改动需重启 DSH Desktop 生效**；client 改动经 HMR 生效

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
