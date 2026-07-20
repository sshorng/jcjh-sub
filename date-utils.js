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

  function getPeriodTimeSpan(p) {
    // 建成國中課堂時間表
    const times = {
      1: '08:30-09:15',
      2: '09:25-10:10',
      3: '10:20-11:05',
      4: '11:15-12:00',
      5: '13:20-14:05',
      6: '14:15-15:00',
      7: '15:15-16:00',
      8: '16:10-16:55'
    };
    return times[p] || '';
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
    getWeekDatesFromDate
  };
})();
