// 宿主外烟雾测试：用 mock 的严格 cordis 上下文干跑 packages/reader/index.js
// 验证：模块可导入、apply 不抛、种子源真实抓取、API 路由各端点响应正常
// 用法：node scripts/smoke-reader.mjs   （前置：RSSHub 容器在 :1200 运行）
import { EventEmitter } from 'node:events';

const { apply, inject } = await import('../packages/reader/index.js');

if (!Array.isArray(inject) || !inject.includes('storageDomain') || !inject.includes('webServer')) {
  console.error('FAIL: inject 声明不对', inject);
  process.exit(1);
}

// ---- 严格上下文 mock：未注入属性直接抛错（模拟 cordis 行为）
const routes = new Map();
const disposers = [];
const domains = new Map();
const toolDefs = new Map();

function makeTable() {
  const m = new Map();
  return {
    get: (k) => m.get(k),
    entries: () => m.entries(),
    keys: () => m.keys(),
    get size() { return m.size; },
    put: async (k, v) => { m.set(k, v); },
    delete: async (k) => m.delete(k),
    update: async (k, fn) => { const nv = fn(m.get(k)); m.set(k, nv); return nv; },
  };
}

const UNIT_NAME_RE = /^[a-z][a-z0-9_]*$/; // 与 dsh-storage 一致

const ctx = {
  get(name) { throw new Error(`cannot get property "${name}" without inject`); },
  inject(names, cb) {
    const available = { storageDomain: true, webServer: true, tools: true };
    for (const n of names) {
      if (!available[n]) throw new Error(`cannot inject "${n}": not provided`);
    }
    cb(ctx);
    return () => {};
  },
  on() { return () => {}; },
  provide() { return () => {}; },
  effect(cb, label) {
    try {
      const d = cb();
      disposers.push([label, d]);
      return typeof d === 'function' ? d : () => {};
    } catch (e) {
      console.error(`FAIL: effect(${label}) 抛错: ${e.message}`);
      process.exit(1);
    }
  },
  storageDomain: {
    async open(spec) {
      if (!UNIT_NAME_RE.test(spec.name)) throw new Error(`invalid unit name '${spec.name}'`);
      for (const t of Object.keys(spec.tables ?? {})) {
        if (!UNIT_NAME_RE.test(t)) throw new Error(`invalid table name '${t}'`);
      }
      const tables = new Map();
      let globalVal = spec.global?.initial;
      const dom = {
        name: spec.name,
        global: { get: () => globalVal, set: async (v) => { globalVal = v; } },
        table(name) {
          if (!tables.has(name)) tables.set(name, makeTable());
          return tables.get(name);
        },
        close: async () => {},
      };
      domains.set(spec.name, dom);
      return dom;
    },
  },
  webServer: {
    register(route) {
      routes.set(route.path, route);
      return () => routes.delete(route.path);
    },
  },
  tools: {
    register(def) {
      if (!def?.name || typeof def.execute !== 'function') throw new Error('bad tool definition');
      if (toolDefs.has(def.name)) throw new Error(`duplicate tool ${def.name}`);
      // 与宿主一致的 schema 校验：type 必须是单个类型字符串，不接受类型数组
      if (Array.isArray(def.output?.schema?.type)) {
        throw new Error('unsupported JSON schema: schema.type must be a single type string');
      }
      toolDefs.set(def.name, def);
      return () => toolDefs.delete(def.name);
    },
  },
};

// 与 dsh-host-webserver 一致的匹配语义：exact 全等；prefix 为 pathname === prefix 或 startsWith(prefix + '/')
function matchRoute(pathname) {
  for (const r of routes.values()) {
    if (r.kind === 'exact' && pathname === r.path) return r.handler;
    if (r.kind === 'prefix' && (pathname === r.path || pathname.startsWith(`${r.path}/`))) return r.handler;
  }
  return null;
}

apply(ctx);
console.log('OK: apply 未抛错');

