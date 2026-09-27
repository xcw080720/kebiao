/* 在 Edge 里按手机尺寸预演 APK 界面，逐屏截图，供 read_image 肉眼检查。
   做法：先用 addInitScript 注入一个假的 Native（内存版），这样 Java 桥不在也能跑通全流程。 */
const path = require('path');
const fs = require('fs');

const PW = path.join(process.env.USERPROFILE, '_haidsh_ui', 'node_modules', 'playwright-core');
const { chromium } = require(PW);

function edgePath() {
  const cands = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
  ];
  for (const c of cands) if (fs.existsSync(c)) return c;
  throw new Error('Edge not found');
}

function mondayOf(d) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const wd = x.getDay() === 0 ? 7 : x.getDay();
  x.setDate(x.getDate() - (wd - 1));
  return x;
}
function fmt(d) {
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

const SEED = {
  settings: {
    semesterName: '2026 秋',
    termStart: fmt(mondayOf(new Date())),
    totalWeeks: 20,
    periods: [
      { no: 1, start: '08:00', end: '08:45' }, { no: 2, start: '08:55', end: '09:40' },
      { no: 3, start: '10:00', end: '10:45' }, { no: 4, start: '10:55', end: '11:40' },
      { no: 5, start: '13:30', end: '14:15' }, { no: 6, start: '14:25', end: '15:10' },
      { no: 7, start: '15:30', end: '16:15' }, { no: 8, start: '16:25', end: '17:10' }
    ],
    defaultOffsets: [15, 5],
    remindEnabled: true,
    ai: { baseURL: 'https://api.deepseek.com/v1', apiKey: 'sk-test', model: 'deepseek-chat' }
  },
  courses: [
    { id: 'c1', name: '高等数学A', teacher: '张伟', location: '理科楼302', day: 1, periodFrom: 1, periodTo: 2, weeks: { type: 'range', from: 1, to: 16 }, remindOffsets: [], remindEnabled: true },
    { id: 'c2', name: '大学英语', teacher: '李娜', location: '外语楼205', day: 1, periodFrom: 3, periodTo: 4, weeks: { type: 'range', from: 1, to: 16 }, remindOffsets: [30], remindEnabled: true },
    { id: 'c3', name: '计算机网络', teacher: '王强', location: '信息楼401', day: 2, periodFrom: 3, periodTo: 4, weeks: { type: 'range', from: 1, to: 12 }, remindOffsets: [], remindEnabled: true },
    { id: 'c4', name: '体育（篮球）', teacher: '刘洋', location: '体育馆', day: 3, periodFrom: 5, periodTo: 6, weeks: { type: 'odd', from: 1, to: 16 }, remindOffsets: [], remindEnabled: true },
    { id: 'c5', name: '数据结构与算法', teacher: '赵鹏', location: '信息楼502', day: 5, periodFrom: 3, periodTo: 4, weeks: { type: 'range', from: 1, to: 16 }, remindOffsets: [], remindEnabled: true },
    { id: 'c6', name: '毛泽东思想概论', teacher: '陈静', location: '文科楼108', day: 4, periodFrom: 7, periodTo: 8, weeks: { type: 'even', from: 2, to: 16 }, remindOffsets: [], remindEnabled: true }
  ]
};

const DRAFT_REPLY = {
  termStart: null,
  courses: [
    { name: '高等数学A', teacher: '张伟', location: '理科楼302', day: 1, periodFrom: 1, periodTo: 2, weeks: { type: 'range', from: 1, to: 16 }, note: '' },
    { name: '大学英语', teacher: '李娜', location: '外语楼205', day: 1, periodFrom: 3, periodTo: 4, weeks: { type: 'range', from: 1, to: 16 }, note: '' },
    { name: '计算机网络', teacher: '王强', location: '信息楼401', day: 2, periodFrom: 3, periodTo: 4, weeks: { type: 'range', from: 1, to: 12 }, note: '' }
  ],
  warnings: ['第 4 条没写周次，按全周处理']
};

(async () => {
  const outDir = process.argv[2] || path.join(__dirname, '_shots');
  fs.mkdirSync(outDir, { recursive: true });

  const browser = await chromium.launch({ executablePath: edgePath(), headless: true });
  const ctx = await browser.newContext({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 2 });

  await ctx.addInitScript(`(() => {
    const seed = ${JSON.stringify(SEED)};
    const draft = ${JSON.stringify(DRAFT_REPLY)};
    window.Native = {
      _d: JSON.stringify(seed),
      _n: 0,
      load(){ return this._d; },
      save(s){ this._d = s; },
      reschedule(j){ try { window.__armed = JSON.parse(j); } catch(e) { window.__armed = []; } return window.__armed.length; },
      notifyNow(t,b){ window.__notified = [t,b]; },
      pickFile(){ window.__picked = true; },
      takeShared(){ return ''; },
      ai(req){ const r = JSON.parse(req);
        setTimeout(() => { window.__onAi(JSON.stringify({ id: r.id, ok: true, text: '\\u0060\\u0060\\u0060json\\n' + JSON.stringify(draft) + '\\n\\u0060\\u0060\\u0060' })); }, 60);
      },
      toast(s){ window.__toast = s; },
      info(){ return JSON.stringify({ sdk: 36, device: 'vivo V2520A', version: '1.0', notifGranted: true }); },
      log(s){}, openUrl(u){}
    };
  })()`);

  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()); });

  await page.goto('file:///D:/kebiao/assets/www/index.html', { waitUntil: 'load' });
  await page.waitForTimeout(700);

  await page.screenshot({ path: path.join(outDir, '01-today.png') });

  await page.click('nav button[data-tab="week"]');
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(outDir, '02-week.png') });

  // 打开一门课的编辑弹层
  const cell = await page.$('#grid td.cell[data-oid]');
  if (cell) { await cell.click(); await page.waitForTimeout(300); await page.screenshot({ path: path.join(outDir, '03-course-sheet.png') }); await page.click('#sheetClose'); }

  // 导入：塞样例 -> 出草稿
  await page.click('nav button[data-tab="import"]');
  await page.waitForTimeout(200);
  await page.click('#btnDemo');
  await page.waitForTimeout(1200);
  await page.screenshot({ path: path.join(outDir, '04-import-draft.png') });

  // 设置
  await page.click('nav button[data-tab="set"]');
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(outDir, '05-settings.png') });

  const state = await page.evaluate(() => ({
    armed: (window.__armed || []).length,
    armedFirst: (window.__armed || [])[0] || null,
    tab: document.querySelector('nav button.on') ? document.querySelector('nav button.on').getAttribute('data-tab') : null,
    draftCount: document.querySelectorAll('#draftWrap .draft').length,
    gridCells: document.querySelectorAll('#grid td.cell').length,
    blockCount: document.querySelectorAll('#grid .blk').length,
    scrollW: document.documentElement.scrollWidth,
    innerW: window.innerWidth
  }));

  console.log(JSON.stringify({ errors: errors.slice(0, 20), state }, null, 2));
  await browser.close();
})().catch(e => { console.error('FAILED: ' + (e && e.stack || e)); process.exit(1); });
