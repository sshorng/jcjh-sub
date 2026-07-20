/**
 * 日期／節次純工具 (date-utils.js)
 */
window.DateUtils = (function () {
  function toLocalDateStr(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + d;
  }

  function getTodayString() {
    return toLocalDateStr(new Date());
  }

  function getWeekDayText(d) {
    const days = { 1: '一', 2: '二', 3: '三', 4: '四', 5: '五' };
    return days[d] || '';
  }

  function formatDateMMDD(dateStr) {
    if (!dateStr) return '';
    const parts = String(dateStr).split('-');
    if (parts.length < 3) return dateStr;
    return parts[1] + '/' + parts[2];
  }

  /**
   * 課表節次列（含午休）
   * 午休內部代碼 45，顯示「午休」，時段 12:35–13:15（第4節與第5節之間）
   */
  var TIMETABLE_PERIODS = [1, 2, 3, 4, 45, 5, 6, 7, 8];
  var LUNCH_PERIOD = 45;

  function getTimetablePeriods() {
    return TIMETABLE_PERIODS.slice();
  }

  function isLunchPeriod(p) {
    var n = parseInt(p, 10);
    return n === LUNCH_PERIOD || n === 0 && String(p).trim() === '0';
  }

  /** 解析節次：1–8、45／午休／午／lunch */
  function parsePeriod(raw) {
    if (raw == null || raw === '') return NaN;
    var s = String(raw).trim();
    if (/^(午休|午|lunch|LUNCH)$/i.test(s)) return LUNCH_PERIOD;
    if (s === '45' || s === '0') return LUNCH_PERIOD;
    var n = parseInt(s, 10);
    if (n === LUNCH_PERIOD) return LUNCH_PERIOD;
    if (!isNaN(n) && n >= 1 && n <= 8) return n;
    return NaN;
  }

  function isValidPeriod(p) {
    var n = parsePeriod(p);
    return !isNaN(n) && (n === LUNCH_PERIOD || (n >= 1 && n <= 8));
  }

  /** 顯示用節次標籤 */
  function getPeriodLabel(p) {
    var n = parseInt(p, 10);
    if (n === LUNCH_PERIOD) return '午休';
    if (!isNaN(n) && n >= 1 && n <= 8) return String(n);
    return String(p == null ? '' : p);
  }

  /** 「第N節」文案（午休不寫「第」） */
  function formatPeriodText(p) {
    var n = parseInt(p, 10);
    if (n === LUNCH_PERIOD) return '午休';
    if (!isNaN(n) && n >= 1 && n <= 8) return '第' + n + '節';
    return String(p == null ? '' : p);
  }

  function getPeriodTimeSpan(p) {
    // 建成國中課堂時間表（含午休抽離／特教／資優）
    const times = {
      1: '08:30-09:15',
      2: '09:25-10:10',
      3: '10:20-11:05',
      4: '11:15-12:00',
      45: '12:35-13:15',
      5: '13:20-14:05',
      6: '14:15-15:00',
      7: '15:15-16:00',
      8: '16:10-16:55'
    };
    var n = parseInt(p, 10);
    return times[n] || times[p] || '';
  }

  /**
   * 併班：班級欄可填多班（701、702／701/702／701,702）
   * 回傳淨化後的班級字串陣列
   */
  function parseCombinedClasses(raw) {
    if (raw == null || raw === '') return [];
    if (Array.isArray(raw)) {
      return raw.map(function (x) { return String(x || '').trim(); })
        .filter(function (x) { return x && !/^0+$/.test(x); });
    }
    return String(raw)
      .split(/[、,，/／|｜\s]+/)
      .map(function (s) { return s.trim(); })
      .filter(function (s) { return s && !/^0+$/.test(s); });
  }

  /** 顯示用：多班以頓號連接 */
  function formatClassName(raw) {
    var list = parseCombinedClasses(raw);
    return list.join('、');
  }

  function isCombinedClass(raw) {
    return parseCombinedClasses(raw).length > 1;
  }

  /** 迴圈用：優先課表全節次（含午休） */
  function forEachTimetablePeriod(fn) {
    var list = getTimetablePeriods();
    for (var i = 0; i < list.length; i++) fn(list[i], i);
  }

  /** 僅 1–8（連堂／大鐘點等不計午休） */
  function forEachCorePeriod(fn) {
    for (var p = 1; p <= 8; p++) fn(p);
  }

  /**
   * 星期+節次鍵：一律「日-節」（如 1-4、2-45）
   * 勿用字串拼接 day+period（午休 45 會變成 145，slice 解析錯）
   */
  function encodeTimeKey(dayOfWeek, period) {
    var d = parseInt(dayOfWeek, 10);
    var p = parsePeriod(period);
    if (isNaN(d) || isNaN(p)) return '';
    return d + '-' + p;
  }

  function decodeTimeKey(key) {
    var s = String(key == null ? '' : key).trim();
    if (!s) return { day: NaN, period: NaN };
    // 新格式 day-period
    if (s.indexOf('-') >= 0) {
      var parts = s.split('-');
      return {
        day: parseInt(parts[0], 10),
        period: parsePeriod(parts[1])
      };
    }
    // 舊格式：一位星期 + 一位節次（1–8）
    if (/^[1-5][1-8]$/.test(s)) {
      return { day: parseInt(s.charAt(0), 10), period: parseInt(s.charAt(1), 10) };
    }
    // 舊格式誤接午休：145 → 1 + 45
    if (/^[1-5]45$/.test(s)) {
      return { day: parseInt(s.charAt(0), 10), period: LUNCH_PERIOD };
    }
    return { day: NaN, period: NaN };
  }

  /** 班級字串是否包含目標班（併班 701、702 含 701） */
  function classListIncludes(classField, targetClass) {
    var target = String(targetClass || '').trim();
    if (!target) return false;
    var list = parseCombinedClasses(classField);
    if (!list.length) return String(classField || '').trim() === target;
    return list.indexOf(target) !== -1;
  }

  /** 取得 dateStr 所在週一至週五的 YYYY-MM-DD 陣列 */
  function getWeekDatesFrom(dateStr) {
    const dates = [];
    const current = new Date(String(dateStr).indexOf('T') >= 0 ? dateStr : dateStr + 'T00:00:00');
    if (Number.isNaN(current.getTime())) {
      const fallback = new Date(String(dateStr).replace(/-/g, '/'));
      return getWeekDatesFromDate(fallback);
    }
    return getWeekDatesFromDate(current);
  }

  function getWeekDatesFromDate(current) {
    const dates = [];
    const day = current.getDay();
    const mondayDiff = day === 0 ? -6 : 1 - day;
    const monday = new Date(current);
    monday.setDate(current.getDate() + mondayDiff);
    for (let i = 0; i < 5; i++) {
      const next = new Date(monday);
      next.setDate(monday.getDate() + i);
      dates.push(toLocalDateStr(next));
    }
    return dates;
  }

  return {
    toLocalDateStr,
    getTodayString,
    getWeekDayText,
    formatDateMMDD,
    getPeriodTimeSpan,
    getWeekDatesFrom,
    getWeekDatesFromDate,
    TIMETABLE_PERIODS,
    LUNCH_PERIOD,
    getTimetablePeriods,
    isLunchPeriod,
    parsePeriod,
    isValidPeriod,
    getPeriodLabel,
    formatPeriodText,
    parseCombinedClasses,
    formatClassName,
    isCombinedClass,
    forEachTimetablePeriod,
    forEachCorePeriod,
    encodeTimeKey,
    decodeTimeKey,
    classListIncludes
  };
})();
