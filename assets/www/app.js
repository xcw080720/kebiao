/* 课表 · 界面逻辑
   设计约束：零常驻动画。倒计时用 1 秒一次的纯文本更新，没有 CSS 动画。 */
(function () {
'use strict';

/* ============================ Native 桥 ============================ */
const Native = (function () {
  if (window.Native && window.Native.load) return window.Native;
  const stub = {
    load: function () { return localStorage.getItem('kebiao_data') || ''; },
    save: function (s) { localStorage.setItem('kebiao_data', s); },
    reschedule: function () { return 0; },
    notifyNow: function (t, b) { alert(t + '\n\n' + b); },
    pickFile: function () { toast('桌面预览版不能选文件，用「粘贴文字」试试'); },
    takeShared: function () { return ''; },
    ai: function (req) {
      const id = (JSON.parse(req) || {}).id;
      setTimeout(function () {
        if (window.__onAi) window.__onAi(JSON.stringify({ id: id, ok: false, error: '桌面预览版不走网络' }));
      }, 300);
    },
    toast: function (s) { toast(s); },
    info: function () { return JSON.stringify({ sdk: 0, device: '预览', version: 'preview', notifGranted: true }); },
    log: function (s) { try { console.log(s); } catch (e) {} },
    openUrl: function (u) { window.open(u); }
  };
  window.Native = stub;
  return stub;
})();

/* ============================ 常量 ============================ */
const DAYS = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const PALETTE = ['#3E7BFA', '#0E9AA7', '#E4572E', '#7D5BA6', '#2E9E5B', '#C2185B', '#0277BD', '#8D6E63', '#5C6BC0', '#00897B'];

const SYS_PROMPT = [
  '你是一个课表信息抽取助手。用户会给你一段课表文字、一张课表截图、或一份课表表格，你要把它整理成结构化 JSON。',
  '只输出一个 JSON 对象，不要解释，不要 Markdown 代码块。',
  '',
  '输出格式：',
  '{',
  '  "termStart": "YYYY-MM-DD 或 null（只有材料里明确写了第1周的日期才填，否则 null）",',
  '  "courses": [',
  '    {',
  '      "name": "课程名",',
  '      "teacher": "任课老师，没有就空字符串",',
  '      "location": "上课地点，没有就空字符串",',
  '      "day": 1,',
  '      "periodFrom": 1,',
  '      "periodTo": 2,',
  '      "weeks": { "type": "range", "from": 1, "to": 16 },',
  '      "note": "其它备注，没有就空字符串"',
  '    }',
  '  ],',
  '  "warnings": ["拿不准、或材料里缺的信息，写在这里"]',
  '}',
  '',
  '规则：',
  '1. 绝对不要编造。材料里没有的信息留空字符串或 null。',
  '2. day 用数字：周一=1、周二=2、……、周日=7。',
  '3. periodFrom/periodTo 是节次编号，比如「3-4节」就是 from=3, to=4。',
  '4. weeks.type 只能是这五种：',
  '   - "all"   全周都上（信息里没说周次时用这个，并在 warnings 里说明）',
  '   - "range" 连续周次，配 from/to，如 1-16 周',
  '   - "odd"   单周，配 from/to',
  '   - "even"  双周，配 from/to',
  '   - "list"  不连续，配 "list": [1,3,5,7]',
  '5. 同一门课有多个时间段（不同星期/不同节次/不同周次），就拆成多条记录。',
  '6. 如果材料是聊天记录，忽略打招呼、闲聊、表情，只取课程信息。',
  '7. 如果材料里有多门课名字相同但老师/地点不同，也要分开列。',
  '8. 输出必须是合法 JSON，字符串用双引号。'
].join('\n');

const STUB_PROMPT_HINT = '\n\n请把上面的课表截图/文字整理成 JSON。';

/* ============================ 状态 ============================ */
let S = null;
let courses = [];
const ui = { tab: 'today', week: 0, draft: null, sheet: null, busy: false, editingId: null };

function defaults() {
  return {
    semesterName: '',
    termStart: '',
    totalWeeks: 20,
    periods: [
      { no: 1, start: '08:00', end: '08:45' },
      { no: 2, start: '08:55', end: '09:40' },
      { no: 3, start: '10:00', end: '10:45' },
      { no: 4, start: '10:55', end: '11:40' },
      { no: 5, start: '13:30', end: '14:15' },
      { no: 6, start: '14:25', end: '15:10' },
      { no: 7, start: '15:30', end: '16:15' },
      { no: 8, start: '16:25', end: '17:10' },
      { no: 9, start: '18:30', end: '19:15' },
      { no: 10, start: '19:25', end: '20:10' }
    ],
    defaultOffsets: [15],
    remindEnabled: true,
    ai: { baseURL: 'https://api.deepseek.com/v1', apiKey: '', model: 'deepseek-chat' }
  };
}

/* ============================ 工具 ============================ */
const $ = function (id) { return document.getElementById(id); };
function esc(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function pad2(n) { return String(n).padStart(2, '0'); }
function fmtDate(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
function parseD(v) {
  if (!v) return null;
  const m = String(v).trim().match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}
function mondayOf(d) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const wd = x.getDay() === 0 ? 7 : x.getDay();
  x.setDate(x.getDate() - (wd - 1));
  return x;
}
function addDays(d, n) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() + n);
  return x;
}
function todayDow() { const d = new Date().getDay(); return d === 0 ? 7 : d; }
function hm2min(s) {
  const m = String(s || '').match(/^(\d{1,2})\s*[:：]\s*(\d{1,2})/);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}
function min2hm(v) { return pad2(Math.floor(v / 60)) + ':' + pad2(v % 60); }
function toast(s) {
  const el = document.createElement('div');
  el.className = 'note';
  el.style.cssText = 'position:fixed;left:14px;right:14px;bottom:76px;z-index:99;text-align:center';
  el.textContent = s;
  document.body.appendChild(el);
  setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 2200);
}
function hash(s) { let h = 0; s = String(s); for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h); }
function colorOf(c) { return c.color || PALETTE[hash(c.name || 'x') % PALETTE.length]; }

