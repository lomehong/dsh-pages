// 直读 we-mp-rss SQLite 数据库，输出订阅与文章抓取状态
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('data/we-mp-rss/db.db', { readOnly: true });

const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
console.log('tables:', tables.join(', '));

if (tables.includes('feeds')) {
  const feeds = db.prepare('SELECT * FROM feeds').all();
  console.log('\nfeeds:');
  for (const f of feeds) console.log(' ', JSON.stringify(f));
}

if (tables.includes('articles')) {
  const cols = db.prepare('PRAGMA table_info(articles)').all().map((r) => r.name);
  const idCol = cols.includes('mp_id') ? 'mp_id' : cols.includes('feed_id') ? 'feed_id' : null;
  console.log('\narticles group key:', idCol);
  if (idCol) {
    const arts = db
      .prepare(
        `SELECT ${idCol} AS k, COUNT(*) n, SUM(has_content) with_content, MAX(publish_time) latest FROM articles GROUP BY ${idCol}`,
      )
      .all();
    console.log('articles:');
    for (const a of arts) console.log(' ', JSON.stringify(a));
  }
  const sample = db.prepare('SELECT title, has_content, publish_time, LENGTH(content) clen FROM articles ORDER BY publish_time DESC LIMIT 5').all();
  console.log('\nlatest articles:');
  for (const s of sample) console.log(' ', JSON.stringify(s));
}

db.close();
