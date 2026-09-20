// dsh-pages 阅读器 · Host 半层
// 职责：订阅管理 / RSS+Atom 抓取解析 / storageDomain 持久化 / 图片代理 / JSON API（webServer 路由）
// 运行时约定：已安装 bundle 无 harness 全局，client↔host 走同源 HTTP（参照 im-channel 等已装插件）
// 安全模型：订阅内容是远程不可信输入。服务端 HTML 白名单快滤（本文件 sanitizeHtml，API 出口生效）
// + 客户端 DOMParser 白名单重建（client.js sanitizeArticleHtml，渲染前权威防线），两层互为纵深；
// webServer 路由层无鉴权，仅限本机回环使用，webServer 勿绑定 0.0.0.0
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { XMLParser } from 'fast-xml-parser';

// 静态 inject 决定加载器挂载顺序：等这些服务就绪后本插件才启动。
// 漏掉 'tools' 时，apply 期 tools 服务尚未挂载，运行时 inject 回调会被静默丢弃
// （im-channel 的 export const inject = ['agents','tools'] 是实证范式）；
// agents + sessionProjections 供 /reader-api/schedules 跨会话汇总排程
export const inject = ['storageDomain', 'webServer', 'tools', 'agents', 'sessionProjections'];

const PLUGIN = 'dsh-pages-reader';
// 注意：webserver 前缀匹配规则是 pathname === prefix || pathname.startsWith(prefix + '/')，
// 因此注册前缀绝不能带尾斜杠（/reader-api/ 会要求子路径以 // 开头，全部 404）
const API_PREFIX = '/reader-api';
const MEDIA_PREFIX = '/reader-media';
// we-mp-rss 自动发现源：其"订阅列表 RSS"端点免鉴权，item.link 内含 MP_WXS_* feed id
const WEMP_BASE = 'http://localhost:8001';
const FETCH_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 dsh-pages-reader/0.1';
const REFRESH_INTERVAL_MS = 15 * 60 * 1000;
const KEEP_ITEMS_PER_FEED = 120;
const MEDIA_CACHE_LIMIT = 300;
const MEDIA_BYTES_LIMIT = 15 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 25 * 1000;

const FeedSchema = z.object({
  url: z.string(),
  title: z.string(),
  addedAt: z.string(),
  lastFetchAt: z.string().nullable(),
  etag: z.string().nullable(),
  lastModified: z.string().nullable(),
  lastError: z.string().nullable(),
  // 关键词过滤：| 分隔，include 命中其一才展示，exclude 命中其一即隐藏（空串不过滤）
  include: z.string().default(''),
  exclude: z.string().default(''),
});

const ItemSchema = z.object({
  feedId: z.string(),
  title: z.string(),
  link: z.string(),
  author: z.string(),
  publishedAt: z.string(),
  snippet: z.string(),
  contentHtml: z.string(),
  readAt: z.string().nullable(),
  starredAt: z.string().nullable().default(null),
});

// 知识库条目：文章快照 / 日报归档 / 手动条目
const KbEntrySchema = z.object({
  kind: z.enum(['article', 'digest', 'manual']),
  title: z.string(),
  contentText: z.string(),
  link: z.string().default(''),
  sourceFeedTitle: z.string().default(''),
  articleId: z.string().nullable().default(null),
  note: z.string().default(''),
  tags: z.array(z.string()).default([]),
  createdAt: z.string(),
});

const DomainSpec = {
  // 单元名规则 /^[a-z][a-z0-9_]*$/（dsh-storage UNIT_NAME_RE），连字符非法
  name: 'dsh_pages_reader',
  // per-record 布局（一记录一文件）：single 布局每次 put 都把整个单元 JSON 全量序列化
  // + fsync 落盘（全文 HTML 下单元文件 15-30MB，逐条 upsert 就是逐次全量重写），
  // per-record 把写放大降到单记录级别；且 compatibleVersions 只对 per-record 生效，
  // 为未来字段演进留余地。从旧 single 文件首开时由存储后端自动迁移（legacy bootstrap），
  // 旧 dsh_pages_reader.json 原样保留（确认迁移成功后可手动删除）。
  layout: 'per-record',
  // 版本纪律：纯增量加表（旧代码读时忽略多出的表）不算结构变更，保持 v1；
  // 改字段/删表才 bump 并写迁移（per-record 下可用 compatibleVersions 平滑过渡）
  version: 1,
  invalidRecords: 'backup-and-skip',
  global: {
    schema: z.object({ mediaSecret: z.string(), seeded: z.boolean() }),
    initial: { mediaSecret: '', seeded: false },
  },
  tables: {
    feeds: { valueSchema: FeedSchema },
    items: { valueSchema: ItemSchema },
    kb_entries: { valueSchema: KbEntrySchema },
  },
};

const SEED_FEEDS = [
  'http://localhost:1200/sspai/matrix',
  'http://localhost:1200/36kr/newsflashes',
];

// ---------------------------------------------------------------- 工具函数

const sha = (s, n = 16) => createHash('sha1').update(s).digest('hex').slice(0, n);

function txt(v) {
  if (v == null) return '';
  if (typeof v === 'string' || typeof v === 'number') return String(v);
  if (typeof v === 'object') return txt(v.__cdata ?? v['#text'] ?? '');
  return '';
}

