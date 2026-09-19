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
      const [selected, setSelected] = React.useState(null);
      const [detail, setDetail] = React.useState(null);
      const [addUrl, setAddUrl] = React.useState('');
      const [adding, setAdding] = React.useState(false);
      const [notice, setNotice] = React.useState('');
      const [refreshing, setRefreshing] = React.useState(false);

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
          setItems(await api(`items?${params}`));
        } catch (e) {
          setNotice(`加载文章失败：${e.message || e}`);
        }
      }, [feedId, unreadOnly]);

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

      async function openItem(id) {
        setSelected(id);
        setDetail(null);
        try {
          const r = await api(`item?id=${encodeURIComponent(id)}`);
          if (r && r.ok) setDetail(r.item);
          else setNotice((r && r.error) || '文章加载失败');
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
        ),
        notice ? h('div', { className: 'dshr-notice' }, notice) : null,
        h(
          'div',
          { className: 'dshr-feed-list' },
          h(
            'div',
            {
              className: `dshr-feed${feedId === 'all' ? ' active' : ''}`,
              onClick: () => setFeedId('all'),
            },
            h('span', { className: 'dshr-feed-title' }, '全部'),
            totalUnread > 0 ? h('span', { className: 'dshr-badge' }, String(totalUnread)) : null,
          ),
          feeds.map((f) =>
            h(
              'div',
              {
                key: f.id,
                className: `dshr-feed${feedId === f.id ? ' active' : ''}`,
                onClick: () => setFeedId(f.id),
                title: f.lastError ? `抓取失败：${f.lastError}` : f.url,
              },
              h('span', { className: 'dshr-feed-title' }, f.lastError ? `⚠ ${f.title}` : f.title),
              f.unread > 0 ? h('span', { className: 'dshr-badge' }, String(f.unread)) : null,
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

      // ----- 中栏：文章列表
      const itemCol = h(
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
            h('div', { className: 'dshr-item-title' }, it.title),
            h(
              'div',
              { className: 'dshr-item-meta' },
              `${it.feedTitle} · ${relTime(it.publishedAt)}`,
            ),
            it.snippet ? h('div', { className: 'dshr-item-snippet' }, it.snippet) : null,
          ),
        ),
        items.length === 0 ? h('div', { className: 'dshr-hint' }, unreadOnly ? '没有未读文章' : '暂无文章') : null,
      );

      // ----- 右栏：阅读面板
      const readerCol = h(
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