// ---- 请求模拟
function mockReq(method, url, body) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  process.nextTick(() => {
    if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body)));
    req.emit('end');
  });
  return req;
}
function mockRes() {
  return {
    status: 0,
    headers: {},
    body: null,
    writeHead(s, h) { this.status = s; this.headers = h ?? {}; },
    end(b) { this.body = b; },
  };
}
async function callApi(method, path, body) {
  const url = `/reader-api/${path}`;
  const handler = matchRoute(new URL(url, 'http://local').pathname);
  if (!handler) throw new Error(`api 路由未匹配: ${url}`);
  const res = mockRes();
  await handler(mockReq(method, url, body), res);
  const text = Buffer.isBuffer(res.body) ? res.body.toString('utf8') : String(res.body ?? '');
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

let failed = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'OK ' : 'FAIL'}: ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) failed += 1;
};

// ---- 等待初始化（种子源真实抓取 RSSHub）
console.log('等待种子源抓取（localhost:1200）…');
let feeds = [];
for (let i = 0; i < 30; i++) {
  await new Promise((r) => setTimeout(r, 2000));
  try {
    const r = await callApi('GET', 'feeds');
    if (r.status === 200 && Array.isArray(r.json) && r.json.length >= 2 && r.json.every((f) => f.lastFetchAt)) {
      feeds = r.json;
      break;
    }
  } catch {}
}
check('种子源就位（≥2 个且抓取成功）', feeds.length >= 2, feeds.map((f) => `${f.title}(${f.unread}未读)`).join(' / ') || '无');

const items = (await callApi('GET', 'items')).json;
check('文章列表非空', Array.isArray(items) && items.length > 0, `${items?.length ?? 0} 篇`);

const first = items?.[0];
let detail = null;
if (first) {
  const r = await callApi('GET', `item?id=${encodeURIComponent(first.id)}`);
  detail = r.json?.item;
  check('文章详情可取', r.status === 200 && !!detail, detail ? detail.title : '');
  check('详情含全文 HTML', !!detail?.contentHtml, `${detail?.contentHtml?.length ?? 0} 字符`);
  const mr = await callApi('POST', 'items/markRead', { id: first.id, read: true });
  check('标记已读', mr.json?.ok === true);
}

const addBad = await callApi('POST', 'feeds/add', { url: 'not-a-url' });
check('非法地址返回 ok:false', addBad.json?.ok === false, addBad.json?.error ?? '');

// ---- P3：星标 / 关键词过滤 / OPML 导入
if (first) {
  await callApi('POST', 'items/star', { id: first.id, starred: true });
  const starredList = (await callApi('GET', 'items?starredOnly=1')).json;
  check('星标后可按星标过滤', Array.isArray(starredList) && starredList.some((i) => i.id === first.id && i.starred === true));
  await callApi('POST', 'items/star', { id: first.id, starred: false });
  const unstarredList = (await callApi('GET', 'items?starredOnly=1')).json;
  check('取消星标后从星标列表消失', !unstarredList?.some((i) => i.id === first.id));
}

const sspai = feeds.find((f) => /sspai|少数派/.test(f.title) || /sspai/.test(f.url));
if (sspai) {
  await callApi('POST', 'feeds/filter', { id: sspai.id, include: 'zzz不存在的词', exclude: '' });
  const filtered = (await callApi('GET', `items?feedId=${sspai.id}`)).json;
  check('关键词 include 过滤生效', Array.isArray(filtered) && filtered.length === 0, `${filtered?.length ?? '?'} 篇`);
  await callApi('POST', 'feeds/filter', { id: sspai.id, include: '', exclude: '' });
  const restored = (await callApi('GET', `items?feedId=${sspai.id}`)).json;
  check('清除过滤后恢复', Array.isArray(restored) && restored.length > 0);
}