function stripHtml(html) {
  return txt(html)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

// HTML → 阅读用纯文本（保留段落换行；图片折叠为占位符）
function htmlToText(html) {
  return txt(html)
    .replace(/<(script|style|noscript|iframe|svg|form|button|select)[^>]*>.*?<\/\1>/gis, ' ')
    .replace(/<img[^>]*?alt=(["'])(.*?)\1[^>]*>/gi, (m, q, alt) => (alt ? `[图片:${alt}]` : '[图片]'))
    .replace(/<img[^>]*>/gi, '[图片]')
    .replace(/<br[^>]*>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<\/(p|div|h[1-6]|li|tr|blockquote|section|article|figure|table)>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

// ---------------------------------------------------------------- HTML 消毒（服务端第一道，尽力而为）
// 快滤式白名单思路：删危险容器、on*/style/data-* 等属性、非白名单协议的 URL 属性。
// 正则实现覆盖不了全部解析器差异（如 <a/href=...>），权威消毒在客户端 DOMParser
// 白名单重建（client.js sanitizeArticleHtml）；本函数保证 API 出口拿到的已是滤过的 HTML。
const HTML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function safeCodePoint(n) {
  return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
}
function decodeEntities(v) {
  return String(v)
    .replace(/&#x([0-9a-f]+);?/gi, (m, h) => safeCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);?/g, (m, d) => safeCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => HTML_ENTITIES[n.toLowerCase()] ?? m);
}
const DROP_BLOCK_RE =
  /<(script|style|iframe|frame|frameset|object|embed|applet|template|noscript|svg|math|form|link|meta|base|title)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const DROP_LONELY_RE =
  /<\/?(?:script|style|iframe|frame|frameset|object|embed|applet|template|noscript|svg|math|form|link|meta|base|title)\b[^>]*>/gi;
function sanitizeHtml(html) {
  if (!html) return '';
  let s = String(html)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(DROP_BLOCK_RE, ' ')
    .replace(DROP_LONELY_RE, ' ');
  // 懒加载迁移：无 src 的 img 用 data-src 补 src（必须在删 data-* 之前；rewriteMedia 依赖 src）
  s = s.replace(/<img\b([^>]*)>/gi, (m, attrs) => {
    if (/\ssrc\s*=/i.test(attrs)) return m;
    const patched = attrs.replace(/\sdata-src\s*=\s*(["'])([\s\S]*?)\1/i, (mm, q, v) => ` src="${v.replace(/"/g, '&quot;')}"`);
    return patched === attrs ? m : `<img${patched}>`;
  });
  // 事件处理器 / style / data-* / 杂项危险属性（\s 或 / 分隔均可，HTML5 里 <img/src=x> 合法）
  s = s.replace(
    /(?:\s|\/)(?:on[a-z]+|style|data-[a-z-]+|srcset|ping|background|dynsrc|lowsrc|formaction|id|name)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]*)/gi,
    '',
  );
  // URL 属性协议过滤：实体解码 + 控制字符剥离后判定，防 java\tscript: / &#106;avascript: 变体。
  // 仅放行 http/https/mailto/相对地址；src 额外放行 data:image/*（img 上下文脚本惰性）
  s = s.replace(/(\s(?:href|src|poster)\s*=\s*)("([^"]*)"|'([^']*)'|([^\s>]+))/gi, (m, pre, whole, dq, sq, bare) => {
    const raw = dq !== undefined ? dq : sq !== undefined ? sq : bare ?? '';
    const decoded = decodeEntities(raw).replace(/[\x00-\x20]+/g, '');
    const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(decoded);
    if (scheme) {
      const p = scheme[1].toLowerCase();
      const ok = p === 'http' || p === 'https' || p === 'mailto' || (p === 'data' && /^data:image\//i.test(decoded));
      if (!ok) return '';
    }
    return m;
  });
  return s;
}

// 在线正文粗提取：去噪后优先 <article>/<main>，供摘要型源补全文（尽力而为，复杂排版可能不准）
async function extractFulltext(url, timeoutMs) {
  const res = await fetch(url, {
    headers: { 'User-Agent': FETCH_UA },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  const cleaned = html.replace(
    /<(script|style|noscript|iframe|svg|form|header|footer|nav|aside|button|select)[^>]*>.*?<\/\1>/gis,
    ' ',
  );
  const m =
    cleaned.match(/<article[^>]*>(.*?)<\/article>/is) ??
    cleaned.match(/<main[^>]*>(.*?)<\/main>/is) ??
    cleaned.match(/<body[^>]*>(.*?)<\/body>/is);
  const text = htmlToText(m ? m[1] : cleaned);
  if (text.length < 200) throw new Error('正文提取结果过短');
  return text;
}

function toIso(value) {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

// 关键词过滤：include 命中其一才通过，exclude 命中其一即拒绝（| 分隔，大小写不敏感）
function matchKeywords(title, include, exclude) {
  const t = (title ?? '').toLowerCase();
  const inc = (include ?? '').split('|').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const exc = (exclude ?? '').split('|').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (inc.length > 0 && !inc.some((k) => t.includes(k))) return false;
  if (exc.length > 0 && exc.some((k) => t.includes(k))) return false;
  return true;
}

// 解析 OPML，递归收集所有带 xmlUrl 的 outline
function collectOpmlUrls(node, out = []) {
  for (const n of Array.isArray(node) ? node : node ? [node] : []) {
    if (n == null || typeof n !== 'object') continue;
    const url = n['@_xmlUrl'] ?? n['@_xmlurl'];
    if (url) out.push({ url: String(url), title: String(n['@_title'] ?? n['@_text'] ?? '') });
    if (n.outline) collectOpmlUrls(n.outline, out);
  }
  return out;
}

const b64urlEncode = (s) => Buffer.from(s, 'utf8').toString('base64url');
const b64urlDecode = (s) => Buffer.from(s, 'base64url').toString('utf8');

// 定并发池：固定 worker 数消费队列（fn 自身负责不抛，如 refreshFeed 内部已 catch）
async function mapPool(list, limit, fn) {
  const queue = [...list];
  const workers = Array.from({ length: Math.max(1, Math.min(limit, queue.length)) }, async () => {
    while (queue.length) await fn(queue.shift());
  });
  await Promise.all(workers);
}

// ---------------------------------------------------------------- 插件入口

// start() 完成后赋值的能力句柄与工具注册器，供顶层的注入回调取用
let apiImpl = null;
let registerReaderToolsRef = null;

// apply 绝不抛出：任何装载期异常只禁用本插件，不拖死宿主
// 静态 inject 保证三服务挂载后再启动；ctx.tools 直接属性访问（勿用运行时 inject 子 fiber）
export function apply(ctx) {
  try {
    ctx.inject(['storageDomain', 'webServer'], (wctx) => {
      apiImpl = start(wctx);
      // 跨会话排程聚合：agents/sessionProjections 已由静态 inject 保证，从顶层 ctx 读取
      apiImpl.getSchedules = () => {
        const sessions = [];
        let total = 0;
        for (const agent of ctx.agents.list()) {
          try {
            const snap = ctx.sessionProjections.snapshot(agent.session, ['schedule']);
            const active = snap?.values?.schedule;
            if (Array.isArray(active) && active.length > 0) {
              sessions.push({
                sessionId: String(agent.id),
                schedules: active.map((r) => ({
                  id: String(r.id ?? ''),
                  prompt: String(r.prompt ?? ''),
                  scheduledAt: r.scheduledAt ? String(r.scheduledAt) : null,
                })),
              });
              total += active.length;
            }
          } catch {}
        }
        return { ok: true, total, sessions };
      };
    });
  } catch (e) {
    console.error(`[${PLUGIN}] apply failed: ${e?.stack || e}`);
  }
  // 工具注册：静态 inject 保证 ctx.tools 直接可用（im-channel registerGlobal 同款访问路径）。
  // 不要写成 ctx.inject(['tools'], cb)——子 fiber 的 inject 解析在本部署会静默失活。
  try {
    if (ctx.tools && typeof ctx.tools.register === 'function') {
      registerReaderToolsRef?.(ctx.tools, () => apiImpl);
      console.log(`[${PLUGIN}] reader_* tools registered`);
    } else {
      console.error(`[${PLUGIN}] ctx.tools unavailable, reader_* disabled`);
    }
  } catch (e) {
    console.error(`[${PLUGIN}] tools register failed: ${e.message}`);
  }
  // 每个新创建的 agent（含子代理）在其作用域内获得 reader_* 工具——全局注册在本部署
  // 不会自动出现在会话工具表（yuyi 同款），必须 per-agent 注入。
  // 范式：dsh-schedule 的 agent/created 监听 + agent.ctx.tools.register（作用域随 agent 回收）
  try {
    ctx.on('agent/created', ({ agent }) => {
      try {
        agent.ctx.effect(() => {
          registerReaderToolsRef?.(agent.ctx.tools, () => apiImpl);
          return () => {};
        }, 'dsh-pages-reader.tools()');
      } catch (e) {
        console.error(`[${PLUGIN}] per-agent tools failed: ${e.message}`);
      }
    });
    console.log(`[${PLUGIN}] agent/created hook installed`);
  } catch (e) {
    console.error(`[${PLUGIN}] agent/created hook failed: ${e.message}`);
  }
}

function start(ctx) {
  let domain = null;
  const mediaCache = new Map(); // url -> { buf: Buffer, ctype: string }

  const ready = init().catch((e) => {
    console.error(`[${PLUGIN}] init failed: ${e?.stack || e}`);
    throw e;
  });
  // 避免未处理拒绝；各请求处理器仍会 await ready 并收到错误
  ready.catch(() => {});

  async function init() {
    domain = await ctx.storageDomain.open(DomainSpec);
    if (!domain.global.get().mediaSecret) {
      await domain.global.set({
        mediaSecret: randomBytes(18).toString('base64url'),
        seeded: false,
      });
    }
    if (!domain.global.get().seeded) {
      await domain.global.set({ ...domain.global.get(), seeded: true });
      for (const url of SEED_FEEDS) {
        await addFeed(url).catch((e) =>
          console.error(`[${PLUGIN}] seed ${url} failed: ${e.message}`),
        );
      }
    }
    // 定时器与域句柄随宿主进程同寿（storageDomain 卸载时由设施统一关闭域）
    setInterval(
      () => refreshAll().catch((e) => console.error(`[${PLUGIN}] refresh: ${e.message}`)),
      REFRESH_INTERVAL_MS,
    );
    console.log(`[${PLUGIN}] ready, feeds=${domain.table('feeds').size}`);
  }

  // ---------------------------------------------------------------- 抓取与解析

  const xml = new XMLParser({
    removeNSPrefix: true,
    cdataPropName: '__cdata',
    textNodeName: '#text',
    parseTagValue: false,
    trimValues: true,
    // 必须显式开启属性解析（v4 默认丢弃）：Atom link/@_href、OPML outline/@_xmlUrl 全靠它
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    // 全文 feed 实体数量大（&nbsp; 等），源均为自托管容器，放宽扩展上限
    processEntities: {
      maxTotalExpansions: 100000,
      maxExpandedLength: 5 * 1024 * 1024,
    },
  });

  async function fetchFeedDocument(feedOrUrl) {
    const url = typeof feedOrUrl === 'string' ? feedOrUrl : feedOrUrl.url;
    const headers = {
      'User-Agent': FETCH_UA,
      Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
    };
    if (typeof feedOrUrl !== 'string') {
      if (feedOrUrl.etag) headers['If-None-Match'] = feedOrUrl.etag;
      if (feedOrUrl.lastModified) headers['If-Modified-Since'] = feedOrUrl.lastModified;
    }
    const res = await fetch(url, {
      headers,
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (res.status === 304) return { notModified: true };
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.text();
    return {
      body,
      etag: res.headers.get('etag'),
      lastModified: res.headers.get('last-modified'),
    };
  }

  function parseFeed(body) {
    const doc = xml.parse(body);
    // RSS 2.0
    if (doc.rss?.channel) {
      const ch = doc.rss.channel;
      const items = (Array.isArray(ch.item) ? ch.item : ch.item ? [ch.item] : []).map((it) => {
        const link = txt(it.link) || txt(it.guid);
        const content = txt(it.encoded) || txt(it.description);
        return {
          guid: txt(it.guid) || link,
          title: txt(it.title) || '（无标题）',
          link,
          author: txt(it.author) || txt(it.creator),
          publishedAt: toIso(txt(it.pubDate) || txt(it.date)),
          contentHtml: content,
          snippet: stripHtml(content),
        };
      });
      return { title: txt(ch.title) || '未命名订阅', items };
    }
    // Atom
    if (doc.feed) {
      const f = doc.feed;
      const entries = Array.isArray(f.entry) ? f.entry : f.entry ? [f.entry] : [];
      const items = entries.map((e) => {
        const links = Array.isArray(e.link) ? e.link : e.link ? [e.link] : [];
        const alt = links.find((l) => (l['@_rel'] ?? 'alternate') === 'alternate') ?? links[0];
        const link = alt?.['@_href'] ?? txt(e.id);
        // Atom 全文优先级：content:encoded（removeNSPrefix 后变 encoded）> content > summary
        // 公众号源（we-mp-rss）的正文就在 content:encoded 里
        const content = txt(e.encoded) || txt(e.content) || txt(e.summary);
        return {
          guid: txt(e.id) || link,
          title: txt(e.title) || '（无标题）',
          link,
          author: txt(e.author?.name),
          publishedAt: toIso(txt(e.published) || txt(e.updated)),
          contentHtml: content,
          snippet: stripHtml(content),
        };
      });
      return { title: txt(f.title) || '未命名订阅', items };
    }
    throw new Error('无法识别的 feed 格式（既不是 RSS 也不是 Atom）');
  }

  // ---------------------------------------------------------------- 数据操作

  const feeds = () => domain.table('feeds');
  const items = () => domain.table('items');

  async function upsertItems(feedId, parsedItems) {
    let added = 0;
    for (const it of parsedItems) {
      if (!it.link && !it.guid) continue;
      const key = sha(`${feedId}|${it.guid || it.link || it.title}`);
      const base = {
        feedId,
        title: it.title,
        link: it.link,
        author: it.author ?? '',
        publishedAt: it.publishedAt,
        snippet: it.snippet,
        contentHtml: it.contentHtml,
      };
      // readAt/starredAt 必须在【写链内】合并：update 的 fn 拿到的是已提交的最新记录，
      // 并发的 markRead/star 不会被抓取用旧快照覆盖（旧实现 get→put 跨链读改写有竞态）
      if (items().get(key)) {
        await items().update(key, (cur) => ({
          ...base,
          readAt: cur.readAt ?? null,
          starredAt: cur.starredAt ?? null,
        }));
      } else {
        await items().put(key, { ...base, readAt: null, starredAt: null });
        added += 1;
      }
    }
    // 留存裁剪：每订阅保留最新 N 条；星标条目无论多旧一律豁免（星标 = 长期保存的承诺）
    const mine = [...items().entries()].filter(([, v]) => v.feedId === feedId);
    mine.sort((a, b) => (a[1].publishedAt < b[1].publishedAt ? 1 : -1));
    const survivors = new Set(mine.slice(0, KEEP_ITEMS_PER_FEED).map(([k]) => k));
    for (const [key, v] of mine.slice(KEEP_ITEMS_PER_FEED)) {
      if (v.starredAt) survivors.add(key);
    }
    for (const [key] of mine) {
      if (!survivors.has(key)) await items().delete(key);
    }
    return added;
  }

  async function addFeed(url) {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('仅支持 http(s) 地址');
    const id = sha(url, 12);
    if (feeds().get(id)) throw new Error('该订阅已存在');
    const doc = await fetchFeedDocument(url);
    const parsed = parseFeed(doc.body);
    await feeds().put(id, {
      url,
      title: parsed.title,
      addedAt: new Date().toISOString(),
      lastFetchAt: new Date().toISOString(),
      etag: doc.etag ?? null,
      lastModified: doc.lastModified ?? null,
      lastError: null,
      include: '',
      exclude: '',
    });
    const added = await upsertItems(id, parsed.items);
    return { id, title: parsed.title, added };
  }

  async function refreshFeed(id) {
    const rec = feeds().get(id);
    if (!rec) throw new Error('订阅不存在');
    try {
      const doc = await fetchFeedDocument(rec);
      if (!doc.notModified) {
        const parsed = parseFeed(doc.body);
        await upsertItems(id, parsed.items);
        await feeds().update(id, (c) => ({
          ...c,
          title: parsed.title || c.title,
          etag: doc.etag ?? c.etag,
          lastModified: doc.lastModified ?? c.lastModified,
        }));
      }
      await feeds().update(id, (c) => ({ ...c, lastFetchAt: new Date().toISOString(), lastError: null }));
      return { id, ok: true };
    } catch (e) {
      await feeds().update(id, (c) => ({
        ...c,
        lastFetchAt: new Date().toISOString(),
        lastError: e.message,
      }));
      return { id, ok: false, error: e.message };
    }
  }

  // 全量刷新防重入：客户端每次挂载面板会触发 feeds/refresh，与 15min 定时器、手动刷新叠加；
  // 进行中再触发返回 {skipped} 而不是排队第二轮。订阅间并发 4，避免 N×25s 串行超过刷新周期
  let refreshInFlight = null;

  // 自动发现：从 we-mp-rss 订阅列表增量同步新增公众号——we-mp-rss 里加号后无需手动接入
  async function discoverWeMpFeeds() {
    const seen = new Map(); // mpId -> title
    for (let offset = 0; offset < 300; offset += 30) {
      const res = await fetch(`${WEMP_BASE}/rss?limit=30&offset=${offset}`, {
        headers: { 'User-Agent': FETCH_UA },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) return;
      const doc = xml.parse(await res.text());
      const list = Array.isArray(doc.rss?.channel?.item)
        ? doc.rss.channel.item
        : doc.rss?.channel?.item
          ? [doc.rss.channel.item]
          : [];
      for (const it of list) {
        const m = String(txt(it.link)).match(/MP_WXS_[A-Za-z0-9]+/);
        if (m) seen.set(m[0], txt(it.title));
      }
      if (list.length < 30) break;
    }
    let added = 0;
    for (const mpId of seen.keys()) {
      const feedUrl = `${WEMP_BASE}/feed/${mpId}.atom`;
      const id = sha(feedUrl, 12);
      if (feeds().get(id)) continue;
      try {
        await addFeed(feedUrl);
        added += 1;
      } catch {}
    }
    if (added > 0) console.log(`[${PLUGIN}] 自动发现 ${added} 个新公众号源`);
  }

  async function refreshAll() {
    if (refreshInFlight) return { skipped: true, reason: '已有刷新正在进行' };
    refreshInFlight = (async () => {
      try {
        await discoverWeMpFeeds();
      } catch (e) {
        console.error(`[${PLUGIN}] discover failed: ${e.message}`);
      }
      const ids = [...feeds().keys()];
      const out = [];
      await mapPool(ids, 4, async (id) => out.push(await refreshFeed(id)));
      return out;
    })();
    try {
      return await refreshInFlight;
    } finally {
      refreshInFlight = null;
    }
  }

  function listFeeds() {
    const counts = new Map();
    for (const [, v] of items().entries()) {
      if (v.readAt) continue;
      counts.set(v.feedId, (counts.get(v.feedId) ?? 0) + 1);
    }
    return [...feeds().entries()]
      .map(([id, f]) => ({
        id,
        url: f.url,
        title: f.title,
        addedAt: f.addedAt,
        lastFetchAt: f.lastFetchAt,
        lastError: f.lastError,
        include: f.include ?? '',
        exclude: f.exclude ?? '',
        unread: counts.get(id) ?? 0,
      }))
      .sort((a, b) => (a.addedAt < b.addedAt ? -1 : 1));
  }

  function listItems(feedId, unreadOnly, starredOnly) {
    const feedMap = new Map([...feeds().entries()]);
    const out = [];
    for (const [id, v] of items().entries()) {
      if (feedId && v.feedId !== feedId) continue;
      if (unreadOnly && v.readAt) continue;
      if (starredOnly && !v.starredAt) continue;
      const f = feedMap.get(v.feedId);
      if (!matchKeywords(v.title, f?.include, f?.exclude)) continue;
      out.push({
        id,
        feedId: v.feedId,
        feedTitle: f?.title ?? '',
        title: v.title,
        publishedAt: v.publishedAt,
        snippet: v.snippet,
        read: !!v.readAt,
        starred: !!v.starredAt,
      });
    }
    out.sort((a, b) => (a.publishedAt < b.publishedAt ? 1 : -1));
    return out.slice(0, 300);
  }

  function rewriteMedia(html) {
    if (!html) return '';
    const g = domain.global;
    const secret = g.get().mediaSecret;
    return html.replace(
      /(<img\b[^>]*?\s)(?:src|data-src)=(["'])(https?:\/\/[^"']+)\2/gi,
      (m, pre, q, u) => `${pre}src=${q}${MEDIA_PREFIX}/${secret}/${b64urlEncode(u)}${q}`,
    );
  }

  // ---------------------------------------------------------------- HTTP 辅助

  function json(res, code, obj) {
    res.writeHead(code, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify(obj));
  }

  function readBody(req, limit = 5 * 1024 * 1024) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size > limit) {
          reject(new Error('请求体过大'));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => {
        if (!chunks.length) return resolve({});
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch (e) {
          reject(new Error('请求体不是合法 JSON'));
        }
      });
      req.on('error', reject);
    });
  }

  // ---------------------------------------------------------------- JSON API 路由

  async function apiHandler(req, res) {
    try {
      await ready;
      const u = new URL(req.url ?? '', 'http://local');
      const method = u.pathname.slice(API_PREFIX.length).replace(/^\//, '');
      const body = req.method === 'POST' ? await readBody(req) : {};

      switch (method) {
        case 'feeds':
          return json(res, 200, listFeeds());

        case 'feeds/add':
          try {
            return json(res, 200, { ok: true, ...(await addFeed(String(body.url ?? ''))) });
          } catch (e) {
            return json(res, 200, { ok: false, error: e.message });
          }

        case 'feeds/remove': {
          const id = String(body.id ?? '');
          if (!feeds().get(id)) return json(res, 200, { ok: false, error: '订阅不存在' });
          await feeds().delete(id);
          for (const [key, v] of items().entries()) if (v.feedId === id) await items().delete(key);
          return json(res, 200, { ok: true });
        }

        case 'feeds/refresh': {
          const id = body.id ? String(body.id) : null;
          return json(res, 200, id ? await refreshFeed(id) : await refreshAll());
        }

        case 'feeds/filter': {
          const id = String(body.id ?? '');
          if (!feeds().get(id)) return json(res, 200, { ok: false, error: '订阅不存在' });
          await feeds().update(id, (c) => ({
            ...c,
            include: String(body.include ?? ''),
            exclude: String(body.exclude ?? ''),
          }));
          return json(res, 200, { ok: true });
        }

        case 'feeds/import-opml': {
          const opmlText = String(body.opml ?? '');
          if (!opmlText.trim()) return json(res, 200, { ok: false, error: 'OPML 内容为空' });
          let doc;
          try {
            doc = xml.parse(opmlText);
          } catch {
            return json(res, 200, { ok: false, error: 'OPML 解析失败' });
          }
          const urls = collectOpmlUrls(doc?.opml?.body?.outline);
          // 同一 OPML 内按 url 去重，防并发池重复添加同一订阅
          const uniq = [...new Map(urls.map((u) => [u.url, u])).values()];
          if (uniq.length === 0) return json(res, 200, { ok: false, error: 'OPML 中未找到任何订阅（xmlUrl）' });
          const added = [];
          const skipped = [];
          const failed = [];
          await mapPool(uniq, 4, async ({ url }) => {
            try {
              added.push(await addFeed(url));
            } catch (e) {
              if (/已存在/.test(e.message)) skipped.push(url);
              else failed.push({ url, error: e.message });
            }
          });
          return json(res, 200, { ok: true, total: uniq.length, added, skipped, failed });
        }

        case 'items': {
          const feedId = u.searchParams.get('feedId') || null;
          const unreadOnly = u.searchParams.get('unreadOnly') === '1';
          const starredOnly = u.searchParams.get('starredOnly') === '1';
          return json(res, 200, listItems(feedId, unreadOnly, starredOnly));
        }

        case 'item': {
          const id = u.searchParams.get('id') ?? '';
          const v = items().get(id);
          if (!v) return json(res, 404, { ok: false, error: '文章不存在' });
          return json(res, 200, {
            ok: true,
            item: {
              id,
              feedId: v.feedId,
              feedTitle: feeds().get(v.feedId)?.title ?? '',
              title: v.title,
              link: v.link,
              author: v.author,
              publishedAt: v.publishedAt,
              // 服务端白名单快滤在前（API 出口契约），客户端 DOMParser 重建在后（权威防线），
              // rewriteMedia 最后把 img 改写指向媒体代理
              contentHtml: rewriteMedia(sanitizeHtml(v.contentHtml)),
              snippet: v.snippet,
              starred: !!v.starredAt,
            },
          });
        }

        case 'items/markRead': {
          const id = String(body.id ?? '');
          const read = body.read !== false;
          if (!items().get(id)) return json(res, 200, { ok: false });
          await items().update(id, (c) => ({ ...c, readAt: read ? new Date().toISOString() : null }));
          return json(res, 200, { ok: true });
        }

        case 'items/star': {
          const id = String(body.id ?? '');
          const starred = body.starred !== false;
          if (!items().get(id)) return json(res, 200, { ok: false });
          await items().update(id, (c) => ({ ...c, starredAt: starred ? new Date().toISOString() : null }));
          return json(res, 200, { ok: true });
        }

        // ---------------------------------------------------------------- 知识库 API
        case 'kb/from-article': {
          try {
            const r = await saveKbEntry({
              kind: 'article',
              articleId: body.articleId ? String(body.articleId) : null,
              title: body.title ? String(body.title) : '',
              tags: body.tags ?? [],
              note: String(body.note ?? ''),
            });
            return json(res, 200, { ok: true, ...r });
          } catch (e) {
            return json(res, 200, { ok: false, error: e.message });
          }
        }

        case 'kb/save': {
          try {
            const r = await saveKbEntry({
              kind: ['digest', 'manual', 'article'].includes(body.kind) ? body.kind : 'manual',
              title: String(body.title ?? ''),
              contentText: body.contentText !== undefined ? String(body.contentText) : String(body.text ?? ''),
              link: String(body.link ?? ''),
              sourceFeedTitle: String(body.sourceFeedTitle ?? ''),
              note: String(body.note ?? ''),
              tags: body.tags ?? [],
              digest: body.digest,
            });
            return json(res, 200, { ok: true, ...r });
          } catch (e) {
            return json(res, 200, { ok: false, error: e.message });
          }
        }

        case 'kb/save-digest': {
          try {
            const hours = Math.min(Math.max(Number(body.hours) || 24, 1), 24 * 30);
            const unreadOnly = body.unreadOnly !== false;
            return json(res, 200, { ok: true, ...(await saveDigestToKb(hours, unreadOnly)) });
          } catch (e) {
            return json(res, 200, { ok: false, error: e.message });
          }
        }

        case 'kb/list': {
          const q = u.searchParams.get('query') || '';
          const tag = u.searchParams.get('tag') || null;
          const kind = u.searchParams.get('kind') || null;
          const limit = Math.min(Math.max(Number(u.searchParams.get('limit')) || 100, 1), 300);
          return json(res, 200, searchKbEntries(q, tag, kind).slice(0, limit));
        }

        case 'kb/entry': {
          const r = getKbEntry(u.searchParams.get('id'));
          if (!r) return json(res, 404, { ok: false, error: '条目不存在' });
          return json(res, 200, { ok: true, entry: r });
        }

        case 'kb/note': {
          const id = String(body.id ?? '');
          if (!kb().get(id)) return json(res, 200, { ok: false, error: '条目不存在' });
          await kb().update(id, (c) => ({ ...c, note: String(body.note ?? '') }));
          return json(res, 200, { ok: true });
        }

        case 'kb/remove': {
          const removed = await kb().delete(String(body.id ?? ''));
          return json(res, 200, { ok: removed });
        }

        case 'kb/related': {
          const articleId = u.searchParams.get('articleId') || '';
          const limit = Math.min(Math.max(Number(u.searchParams.get('limit')) || 5, 1), 20);
          return json(res, 200, relatedKbEntries(articleId, limit));
        }

        // 跨会话排程汇总：数据由 apply 顶层挂载的 getSchedules 提供（读取 dsh-schedule projection）
        case 'schedules': {
          const get = apiImpl?.getSchedules;
          if (typeof get !== 'function') return json(res, 503, { ok: false, error: '排程聚合不可用' });
          return json(res, 200, get());
        }

        default:
          return json(res, 404, { ok: false, error: `unknown endpoint: ${method}` });
      }
    } catch (e) {
      return json(res, 500, { ok: false, error: e.message ?? 'internal error' });
    }
  }

  // ---------------------------------------------------------------- 图片代理路由

  async function mediaHandler(req, res) {
    const fail = (code, msg) => {
      res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(msg);
    };
    try {
      await ready;
      const pathname = new URL(req.url ?? '', 'http://local').pathname;
      const rest = pathname.slice(MEDIA_PREFIX.length).replace(/^\//, '');
      const slash = rest.indexOf('/');
      const secret = slash >= 0 ? rest.slice(0, slash) : '';
      const encoded = slash >= 0 ? rest.slice(slash + 1) : '';
      if (!secret || secret !== domain.global.get().mediaSecret) return fail(404, 'not found');
      let upstream;
      try {
        upstream = new URL(b64urlDecode(encoded));
      } catch {
        return fail(400, 'bad url');
      }
      if (upstream.protocol !== 'http:' && upstream.protocol !== 'https:') return fail(400, 'bad protocol');
      const key = upstream.href;
      const hit = mediaCache.get(key);
      if (hit) {
        res.writeHead(200, {
          'Content-Type': hit.ctype,
          'Cache-Control': 'public, max-age=86400',
          'X-Content-Type-Options': 'nosniff',
        });
        return res.end(hit.buf);
      }
      // 图片防盗链策略按站适配（实测）：
      // - 微信 mmbiz.qpic.cn：必须【无】Referer，带了就 403
      // - 少数派 cdnfile.sspai.com：必须带主站 Referer，不带/错带都 403
      // - 其余：先无 Referer，403 时退化为源站 Referer 重试一次
      const REFERER_MAP = new Map([
        ['mmbiz.qpic.cn', null],
        ['cdnfile.sspai.com', 'https://sspai.com/'],
      ]);
      const fetchUpstream = (referer) =>
        fetch(key, {
          headers: referer
            ? { 'User-Agent': FETCH_UA, Referer: referer }
            : { 'User-Agent': FETCH_UA },
          redirect: 'follow',
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
      let r;
      if (REFERER_MAP.has(upstream.hostname)) {
        r = await fetchUpstream(REFERER_MAP.get(upstream.hostname) ?? undefined);
      } else {
        r = await fetchUpstream(undefined);
        if (r.status === 403) r = await fetchUpstream(`${upstream.origin}/`);
      }
      if (!r.ok) return fail(502, `upstream ${r.status}`);
      const len = Number(r.headers.get('content-length') ?? 0);
      // 双保险：content-length 缺失/谎报时也用实际字节数兜底
      if (len > MEDIA_BYTES_LIMIT) return fail(502, 'too large');
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > MEDIA_BYTES_LIMIT) return fail(502, 'too large');
      const ctype = r.headers.get('content-type') ?? 'application/octet-stream';
      mediaCache.set(key, { buf, ctype });
      if (mediaCache.size > MEDIA_CACHE_LIMIT) {
        const oldest = mediaCache.keys().next().value;
        mediaCache.delete(oldest);
      }
      res.writeHead(200, {
        'Content-Type': ctype,
        'Cache-Control': 'public, max-age=86400',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(buf);
    } catch (e) {
      fail(502, e.message ?? 'proxy error');
    }
  }

  // ---------------------------------------------------------------- Agent 工具（P2）

  async function getArticleText(id, full) {
    const v = items().get(id);
    if (!v) return null;
    const meta = {
      id,
      feedTitle: feeds().get(v.feedId)?.title ?? '',
      title: v.title,
      link: v.link,
      author: v.author,
      publishedAt: v.publishedAt,
    };
    let text = htmlToText(v.contentHtml);
    let source = 'stored';
    if ((full === true || text.length < 300) && v.link) {
      try {
        text = await extractFulltext(v.link, FETCH_TIMEOUT_MS);
        source = 'live-extract';
      } catch (e) {
        source = text.length > 0 ? 'stored-fallback' : `extract-failed: ${e.message}`;
      }
    }
    const CAP = 12000;
    const truncated = text.length > CAP;
    return { ...meta, text: truncated ? text.slice(0, CAP) : text, truncated, source };
  }

  function buildDigest(hours, unreadOnly) {
    const since = new Date(Date.now() - hours * 3600 * 1000).toISOString();
    const feedMap = new Map([...feeds().entries()]);
    const groups = new Map();
    let itemCount = 0;
    const all = [...items().entries()].sort((a, b) => (a[1].publishedAt < b[1].publishedAt ? 1 : -1));
    for (const [id, v] of all) {
      if (unreadOnly ? !!v.readAt : v.publishedAt < since) continue;
      if (itemCount >= 100) break;
      const f = feedMap.get(v.feedId);
      if (!matchKeywords(v.title, f?.include, f?.exclude)) continue; // 日报同样尊重关键词过滤
      const g = groups.get(v.feedId) ?? { feedId: v.feedId, feedTitle: f?.title ?? '', items: [] };
      g.items.push({ id, title: v.title, publishedAt: v.publishedAt, snippet: v.snippet, link: v.link });
      groups.set(v.feedId, g);
      itemCount += 1;
    }
    return {
      since,
      hours,
      unreadOnly,
      feedCount: groups.size,
      itemCount,
      groups: [...groups.values()],
    };
  }

  // ---------------------------------------------------------------- 知识库（P4）

  const kb = () => domain.table('kb_entries');
  const newKbId = () => `kb_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

  async function saveKbEntry(input) {
    const kind = ['article', 'digest', 'manual'].includes(input.kind) ? input.kind : 'manual';
    let title = String(input.title ?? '').trim();
    let contentText = String(input.contentText ?? '');
    let link = String(input.link ?? '');
    let sourceFeedTitle = String(input.sourceFeedTitle ?? '');
    let articleId = input.articleId ? String(input.articleId) : null;

    // 从阅读器文章一键入库：自动补全标题/全文/来源
    if (articleId) {
      const v = items().get(articleId);
      if (!v) throw new Error('关联文章不存在');
      if (!contentText) contentText = htmlToText(v.contentHtml);
      if (!title) title = v.title;
      if (!link) link = v.link;
      if (!sourceFeedTitle) sourceFeedTitle = feeds().get(v.feedId)?.title ?? '';
    }
    if (kind === 'digest' && !contentText && input.digest) {
      contentText = digestToMarkdown(input.digest);
    }
    if (!title) throw new Error('标题不能为空');
    if (!contentText.trim()) throw new Error('正文内容不能为空');

    const id = newKbId();
    const tags = Array.isArray(input.tags)
      ? input.tags.map((t) => String(t).trim()).filter(Boolean)
      : String(input.tags ?? '').split('|').map((t) => t.trim()).filter(Boolean);
    await kb().put(id, {
      kind,
      title,
      contentText,
      link,
      sourceFeedTitle,
      articleId,
      note: String(input.note ?? ''),
      tags,
      createdAt: new Date().toISOString(),
    });
    return { id, kind, title, tags };
  }

  async function saveDigestToKb(hours = 24, unreadOnly = true) {
    const d = buildDigest(hours, unreadOnly);
    if (d.itemCount === 0) throw new Error('当前窗口没有可归档的文章');
    const id = newKbId();
    const title = `RSS 日报 ${new Date().toISOString().slice(0, 10)}（${d.unreadOnly ? '未读' : `近 ${d.hours} 小时`}·${d.itemCount} 篇）`;
    await kb().put(id, {
      kind: 'digest',
      title,
      contentText: digestToMarkdown(d),
      link: '',
      sourceFeedTitle: '',
      articleId: null,
      note: '',
      tags: ['日报'],
      createdAt: new Date().toISOString(),
    });
    return { id, title, itemCount: d.itemCount, feedCount: d.feedCount };
  }

  function digestToMarkdown(d) {
    const lines = [`# RSS 日报（${d.unreadOnly ? '未读' : `近 ${d.hours} 小时`} · ${d.itemCount} 篇 / ${d.feedCount} 个源）`, ''];
    for (const g of d.groups) {
      lines.push(`## ${g.feedTitle}`, '');
      for (const it of g.items) {
        lines.push(`- ${it.title}（${String(it.publishedAt).slice(0, 10)}）${it.link ? `<${it.link}>` : ''}`);
      }
      lines.push('');
    }
    return lines.join('\n');
  }

  // 关键词检索：标题×3 / 标签×2 / 笔记×2 / 正文×1，多词 AND 语义
  function searchKbEntries(query, tag, kind) {
    const terms = (query ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean);
    const out = [];
    for (const [id, v] of kb().entries()) {
      if (tag && !v.tags.includes(tag)) continue;
      if (kind && v.kind !== kind) continue;
      let score = 0;
      if (terms.length > 0) {
        const title = v.title.toLowerCase();
        const note = (v.note ?? '').toLowerCase();
        const content = (v.contentText ?? '').toLowerCase();
        const tags = (v.tags ?? []).join('|').toLowerCase();
        for (const t of terms) {
          let s = 0;
          if (title.includes(t)) s += 3;
          if (tags.includes(t)) s += 2;
          if (note.includes(t)) s += 2;
          if (content.includes(t)) s += 1;
          if (s === 0) { score = -1; break; }
          score += s;
        }
        if (score < 0) continue;
      }
      out.push({
        id,
        kind: v.kind,
        title: v.title,
        snippet: (v.note || stripHtml(v.contentText)).slice(0, 120),
        tags: v.tags ?? [],
        link: v.link,
        sourceFeedTitle: v.sourceFeedTitle,
        createdAt: v.createdAt,
        score,
      });
    }
    out.sort((a, b) => (b.score - a.score) || (a.createdAt < b.createdAt ? 1 : -1));
    return out;
  }

  function getKbEntry(id) {
    const v = kb().get(String(id ?? ''));
    if (!v) return null;
    return { id: String(id), ...v };
  }

  // 阅读反哺：按文章标题分词 + 订阅名，对知识库做 OR 加权匹配，返回最相关的几条
  function relatedKbEntries(articleId, limit = 5) {
    const v = items().get(String(articleId ?? ''));
    if (!v) return [];
    const f = feeds().get(v.feedId);
    const terms = [
      ...new Set([
        ...v.title.split(/[，。！？、：；""''（）\s\-—·|「」【】]+/).filter((t) => t.length >= 2),
        ...(f?.title ? [f.title] : []),
      ]),
    ];
    if (terms.length === 0) return [];
    const out = [];
    for (const [id, k] of kb().entries()) {
      // 注意：不排除本文的快照条目——读原文时"跳回自己的笔记"正是高价值相关项
      const title = k.title.toLowerCase();
      const hay = `${k.title} ${k.note ?? ''} ${(k.tags ?? []).join(' ')} ${k.contentText ?? ''}`.toLowerCase();
      let score = 0;
      for (const t of terms) {
        if (title.includes(t.toLowerCase())) score += 2;
        else if (hay.includes(t.toLowerCase())) score += 1;
      }
      if (score > 0) out.push({ id, kind: k.kind, title: k.title, snippet: (k.note || stripHtml(k.contentText)).slice(0, 100), createdAt: k.createdAt, score });
    }
    out.sort((a, b) => b.score - a.score);
    return out.slice(0, limit);
  }

  const text = (t) => [{ type: 'text', text: t }];
  const objSchema = { type: 'object', additionalProperties: true };

  function registerReaderTools(tools, getApi) {
    // 工具 execute 延迟解析能力句柄：start() 尚未完成时给出可读错误而非崩溃
    const api = () => {
      const a = getApi();
      if (!a) throw new Error('阅读器尚未就绪，请稍后重试');
      return a;
    };
    tools.register({
      name: 'reader_list_feeds',
      description: '列出 RSS 阅读器的全部订阅源（未读数、最近抓取时间与错误状态）。',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      output: {
        schema: { type: 'array', items: objSchema },
        render: (_a, v) =>
          text(
            `${v.length} 个订阅：\n` +
              v.map((f) => `- ${f.title}（${f.unread} 未读${f.lastError ? `，抓取失败：${f.lastError}` : ''}）`).join('\n'),
          ),
      },
      isConcurrencySafe: () => true,
      execute: async () => {
        await api().ready;
        return api().listFeeds();
      },
    });

    tools.register({
      name: 'reader_list_items',
      description: '列出阅读器文章（按时间倒序，可按订阅/未读/星标过滤）。返回 id、标题、订阅名、发布时间、摘要；读正文用 reader_get_article。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          feedId: { type: 'string', description: '只看某个订阅（id 来自 reader_list_feeds）' },
          unreadOnly: { type: 'boolean', description: '只看未读，默认 false' },
          starredOnly: { type: 'boolean', description: '只看星标，默认 false' },
          limit: { type: 'number', description: '返回条数，默认 30，最大 100' },
        },
      },
      output: {
        schema: { type: 'array', items: objSchema },
        render: (_a, v) =>
          text(
            `${v.length} 篇文章：\n` +
              v.slice(0, 15).map((i) => `- [${i.feedTitle}] ${i.title}（${i.read ? '已读' : '未读'}）`).join('\n') +
              (v.length > 15 ? `\n…另有 ${v.length - 15} 篇` : ''),
          ),
      },
      isConcurrencySafe: () => true,
      execute: async (args) => {
        await api().ready;
        const a = args ?? {};
        const limit = Math.min(Math.max(Number(a.limit) || 30, 1), 100);
        return api()
          .listItems(a.feedId ? String(a.feedId) : null, a.unreadOnly === true, a.starredOnly === true)
          .slice(0, limit);
      },
    });

    tools.register({
      name: 'reader_get_article',
      description: '读取一篇文章的正文纯文本（默认取库存全文；full=true 或库存内容过短时在线抓取原文提取正文）。用于摘要、翻译、问答。返回含 text、truncated、source 字段。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['id'],
        properties: {
          id: { type: 'string', description: '文章 id（来自 reader_list_items / reader_digest）' },
          full: { type: 'boolean', description: '强制在线抓取原文提取正文' },
        },
      },
      output: {
        schema: objSchema,
        render: (_a, v) =>
          v?.ok === false
            ? text(`文章不存在`)
            : text(`《${v.title}》（${v.feedTitle}，${v.source}${v.truncated ? '，已截断' : ''}）\n${(v.text ?? '').slice(0, 600)}…`),
      },
      timeoutMs: 45000,
      isConcurrencySafe: () => true,
      execute: async (args) => {
        await api().ready;
        const a = args ?? {};
        const r = await api().getArticleText(String(a.id ?? ''), a.full === true);
        return r ?? { ok: false, error: '文章不存在' };
      },
    });

    tools.register({
      name: 'reader_add_feed',
      description: '订阅新的 RSS/Atom 源并立即抓取验证。RSSHub 路由格式 http://localhost:1200/<路由>（如 /sspai/matrix、/36kr/hot-list、/bilibili/popular/all）；微信公众号聚合源 http://localhost:4000/feeds/all.atom。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['url'],
        properties: { url: { type: 'string', description: 'feed 地址（http/https）' } },
      },
      output: {
        schema: objSchema,
        render: (_a, v) => text(v.ok ? `已订阅「${v.title}」，收录 ${v.added} 篇` : `订阅失败：${v.error}`),
      },
      timeoutMs: 45000,
      execute: async (args) => {
        await api().ready;
        try {
          return { ok: true, ...(await api().addFeed(String(args?.url ?? ''))) };
        } catch (e) {
          return { ok: false, error: e.message };
        }
      },
    });

    tools.register({
      name: 'reader_refresh',
      description: '立即刷新订阅抓取（指定 feedId 刷单个，否则刷全部）。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { feedId: { type: 'string', description: '可选，单个订阅 id' } },
      },
      output: {
        // 宿主 schema 校验不接受类型数组，输出统一包一层对象
        schema: { type: 'object', additionalProperties: true },
        render: (_a, v) => {
          const arr = Array.isArray(v?.results) ? v.results : [];
          if (arr.length === 1 && arr[0]?.skipped) return text('已有一轮刷新正在进行，本轮跳过');
          const bad = arr.filter((r) => r && r.ok === false);
          return text(`刷新完成：${arr.length - bad.length} 成功${bad.length ? `，${bad.length} 失败（${bad.map((b) => b.error).join('；')}）` : ''}`);
        },
      },
      timeoutMs: 90000,
      execute: async (args) => {
        await api().ready;
        const id = args?.feedId ? String(args.feedId) : null;
        const r = id ? [await api().refreshFeed(id)] : await api().refreshAll();
        const results = Array.isArray(r) ? r : [{ ok: true, skipped: true }];
        return { results };
      },
    });

    tools.register({
      name: 'reader_digest',
      description: '生成 RSS 日报素材：按订阅分组的近 N 小时（默认 24）或未读文章清单（标题+摘要+链接）。调用后请用中文整理成简明日报：按主题聚类、每条一行要点、标注来源。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          hours: { type: 'number', description: '时间窗口（小时），默认 24' },
          unreadOnly: { type: 'boolean', description: 'true=只看未读（默认），false=按时间窗口' },
        },
      },
      output: {
        schema: objSchema,
        render: (_a, v) =>
          text(
            `${v.unreadOnly ? '未读' : `近 ${v.hours} 小时`}共 ${v.itemCount} 篇 / ${v.feedCount} 个源：\n` +
              v.groups.map((g) => `- ${g.feedTitle}：${g.items.length} 篇`).join('\n'),
          ),
      },
      isConcurrencySafe: () => true,
      execute: async (args) => {
        await api().ready;
        const a = args ?? {};
        const hours = Math.min(Math.max(Number(a.hours) || 24, 1), 24 * 30);
        return api().buildDigest(hours, a.unreadOnly !== false);
      },
    });

    tools.register({
      name: 'kb_save',
      description: '把一段知识存入个人知识库（手动条目/日报归档/要点摘录）。同主题已有条目时建议新存一条并在 title 里注明，不要覆盖。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'text'],
        properties: {
          title: { type: 'string', description: '条目标题' },
          text: { type: 'string', description: '条目正文（纯文本）' },
          tags: { type: 'string', description: '标签，| 分隔，如 "Rust|学习笔记"' },
          note: { type: 'string', description: '个人笔记/批注' },
          link: { type: 'string', description: '来源链接（可选）' },
        },
      },
      output: {
        schema: objSchema,
        render: (_a, v) => text(v.ok ? `已入库「${v.title}」（${v.id}）` : `入库失败：${v.error}`),
      },
      execute: async (args) => {
        await api().ready;
        const a = args ?? {};
        try {
          const r = await api().saveKbEntry({
            kind: 'manual',
            title: String(a.title ?? ''),
            contentText: String(a.text ?? ''),
            tags: String(a.tags ?? ''),
            note: String(a.note ?? ''),
            link: String(a.link ?? ''),
          });
          return { ok: true, ...r };
        } catch (e) {
          return { ok: false, error: e.message };
        }
      },
    });

    tools.register({
      name: 'kb_search',
      description: '在个人知识库中按关键词检索（标题/标签/笔记/正文，多词 AND）。返回命中条目列表（id、标题、标签、摘要）。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['query'],
        properties: {
          query: { type: 'string', description: '关键词，多词空格分隔（AND）' },
          tag: { type: 'string', description: '限定某个标签' },
          limit: { type: 'number', description: '返回条数，默认 20，最大 100' },
        },
      },
      output: {
        schema: { type: 'array', items: objSchema },
        render: (_a, v) =>
          text(
            v.length === 0
              ? '知识库无命中'
              : `命中 ${v.length} 条：\n` + v.slice(0, 10).map((i) => `- [${i.id}] ${i.title}（${i.tags.join('/') || '无标签'}）`).join('\n'),
          ),
      },
      isConcurrencySafe: () => true,
      execute: async (args) => {
        await api().ready;
        const a = args ?? {};
        const limit = Math.min(Math.max(Number(a.limit) || 20, 1), 100);
        return api().searchKbEntries(String(a.query ?? ''), a.tag ? String(a.tag) : null, null).slice(0, limit);
      },
    });

    tools.register({
      name: 'kb_read',
      description: '读取知识库单条全文（含个人笔记）。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['id'],
        properties: { id: { type: 'string', description: '条目 id（来自 kb_search / kb_list）' } },
      },
      output: {
        schema: objSchema,
        render: (_a, v) =>
          v?.ok === false ? text('条目不存在') : text(`《${v.title}》（${v.kind}${v.tags?.length ? '，' + v.tags.join('/') : ''}）\n${(v.contentText ?? '').slice(0, 600)}…`),
      },
      isConcurrencySafe: () => true,
      execute: async (args) => {
        await api().ready;
        const r = api().getKbEntry(String(args?.id ?? ''));
        if (!r) return { ok: false, error: '条目不存在' };
        const CAP = 12000;
        const truncated = r.contentText.length > CAP;
        return { ok: true, ...r, contentText: truncated ? r.contentText.slice(0, CAP) : r.contentText, truncated };
      },
    });

    tools.register({
      name: 'kb_list',
      description: '浏览个人知识库条目列表（可按标签/类型过滤，按时间倒序）。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          tag: { type: 'string', description: '限定某个标签' },
          kind: { type: 'string', enum: ['article', 'digest', 'manual'], description: '限定类型' },
          limit: { type: 'number', description: '返回条数，默认 20，最大 100' },
        },
      },
      output: {
        schema: { type: 'array', items: objSchema },
        render: (_a, v) =>
          text(
            v.length === 0
              ? '知识库为空'
              : `共 ${v.length} 条：\n` + v.slice(0, 15).map((i) => `- [${i.kind}] ${i.title}（${i.tags.join('/') || '无标签'}）`).join('\n'),
          ),
      },
      isConcurrencySafe: () => true,
      execute: async (args) => {
        await api().ready;
        const a = args ?? {};
        const limit = Math.min(Math.max(Number(a.limit) || 20, 1), 100);
        return api()
          .searchKbEntries('', a.tag ? String(a.tag) : null, a.kind ? String(a.kind) : null)
          .slice(0, limit);
      },
    });
  }

  // ---------------------------------------------------------------- 路由注册
  // 手法照搬 im-channel：注入回调里直接 register，不经 ctx.effect 包装

  ctx.webServer.register({ kind: 'prefix', path: API_PREFIX, handler: apiHandler });
  ctx.webServer.register({ kind: 'prefix', path: MEDIA_PREFIX, handler: mediaHandler });
  console.log(`[${PLUGIN}] routes registered: ${API_PREFIX}* ${MEDIA_PREFIX}*`);

  // 能力句柄：顶层注册的 reader_* 工具在 execute 时取用
  registerReaderToolsRef = registerReaderTools;
  return {
    ready, listFeeds, listItems, addFeed, refreshFeed, refreshAll, getArticleText, buildDigest,
    saveKbEntry, saveDigestToKb, searchKbEntries, getKbEntry, relatedKbEntries,
    kbNote: async (id, note) => { await kb().update(String(id), (c) => ({ ...c, note: String(note ?? '') })); return true; },
    kbRemove: async (id) => kb().delete(String(id)),
  };
}