/* ============================ 课表算法 ============================ */
function nowWeek() {
  const t = parseD(S.termStart);
  if (!t) return null;
  const diff = Math.round((mondayOf(new Date()) - mondayOf(t)) / 86400000);
  return Math.floor(diff / 7) + 1;
}
function periodOf(no) {
  for (let i = 0; i < S.periods.length; i++) if (Number(S.periods[i].no) === Number(no)) return S.periods[i];
  return null;
}
function occursInWeek(c, w) {
  const wk = c.weeks || { type: 'all' };
  const t = wk.type || 'all';
  const from = Number(wk.from || 1), to = Number(wk.to || 999);
  if (t === 'all') return w >= 1;
  if (t === 'odd') return w % 2 === 1 && w >= from && w <= to;
  if (t === 'even') return w % 2 === 0 && w >= from && w <= to;
  if (t === 'list') return (wk.list || []).map(Number).indexOf(w) >= 0;
  return w >= from && w <= to;
}
function occOf(c, w) {
  const base = parseD(S.termStart);
  if (!base) return null;
  const date = addDays(mondayOf(base), (w - 1) * 7 + (Number(c.day) - 1));
  const p1 = periodOf(c.periodFrom), p2 = periodOf(c.periodTo || c.periodFrom);
  if (!p1 || !p2) return null;
  const sMin = hm2min(p1.start), eMin = hm2min(p2.end);
  if (sMin === null || eMin === null) return null;
  const st = new Date(date.getFullYear(), date.getMonth(), date.getDate(), Math.floor(sMin / 60), sMin % 60, 0, 0);
  const en = new Date(date.getFullYear(), date.getMonth(), date.getDate(), Math.floor(eMin / 60), eMin % 60, 0, 0);
  return {
    course: c, courseId: c.id, name: c.name, teacher: c.teacher || '', location: c.location || '',
    day: Number(c.day), dayName: DAYS[Number(c.day)] || '', periodFrom: Number(c.periodFrom),
    periodTo: Number(c.periodTo || c.periodFrom), week: w, date: fmtDate(date),
    startHM: min2hm(sMin), endHM: min2hm(eMin), startLocal: st.getTime(), endLocal: en.getTime()
  };
}
function occForWeek(w) {
  const out = [];
  for (let i = 0; i < courses.length; i++) {
    const c = courses[i];
    if (c.enabled === false) continue;
    if (!occursInWeek(c, w)) continue;
    const o = occOf(c, w);
    if (o) out.push(o);
  }
  out.sort(function (a, b) { return a.startLocal - b.startLocal; });
  return out;
}
function upcoming(n) {
  const cw = nowWeek();
  if (cw === null || cw < 1) return [];
  const out = [], now = Date.now();
  for (let w = cw; w <= cw + 5 && out.length < n; w++) {
    const list = occForWeek(w);
    for (let i = 0; i < list.length; i++) {
      if (list[i].endLocal > now) out.push(list[i]);
      if (out.length >= n) break;
    }
  }
  return out.slice(0, n);
}
function offsetsOf(c) {
  if (c.remindEnabled === false) return [];
  if (c.remindOffsets && c.remindOffsets.length) return c.remindOffsets;
  return S.defaultOffsets || [];
}
function weeksText(c) {
  const wk = c.weeks || { type: 'all' };
  if (wk.type === 'all') return '每周';
  if (wk.type === 'odd') return wk.from + '-' + wk.to + ' 周(单)';
  if (wk.type === 'even') return wk.from + '-' + wk.to + ' 周(双)';
  if (wk.type === 'list') return (wk.list || []).join(',') + ' 周';
  return wk.from + '-' + wk.to + ' 周';
}

/* ============================ 存取 ============================ */
function persist() {
  Native.save(JSON.stringify({ settings: S, courses: courses }));
}
function boot() {
  let loaded = null;
  try { const raw = Native.load(); if (raw) loaded = JSON.parse(raw); } catch (e) { loaded = null; }
  S = defaults();
  if (loaded && loaded.settings) {
    const d = defaults();
    const s = loaded.settings;
    for (const k in d) if (!(k in s)) s[k] = d[k];
    if (!s.ai) s.ai = d.ai;
    if (!Array.isArray(s.periods) || !s.periods.length) s.periods = d.periods;
    if (!Array.isArray(s.defaultOffsets)) s.defaultOffsets = d.defaultOffsets;
    S = s;
  }
  courses = (loaded && Array.isArray(loaded.courses)) ? loaded.courses : [];
  if (!S.termStart) {
    S.termStart = fmtDate(mondayOf(new Date()));
    persist();
  }
  const cw = nowWeek();
  ui.week = (cw && cw >= 1) ? cw : 1;
}

/* ============================ 提醒落地 ============================ */
function armReminders() {
  if (!S.remindEnabled || !S.termStart) { try { Native.reschedule('[]'); } catch (e) {} return 0; }
  const cw = nowWeek();
  if (cw === null || cw < 1) return 0;
  const now = Date.now();
  const horizon = now + 14 * 86400000;
  const list = [];
  for (let w = cw; w <= cw + 3; w++) {
    for (let i = 0; i < courses.length; i++) {
      const c = courses[i];
      if (c.enabled === false) continue;
      if (!occursInWeek(c, w)) continue;
      const o = occOf(c, w);
      if (!o) continue;
      const offs = offsetsOf(c);
      for (let k = 0; k < offs.length; k++) {
        const off = Number(offs[k]);
        const at = o.startLocal - off * 60000;
        if (at < now + 30000 || at > horizon) continue;
        list.push({
          key: c.id + '|' + o.date + '|' + off,
          at: at,
          title: (off > 0 ? '还有 ' + off + ' 分钟上课 · ' : '现在上课 · ') + o.name,
          body: o.dayName + ' 第' + o.periodFrom + '-' + o.periodTo + '节  ' + o.startHM + '-' + o.endHM +
                (o.location ? '\n地点：' + o.location : '') + (o.teacher ? '\n老师：' + o.teacher : '')
        });
      }
    }
  }
  list.sort(function (a, b) { return a.at - b.at; });
  try { Native.reschedule(JSON.stringify(list)); } catch (e) {}
  return list.length;
}

