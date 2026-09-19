// dsh-pages 阅读器 · Host 半层
// 职责：订阅管理 / RSS+Atom 抓取解析 / storageDomain 持久化 / 图片代理 / JSON API（webServer 路由）
// 运行时约定：已安装 bundle 无 harness 全局，client↔host 走同源 HTTP（参照 im-channel 等已装插件）
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { XMLParser } from 'fast-xml-parser';

export const inject = ['storageDomain', 'webServer'];

const PLUGIN = 'dsh-pages-reader';
// 注意：webserver 前缀匹配规则是 pathname === prefix || pathname.startsWith(prefix + '/')，
// 因此注册前缀绝不能带尾斜杠（/reader-api/ 会要求子路径以 // 开头，全部 404）
const API_PREFIX = '/reader-api';
const MEDIA_PREFIX = '/reader-media';
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

const DomainSpec = {
  // 单元名规则 /^[a-z][a-z0-9_]*$/（dsh-storage UNIT_NAME_RE），连字符非法
  name: 'dsh_pages_reader',
  version: 1,
  invalidRecords: 'backup-and-skip',
  global: {
    schema: z.object({ mediaSecret: z.string(), seeded: z.boolean() }),
    initial: { mediaSecret: '', seeded: false },
  },
  tables: {
    feeds: { valueSchema: FeedSchema },
    items: { valueSchema: ItemSchema },
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

// ---------------------------------------------------------------- 插件入口

// start() 完成后赋值的能力句柄与工具注册器，供顶层的注入回调取用
let apiImpl = null;
let registerReaderToolsRef = null;

// apply 绝不抛出：任何装载期异常只禁用本插件，不拖死宿主
// 注意：ctx.inject 回调必须在【顶层】调用——嵌套 inject 的回调在本 cordis 版本会静默丢失
// （dsh-architect 用独立加载项、im-channel 用顶层 inject，均不嵌套，实证有效）
export function apply(ctx) {
  try {
    ctx.inject(['storageDomain', 'webServer'], (wctx) => {
      apiImpl = start(wctx);
    });
  } catch (e) {
    console.error(`[${PLUGIN}] apply failed: ${e?.stack || e}`);
  }
  try {
    ctx.inject(['tools'], (tctx) => {
      if (registerReaderToolsRef) {
        registerReaderToolsRef(tctx.tools, () => apiImpl);
        console.log(`[${PLUGIN}] reader_* tools registered`);
      } else {
        console.error(`[${PLUGIN}] tools registry unavailable, reader_* disabled`);
      }
    });
  } catch (e) {
    console.error(`[${PLUGIN}] tools unavailable, reader_* disabled: ${e.message}`);
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
        const content = txt(e.content) || txt(e.summary);
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
      const existing = items().get(key);
      await items().put(key, {
        feedId,
        title: it.title,
        link: it.link,
        author: it.author ?? '',
        publishedAt: it.publishedAt,
        snippet: it.snippet,
        contentHtml: it.contentHtml,
        readAt: existing?.readAt ?? null,
        starredAt: existing?.starredAt ?? null,
      });
      if (!existing) added += 1;
    }
    // 保留每个订阅最新的 N 条
    const mine = [...items().entries()].filter(([, v]) => v.feedId === feedId);
    mine.sort((a, b) => (a[1].publishedAt < b[1].publishedAt ? 1 : -1));
    for (const [key] of mine.slice(KEEP_ITEMS_PER_FEED)) await items().delete(key);
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

  async function refreshAll() {
    const out = [];
    for (const id of [...feeds().keys()]) out.push(await refreshFeed(id));
    return out;
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
    const feedMap = new Map(feeds ? [...feeds().entries()] : []);
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

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
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
          if (urls.length === 0) return json(res, 200, { ok: false, error: 'OPML 中未找到任何订阅（xmlUrl）' });
          const added = [];
          const skipped = [];
          const failed = [];
          for (const { url } of urls) {
            try {
              added.push(await addFeed(url));
            } catch (e) {
              if (/已存在/.test(e.message)) skipped.push(url);
              else failed.push({ url, error: e.message });
            }
          }
          return json(res, 200, { ok: true, total: urls.length, added, skipped, failed });
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
              contentHtml: rewriteMedia(v.contentHtml),
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
      if (len > MEDIA_BYTES_LIMIT) return fail(502, 'too large');
      const buf = Buffer.from(await r.arrayBuffer());
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
        schema: { type: ['array', 'object'] },
        render: (_a, v) => {
          const arr = Array.isArray(v) ? v : [v];
          const bad = arr.filter((r) => r && r.ok === false);
          return text(`刷新完成：${arr.length - bad.length} 成功${bad.length ? `，${bad.length} 失败（${bad.map((b) => b.error).join('；')}）` : ''}`);
        },
      },
      timeoutMs: 90000,
      execute: async (args) => {
        await api().ready;
        const id = args?.feedId ? String(args.feedId) : null;
        return id ? await api().refreshFeed(id) : await api().refreshAll();
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
  }

  // ---------------------------------------------------------------- 路由注册
  // 手法照搬 im-channel：注入回调里直接 register，不经 ctx.effect 包装

  ctx.webServer.register({ kind: 'prefix', path: API_PREFIX, handler: apiHandler });
  ctx.webServer.register({ kind: 'prefix', path: MEDIA_PREFIX, handler: mediaHandler });
  console.log(`[${PLUGIN}] routes registered: ${API_PREFIX}* ${MEDIA_PREFIX}*`);

  // 能力句柄：顶层注册的 reader_* 工具在 execute 时取用
  registerReaderToolsRef = registerReaderTools;
  return { ready, listFeeds, listItems, addFeed, refreshFeed, refreshAll, getArticleText, buildDigest };
}
