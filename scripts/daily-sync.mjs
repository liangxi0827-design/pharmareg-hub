/* 每日数据刷新(GitHub Actions 里运行,不依赖任何人的电脑)
 *
 * 作用:
 *   1) 抓取各监管机构官方新闻源(FDA / MHRA / WHO / NMPA) → 合并进 data/hub.json 的 news-live.json;
 *   2) 维护 data/meta.json 的更新时间字段:updatedAt(数据真正变化的时间)、checkedAt(最近检查时间),
 *      CDE 原辅包快照时间(cde.updatedAt)由本机每日同步维护,这里原样保留、不覆盖。
 *
 * 用法:node scripts/daily-sync.mjs
 * 设计:只用 Node 自带模块,无需 npm install;任一来源失败只记状态,不中断(单来源失效不影响整次更新)。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

/* 官方新闻源(与本地服务版 data/sources.json 同款) */
const SOURCES = [
  {
    id: 'fda-press', name: 'FDA Press Announcements', type: 'html',
    url: 'https://www.fda.gov/news-events/fda-newsroom/press-announcements',
    baseUrl: 'https://www.fda.gov',
    itemRegex: 'href="(/news-events/press-announcements/[a-z0-9-]+)"[^>]*>([\\s\\S]{10,400}?)</a>',
    dateGroup: '<time datetime="(\\d{4}-\\d{2}-\\d{2})',
    maxItems: 12, tag: 'FDA', lang: 'EN',
  },
  {
    id: 'nmpa-ggtg', name: 'NMPA 药品公告/法规', type: 'html',
    url: 'https://www.nmpa.gov.cn/yaopin/ypggtg/index.html',
    fallbackUrls: ['https://www.nmpa.gov.cn/xxgk/fgwj/xzhgfxwj/index.html', 'https://www.nmpa.gov.cn/yaopin/ypfgwj/index.html'],
    baseUrl: 'https://www.nmpa.gov.cn',
    itemRegex: '<a\\s+href="([^"]*\\d{17}\\.html)"[^>]*title=\'([^\']{8,200})\'[^>]*>',
    maxItems: 20, tag: 'NMPA', lang: 'CN',
  },
  {
    id: 'mhra-atom', name: 'MHRA (gov.uk Atom)', type: 'atom',
    url: 'https://www.gov.uk/government/organisations/medicines-and-healthcare-products-regulatory-agency.atom',
    maxItems: 10, tag: 'MHRA', lang: 'EN',
  },
  {
    id: 'who-rss', name: 'WHO News (RSS)', type: 'rss',
    url: 'https://www.who.int/rss-feeds/news-english.xml',
    maxItems: 8, tag: 'WHO', lang: 'EN',
    filter: 'medicin|pharmac|drug|vaccine|health product|regulat',
  },
];