const opml = `<?xml version="1.0"?>
<opml version="1.0"><body>
<outline text="重复源" xmlUrl="http://localhost:1200/sspai/matrix"/>
<outline text="新源" xmlUrl="http://localhost:4000/feeds/all.atom"/>
<outline text="坏源" xmlUrl="http://localhost:9/nope"/>
</body></opml>`;
const imp = (await callApi('POST', 'feeds/import-opml', { opml })).json;
check(
  'OPML 导入：新增/跳过/失败分类正确',
  imp?.ok === true && imp.total === 3 && imp.added?.length === 1 && imp.skipped?.length === 1 && imp.failed?.length === 1,
  `total=${imp?.total} added=${imp?.added?.length} skipped=${imp?.skipped?.length} failed=${imp?.failed?.length}`,
);

// ---- 回归：Atom 的 content:encoded 正文（we-mp-rss 公众号源的真实形态）
// 起进程内小服务器提供一个带 content:encoded 全文的合成 Atom feed
const { createServer } = await import('node:http');
const longText = '公众号正文内容。'.repeat(200); // 1600+ 字符，远超摘要
const syntheticAtom = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:content="http://purl.org/rss/1.0/modules/content/">
<title>合成公众号</title>
<entry><id>syn-1</id><title>合成文章</title><link href="https://mp.weixin.qq.com/s/abc"/><updated>2026-09-19T12:00:00+08:00</updated><summary>摘要</summary><author>合成</author><content:encoded>&lt;p&gt;${longText}&lt;/p&gt;</content:encoded></entry>
</feed>`;
const synServer = createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/atom+xml; charset=utf-8' });
  res.end(syntheticAtom);
});
await new Promise((r) => synServer.listen(0, '127.0.0.1', r));
const synPort = synServer.address().port;
try {
  const addR = await callApi('POST', 'feeds/add', { url: `http://127.0.0.1:${synPort}/feed.atom` });
  check('合成 Atom 源添加成功', addR.json?.ok === true && addR.json.added === 1, JSON.stringify(addR.json));
  const synItems = (await callApi('GET', `items?feedId=${addR.json.id}`)).json;
  const synDetail = (await callApi('GET', `item?id=${encodeURIComponent(synItems[0].id)}`)).json;
  check(
    'content:encoded 正文完整入库',
    synDetail?.item?.contentHtml?.length > 1000,
    `${synDetail?.item?.contentHtml?.length ?? 0} 字符`,
  );
} finally {
  synServer.close();
}

// 媒体代理：错误密钥应 404
const mediaHandler = matchRoute('/reader-media/wrong-secret/aaaa');
check('媒体路由已注册并可匹配', typeof mediaHandler === 'function');
if (mediaHandler) {
  const res = mockRes();
  await mediaHandler(mockReq('GET', '/reader-media/wrong-secret/aaaa'), res);
  check('媒体路由错误密钥 404', res.status === 404);
}

// ---- 知识库（P4）
const kbSave = (await callApi('POST', 'kb/save', {
  title: '冒烟测试条目',
  text: '知识库检索冒烟测试的关键词是荧光绿狐狸。',
  tags: ['冒烟', '测试'],
})).json;
check('kb/save 手动条目', kbSave?.ok === true && !!kbSave.id, kbSave?.id ?? kbSave?.error);

if (first) {
  const fa = (await callApi('POST', 'kb/from-article', { articleId: first.id, tags: ['来自文章'] })).json;
  check('kb/from-article 文章快照入库', fa?.ok === true && (fa.title?.length ?? 0) > 0, fa?.title ?? fa?.error);
}

const kbHit = (await callApi('GET', 'kb/list?query=' + encodeURIComponent('荧光绿狐狸'))).json;
check('kb/list 关键词检索命中', Array.isArray(kbHit) && kbHit.some((i) => i.id === kbSave.id), `${kbHit?.length ?? 0} 条`);

const kbEntry = (await callApi('GET', `kb/entry?id=${encodeURIComponent(kbSave.id)}`)).json;
check('kb/entry 读取全文', kbEntry?.ok === true && kbEntry.entry.contentText.includes('荧光绿狐狸'));

