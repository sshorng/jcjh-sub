/**
 * 班級空堂事件（畢旅 keep／畢業 reduce）
 * - 迄日空白 → 學期結束日
 * - 課表：事件期間內該班視為空堂
 * - 月報：reduce 只扣「起日之後的週」；keep 不扣
 */
window.DomainClassAway = (function () {
  var RULE_KEEP = 'keep';
  var RULE_REDUCE = 'reduce';

  function normDate(d) {
    return String(d || '').trim().slice(0, 10);
  }

  /**
   * 正規化班名：去掉 Sheets 數字／日期污染（0、000、日期字串）
   * 合法例：701、901、7A、美一
   */
  function normClass(c) {
    if (c === undefined || c === null) return '';
    // 純數字 0 不當班名
    if (typeof c === 'number') {
      if (!c || !isFinite(c)) return '';
      // 拒絕過大／小數（常是日期序號）
      if (c < 1 || c > 9999 || Math.floor(c) !== c) return '';
      return String(c);
    }
    var s = String(c).trim();
    if (!s) return '';
    // 明確垃圾：0 / 00 / 000
    if (/^0+$/.test(s)) return '';
    // 日期字串（Sheets 誤把 7/01 當日期）
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return '';
    if (/^\d{1,2}\/\d{1,2}(\/\d{2,4})?$/.test(s)) return '';
    // 科學記號／浮點
    if (/e|E|\./.test(s) && !/^[A-Za-z\u4e00-\u9fff]/.test(s)) return '';
    return s;
  }

  function parseClassList(raw) {
    if (Array.isArray(raw)) {
      return raw.map(normClass).filter(Boolean);
    }
    // 數字 0 → 無效；901 → "901"
    if (typeof raw === 'number') {
      var one = normClass(raw);
      return one ? [one] : [];
    }
    if (raw !== undefined && raw !== null && typeof raw !== 'string') {
      raw = String(raw);
    }
    return String(raw || '')
      .split(/[,，、;\s]+/)
      .map(normClass)
      .filter(Boolean);
  }

  function classListToStore(list) {
    return parseClassList(list).join(',');
  }

  /** 是否像合理班名（供 UI 勾選清單過濾） */
  function isPlausibleClassName(c) {
    var s = normClass(c);
    if (!s) return false;
    if (/^0+$/.test(s)) return false;
    // 至少含一個非零數字，或含中文／字母（特殊班）
    if (/[1-9]/.test(s)) return true;
    if (/[A-Za-z\u4e00-\u9fff]/.test(s)) return true;
    return false;
  }

  function isEnabled(ev) {
    if (!ev) return false;
    if (ev.enabled === false || ev.enabled === 'FALSE' || ev.enabled === 'false') return false;
    if (ev['啟用'] === false || ev['啟用'] === 'FALSE' || ev['啟用'] === '否') return false;
    return true;
  }

  function getRule(ev) {
    var r = String(ev.billingRule || ev['鐘點規則'] || RULE_KEEP).toLowerCase();
    if (r === RULE_REDUCE || r === '調降' || r === 'reduce') return RULE_REDUCE;
    return RULE_KEEP;
  }

  function canMutual(ev) {
    var v = ev.forMutual != null ? ev.forMutual : ev['可進互代'];
    return v === true || v === 'TRUE' || v === 'true' || v === '是' || v === 1 || v === '1';
  }

  function eventClasses(ev) {
    return parseClassList(ev.classes || ev.classList || ev['班級清單'] || '');
  }

  /**
   * 有效迄日：空白 → semesterEndDate
   */
  function effectiveEnd(ev, semesterEndDate) {
    var end = normDate(ev.endDate || ev['迄日']);
    if (end) return end;
    return normDate(semesterEndDate) || '9999-12-31';
  }

  function eventStart(ev) {
    return normDate(ev.startDate || ev['起日']);
  }

  function isDateInEvent(dateStr, ev, semesterEndDate) {
    if (!isEnabled(ev)) return false;
    var d = normDate(dateStr);
    var s = eventStart(ev);
    if (!d || !s) return false;
    if (d < s) return false;
    var e = effectiveEnd(ev, semesterEndDate);
    if (d > e) return false;
    return true;
  }

  function isClassAwayOnDate(className, dateStr, events, semesterEndDate) {
    var c = normClass(className);
    if (!c) return false;
    var list = events || [];
    for (var i = 0; i < list.length; i++) {
      var ev = list[i];
      if (!isDateInEvent(dateStr, ev, semesterEndDate)) continue;
      var classes = eventClasses(ev);
      if (classes.indexOf(c) >= 0) return true;
    }
    return false;
  }

  function getActiveAwayClasses(dateStr, events, semesterEndDate) {
    var set = {};
    (events || []).forEach(function (ev) {
      if (!isDateInEvent(dateStr, ev, semesterEndDate)) return;
      eventClasses(ev).forEach(function (c) { set[c] = 1; });
    });
    return Object.keys(set).sort();
  }

  /**
   * 期間內有交集的外出班（活動互代帶入用）
   * @param {{ forMutualOnly?: boolean }} opts
   */
  function getAwayClassesInRange(startDate, endDate, events, semesterEndDate, opts) {
    opts = opts || {};
    var a = normDate(startDate);
    var b = normDate(endDate) || a;
    if (!a) return [];
    var set = {};
    (events || []).forEach(function (ev) {
      if (!isEnabled(ev)) return;
      if (opts.forMutualOnly && !canMutual(ev)) return;
      var s = eventStart(ev);
      var e = effectiveEnd(ev, semesterEndDate);
      if (!s) return;
      // 區間重疊：s<=b && e>=a
      if (s > b || e < a) return;
      eventClasses(ev).forEach(function (c) { set[c] = 1; });
    });
    return Object.keys(set).sort();
  }

  /** 建議帶入的期間：可進互代事件的聯集起迄 */
  function suggestMutualRangeFromEvents(events, semesterEndDate) {
    var start = '';
    var end = '';
    (events || []).forEach(function (ev) {
      if (!isEnabled(ev) || !canMutual(ev)) return;
      var s = eventStart(ev);
      var e = effectiveEnd(ev, semesterEndDate);
      if (!s) return;
      if (!start || s < start) start = s;
      if (!end || e > end) end = e;
    });
    return { startDate: start, endDate: end === '9999-12-31' ? '' : end };
  }

  function eventsActiveOnDate(dateStr, events, semesterEndDate) {
    return (events || []).filter(function (ev) {
      return isDateInEvent(dateStr, ev, semesterEndDate);
    });
  }

  /**
   * 取得報告月內各週一（YYYY-MM-DD），最多取 reportWeeksCount 個
   * 從該月第一個週一起算
   */
  function mondaysInReportMonth(reportMonth, reportWeeksCount) {
    var ym = String(reportMonth || '').slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(ym)) return [];
    var y = parseInt(ym.slice(0, 4), 10);
    var m = parseInt(ym.slice(5, 7), 10) - 1;
    var d = new Date(y, m, 1);
    var dow = d.getDay();
    var monDiff = dow === 0 ? 1 : (dow === 1 ? 0 : 8 - dow);
    // 若 1 號已是週一 monDiff=0；若週日則下週一；其餘推到下一個週一
    // 更正：月內第一個週一
    var first = new Date(y, m, 1);
    while (first.getDay() !== 1) {
      first.setDate(first.getDate() + 1);
      if (first.getMonth() !== m) return [];
    }
    var maxW = Math.max(1, parseInt(reportWeeksCount, 10) || 4);
    var out = [];
    var cur = new Date(first.getTime());
    while (out.length < maxW && cur.getMonth() === m) {
      var ys = cur.getFullYear();
      var ms = String(cur.getMonth() + 1).padStart(2, '0');
      var ds = String(cur.getDate()).padStart(2, '0');
      out.push(ys + '-' + ms + '-' + ds);
      cur.setDate(cur.getDate() + 7);
    }
    // 若不足 reportWeeksCount（跨月教學週），用連續週一補足
    while (out.length < maxW) {
      var last = out[out.length - 1];
      if (!last) break;
      var parts = last.split('-');
      var nd = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10) + 7);
      out.push(
        nd.getFullYear() + '-' +
        String(nd.getMonth() + 1).padStart(2, '0') + '-' +
        String(nd.getDate()).padStart(2, '0')
      );
    }
    return out;
  }

  /**
   * 某週一是否落在 reduce 事件生效後（monday >= start 且 monday <= end）
   */
  function mondayInReduceWindow(monday, ev, semesterEndDate) {
    if (getRule(ev) !== RULE_REDUCE) return false;
    if (!isEnabled(ev)) return false;
    var mon = normDate(monday);
    var s = eventStart(ev);
    var e = effectiveEnd(ev, semesterEndDate);
    if (!mon || !s) return false;
    return mon >= s && mon <= e;
  }

  /**
   * 教師基礎課表中，屬於「reduce 空堂班」的 1–7 節基本／兼課節數
   */
  function countReduceSlotsForTeacher(teacherEmail, allSchedules, awayClassSet) {
    var em = String(teacherEmail || '').toLowerCase();
    var n = 0;
    (allSchedules || []).forEach(function (s) {
      if (String(s.teacherEmail || '').toLowerCase() !== em) return;
      if (parseInt(s.period, 10) > 7) return;
      var attr = s.attr || '';
      if (attr !== '基本' && attr !== '兼課') return;
      var c = normClass(s.className);
      if (c && awayClassSet[c]) n++;
    });
    return n;
  }

  /**
   * 月報扣減：reduce 事件在起日後的週 × 該師對應班節數
   * @returns {number} reduceDeduction 節數（從本月超時總額扣除）
   */
  function computeReduceDeduction(opts) {
    opts = opts || {};
    var email = opts.teacherEmail;
    var allSchedules = opts.allSchedules || [];
    var events = opts.events || [];
    var semesterEnd = opts.semesterEndDate || '';
    var reportMonth = opts.reportMonth;
    var reportWeeksCount = opts.reportWeeksCount || 4;
    var mondays = mondaysInReportMonth(reportMonth, reportWeeksCount);
    if (!mondays.length) return 0;

    var total = 0;
    // 依事件加總（多事件同班不重複：先建「每個週一要扣的班集合」）
    mondays.forEach(function (mon) {
      var awaySet = {};
      events.forEach(function (ev) {
        if (!mondayInReduceWindow(mon, ev, semesterEnd)) return;
        eventClasses(ev).forEach(function (c) { awaySet[c] = 1; });
      });
      if (!Object.keys(awaySet).length) return;
      total += countReduceSlotsForTeacher(email, allSchedules, awaySet);
    });
    return total;
  }

  /**
   * 從課表掃出所有班名（排序）
   */
  function scanClassNames(allSchedules) {
    var set = {};
    (allSchedules || []).forEach(function (s) {
      var c = normClass(s.className || s['班級']);
      if (c && isPlausibleClassName(c)) set[c] = 1;
    });
    return Object.keys(set).sort(function (a, b) {
      return a.localeCompare(b, 'zh-Hant', { numeric: true });
    });
  }

  function filterClassesByGrade(classNames, gradeDigit) {
    var g = String(gradeDigit || '');
    return (classNames || []).filter(function (c) {
      var s = normClass(c);
      return s && s.charAt(0) === g && isPlausibleClassName(s);
    });
  }

  return {
    RULE_KEEP: RULE_KEEP,
    RULE_REDUCE: RULE_REDUCE,
    normClass: normClass,
    parseClassList: parseClassList,
    classListToStore: classListToStore,
    isPlausibleClassName: isPlausibleClassName,
    isEnabled: isEnabled,
    getRule: getRule,
    canMutual: canMutual,
    eventClasses: eventClasses,
    effectiveEnd: effectiveEnd,
    isDateInEvent: isDateInEvent,
    isClassAwayOnDate: isClassAwayOnDate,
    getActiveAwayClasses: getActiveAwayClasses,
    getAwayClassesInRange: getAwayClassesInRange,
    suggestMutualRangeFromEvents: suggestMutualRangeFromEvents,
    eventsActiveOnDate: eventsActiveOnDate,
    mondaysInReportMonth: mondaysInReportMonth,
    computeReduceDeduction: computeReduceDeduction,
    scanClassNames: scanClassNames,
    filterClassesByGrade: filterClassesByGrade
  };
})();