/* ============================ 渲染：头 ============================ */
function renderHeader() {
  const cw = nowWeek();
  $('hWeek').textContent = (cw && cw >= 1) ? ('第 ' + cw + ' 周') : '未开学';
  const d = new Date();
  let sub = (S.semesterName ? S.semesterName + ' · ' : '') +
    (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + DAYS[todayDow()];
  $('hSub').textContent = sub;
}

/* ============================ 渲染：今天 ============================ */
let cdTimer = null;
function renderToday() {
  const list = upcoming(6);
  const now = Date.now();
  const todayStr = fmtDate(new Date());
  const wrap = $('nextWrap');

  const next = list.filter(function (o) { return o.endLocal > now; })[0];
  if (!courses.length) {
    // 空课表：给一条能走通的路（以前这里只有一句"课表还空着"，而唯一的加课入口要过 AI）
    wrap.innerHTML =
      '<div class="card">' +
        '<div style="font-size:16px;font-weight:600;margin-bottom:6px">课表还是空的</div>' +
        '<div class="muted" style="margin-bottom:12px">可以一门一门手动加，也可以让 AI 从截图 / 表格 / 文档里读出来。</div>' +
        '<div class="two">' +
          '<button class="btn" id="emptyAdd">手动加一门课</button>' +
          '<button class="btn ghost" id="emptyImport">去导入</button>' +
        '</div>' +
      '</div>';
    $('emptyAdd').onclick = function () { openCourse(null); };
    $('emptyImport').onclick = function () { ui.tab = 'import'; renderAll(); };
    if (cdTimer) { clearInterval(cdTimer); cdTimer = null; }
  } else if (next) {
    const going = now >= next.startLocal && now <= next.endLocal;
    wrap.innerHTML =
      '<div class="card next' + (going ? ' going' : '') + '">' +
        '<div class="row between"><span class="muted">' + (going ? '正在上课' : '下一节课') + '</span>' +
        '<span class="muted">' + esc(next.dayName) + ' ' + esc(next.date) + '</span></div>' +
        '<div class="cd" id="cd">--:--</div>' +
        '<div style="font-size:17px;font-weight:600;margin-top:2px">' + esc(next.name) + '</div>' +
        '<div class="muted" style="margin-top:4px">第 ' + next.periodFrom + '-' + next.periodTo + ' 节 · ' +
          next.startHM + '-' + next.endHM + (next.location ? ' · ' + esc(next.location) : '') +
          (next.teacher ? ' · ' + esc(next.teacher) : '') + '</div>' +
      '</div>';
    tickCountdown(next);
    if (cdTimer) clearInterval(cdTimer);
    cdTimer = setInterval(function () { tickCountdown(next); }, 1000);
  } else {
    wrap.innerHTML = '<div class="card"><div class="muted">接下来这几天没有课（或者课表还空着）。</div></div>';
    if (cdTimer) { clearInterval(cdTimer); cdTimer = null; }
  }

  // 今天
  const tl = $('todayList');
  const todayList = list.filter(function (o) { return o.date === todayStr; });
  if (!todayList.length) {
    tl.innerHTML = '<div class="card tight"><span class="muted">今天没课。</span></div>';
  } else {
    tl.innerHTML = todayList.map(function (o) {
      const dim = o.endLocal < now ? ' dim' : '';
      return '<div class="lesson' + dim + '" data-oid="' + esc(o.courseId) + '">' +
        '<div class="bar" style="background:' + colorOf(o.course) + '"></div>' +
        '<div class="t">' + o.startHM + '<br>' + o.endHM + '</div>' +
        '<div class="spacer"><div class="n">' + esc(o.name) + '</div>' +
        '<div class="muted">第' + o.periodFrom + '-' + o.periodTo + '节' +
        (o.location ? ' · ' + esc(o.location) : '') + (o.teacher ? ' · ' + esc(o.teacher) : '') + '</div></div>' +
        '</div>';
    }).join('');
  }

  // 接下来（不含今天）
  const up = list.filter(function (o) { return o.date !== todayStr; }).slice(0, 4);
  $('upcomingList').innerHTML = up.length ? up.map(function (o) {
    return '<div class="lesson" data-oid="' + esc(o.courseId) + '">' +
      '<div class="bar" style="background:' + colorOf(o.course) + '"></div>' +
      '<div class="t">' + esc(o.dayName) + '<br>' + o.startHM + '</div>' +
      '<div class="spacer"><div class="n">' + esc(o.name) + '</div>' +
      '<div class="muted">第' + o.periodFrom + '-' + o.periodTo + '节' +
      (o.location ? ' · ' + esc(o.location) : '') + '</div></div></div>';
  }).join('') : '<div class="card tight"><span class="muted">往后 4 周没有别的课。</span></div>';
}

function tickCountdown(o) {
  const el = $('cd');
  if (!el) return;
  const now = Date.now();
  let diff;
  if (now < o.startLocal) diff = o.startLocal - now;
  else if (now <= o.endLocal) diff = o.endLocal - now;
  else { el.textContent = '已结束'; return; }
  const s = Math.floor(diff / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  el.textContent = (h > 0 ? h + ' 小时 ' : '') + (h > 0 ? pad2(m) : m) + ' 分 ' + pad2(ss) + ' 秒';
}

/* ============================ 渲染：周 ============================ */
function renderWeek() {
  const cw = nowWeek();
  $('wLabel').textContent = '第 ' + ui.week + ' 周' + (cw === ui.week ? '（本周）' : '');
  const list = occForWeek(ui.week);

  let maxP = 8;
  for (let i = 0; i < list.length; i++) maxP = Math.max(maxP, list[i].periodTo);
  const periods = [];
  for (let p = 1; p <= maxP; p++) periods.push(p);

  // 每格：先放课
  const cellMap = {};
  const covered = {};
  for (let i = 0; i < list.length; i++) {
    const o = list[i];
    for (let p = o.periodFrom; p <= o.periodTo; p++) {
      cellMap[o.day + '_' + p] = o;
      if (p !== o.periodFrom) covered[o.day + '_' + p] = true;
    }
  }

  const todayDowNow = todayDow();
  let html = '<table class="grid"><tr><th style="width:34px">节</th>';
  for (let d = 1; d <= 7; d++) {
    html += '<th class="' + (d === todayDowNow && ui.week === cw ? 'today' : '') + '">' + DAYS[d].slice(1) + '</th>';
  }
  html += '</tr>';

  for (let pi = 0; pi < periods.length; pi++) {
    const p = periods[pi];
    const per = periodOf(p);
    html += '<tr><td class="slot"><b>' + p + '</b>' + (per ? esc(per.start) : '') + '</td>';
    for (let d = 1; d <= 7; d++) {
      if (covered[d + '_' + p]) continue;
      const o = cellMap[d + '_' + p];
      if (!o) { html += '<td class="cell empty"></td>'; continue; }
      const span = o.periodTo - o.periodFrom + 1;
      html += '<td class="cell" rowspan="' + span + '" data-oid="' + esc(o.courseId) + '">' +
        '<span class="blk" style="background:' + colorOf(o.course) + '">' + esc(o.name) + '</span></td>';
    }
    html += '</tr>';
  }
  html += '</table>';
  $('grid').innerHTML = html;
}

/* ============================ 渲染：设置 ============================ */
function renderSettings() {
  $('sBase').value = S.ai.baseURL || '';
  $('sKey').value = S.ai.apiKey || '';
  $('sModel').value = S.ai.model || '';
  $('sTerm').value = S.termStart || '';
  $('sWeeks').value = S.totalWeeks || 20;
  $('sTermName').value = S.semesterName || '';
  $('sOffsets').value = (S.defaultOffsets || []).join(',');
  $('sRemindOn').checked = S.remindEnabled !== false;
  $('dCount').textContent = courses.length + ' 门';
  try {
    const inf = JSON.parse(Native.info() || '{}');
    $('dDev').textContent = (inf.device || '—') + ' / Android ' + (inf.sdk || '?');
    $('dNotif').textContent = inf.notifGranted ? '已允许' : '被关掉了（去系统设置里开）';
  } catch (e) {}
  renderPeriods();
}

function renderPeriods() {
  const box = $('periodBox');
  box.innerHTML = S.periods.map(function (p, i) {
    return '<div class="period-row">' +
      '<span class="no">第' + p.no + '节</span>' +
      '<input type="time" data-pi="' + i + '" data-k="start" value="' + esc(p.start) + '">' +
      '<span class="muted">—</span>' +
      '<input type="time" data-pi="' + i + '" data-k="end" value="' + esc(p.end) + '">' +
      '</div>';
  }).join('') +
  '<div class="two" style="margin-top:6px">' +
    '<button class="btn ghost sm" id="pAdd">加一节</button>' +
    '<button class="btn ghost sm" id="pDel">删末节</button>' +
  '</div>';
  const add = $('pAdd'); if (add) add.onclick = function () {
    const last = S.periods[S.periods.length - 1] || { no: 0, start: '20:00', end: '20:45' };
    const s = hm2min(last.end) || 1200;
    S.periods.push({ no: last.no + 1, start: min2hm(s + 10), end: min2hm(s + 55) });
    persist(); renderPeriods();
  };
  const del = $('pDel'); if (del) del.onclick = function () {
    if (S.periods.length <= 1) return;
    S.periods.pop(); persist(); renderPeriods(); renderWeek();
  };
}

/* ============================ 弹层 ============================ */
function closeSheet() {
  $('sheetHost').innerHTML = '';
  ui.sheet = null;
  ui.editingId = null;
  ui.pendingOcc = null;
}
function openSheet(title, bodyHtml, after) {
  ui.sheet = title;
  $('sheetHost').innerHTML =
    '<div class="sheet" id="sheetMask"><div class="panel">' +
      '<h2>' + esc(title) + '</h2>' + bodyHtml +
      '<button class="btn ghost block" id="sheetClose" style="margin-top:12px">关闭</button>' +
    '</div></div>';
  $('sheetClose').onclick = closeSheet;
  const mask = $('sheetMask');
  mask.onclick = function (e) { if (e.target === mask) closeSheet(); };
  if (after) after();
}

window.__back = function () {
  if (ui.sheet) { closeSheet(); return true; }
  return false;
};

/* ============================ 课程编辑 ============================ */
/** 新建课程时的空白模板：星期默认今天，周次默认整个学期 */
function blankCourse() {
  return {
    id: null, name: '', teacher: '', location: '',
    day: todayDow(), periodFrom: 1, periodTo: 2,
    weeks: { type: 'range', from: 1, to: S.totalWeeks || 16, list: [] },
    remindOffsets: [], remindEnabled: true, color: null
  };
}

function openCourse(courseId) {
  const isNew = !courseId;
  const c = isNew
    ? blankCourse()
    : courses.filter(function (x) { return x.id === courseId; })[0];
  if (!c) return;
  ui.editingId = courseId || null;
  const wk = c.weeks || { type: 'range', from: 1, to: 16 };
  const body =
    '<div class="field"><label class="f">课程名</label><input id="cName" value="' + esc(c.name) + '"></div>' +
    '<div class="two"><div class="field"><label class="f">老师</label><input id="cTeacher" value="' + esc(c.teacher || '') + '"></div>' +
    '<div class="field"><label class="f">地点</label><input id="cLoc" value="' + esc(c.location || '') + '"></div></div>' +
    '<div class="three">' +
      '<div class="field"><label class="f">星期</label><select id="cDay">' +
        [1,2,3,4,5,6,7].map(function (d) { return '<option value="' + d + '"' + (Number(c.day) === d ? ' selected' : '') + '>' + DAYS[d] + '</option>'; }).join('') +
      '</select></div>' +
      '<div class="field"><label class="f">起始节</label><input id="cFrom" type="number" min="1" value="' + c.periodFrom + '"></div>' +
      '<div class="field"><label class="f">结束节</label><input id="cTo" type="number" min="1" value="' + (c.periodTo || c.periodFrom) + '"></div>' +
    '</div>' +
    '<div class="field"><label class="f">周次类型</label><select id="cWType">' +
      ['range:连续周次', 'odd:单周', 'even:双周', 'list:不连续', 'all:全周'].map(function (o) {
        const v = o.split(':')[0];
        return '<option value="' + v + '"' + ((wk.type || 'range') === v ? ' selected' : '') + '>' + o.split(':')[1] + '</option>';
      }).join('') +
    '</select></div>' +
    '<div class="two"><div class="field"><label class="f">从第几周</label><input id="cWFrom" type="number" min="1" value="' + (wk.from || 1) + '"></div>' +
    '<div class="field"><label class="f">到第几周</label><input id="cWTo" type="number" min="1" value="' + (wk.to || 16) + '"></div></div>' +
    '<div class="field"><label class="f">不连续周次（逗号分隔，如 1,3,5,7）</label><input id="cWList" value="' + esc((wk.list || []).join(',')) + '"></div>' +
    '<div class="field"><label class="f">提醒提前量（分钟，逗号分隔；留空用默认；填 -1 关掉这门课提醒）</label>' +
      '<input id="cOff" value="' + esc((c.remindOffsets || []).join(',')) + '"></div>' +
    '<div class="two" style="margin-top:4px">' +
      '<button class="btn" id="cSave">' + (isNew ? '加进课表' : '保存') + '</button>' +
      '<button class="btn danger" id="cDel">删除</button>' +
    '</div>';
  openSheet(isNew ? '新建课程' : '编辑课程', body, function () {
    $('cWType').onchange = function () {
      const t = this.value;
      $('cWFrom').disabled = (t === 'all' || t === 'list');
      $('cWTo').disabled = (t === 'all' || t === 'list');
      $('cWList').disabled = (t !== 'list');
    };
    $('cWType').onchange();
    $('cSave').onclick = function () {
      c.name = $('cName').value.trim() || '未命名';
      c.teacher = $('cTeacher').value.trim();
      c.location = $('cLoc').value.trim();
      c.day = Number($('cDay').value);
      c.periodFrom = Math.max(1, Number($('cFrom').value) || 1);
      c.periodTo = Math.max(c.periodFrom, Number($('cTo').value) || c.periodFrom);
      const t = $('cWType').value;
      c.weeks = { type: t, from: Number($('cWFrom').value) || 1, to: Number($('cWTo').value) || 16, list: [] };
      if (t === 'list') {
        c.weeks.list = $('cWList').value.split(/[,，\s]+/).map(Number).filter(function (n) { return n > 0; });
      }
      const raw = $('cOff').value.trim();
      if (raw === '') c.remindOffsets = [];
      else if (raw === '-1') { c.remindEnabled = false; c.remindOffsets = []; }
      else { c.remindEnabled = true; c.remindOffsets = raw.split(/[,，\s]+/).map(Number).filter(function (n) { return n >= 0; }); }
      if (isNew) {
        c.id = 'c' + Date.now().toString(36) + Math.floor(Math.random() * 1000).toString(36);
        courses.push(c);
      }
      persist(); armReminders(); closeSheet(); renderAll();
      toast(isNew ? '已加进课表' : '已保存');
    };
    if (isNew) $('cDel').style.display = 'none';
    $('cDel').onclick = function () {
      courses = courses.filter(function (x) { return x.id !== c.id; });
      persist(); armReminders(); closeSheet(); renderAll(); toast('已删除');
    };
  });
}

/* ============================ 渲染总入口 ============================ */
function renderAll() {
  renderHeader();
  renderToday();
  renderWeek();
  renderSettings();
  $('p-today').className = 'page' + (ui.tab === 'today' ? ' on' : '');
  $('p-week').className = 'page' + (ui.tab === 'week' ? ' on' : '');
  $('p-import').className = 'page' + (ui.tab === 'import' ? ' on' : '');
  $('p-set').className = 'page' + (ui.tab === 'set' ? ' on' : '');
  const bs = document.querySelectorAll('nav button');
  for (let i = 0; i < bs.length; i++) bs[i].className = (bs[i].getAttribute('data-tab') === ui.tab ? 'on' : '');
}

/* ============================ AI ============================ */
let aiSeq = 0;
const aiPending = {};
window.__onAi = function (json) {
  let o = null;
  try { o = JSON.parse(json); } catch (e) { return; }
  const p = aiPending[o.id];
  if (p) { delete aiPending[o.id]; p(o); }
};
function callAi(req) {
  return new Promise(function (resolve) {
    const id = 'a' + (++aiSeq);
    req.id = id;
    aiPending[id] = resolve;
    try { Native.ai(JSON.stringify(req)); } catch (e) { resolve({ ok: false, error: String(e) }); return; }
    setTimeout(function () {
      if (aiPending[id]) { delete aiPending[id]; resolve({ ok: false, error: '等太久没回应（3 分钟），检查网络或接口地址' }); }
    }, 180000);
  });
}
function extractJson(text) {
  if (!text) return null;
  let t = String(text).trim();
  t = t.replace(/^```[a-zA-Z]*\s*/, '').replace(/```\s*$/, '').trim();
  const i = t.indexOf('{'), j = t.lastIndexOf('}');
  if (i < 0 || j <= i) return null;
  const slice = t.slice(i, j + 1);
  try { return JSON.parse(slice); } catch (e) {}
  try { return JSON.parse(slice.replace(/,\s*([}\]])/g, '$1')); } catch (e) {}
  return null;
}

