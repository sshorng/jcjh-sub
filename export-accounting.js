/*
 * 會計核銷版 Excel 匯出
 *
 * 這個模組只負責兩件事：
 * 1. 依現有前端資料產生五類核銷資料與匯出前摘要。
 * 2. 載入去識別化的會計範本，保留版面後寫入資料。
 *
 * 扣勞健保／實際金額刻意保持空白，避免在系統尚無扣款來源時誤算。
 */
(function (root) {
  'use strict';

  var TEMPLATE_URL = 'templates/accounting-template.xlsx';
  var STORAGE_KEY = 'school-substitution-accounting-periods-v1';
  var FEE_DEFAULT = 455;
  var DAY_NAMES = ['日', '一', '二', '三', '四', '五', '六'];
  var PERIOD_NAMES = {
    '0': '早自習',
    '1': '一',
    '2': '二',
    '3': '三',
    '4': '四',
    '5': '五',
    '6': '六',
    '7': '七',
    '8': '八',
    '45': '午休'
  };

  var SHEET_CONFIG = {
    overtime: {
      index: 0,
      key: 'overtime',
      label: '超鐘點',
      suffix: '超鐘點',
      titleSuffix: '超鐘點（計畫）印領清冊',
      dataStart: 3,
      templateTotalRow: 28,
      columns: 15,
      kind: 'summary'
    },
    adjunct: {
      index: 1,
      key: 'adjunct',
      label: '兼課教師鐘點',
      suffix: '兼課',
      titleSuffix: '教師兼課費印領清冊',
      dataStart: 3,
      templateTotalRow: 10,
      columns: 14,
      kind: 'summary'
    },
    publicSub: {
      index: 2,
      key: 'publicSub',
      label: '公付代課',
      suffix: '公假代課',
      titleSuffix: '公假代課鐘點費印領清冊',
      dataStart: 3,
      templateTotalRow: 14,
      columns: 15,
      kind: 'public'
    },
    selfSub: {
      index: 3,
      key: 'selfSub',
      label: '自付代課',
      suffix: '  自付代課',
      titleSuffix: '自付代課鐘點費',
      dataStart: 3,
      templateTotalRow: 14,
      columns: 10,
      kind: 'line'
    },
    mentor: {
      index: 4,
      key: 'mentor',
      label: '代導鐘點',
      suffix: '代導鐘點',
      titleSuffix: '公付代導師鐘點費',
      dataStart: 3,
      templateTotalRow: 11,
      columns: 10,
      kind: 'line'
    }
  };

  var PERIOD_OPTIONS = [
    { key: 'overtime', label: '超鐘點' },
    { key: 'adjunct', label: '兼課教師鐘點' },
    { key: 'publicSub', label: '公付代課' },
    { key: 'selfSub', label: '自付代課' },
    { key: 'mentor', label: '代導鐘點' }
  ];

  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function isIsoDate(value) {
    return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
  }

  function dateObj(value) {
    var s = String(value || '').slice(0, 10);
    if (!isIsoDate(s)) return null;
    var p = s.split('-').map(Number);
    var d = new Date(p[0], p[1] - 1, p[2]);
    if (d.getFullYear() !== p[0] || d.getMonth() !== p[1] - 1 || d.getDate() !== p[2]) return null;
    return d;
  }

  function isoDate(d) {
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  function monthEnd(month) {
    var parts = String(month || '').split('-').map(Number);
    if (parts.length !== 2 || !parts[0] || !parts[1]) return '';
    return parts[0] + '-' + pad2(parts[1]) + '-' + pad2(new Date(parts[0], parts[1], 0).getDate());
  }

  function monthStart(month) {
    return /^\d{4}-\d{2}$/.test(String(month || '')) ? String(month) + '-01' : '';
  }

  function defaultPeriod(month) {
    var start = monthStart(month);
    var end = monthEnd(month);
    return { start: start, end: end };
  }

  function defaultPeriodSettings(month) {
    return defaultPeriod(month);
  }

  function normalizePeriod(period, fallback) {
    var p = period || {};
    var start = isIsoDate(p.start) ? p.start : fallback.start;
    var end = isIsoDate(p.end) ? p.end : fallback.end;
    if (!dateObj(start) || !dateObj(end) || start > end) {
      return { start: fallback.start, end: fallback.end };
    }
    return { start: start, end: end };
  }

  function loadPeriodSettings(month) {
    var fallback = defaultPeriod(month);
    var saved = null;
    try {
      if (root.localStorage) saved = JSON.parse(root.localStorage.getItem(STORAGE_KEY) || '{}');
    } catch (e) {
      saved = null;
    }
    var monthSaved = saved && saved[month] ? saved[month] : {};
    if (monthSaved.period && (isIsoDate(monthSaved.period.start) || isIsoDate(monthSaved.period.end))) {
      return normalizePeriod(monthSaved.period, fallback);
    }
    if (isIsoDate(monthSaved.start) || isIsoDate(monthSaved.end)) {
      return normalizePeriod(monthSaved, fallback);
    }
    for (var i = 0; i < PERIOD_OPTIONS.length; i += 1) {
      var legacy = monthSaved[PERIOD_OPTIONS[i].key];
      if (legacy && (isIsoDate(legacy.start) || isIsoDate(legacy.end))) {
        return normalizePeriod(legacy, fallback);
      }
    }
    return fallback;
  }

  function savePeriodSettings(month, settings) {
    try {
      if (!root.localStorage) return;
      var all = JSON.parse(root.localStorage.getItem(STORAGE_KEY) || '{}');
      var fallback = defaultPeriod(month);
      var source = settings && (settings.period || settings);
      all[month] = { period: normalizePeriod(source, fallback) };
      root.localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
    } catch (e) {
      // 私密瀏覽或瀏覽器封鎖 localStorage 時，匯出仍可繼續。
    }
  }

  function getPeriod(settings, key, month) {
    var fallback = defaultPeriod(month);
    var source = settings || {};
    var unified = source.period || source;
    if (isIsoDate(unified.start) || isIsoDate(unified.end)) {
      return normalizePeriod(unified, fallback);
    }
    return normalizePeriod(source[key], fallback);
  }

  function dateInPeriod(value, period) {
    var s = String(value || '').slice(0, 10).replace(/\//g, '-');
    return isIsoDate(s) && s >= period.start && s <= period.end;
  }

  function periodWeekCount(period) {
    var start = dateObj(period.start);
    var end = dateObj(period.end);
    if (!start || !end || start > end) return 0;
    var keys = {};
    var d = new Date(start);
    while (d <= end) {
      var dow = d.getDay();
      var monday = new Date(d);
      monday.setDate(d.getDate() - (dow === 0 ? 6 : dow - 1));
      keys[isoDate(monday)] = true;
      d.setDate(d.getDate() + 1);
    }
    return Object.keys(keys).length;
  }

  function rocYear(year) {
    return Number(year) - 1911;
  }

  function reportParts(reportMonth) {
    var parts = String(reportMonth || '').split('-').map(Number);
    return { year: parts[0] || new Date().getFullYear(), month: parts[1] || (new Date().getMonth() + 1) };
  }

  function rangeLabel(period) {
    var a = dateObj(period.start);
    var b = dateObj(period.end);
    if (!a || !b) return '';
    return (a.getMonth() + 1) + '/' + a.getDate() + '-' + (b.getMonth() + 1) + '/' + b.getDate();
  }

  function normalizeExpensePlan(value) {
    return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  }

  function teacherExpensePlan(teacher) {
    return normalizeExpensePlan(teacher && (
      teacher.expensePlan || teacher['鐘點支出計畫'] || teacher['鐘點支出來源']
      || teacher['支出計畫'] || teacher['計畫'] || teacher.plan || ''
    ));
  }

  function planLabel(value) {
    return normalizeExpensePlan(value) || '預設';
  }

  function titleFor(config, reportMonth, period, expensePlan) {
    var parts = reportParts(reportMonth);
    var range = rangeLabel(period);
    var suffix = config.titleSuffix;
    if (config.key === 'overtime') {
      var plan = normalizeExpensePlan(expensePlan);
      suffix = plan ? '超鐘點（' + plan + '）印領清冊' : '超鐘點印領清冊';
    }
    if (config.key === 'selfSub' || config.key === 'mentor') {
      return '臺北市立建成國民中學' + rocYear(parts.year) + '年' + parts.month + '月(' + range + ')' + suffix;
    }
    return '臺北市立建成國中' + rocYear(parts.year) + '年' + parts.month + '月(' + range + ')' + suffix;
  }

  function safeSheetPart(value) {
    return normalizeExpensePlan(value).replace(/[\\/:*?\[\]]/g, '-').trim();
  }

  function sheetName(config, reportMonth, period, expensePlan) {
    var parts = reportParts(reportMonth);
    var a = dateObj(period.start);
    var b = dateObj(period.end);
    var prefix = rocYear(parts.year) + '.' + (a ? (a.getMonth() + 1) : parts.month) + '.' + (a ? a.getDate() : 1)
      + '-' + (b ? (b.getMonth() + 1) : parts.month) + '.' + (b ? b.getDate() : 31);
    var planSuffix = config.key === 'overtime' && normalizeExpensePlan(expensePlan)
      ? '-' + safeSheetPart(expensePlan)
      : '';
    var name = prefix + config.suffix + planSuffix;
    return name.slice(0, 31);
  }

  function teacherEmail(value) {
    if (value && typeof value === 'object') {
      value = value.email || value['\u6559\u5e2bEmail'] || value.teacherEmail || '';
    }
    return String(value || '').trim().toLowerCase();
  }

  function teacherName(teacher, fallback) {
    if (typeof teacher === 'string') return String(teacher || fallback || '').trim();
    return String((teacher && (teacher.name || teacher['\u6559\u5e2b\u59d3\u540d'] || teacher.teacherName)) || fallback || '').trim();
  }

  function teacherTitle(teacher) {
    return String((teacher && (teacher.jobTitle || teacher.title || teacher['\u8077\u52d9'] || teacher['\u8077\u7a31'] || teacher['\u8077\u4f4d'] || teacher.teacherTitle)) || '').trim();
  }

  function addTeacherToMap(map, teacher) {
    var email = teacherEmail(teacher);
    var name = teacherName(teacher, '');
    if (email) map[email] = teacher;
    if (name) map['name:' + name] = teacher;
  }

  function teacherFromMap(map, email, name) {
    return (map && (map[teacherEmail(email)] || map['name:' + String(name || '').trim()])) || {};
  }
  function isAdjunctTeacher(teacher) {
    return teacherTitle(teacher).indexOf('兼課') >= 0;
  }

  function feeRate(record, fallback) {
    var n = Number(record && (record.feeAmount || record.rate || record['鐘點費']));
    return Number.isFinite(n) && n > 0 ? n : (fallback || FEE_DEFAULT);
  }

  function periodCount(record, mentor) {
    var n = Number(record && (record.periodCount || record['合計節數']));
    if (Number.isFinite(n) && n >= 0) return n;
    return mentor ? 0.8 : 1;
  }

  function periodText(value) {
    var raw = String(value == null ? '' : value).trim();
    if (!raw || raw === '代導') return raw === '代導' ? '' : '';
    return PERIOD_NAMES[raw] || raw;
  }

  function rocDate(value) {
    var d = dateObj(value);
    if (!d) return String(value || '');
    return rocYear(d.getFullYear()) + '.' + pad2(d.getMonth() + 1) + '.' + pad2(d.getDate()) + '(' + DAY_NAMES[d.getDay()] + ')';
  }

  function shortDate(value) {
    var normalized = String(value || '').slice(0, 10).replace(/\//g, '-');
    var d = dateObj(normalized);
    return d ? (d.getMonth() + 1) + '/' + d.getDate() : String(value || '').trim();
  }

  function lookupTeacherName(opts, email, fallback) {
    var key = teacherEmail(email);
    if (opts && typeof opts.getTeacherNameByEmail === 'function' && key) {
      try {
        var fromLookup = opts.getTeacherNameByEmail(email);
        if (fromLookup) return String(fromLookup).trim();
      } catch (e) {
        // 名稱查詢失敗時回退到教師清單。
      }
    }
    var found = (opts && opts.teachers || []).find(function (t) {
      return teacherEmail(t && t.email) === key;
    });
    return teacherName(found, fallback || email);
  }

  function displayCount(value) {
    var n = Number(value);
    if (!Number.isFinite(n)) return '0';
    return String(Math.round(n * 10) / 10).replace(/\.0$/, '');
  }

  function uniqueNotes(notes) {
    var seen = {};
    return (notes || []).map(function (note) {
      return cleanAccountingText(note);
    }).filter(function (note) {
      if (!note || seen[note]) return false;
      seen[note] = true;
      return true;
    });
  }

  function joinAccountingNotes(notes) {
    var list = uniqueNotes(notes);
    if (list.length <= 1) return list[0] || '';
    return list.map(function (note, index) {
      return (index + 1) + '、' + note;
    }).join('\n');
  }

  function noteDates(records) {
    return (records || []).map(function (record) {
      return shortDate(record.date);
    }).filter(Boolean).filter(function (date, index, all) {
      return all.indexOf(date) === index;
    }).join('、');
  }

  function notePeriodCount(records) {
    return (records || []).reduce(function (sum, record) {
      return sum + periodCount(record, false);
    }, 0);
  }

  function groupedCoverNoteParts(records, opts) {
    var groups = {};
    var order = [];
    (records || []).slice().sort(function (a, b) {
      return String(a.date || '').localeCompare(String(b.date || ''))
        || String(a.originalTeacherEmail || '').localeCompare(String(b.originalTeacherEmail || ''));
    }).forEach(function (record) {
      var name = lookupTeacherName(opts, record.originalTeacherEmail, record.originalTeacherName || '');
      var key = teacherEmail(record.originalTeacherEmail) + '|' + name;
      if (!groups[key]) {
        groups[key] = { name: name, dates: [], count: 0 };
        order.push(key);
      }
      var group = groups[key];
      var date = shortDate(record.date);
      if (date && group.dates.indexOf(date) < 0) group.dates.push(date);
      group.count += periodCount(record, false);
    });
    return order.map(function (key) {
      var group = groups[key];
      var dates = group.dates.join('、');
      var name = group.name ? '代' + group.name : '代課';
      return dates + name + displayCount(group.count) + '節';
    }).filter(Boolean);
  }

  function deductionReasonLabel(record, fallback) {
    var value = reason(record);
    if (!value) return fallback;
    if (value.indexOf('\u516c\u5047') >= 0 || value.indexOf('\u516c\u5dee') >= 0) return '\u516c\u5047';
    if (value.indexOf('\u4e8b\u5047') >= 0) return '\u4e8b\u5047';
    if (value.indexOf('\u75c5\u5047') >= 0) return '\u75c5\u5047';
    if (value.indexOf('\u88dc\u4f11') >= 0) return '\u88dc\u4f11';
    return value;
  }

  function leaveNoteParts(records, publicUsed) {
    var groups = {};
    var order = [];
    (records || []).filter(function (record) {
      return isSelfPaidRecord(record) || isPublicOvertimeRecord(record);
    }).slice().sort(function (a, b) {
      return String(a.date || '').localeCompare(String(b.date || ''));
    }).forEach(function (record) {
      var fallback = isSelfPaidRecord(record) ? '\u81ea\u4ed8' : '\u516c\u5047';
      var label = deductionReasonLabel(record, fallback);
      if (!groups[label]) {
        groups[label] = { label: label, dates: [], count: 0 };
        order.push(label);
      }
      var group = groups[label];
      var date = shortDate(record.date);
      if (date && group.dates.indexOf(date) < 0) group.dates.push(date);
      group.count += periodCount(record, false);
    });
    return order.map(function (label) {
      var group = groups[label];
      return group.dates.join('\u3001') + group.label + '\u6263' + displayCount(group.count) + '\u7bc0';
    }).filter(Boolean);
  }
  function legacySelfSubNoteParts(value) {
    var raw = cleanAccountingText(value);
    if (!raw || raw === '無') return [];
    return raw.split(/\s*,\s*|\s*，\s*/).map(function (part) {
      var match = part.match(/^(.+?)\((\d{1,2})-(\d{1,2})\)$/);
      return match ? Number(match[2]) + '/' + Number(match[3]) + '代' + match[1] + '1節' : part;
    }).filter(Boolean);
  }

  function summaryNote(opts, source, period, leaveRecords, publicUsed) {
    var email = teacherEmail(source && source.email);
    var actualRecords = (opts.substitutionRecords || []).filter(function (record) {
      return isUsableSubstitution(record)
        && dateInPeriod(record.date, period)
        && teacherEmail(record.actualTeacherEmail) === email
        && isWeeklyPeriod(record.period);
    });
    var notes = groupedCoverNoteParts(actualRecords, opts);
    if (!actualRecords.length) notes = notes.concat(legacySelfSubNoteParts(source && source.selfSubDetail));
    var chargedRecords = chargedSubstitutionRecords(opts.substitutionRecords || [], opts.allSchedules || [], source && source.email, period, source && source.weeklyOvertime);
    notes = notes.concat(leaveNoteParts(chargedRecords, publicUsed));
    if (source && source.note) notes.push(source.note);
    return joinAccountingNotes(notes);
  }
  function recordStatus(record) {
    return String(record && (record.status || record['狀態']) || '').trim().toLowerCase();
  }

  function isApprovedActive(record) {
    var status = recordStatus(record);
    if (!status) return true;
    var good = ['approved', 'active', 'effective', 'approved_active', '核准生效', '已核准', '核准', '已生效', '生效', '有效', '啟用'];
    var bad = ['pending_teacher', 'pending_admin', 'rejected', 'admin_rejected', 'cancelled', 'withdrawn', '待受邀人簽核', '待行政審核', '受邀人已拒絕', '行政已退回', '已取消', '已撤銷', '已撤回'];
    if (good.indexOf(status) >= 0) return true;
    if (bad.indexOf(status) >= 0) return false;
    return false;
  }

  function isActiveHomeroom(record) {
    if (!record || record.enabled === false) return false;
    var status = recordStatus(record);
    if (!status) return true;
    var bad = ['cancelled', 'withdrawn', 'rejected', 'admin_rejected', '已取消', '已撤銷', '已撤回', '撤銷', '撤回'];
    if (bad.indexOf(status) >= 0) return false;
    var good = ['approved', 'active', 'effective', 'approved_active', 'assigned', '核准生效', '已核准', '核准', '已生效', '生效', '有效', '啟用', '已指定', '已指派', '已分派', '指定'];
    return good.indexOf(status) >= 0 || !!record.actualTeacherEmail;
  }

  function subFee(record) {
    return String(record && (record.subFee || record['經費來源']) || '').trim();
  }

  function reason(record) {
    return String(record && (record.reason || record['請假事由']) || '').trim();
  }

  function cleanAccountingText(value) {
    return String(value == null ? '' : value)
      .replace(/\[直接核准\]|【直接核准】|［直接核准］/g, '')
      .split(/\r?\n/)
      .map(function (line) {
        return line
          .replace(/[ \t]{2,}/g, ' ')
          .replace(/[ \t]*([；;、,，])[ \t]*/g, '$1')
          .trim();
      })
      .filter(Boolean)
      .join('\n')
      .trim();
  }

  function isPublic(record) {
    var fee = subFee(record);
    var why = reason(record);
    if (['\u516c\u8cbb\u4ee3\u8ab2', '\u5b78\u6821\u79fb\u64a5', '\u6d3b\u52d5\u516c\u8cbb', '\u516c\u8cbb', '\u4ee3\u8ab2\u8cbb'].indexOf(fee) >= 0) return true;
    if (['\u81ea\u8cbb\u4ee3\u8ab2', '\u81ea\u8cbb'].indexOf(fee) >= 0) return false;
    if (/\u516c\u5047\u81ea\u7406|\u4e8b\u5047|\u75c5\u5047|\u88dc\u4f11/.test(why)) return false;
    return true;
  }

  function isSelfPaidRecord(record) {
    return subFee(record) === '\u81ea\u8cbb\u4ee3\u8ab2';
  }

  function isPublicOvertimeRecord(record) {
    var fee = subFee(record);
    return fee === '\u516c\u8cbb\u4ee3\u8ab2' || fee === '\u5b78\u6821\u79fb\u64a5';
  }

  function isPublicPayoutRecord(record) {
    var fee = subFee(record);
    return isPublicOvertimeRecord(record) || fee === '\u6d3b\u52d5\u516c\u8cbb';
  }

  function isSubstitutionRecord(record) {
    var type = String(record && (record.type || record['\u7570\u52d5\u985e\u578b']) || '').trim().toLowerCase();
    return !type || type === 'substitution' || type === '\u4ee3\u8ab2';
  }
  function isWeeklyPeriod(value) {
    var n = Number(value);
    return n === 0 || n === 45 || (n >= 1 && n <= 7);
  }

  function isUsableSubstitution(record) {
    if (!record || !record.date || !isApprovedActive(record) || !isSubstitutionRecord(record)) return false;
    var fee = subFee(record);
    if (['\u6263\u984d\u5ea6', '\u4e92\u4ee3\u4e0d\u7d50', '\u7b2c8\u7bc0\u4ee3\u8ab2'].indexOf(fee) >= 0) return false;
    if (!isWeeklyPeriod(record.period)) return false;
    return true;
  }
  function dayPeriodKey(date, period) {
    var d = dateObj(date);
    if (!d) return '';
    var day = d.getDay() === 0 ? 7 : d.getDay();
    return day + '|' + Number(period);
  }

  function isOvertimeSchedule(schedule) {
    return String(schedule && schedule.attr || '').trim() === '\u8d85\u9418\u9ede';
  }
  function dayNameForWeekday(day) {
    var n = Number(day);
    return DAY_NAMES[n === 7 ? 0 : n] || '';
  }

  function scheduleText(email, allSchedules, onlyOvertime) {
    var seen = {};
    var list = (allSchedules || []).filter(function (s) {
      if (teacherEmail(s.teacherEmail) !== teacherEmail(email)) return false;
      if (!isWeeklyPeriod(s.period)) return false;
      if (onlyOvertime && !isOvertimeSchedule(s)) return false;
      return true;
    }).map(function (s) {
      return { day: Number(s.dayOfWeek) || 0, period: Number(s.period) || 0 };
    }).filter(function (x) {
      var key = x.day + '|' + x.period;
      if (seen[key]) return false;
      seen[key] = true;
      return true;
    }).sort(function (a, b) {
      return a.day - b.day || a.period - b.period;
    });
    return list.map(function (x) {
      return dayNameForWeekday(x.day) + String(x.period);
    }).filter(Boolean).join('\u3001');
  }
  function accountingClassParts(value) {
    return String(value == null ? '' : value)
      .trim()
      .split(/[、,，/／|｜\s]+/)
      .map(function (part) { return part.replace(/班$/, '').trim(); })
      .filter(function (part) {
        return part && !/^0+$/.test(part) && part !== '巡堂';
      });
  }

  function overtimeClassNote(opts, source, weeks) {
    var weekly = Number(source && source.weeklyOvertime) || 0;
    var weekCount = Number(weeks) || 0;
    if (!weekly || !weekCount) return '';

    var seen = {};
    var classes = [];
    (opts.allSchedules || []).filter(function (schedule) {
      return teacherEmail(schedule.teacherEmail) === teacherEmail(source && source.email)
        && isWeeklyPeriod(schedule.period)
        && isOvertimeSchedule(schedule);
    }).forEach(function (schedule) {
      accountingClassParts(schedule.className).forEach(function (className) {
        if (seen[className]) return;
        seen[className] = true;
        classes.push(className);
      });
    });

    classes.sort(function (a, b) {
      return a.localeCompare(b, 'zh-Hant', { numeric: true });
    });
    return classes.length
      ? weekly + '*' + weekCount + '(' + classes.join('、') + '班)'
      : '';
  }
  function fallbackReportRow(teacher, allSchedules) {
    var email = teacherEmail(teacher && teacher.email);
    var schedules = (allSchedules || []).filter(function (s) {
      return teacherEmail(s.teacherEmail) === email && isWeeklyPeriod(s.period) && String(s.attr || '') !== '巡堂';
    });
    var weeklyPeriods = schedules.length;
    var rawBase = teacher && (teacher.baseHours !== undefined ? teacher.baseHours : teacher['基本鐘點']);
    var baseHours = rawBase === 0 || rawBase === '0' ? 0 : (parseInt(rawBase, 10) || 16);
    return {
      email: email,
      name: teacherName(teacher, email),
      subject: teacher && (teacher.subject || teacher['授課科目']) || '',
      weeklyPeriods: weeklyPeriods,
      baseHours: baseHours,
      weeklyOvertime: Math.max(0, weeklyPeriods - baseHours),
      reduceDeduction: 0,
      actualOvertime: 0,
      selfPaidDeduction: 0,
      publicOvertimeUsed: 0,
      overtimeFee: 0,
      selfSubDetail: '無',
      expensePlan: teacherExpensePlan(teacher)
    };
  }

  function reportSourceRows(opts) {
    var teachers = opts.teachers || [];
    var teacherMap = {};
    teachers.forEach(function (teacher) {
      teacherMap[teacherEmail(teacher && teacher.email)] = teacher;
    });
    var map = {};
    (opts.monthlyReportRows || []).forEach(function (row) {
      map[teacherEmail(row.email)] = row;
    });
    return teachers.map(function (teacher) {
      var source = map[teacherEmail(teacher.email)] || fallbackReportRow(teacher, opts.allSchedules);
      var plan = teacherExpensePlan(teacher) || normalizeExpensePlan(source.expensePlan || source['鐘點支出計畫'] || source['鐘點支出來源'] || source.plan);
      return Object.assign({}, source, { expensePlan: plan });
    });
  }
  function leaveRecordsFor(email, records, period) {
    return (records || []).filter(function (r) {
      return isUsableSubstitution(r) && dateInPeriod(r.date, period) && teacherEmail(r.originalTeacherEmail) === teacherEmail(email);
    });
  }

  function substitutionKey(record) {
    var id = record && (record.id || record.recordId || record['紀錄ID'] || record['調代課紀錄ID']);
    if (id) return 'id:' + String(id);
    return [
      teacherEmail(record && record.originalTeacherEmail),
      String(record && record.date || '').slice(0, 10),
      String(record && record.period || ''),
      String(record && (record.className || record['班級']) || '').trim(),
      teacherEmail(record && record.actualTeacherEmail),
      String(record && record.type || '')
    ].join('|');
  }

  function sameScheduleClass(record, schedule) {
    var cn = String(record && (record.className || record['班級']) || '').trim();
    var scn = String(schedule && (schedule.className || schedule['班級']) || '').trim();
    return !cn || !scn || cn === scn || cn.indexOf(scn) >= 0 || scn.indexOf(cn) >= 0;
  }

  function isOvertimeSubstitution(record, schedules) {
    var d = dateObj(record && record.date);
    var period = Number(record && record.period);
    if (!d || !Number.isFinite(period) || !isWeeklyPeriod(period)) return false;
    var dow = d.getDay() === 0 ? 7 : d.getDay();
    return (schedules || []).some(function (schedule) {
      return teacherEmail(schedule && schedule.teacherEmail) === teacherEmail(record.originalTeacherEmail)
        && Number(schedule.dayOfWeek) === dow
        && Number(schedule.period) === period
        && sameScheduleClass(record, schedule)
        && isOvertimeSchedule(schedule);
    });
  }

  function weekKeyForRecord(record) {
    var d = dateObj(record && record.date);
    if (!d) return '';
    var dow = d.getDay() === 0 ? 7 : d.getDay();
    var monday = new Date(d);
    monday.setDate(d.getDate() - (dow - 1));
    return isoDate(monday);
  }

  function chargedSubstitutionRecords(records, schedules, email, period, weeklyOvertime) {
    var eligible = (records || []).filter(function (record) {
      return isUsableSubstitution(record)
        && dateInPeriod(record.date, period)
        && teacherEmail(record.originalTeacherEmail) === teacherEmail(email)
        && teacherEmail(record.actualTeacherEmail);
    });
    // \u4f9d\u7db2\u9801\u6708\u5831\uff1a\u81ea\u8cbb\u5168\u90e8\u6263\u539f\u6559\u5e2b\u8d85\u9418\uff1b\u516c\u8cbb\u4f9d\u6b63\u5f0f\u8ab2\u7a0b\u539f\u5802\u5c6c\u6027\u70ba\u8d85\u9418\u9ede\u6642\u6263\uff0c\u542b\u65e9\u81ea\u7fd00\u30011\u81f37\u8207\u5348\u4f1145\u3002
    var selfRecords = eligible.filter(isSelfPaidRecord);
    var publicRecords = eligible.filter(function (record) {
      return isPublicOvertimeRecord(record) && isOvertimeSubstitution(record, schedules);
    });
    var selected = selfRecords.slice();
    var selfByWeek = {};
    selfRecords.forEach(function (record) {
      var week = weekKeyForRecord(record);
      selfByWeek[week] = (selfByWeek[week] || 0) + 1;
    });
    var publicByWeek = {};
    publicRecords.slice().sort(function (a, b) {
      return String(a.date || '').localeCompare(String(b.date || ''))
        || Number(a.period || 0) - Number(b.period || 0)
        || substitutionKey(a).localeCompare(substitutionKey(b));
    }).forEach(function (record) {
      var week = weekKeyForRecord(record);
      if (!publicByWeek[week]) publicByWeek[week] = [];
      publicByWeek[week].push(record);
    });
    Object.keys(publicByWeek).sort().forEach(function (week) {
      var remaining = Math.max(0, (Number(weeklyOvertime) || 0) - (selfByWeek[week] || 0));
      publicByWeek[week].slice(0, remaining).forEach(function (record) { selected.push(record); });
    });
    var seen = {};
    return selected.filter(function (record) {
      var key = substitutionKey(record);
      if (seen[key]) return false;
      seen[key] = true;
      return true;
    });
  }
  function publicOvertimeUsed(email, records, schedules, period, weeklyOvertime) {
    return chargedSubstitutionRecords(records, schedules, email, period, weeklyOvertime)
      .filter(isPublicOvertimeRecord).length;
  }
  function buildChargedRecordMap(opts, period) {
    var result = { byKey: {}, byOriginal: {} };
    var records = opts.substitutionRecords || [];
    reportSourceRows(opts).forEach(function (source) {
      if (!normalizeExpensePlan(source.expensePlan)) return;
      chargedSubstitutionRecords(records, opts.allSchedules, source.email, period, source.weeklyOvertime)
        .forEach(function (record) {
          var key = substitutionKey(record);
          var email = teacherEmail(source.email);
          var item = { record: record, source: source, plan: normalizeExpensePlan(source.expensePlan) };
          result.byKey[key] = item;
          if (!result.byOriginal[email]) result.byOriginal[email] = [];
          result.byOriginal[email].push(item);
        });
    });
    return result;
  }
  function substitutionSlotLabel(record) {
    var d = dateObj(record && record.date);
    var day = d ? dayNameForWeekday(d.getDay()) : '';
    var label = String(record && record.period || '');
    return day + label + '(\u4ee3)';
  }

  function buildOvertimeSubstitutionRow(opts, source, teacherMap, item, serial) {
    var record = item.record;
    var actualTeacher = teacherFromMap(teacherMap, record.actualTeacherEmail, record.actualTeacherName);
    var sourceTeacher = teacherFromMap(teacherMap, source.email, source.name);
    var count = periodCount(record, false);
    var rate = feeRate(record, FEE_DEFAULT);
    var originalName = teacherName(sourceTeacher, source.name || source.email);
    var feeLabel = isSelfPaidRecord(record) ? '\u81ea\u4ed8' : '\u8d85\u9418';
    var detail = shortDate(record.date) + '\u4ee3' + feeLabel + originalName + displayCount(count) + '\u7bc0';
    var className = String(record.className || record['\u73ed\u7d1a'] || '').trim();
    if (className) detail += '\uff08' + className + '\uff09';
    return {
      expensePlan: normalizeExpensePlan(source.expensePlan),
      serial: serial,
      title: teacherTitle(actualTeacher) || '\u6559\u5e2b',
      name: teacherName(actualTeacher, record.actualTeacherName || record.actualTeacherEmail),
      weeklyOvertime: count,
      schedule: substitutionSlotLabel(record),
      weeks: '',
      grossHours: count,
      deduction: 0,
      actualHours: count,
      rate: rate,
      amount: count * rate,
      reduceNote: '',
      note: detail
    };
  }
  function buildSummaryRows(config, opts, period, planFilter, chargedMap) {
    var teacherMap = {};
    (opts.teachers || []).forEach(function (t) { addTeacherToMap(teacherMap, t); });
    var records = opts.substitutionRecords || [];
    var weeks = Number(opts.reportWeeksCount) > 0 ? Number(opts.reportWeeksCount) : (periodWeekCount(period) || 1);
    var rows = [];
    var expectedPlan = config.key === 'overtime' ? normalizeExpensePlan(planFilter) : null;
    reportSourceRows(opts).forEach(function (source) {
      var t = teacherFromMap(teacherMap, source.email, source.name);
      var sourcePlan = normalizeExpensePlan(source.expensePlan || source['鐘點支出計畫'] || source.plan);
      if (config.key === 'overtime' && sourcePlan !== expectedPlan) return;
      var adjunct = isAdjunctTeacher(t);
      if (config.key === 'adjunct' ? !adjunct : adjunct) return;
      var title = teacherTitle(t) || (adjunct ? '兼課教師' : '教師');
      var leave = leaveRecordsFor(source.email, records, period);
      var selfCount = leave.filter(isSelfPaidRecord).length;
      var publicUsed = publicOvertimeUsed(source.email, records, opts.allSchedules, period, source.weeklyOvertime);
      var chargedItemsForSource = sourcePlan && chargedMap && chargedMap.byOriginal[teacherEmail(source.email)] || [];
      var chargedRecordsForSource = chargedSubstitutionRecords(records, opts.allSchedules || [], source.email, period, source.weeklyOvertime);
      var reduce = Number(source.reduceDeduction) || 0;
      if (period.start.slice(0, 7) !== String(opts.reportMonth || '') || period.end.slice(0, 7) !== String(opts.reportMonth || '')) {
        reduce = 0;
      }
      var grossHours = Math.max(0, (Number(source.weeklyOvertime) || 0) * weeks - reduce);
      var deduction = selfCount + publicUsed;
      var actualHours = grossHours - deduction;
      var rate = Number(opts.overtimeRate) || FEE_DEFAULT;
      var overtimeNotes = [overtimeClassNote(opts, source, weeks)]
        .concat(leaveNoteParts(chargedRecordsForSource, publicUsed));
      var notes = config.key === 'overtime'
        ? joinAccountingNotes(overtimeNotes)
        : summaryNote(opts, source, period, leave, publicUsed);
      var row = {
        expensePlan: sourcePlan,
        serial: rows.length + 1,
        title: title,
        name: teacherName(t, source.name),
        weeklyOvertime: Number(source.weeklyOvertime) || 0,
        schedule: scheduleText(source.email, opts.allSchedules, true),
        weeks: weeks,
        grossHours: grossHours,
        deduction: deduction,
        actualHours: actualHours,
        rate: rate,
        amount: actualHours * rate,
        reduceNote: reduce ? ('空堂調降 ' + reduce + ' 節') : '',
        note: notes
      };
      rows.push(row);
      if (config.key === 'overtime' && sourcePlan && chargedMap && chargedMap.byOriginal[teacherEmail(source.email)]) {
        chargedMap.byOriginal[teacherEmail(source.email)].forEach(function (item) {
          rows.push(buildOvertimeSubstitutionRow(opts, source, teacherMap, item, rows.length + 1));
        });
      }
    });
    return rows;
  }

  function courseText(record) {
    var cls = String(record && (record.className || record['班級']) || '').trim();
    var subj = String(record && (record.subject || record['科目']) || '').trim();
    return cls + subj;
  }

  function publicRows(opts, period, chargedMap) {
    var teacherMap = {};
    (opts.teachers || []).forEach(function (t) { addTeacherToMap(teacherMap, t); });
    var groups = {};
    (opts.substitutionRecords || []).filter(function (r) {
      return isUsableSubstitution(r) && dateInPeriod(r.date, period) && isPublicPayoutRecord(r) && r.actualTeacherEmail && !(chargedMap && chargedMap.byKey[substitutionKey(r)]);
    }).forEach(function (r) {
      var email = teacherEmail(r.actualTeacherEmail);
      if (!groups[email]) groups[email] = { email: email, records: [], hours: 0, rate: feeRate(r, FEE_DEFAULT) };
      groups[email].records.push(r);
      groups[email].hours += periodCount(r, false);
      groups[email].rate = feeRate(r, groups[email].rate);
    });
    return Object.keys(groups).sort().map(function (email, idx) {
      var group = groups[email];
      var t = teacherFromMap(teacherMap, email, group.records[0].actualTeacherName);
      var name = teacherName(t, group.records[0].actualTeacherName || email);
      return {
        serial: idx + 1,
        title: teacherTitle(t) || '\u6559\u5e2b',
        name: name,
        hours: group.hours,
        rate: group.rate,
        amount: group.hours * group.rate,
        note: joinAccountingNotes(groupedCoverNoteParts(group.records, opts))
      };
    });
  }

  function selfRows(opts, period, chargedMap) {
    var teacherMap = {};
    (opts.teachers || []).forEach(function (t) { addTeacherToMap(teacherMap, t); });
    return (opts.substitutionRecords || []).filter(function (r) {
      return isUsableSubstitution(r) && dateInPeriod(r.date, period) && isSelfPaidRecord(r) && r.actualTeacherEmail && !(chargedMap && chargedMap.byKey[substitutionKey(r)]);
    }).sort(function (a, b) {
      return String(a.date || '').localeCompare(String(b.date || '')) || Number(a.period || 0) - Number(b.period || 0);
    }).map(function (r) {
      var t = teacherFromMap(teacherMap, r.actualTeacherEmail, r.actualTeacherName);
      return {
        actualName: teacherName(t, r.actualTeacherName || r.actualTeacherEmail),
        date: rocDate(r.date),
        time: r.leaveTime || r.timeRange || '08:00-16:00',
        course: courseText(r),
        period: periodText(r.period),
        count: periodCount(r, false),
        rate: feeRate(r, FEE_DEFAULT),
        amount: periodCount(r, false) * feeRate(r, FEE_DEFAULT),
        originalName: r.originalTeacherName || teacherName(teacherFromMap(teacherMap, r.originalTeacherEmail, r.originalTeacherName), r.originalTeacherEmail),
        reason: reason(r) || subFee(r),
        note: r.note || ''
      };
    });
  }

  function mentorRows(opts, period) {
    return (opts.homeroomRecords || []).filter(function (r) {
      return isActiveHomeroom(r) && r.actualTeacherEmail && dateInPeriod(r.date, period);
    }).sort(function (a, b) {
      return String(a.date || '').localeCompare(String(b.date || ''));
    }).map(function (r) {
      var count = periodCount(r, true);
      var rate = feeRate(r, FEE_DEFAULT);
      return {
        actualName: r.actualTeacherName || r.actualTeacherEmail,
        date: rocDate(r.date),
        time: r.leaveTime || r.timeRange || '08:00-16:00',
        course: '代導',
        period: '1日',
        count: count,
        rate: rate,
        amount: count * rate,
        originalName: r.className || r.originalTeacherName || '',
        reason: r.reason || '代導公付',
        note: r.note || ''
      };
    });
  }

  function buildExportData(opts) {
    opts = opts || {};
    var periods = opts.periods || loadPeriodSettings(opts.reportMonth);
    var data = {
      periods: periods,
      sheets: {},
      overtimePlans: [],
      summary: [],
      warnings: [],
      blocking: []
    };
    var summaryFor = function (key, label, rows) {
      data.summary.push({
        key: key,
        label: label,
        count: rows.length,
        hours: rows.reduce(function (sum, row) {
          return sum + Number(row.actualHours !== undefined ? row.actualHours : (row.hours !== undefined ? row.hours : row.count)) || 0;
        }, 0),
        amount: rows.reduce(function (sum, row) {
          return sum + Number(row.amount) || 0;
        }, 0)
      });
    };

    var overtimeConfig = SHEET_CONFIG.overtime;
    var overtimePeriod = getPeriod(periods, 'overtime', opts.reportMonth);
    var chargedMap = buildChargedRecordMap(opts, overtimePeriod);
    data.sheets.overtime = buildSummaryRows(overtimeConfig, opts, overtimePeriod, '', chargedMap);
    summaryFor('overtime', '超鐘點', data.sheets.overtime);

    var planKeys = [];
    reportSourceRows(opts).forEach(function (source) {
      var plan = normalizeExpensePlan(source.expensePlan || source['鐘點支出計畫'] || source.plan);
      if (plan && planKeys.indexOf(plan) < 0) planKeys.push(plan);
    });
    planKeys.sort(function (a, b) { return a.localeCompare(b, 'zh-Hant', { numeric: true }); });
    planKeys.forEach(function (plan) {
      var rows = buildSummaryRows(overtimeConfig, opts, overtimePeriod, plan, chargedMap);
      if (!rows.length) return;
      data.overtimePlans.push({ plan: plan, rows: rows });
      summaryFor('overtime:' + plan, '超鐘點-' + plan, rows);
    });

    [SHEET_CONFIG.adjunct, SHEET_CONFIG.publicSub, SHEET_CONFIG.selfSub, SHEET_CONFIG.mentor].forEach(function (config) {
      var period = getPeriod(periods, config.key, opts.reportMonth);
      if (config.kind === 'summary') data.sheets[config.key] = buildSummaryRows(config, opts, period);
      if (config.key === 'publicSub') data.sheets[config.key] = publicRows(opts, period, chargedMap);
      if (config.key === 'selfSub') data.sheets[config.key] = selfRows(opts, period, chargedMap);
      if (config.key === 'mentor') data.sheets[config.key] = mentorRows(opts, period);
      summaryFor(config.key, config.label, data.sheets[config.key]);
    });

    (opts.teachers || []).forEach(function (t) {
      if (!teacherTitle(t)) data.warnings.push('教師「' + teacherName(t, t.email) + '」缺少職稱，已使用預設職稱。');
    });
    (opts.substitutionRecords || []).filter(function (r) {
      return r && r.date && isApprovedActive(r) && dateInPeriod(r.date, getPeriod(periods, 'publicSub', opts.reportMonth)) && !r.actualTeacherEmail;
    }).forEach(function (r) {
      data.warnings.push('代課紀錄 ' + (r.date || '') + ' 缺少實際代課教師，未列入會計表。');
    });
    if (!data.summary.some(function (x) { return x.count > 0; })) data.warnings.push('目前五類範圍內沒有可匯出的資料。');
    return data;
  }
  function firstTitleCell(sheet, columns) {
    for (var c = 1; c <= columns; c += 1) {
      var cell = sheet.getCell(1, c);
      if (cell && cell.value !== null && cell.value !== undefined && String(cell.value).trim()) return cell;
    }
    return sheet.getCell(1, 1);
  }

  function clearRow(sheet, rowNumber, columns) {
    for (var c = 1; c <= columns; c += 1) sheet.getCell(rowNumber, c).value = null;
  }

  function copyRowStyle(sheet, fromRow, toRow, columns) {
    var src = sheet.getRow(fromRow);
    var dst = sheet.getRow(toRow);
    if (src.height) dst.height = src.height;
    for (var c = 1; c <= columns; c += 1) {
      var sourceCell = src.getCell(c);
      var targetCell = dst.getCell(c);
      try { targetCell.style = clone(sourceCell.style); } catch (e) { /* ExcelJS may share immutable styles */ }
    }
  }

  function prepareRows(sheet, config, rowCount) {
    var totalRow = config.templateTotalRow;
    var capacity = totalRow - config.dataStart;
    if (rowCount > capacity) {
      var extra = rowCount - capacity;
      var blanks = [];
      for (var i = 0; i < extra; i += 1) blanks.push([]);
      sheet.insertRows(totalRow, blanks, 'i');
      for (var j = 0; j < extra; j += 1) copyRowStyle(sheet, totalRow - 1, totalRow + j, config.columns);
      totalRow += extra;
    }
    for (var r = config.dataStart; r < totalRow; r += 1) clearRow(sheet, r, config.columns);
    clearRow(sheet, totalRow, config.columns);
    return totalRow;
  }

  function writeRows(sheet, start, rows) {
    rows.forEach(function (values, index) {
      var rowNumber = start + index;
      values.forEach(function (value, colIndex) {
        var outputValue = value === undefined ? null : value;
        if (typeof outputValue === 'string') outputValue = cleanAccountingText(outputValue);
        sheet.getCell(rowNumber, colIndex + 1).value = outputValue;
      });
    });
  }

  function noteColumnFor(config) {
    if (!config) return 0;
    if (config.key === 'overtime') return 15;
    if (config.key === 'adjunct') return 14;
    if (config.key === 'publicSub') return 9;
    if (config.key === 'selfSub' || config.key === 'mentor') return 10;
    return 0;
  }

  function textDisplayWidth(value) {
    return Array.from(String(value == null ? '' : value)).reduce(function (sum, ch) {
      return sum + (ch.charCodeAt(0) > 255 ? 1 : 0.6);
    }, 0);
  }

  function applyNoteLayout(sheet, config, startRow, rows) {
    var noteColumn = noteColumnFor(config);
    if (!noteColumn) return;
    var column = sheet.getColumn(noteColumn);
    var columnWidth = Number(column && column.width);
    var charsPerLine = Number.isFinite(columnWidth) && columnWidth > 0
      ? Math.max(8, Math.floor(columnWidth * 0.9))
      : 18;
    (rows || []).forEach(function (row, index) {
      var rowNumber = startRow + index;
      var cell = sheet.getCell(rowNumber, noteColumn);
      var value = cleanAccountingText(cell.value);
      var alignment = Object.assign({}, cell.alignment || {});
      alignment.wrapText = true;
      if (value.indexOf('\n') >= 0) alignment.vertical = 'top';
      cell.alignment = alignment;
      if (!value) return;
      var visualLines = value.split(/\r?\n/).reduce(function (sum, line) {
        return sum + Math.max(1, Math.ceil(textDisplayWidth(line) / charsPerLine));
      }, 0);
      var targetHeight = Math.min(120, Math.max(22, visualLines * 20 + 4));
      var targetRow = sheet.getRow(rowNumber);
      targetRow.height = Math.max(Number(targetRow.height) || 15, targetHeight);
    });
  }

  function sumFormula(column, start, end) {
    return {
      formula: end >= start ? 'SUM(' + column + start + ':' + column + end + ')' : '0'
    };
  }

  function writeSummarySheet(sheet, config, rows) {
    var totalRow = prepareRows(sheet, config, rows.length);
    var values = rows.map(function (row) {
      if (config.key === 'overtime') {
        return [row.serial, row.title, row.name, row.weeklyOvertime, row.schedule, row.weeks === '' ? null : row.weeks, row.grossHours, row.deduction, row.actualHours, row.rate, row.amount, row.reduceNote === '' ? null : row.reduceNote, null, null, row.note];
      }
      return [row.serial, row.title, row.name, row.weeklyOvertime, row.schedule, row.weeks === '' ? null : row.weeks, row.grossHours, row.deduction, row.actualHours, row.rate, row.amount, null, null, row.note];
    });
    writeRows(sheet, config.dataStart, values);
    applyNoteLayout(sheet, config, config.dataStart, rows);
    var end = config.dataStart + rows.length - 1;
    if (config.key === 'overtime') {
      sheet.getCell(totalRow, 2).value = '合計';
      sheet.getCell(totalRow, 4).value = sumFormula('D', config.dataStart, end);
      sheet.getCell(totalRow, 7).value = sumFormula('G', config.dataStart, end);
      sheet.getCell(totalRow, 8).value = sumFormula('H', config.dataStart, end);
      sheet.getCell(totalRow, 9).value = sumFormula('I', config.dataStart, end);
      sheet.getCell(totalRow, 11).value = sumFormula('K', config.dataStart, end);
    } else {
      sheet.getCell(totalRow, 3).value = '合計';
      sheet.getCell(totalRow, 4).value = sumFormula('D', config.dataStart, end);
      sheet.getCell(totalRow, 7).value = sumFormula('G', config.dataStart, end);
      sheet.getCell(totalRow, 8).value = sumFormula('H', config.dataStart, end);
      sheet.getCell(totalRow, 9).value = sumFormula('I', config.dataStart, end);
      sheet.getCell(totalRow, 11).value = sumFormula('K', config.dataStart, end);
    }
    return totalRow;
  }

  function writePublicSheet(sheet, config, rows) {
    var totalRow = prepareRows(sheet, config, rows.length);
    writeRows(sheet, config.dataStart, rows.map(function (row) {
      return [row.serial, row.title, row.name, row.hours, row.rate, row.amount, null, null, row.note, null, null, null, null, null, null];
    }));
    applyNoteLayout(sheet, config, config.dataStart, rows);
    var end = config.dataStart + rows.length - 1;
    sheet.getCell(totalRow, 2).value = '合計';
    sheet.getCell(totalRow, 4).value = sumFormula('D', config.dataStart, end);
    sheet.getCell(totalRow, 6).value = sumFormula('F', config.dataStart, end);
    return totalRow;
  }

  function writeLineSheet(sheet, config, rows) {
    var totalRow = prepareRows(sheet, config, rows.length);
    writeRows(sheet, config.dataStart, rows.map(function (row) {
      return [row.actualName, row.date, row.time, row.course, row.period, row.count, row.rate, row.amount, row.originalName, row.reason || row.note];
    }));
    applyNoteLayout(sheet, config, config.dataStart, rows);
    var end = config.dataStart + rows.length - 1;
    sheet.getCell(totalRow, 1).value = '合計';
    sheet.getCell(totalRow, 6).value = sumFormula('F', config.dataStart, end);
    sheet.getCell(totalRow, 8).value = sumFormula('H', config.dataStart, end);
    return totalRow;
  }

  function cloneWorksheet(source, workbook, name, maxColumns) {
    var target = workbook.addWorksheet(name);
    var copyValue = function (value) {
      try { return clone(value); } catch (e) { return value; }
    };
    ['properties', 'pageSetup', 'pageMargins', 'views', 'headerFooter', 'printOptions', 'sheetProtection', 'sheetFormatProperties'].forEach(function (key) {
      if (source[key] !== undefined && source[key] !== null) {
        try { target[key] = copyValue(source[key]); } catch (e) { /* optional ExcelJS metadata */ }
      }
    });
    var columnCount = Number(maxColumns) > 0 ? Number(maxColumns) : Math.max(Number(source.columnCount) || 0, (source.columns || []).length || 0);
    for (var c = 1; c <= columnCount; c += 1) {
      var sourceColumn = source.getColumn(c);
      var targetColumn = target.getColumn(c);
      ['width', 'hidden', 'outlineLevel', 'collapsed', 'style'].forEach(function (key) {
        if (sourceColumn[key] !== undefined && sourceColumn[key] !== null) {
          try { targetColumn[key] = copyValue(sourceColumn[key]); } catch (e) { /* optional column metadata */ }
        }
      });
    }
    var rowCount = Number(source.rowCount) || 0;
    for (var r = 1; r <= rowCount; r += 1) {
      var sourceRow = source.getRow(r);
      var targetRow = target.getRow(r);
      ['height', 'hidden', 'outlineLevel', 'collapsed', 'style'].forEach(function (key) {
        if (sourceRow[key] !== undefined && sourceRow[key] !== null) {
          try { targetRow[key] = copyValue(sourceRow[key]); } catch (e) { /* optional row metadata */ }
        }
      });
      for (var c2 = 1; c2 <= columnCount; c2 += 1) {
        var sourceCell = sourceRow.getCell(c2);
        var targetCell = targetRow.getCell(c2);
        if (sourceCell.value !== undefined && sourceCell.value !== null) {
          try { targetCell.value = copyValue(sourceCell.value); } catch (e) { /* ignore unsupported cell value */ }
        }
        if (sourceCell.style) {
          try { targetCell.style = copyValue(sourceCell.style); } catch (e) { /* ExcelJS may share immutable styles */ }
        }
        ['numFmt', 'alignment', 'font', 'border', 'fill', 'protection'].forEach(function (key) {
          if (sourceCell[key] !== undefined && sourceCell[key] !== null) {
            try { targetCell[key] = copyValue(sourceCell[key]); } catch (e) { /* optional cell metadata */ }
          }
        });
      }
    }
    var merges = source.model && source.model.merges ? source.model.merges : [];
    merges.forEach(function (range) {
      try { target.mergeCells(range); } catch (e) { /* ignore malformed optional merge */ }
    });
    return target;
  }

  function populateWorkbook(workbook, opts, data) {
    var usedNames = {};
    var overtimeConfig = SHEET_CONFIG.overtime;
    var overtimeTemplate = workbook.worksheets[overtimeConfig.index];
    if (!overtimeTemplate) throw new Error('範本缺少工作表：' + overtimeConfig.label);
    var planSheets = (data.overtimePlans || []).map(function (group, index) {
      return {
        group: group,
        sheet: cloneWorksheet(overtimeTemplate, workbook, '__overtime_plan_' + index, overtimeConfig.columns)
      };
    });
    [SHEET_CONFIG.overtime, SHEET_CONFIG.adjunct, SHEET_CONFIG.publicSub, SHEET_CONFIG.selfSub, SHEET_CONFIG.mentor].forEach(function (config) {
      var sheet = workbook.worksheets[config.index];
      if (!sheet) throw new Error('範本缺少工作表：' + config.label);
      var period = getPeriod(data.periods, config.key, opts.reportMonth);
      var plan = config.key === 'overtime' ? '' : null;
      var titleCell = firstTitleCell(sheet, config.columns);
      titleCell.value = titleFor(config, opts.reportMonth, period, plan);
      var name = sheetName(config, opts.reportMonth, period, plan);
      var base = name;
      var suffix = 2;
      while (usedNames[name]) {
        name = (base.slice(0, 28) + '_' + suffix).slice(0, 31);
        suffix += 1;
      }
      usedNames[name] = true;
      sheet.name = name;
      if (config.kind === 'summary') writeSummarySheet(sheet, config, data.sheets[config.key]);
      if (config.kind === 'public') writePublicSheet(sheet, config, data.sheets[config.key]);
      if (config.kind === 'line') writeLineSheet(sheet, config, data.sheets[config.key]);
    });
    planSheets.forEach(function (entry) {
      var group = entry.group;
      var sheet = entry.sheet;
      var period = getPeriod(data.periods, 'overtime', opts.reportMonth);
      var titleCell = firstTitleCell(sheet, overtimeConfig.columns);
      titleCell.value = titleFor(overtimeConfig, opts.reportMonth, period, group.plan);
      var name = sheetName(overtimeConfig, opts.reportMonth, period, group.plan);
      var base = name;
      var suffix = 2;
      while (usedNames[name]) {
        name = (base.slice(0, 28) + '_' + suffix).slice(0, 31);
        suffix += 1;
      }
      usedNames[name] = true;
      sheet.name = name;
      writeSummarySheet(sheet, overtimeConfig, group.rows);
    });
    // 計畫表要緊接在一般超鐘點後面，讓會計查看時先看到一般表，再看到各計畫表。
    var baseSheets = workbook.worksheets.filter(function (sheet) {
      return planSheets.every(function (entry) { return entry.sheet !== sheet; });
    });
    if (planSheets.length && baseSheets.length) {
      var orderedSheets = [baseSheets[0]]
        .concat(planSheets.map(function (entry) { return entry.sheet; }))
        .concat(baseSheets.slice(1));
      orderedSheets.forEach(function (sheet, index) {
        sheet.orderNo = index;
      });
    }
  }
  async function loadTemplateBuffer() {
    var response = await root.fetch(TEMPLATE_URL + '?t=' + Date.now(), { cache: 'no-cache' });
    if (!response.ok) throw new Error('無法載入會計範本（HTTP ' + response.status + '）');
    return response.arrayBuffer();
  }

  async function exportWorkbook(opts) {
    opts = opts || {};
    var data = buildExportData(opts);
    var ExcelJSLib = opts.ExcelJS || root.ExcelJS || (typeof ExcelJS !== 'undefined' ? ExcelJS : null);
    if (!ExcelJSLib) throw new Error('ExcelJS 未載入');
    var buffer = opts.templateBuffer || await loadTemplateBuffer();
    var workbook = new ExcelJSLib.Workbook();
    try {
      await workbook.xlsx.load(buffer.slice ? buffer.slice(0) : buffer);
    } catch (e) {
      throw new Error('會計範本讀取失敗，請重新整理後再試：' + (e && e.message ? e.message : e));
    }
    if (!workbook || !Array.isArray(workbook.worksheets) || workbook.worksheets.length < 5) {
      throw new Error('會計範本缺少五個工作表，請確認 templates/accounting-template.xlsx。');
    }
    if (!data || !data.sheets) {
      throw new Error('會計匯出資料建立失敗，請重新整理資料後再試。');
    }
    populateWorkbook(workbook, opts, data);
    if (workbook.calcProperties) {
      workbook.calcProperties.fullCalcOnLoad = true;
      workbook.calcProperties.forceFullCalc = true;
      workbook.calcProperties.calcMode = 'auto';
    }
    var outputBuffer = await workbook.xlsx.writeBuffer();
    var parts = reportParts(opts.reportMonth);
    return {
      buffer: outputBuffer,
      fileName: (parts.month + '月會計核銷明細.xlsx'),
      summary: data.summary,
      warnings: data.warnings,
      periods: data.periods
    };
  }

  root.ExportAccounting = {
    TEMPLATE_URL: TEMPLATE_URL,
    PERIOD_OPTIONS: PERIOD_OPTIONS,
    defaultPeriodSettings: defaultPeriodSettings,
    loadPeriodSettings: loadPeriodSettings,
    savePeriodSettings: savePeriodSettings,
    buildExportData: buildExportData,
    exportWorkbook: exportWorkbook
  };
})(window);
