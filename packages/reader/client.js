// dsh-pages 阅读器 · Client 半层
// 落点：sidebar.panellist 注册图标（id reading）→ main 面板注册三栏阅读器（key reading）
// 数据通道：同源 fetch /reader-api/*（参照 im-channel 等已装插件的成熟模式）
window.__ModuleLoader__.load({
  id: '@dsh-pages/reader',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const API = '/reader-api/';

    async function api(path, body) {
      const r = await fetch(
        API + path,
        body !== undefined
          ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
          : undefined,
      );
      if (!r.ok) {
        let msg = `HTTP ${r.status}`;
        try {
          const j = await r.json();
          if (j && j.error) msg = j.error;
        } catch {}
        throw new Error(msg);
      }
      return r.json();
    }

    function relTime(iso) {
      const t = new Date(iso).getTime();
      if (Number.isNaN(t)) return '';
      const s = Math.max(0, (Date.now() - t) / 1000);
      if (s < 60) return '刚刚';
      if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
      if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
      if (s < 86400 * 30) return `${Math.floor(s / 86400)} 天前`;
      const d = new Date(t);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }

    // 知识库受限 markdown 渲染：先整体转义，再恢复 #/##/### 标题、- 列表与链接。
    // 面向日报与纯文本快照，够用且安全（不做任意 markdown）
    function kbRender(text) {
      const anchor = (u) => {
        const short = u.replace(/^https?:\/\//, '').replace(/\/$/, '');
        const shown = short.length > 46 ? `${short.slice(0, 46)}…` : short;
        return `<a href="${u}" target="_blank" rel="noopener noreferrer">${shown}</a>`;
      };
      const out = [];
      let inList = false;
      const closeList = () => {
        if (inList) {
          out.push('</ul>');
          inList = false;
        }
      };
      for (const raw of String(text ?? '').split(/\r?\n/)) {
        const line = raw.trim();
        if (/^###\s+/.test(line)) { closeList(); out.push(`<h5>${line.replace(/^###\s+/, '')}</h5>`); continue; }
        if (/^##\s+/.test(line)) { closeList(); out.push(`<h4>${line.replace(/^##\s+/, '')}</h4>`); continue; }
        if (/^#\s+/.test(line)) { closeList(); out.push(`<h3>${line.replace(/^#\s+/, '')}</h3>`); continue; }
        if (/^(?:[-•*]|\d+[.、])\s+/.test(line)) {
          if (!inList) { out.push('<ul>'); inList = true; }
          out.push(`<li>${line.replace(/^(?:[-•*]|\d+[.、])\s+/, '')}</li>`);
          continue;
        }
        closeList();
        if (line === '') { out.push('<div class="dshr-kb-sp"></div>'); continue; }
        out.push(`<p>${line}</p>`);
      }
      closeList();
      let html = out.join('\n');
      // 链接化：<https://…> 自动链接（日报格式）与裸链接；显示文本截断
      html = html.replace(/&lt;(https?:\/\/[^&\s]+?)&gt;/g, (m, u) => anchor(u));
      html = html.replace(/(^|[\s(])((?:https?:\/\/)[^\s<]+?)(?=[。）)\s]|$)/g, (m, pre, u) => pre + anchor(u));
      return html;
    }

    // ---------------------------------------------------------------- 侧边栏图标

    function PanelIcon(props) {
      const size = (props && props.size) || 20;
      const active = !!(props && props.active);
      return h(
        'svg',
        {
          viewBox: '0 0 24 24',
          width: size,
          height: size,
          'aria-hidden': true,
          style: {
            display: 'block',
            color: active ? 'var(--dsw-alias-brand-primary)' : 'currentColor',
          },
        },
        h('path', {
          fill: 'currentColor',
          d: 'M4 4.44v2.83c7.03 0 12.73 5.7 12.73 12.73h2.83c0-8.59-6.97-15.56-15.56-15.56zm0 5.66v2.83c3.9 0 7.07 3.17 7.07 7.07h2.83c0-5.47-4.43-9.9-9.9-9.9zM6.18 15.64a2.18 2.18 0 1 0 0 4.36 2.18 2.18 0 0 0 0-4.36z',
        }),
      );
    }

    // ---------------------------------------------------------------- 阅读器主面板

    function ReaderApp() {
      const [feeds, setFeeds] = React.useState([]);
      const [items, setItems] = React.useState([]);
      const [feedId, setFeedId] = React.useState('all');
      const [unreadOnly, setUnreadOnly] = React.useState(false);
      const [starredOnly, setStarredOnly] = React.useState(false);
      const [selected, setSelected] = React.useState(null);
      const [detail, setDetail] = React.useState(null);
      const [addUrl, setAddUrl] = React.useState('');
      const [adding, setAdding] = React.useState(false);
      const [importing, setImporting] = React.useState(false);
      const [notice, setNotice] = React.useState('');
      const [refreshing, setRefreshing] = React.useState(false);
      const fileInputRef = React.useRef(null);
      // 知识库视图
      const [kbView, setKbView] = React.useState(false);
      const [kbList, setKbList] = React.useState([]);
      const [kbQuery, setKbQuery] = React.useState('');
      const [kbDetail, setKbDetail] = React.useState(null);
      const [kbNote, setKbNote] = React.useState('');
      const [relatedKb, setRelatedKb] = React.useState([]);

      const loadFeeds = React.useCallback(async () => {
        try {
          setFeeds(await api('feeds'));
        } catch (e) {
          setNotice(`加载订阅失败：${e.message || e}`);
        }
      }, []);

      const loadItems = React.useCallback(async () => {
        try {
          const params = new URLSearchParams();
          if (feedId !== 'all') params.set('feedId', feedId);
          if (unreadOnly) params.set('unreadOnly', '1');
          if (starredOnly) params.set('starredOnly', '1');
          setItems(await api(`items?${params}`));
        } catch (e) {
          setNotice(`加载文章失败：${e.message || e}`);
        }
      }, [feedId, unreadOnly, starredOnly]);

      // 仅挂载一次：首屏加载 + 后台刷新一轮 + 定时轻量重载
      React.useEffect(() => {
        let stop = false;
        (async () => {
          await loadFeeds();
          await loadItems();
          api('feeds/refresh', {}).then(async () => {
            if (stop) return;
            await loadFeeds();
            await loadItems();
          }).catch(() => {});
        })();
        const timer = setInterval(() => {
          loadFeeds();
          loadItems();
        }, 90 * 1000);
        return () => {
          stop = true;
          clearInterval(timer);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);

      // 切换订阅/未读过滤时只重载文章列表
      React.useEffect(() => {
        loadItems();
      }, [loadItems]);

      async function addFeed() {
        const url = addUrl.trim();
        if (!url) return;
        setAdding(true);
        setNotice('');
        try {
          const r = await api('feeds/add', { url });
          if (r && r.ok) {
            setAddUrl('');
            setNotice(`已添加「${r.title}」，收录 ${r.added} 篇`);
            await loadFeeds();
            await loadItems();
          } else {
            setNotice(`添加失败：${(r && r.error) || '未知错误'}`);
          }
        } catch (e) {
          setNotice(`添加失败：${e.message || e}`);
        } finally {
          setAdding(false);
        }
      }

      async function removeFeed(id, title) {
        if (!window.confirm(`删除订阅「${title}」及其全部文章？`)) return;
        try {
          await api('feeds/remove', { id });
        } catch {}
        if (feedId === id) setFeedId('all');
        await loadFeeds();
        await loadItems();
      }

      async function refreshNow() {
        setRefreshing(true);
        try {
          await api('feeds/refresh', {});
          await loadFeeds();
          await loadItems();
        } catch (e) {
          setNotice(`刷新失败：${e.message || e}`);
        } finally {
          setRefreshing(false);
        }
      }

      // OPML 批量导入
      function pickOpmlFile() {
        fileInputRef.current?.click();
      }

      async function onOpmlFile(e) {
        const file = e.target.files?.[0];
        e.target.value = '';
        if (!file) return;
        setImporting(true);
        setNotice('正在导入 OPML…');
        try {
          const opml = await file.text();
          const r = await api('feeds/import-opml', { opml });
          if (r && r.ok) {
            setNotice(
              `OPML 导入完成：共 ${r.total} 个，新增 ${r.added.length}，已存在 ${r.skipped.length}` +
                (r.failed.length ? `，失败 ${r.failed.length}（${r.failed[0].error}）` : ''),
            );
            await loadFeeds();
            await loadItems();
          } else {
            setNotice(`导入失败：${(r && r.error) || '未知错误'}`);
          }
        } catch (err) {
          setNotice(`导入失败：${err.message || err}`);
        } finally {
          setImporting(false);
        }
      }

      // 关键词过滤编辑（格式：包含词1|包含词2 // 排除词1|排除词2）
      async function editFilter(f) {
        const cur = `${f.include || ''}${f.exclude ? ` // ${f.exclude}` : ''}`;
        const input = window.prompt(
          `「${f.title}」关键词过滤\n格式：包含词1|包含词2 // 排除词1|排除词2\n留空则清除过滤：`,
          cur,
        );
        if (input === null) return;
        const [include = '', exclude = ''] = input.split('//').map((s) => s.trim());
        try {
          await api('feeds/filter', { id: f.id, include, exclude });
          setNotice(include || exclude ? `已设置「${f.title}」过滤` : `已清除「${f.title}」过滤`);
          await loadFeeds();
          await loadItems();
        } catch (err) {
          setNotice(`设置失败：${err.message || err}`);
        }
      }

      async function toggleStar() {
        if (!detail) return;
        const next = !detail.starred;
        try {
          await api('items/star', { id: detail.id, starred: next });
        } catch {}
        setDetail((d) => (d ? { ...d, starred: next } : d));
        setItems((cur) => cur.map((it) => (it.id === detail.id ? { ...it, starred: next } : it)));
      }

      async function openItem(id) {
        setSelected(id);
        setDetail(null);
        setRelatedKb([]);
        try {
          const r = await api(`item?id=${encodeURIComponent(id)}`);
          if (r && r.ok) {
            setDetail(r.item);
            api(`kb/related?articleId=${encodeURIComponent(id)}`)
              .then((list) => setRelatedKb(Array.isArray(list) ? list : []))
              .catch(() => {});
          } else setNotice((r && r.error) || '文章加载失败');
        } catch (e) {
          setNotice(`文章加载失败：${e.message || e}`);
        }
        api('items/markRead', { id, read: true }).catch(() => {});
        setItems((cur) => cur.map((it) => (it.id === id ? { ...it, read: true } : it)));
        setFeeds((cur) =>
          cur.map((f) => {
            const it = items.find((x) => x.id === id);
            return it && f.id === it.feedId && f.unread > 0 ? { ...f, unread: f.unread - 1 } : f;
          }),
        );
      }

      // ---------------- 知识库 ----------------
      const loadKb = React.useCallback(async (q) => {
        try {
          const params = new URLSearchParams();
          if (q) params.set('query', q);
          setKbList(await api(`kb/list?${params}`));
        } catch (e) {
          setNotice(`知识库加载失败：${e.message || e}`);
        }
      }, []);

      function toggleKbView() {
        const next = !kbView;
        setKbView(next);
        setKbDetail(null);
        if (next) loadKb('');
      }

      async function searchKbNow() {
        await loadKb(kbQuery.trim());
      }

      async function openKbEntry(id) {
        try {
          const r = await api(`kb/entry?id=${encodeURIComponent(id)}`);
          if (r && r.ok) {
            setKbDetail(r.entry);
            setKbNote(r.entry.note || '');
          }
        } catch (e) {
          setNotice(`条目加载失败：${e.message || e}`);
        }
      }

      async function saveKbNote() {
        if (!kbDetail) return;
        try {
          await api('kb/note', { id: kbDetail.id, note: kbNote });
          setKbDetail((d) => (d ? { ...d, note: kbNote } : d));
          setNotice('笔记已保存');
        } catch (e) {
          setNotice(`保存失败：${e.message || e}`);
        }
      }

      async function removeKbEntry(id) {
        if (!window.confirm('删除这条知识库条目？')) return;
        try {
          await api('kb/remove', { id });
        } catch {}
        setKbDetail(null);
        await loadKb(kbQuery.trim());
      }

      async function saveArticleToKb() {
        if (!detail) return;
        try {
          const r = await api('kb/from-article', { articleId: detail.id, tags: [detail.feedTitle].filter(Boolean) });
          setNotice(r && r.ok ? `已入库「${r.title}」` : `入库失败：${(r && r.error) || '未知错误'}`);
        } catch (e) {
          setNotice(`入库失败：${e.message || e}`);
        }
      }

      async function archiveDigest() {
        try {
          const r = await api('kb/save-digest', { hours: 24, unreadOnly: false });
          setNotice(r && r.ok ? `今日日报已归档（${r.itemCount} 篇 / ${r.feedCount} 源）` : `归档失败：${(r && r.error) || '未知错误'}`);
        } catch (e) {
          setNotice(`归档失败：${e.message || e}`);
        }
      }

      const totalUnread = feeds.reduce((n, f) => n + (f.unread || 0), 0);

      // ----- 左栏：订阅列表
      const feedCol = h(
        'div',
        { className: 'dshr-col dshr-feeds' },
        h(
          'div',
          { className: 'dshr-head' },
          h('span', { className: 'dshr-title' }, '订阅'),
          h(
            'label',
            { className: 'dshr-unread-toggle' },
            h('input', {
              type: 'checkbox',
              checked: unreadOnly,
              onChange: (e) => setUnreadOnly(e.target.checked),
            }),
            '未读',
          ),
          h(
            'label',
            { className: 'dshr-unread-toggle' },
            h('input', {
              type: 'checkbox',
              checked: starredOnly,
              onChange: (e) => setStarredOnly(e.target.checked),
            }),
            '星标',
          ),
          h(
            'button',
            { className: 'dshr-btn', onClick: refreshNow, disabled: refreshing },
            refreshing ? '刷新中…' : '刷新',
          ),
        ),
        h(
          'div',
          { className: 'dshr-add' },
          h('input', {
            className: 'dshr-input',
            placeholder: '粘贴 RSS / RSSHub / wewe-rss 地址…',
            value: addUrl,
            onChange: (e) => setAddUrl(e.target.value),
            onKeyDown: (e) => {
              if (e.key === 'Enter') addFeed();
            },
          }),
          h('button', { className: 'dshr-btn dshr-btn-primary', onClick: addFeed, disabled: adding }, adding ? '…' : '添加'),
          h(
            'button',
            { className: 'dshr-btn', onClick: pickOpmlFile, disabled: importing, title: '从 OPML 文件批量导入订阅' },
            importing ? '…' : 'OPML',
          ),
          h('input', {
            ref: fileInputRef,
            type: 'file',
            accept: '.opml,.xml',
            style: { display: 'none' },
            onChange: onOpmlFile,
          }),
        ),
        notice ? h('div', { className: 'dshr-notice' }, notice) : null,
        h(
          'div',
          { className: 'dshr-feed-list' },
          h(
            'div',
            {
              className: `dshr-feed${kbView ? ' active' : ''}`,
              onClick: toggleKbView,
              title: '收藏的文章快照、笔记与日报归档',
            },
            h('span', { className: 'dshr-feed-title' }, '📚 知识库'),
            h(
              'button',
              {
                className: 'dshr-feed-del',
                title: '归档今日日报到知识库',
                onClick: (e) => {
                  e.stopPropagation();
                  archiveDigest();
                },
              },
              '📨',
            ),
          ),
          h(
            'div',
            {
              className: `dshr-feed${!kbView && feedId === 'all' ? ' active' : ''}`,
              onClick: () => {
                setKbView(false);
                setFeedId('all');
              },
            },
            h('span', { className: 'dshr-feed-title' }, '全部'),
            totalUnread > 0 ? h('span', { className: 'dshr-badge' }, String(totalUnread)) : null,
          ),
          feeds.map((f) =>
            h(
              'div',
              {
                key: f.id,
                className: `dshr-feed${!kbView && feedId === f.id ? ' active' : ''}`,
                onClick: () => {
                  setKbView(false);
                  setFeedId(f.id);
                },
                title: f.lastError ? `抓取失败：${f.lastError}` : f.url,
              },
               h('span', { className: 'dshr-feed-title' }, f.lastError ? `⚠ ${f.title}` : f.title),
              (f.include || f.exclude) ? h('span', { className: 'dshr-filter-mark', title: `过滤：${f.include || ''}${f.exclude ? ` // ${f.exclude}` : ''}` }, '⧩') : null,
              f.unread > 0 ? h('span', { className: 'dshr-badge' }, String(f.unread)) : null,
              h(
                'button',
                {
                  className: 'dshr-feed-del',
                  title: '关键词过滤',
                  onClick: (e) => {
                    e.stopPropagation();
                    editFilter(f);
                  },
                },
                '⚙',
              ),
              h(
                'button',
                {
                  className: 'dshr-feed-del',
                  title: '删除订阅',
                  onClick: (e) => {
                    e.stopPropagation();
                    removeFeed(f.id, f.title);
                  },
                },
                '×',
              ),
            ),
          ),
          feeds.length === 0
            ? h('div', { className: 'dshr-hint' }, '还没有订阅。试试：http://localhost:1200/sspai/matrix')
            : null,
        ),
      );

      // ----- 中栏：文章列表 / 知识库列表
      const itemCol = kbView
        ? h(
            'div',
            { className: 'dshr-col dshr-items' },
            h(
              'div',
              { className: 'dshr-kb-search' },
              h('input', {
                className: 'dshr-input',
                placeholder: '在知识库中搜索…',
                value: kbQuery,
                onChange: (e) => setKbQuery(e.target.value),
                onKeyDown: (e) => {
                  if (e.key === 'Enter') searchKbNow();
                },
              }),
              h('button', { className: 'dshr-btn dshr-btn-primary', onClick: searchKbNow }, '搜索'),
            ),
            kbList.map((k) =>
              h(
                'div',
                {
                  key: k.id,
                  className: `dshr-item${kbDetail && kbDetail.id === k.id ? ' active' : ''}`,
                  onClick: () => openKbEntry(k.id),
                },
                h('div', { className: 'dshr-item-title' }, `${k.kind === 'digest' ? '📰 ' : k.kind === 'manual' ? '📝 ' : '📄 '}${k.title}`),
                h(
                  'div',
                  { className: 'dshr-item-meta' },
                  `${k.sourceFeedTitle || k.kind} · ${relTime(k.createdAt)}${k.tags.length ? ' · ' + k.tags.join('/') : ''}`,
                ),
                k.snippet ? h('div', { className: 'dshr-item-snippet' }, k.snippet) : null,
              ),
            ),
            kbList.length === 0 ? h('div', { className: 'dshr-hint' }, '知识库还没有条目：阅读时点 📥 入库，或点左栏 📨 归档今日日报') : null,
          )
        : h(
            'div',
            { className: 'dshr-col dshr-items' },
            items.map((it) =>
              h(
                'div',
                {
                  key: it.id,
                  className: `dshr-item${it.read ? '' : ' unread'}${selected === it.id ? ' active' : ''}`,
                  onClick: () => openItem(it.id),
                },
                h('div', { className: 'dshr-item-title' }, it.starred ? `★ ${it.title}` : it.title),
                h(
                  'div',
                  { className: 'dshr-item-meta' },
                  `${it.feedTitle} · ${relTime(it.publishedAt)}`,
                ),
                it.snippet ? h('div', { className: 'dshr-item-snippet' }, it.snippet) : null,
              ),
            ),
            items.length === 0 ? h('div', { className: 'dshr-hint' }, starredOnly ? '没有星标文章' : unreadOnly ? '没有未读文章' : '暂无文章') : null,
          );

      // ----- 右栏：阅读面板 / 知识库详情
      const readerCol = kbView
        ? h(
            'div',
            { className: 'dshr-col dshr-reader' },
            kbDetail
              ? h(
                  'article',
                  { className: 'dshr-article' },
                  h('h1', { className: 'dshr-article-title' }, kbDetail.title),
                  h(
                    'div',
                    { className: 'dshr-article-meta' },
                    `${kbDetail.kind === 'digest' ? '📰 日报' : kbDetail.kind === 'manual' ? '📝 手动' : '📄 文章'}${kbDetail.sourceFeedTitle ? ` · ${kbDetail.sourceFeedTitle}` : ''} · ${relTime(kbDetail.createdAt)} · `,
                    kbDetail.link
                      ? h('a', { href: kbDetail.link, target: '_blank', rel: 'noopener noreferrer' }, '打开原文 ↗')
                      : null,
                    ' · ',
                    h(
                      'button',
                      { className: 'dshr-feed-del', style: { visibility: 'visible', fontSize: '12px' }, onClick: () => removeKbEntry(kbDetail.id) },
                      '删除',
                    ),
                  ),
                  h(
                    'div',
                    { className: 'dshr-kb-note' },
                    h('div', { className: 'dshr-kb-note-label' }, '✍️ 我的笔记'),
                    h('textarea', {
                      className: 'dshr-kb-note-input',
                      placeholder: '写点想法、摘录、总结…',
                      value: kbNote,
                      onChange: (e) => setKbNote(e.target.value),
                    }),
                    h('button', { className: 'dshr-btn dshr-btn-primary', onClick: saveKbNote }, '保存笔记'),
                  ),
                  h('div', {
                    className: 'dshr-content dshr-kb-md',
                    dangerouslySetInnerHTML: { __html: kbRender(kbDetail.contentText) },
                  }),
                )
              : h('div', { className: 'dshr-empty' }, '选择一条知识库条目查看'),
          )
        : h(
            'div',
            { className: 'dshr-col dshr-reader' },
            detail
              ? h(
                  'article',
                  { className: 'dshr-article' },
                  h('h1', { className: 'dshr-article-title' }, detail.title),
                  h(
                    'div',
                    { className: 'dshr-article-meta' },
                    `${detail.feedTitle}${detail.author ? ` · ${detail.author}` : ''} · ${relTime(detail.publishedAt)} · `,
                    h('a', { href: detail.link, target: '_blank', rel: 'noopener noreferrer' }, '打开原文 ↗'),
                    ' · ',
                    h(
                      'button',
                      {
                        className: `dshr-star${detail.starred ? ' starred' : ''}`,
                        onClick: toggleStar,
                        title: detail.starred ? '取消星标' : '加星标',
                      },
                      detail.starred ? '★ 已星标' : '☆ 星标',
                    ),
                    ' · ',
                    h(
                      'button',
                      { className: 'dshr-star', onClick: saveArticleToKb, title: '把全文快照存入知识库' },
                      '📥 入库',
                    ),
                  ),
                  detail.contentHtml
                    ? h('div', {
                        className: 'dshr-content',
                        dangerouslySetInnerHTML: { __html: detail.contentHtml },
                      })
                    : h(
                        'div',
                        { className: 'dshr-hint' },
                        '该源未提供全文，请 ',
                        h('a', { href: detail.link, target: '_blank', rel: 'noopener noreferrer' }, '打开原文阅读'),
                      ),
                  relatedKb.length > 0
                    ? h(
                        'div',
                        { className: 'dshr-related' },
                        h('div', { className: 'dshr-related-label' }, '🔗 知识库相关'),
                        relatedKb.map((k) =>
                          h(
                            'div',
                            {
                              key: k.id,
                              className: 'dshr-related-item',
                              onClick: () => {
                                setKbView(true);
                                loadKb(kbQuery.trim()); // 跳转时同步加载列表，避免中栏空提示
                                openKbEntry(k.id);
                              },
                            },
                            h('div', { className: 'dshr-related-title' }, `${k.kind === 'digest' ? '📰 ' : k.kind === 'manual' ? '📝 ' : '📄 '}${k.title}`),
                            k.snippet ? h('div', { className: 'dshr-item-snippet' }, k.snippet) : null,
                          ),
                        ),
                      )
                    : null,
                )
              : h('div', { className: 'dshr-empty' }, '选择一篇文章开始阅读'),
          );

      // 组件内联样式：随组件卸载清理，不依赖 styles 内建
      return h('div', { className: 'dshr-root' }, h('style', null, CSS), feedCol, itemCol, readerCol);
    }

    // ---------------------------------------------------------------- 样式

    const CSS = `
.dshr-root { display: flex; height: 100%; min-height: 0; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font-size: 14px; }
.dshr-col { min-height: 0; overflow-y: auto; }
.dshr-feeds { width: 240px; flex: none; border-right: 1px solid var(--dsw-alias-border-l1); display: flex; flex-direction: column; }
.dshr-items { width: 340px; flex: none; border-right: 1px solid var(--dsw-alias-border-l1); }
.dshr-reader { flex: 1; min-width: 0; }
.dshr-head { display: flex; align-items: center; gap: 8px; padding: 12px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.dshr-title { font-weight: 600; flex: 1; }
.dshr-unread-toggle { display: flex; align-items: center; gap: 4px; color: var(--dsw-alias-label-secondary); font-size: 12px; cursor: pointer; }
.dshr-btn { border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); border-radius: 6px; padding: 3px 10px; font-size: 12px; cursor: pointer; }
.dshr-btn:disabled { opacity: 0.5; cursor: default; }
.dshr-btn-primary { background: var(--dsw-alias-brand-primary); border-color: transparent; color: var(--dsw-alias-bg-base); font-weight: 600; }
.dshr-add { display: flex; gap: 6px; padding: 10px 12px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.dshr-input { flex: 1; min-width: 0; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); border-radius: 6px; padding: 5px 8px; font-size: 12px; outline: none; }
.dshr-notice { padding: 6px 12px; font-size: 12px; color: var(--dsw-alias-label-secondary); border-bottom: 1px solid var(--dsw-alias-border-l1); word-break: break-all; }
.dshr-feed-list { flex: 1; overflow-y: auto; padding: 6px; }
.dshr-feed { display: flex; align-items: center; gap: 6px; padding: 7px 8px; border-radius: 6px; cursor: pointer; }
.dshr-feed:hover { background: var(--dsw-alias-bg-layer-1); }
.dshr-feed.active { background: var(--dsw-alias-bg-layer-2); }
.dshr-feed-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshr-badge { flex: none; min-width: 18px; text-align: center; font-size: 11px; border-radius: 9px; padding: 0 5px; background: var(--dsw-alias-brand-primary); color: var(--dsw-alias-bg-base); font-weight: 600; }
.dshr-filter-mark { flex: none; font-size: 11px; color: var(--dsw-alias-state-warn-primary); }
.dshr-star { border: none; background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer; font-size: 12px; padding: 0 2px; }
.dshr-star:hover, .dshr-star.starred { color: var(--dsw-alias-state-warn-primary); }
.dshr-kb-search { display: flex; gap: 6px; padding: 10px 14px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.dshr-kb-note { margin: 0 0 20px; padding: 12px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; background: var(--dsw-alias-bg-layer-1); }
.dshr-kb-note-label { font-size: 12px; color: var(--dsw-alias-label-secondary); margin-bottom: 8px; }
.dshr-kb-note-input { width: 100%; min-height: 72px; box-sizing: border-box; resize: vertical; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); border-radius: 6px; padding: 8px; font-size: 13px; line-height: 1.6; margin-bottom: 8px; outline: none; font-family: inherit; }
.dshr-related { margin-top: 28px; padding: 14px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; }
.dshr-related-label { font-size: 12px; color: var(--dsw-alias-label-secondary); margin-bottom: 8px; }
.dshr-related-item { padding: 6px 4px; border-radius: 6px; cursor: pointer; }
.dshr-related-item:hover { background: var(--dsw-alias-bg-layer-1); }
.dshr-related-title { font-size: 13px; line-height: 1.5; }
.dshr-kb-md h3 { font-size: 18px; margin: 18px 0 10px; }
.dshr-kb-md h4 { font-size: 15px; margin: 16px 0 8px; color: var(--dsw-alias-brand-primary); }
.dshr-kb-md h5 { font-size: 13px; margin: 12px 0 6px; }
.dshr-kb-md ul { margin: 4px 0 10px; padding-left: 18px; }
.dshr-kb-md li { margin: 3px 0; line-height: 1.7; }
.dshr-kb-md p { margin: 6px 0; line-height: 1.7; }
.dshr-kb-md a { color: var(--dsw-alias-brand-primary); text-decoration: none; word-break: break-all; }
.dshr-kb-md a:hover { text-decoration: underline; }
.dshr-kb-sp { height: 6px; }
.dshr-feed-del { flex: none; border: none; background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer; font-size: 14px; padding: 0 2px; visibility: hidden; }
.dshr-feed:hover .dshr-feed-del { visibility: visible; }
.dshr-hint { padding: 16px 12px; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 1.7; }
.dshr-item { padding: 10px 14px; border-bottom: 1px solid var(--dsw-alias-border-l1); cursor: pointer; }
.dshr-item:hover { background: var(--dsw-alias-bg-layer-1); }
.dshr-item.active { background: var(--dsw-alias-bg-layer-2); }
.dshr-item.unread .dshr-item-title { font-weight: 600; }
.dshr-item.unread .dshr-item-title::before { content: '● '; color: var(--dsw-alias-brand-primary); font-size: 10px; }
.dshr-item-title { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; line-height: 1.5; }
.dshr-item-meta { margin-top: 4px; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.dshr-item-snippet { margin-top: 4px; font-size: 12px; color: var(--dsw-alias-label-secondary); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; line-height: 1.6; }
.dshr-empty { padding: 48px 16px; text-align: center; color: var(--dsw-alias-label-secondary); }
.dshr-article { max-width: 760px; margin: 0 auto; padding: 28px 32px 80px; }
.dshr-article-title { font-size: 22px; line-height: 1.4; margin: 0 0 10px; }
.dshr-article-meta { font-size: 12px; color: var(--dsw-alias-label-secondary); padding-bottom: 16px; border-bottom: 1px solid var(--dsw-alias-border-l1); margin-bottom: 20px; }
.dshr-article-meta a { color: var(--dsw-alias-brand-primary); text-decoration: none; }
.dshr-content { font-size: 15px; line-height: 1.85; word-break: break-word; }
.dshr-content img, .dshr-content video { max-width: 100%; height: auto; }
.dshr-content pre { overflow-x: auto; padding: 12px; border-radius: 8px; background: var(--dsw-alias-bg-layer-1); font-size: 13px; }
.dshr-content code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.dshr-content blockquote { margin: 0; padding: 2px 14px; border-left: 3px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-label-secondary); }
.dshr-content a { color: var(--dsw-alias-brand-primary); }
.dshr-content table { border-collapse: collapse; }
.dshr-content td, .dshr-content th { border: 1px solid var(--dsw-alias-border-l1); padding: 6px 10px; }
/* 深色/浅色通吃：公众号等文章的内联样式写死颜色（黑字/白底），全部中和为主题色。
   !important 作者样式表优先级高于无 !important 的内联样式 */
.dshr-content * { color: inherit !important; background-color: transparent !important; background-image: none !important; }
.dshr-content a { color: var(--dsw-alias-brand-primary) !important; }
.dshr-content pre { background-color: var(--dsw-alias-bg-layer-1) !important; }
.dshr-content pre, .dshr-content code { color: var(--dsw-alias-label-primary) !important; }
.dshr-content blockquote { color: var(--dsw-alias-label-secondary) !important; }
`;

    // ---------------------------------------------------------------- 注册

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register({ name: 'sidebar.panellist', id: 'reading', order: 10, label: '阅读' }, PanelIcon),
        );
        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'reading' }, ReaderApp));
      },
    };
  },
});