function setImpStatus(kind, text) {
  $('impStatus').innerHTML = text ? '<div class="note ' + kind + '">' + esc(text) + '</div>' : '';
}

/* ============================ 草稿 ============================ */
function normalizeDraft(obj) {
  const out = { termStart: null, courses: [], warnings: [] };
  if (!obj) return out;
  if (typeof obj.termStart === 'string' && /^\d{4}-\d{2}-\d{2}/.test(obj.termStart)) out.termStart = obj.termStart.slice(0, 10);
  if (Array.isArray(obj.warnings)) out.warnings = obj.warnings.map(String);
  const arr = Array.isArray(obj.courses) ? obj.courses : (Array.isArray(obj.list) ? obj.list : []);
  for (let i = 0; i < arr.length; i++) {
    const c = arr[i] || {};
    if (!c.name) continue;
    let from = Number(c.periodFrom), to = Number(c.periodTo);
    if (!(from >= 1)) from = 1;
    if (!(to >= from)) to = from;
    const wk = c.weeks || {};
    const row = {
      name: String(c.name).trim(),
      teacher: String(c.teacher || '').trim(),
      location: String(c.location || '').trim(),
      day: Math.min(7, Math.max(1, Number(c.day) || 1)),
      periodFrom: Math.min(20, from),
      periodTo: Math.min(20, to),
      weeks: {
        type: ['all', 'range', 'odd', 'even', 'list'].indexOf(wk.type) >= 0 ? wk.type : 'range',
        from: Number(wk.from) || 1,
        to: Number(wk.to) || 16,
        list: Array.isArray(wk.list) ? wk.list.map(Number) : []
      },
      note: String(c.note || '').trim()
    };
    out.courses.push(row);
  }
  return out;
}

