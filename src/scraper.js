import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';

const BASE_URL = 'https://rasp.rea.ru';
const GROUP = process.env.GROUP || '15.27Д-БИ01/256';
const OUTPUT_ICS = process.env.OUTPUT || 'public/schedule.ics';
const DEBUG_DIR = 'public/debug';

const TIME_TO_SLOT = {
  '08:30': 1, '10:10': 2, '11:50': 3,
  '14:00': 4, '15:40': 5, '17:20': 6,
};

function hhmm(h, m) { return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`; }

function parseIcsDate(s) {
  const m = s.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/);
  if (!m) return null;
  return { y: +m[1], mo: +m[2], d: +m[3], h: +m[4], mi: +m[5] };
}

function icsUnfold(ics) {
  return ics.replace(/\r?\n[ \t]/g, '');
}

function parseVEvents(ics) {
  const text = icsUnfold(ics);
  const events = [];
  const blocks = text.split(/BEGIN:VEVENT/).slice(1);
  for (const b of blocks) {
    const block = b.split('END:VEVENT')[0];
    const get = re => {
      const m = block.match(re);
      return m ? m[1].trim() : '';
    };
    events.push({
      uid: get(/\nUID:(.+?)\r?\n/),
      dtstart: get(/\nDTSTART:(.+?)\r?\n/),
      dtend: get(/\nDTEND:(.+?)\r?\n/),
      summary: get(/\nSUMMARY:(.+?)\r?\n/),
      location: get(/\nLOCATION:(.+?)\r?\n/),
      description: get(/\nDESCRIPTION:(.+?)\r?\n/),
      rawBlock: block,
    });
  }
  return events;
}

function eventToDetailsKey(ev) {
  const d = parseIcsDate(ev.dtstart);
  if (!d) return null;
  const date = `${String(d.d).padStart(2, '0')}.${String(d.mo).padStart(2, '0')}.${d.y}`;
  const slot = TIME_TO_SLOT[hhmm(d.h, d.mi)];
  return slot ? { date, slot } : null;
}

function decodeHtml(s) {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

function shortenTeacher(full) {
  const clean = decodeHtml(full);
  const parts = clean.trim().split(/\s+/);
  if (parts.length < 2) return clean;
  const [last, first, patronymic] = parts;
  const f = first ? first[0] + '.' : '';
  const p = patronymic ? patronymic[0] + '.' : '';
  return `${last} ${f}${p}`.trim();
}

function extractTeacher(html) {
  const m = html.match(/school<\/i>\s*([А-ЯЁ][А-Яа-яЁё\-\s]+?)\s*<\/a>/);
  if (m) return m[1].trim().replace(/\s+/g, ' ');
  const m2 = html.match(/<a[^>]*\?q=[^"]+"[^>]*>[^<]*school[^<]*<\/i>\s*([^<]+)<\/a>/);
  if (m2) return m2[1].trim();
  return null;
}

function extractDepartment(html) {
  const m = html.match(/\(([^)]*кафедр[^)]*)\)/i) || html.match(/<br\s*\/?>\s*&emsp;&emsp;\s*\(([^)]+)\)/);
  return m ? m[1].trim().replace(/\s+/g, ' ') : null;
}

function cleanSummaryEscaped(raw, groupPrefix) {
  const esc = groupPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return raw.replace(new RegExp(`^${esc}\\s*-\\s*`), '').trim();
}

function icsEscape(s) {
  return s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

function foldLine(line) {
  if (line.length <= 75) return line;
  const out = [];
  let i = 0;
  while (i < line.length) {
    const chunk = i === 0 ? line.slice(0, 75) : ' ' + line.slice(i, i + 74);
    out.push(chunk);
    i += (i === 0 ? 75 : 74);
  }
  return out.join('\r\n');
}

function rebuildIcs(nativeIcs, enrichment, groupPrefix) {
  const text = icsUnfold(nativeIcs);
  const out = [];
  const lines = text.split(/\r?\n/);
  let inEvent = false;
  let cur = {};
  let buf = [];

  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') {
      inEvent = true; cur = {}; buf = [line];
      continue;
    }
    if (line === 'END:VEVENT') {
      const key = cur.uid && enrichment.get(cur.uid);
      const teacher = key?.teacher || null;
      const dept = key?.department || null;
      const newBuf = [];
      for (const L of buf) {
        if (L.startsWith('SUMMARY:')) {
          // SUMMARY value is plain (no ICS escapes in native export usually)
          const cleanedPlain = cleanSummaryEscaped(L.slice(8), groupPrefix);
          const summary = teacher ? `${cleanedPlain} · ${shortenTeacher(teacher)}` : cleanedPlain;
          newBuf.push(foldLine('SUMMARY:' + icsEscape(summary)));
        } else if (L.startsWith('DESCRIPTION:')) {
          // DESCRIPTION in native ICS is already escaped — keep as is, append teacher/dept as escaped chunks
          const originalEscaped = cleanSummaryEscaped(L.slice(12), groupPrefix);
          const additions = [];
          if (teacher) additions.push(icsEscape('Преподаватель: ' + decodeHtml(teacher)));
          if (dept) additions.push(icsEscape('Кафедра: ' + decodeHtml(dept)));
          const desc = [originalEscaped, ...additions].filter(Boolean).join('\\n');
          newBuf.push(foldLine('DESCRIPTION:' + desc));
        } else {
          newBuf.push(L);
        }
      }
      newBuf.push('END:VEVENT');
      out.push(...newBuf);
      inEvent = false;
      continue;
    }
    if (inEvent) {
      buf.push(line);
      const kv = line.match(/^([A-Z-]+):(.*)$/);
      if (kv) {
        const key = kv[1].toLowerCase();
        const val = kv[2];
        if (key === 'uid') cur.uid = val;
      }
    } else {
      out.push(line);
    }
  }
  return out.join('\r\n');
}

async function exportNativeIcs(page) {
  console.log('[export] Opening modal and downloading ICS...');
  await page.evaluate(() => window.jQuery && window.jQuery('#modal-export-dlg').modal('show'));
  await page.waitForTimeout(1000);
  await page.evaluate(() => {
    const radio = document.querySelector('input.export-range[value="all"]');
    if (radio) {
      radio.checked = true;
      const lbl = radio.closest('label');
      if (lbl) {
        document.querySelectorAll('.btn-export-range').forEach(l => l.classList.remove('active'));
        lbl.classList.add('active');
      }
      radio.dispatchEvent(new Event('change', { bubbles: true }));
      radio.dispatchEvent(new Event('click', { bubbles: true }));
    }
  });
  await page.waitForTimeout(500);
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 30000 }),
    page.click('#calexport'),
  ]);
  const tmp = path.join(DEBUG_DIR, 'native.ics');
  await download.saveAs(tmp);
  const content = await fs.readFile(tmp, 'utf8');
  console.log(`[export] got native ICS: ${content.length} bytes`);
  await page.evaluate(() => window.jQuery && window.jQuery('#modal-export-dlg').modal('hide')).catch(() => {});
  await page.waitForTimeout(400);
  return content;
}

async function fetchDetails(page, selection, date, slot) {
  return await page.evaluate(async ({ sel, d, t }) => {
    const url = `/Schedule/GetDetails?selection=${encodeURIComponent(sel)}&date=${d}&timeSlot=${t}`;
    const r = await fetch(url, { headers: { 'X-Requested-With': 'XMLHttpRequest', 'Accept': 'text/html, */*; q=0.01' } });
    return { status: r.status, text: await r.text() };
  }, { sel: selection, d: date, t: String(slot) });
}

async function enrichEvents(page, events, groupLower) {
  const cache = new Map();
  const keyOf = ev => {
    const k = eventToDetailsKey(ev);
    if (!k) return null;
    const sumKey = ev.summary.split(' - ').slice(-1)[0];
    return `${sumKey}::${k.slot}::${new Date(`${k.date.split('.').reverse().join('-')}T00:00:00`).getDay()}`;
  };

  const uniquePairs = new Map();
  for (const ev of events) {
    const k = eventToDetailsKey(ev);
    const cKey = keyOf(ev);
    if (!k || !cKey) continue;
    if (!uniquePairs.has(cKey)) uniquePairs.set(cKey, { ...k, summary: ev.summary, examples: [] });
    uniquePairs.get(cKey).examples.push(ev.uid);
  }
  console.log(`[enrich] ${events.length} events, ${uniquePairs.size} unique (subject × slot × weekday) combinations`);

  const enrichment = new Map();
  let done = 0, fail = 0;
  for (const [cKey, info] of uniquePairs) {
    const { date, slot } = info;
    try {
      const { status, text } = await fetchDetails(page, groupLower, date, slot);
      if (status !== 200) { fail++; continue; }
      const teacher = extractTeacher(text);
      const department = extractDepartment(text);
      if (teacher) {
        for (const uid of info.examples) {
          enrichment.set(uid, { teacher, department });
        }
        done++;
      } else {
        fail++;
      }
    } catch (e) {
      console.warn(`[enrich] failed ${date}/${slot}: ${e.message}`);
      fail++;
    }
  }
  console.log(`[enrich] teachers found for ${done}/${uniquePairs.size} combos, ${fail} without teacher`);
  console.log(`[enrich] enriched ${enrichment.size} events`);
  return enrichment;
}

export async function exportIcs() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    locale: 'ru-RU', timezoneId: 'Europe/Moscow',
    viewport: { width: 1440, height: 900 }, acceptDownloads: true,
  });
  const page = await context.newPage();
  await fs.mkdir(DEBUG_DIR, { recursive: true });
  await fs.mkdir(path.dirname(OUTPUT_ICS), { recursive: true });

  console.log(`[scraper] Opening ${BASE_URL}`);
  await page.goto(BASE_URL, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);

  console.log(`[scraper] Filling group: ${GROUP}`);
  const search = page.locator('#search');
  await search.waitFor({ state: 'visible', timeout: 15000 });
  await search.click();
  await search.fill('');
  await search.type(GROUP, { delay: 35 });
  await page.waitForTimeout(1000);
  await search.press('Enter');

  await page.waitForFunction(() => /ПОНЕДЕЛЬНИК|ВТОРНИК|СРЕДА|ЧЕТВЕРГ|ПЯТНИЦА|СУББОТА/i.test(document.body.innerText), { timeout: 25000 });
  console.log('[scraper] Schedule rendered ✓');

  const nativeIcs = await exportNativeIcs(page);
  const events = parseVEvents(nativeIcs);
  console.log(`[scraper] Parsed ${events.length} events from native ICS`);

  const enrichment = await enrichEvents(page, events, GROUP.toLowerCase());

  const enriched = rebuildIcs(nativeIcs, enrichment, GROUP);
  await fs.writeFile(OUTPUT_ICS, enriched, 'utf8');
  const stat = await fs.stat(OUTPUT_ICS);
  console.log(`[scraper] ✓ Saved ${OUTPUT_ICS} (${stat.size} bytes)`);

  await browser.close();
  return { outputPath: OUTPUT_ICS, size: stat.size, events: events.length, enriched: enrichment.size };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  exportIcs().then(r => console.log('DONE:', r)).catch(e => { console.error(e); process.exit(1); });
}