await callApi('POST', 'kb/note', { id: kbSave.id, note: '补一条笔记' });
const kbAfterNote = (await callApi('GET', `kb/entry?id=${encodeURIComponent(kbSave.id)}`)).json;
check('kb/note 笔记更新', kbAfterNote?.entry?.note === '补一条笔记');

const kbArch = (await callApi('POST', 'kb/save-digest', { hours: 24 * 30, unreadOnly: false })).json;
check('kb/save-digest 日报归档', kbArch?.ok === true && kbArch.itemCount > 0, `${kbArch?.itemCount ?? 0} 篇 / ${kbArch?.feedCount ?? 0} 源`);

const kbRemove = (await callApi('POST', 'kb/remove', { id: kbSave.id })).json;
check('kb/remove 删除', kbRemove?.ok === true);

// ---- 阅读反哺：文章页相关知识库条目
if (first) {
  const rel = (await callApi('GET', `kb/related?articleId=${encodeURIComponent(first.id)}`)).json;
  check(
    'kb/related 命中同源条目',
    Array.isArray(rel) && rel.some((i) => i.title === first.title),
    `${rel?.length ?? 0} 条相关`,
  );
}

// ---- Agent 工具（P2）
const expectedTools = [
  'reader_list_feeds', 'reader_list_items', 'reader_get_article', 'reader_add_feed', 'reader_refresh', 'reader_digest',
  'kb_save', 'kb_search', 'kb_read', 'kb_list',
];
check(
  '10 个 reader_*/kb_* 工具已注册',
  expectedTools.every((n) => toolDefs.has(n)),
  [...toolDefs.keys()].join(', '),
);

async function execTool(name, args) {
  const def = toolDefs.get(name);
  const value = await def.execute(args ?? {});
  // render 必须能消化 execute 的返回值（模型看到的卡片来自这里）
  const blocks = def.output?.render?.(args ?? {}, value);
  if (!Array.isArray(blocks) || !blocks.length) throw new Error(`${name} render 未产出内容块`);
  return value;
}

if (expectedTools.every((n) => toolDefs.has(n))) {
  try {
    const feedList = await execTool('reader_list_feeds');
    check('reader_list_feeds 可执行', Array.isArray(feedList) && feedList.length >= 2);

    const toolItems = await execTool('reader_list_items', { limit: 5 });
    check('reader_list_items 可执行', Array.isArray(toolItems) && toolItems.length > 0, `${toolItems?.length ?? 0} 篇`);

    const article = await execTool('reader_get_article', { id: toolItems[0].id });
    check('reader_get_article 返回正文', typeof article?.text === 'string' && article.text.length > 0, `${article?.text?.length ?? 0} 字符（${article?.source}）`);

    const digest = await execTool('reader_digest', { hours: 24 * 30, unreadOnly: false });
    check('reader_digest 产出分组素材', digest?.itemCount > 0 && digest?.groups?.length > 0, `${digest?.itemCount} 篇 / ${digest?.feedCount} 源`);

    const badAdd = await execTool('reader_add_feed', { url: 'not-a-url' });
    check('reader_add_feed 非法地址 ok:false', badAdd?.ok === false);

    await execTool('kb_save', { title: '工具入库条目', text: 'kb 工具链路冒烟关键词是深海蓝鲸。', tags: '冒烟' });
    const kbSearchRes = await execTool('kb_search', { query: '深海蓝鲸' });
    check('kb_search 命中', Array.isArray(kbSearchRes) && kbSearchRes.some((i) => i.title === '工具入库条目'));
    const kbHit2 = kbSearchRes[0];
    const kbReadRes = await execTool('kb_read', { id: kbHit2.id });
    check('kb_read 读全文', kbReadRes?.contentText?.includes('深海蓝鲸'));
    const kbListRes = await execTool('kb_list', {});
    check('kb_list 浏览', Array.isArray(kbListRes) && kbListRes.length > 0);
  } catch (e) {
    check('工具执行链路无异常', false, e.message);
  }
}

console.log(failed === 0 ? '\n全部通过 ✓' : `\n${failed} 项失败 ✗`);
process.exit(failed === 0 ? 0 : 1);