function renderDraft() {
  const wrap = $('draftWrap');
  const d = ui.draft;
  if (!d) { wrap.innerHTML = ''; return; }
  if (!d.courses.length) {
    wrap.innerHTML = '<div class="note warn">没抽出任何课程。可能是截图太糊、或者这段材料里确实没有课表信息。</div>';
    return;
  }
  let html = '<div class="note ' + (ui.draftStale ? 'warn' : 'ok') + '">' +
    (ui.draftStale ? '下面这份是【上一次】的结果，这次没成功，没被改动。' : '抽到 ' + d.courses.length + ' 条，先核对一下再写。') +
    (d.termStart ? '（里面写了开学日期：' + esc(d.termStart) + '）' : '') + '</div>';
  if (d.warnings && d.warnings.length) {
    html += '<div class="note warn">模型自己标的不确定项：<br>' + d.warnings.map(function (w) { return '· ' + esc(w); }).join('<br>') + '</div>';
  }
  d.courses.forEach(function (c, i) {
    html += '<div class="draft" data-i="' + i + '">' +
      '<div class="dhead"><span class="idx">' + (i + 1) + '</span>' +
        '<input class="d-name" value="' + esc(c.name) + '" style="flex:1">' +
        '<button class="btn danger sm d-del">删</button></div>' +
      '<div class="dgrid">' +
        '<input class="d-teacher full" placeholder="老师" value="' + esc(c.teacher) + '">' +
        '<input class="d-loc full" placeholder="地点" value="' + esc(c.location) + '">' +
        '<select class="d-day">' + [1,2,3,4,5,6,7].map(function (x) {
          return '<option value="' + x + '"' + (c.day === x ? ' selected' : '') + '>' + DAYS[x] + '</option>'; }).join('') + '</select>' +
        '<div class="row"><input class="d-from" type="number" min="1" value="' + c.periodFrom + '" title="起始节">' +
          '<span class="muted">-</span><input class="d-to" type="number" min="1" value="' + c.periodTo + '" title="结束节">' +
          '<span class="muted small">节</span></div>' +
        '<select class="d-wt full">' + [['range','连续周'],['odd','单周'],['even','双周'],['list','指定周'],['all','全周']].map(function (o) {
          return '<option value="' + o[0] + '"' + (c.weeks.type === o[0] ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select>' +
        '<div class="row full"><input class="d-wfrom" type="number" min="1" value="' + c.weeks.from + '">' +
          '<span class="muted">-</span><input class="d-wto" type="number" min="1" value="' + c.weeks.to + '">' +
          '<span class="muted small">周</span></div>' +
        '<input class="d-wlist full" placeholder="指定周：1,3,5" value="' + esc((c.weeks.list || []).join(',')) + '">' +
      '</div></div>';
  });
  html += '<div class="two" style="margin-top:6px">' +
      '<button class="btn" id="dApplyAdd">追加到课表</button>' +
      '<button class="btn ghost" id="dApplyReplace">替换课表</button>' +
    '</div>' +
    '<button class="btn ghost block" id="dDrop" style="margin-top:8px">丢弃这份草稿</button>';
  wrap.innerHTML = html;

  wrap.querySelectorAll('.d-del').forEach(function (b) {
    b.onclick = function () {
      const i = Number(this.parentNode.parentNode.getAttribute('data-i'));
      ui.draft.courses.splice(i, 1); renderDraft();
    };
  });
  $('dApplyAdd').onclick = function () { applyDraft(false); };
  $('dApplyReplace').onclick = function () { applyDraft(true); };
  $('dDrop').onclick = function () { ui.draft = null; renderDraft(); setImpStatus('', ''); };
}

function collectDraft() {
  const wrap = $('draftWrap');
  const out = [];
  const boxes = wrap.querySelectorAll('.draft');
  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i];
    const g = function (cls) { const e = b.querySelector('.' + cls); return e ? e.value : ''; };
    const from = Math.max(1, Number(g('d-from')) || 1);
    const to = Math.max(from, Number(g('d-to')) || from);
    const t = g('d-wt') || 'range';
    out.push({
      name: (g('d-name') || '').trim() || '未命名',
      teacher: (g('d-teacher') || '').trim(),
      location: (g('d-loc') || '').trim(),
      day: Number(g('d-day')) || 1,
      periodFrom: from,
      periodTo: to,
      weeks: {
        type: t,
        from: Number(g('d-wfrom')) || 1,
        to: Number(g('d-wto')) || 16,
        list: (g('d-wlist') || '').split(/[,，\s]+/).map(Number).filter(function (n) { return n > 0; })
      },
      note: ''
    });
  }
  return out;
}

function applyDraft(replace) {
  const rows = collectDraft();
  if (!rows.length) { toast('没有可写入的课程'); return; }
  if (replace) courses = [];
  let n = 0;
  rows.forEach(function (r) {
    courses.push({
      id: 'c' + Date.now().toString(36) + (n++) + Math.floor(Math.random() * 1000),
      name: r.name, teacher: r.teacher, location: r.location,
      day: r.day, periodFrom: r.periodFrom, periodTo: r.periodTo,
      weeks: r.weeks, remindOffsets: [], remindEnabled: true,
      source: 'import'
    });
  });
  if (ui.draft && ui.draft.termStart && !S.termStartIsSet) { /* 不动用户的开学日期 */ }
  persist();
  const armed = armReminders();
  ui.draft = null;
  renderDraft();
  setImpStatus('ok', '已写入 ' + rows.length + ' 门课，装了 ' + armed + ' 个提醒。');
  ui.tab = 'week';
  renderAll();
}

/* ============================ 导入流程 ============================ */
function blankDraftRow() {
  return {
    name: '', teacher: '', location: '', day: todayDow(), periodFrom: 1, periodTo: 2,
    weeks: { type: 'range', from: 1, to: S.totalWeeks || 16, list: [] }, note: ''
  };
}

async function runExtract(userText, imagePath) {
  const ai = S.ai || {};
  if (!ai.apiKey) {
    // 没填 Key 不是死路：给一张空草稿，当手动录入表用
    ui.draft = { termStart: null, courses: [blankDraftRow()], warnings: [] };
    setImpStatus('warn', '还没填 API Key，所以我不会自动识别（材料没读）。下面给你一张空表格，手动一条条填，填好点「追加到课表」。想去掉这一步就去「设置 → AI 识别」填 Key。');
    renderDraft(); renderAll();
    return;
  }
  if (!ai.baseURL || !ai.model) {
    setImpStatus('err', '接口地址或模型名还是空的，去设置里补一下。');
    return;
  }
  setImpStatus('busy', (imagePath ? '正在看这张图…' : '正在读这份材料…') + '（模型 ' + ai.model + '，大概 10～40 秒）');
  const res = await callAi({
    kind: 'chat',
    baseURL: ai.baseURL,
    apiKey: ai.apiKey,
    model: ai.model,
    system: SYS_PROMPT,
    user: (userText || '请看这张课表截图，整理成 JSON。') + STUB_PROMPT_HINT,
    imagePath: imagePath || ''
  });
  if (!res.ok) {
    // 别让失败把上一次的好结果盖住，但要说清「下面这张是旧的」
    ui.draftStale = !!ui.draft;
    setImpStatus('err', '识别失败：' + res.error);
    renderDraft();
    return;
  }
  const obj = extractJson(res.text);
  if (!obj) {
    ui.draftStale = !!ui.draft;
    setImpStatus('err', '模型没按格式回 JSON。原始回复前 300 字：' + String(res.text).slice(0, 300));
    renderDraft();
    return;
  }
  ui.draft = normalizeDraft(obj);
  if (ui.draft.termStart && !S.termStartIsSet) ui.draft.termStart = ui.draft.termStart;
  ui.draftStale = false;
  setImpStatus('', '');
  renderDraft();
  renderAll();
}

window.__onFilePicked = function (json) {
  let o = null;
  try { o = JSON.parse(json); } catch (e) { return; }
  if (o.cancelled) return;
  if (!o.ok) { setImpStatus('err', o.error || '读不了这个文件'); return; }
  ui.tab = 'import';
  renderAll();
  if (o.kind === 'image') {
    runExtract('', o.path);
  } else {
    const txt = String(o.text || '').trim();
    if (!txt) { setImpStatus('err', '这个文件里没读到文字（可能是纯图片的文档）。'); return; }
    setImpStatus('busy', '读到了 ' + txt.length + ' 个字，正在整理…');
    runExtract(txt.slice(0, 20000), '');
  }
};

window.__onResume = function () {
  let shared = '';
  try { shared = Native.takeShared() || ''; } catch (e) { shared = ''; }
  if (!shared) return;
  let o = null;
  try { o = JSON.parse(shared); } catch (e) { return; }
  ui.tab = 'import';
  renderAll();
  if (o.kind === 'image') runExtract('', o.path);
  else if (o.kind === 'text') { $('impStatus').innerHTML = ''; runExtract(String(o.text).slice(0, 20000), ''); }
};

/* ============================ 设置交互 ============================ */
function bindSettings() {
  $('sBase').onchange = function () { S.ai.baseURL = this.value.trim(); persist(); };
  $('sKey').onchange = function () { S.ai.apiKey = this.value.trim(); persist(); };
  $('sModel').onchange = function () { S.ai.model = this.value.trim(); persist(); };
  $('sTerm').onchange = function () {
    S.termStart = this.value; S.termStartIsSet = true;
    persist(); armReminders(); renderAll();
  };
  $('sWeeks').onchange = function () { S.totalWeeks = Number(this.value) || 20; persist(); renderWeek(); };
  $('sTermName').onchange = function () { S.semesterName = this.value.trim(); persist(); renderHeader(); };
  $('sOffsets').onchange = function () {
    S.defaultOffsets = this.value.split(/[,，\s]+/).map(Number).filter(function (n) { return n >= 0; });
    persist(); armReminders();
  };
  $('sRemindOn').onchange = function () {
    S.remindEnabled = this.checked; persist();
    const n = armReminders();
    $('remindStatus').innerHTML = '<div class="note ' + (n ? 'ok' : 'warn') + '">' +
      (n ? '已排好 ' + n + ' 个提醒（往后 2 周）。' : '提醒已关掉。') + '</div>';
  };
  $('periodBox').addEventListener('change', function (e) {
    const t = e.target;
    if (t && t.getAttribute('data-pi') !== null) {
      const i = Number(t.getAttribute('data-pi'));
      S.periods[i][t.getAttribute('data-k')] = t.value;
      persist(); armReminders(); renderWeek();
    }
  });
  $('btnTestNotify').onclick = function () {
    Native.notifyNow('课表测试 · 还有 15 分钟上课', '高等数学\n周一 第1-2节  08:00-09:40\n地点：理科楼 302');
    $('remindStatus').innerHTML = '<div class="note busy">发了一条测试通知。没看到的话，去系统设置里把「课表」的通知权限打开。</div>';
  };
  $('btnExport').onclick = function () {
    const txt = JSON.stringify({ settings: S, courses: courses }, null, 2);
    openSheet('课表数据（复制走就能备份）',
      '<textarea style="height:280px" readonly>' + esc(txt) + '</textarea>' +
      '<div class="two" style="margin-top:10px"><button class="btn ghost" id="exCopy">全选</button>' +
      '<button class="btn ghost" id="exShare">导出到文件</button></div>',
      function () {
        $('exCopy').onclick = function () {
          const ta = document.querySelector('#sheetHost textarea');
          ta.focus(); ta.select();
        };
        $('exShare').onclick = function () {
          Native.toast('长按上面的文本框手动复制即可（文件导出后续版本加）');
        };
      });
  };
  $('btnWipe').onclick = function () {
    openSheet('确认清空？',
      '<div class="note err">会把 ' + courses.length + ' 门课全部删掉，且不能撤销。API Key 和设置不动。</div>' +
      '<div class="two"><button class="btn danger" id="wipeYes">真的清空</button>' +
      '<button class="btn ghost" id="wipeNo">算了</button></div>',
      function () {
        $('wipeYes').onclick = function () {
          courses = []; persist(); armReminders(); closeSheet(); renderAll(); toast('已清空');
        };
        $('wipeNo').onclick = closeSheet;
      });
  };
  $('btnModels').onclick = async function () {
    const ai = S.ai;
    if (!ai.apiKey) { $('aiStatus').innerHTML = '<div class="note err">先填 API Key。</div>'; return; }
    $('aiStatus').innerHTML = '<div class="note busy">正在拉模型列表…</div>';
    const r = await callAi({ kind: 'models', baseURL: ai.baseURL, apiKey: ai.apiKey, model: '' });
    if (!r.ok) { $('aiStatus').innerHTML = '<div class="note err">' + esc(r.error) + '</div>'; return; }
    const ids = String(r.text).split('\n').filter(Boolean);
    $('aiStatus').innerHTML = '<div class="note ok">可用模型（点一下填进模型名）：</div>' +
      ids.map(function (id) { return '<span class="chip" data-model="' + esc(id) + '">' + esc(id) + '</span>'; }).join('');
    $('aiStatus').querySelectorAll('.chip').forEach(function (ch) {
      ch.onclick = function () { S.ai.model = this.getAttribute('data-model'); persist(); $('sModel').value = S.ai.model; toast('已选 ' + S.ai.model); };
    });
  };
  $('btnTest').onclick = async function () {
    const ai = S.ai;
    $('aiStatus').innerHTML = '<div class="note busy">正在测试…</div>';
    const r = await callAi({
      kind: 'chat', baseURL: ai.baseURL, apiKey: ai.apiKey, model: ai.model,
      system: '你是一个测试用的助手。', user: '只回复两个字：正常', imagePath: ''
    });
    if (!r.ok) $('aiStatus').innerHTML = '<div class="note err">' + esc(r.error) + '</div>';
    else $('aiStatus').innerHTML = '<div class="note ok">通了。模型回了：' + esc(String(r.text).slice(0, 60)) + '</div>';
  };
}

/* ============================ 导入页交互 ============================ */
function bindImport() {
  $('btnPick').onclick = function () { Native.pickFile(); };
  $('btnPaste').onclick = function () {
    openSheet('粘贴课表文字',
      '<div class="muted" style="margin-bottom:8px">聊天记录、教务系统复制的表格、随便什么文字都行，粘贴进来我来整理。</div>' +
      '<textarea id="pasteBox" style="height:200px" placeholder="例如：&#10;高等数学 周一 1-2节 理科楼302 张三 1-16周"></textarea>' +
      '<button class="btn block" id="pasteGo" style="margin-top:10px">开始整理</button>',
      function () {
        $('pasteGo').onclick = function () {
          const t = $('pasteBox').value.trim();
          if (!t) { toast('还没粘东西'); return; }
          closeSheet();
          ui.tab = 'import'; renderAll();
          runExtract(t.slice(0, 20000), '');
        };
      });
  };
  $('btnDemo').onclick = function () {
    const demo =
      '【教务系统】2026-2027学年第一学期课表（第1周从2026-09-07开始）\n' +
      '高等数学A    周一 第1-2节   理科楼302   张伟   1-16周\n' +
      '大学英语      周一 第3-4节   外语楼205   李娜   1-16周\n' +
      '计算机网络    周二 第3-4节   信息楼401   王强   1-12周\n' +
      '体育（篮球）  周三 第5-6节   体育馆     刘洋   1-16周(单周)\n' +
      '毛泽东思想概论 周四 第7-8节  文科楼108   陈静   2-16周(双周)\n' +
      '数据结构与算法 周五 第3-4节  信息楼502   赵鹏   1-16周';
    ui.tab = 'import'; renderAll();
    runExtract(demo, '');
  };
}

/* ============================ 启动 ============================ */
function main() {
  boot();
  try {
    const inf = JSON.parse(Native.info() || '{}');
    if (inf.sdk) document.title = '课表';
  } catch (e) {}

  const navs = document.querySelectorAll('nav button');
  for (let i = 0; i < navs.length; i++) {
    navs[i].onclick = function () {
      ui.tab = this.getAttribute('data-tab');
      renderAll();
      window.scrollTo(0, 0);
    };
  }
  $('wPrev').onclick = function () { if (ui.week > 1) { ui.week--; renderWeek(); } };
  $('wNext').onclick = function () { ui.week++; renderWeek(); };
  $('wNow').onclick = function () { const w = nowWeek(); ui.week = (w && w >= 1) ? w : 1; renderWeek(); };
  $('wAdd').onclick = function () { openCourse(null); };

  $('grid').addEventListener('click', function (e) {
    let el = e.target;
    while (el && el !== this && !el.getAttribute('data-oid')) el = el.parentNode;
    if (el && el !== this) openCourse(el.getAttribute('data-oid'));
  });
  $('todayList').addEventListener('click', function (e) {
    let el = e.target;
    while (el && el !== this && !el.getAttribute('data-oid')) el = el.parentNode;
    if (el && el !== this) openCourse(el.getAttribute('data-oid'));
  });

  bindSettings();
  bindImport();
  renderAll();
  const n = armReminders();
  window.__onResume();
  try { Native.log('armed ' + n + ' reminders'); } catch (e) {}
}

document.addEventListener('DOMContentLoaded', main);
if (document.readyState === 'complete' || document.readyState === 'interactive') {
  setTimeout(function () { if (!S) main(); }, 0);
}
})();