function fetchText(url, timeoutMs = 25000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  return fetch(url, { signal: ctrl.signal, redirect: 'follow', headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9,zh-CN;q=0.8' } })
    .then(async res => ({ status: res.status, text: await res.text() }))
    .finally(() => clearTimeout(timer));
}
function parseAtom(xml) {
  const items = [];
  for (const m of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const seg = m[1];
    const title = (seg.match(/<title>([\s\S]*?)<\/title>/) || [, ''])[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim();
    const link = (seg.match(/href="([^"]+)"/) || [, ''])[1];
    const date = (seg.match(/<updated>([\s\S]*?)<\/updated>/) || [, ''])[1].slice(0, 10);
    if (title && link) items.push({ title, url: link, date });
  }
  return items;
}
function parseRss(xml) {
  const items = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const seg = m[1];
    const title = (seg.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/) || [, ''])[1].trim();
    const link = (seg.match(/<link>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/link>/) || [, ''])[1].trim();
    const pub = (seg.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [, ''])[1].trim();
    let date = new Date().toISOString().slice(0, 10);
    try { if (pub) date = new Date(pub).toISOString().slice(0, 10); } catch (e) { }
    if (title && link) items.push({ title, url: link, date });
  }
  return items;
}
function resolveUrl(href, baseUrl) {
  let u = href;
  if (u.startsWith('../../')) u = u.slice(6);
  else if (u.startsWith('../')) u = u.slice(3);
  try { return new URL(u, baseUrl).href; } catch (e) { return u; }
}
function parseHtmlList(html, src) {
  const items = [];
  const re = new RegExp(src.itemRegex, 'g');
  let m;
  while ((m = re.exec(html)) && items.length < src.maxItems * 3) {
    const href = m[1];
    let title = (m[2] || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    title = title.replace(/^[A-Z][a-z]+ \d{1,2}, \d{4} - /, '');
    const url = resolveUrl(href, src.baseUrl);
    if (!title || title.length < 8) continue;
    let date = new Date().toISOString().slice(0, 10);
    if (src.dateGroup) {
      const dm = m[0].match(new RegExp(src.dateGroup));
      if (dm) date = dm[1];
    } else {
      const dm = url.match(/(\d{8})\d{6,}\.html/);
      if (dm) date = `${dm[1].slice(0, 4)}-${dm[1].slice(4, 6)}-${dm[1].slice(6, 8)}`;
    }
    items.push({ title, url, date });
  }
  return items;
}
const hashId = url => 's-' + createHash('sha1').update(url).digest('hex').slice(0, 10);
const stripHash = u => String(u || '').replace(/[#?].*$/, '');

async function collect() {
  const status = [], collected = [];
  for (const src of SOURCES) {
    const urls = [src.url, ...(src.fallbackUrls || [])];
    let code = 0, raw = [];
    try {
      for (const u of urls) {
        const r = await fetchText(u);
        code = r.status;
        if (code !== 200) continue;
        raw = src.type === 'atom' ? parseAtom(r.text) : src.type === 'rss' ? parseRss(r.text) : parseHtmlList(r.text, src);
        if (raw.length) break;
      }
      if (code !== 200 || !raw.length) { status.push({ id: src.id, ok: false, code, count: 0, msg: raw.length ? '' : 'HTTP ' + code + ' 或页面结构变化' }); continue; }
      if (src.filter) { const fr = new RegExp(src.filter, 'i'); raw = raw.filter(it => fr.test(it.title)); }
      raw = raw.slice(0, src.maxItems);
      for (const it of raw) collected.push({ ...it, source: src.tag, lang: src.lang || 'EN' });
      status.push({ id: src.id, ok: true, code, count: raw.length });
    } catch (e) {
      status.push({ id: src.id, ok: false, code: 0, msg: String(e && e.message || e).slice(0, 160) });
    }
  }
  return { status, collected };
}

async function main() {
  const hubPath = join(ROOT, 'data', 'hub.json');
  const metaPath = join(ROOT, 'data', 'meta.json');
  if (!existsSync(hubPath)) throw new Error('data/hub.json 不存在,先运行本机 cloud-sync 生成一次');
  const hub = JSON.parse(readFileSync(hubPath, 'utf8'));
  if (!hub || !hub.files) throw new Error('data/hub.json 结构异常');
  let meta = {};
  try { meta = JSON.parse(readFileSync(metaPath, 'utf8')); } catch (e) { meta = {}; }
  let news = {};
  try { news = JSON.parse(hub.files['news-live.json'] || '{}'); } catch (e) { news = {}; }
  news.items = Array.isArray(news.items) ? news.items : [];

  const { status, collected } = await collect();
  const seen = new Set(news.items.map(i => stripHash(i.url)).filter(Boolean));
  const fresh = [];
  for (const it of collected) {
    const url = stripHash(it.url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    fresh.push({ id: hashId(url), date: it.date, source: it.source, title: it.title, url, tags: ['同步'], summary: '', synced: true });
  }
  const now = new Date().toISOString();
  let wroteHub = false;
  if (fresh.length) {
    news.items = [...fresh, ...news.items].slice(0, 2000);
    news.lastSync = now;
    news.sourceStatus = status;
    hub.files['news-live.json'] = JSON.stringify(news);
    hub.updatedAt = now;
    wroteHub = true;
    writeFileSync(hubPath, JSON.stringify(hub));
  }
  const newMeta = {
    updatedAt: wroteHub ? now : (meta.updatedAt || (meta.hub && meta.hub.updatedAt) || now),
    checkedAt: now,
    dataSha: meta.dataSha || '',
    /* CDE 全量快照只能由分享者电脑上的 Edge 拉取,这里原样保留上次的时间与规模 */
    cde: meta.cde || {},
    hub: { updatedAt: hub.updatedAt || now, file: 'hub.json' },
    news: { updatedAt: now, items: news.items.length, added: fresh.length, lastSync: news.lastSync || now },
    sources: status,
    engine: 'github-actions',
    site: meta.site || '',
  };
  writeFileSync(metaPath, JSON.stringify(newMeta, null, 1));
  const okCount = status.filter(s => s.ok).length;
  console.log(`[daily-sync] 来源 ${okCount}/${status.length} 成功 · 新增 ${fresh.length} 条 · 库内共 ${news.items.length} 条`);
  for (const s of status) console.log(`  - ${s.id}: ${s.ok ? 'OK ' + s.count + ' 条' : 'FAIL ' + (s.code || '') + ' ' + (s.msg || '')}`);
  console.log(`[daily-sync] updatedAt=${newMeta.updatedAt} checkedAt=${newMeta.checkedAt} cde=${newMeta.cde && newMeta.cde.updatedAt || '未记录'}`);
}
main().catch(e => { console.error('[daily-sync] 失败:', e.message); process.exit(1); });
