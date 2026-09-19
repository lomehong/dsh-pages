// dsh-pages 阅读器 · Client 半层
// 落点：sidebar.panellist 注册图标（id reading）→ main 面板注册三栏阅读器（key reading）
// 数据通道：同源 fetch /reader-api/*（参照 im-channel 等已装插件的成熟模式）
//
// 信息架构（P6 重构）：两个空间，一个舞台。
//   - 「阅读」= 收件流（时间性、未读驱动）：订阅源导航 + 文章列表
//   - 「知识库」= 藏书馆（永久性、检索驱动）：类型/标签导航 + 条目列表
//   - 右栏是两空间共享的持久阅读舞台：文章与知识库条目用同一阅读表面渲染；
//     文章 → 相关笔记 为推栈导航（面包屑返回），阅读上下文不丢失
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

    function escapeHtml(s) {
      return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    // 知识库受限 markdown 渲染：contentText 是纯文本，但可能携带来自 feed 标题/正文的
    // 尖括号——绝不能原文进 innerHTML。先整体 HTML 转义，再恢复 #/##/### 标题、- 列表
    // 与链接结构。链接化在【转义后的文本】上匹配 &lt;url&gt; 与裸 URL；href 值先把
    // &amp; 解码回 &（否则查询参数被截断），再转义进属性。
    function kbRender(text) {
      const anchor = (escapedUrl) => {
        const u = escapedUrl.replace(/&amp;/g, '&');
        const bare = u.replace(/^https?:\/\//, '').replace(/\/$/, '');
        const shown = bare.length > 46 ? `${bare.slice(0, 46)}…` : bare;
        return `<a href="${escapeHtml(u)}" target="_blank" rel="noopener noreferrer">${escapeHtml(shown)}</a>`;
      };
      const URL_BODY = '(?:https?:\\/\\/)[^\\s]+?';
      const escaped = escapeHtml(text);
      const out = [];
      let inList = false;
      const closeList = () => {
        if (inList) {
          out.push('</ul>');
          inList = false;
        }
      };
      for (const raw of escaped.split(/\r?\n/)) {
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
      // 链接化：&lt;https://…&gt;（日报格式）与裸链接；终止于空白/右括号/已转义尖括号
      html = html.replace(new RegExp(`&lt;(${URL_BODY})&gt;`, 'g'), (m, u) => anchor(u));
      html = html.replace(new RegExp(`(^|[\\s(])(${URL_BODY})(?=$|[\\s）。)]|&(?:gt|lt);)`, 'g'), (m, pre, u) => pre + anchor(u));
      return html;
    }

    // ---------------------------------------------------------------- 文章 HTML 权威消毒
    // 用浏览器自己的 HTML 解析器（DOMParser）按白名单重建 DOM——比正则滤除更难绕过，
    // 实体编码/大小写/斜杠分隔等解析器差异全部由浏览器语义兜底。服务端正则快滤
    // （index.js sanitizeHtml）是第一道，这里是 innerHTML 渲染前的最后一道。
    const SANITIZE_KEEP_TAGS = new Set([
      'a', 'abbr', 'article', 'aside', 'b', 'bdi', 'bdo', 'blockquote', 'br', 'caption', 'cite', 'code', 'dd', 'del',
      'details', 'dfn', 'div', 'dl', 'dt', 'em', 'figcaption', 'figure', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      'header', 'hr', 'i', 'img', 'ins', 'kbd', 'li', 'main', 'mark', 'nav', 'ol', 'p', 'picture', 'pre', 'q', 'rp',
      'rt', 'ruby', 's', 'samp', 'section', 'small', 'source', 'span', 'strike', 'strong', 'sub', 'summary', 'sup',
      'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'time', 'tr', 'track', 'u', 'ul', 'var', 'video', 'wbr',
    ]);
    // 命中即连同内容删除（unwrap 会留下残余文本的交互控件也直接删）
    const SANITIZE_DROP_TAGS = new Set([
      'script', 'style', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'template', 'noscript', 'svg',
      'math', 'form', 'input', 'button', 'select', 'textarea', 'link', 'meta', 'base', 'title', 'head', 'dialog', 'canvas',
    ]);
    const SANITIZE_KEEP_ATTRS = new Set([
      'href', 'src', 'alt', 'title', 'width', 'height', 'colspan', 'rowspan', 'span', 'align', 'border',
      'cellpadding', 'cellspacing', 'datetime', 'start', 'reversed', 'controls', 'loop', 'muted', 'preload', 'dir', 'lang',
    ]);
    const SANITIZE_URL_ATTRS = new Set(['href', 'src']);

    // 白名单协议：http/https/mailto/相对地址；allowDataImage 仅用于 src（img 上下文脚本惰性）
    function sanitizeUrl(value, allowDataImage) {
      const cleaned = String(value ?? '').replace(/[\x00-\x20]+/g, '');
      if (!cleaned) return null;
      const m = /^([a-z][a-z0-9+.-]*):/i.exec(cleaned);
      if (!m) return value;
      const p = m[1].toLowerCase();
      if (p === 'http' || p === 'https' || p === 'mailto') return value;
      if (allowDataImage && p === 'data' && /^data:image\//i.test(cleaned)) return value;
      return null;
    }

    function sanitizeArticleHtml(html) {
      let doc;
      try {
        doc = new DOMParser().parseFromString(String(html ?? ''), 'text/html');
      } catch {
        return '';
      }
      const visit = (el) => {
        const tag = el.tagName.toLowerCase();
        if (SANITIZE_DROP_TAGS.has(tag)) {
          el.remove();
          return;
        }
        if (!SANITIZE_KEEP_TAGS.has(tag)) {
          // 未知标签：剥壳留内容（unwrap），被移动的子元素继续逐个检查
          const parent = el.parentNode;
          const kids = Array.from(el.childNodes);
          for (const k of kids) parent.insertBefore(k, el);
          el.remove();
          for (const k of kids) if (k.nodeType === 1) visit(k);
          return;
        }
        // 懒加载兜底：无 src 的 img 从 data-src 补（服务端快滤通常已迁移）
        if (tag === 'img' && !el.hasAttribute('src') && el.hasAttribute('data-src')) {
          const u = sanitizeUrl(el.getAttribute('data-src'), true);
          if (u) el.setAttribute('src', u);
        }
        for (const attr of Array.from(el.attributes)) {
          const name = attr.name.toLowerCase();
          if (!SANITIZE_KEEP_ATTRS.has(name)) {
            el.removeAttribute(attr.name);
            continue;
          }
          if (SANITIZE_URL_ATTRS.has(name) && sanitizeUrl(attr.value, name === 'src') === null) {
            el.removeAttribute(attr.name);
            continue;
          }
        }
        // 外链新窗打开 + 反向 tabnabbing 防护
        if (tag === 'a' && /^https?:/i.test((el.getAttribute('href') ?? '').trim())) {
          el.setAttribute('target', '_blank');
          el.setAttribute('rel', 'noopener noreferrer');
        }
        for (const child of Array.from(el.children)) visit(child);
      };
      const body = doc.body;
      for (const el of Array.from(body.children)) visit(el);
      return body.innerHTML.replace(/<!--[\s\S]*?-->/g, '');
    }

    // ---------------------------------------------------------------- 图标
    // 内联 SVG（Feather 风格 stroke 路径），与宿主侧栏 RSS 图标同一视觉语言；不用 emoji。

    const ICONS = {
      tray: 'M22 12h-6l-2 3h-4l-2-3H2|M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z',
      book: 'M4 19.5A2.5 2.5 0 0 1 6.5 17H20|M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z',
      plus: 'M12 5v14|M5 12h14',
      refresh: 'M23 4v6h-6|M20.49 15a9 9 0 1 1-2.12-9.36L23 10',
      archive: 'M21 8v13H3V8|M1 3h22v5H1z|M10 12h4',
      star: 'M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z',
      save: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4|M7 10l5 5 5-5|M12 15V3',
      file: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z|M14 2v6h6|M16 13H8|M16 17H8|M10 9H8',
      news: 'M8 6h13|M8 12h13|M8 18h13|M3 6h.01|M3 12h.01|M3 18h.01',
      pen: 'M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7|M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4z',
      chevronLeft: 'M15 18l-6-6 6-6',
      sliders: 'M4 21v-7|M4 10V3|M12 21v-9|M12 8V3|M20 21v-5|M20 12V3|M1 14h6|M9 8h6|M17 16h6',
      x: 'M18 6L6 18|M6 6l12 12',
      warn: 'M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z|M12 9v4|M12 17h.01',
      external: 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6|M15 3h6v6|M10 14L21 3',
    };

    function Icon(props) {
      const size = props.size || 16;
      const paths = String(props.d || '').split('|').map((d, i) => h('path', { key: i, d }));
      const filled = !!props.fill;
      return h(
        'svg',
        {
          viewBox: '0 0 24 24',
          width: size,
          height: size,
          'aria-hidden': true,
          fill: filled ? 'currentColor' : 'none',
          stroke: filled ? 'none' : 'currentColor',
          strokeWidth: 1.8,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          className: props.className,
          style: { display: 'block', flex: 'none', ...(props.style || {}) },
        },
        ...paths,
      );
    }

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

    // ---------------------------------------------------------------- 本地 UI 状态

    function storeGet(key, fallback) {
      try {
        return window.localStorage.getItem(`dshr.${key}`) ?? fallback;
      } catch {
        return fallback;
      }
    }
    function storeSet(key, value) {
      try {
        window.localStorage.setItem(`dshr.${key}`, value);
      } catch {}
    }

    const KB_KINDS = [
      { key: 'article', label: '文章快照', icon: 'file' },
      { key: 'digest', label: '日报', icon: 'news' },
      { key: 'manual', label: '笔记', icon: 'pen' },
    ];
    const kindLabel = (k) => (k === 'digest' ? '日报' : k === 'manual' ? '笔记' : '文章快照');
    const kindIcon = (k) => (k === 'digest' ? ICONS.news : k === 'manual' ? ICONS.pen : ICONS.file);

    // ---------------------------------------------------------------- 阅读器主面板

    function ReaderApp() {
      // ---- 空间与视图（localStorage 持久化，重开面板回到离开时的位置）
      const [space, setSpaceState] = React.useState(() => (storeGet('space', 'read') === 'kb' ? 'kb' : 'read'));
      const [view, setViewState] = React.useState(() => {
        const v = storeGet('view', 'all');
        return ['unread', 'all', 'starred'].includes(v) ? v : 'all';
      });
      const setSpace = (s) => {
        setSpaceState(s);
        storeSet('space', s);
      };
      const setView = (v) => {
        setViewState(v);
        storeSet('view', v);
      };

      // ---- 阅读空间
      const [feeds, setFeeds] = React.useState([]);
      const [items, setItems] = React.useState(null);
      const [itemsLoaded, setItemsLoaded] = React.useState(false);
      const [feedId, setFeedId] = React.useState('all');
      const [addOpen, setAddOpen] = React.useState(false);
      const [addUrl, setAddUrl] = React.useState('');
      const [adding, setAdding] = React.useState(false);
      const [importing, setImporting] = React.useState(false);
      const [refreshing, setRefreshing] = React.useState(false);
      const fileInputRef = React.useRef(null);
      const [filterEdit, setFilterEdit] = React.useState(null); // { id, include, exclude } | null

      // ---- 知识库空间
      const [kbAll, setKbAll] = React.useState([]); // 全量条目：类型/标签计数聚合
      const [kbList, setKbList] = React.useState([]); // 当前过滤结果
      const [kbLoaded, setKbLoaded] = React.useState(false);
      const [kbQuery, setKbQuery] = React.useState('');
      const [kbKind, setKbKind] = React.useState('all');
      const [kbTag, setKbTag] = React.useState(null);
      const [kbNote, setKbNote] = React.useState('');

      // ---- 共享阅读舞台（推栈：文章 ↔ 相关条目往返不丢上下文）
      const [stage, setStage] = React.useState([]); // [{ kind: 'article'|'kb', id }]
      const [articleDetail, setArticleDetail] = React.useState(null);
      const [kbDetail, setKbDetail] = React.useState(null);
      const [relatedKb, setRelatedKb] = React.useState([]);
      const detailCache = React.useRef(new Map()); // articleId -> 消毒后的 detail

      // ---- 轻提示（toast）
      const [notice, setNoticeState] = React.useState(null); // { text, kind: 'ok'|'err' }
      const noticeTimer = React.useRef(null);
      const setNotice = (text, kind = 'ok') => {
        setNoticeState({ text, kind });
        clearTimeout(noticeTimer.current);
        noticeTimer.current = setTimeout(() => setNoticeState(null), kind === 'err' ? 8000 : 3500);
      };
      React.useEffect(() => () => clearTimeout(noticeTimer.current), []);

      // ---------------- 数据加载 ----------------

      const loadFeeds = React.useCallback(async () => {
        try {
          setFeeds(await api('feeds'));
        } catch (e) {
          setNotice(`加载订阅失败：${e.message || e}`, 'err');
        }
      }, []);

      const loadItems = React.useCallback(async () => {
        try {
          const params = new URLSearchParams();
          if (feedId !== 'all') params.set('feedId', feedId);
          if (view === 'unread') params.set('unreadOnly', '1');
          if (view === 'starred') params.set('starredOnly', '1');
          setItems(await api(`items?${params}`));
          setItemsLoaded(true);
        } catch (e) {
          setNotice(`加载文章失败：${e.message || e}`, 'err');
        }
      }, [feedId, view]);

      const loadKbAll = React.useCallback(async () => {
        try {
          setKbAll(await api('kb/list'));
        } catch {}
      }, []);

      const loadKb = React.useCallback(async () => {
        try {
          const params = new URLSearchParams();
          if (kbQuery.trim()) params.set('query', kbQuery.trim());
          if (kbKind !== 'all') params.set('kind', kbKind);
          if (kbTag) params.set('tag', kbTag);
          setKbList(await api(`kb/list?${params}`));
          setKbLoaded(true);
        } catch (e) {
          setNotice(`知识库加载失败：${e.message || e}`, 'err');
        }
      }, [kbQuery, kbKind, kbTag]);

      const refreshKb = React.useCallback(() => {
        loadKbAll();
        loadKb();
      }, [loadKbAll, loadKb]);

      // 未读视图为空时，旁路查询全部篇数，给空态一个"去处"而不是死胡同
      const [allCount, setAllCount] = React.useState(null);
      React.useEffect(() => {
        if (space === 'read' && view === 'unread' && itemsLoaded && Array.isArray(items) && items.length === 0) {
          api('items')
            .then((all) => setAllCount(Array.isArray(all) ? all.length : 0))
            .catch(() => {});
        }
      }, [space, view, itemsLoaded, items]);

      // 仅挂载一次：首屏加载 + 后台刷新一轮 + 定时轻量重载
      React.useEffect(() => {
        let stop = false;
        (async () => {
          await loadFeeds();
          await loadItems();
          api('feeds/refresh', {})
            .then(async () => {
              if (stop) return;
              await loadFeeds();
              await loadItems();
            })
            .catch(() => {});
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

      // 切换订阅/视图时重载文章列表；进入知识库或切换类型/标签时重载知识库
      React.useEffect(() => {
        loadItems();
      }, [loadItems]);
      React.useEffect(() => {
        if (space === 'kb') {
          loadKbAll();
          loadKb();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [space, kbKind, kbTag]);

      // ---------------- 阅读空间操作 ----------------

      async function addFeed() {
        const url = addUrl.trim();
        if (!url) return;
        setAdding(true);
        try {
          const r = await api('feeds/add', { url });
          if (r && r.ok) {
            setAddUrl('');
            setNotice(`已添加「${r.title}」，收录 ${r.added} 篇`);
            await loadFeeds();
            await loadItems();
          } else {
            setNotice(`添加失败：${(r && r.error) || '未知错误'}`, 'err');
          }
        } catch (e) {
          setNotice(`添加失败：${e.message || e}`, 'err');
        } finally {
          setAdding(false);
        }
      }

      async function removeFeed(id, title) {
        // 删除订阅属破坏性操作：保留 window.confirm（阻塞确认是这个 UI 目前唯一的确认原语）
        if (!window.confirm(`删除订阅「${title}」及其全部文章？`)) return;
        setFilterEdit((cur) => (cur && cur.id === id ? null : cur));
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
          setNotice(`刷新失败：${e.message || e}`, 'err');
        } finally {
          setRefreshing(false);
        }
      }

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
            setNotice(`导入失败：${(r && r.error) || '未知错误'}`, 'err');
          }
        } catch (err) {
          setNotice(`导入失败：${err.message || err}`, 'err');
        } finally {
          setImporting(false);
        }
      }

      function openFilterEditor(f) {
        setFilterEdit({ id: f.id, include: f.include || '', exclude: f.exclude || '' });
      }

      async function saveFilterEditor() {
        if (!filterEdit) return;
        try {
          await api('feeds/filter', {
            id: filterEdit.id,
            include: filterEdit.include.trim(),
            exclude: filterEdit.exclude.trim(),
          });
          setNotice('过滤已更新');
        } catch (err) {
          setNotice(`设置失败：${err.message || err}`, 'err');
        }
        setFilterEdit(null);
        await loadFeeds();
        await loadItems();
      }

      // ---------------- 阅读舞台（推栈导航） ----------------

      async function showArticle(id, push = false) {
        setStage((cur) => {
          const top = cur[cur.length - 1];
          if (top && top.kind === 'article' && top.id === id) return cur;
          return push ? [...cur, { kind: 'article', id }] : [{ kind: 'article', id }];
        });
        let d = detailCache.current.get(id);
        if (!d) {
          try {
            const r = await api(`item?id=${encodeURIComponent(id)}`);
            if (r && r.ok) {
              // 渲染前权威消毒：服务端快滤后的 HTML 在这里用 DOMParser 白名单重建
              d = { ...r.item, contentHtml: sanitizeArticleHtml(r.item.contentHtml) };
              if (detailCache.current.size > 40) detailCache.current.clear();
              detailCache.current.set(id, d);
            } else {
              setNotice(r?.error || '文章加载失败', 'err');
              setStage((cur) => cur.slice(0, -1)); // 加载失败：回退栈帧，避免空帧卡住舞台
              return;
            }
          } catch (e) {
            setNotice(`文章加载失败：${e.message || e}`, 'err');
            setStage((cur) => cur.slice(0, -1));
            return;
          }
        }
        setArticleDetail(d);
        setRelatedKb([]);
        api(`kb/related?articleId=${encodeURIComponent(id)}`)
          .then((list) => setRelatedKb(Array.isArray(list) ? list : []))
          .catch(() => {});
        // 标记已读：服务端幂等；未读计数只在列表里确实是未读时递减一次
        api('items/markRead', { id, read: true }).catch(() => {});
        const hit = Array.isArray(items) ? items.find((x) => x.id === id) : null;
        if (hit && !hit.read) {
          setItems((cur) => (Array.isArray(cur) ? cur.map((it) => (it.id === id ? { ...it, read: true } : it)) : cur));
          setFeeds((cur) => cur.map((f) => (f.id === hit.feedId && f.unread > 0 ? { ...f, unread: f.unread - 1 } : f)));
        }
      }

      async function openKb(id, push = false) {
        setStage((cur) => {
          const top = cur[cur.length - 1];
          if (top && top.kind === 'kb' && top.id === id) return cur;
          return push ? [...cur, { kind: 'kb', id }] : [{ kind: 'kb', id }];
        });
        try {
          const r = await api(`kb/entry?id=${encodeURIComponent(id)}`);
          if (r && r.ok) {
            setKbDetail(r.entry);
            setKbNote(r.entry.note || '');
          } else {
            setNotice(r?.error || '条目加载失败', 'err');
            setStage((cur) => cur.slice(0, -1));
          }
        } catch (e) {
          setNotice(`条目加载失败：${e.message || e}`, 'err');
          setStage((cur) => cur.slice(0, -1));
        }
      }

      function popStage() {
        setStage((cur) => cur.slice(0, -1));
      }

      async function toggleStar() {
        const d = articleDetail;
        if (!d) return;
        const next = !d.starred;
        api('items/star', { id: d.id, starred: next }).catch(() => {});
        const updated = { ...d, starred: next };
        setArticleDetail(updated);
        detailCache.current.set(d.id, updated);
        setItems((cur) => (Array.isArray(cur) ? cur.map((it) => (it.id === d.id ? { ...it, starred: next } : it)) : cur));
      }

      // ---------------- 知识库操作 ----------------

      async function saveKbNote() {
        if (!kbDetail) return;
        try {
          await api('kb/note', { id: kbDetail.id, note: kbNote });
          const patch = (d) => (d && d.id === kbDetail.id ? { ...d, note: kbNote } : d);
          setKbDetail(patch);
          setKbList((cur) => cur.map(patch));
          setKbAll((cur) => cur.map(patch));
          setNotice('笔记已保存');
        } catch (e) {
          setNotice(`保存失败：${e.message || e}`, 'err');
        }
      }

      async function removeKbEntry(id) {
        if (!window.confirm('删除这条知识库条目？')) return;
        try {
          await api('kb/remove', { id });
        } catch {}
        setStage((cur) => cur.filter((f) => !(f.kind === 'kb' && f.id === id)));
        setKbDetail((d) => (d && d.id === id ? null : d));
        refreshKb();
      }

      async function saveArticleToKb() {
        const d = articleDetail;
        if (!d) return;
        try {
          const r = await api('kb/from-article', { articleId: d.id, tags: [d.feedTitle].filter(Boolean) });
          if (r && r.ok) {
            setNotice(`已入库「${r.title}」`);
            refreshKb();
          } else {
            setNotice(`入库失败：${(r && r.error) || '未知错误'}`, 'err');
          }
        } catch (e) {
          setNotice(`入库失败：${e.message || e}`, 'err');
        }
      }

      async function archiveDigest() {
        try {
          const r = await api('kb/save-digest', { hours: 24, unreadOnly: false });
          if (r && r.ok) {
            setNotice(`今日日报已归档（${r.itemCount} 篇 / ${r.feedCount} 源）`);
            refreshKb();
          } else {
            setNotice(`归档失败：${(r && r.error) || '未知错误'}`, 'err');
          }
        } catch (e) {
          setNotice(`归档失败：${e.message || e}`, 'err');
        }
      }

      // ---------------- 派生数据 ----------------

      const totalUnread = feeds.reduce((n, f) => n + (f.unread || 0), 0);

      const tagCounts = new Map();
      for (const k of kbAll) for (const t of k.tags || []) tagCounts.set(t, (tagCounts.get(t) || 0) + 1);
      const tags = [...tagCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
      const kindCount = (key) => kbAll.filter((k) => k.kind === key).length;

      const stageTop = stage[stage.length - 1] ?? null;
      const stagePrev = stage.length > 1 ? stage[stage.length - 2] : null;
      const activeArticleId = [...stage].reverse().find((f) => f.kind === 'article')?.id ?? null;

      const monogram = (title) => {
        // 跳过前导数字取首字：'36氪' → '氪'——头像显示 '3' 会被误读成未读数
        const s = String(title || '？').trim();
        let i = 0;
        while (i < s.length && /[0-9]/.test(s[i])) i++;
        return (s.charAt(i) || s.charAt(0) || '？').toUpperCase();
      };

      // ---------------- 渲染：侧栏 ----------------

      function navRow({ key, icon, avatar, warn, title, hash, count, badge, active, onClick, mark, rowTitle, acts }) {
        return h(
          'div',
          { key, className: `dshr-navrow${active ? ' active' : ''}`, onClick, title: rowTitle },
          avatar ? h('span', { className: 'dshr-avatar' }, monogram(title)) : null,
          icon ? h(Icon, { d: icon, size: 14, className: 'dshr-navrow-icon' }) : null,
          warn ? h(Icon, { d: ICONS.warn, size: 13, className: 'dshr-navrow-warn' }) : null,
          hash ? h('span', { className: 'dshr-taghash' }, '#') : null,
          h('span', { className: 'dshr-navrow-title' }, title),
          mark ?? null,
          badge != null && badge > 0 ? h('span', { className: 'dshr-badge' }, String(badge)) : null,
          count != null ? h('span', { className: 'dshr-count' }, String(count)) : null,
          acts ?? null,
        );
      }

      const readSide = h(
        'div',
        { key: 'read-side', className: 'dshr-spacefade' },
        h(
          'div',
          { className: 'dshr-side-actions' },
          h(
            'button',
            {
              className: `dshr-btn dshr-side-add${addOpen ? ' dshr-btn-primary' : ''}`,
              onClick: () => setAddOpen((o) => !o),
              title: addOpen ? '收起订阅输入' : '添加订阅源',
            },
            h(Icon, { d: addOpen ? ICONS.x : ICONS.plus, size: 13 }),
            addOpen ? '收起' : '订阅源',
          ),
          h(
            'button',
            { className: 'dshr-btn dshr-iconbtn', onClick: refreshNow, disabled: refreshing, title: '刷新全部订阅' },
            h(Icon, { d: ICONS.refresh, size: 13, style: refreshing ? { animation: 'dshr-spin 900ms linear infinite' } : null }),
          ),
        ),
        addOpen
          ? h(
              'div',
              { className: 'dshr-composer' },
              h('input', {
                className: 'dshr-input',
                placeholder: '粘贴 RSS / RSSHub / we-mp-rss 地址…',
                value: addUrl,
                autoFocus: true,
                onChange: (e) => setAddUrl(e.target.value),
                onKeyDown: (e) => {
                  if (e.key === 'Enter') addFeed();
                },
              }),
              h(
                'div',
                { className: 'dshr-composer-row' },
                h('button', { className: 'dshr-btn dshr-btn-primary', onClick: addFeed, disabled: adding }, adding ? '添加中…' : '添加'),
                h('button', { className: 'dshr-btn', onClick: pickOpmlFile, disabled: importing, title: '从 OPML 文件批量导入订阅' }, importing ? '导入中…' : '导入 OPML'),
              ),
            )
          : null,
        h(
          'div',
          { className: 'dshr-side-scroll' },
          navRow({
            key: 'all',
            title: '全部文章',
            icon: ICONS.tray,
            badge: totalUnread,
            active: feedId === 'all',
            onClick: () => setFeedId('all'),
          }),
          h('div', { className: 'dshr-group-label' }, '订阅源'),
          feeds.flatMap((f) => {
            const hasFilter = !!(f.include || f.exclude);
            const acts = h(
              'span',
              { key: `${f.id}-acts`, className: 'dshr-rowacts' },
              h('button', {
                className: `dshr-rowact${hasFilter ? ' keep' : ''}`,
                title: `过滤：${f.include || '无'}${f.exclude ? ` // 排除：${f.exclude}` : ''}`,
                onClick: (e) => {
                  e.stopPropagation();
                  openFilterEditor(f);
                },
              }, h(Icon, { d: ICONS.sliders, size: 12 })),
              h('button', { className: 'dshr-rowact', title: '删除订阅', onClick: (e) => { e.stopPropagation(); removeFeed(f.id, f.title); } }, h(Icon, { d: ICONS.x, size: 12 })),
            );
            const row = navRow({
              key: f.id,
              avatar: true,
              warn: !!f.lastError,
              title: f.title,
              badge: f.unread,
              active: feedId === f.id,
              onClick: () => setFeedId(f.id),
              rowTitle: f.lastError ? `抓取失败：${f.lastError}` : f.url,
              mark: hasFilter ? h(Icon, { d: ICONS.sliders, size: 12, className: 'dshr-filter-mark' }) : null,
              acts,
            });
            const editor =
              filterEdit && filterEdit.id === f.id
                ? h(
                    'div',
                    { key: `${f.id}-filter`, className: 'dshr-filter-editor', onClick: (e) => e.stopPropagation() },
                    h('label', null, '包含词（| 分隔，命中其一才展示）'),
                    h('input', {
                      className: 'dshr-input',
                      value: filterEdit.include,
                      placeholder: '如：AI|模型|Agent',
                      onChange: (e) => setFilterEdit({ ...filterEdit, include: e.target.value }),
                    }),
                    h('label', null, '排除词（| 分隔，命中其一即隐藏）'),
                    h('input', {
                      className: 'dshr-input',
                      value: filterEdit.exclude,
                      placeholder: '如：广告|招聘',
                      onChange: (e) => setFilterEdit({ ...filterEdit, exclude: e.target.value }),
                    }),
                    h(
                      'div',
                      { className: 'dshr-filter-actions' },
                      h('button', { className: 'dshr-btn dshr-btn-primary', onClick: saveFilterEditor }, '保存'),
                      h('button', { className: 'dshr-btn', onClick: () => setFilterEdit(null) }, '取消'),
                    ),
                  )
                : null;
            return editor ? [row, editor] : [row];
          }),
          feeds.length === 0 ? h('div', { className: 'dshr-hint' }, '还没有订阅。点上方「订阅源」添加，试试 http://localhost:1200/sspai/matrix') : null,
        ),
      );

      const kbSide = h(
        'div',
        { key: 'kb-side', className: 'dshr-spacefade' },
        h(
          'div',
          { className: 'dshr-side-actions' },
          h(
            'button',
            { className: 'dshr-btn dshr-side-add', onClick: archiveDigest, title: '把当前文章清单归档为日报，存入知识库' },
            h(Icon, { d: ICONS.archive, size: 13 }),
            '归档日报',
          ),
        ),
        h(
          'div',
          { className: 'dshr-side-scroll' },
          navRow({
            key: 'kb-all',
            title: '全部条目',
            icon: ICONS.book,
            count: kbAll.length,
            active: kbKind === 'all' && !kbTag,
            onClick: () => {
              setKbKind('all');
              setKbTag(null);
            },
          }),
          h('div', { className: 'dshr-group-label' }, '类型'),
          KB_KINDS.map((k) =>
            navRow({
              key: k.key,
              icon: ICONS[k.icon],
              title: k.label,
              count: kindCount(k.key),
              active: kbKind === k.key && !kbTag,
              onClick: () => {
                setKbKind(k.key);
                setKbTag(null);
              },
            }),
          ),
          tags.length > 0 ? h('div', { className: 'dshr-group-label' }, '标签') : null,
          tags.map(([t, n]) =>
            navRow({
              key: `tag-${t}`,
              hash: true,
              title: t,
              count: n,
              active: kbTag === t,
              onClick: () => setKbTag(kbTag === t ? null : t),
            }),
          ),
        ),
      );

      const sidebar = h(
        'div',
        { className: 'dshr-side' },
        h(
          'div',
          { className: 'dshr-switch' },
          h('div', { className: 'dshr-switch-ind', style: { transform: space === 'kb' ? 'translateX(100%)' : 'translateX(0)' } }),
          h('button', { className: 'dshr-switch-btn', 'data-active': space === 'read', onClick: () => setSpace('read') }, h(Icon, { d: ICONS.tray, size: 14 }), '阅读'),
          h('button', { className: 'dshr-switch-btn', 'data-active': space === 'kb', onClick: () => setSpace('kb') }, h(Icon, { d: ICONS.book, size: 14 }), '知识库'),
        ),
        space === 'read' ? readSide : kbSide,
      );

      // ---------------- 渲染：中栏列表 ----------------

      const ctxLabel =
        space === 'kb'
          ? `知识库 · ${kbLoaded ? `${kbList.length} 条` : '加载中'}`
          : `${feedId === 'all' ? '全部文章' : feeds.find((f) => f.id === feedId)?.title ?? '订阅'} · ${itemsLoaded ? `${items.length} 篇` : '加载中'}`;

      const segBtn = (key, label) =>
        h('button', { key, 'data-active': view === key, onClick: () => setView(key) }, label);

      const articleList = h(
        'div',
        null,
        items === null
          ? [0, 1, 2, 3, 4].map((i) =>
              h('div', { key: `sk${i}`, className: 'dshr-skel' },
                h('div', { className: 'dshr-skel-bar', style: { width: '72%' } }),
                h('div', { className: 'dshr-skel-bar', style: { width: '38%' } }),
              ),
            )
          : null,
        Array.isArray(items) && items.map((it) =>
          h(
            'div',
            {
              key: it.id,
              className: `dshr-item${it.read ? '' : ' unread'}${activeArticleId === it.id ? ' active' : ''}`,
              onClick: () => showArticle(it.id),
            },
            h(
              'div',
              { className: 'dshr-item-title' },
              it.starred ? h(Icon, { d: ICONS.star, size: 11, fill: true, className: 'dshr-item-star' }) : null,
              it.title,
            ),
            h('div', { className: 'dshr-item-meta' }, `${it.feedTitle} · ${relTime(it.publishedAt)}`),
            it.snippet ? h('div', { className: 'dshr-item-snippet' }, it.snippet) : null,
          ),
        ),
        itemsLoaded && Array.isArray(items) && items.length === 0
          ? view === 'unread'
            ? h(
                'div',
                { className: 'dshr-hint dshr-empty-actions' },
                '没有未读文章，读得很干净',
                allCount ? h('div', { className: 'dshr-empty-sub' }, `共 ${allCount} 篇已读文章在库`) : null,
                h('button', { className: 'dshr-btn', onClick: () => setView('all') }, '查看全部文章'),
              )
            : view === 'starred'
              ? '没有星标文章'
              : '暂无文章，点左上角刷新看看'
          : null,
      );

      const kbListEl = h(
        'div',
        null,
        kbList.map((k) =>
          h(
            'div',
            {
              key: k.id,
              className: `dshr-item${kbDetail && kbDetail.id === k.id && stageTop?.kind === 'kb' ? ' active' : ''}`,
              onClick: () => openKb(k.id),
            },
            h(
              'div',
              { className: 'dshr-item-title' },
              h(Icon, { d: kindIcon(k.kind), size: 12, className: 'dshr-item-kind' }),
              k.title,
            ),
            h(
              'div',
              { className: 'dshr-item-meta' },
              `${k.sourceFeedTitle || kindLabel(k.kind)} · ${relTime(k.createdAt)}${k.tags.length ? ' · ' + k.tags.join(' / ') : ''}`,
            ),
            k.snippet ? h('div', { className: 'dshr-item-snippet' }, k.snippet) : null,
          ),
        ),
        kbLoaded && kbList.length === 0
          ? h('div', { className: 'dshr-hint' }, kbQuery.trim() || kbTag || kbKind !== 'all' ? '没有匹配的条目，换个关键词或筛选条件试试' : '知识库还是空的。读文章时点「收藏入库」，或在这里「归档日报」。')
          : null,
      );

      const listCol = h(
        'div',
        { className: 'dshr-col dshr-items' },
        h(
          'div',
          { className: 'dshr-bar' },
          h('span', { className: 'dshr-bar-label' }, ctxLabel),
          space === 'read'
            ? h('div', { className: 'dshr-seg' }, segBtn('unread', '未读'), segBtn('all', '全部'), segBtn('starred', '星标'))
            : [
                h('input', {
                  key: 'q',
                  className: 'dshr-input dshr-bar-input',
                  placeholder: '搜索知识库…',
                  value: kbQuery,
                  onChange: (e) => setKbQuery(e.target.value),
                  onKeyDown: (e) => {
                    if (e.key === 'Enter') loadKb();
                  },
                }),
                h('button', { key: 'go', className: 'dshr-btn dshr-btn-primary', onClick: () => loadKb() }, '搜索'),
              ],
        ),
        space === 'read' ? articleList : kbListEl,
      );

      // ---------------- 渲染：阅读舞台 ----------------

      const stageNav =
        stageTop && stage.length > 1
          ? h(
              'div',
              { className: 'dshr-stage-nav' },
              h(
                'button',
                { className: 'dshr-back', onClick: popStage },
                h(Icon, { d: ICONS.chevronLeft, size: 14 }),
                stagePrev?.kind === 'article' ? '返回文章' : '返回条目',
              ),
            )
          : null;

      // 详情与栈帧按 id 匹配：推入新帧时旧详情不串台；弹回旧帧时详情仍在，即时呈现
      const articleStage =
        articleDetail && articleDetail.id === stageTop?.id
          ? h(
              'article',
              { key: `a-${articleDetail.id}`, className: 'dshr-article' },
              h('h1', { className: 'dshr-article-title' }, articleDetail.title),
              h(
                'div',
                { className: 'dshr-article-meta' },
                h('span', null, `${articleDetail.feedTitle}${articleDetail.author ? ` · ${articleDetail.author}` : ''} · ${relTime(articleDetail.publishedAt)}`),
                h('span', { className: 'dshr-meta-sep' }),
                h(
                  'button',
                  { className: 'dshr-meta-act', 'data-on': !!articleDetail.starred, onClick: toggleStar, title: articleDetail.starred ? '取消星标' : '加星标' },
                  h(Icon, { d: ICONS.star, size: 13, fill: !!articleDetail.starred }),
                  articleDetail.starred ? '已星标' : '星标',
                ),
                h(
                  'button',
                  { className: 'dshr-meta-act', onClick: saveArticleToKb, title: '把全文快照存入知识库' },
                  h(Icon, { d: ICONS.save, size: 13 }),
                  '收藏入库',
                ),
                h(
                  'a',
                  { className: 'dshr-meta-act', href: articleDetail.link, target: '_blank', rel: 'noopener noreferrer' },
                  h(Icon, { d: ICONS.external, size: 13 }),
                  '打开原文',
                ),
              ),
              articleDetail.contentHtml
                ? h('div', { className: 'dshr-content', dangerouslySetInnerHTML: { __html: articleDetail.contentHtml } })
                : h(
                    'div',
                    { className: 'dshr-hint' },
                    '该源未提供全文，请 ',
                    h('a', { href: articleDetail.link, target: '_blank', rel: 'noopener noreferrer' }, '打开原文阅读'),
                  ),
              relatedKb.length > 0
                ? h(
                    'div',
                    { className: 'dshr-related' },
                    h('div', { className: 'dshr-related-label' }, '知识库相关'),
                    relatedKb.map((k) =>
                      h(
                        'div',
                        { key: k.id, className: 'dshr-related-item', onClick: () => openKb(k.id, true) },
                        h('div', { className: 'dshr-related-title' },
                          h(Icon, { d: kindIcon(k.kind), size: 12, className: 'dshr-item-kind' }),
                          k.title,
                        ),
                        k.snippet ? h('div', { className: 'dshr-item-snippet' }, k.snippet) : null,
                      ),
                    ),
                  )
                : null,
            )
          : h('div', { className: 'dshr-empty' }, '正在加载文章…');

      const kbStage = kbDetail && kbDetail.id === stageTop?.id
        ? h(
            'article',
            { key: `k-${kbDetail.id}`, className: 'dshr-article' },
            h('h1', { className: 'dshr-article-title' }, kbDetail.title),
            h(
              'div',
              { className: 'dshr-article-meta' },
              h('span', { className: 'dshr-kindchip' }, h(Icon, { d: kindIcon(kbDetail.kind), size: 12 }), kindLabel(kbDetail.kind)),
              kbDetail.sourceFeedTitle ? h('span', null, kbDetail.sourceFeedTitle) : null,
              h('span', null, relTime(kbDetail.createdAt)),
              h('span', { className: 'dshr-meta-sep' }),
              kbDetail.link
                ? h('a', { className: 'dshr-meta-act', href: kbDetail.link, target: '_blank', rel: 'noopener noreferrer' },
                    h(Icon, { d: ICONS.external, size: 13 }), '打开原文')
                : null,
              kbDetail.articleId
                ? h('button', { className: 'dshr-meta-act', onClick: () => showArticle(kbDetail.articleId, true), title: '在阅读器中打开库存原文' },
                    h(Icon, { d: ICONS.file, size: 13 }), '库存原文')
                : null,
              h('button', { className: 'dshr-meta-act', onClick: () => removeKbEntry(kbDetail.id) },
                h(Icon, { d: ICONS.x, size: 13 }), '删除'),
            ),
            h(
              'div',
              { className: 'dshr-kb-note' },
              h('div', { className: 'dshr-kb-note-label' }, h(Icon, { d: ICONS.pen, size: 12 }), '我的笔记'),
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
        : h('div', { className: 'dshr-empty' }, '正在加载条目…');

      const emptyText = space === 'kb' ? '选择一条知识库条目查看' : '选择一篇文章开始阅读';
      const loadingEl = h('div', { className: 'dshr-empty' }, '正在加载…');
      let stageBody;
      if (!stageTop) stageBody = h('div', { className: 'dshr-empty' }, emptyText);
      else if (stageTop.kind === 'article') stageBody = articleDetail && articleDetail.id === stageTop.id ? articleStage : loadingEl;
      else stageBody = kbDetail && kbDetail.id === stageTop.id ? kbStage : loadingEl;
      const stageCol = h(
        'div',
        { className: 'dshr-col dshr-reader' },
        stageNav,
        stageBody,
      );

      // ---------------- 组装 ----------------

      return h(
        'div',
        { className: 'dshr-root' },
        h('style', null, CSS),
        h('div', { className: 'dshr-shell' }, sidebar, listCol, stageCol),
        notice
          ? h('div', { className: 'dshr-toast', 'data-kind': notice.kind, onClick: () => setNoticeState(null), title: '点击关闭' }, notice.text)
          : null,
        h('input', {
          ref: fileInputRef,
          type: 'file',
          accept: '.opml,.xml',
          style: { display: 'none' },
          onChange: onOpmlFile,
        }),
      );
    }

    // ---------------------------------------------------------------- 样式

    const CSS = `
.dshr-root {
  --r-ease: cubic-bezier(0.23, 1, 0.32, 1);
  --r-fast: 140ms;
  --r-med: 200ms;
  position: relative; display: flex; height: 100%; min-height: 0; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font-size: 14px; line-height: 1.5;
}
.dshr-root ::selection { background: var(--dsw-alias-brand-primary); color: var(--dsw-alias-bg-base); }
.dshr-root :focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; border-radius: 4px; }
.dshr-shell { display: flex; width: 100%; min-height: 0; }
.dshr-col { min-height: 0; overflow-y: auto; scrollbar-width: thin; scrollbar-color: var(--dsw-alias-border-l2) transparent; }
.dshr-col::-webkit-scrollbar { width: 8px; }
.dshr-col::-webkit-scrollbar-thumb { background: var(--dsw-alias-border-l2); border-radius: 4px; }
.dshr-col::-webkit-scrollbar-track { background: transparent; }

/* ---- 侧栏：空间切换器 + 空间导航 ---- */
.dshr-side { width: 252px; flex: none; border-right: 1px solid var(--dsw-alias-border-l1); display: flex; flex-direction: column; background: var(--dsw-alias-specific-sidebar-fill, var(--dsw-alias-bg-layer-1)); }
.dshr-switch { position: relative; display: flex; margin: 10px 10px 8px; padding: 3px; border-radius: 9px; background: var(--dsw-alias-bg-base); border: 1px solid var(--dsw-alias-border-l1); }
.dshr-switch-ind { position: absolute; top: 3px; bottom: 3px; left: 3px; width: calc(50% - 3px); border-radius: 7px; background: var(--dsw-alias-bg-layer-2); box-shadow: 0 1px 3px rgba(0,0,0,.14); transition: transform 220ms var(--r-ease); }
.dshr-switch-btn { position: relative; z-index: 1; flex: 1; display: inline-flex; align-items: center; justify-content: center; gap: 6px; border: none; background: transparent; color: var(--dsw-alias-label-secondary); font-size: 12.5px; font-weight: 600; padding: 6px 0; cursor: pointer; border-radius: 7px; transition: color var(--r-fast) ease; }
.dshr-switch-btn[data-active="true"] { color: var(--dsw-alias-label-primary); }
.dshr-side-actions { display: flex; gap: 6px; padding: 2px 10px 8px; }
.dshr-side-add { flex: 1; display: inline-flex; align-items: center; justify-content: center; gap: 6px; }
.dshr-iconbtn { display: inline-flex; align-items: center; justify-content: center; padding: 4px 9px; }
.dshr-spacefade { display: flex; flex-direction: column; min-height: 0; flex: 1; animation: dshr-fade 180ms var(--r-ease); }
.dshr-composer { display: flex; flex-direction: column; gap: 6px; padding: 2px 10px 10px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.dshr-composer-row { display: flex; gap: 6px; }
.dshr-composer-row .dshr-btn { flex: 1; }
.dshr-side-scroll { flex: 1; min-height: 0; overflow-y: auto; padding: 2px 6px 10px; scrollbar-width: thin; scrollbar-color: var(--dsw-alias-border-l2) transparent; }
.dshr-group-label { padding: 12px 8px 4px; font-size: 11px; letter-spacing: 0.02em; color: var(--dsw-alias-label-secondary); }
.dshr-navrow { position: relative; display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: 8px; cursor: pointer; font-size: 12.5px; transition: background-color var(--r-fast) ease, box-shadow var(--r-fast) ease; }
.dshr-navrow:hover { background: var(--dsw-alias-bg-layer-2); }
.dshr-navrow.active { background: var(--dsw-alias-bg-layer-2); box-shadow: inset 2px 0 0 var(--dsw-alias-brand-primary); }
.dshr-navrow-icon { color: var(--dsw-alias-label-secondary); }
.dshr-navrow.active .dshr-navrow-icon { color: var(--dsw-alias-brand-primary); }
.dshr-navrow-warn { color: var(--dsw-alias-state-warn-primary); }
.dshr-navrow-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: inline-flex; align-items: center; gap: 6px; }
.dshr-avatar { flex: none; width: 22px; height: 22px; border-radius: 6px; background: var(--dsw-alias-bg-base); border: 1px solid var(--dsw-alias-border-l1); display: inline-flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 600; color: var(--dsw-alias-label-secondary); }
.dshr-taghash { color: var(--dsw-alias-brand-primary); font-weight: 700; }
.dshr-count { flex: none; font-size: 11px; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }
.dshr-badge { flex: none; min-width: 20px; text-align: center; font-size: 11px; font-weight: 600; border-radius: 10px; padding: 1px 6px; background: var(--dsw-alias-brand-primary); color: var(--dsw-alias-bg-base); font-variant-numeric: tabular-nums; }
.dshr-rowacts { position: absolute; right: 6px; top: 50%; transform: translateY(-50%); display: inline-flex; align-items: center; gap: 2px; padding-left: 14px; background: linear-gradient(90deg, transparent, var(--dsw-alias-bg-layer-2) 40%); visibility: hidden; pointer-events: none; }
.dshr-navrow:hover .dshr-rowacts { visibility: visible; }
.dshr-rowacts .dshr-rowact { pointer-events: auto; }
.dshr-rowacts .dshr-rowact.keep { visibility: visible; color: var(--dsw-alias-state-warn-primary); }
.dshr-rowact { flex: none; border: none; background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer; padding: 3px; border-radius: 4px; display: inline-flex; }
.dshr-rowact:hover { color: var(--dsw-alias-state-error-primary); background: var(--dsw-alias-bg-base); }
.dshr-filter-mark { color: var(--dsw-alias-state-warn-primary); }
.dshr-hint { padding: 16px 12px; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 1.8; word-break: break-all; }
.dshr-empty-actions { display: flex; flex-direction: column; align-items: flex-start; gap: 10px; }
.dshr-empty-actions .dshr-btn { margin-top: 2px; }
.dshr-empty-sub { color: var(--dsw-alias-label-secondary); opacity: 0.8; }
.dshr-filter-editor { display: flex; flex-direction: column; gap: 6px; margin: 2px 2px 8px; padding: 10px 12px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; background: var(--dsw-alias-bg-base); }
.dshr-filter-editor label { font-size: 11px; color: var(--dsw-alias-label-secondary); }
.dshr-filter-actions { display: flex; gap: 6px; justify-content: flex-end; margin-top: 2px; }

/* ---- 按钮 / 输入 ---- */
.dshr-btn { display: inline-flex; align-items: center; justify-content: center; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); border-radius: 7px; padding: 4px 11px; font-size: 12px; cursor: pointer; transition: background-color var(--r-fast) ease, border-color var(--r-fast) ease, transform 160ms var(--r-ease), opacity var(--r-fast) ease; }
.dshr-btn:hover { background: var(--dsw-alias-bg-layer-1); }
.dshr-btn:active { transform: scale(0.96); }
.dshr-btn:disabled { opacity: 0.45; cursor: default; transform: none; }
.dshr-btn-primary { background: var(--dsw-alias-brand-primary); border-color: transparent; color: var(--dsw-alias-bg-base); font-weight: 600; }
.dshr-btn-primary:hover { background: var(--dsw-alias-brand-primary); filter: brightness(1.08); }
.dshr-input { flex: 1; min-width: 0; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); border-radius: 7px; padding: 6px 9px; font-size: 12px; outline: none; transition: border-color var(--r-fast) ease; }
.dshr-input:focus { border-color: var(--dsw-alias-brand-primary); }

/* ---- 中栏：上下文条 + 列表 ---- */
.dshr-items { width: 350px; flex: none; border-right: 1px solid var(--dsw-alias-border-l1); display: flex; flex-direction: column; }
.dshr-bar { position: sticky; top: 0; z-index: 2; display: flex; align-items: center; gap: 8px; padding: 10px 14px; background: color-mix(in srgb, var(--dsw-alias-bg-base) 82%, transparent); backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px); border-bottom: 1px solid var(--dsw-alias-border-l1); }
.dshr-bar-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-secondary); letter-spacing: 0.02em; }
.dshr-bar-input { flex: none; width: 130px; }
.dshr-seg { display: flex; gap: 2px; padding: 2px; background: var(--dsw-alias-bg-layer-1); border-radius: 7px; flex: none; }
.dshr-seg button { border: none; background: transparent; color: var(--dsw-alias-label-secondary); font-size: 11.5px; padding: 3px 10px; border-radius: 5px; cursor: pointer; transition: background-color var(--r-fast) ease, color var(--r-fast) ease; }
.dshr-seg button:hover { color: var(--dsw-alias-label-primary); }
.dshr-seg button[data-active="true"] { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); font-weight: 600; }
.dshr-item { padding: 12px 16px 11px; border-bottom: 1px solid var(--dsw-alias-border-l1); cursor: pointer; transition: background-color var(--r-fast) ease, box-shadow var(--r-fast) ease; }
.dshr-item:hover { background: var(--dsw-alias-bg-layer-1); }
.dshr-item.active { background: var(--dsw-alias-bg-layer-2); box-shadow: inset 3px 0 0 var(--dsw-alias-brand-primary); }
.dshr-item.unread .dshr-item-title { font-weight: 600; color: var(--dsw-alias-label-primary); }
.dshr-item:not(.unread) .dshr-item-title { color: var(--dsw-alias-label-secondary); }
.dshr-item.unread .dshr-item-title::before { content: '● '; color: var(--dsw-alias-brand-primary); font-size: 9px; vertical-align: 2px; }
.dshr-item-title { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; line-height: 1.45; font-size: 13.5px; }
.dshr-item-star { display: inline !important; color: var(--dsw-alias-brand-primary); margin-right: 4px; vertical-align: -1px; }
.dshr-item-kind { display: inline !important; color: var(--dsw-alias-label-secondary); margin-right: 6px; vertical-align: -1px; }
.dshr-item-meta { margin-top: 5px; font-size: 11.5px; color: var(--dsw-alias-label-secondary); }
.dshr-item-snippet { margin-top: 4px; font-size: 12px; color: var(--dsw-alias-label-secondary); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; line-height: 1.6; }
.dshr-skel { padding: 14px 16px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.dshr-skel-bar { height: 11px; border-radius: 5px; margin: 7px 0; background: linear-gradient(90deg, var(--dsw-alias-bg-layer-1) 25%, var(--dsw-alias-bg-layer-2) 45%, var(--dsw-alias-bg-layer-1) 65%); background-size: 240% 100%; animation: dshr-shimmer 1.4s ease infinite; }
@keyframes dshr-shimmer { 0% { background-position: 120% 0; } 100% { background-position: -120% 0; } }

/* ---- 右栏：持久阅读舞台（两空间共用，唯一的"讲究"预算花在这里）---- */
.dshr-reader { flex: 1; min-width: 0; }
.dshr-stage-nav { position: sticky; top: 0; z-index: 3; display: flex; align-items: center; padding: 7px 16px; background: color-mix(in srgb, var(--dsw-alias-bg-base) 82%, transparent); backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px); border-bottom: 1px solid var(--dsw-alias-border-l1); }
.dshr-back { display: inline-flex; align-items: center; gap: 5px; border: none; background: transparent; color: var(--dsw-alias-brand-primary); font-size: 12px; font-weight: 600; cursor: pointer; padding: 3px 8px; margin-left: -8px; border-radius: 6px; transition: background-color var(--r-fast) ease; }
.dshr-back:hover { background: var(--dsw-alias-bg-layer-1); }
.dshr-empty { padding: 64px 16px; text-align: center; color: var(--dsw-alias-label-secondary); }
.dshr-article { max-width: 72ch; margin: 0 auto; padding: 30px 44px 96px; animation: dshr-stage-in 220ms var(--r-ease); }
@keyframes dshr-stage-in { from { opacity: 0; transform: translateX(16px); } to { opacity: 1; transform: none; } }
.dshr-article-title { font-size: 24px; font-weight: 650; line-height: 1.32; letter-spacing: -0.01em; margin: 0 0 12px; }
.dshr-article-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; font-size: 12px; color: var(--dsw-alias-label-secondary); padding-bottom: 16px; border-bottom: 1px solid var(--dsw-alias-border-l1); margin-bottom: 28px; }
.dshr-meta-sep { flex: 1; }
.dshr-meta-act { display: inline-flex; align-items: center; gap: 5px; border: none; background: transparent; color: var(--dsw-alias-label-secondary); font-size: 12px; cursor: pointer; padding: 2px 4px; border-radius: 5px; text-decoration: none; transition: color var(--r-fast) ease; }
.dshr-meta-act:hover { color: var(--dsw-alias-brand-primary); }
.dshr-meta-act[data-on="true"] { color: var(--dsw-alias-brand-primary); }
.dshr-kindchip { display: inline-flex; align-items: center; gap: 5px; padding: 1px 8px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 9px; font-size: 11px; }
.dshr-content { font-family: Georgia, 'Times New Roman', 'Noto Serif SC', 'Source Han Serif SC', 'Songti SC', SimSun, serif; font-size: 16.5px; line-height: 1.95; word-break: break-word; }
.dshr-content img, .dshr-content video { max-width: 100%; height: auto; border-radius: 8px; margin: 10px 0; }
.dshr-content p { margin: 0 0 1.3em; }
.dshr-content h1, .dshr-content h2, .dshr-content h3, .dshr-content h4 { font-family: -apple-system, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', system-ui, sans-serif; line-height: 1.4; margin: 1.7em 0 0.6em; font-weight: 600; }
.dshr-content h1 { font-size: 20px; } .dshr-content h2 { font-size: 18px; } .dshr-content h3 { font-size: 16px; } .dshr-content h4 { font-size: 15px; }
.dshr-content hr { border: none; border-top: 1px solid var(--dsw-alias-border-l1); margin: 2em 0; }
.dshr-content pre { overflow-x: auto; padding: 14px; border-radius: 8px; background: var(--dsw-alias-bg-layer-1); font-size: 13px; line-height: 1.6; }
.dshr-content code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.88em; }
.dshr-content p code, .dshr-content li code { background: var(--dsw-alias-bg-layer-1); padding: 1px 5px; border-radius: 4px; }
.dshr-content blockquote { margin: 0 0 1.2em; padding: 6px 16px; border-left: 3px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-label-secondary); }
.dshr-content table { border-collapse: collapse; margin: 1em 0; }
.dshr-content td, .dshr-content th { border: 1px solid var(--dsw-alias-border-l1); padding: 6px 10px; }
.dshr-content ul, .dshr-content ol { padding-left: 24px; margin: 0 0 1.2em; }
.dshr-content li { margin: 4px 0; }
/* 深色/浅色通吃：中和文章内联写死的颜色（!important 作者样式 > 无 !important 内联） */
.dshr-content * { color: inherit !important; background-color: transparent !important; background-image: none !important; }
.dshr-content a { color: var(--dsw-alias-brand-primary) !important; }
.dshr-content pre { background-color: var(--dsw-alias-bg-layer-1) !important; }
.dshr-content pre, .dshr-content code { color: var(--dsw-alias-label-primary) !important; }
.dshr-content blockquote { color: var(--dsw-alias-label-secondary) !important; }

/* ---- 知识库舞台 ---- */
.dshr-kb-note { margin: 0 0 22px; padding: 14px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; background: var(--dsw-alias-bg-layer-1); }
.dshr-kb-note-label { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--dsw-alias-label-secondary); margin-bottom: 8px; }
.dshr-kb-note-input { width: 100%; min-height: 72px; box-sizing: border-box; resize: vertical; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); border-radius: 7px; padding: 9px 10px; font-size: 13px; line-height: 1.65; margin-bottom: 8px; outline: none; font-family: inherit; transition: border-color var(--r-fast) ease; }
.dshr-kb-note-input:focus { border-color: var(--dsw-alias-brand-primary); }
.dshr-related { margin-top: 30px; padding: 14px 16px; border-radius: 10px; background: var(--dsw-alias-bg-layer-1); }
.dshr-related-label { font-size: 12px; color: var(--dsw-alias-label-secondary); margin-bottom: 6px; letter-spacing: 0.02em; }
.dshr-related-item { padding: 8px 6px; border-radius: 6px; cursor: pointer; transition: background-color var(--r-fast) ease; }
.dshr-related-item:hover { background: var(--dsw-alias-bg-base); }
.dshr-related-title { font-size: 13px; line-height: 1.5; display: flex; align-items: baseline; gap: 6px; }

/* ---- 轻提示 ---- */
.dshr-toast { position: absolute; left: 50%; bottom: 18px; transform: translateX(-50%); max-width: 72%; padding: 9px 14px; border-radius: 9px; background: color-mix(in srgb, var(--dsw-alias-bg-layer-2) 92%, transparent); backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px); border: 1px solid var(--dsw-alias-border-l1); box-shadow: 0 6px 24px rgba(0,0,0,.22); font-size: 12.5px; line-height: 1.6; z-index: 10; cursor: pointer; word-break: break-all; animation: dshr-toast-in 200ms var(--r-ease); }
.dshr-toast[data-kind="err"] { box-shadow: inset 2px 0 0 var(--dsw-alias-state-error-primary), 0 6px 24px rgba(0,0,0,.22); }
@keyframes dshr-toast-in { from { opacity: 0; transform: translate(-50%, 8px); } to { opacity: 1; transform: translate(-50%, 0); } }
@keyframes dshr-fade { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
@keyframes dshr-spin { to { transform: rotate(360deg); } }

/* ---- 动效纪律 ---- */
@media (prefers-reduced-motion: reduce) {
  .dshr-root *, .dshr-root *::before, .dshr-root *::after { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; }
  .dshr-skel-bar { animation: none !important; }
}
@media (hover: none) {
  .dshr-rowacts { visibility: visible; }
}
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
