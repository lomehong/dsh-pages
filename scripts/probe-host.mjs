// 真宿主契约探针：对【正在运行的 DSH 宿主】断言 reader 插件的 HTTP 契约。
// 与 smoke-reader.mjs（mock 宿主干跑）互补：宿主升级导致路由语义/插件装载/消毒层
// 变化时，这里给出显式失败，而不是会话里静默丢工具或页面 404。
//
// 用法：node scripts/probe-host.mjs [baseUrl]     默认 http://127.0.0.1:3088
//
// 注意：
// - 会向真实存储短暂添加一个合成订阅并在结束时删除（自清理）；
// - 「服务端消毒」断言需要宿主已重启加载新插件代码后才可通过；
// - 工具平面（10 个 reader_*/kb_* 工具 per-agent 注入）无法从宿主外断言，
//   以"新会话工具清单含 10 工具"为准（见 README 插件开发约定）。
import { createServer } from 'node:http';

const base = (process.argv[2] ?? 'http://127.0.0.1:3088').replace(/\/$/, '');

let failed = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'OK ' : 'FAIL'}: ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) failed += 1;
};

async function api(path, body) {
  const r = await fetch(
    `${base}/reader-api/${path}`,
    body !== undefined
      ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
      : undefined,
  );
  return { status: r.status, json: await r.json().catch(() => null) };
}

// ---- 只读端点形状
const feeds = await api('feeds');
check('GET feeds → 200 数组', feeds.status === 200 && Array.isArray(feeds.json), `${feeds.json?.length ?? 'x'} 个订阅`);
const items = await api('items');
check('GET items → 200 数组', items.status === 200 && Array.isArray(items.json));
const kbList = await api('kb/list');
check('GET kb/list → 200 数组', kbList.status === 200 && Array.isArray(kbList.json));
const related = await api('kb/related?articleId=probe-nonexistent');
check('GET kb/related → 200 数组', related.status === 200 && Array.isArray(related.json));

// ---- 媒体路由存在性与密钥语义
const media = await fetch(`${base}/reader-media/probe-wrong-secret/aaaa`);
check('GET /reader-media 错误密钥 → 404', media.status === 404, `status=${media.status}`);

// ---- 非法订阅地址
const bad = await api('feeds/add', { url: 'not-a-url' });
check('POST feeds/add 非法地址 → ok:false', bad.json?.ok === false, bad.json?.error ?? '');

// ---- 合成敌意源：增 → 验服务端消毒 → 删（自清理）
const xmlEscape = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const HOSTILE =
  '<script>alert(1)</script><img src=x onerror=alert(1)><a href="javascript:alert(1)">点我</a><iframe src="https://evil.example"></iframe>';
const atom =
  `<?xml version="1.0" encoding="utf-8"?>\n` +
  `<feed xmlns="http://www.w3.org/2005/Atom" xmlns:content="http://purl.org/rss/1.0/modules/content/">\n` +
  `<title>探针合成源</title>\n` +
  `<entry><id>probe-1</id><title>探针文章</title><link href="https://mp.weixin.qq.com/s/probe-1"/>` +
  `<updated>2026-01-01T00:00:00Z</updated><summary>probe</summary><author>probe</author>` +
  `<content:encoded>${xmlEscape(`${HOSTILE}<p>正文标记词蓝鲸铁路。</p>`)}</content:encoded></entry>\n</feed>`;
const syn = createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/atom+xml; charset=utf-8' });
  res.end(atom);
});
await new Promise((r) => syn.listen(0, '127.0.0.1', r));
const synUrl = `http://127.0.0.1:${syn.address().port}/feed.atom`;
try {
  const add = await api('feeds/add', { url: synUrl });
  check('POST feeds/add 合成源 → ok:true', add.json?.ok === true, add.json?.error ?? add.json?.title ?? '');
  if (add.json?.ok) {
    const list = await api(`items?feedId=${encodeURIComponent(add.json.id)}`);
    const first = list.json?.[0];
    check('合成源文章入库', !!first, `${list.json?.length ?? 0} 篇`);
    if (first) {
      const detail = await api(`item?id=${encodeURIComponent(first.id)}`);
      const html = detail.json?.item?.contentHtml ?? '';
      check('真宿主消毒：<script>/<iframe> 删除', !/<script|<iframe/i.test(html), html.slice(0, 100));
      check('真宿主消毒：onerror 删除', !/onerror/i.test(html));
      check('真宿主消毒：javascript: 删除', !/javascript:/i.test(html));
      check('正文保留（标记词）', html.includes('蓝鲸铁路'));
    }
    const rm = await api('feeds/remove', { id: add.json.id });
    check('POST feeds/remove 自清理 → ok:true', rm.json?.ok === true);
    const after = await api(`items?feedId=${encodeURIComponent(add.json.id)}`);
    check('删除订阅后级联清空文章', Array.isArray(after.json) && after.json.length === 0);
  }
} finally {
  syn.close();
}

console.log(failed === 0 ? '\n真宿主契约探针全部通过 ✓' : `\n${failed} 项失败 ✗`);
process.exit(failed === 0 ? 0 : 1);
