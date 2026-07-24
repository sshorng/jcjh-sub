/**
 * 段考監考表匯出
 *
 * 流程：模板 load → 填文字成底稿 → writeBuffer 凍結
 * 每人：load(底稿) → 分發／額度 → 重套字型 → 鎖中線 → 併入 xlsx
 *
 * 鐵則：
 * - 只改 value；R3–R8 不寫
 * - 絕不改 border／格線／中線／欄寬／合併（模板格線原樣）
 * - 字型用完整 style 寫回（拆 ExcelJS 共用 styleId），否則改一格 font 會整欄灰底變粗體底線
 * - 粗體底線：僅代課、調課、加課（空堂排班）
 * - 一般班、基礎巡堂：有字、不粗、不底
 * - writeBuffer→load 後只重套字型（不碰格線）
 */
window.ExportInvigilation = (function () {
  var TEMPLATE_URL = 'templates/invigilation-template.xlsx';
  var DAY_ZH = { 0: '日', 1: '一', 2: '二', 3: '三', 4: '四', 5: '五', 6: '六' };
  var TEACHER_ROW_START = 9;
  var TEACHER_SLOTS_FALLBACK = 38;
  var NOTE5_RE = /【[^】]*未執行的[^】]*共\s*[_\d]*\s*節，本次段考已安排\s*[_\d]*\s*節，尚有\s*[_\d]*\s*節，未執行節數將會累計於本學年度】/;
  var _templateBuf = null;

  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  function parseDate(dateStr) {
    var s = String(dateStr || '').trim().slice(0, 10);
    if (!s) return null;
    var d = new Date(s.indexOf('T') >= 0 ? s : s + 'T00:00:00');
    if (Number.isNaN(d.getTime())) d = new Date(s.replace(/-/g, '/'));
    return Number.isNaN(d.getTime()) ? null : d;
  }

  function formatDayHeader(dateStr) {
    var d = parseDate(dateStr);
    if (!d) return String(dateStr || '');
    return (d.getMonth() + 1) + '月' + d.getDate() + '日(星期' + (DAY_ZH[d.getDay()] || '') + ')';
  }

  function dayOfWeekMon1(dateStr) {
    var d = parseDate(dateStr);
    if (!d) return 0;
    var wd = d.getDay();
    return wd === 0 ? 7 : wd;
  }

  function listWorkdays(startStr, endStr) {
    var start = parseDate(startStr);
    var end = parseDate(endStr);
    if (!start || !end) return { dates: [], error: '請選擇考試起迄日期' };
    if (end < start) return { dates: [], error: '迄日不可早於起日' };
    var dates = [];
    var cur = new Date(start.getTime());
    var guard = 0;
    while (cur <= end && guard < 14) {
      var dow = cur.getDay();
      if (dow >= 1 && dow <= 5) {
        dates.push(
          cur.getFullYear() + '-' + pad2(cur.getMonth() + 1) + '-' + pad2(cur.getDate())
        );
      }
      cur.setDate(cur.getDate() + 1);
      guard++;
    }
    if (!dates.length) return { dates: [], error: '期間內無平日' };
    if (dates.length > 2) {
      return { dates: dates.slice(0, 2), warning: '模板為雙日版面，已取前 2 個平日' };
    }
    return { dates: dates };
  }

  function buildPeriodSpec(dates) {
    var d0 = dates[0];
    var d1 = dates[1] || dates[0];
    var spec = [];
    var p;
    for (p = 1; p <= 7; p++) spec.push({ date: d0, period: p });
    for (p = 1; p <= 4; p++) spec.push({ date: d1, period: p });
    return spec;
  }

  function isEmptySlotAssignCell(cell) {
    if (!cell) return false;
    if (cell.isEmptySlotAssign === true) return true;
    var rec = cell.subRecord || null;
    if (rec && rec.isEmptySlotAssign === true) return true;
    var reason = String((rec && rec.reason) || '').trim();
    if (reason === '空堂排班') return true;
    var note = String((rec && rec.note) || '');
    return note.indexOf('[空堂排班]') >= 0;
  }

  function normText(v) {
    return String(v == null ? '' : v).replace(/[\u3000\s]+/g, '').trim();
  }

  function isPatrolWord(v) {
    var s = normText(v);
    return s === '巡堂' || s.indexOf('巡堂') === 0;
  }

  /**
   * 基礎巡堂（從寬）：isPatrol／attr／班／科 含「巡堂」
   */
  function isBasePatrol(cell) {
    if (!cell) return false;
    if (cell.isPatrol === true) return true;
    if (window.DomainSchedule && window.DomainSchedule.isPatrolCell) {
      try {
        if (window.DomainSchedule.isPatrolCell(cell)) return true;
      } catch (eP) { /* ignore */ }
    }
    if (window.DomainSchedule && window.DomainSchedule.isPatrolAttr
        && window.DomainSchedule.isPatrolAttr(cell.attr)) return true;
    if (isPatrolWord(cell.attr)) return true;
    if (isPatrolWord(cell.className)) return true;
    if (isPatrolWord(cell.subject)) return true;
    return false;
  }

  /**
   * 異動＝isEmptySlotAssign／isSubstitutionDuty → changed=true
   * 基礎巡堂 → 固定寫「巡堂」、changed=false
   */
  function cellTextFromSchedule(cell) {
    if (!cell) return { text: '', changed: false };
    if (cell.isSubstituted) return { text: '', changed: false };

    var emptyAssign = isEmptySlotAssignCell(cell);
    var cn = String(cell.className || '').trim();
    var subj = String(cell.subject || '').trim();
    var attr = String(cell.attr || '').trim();
    var patrol = isBasePatrol(cell);

    if (/特殊考場/.test(cn + subj + attr)) return { text: '', changed: false };
    if (/^請假$|^公假$/.test(subj) || /^請假$|^公假$/.test(cn)) {
      return { text: '', changed: false };
    }

    if (emptyAssign) {
      return { text: (subj || cn || '巡堂'), changed: true };
    }
    if (cell.isSubstitutionDuty) {
      var dutyText = '';
      if (cn && !isPatrolWord(cn)) dutyText = cn;
      else if (subj && !isPatrolWord(subj)) dutyText = subj;
      else if (patrol) dutyText = '巡堂';
      else dutyText = cn || subj || '';
      if (!dutyText) return { text: '', changed: false };
      return { text: dutyText, changed: true };
    }

    // 基礎巡堂：一定要有字
    if (patrol || isPatrolWord(cn) || isPatrolWord(subj) || isPatrolWord(attr)) {
      return { text: '巡堂', changed: false };
    }
    if (cn) return { text: cn, changed: false };
    if (subj) return { text: subj, changed: false };
    return { text: '', changed: false };
  }

  /** 純物件字型（每次 new，避免 styles 池共用） */
  function plainFont(bold, withUnderline) {
    return {
      name: '標楷體',
      size: 15,
      bold: !!bold,
      italic: false,
      underline: withUnderline ? 'single' : false
    };
  }

  function clonePlain(obj) {
    if (!obj) return null;
    try { return JSON.parse(JSON.stringify(obj)); } catch (e) {
      try { return Object.assign({}, obj); } catch (e2) { return null; }
    }
  }

  var THICK_EDGE = { style: 'thick', color: { argb: 'FF000000' } };
  var THIN_EDGE = { style: 'thin', color: { argb: 'FF000000' } };

  function edgeSide(side, fallback) {
    if (side && side.style) {
      return {
        style: side.style,
        color: side.color && side.color.argb
          ? { argb: side.color.argb }
          : { argb: 'FF000000' }
      };
    }
    return fallback || undefined;
  }

  /**
   * 關鍵：ExcelJS 模板多格共用同一 styleId。
   * 若只寫 cell.font，會改到整欄灰底格。
   * 寫入完整 style 時：font 用新物件；fill／border／alignment 原樣深拷貝。
   * L 欄(col12) 空白格也必須強制 right=thick，否則中線斷在無字列。
   * M 欄(col13) 強制 left=thick。
   */
  function setCellFontIsolated(cell, fontSpec, colNumber) {
    if (!cell) return;
    var border = clonePlain(cell.border) || {};
    var col = colNumber != null ? colNumber : 0;
    try {
      if (!col && cell.col != null) col = cell.col;
      if (!col && cell.address) {
        var m = String(cell.address).match(/^([A-Z]+)/i);
        if (m) {
          // A=1 … L=12, M=13
          var letters = m[1].toUpperCase();
          var n = 0;
          var i;
          for (i = 0; i < letters.length; i++) n = n * 26 + (letters.charCodeAt(i) - 64);
          col = n;
        }
      }
    } catch (eCol) { /* ignore */ }

    if (col === 12) {
      border = {
        top: edgeSide(border.top, THIN_EDGE),
        bottom: edgeSide(border.bottom, THIN_EDGE),
        left: edgeSide(border.left, THIN_EDGE),
        right: { style: 'thick', color: { argb: 'FF000000' } }
      };
    } else if (col === 13) {
      border = {
        top: edgeSide(border.top, THIN_EDGE),
        bottom: edgeSide(border.bottom, THIN_EDGE),
        left: { style: 'thick', color: { argb: 'FF000000' } },
        right: edgeSide(border.right, THIN_EDGE)
      };
    }

    cell.style = {
      font: fontSpec,
      fill: clonePlain(cell.fill) || undefined,
      border: border,
      alignment: clonePlain(cell.alignment) || undefined,
      numFmt: cell.numFmt || undefined
    };
  }

  /**
   * 只還原中線（模板 L 右 thick）。
   * 必須用完整 cell.style 寫入。
   * Excel 常不畫「完全空白」儲存格的邊框：空白 L 格寫入零寬空白 \u200B 強制出線，
   * 畫面／列印仍看不見字。
   */
  function restoreMiddleDivider(ws, rowStart, rowEnd) {
    if (!ws) return;
    var rS = rowStart || TEACHER_ROW_START;
    var rE = rowEnd || (TEACHER_ROW_START + TEACHER_SLOTS_FALLBACK - 1);
    var thin = THIN_EDGE;
    var r;
    var ZWSP = '\u200B';

    function keepFont(cell) {
      if (cell.font && cell.font.bold) {
        return plainFont(true, !!cell.font.underline);
      }
      return {
        name: (cell.font && cell.font.name) || '標楷體',
        size: (cell.font && cell.font.size) || 15,
        bold: !!(cell.font && cell.font.bold),
        italic: !!(cell.font && cell.font.italic),
        underline: (cell.font && cell.font.underline) ? cell.font.underline : false
      };
    }

    function isBlankVal(v) {
      if (v == null) return true;
      if (typeof v === 'object' && v.formula) return false;
      var s = String(v).replace(/\u200B/g, '').trim();
      return s === '';
    }

    for (r = rS; r <= rE; r++) {
      var c12 = ws.getCell(r, 12);
      var c13 = ws.getCell(r, 13);
      var b12 = clonePlain(c12.border) || {};
      var b13 = clonePlain(c13.border) || {};

      // 空白 L 格：寫入零寬字，否則 Excel 不畫 thick 右邊線
      if (isBlankVal(c12.value)) {
        c12.value = ZWSP;
      }

      c12.style = {
        font: keepFont(c12),
        fill: clonePlain(c12.fill) || undefined,
        alignment: clonePlain(c12.alignment) || undefined,
        numFmt: c12.numFmt || undefined,
        border: {
          top: edgeSide(b12.top, thin),
          bottom: edgeSide(b12.bottom, thin),
          left: edgeSide(b12.left, thin),
          right: { style: 'thick', color: { argb: 'FF000000' } }
        }
      };
      c13.style = {
        font: keepFont(c13),
        fill: clonePlain(c13.fill) || undefined,
        alignment: clonePlain(c13.alignment) || undefined,
        numFmt: c13.numFmt || undefined,
        border: {
          top: edgeSide(b13.top, thin),
          bottom: edgeSide(b13.bottom, thin),
          left: { style: 'thick', color: { argb: 'FF000000' } },
          right: edgeSide(b13.right, thin)
        }
      };
    }
  }

  /**
   * 兩段式字型 + 還原中線：
   * Pass1：左右 11 節全部格 → 一般字型（拆共用 style）
   * Pass2：matrix.changed → 粗體底線
   * Pass3：還原 L/M 中線 thick（不碰其他格線）
   */
  function applyChangeFonts(ws, matrix, layout) {
    if (!ws || !layout) return 0;
    var slots = layout.slots;
    var rowStart = layout.teacherRowStart;
    var rowEnd = layout.teacherRowEnd;
    var dataStarts = [2, 14];
    var di, idx, s, row, cell;
    var marked = 0;

    // Pass 1：整區隔離＋一般字型（空白格也拆；L=col12 強制 thick）
    for (di = 0; di < dataStarts.length; di++) {
      for (idx = 0; idx < slots; idx++) {
        row = rowStart + idx;
        if (row > rowEnd) break;
        for (s = 0; s < 11; s++) {
          var colN = dataStarts[di] + s;
          cell = ws.getCell(row, colN);
          setCellFontIsolated(cell, plainFont(false, false), colN);
        }
      }
    }

    if (matrix) {
      function markSide(list, dataColStart) {
        if (!list) return;
        for (idx = 0; idx < slots; idx++) {
          row = rowStart + idx;
          if (row > rowEnd) break;
          var t = list[idx];
          if (!t || !t.slots) continue;
          for (s = 0; s < 11; s++) {
            var slot = t.slots[s];
            if (!slot || typeof slot !== 'object' || !slot.changed) continue;
            var txt = String(slot.text || '').trim();
            if (!txt) continue;
            var colM = dataColStart + s;
            cell = ws.getCell(row, colM);
            if (cell.value == null || String(cell.value).trim() === '') {
              cell.value = txt;
            }
            setCellFontIsolated(cell, plainFont(true, true), colM);
            marked += 1;
          }
        }
      }
      markSide(matrix.left, 2);
      markSide(matrix.right, 14);
    }

    // Pass 3：整列 L/M 再鎖中線（含空白 L 格）
    restoreMiddleDivider(ws, rowStart, rowEnd);
    return marked;
  }

  function detectLayout(ws) {
    var tipRow = null;
    var noteRow = null;
    var r;
    for (r = 40; r <= 60; r++) {
      var v = ws.getCell(r, 1).value;
      if (v == null) continue;
      var s = String(v);
      if (!tipRow && s.indexOf('提醒') >= 0) tipRow = r;
      if (!noteRow && s.indexOf('備註') === 0) noteRow = r;
    }
    if (!tipRow) tipRow = 47;
    if (!noteRow) noteRow = tipRow + 1;
    var teacherRowEnd = tipRow - 1;
    if (teacherRowEnd < TEACHER_ROW_START) {
      teacherRowEnd = TEACHER_ROW_START + TEACHER_SLOTS_FALLBACK - 1;
    }
    var slots = teacherRowEnd - TEACHER_ROW_START + 1;
    if (slots < 1 || slots > 60) slots = TEACHER_SLOTS_FALLBACK;
    return {
      teacherRowStart: TEACHER_ROW_START,
      teacherRowEnd: teacherRowEnd,
      slots: slots,
      tipRow: tipRow,
      noteRow: noteRow
    };
  }

  function countEmptySlotQuotaUsed(requests, email, startDate, endDate) {
    var em = String(email || '').toLowerCase();
    var a = String(startDate || '').slice(0, 10);
    var b = String(endDate || '').slice(0, 10);
    var n = 0;
    (requests || []).forEach(function (r) {
      if (!r || String(r.status || '').toLowerCase() !== 'approved') return;
      var fee = String(r.subFee || '');
      if (fee !== '扣額度' && fee !== '互代不結') return;
      var te = String(r.targetTeacherEmail || r.actualTeacherEmail || '').toLowerCase();
      if (te !== em) return;
      var reason = String(r.reason || '').trim();
      var note = String(r.note || '');
      if (!(reason === '空堂排班' || note.indexOf('[空堂排班]') >= 0 || r.isEmptySlotAssign)) return;
      var d = String(r.requestDate || r.date || '').slice(0, 10);
      if (a && d < a) return;
      if (b && d > b) return;
      n += 1;
    });
    return n;
  }

  function getExcelJS() {
    return window.ExcelJS || (typeof ExcelJS !== 'undefined' ? ExcelJS : null);
  }

  async function loadTemplateBuffer() {
    if (_templateBuf) return _templateBuf;
    var res = await fetch(TEMPLATE_URL + '?t=' + Date.now(), { cache: 'no-cache' });
    if (!res.ok) throw new Error('無法載入監考表模板');
    _templateBuf = await res.arrayBuffer();
    return _templateBuf;
  }

  function setVal(cell, val) {
    if (!cell) return;
    try {
      var m = String(cell.address || '').match(/([A-Z]+)(\d+)/i);
      if (m) {
        var rn = parseInt(m[2], 10);
        // R3–R8 含考科列 B4–X6：匯出不覆寫（由主表手填、分發表公式連動）
        if (rn >= 3 && rn <= 8) return;
      }
    } catch (e) { /* ignore */ }
    cell.value = (val === '' || val === undefined) ? null : val;
  }

  var MASTER_SHEET_NAME = '監考表';

  /**
   * 分發表：B4:X6（七／八／九年級考科列）公式連動主表「監考表」
   * 只改 value 為公式，不碰 border／fill
   */
  function linkExamSubjectRows(ws, masterName) {
    if (!ws) return;
    var src = String(masterName || MASTER_SHEET_NAME).replace(/'/g, "''");
    var r;
    var c;
    for (r = 4; r <= 6; r++) {
      for (c = 2; c <= 24; c++) {
        var cell = ws.getCell(r, c);
        var addr = cell.address;
        if (!addr) continue;
        // ExcelJS：公式物件
        cell.value = { formula: "'" + src + "'!" + addr };
      }
    }
  }

  function buildTeacherMatrix(teachers, periodSpec, getCell, slotsPerSide, onProgress, allSchedules) {
    var cap = slotsPerSide || TEACHER_SLOTS_FALLBACK;
    var half = Math.min(Math.ceil(teachers.length / 2), cap);
    var leftT = teachers.slice(0, half);
    var rightT = teachers.slice(half, half + cap);
    var truncated = teachers.length > cap * 2;
    var cache = Object.create(null);
    var baseList = allSchedules || [];

    // 基礎課表索引：email|dow|period → 是否巡堂
    var basePatrolMap = Object.create(null);
    baseList.forEach(function (s) {
      if (!s || !s.teacherEmail) return;
      var a = String(s.attr || '').trim();
      var cn = String(s.className || '').trim();
      var sub = String(s.subject || '').trim();
      var isP = a === '巡堂' || a.indexOf('巡堂') >= 0 || cn === '巡堂' || sub === '巡堂'
        || a.indexOf('巡') === 0 || cn.indexOf('巡') === 0 || sub.indexOf('巡') === 0;
      if (!isP) return;
      var key = String(s.teacherEmail).toLowerCase()
        + '|' + parseInt(s.dayOfWeek, 10)
        + '|' + parseInt(s.period, 10);
      basePatrolMap[key] = true;
    });

    function getCached(em, d, p, day) {
      if (!getCell) return null;
      var k = String(em || '').toLowerCase() + '|' + d + '|' + p;
      if (Object.prototype.hasOwnProperty.call(cache, k)) return cache[k];
      var cell = getCell(em, d, p, day);
      // 備援：getCell 漏掉巡堂時，用基礎課表補
      if (!cell || (!cell.isPatrol && !isPatrolWord(cell.attr)
          && !isPatrolWord(cell.className) && !isPatrolWord(cell.subject)
          && !cell.isSubstitutionDuty && !isEmptySlotAssignCell(cell))) {
        var bk = String(em || '').toLowerCase() + '|' + parseInt(day, 10) + '|' + parseInt(p, 10);
        if (basePatrolMap[bk] && (!cell || !cell.isSubstituted)) {
          cell = Object.assign({}, cell || {}, {
            isPatrol: true,
            attr: '巡堂',
            className: (cell && cell.className) || '巡堂',
            subject: '巡堂'
          });
        }
      }
      cache[k] = cell;
      return cache[k];
    }

    var patrolCount = 0;
    var changedCount = 0;

    function mapOne(t, idx, tot) {
      if (onProgress && (idx === 0 || (idx + 1) % 10 === 0 || idx === tot - 1)) {
        try { onProgress(idx + 1, tot); } catch (e) { /* ignore */ }
      }
      var slots = [];
      var s;
      for (s = 0; s < 11; s++) {
        var sp = periodSpec[s];
        var day = dayOfWeekMon1(sp.date);
        var raw = getCached(t.email, sp.date, sp.period, day);
        var slot = cellTextFromSchedule(raw);
        // 雙重保險：基礎巡堂一定寫「巡堂」
        if (!slot || (!slot.changed && (!slot.text || !String(slot.text).trim()))) {
          var bk2 = String(t.email || '').toLowerCase()
            + '|' + day + '|' + parseInt(sp.period, 10);
          if (basePatrolMap[bk2]
              || (raw && (raw.isPatrol || isPatrolWord(raw.attr)
                || isPatrolWord(raw.className) || isPatrolWord(raw.subject)))) {
            slot = { text: '巡堂', changed: false };
          }
        }
        if (!slot) slot = { text: '', changed: false };
        if (slot.text === '巡堂' && !slot.changed) patrolCount += 1;
        if (slot.changed) changedCount += 1;
        slots.push(slot);
      }
      return { name: t.name || t.email || '', email: t.email, slots: slots };
    }

    var all = leftT.concat(rightT);
    var mapped = all.map(function (t, i) { return mapOne(t, i, all.length); });
    return {
      left: mapped.slice(0, leftT.length),
      right: mapped.slice(leftT.length),
      truncated: truncated,
      total: teachers.length,
      shown: leftT.length + rightT.length,
      patrolCount: patrolCount,
      changedCount: changedCount
    };
  }

  function fillMasterValues(ws, opts) {
    var layout = opts.layout;
    var matrix = opts.matrix;
    var dates = opts.dates;
    var title = opts.title;
    var slots = layout.slots;
    var rowStart = layout.teacherRowStart;
    var rowEnd = layout.teacherRowEnd;

    if (title) setVal(ws.getCell(1, 1), title);

    var d0 = formatDayHeader(dates[0] || '');
    var d1 = formatDayHeader(dates[1] || dates[0] || '');
    setVal(ws.getCell(2, 2), d0);
    setVal(ws.getCell(2, 9), d1);
    setVal(ws.getCell(2, 14), d0);
    setVal(ws.getCell(2, 21), d1);

    function fillSide(list, nameCol, dataColStart) {
      var idx;
      for (idx = 0; idx < slots; idx++) {
        var row = rowStart + idx;
        if (row > rowEnd) break;
        var t = list[idx];
        setVal(ws.getCell(row, nameCol), t ? (t.name || null) : null);
        var s;
        for (s = 0; s < 11; s++) {
          var slot = t && t.slots ? t.slots[s] : null;
          var text = '';
          if (slot && typeof slot === 'object') text = slot.text || '';
          else if (typeof slot === 'string') text = slot;
          setVal(ws.getCell(row, dataColStart + s), text || null);
        }
      }
    }
    fillSide(matrix.left || [], 1, 2);
    fillSide(matrix.right || [], 13, 14);

    // 只重套字型（先清再標異動）；完全不碰格線
    applyChangeFonts(ws, matrix, layout);
  }

  function personalizeValues(ws, layout, recipientName, before, used, remain) {
    var noteRow = (layout && layout.noteRow) || 48;
    if (recipientName) {
      var label = '分發：' + recipientName;
      try {
        if (!ws.headerFooter) ws.headerFooter = {};
        ws.headerFooter.oddHeader = '&L' + label;
        ws.headerFooter.evenHeader = '&L' + label;
      } catch (eH) { /* ignore */ }
      setVal(ws.getCell(1, 25), label);
    }
    var noteCell = ws.getCell(noteRow, 1);
    var noteText = noteCell.value;
    if (noteText == null) return;
    noteText = String(noteText);
    var bracket = (
      '【未執行的課務共' + before + '節，本次段考已安排' + used
      + '節，尚有' + remain + '節，未執行節數將會累計於本學年度】'
    );
    if (NOTE5_RE.test(noteText)) noteText = noteText.replace(NOTE5_RE, bracket);
    else if (/【[^】]*未執行[^】]*】/.test(noteText)) {
      noteText = noteText.replace(/【[^】]*未執行[^】]*】/, bracket);
    }
    setVal(noteCell, noteText);
  }

  /** 每張表：分發後只重套字型（不碰格線） */
  function finalizeSheet(ws, matrix, layout) {
    return applyChangeFonts(ws, matrix, layout);
  }

  /**
   * 逐格複製（value/font/border/fill/alignment）＋合併／頁面設定
   * 複製後呼叫方再 finalizeSheet
   */
  function copySheetValuesAndStyles(srcSheet, targetSheet) {
    if (!srcSheet || !targetSheet) return;

    if (srcSheet.columns) {
      srcSheet.columns.forEach(function (col, idx) {
        if (col && col.width) {
          try { targetSheet.getColumn(idx + 1).width = col.width; } catch (eW) {}
        }
      });
    }

    srcSheet.eachRow({ includeEmpty: true }, function (row, rowNumber) {
      var targetRow = targetSheet.getRow(rowNumber);
      if (row.height) targetRow.height = row.height;

      row.eachCell({ includeEmpty: true }, function (cell, colNumber) {
        var targetCell = targetRow.getCell(colNumber);
        targetCell.value = cell.value;

        if (cell.font) {
          var sf = cell.font;
          targetCell.font = {
            name: sf.name || '標楷體',
            size: sf.size || 15,
            bold: !!sf.bold,
            italic: !!sf.italic,
            underline: sf.underline ? (sf.underline === true ? 'single' : sf.underline) : false
          };
          if (sf.color && sf.color.argb) {
            targetCell.font.color = { argb: sf.color.argb };
          }
        }
        if (cell.border) {
          try { targetCell.border = JSON.parse(JSON.stringify(cell.border)); } catch (eB) {
            targetCell.border = cell.border;
          }
        }
        if (cell.fill) {
          try { targetCell.fill = JSON.parse(JSON.stringify(cell.fill)); } catch (eF) {
            targetCell.fill = cell.fill;
          }
        }
        if (cell.alignment) {
          targetCell.alignment = Object.assign({}, cell.alignment);
        }
      });
    });

    if (srcSheet.model && srcSheet.model.merges) {
      srcSheet.model.merges.forEach(function (range) {
        try { targetSheet.mergeCells(range); } catch (eM) {}
      });
    }

    if (srcSheet.headerFooter) {
      try { targetSheet.headerFooter = JSON.parse(JSON.stringify(srcSheet.headerFooter)); } catch (eHF) {}
    }
    if (srcSheet.pageSetup) {
      try { targetSheet.pageSetup = JSON.parse(JSON.stringify(srcSheet.pageSetup)); } catch (ePS) {}
    }
  }

  function yieldUi() {
    return new Promise(function (resolve) {
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(function () { setTimeout(resolve, 0); });
      } else setTimeout(resolve, 0);
    });
  }

  function downloadBlob(buffer, filename) {
    var blob = new Blob([buffer], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      try { document.body.removeChild(a); } catch (e1) {}
      try { URL.revokeObjectURL(url); } catch (e2) {}
    }, 1500);
  }

  async function exportWorkbook(opts) {
    opts = opts || {};
    var onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
    function progress(msg, cur, total) {
      if (!onProgress) return;
      try { onProgress({ message: msg, current: cur || 0, total: total || 0 }); } catch (e) {}
    }

    var ExcelJSLib = getExcelJS();
    if (!ExcelJSLib) return { ok: false, error: 'ExcelJS 未載入，請重新整理' };

    var range = listWorkdays(opts.startDate, opts.endDate);
    if (!range.dates || !range.dates.length) {
      return { ok: false, error: range.error || '日期無效' };
    }
    var teachers = (opts.teachers || []).filter(function (t) { return t && t.email; });
    if (!teachers.length) return { ok: false, error: '無教師名單' };

    var recipients = opts.recipients && opts.recipients.length
      ? opts.recipients
      : teachers.slice();
    var total = recipients.length;

    var periodSpec = buildPeriodSpec(range.dates);
    var title = (opts.title && String(opts.title).trim())
      || '臺北市立建成國民中學114學年度第一學期第一次段考監考表';

    progress('載入模板…', 0, total);
    _templateBuf = null;
    var tplBuf = await loadTemplateBuffer();
    var masterWb = new ExcelJSLib.Workbook();
    await masterWb.xlsx.load(tplBuf.slice(0));
    var master = masterWb.worksheets[0];
    if (!master) return { ok: false, error: '模板沒有工作表' };
    var layout = detectLayout(master);

    progress('讀取課表…', 0, total);
    await yieldUi();
    var matrix = buildTeacherMatrix(
      teachers, periodSpec, opts.getCell, layout.slots,
      function (c, t) { progress('讀取課表 ' + c + '／' + t + '…', c, t); },
      opts.allSchedules || []
    );

    progress('寫入全校文字…', 0, total);
    await yieldUi();
    fillMasterValues(master, {
      title: title,
      dates: range.dates,
      matrix: matrix,
      layout: layout
    });

    progress('產生底稿…', 0, total);
    await yieldUi();
    var masterBuf = await masterWb.xlsx.writeBuffer();

    // 第一張固定「監考表」：全校內容、不分發、不折抵；B4:X6 手填考科
    progress('建立主表「監考表」…', 0, total);
    await yieldUi();
    var outWb = new ExcelJSLib.Workbook();
    await outWb.xlsx.load(masterBuf.slice(0));
    var masterSheet = outWb.worksheets[0];
    if (!masterSheet) return { ok: false, error: '底稿讀取失敗' };
    masterSheet.name = MASTER_SHEET_NAME;
    var lastMarked = finalizeSheet(masterSheet, matrix, layout);

    var usedNames = {};
    usedNames[MASTER_SHEET_NAME] = 1;
    var i;

    for (i = 0; i < total; i++) {
      var rec = recipients[i];
      var em = String(rec.email || '').toLowerCase();
      var name = rec.name || em || ('教師' + (i + 1));
      var sheetName = String(name).replace(/[\\\/\?\*\[\]]/g, '').slice(0, 28) || ('T' + i);
      if (usedNames[sheetName]) sheetName = sheetName.slice(0, 26) + '_' + i;
      usedNames[sheetName] = 1;

      var remain = parseFloat(rec.mutualQuota);
      if (Number.isNaN(remain)) remain = 0;
      var usedN = countEmptySlotQuotaUsed(
        opts.requests, em, range.dates[0], range.dates[range.dates.length - 1]
      );

      if (i === 0 || (i + 1) % 5 === 0 || i === total - 1) {
        progress('分發工作表 ' + (i + 1) + '／' + total + '…', i + 1, total);
        await yieldUi();
      }

      var tempWb = new ExcelJSLib.Workbook();
      await tempWb.xlsx.load(masterBuf.slice(0));
      var tempSheet = tempWb.worksheets[0];
      if (!tempSheet) return { ok: false, error: '底稿讀取失敗' };
      tempSheet.name = sheetName;
      personalizeValues(tempSheet, layout, name, remain + usedN, usedN, remain);
      finalizeSheet(tempSheet, matrix, layout);

      try {
        var targetSheet = outWb.addWorksheet(sheetName);
        copySheetValuesAndStyles(tempSheet, targetSheet);
        finalizeSheet(targetSheet, matrix, layout);
        // 考科列 B4:X6 公式連動「監考表」
        linkExamSubjectRows(targetSheet, MASTER_SHEET_NAME);
      } catch (eMove) {
        return {
          ok: false,
          error: '合併工作表失敗：' + (eMove && eMove.message ? eMove.message : eMove)
        };
      }
    }

    if (!outWb || !outWb.worksheets.length) {
      return { ok: false, error: '沒有可匯出的工作表' };
    }

    // 寫出前：每張表（含第1張監考表）再鎖中線一次
    progress('鎖定中線…', total, total);
    await yieldUi();
    var rMidS = (layout && layout.teacherRowStart) || 9;
    var rMidE = (layout && layout.teacherRowEnd) || 46;
    outWb.worksheets.forEach(function (sh) {
      restoreMiddleDivider(sh, rMidS, rMidE);
    });

    progress('寫入單一 xlsx…', total, total);
    await yieldUi();
    var fname = opts.filename
      || ('段考監考表_' + String(range.dates[0]).replace(/-/g, '') + '.xlsx');
    var outBuf = await outWb.xlsx.writeBuffer();
    downloadBlob(outBuf, fname);

    var warn = range.warning || '';
    if (matrix.truncated) {
      var tip = '教師 ' + matrix.total + ' 人，表內列出前 ' + matrix.shown + ' 人。';
      warn = warn ? (warn + '；' + tip) : tip;
    }
    var masterTip = '第1張「監考表」可填 B4:X6 考科，其餘分發表已公式連動。';
    warn = warn ? (warn + '；' + masterTip) : masterTip;

    return {
      ok: true,
      fileName: fname,
      dayCount: range.dates.length,
      teacherCount: teachers.length,
      copyCount: total,
      sheetCount: total + 1,
      changedMarked: lastMarked,
      patrolCount: matrix.patrolCount || 0,
      warning: warn,
      dates: range.dates
    };
  }

  return {
    TEMPLATE_URL: TEMPLATE_URL,
    listWorkdays: listWorkdays,
    buildPeriodSpec: buildPeriodSpec,
    cellTextFromSchedule: cellTextFromSchedule,
    countEmptySlotQuotaUsed: countEmptySlotQuotaUsed,
    exportWorkbook: exportWorkbook,
    loadTemplateBuffer: loadTemplateBuffer
  };
})();
