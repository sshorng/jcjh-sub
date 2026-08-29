/**
 * 全校日期節次對調領域邏輯。
 * 固定週課表仍以「星期／節次」保存，只有指定日期的顯示與媒合解析套用例外。
 */
window.DomainSchoolSwap = (function () {
  function pick(row, names) {
    var source = row || {};
    for (var i = 0; i < names.length; i++) {
      var value = source[names[i]];
      if (value !== undefined && value !== null && value !== '') return value;
    }
    return '';
  }

  function asDate(value) {
    var text = String(value == null ? '' : value).trim().slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : '';
  }

  function asPeriod(value) {
    var period = parseInt(value, 10);
    return period === 0 || period === 45 || (period >= 1 && period <= 8) ? period : null;
  }

  function asWeekday(dateStr, value) {
    var day = parseInt(value, 10);
    if (day >= 1 && day <= 5) return day;
    var parts = String(dateStr || '').split('-').map(function (x) { return parseInt(x, 10); });
    if (parts.length !== 3 || parts.some(function (x) { return isNaN(x); })) return 0;
    var date = new Date(parts[0], parts[1] - 1, parts[2]);
    var weekday = date.getDay();
    return weekday === 0 ? 7 : weekday;
  }

  function asBool(value) {
    if (value === undefined || value === null || value === '') return true;
    var text = String(value).trim().toLowerCase();
    return !(value === false || text === 'false' || text === '0' || text === '否'
      || text === 'no' || text === '停用' || text === 'off');
  }

  function normalizeRow(row) {
    var dateA = asDate(pick(row, ['日期A', 'dateA']));
    var dateB = asDate(pick(row, ['日期B', 'dateB']));
    var periodA = asPeriod(pick(row, ['節次A', 'periodA']));
    var periodB = asPeriod(pick(row, ['節次B', 'periodB']));
    if (!dateA || !dateB || periodA === null || periodB === null) return null;
    return {
      id: String(pick(row, ['對調ID', 'id', 'swapId']) || '').trim(),
      semesterId: String(pick(row, ['學期代號', 'semesterId']) || '').trim(),
      name: String(pick(row, ['事件名稱', 'name', 'title']) || '').trim() || '全校對調',
      dateA: dateA,
      dayA: asWeekday(dateA, pick(row, ['星期A', 'dayA'])),
      periodA: periodA,
      dateB: dateB,
      dayB: asWeekday(dateB, pick(row, ['星期B', 'dayB'])),
      periodB: periodB,
      enabled: asBool(pick(row, ['啟用', 'enabled'])),
      note: String(pick(row, ['備註', 'note']) || '').trim(),
      createdAt: String(pick(row, ['建立時間', 'createdAt']) || '').trim(),
      updatedAt: String(pick(row, ['更新時間', 'updatedAt']) || '').trim()
    };
  }

  function normalizeRows(rows) {
    return (rows || []).map(normalizeRow).filter(function (row) { return !!row; });
  }

  function slotKey(dateStr, period) {
    return String(dateStr || '') + '|' + String(parseInt(period, 10));
  }

  function buildIndex(rows) {
    var normalized = normalizeRows(rows);
    var bySlot = {};
    normalized.forEach(function (row) {
      if (!row.enabled) return;
      var aKey = slotKey(row.dateA, row.periodA);
      var bKey = slotKey(row.dateB, row.periodB);
      if (!bySlot[aKey]) {
        bySlot[aKey] = {
          row: row,
          endpoint: 'A',
          sourceDay: row.dayB,
          sourcePeriod: row.periodB
        };
      }
      if (!bySlot[bKey]) {
        bySlot[bKey] = {
          row: row,
          endpoint: 'B',
          sourceDay: row.dayA,
          sourcePeriod: row.periodA
        };
      }
    });
    return { rows: normalized, bySlot: bySlot };
  }

  function resolveSlot(index, dateStr, dayOfWeek, period) {
    var actualDay = parseInt(dayOfWeek, 10);
    var actualPeriod = parseInt(period, 10);
    var hit = index && index.bySlot ? index.bySlot[slotKey(dateStr, actualPeriod)] : null;
    if (!hit) {
      return {
        dayOfWeek: actualDay,
        period: actualPeriod,
        row: null,
        endpoint: ''
      };
    }
    return {
      dayOfWeek: hit.sourceDay,
      period: hit.sourcePeriod,
      row: hit.row,
      endpoint: hit.endpoint
    };
  }

  function isPatrolSchedule(row) {
    if (!row) return false;
    if (row.isPatrol === true) return true;
    var attr = String(pick(row, ['課堂屬性', 'attr']) || '').trim();
    var className = String(pick(row, ['班級', 'className']) || '').trim();
    var subject = String(pick(row, ['科目', 'subject']) || '').trim();
    return attr === '巡堂' || attr.indexOf('巡堂') >= 0
      || className === '巡堂' || subject === '巡堂';
  }

  function scheduleRowsAtSlot(scheduleIndex, allSchedules, teacherEmail, dayOfWeek, period, dateStr) {
    var email = String(teacherEmail || '').toLowerCase();
    var key = email + '|' + parseInt(dayOfWeek, 10) + '|' + parseInt(period, 10);
    var rows;
    if (scheduleIndex && scheduleIndex.byTeacherSlot && scheduleIndex.byTeacherSlot[key]) {
      rows = scheduleIndex.byTeacherSlot[key];
    } else {
      rows = (allSchedules || []).filter(function (row) {
        return String(row && (row.teacherEmail || row['教師Email'] || row.teacherName) || '').toLowerCase() === email
          && parseInt(row.dayOfWeek != null ? row.dayOfWeek : row['星期'], 10) === parseInt(dayOfWeek, 10)
          && parseInt(row.period != null ? row.period : row['節次'], 10) === parseInt(period, 10);
      });
    }
    if (dateStr && window.DomainSchedule && window.DomainSchedule.filterActiveRows) {
      return window.DomainSchedule.filterActiveRows(rows, dateStr);
    }
    return rows;
  }

  // 巡堂是教師原地勤務，不隨全校課表對調移動。
  function resolveSlotForTeacher(index, dateStr, dayOfWeek, period, teacherEmail, scheduleIndex, allSchedules) {
    var resolved = resolveSlot(index, dateStr, dayOfWeek, period);
    if (!teacherEmail || !resolved.row) return resolved;
    var actualRows = scheduleRowsAtSlot(scheduleIndex, allSchedules, teacherEmail, dayOfWeek, period, dateStr);
    var sourceRows = scheduleRowsAtSlot(scheduleIndex, allSchedules, teacherEmail, resolved.dayOfWeek, resolved.period, dateStr);
    if (actualRows.some(isPatrolSchedule) || sourceRows.some(isPatrolSchedule)) {
      return {
        dayOfWeek: parseInt(dayOfWeek, 10),
        period: parseInt(period, 10),
        row: null,
        endpoint: ''
      };
    }
    return resolved;
  }

  function getForSlot(index, dateStr, period) {
    var hit = index && index.bySlot ? index.bySlot[slotKey(dateStr, period)] : null;
    return hit ? hit.row : null;
  }

  function label(row, formatDate, formatPeriod) {
    if (!row) return '';
    var date = typeof formatDate === 'function' ? formatDate : function (x) { return x; };
    var period = typeof formatPeriod === 'function' ? formatPeriod : function (x) { return '第' + x + '節'; };
    return row.name + '：' + date(row.dateA) + ' ' + period(row.periodA)
      + ' ⇄ ' + date(row.dateB) + ' ' + period(row.periodB);
  }

  return {
    normalizeRow: normalizeRow,
    normalizeRows: normalizeRows,
    buildIndex: buildIndex,
    resolveSlot: resolveSlot,
    resolveSlotForTeacher: resolveSlotForTeacher,
    isPatrolSchedule: isPatrolSchedule,
    getForSlot: getForSlot,
    label: label,
    slotKey: slotKey
  };
})();
