/**
 * 學校調代課線上系統 - 列印輔助模組 (print-helper.js)
 * 還原：建成國中代（調、補）課請示單暨班級通知單（A4 橫式雙聯）
 */

/** 對調路線圖（畫面與列印共用結構） */
function escapePrintHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildExchangeRouteHtml(opts) {
  const nameA = escapePrintHtml(opts.nameA || '');
  const nameB = escapePrintHtml(opts.nameB || '');
  const dateA = escapePrintHtml(opts.dateA || '');
  const dateB = escapePrintHtml(opts.dateB || '');
  const dayA = escapePrintHtml(opts.dayA || '');
  const dayB = escapePrintHtml(opts.dayB || '');
  const periodA = escapePrintHtml(opts.periodA || '');
  const periodB = escapePrintHtml(opts.periodB || '');
  const classA = escapePrintHtml(opts.classA || '');
  const classB = escapePrintHtml(opts.classB || '');
  const subjectA = escapePrintHtml(opts.subjectA || '');
  const subjectB = escapePrintHtml(opts.subjectB || '');
  const compact = !!opts.compact;

  const slotA = [dayA ? `週${dayA}` : '', periodA ? `第${periodA}節` : ''].filter(Boolean).join(' ');
  const slotB = [dayB ? `週${dayB}` : '', periodB ? `第${periodB}節` : ''].filter(Boolean).join(' ');
  const metaA = [classA, subjectA].filter(Boolean).join(' ');
  const metaB = [classB, subjectB].filter(Boolean).join(' ');

  const pad = compact ? '6px 8px' : '8px 10px';
  const fontTitle = compact ? '0.8rem' : '0.85rem';
  const fontMeta = compact ? '0.68rem' : '0.72rem';

  return `
    <div class="exchange-route" style="border:1px solid #cbd5e1;border-radius:8px;padding:${pad};background:#f8fafc;margin:6px 0 8px;">
      <div style="font-size:${fontMeta};font-weight:700;color:#64748b;margin-bottom:6px;">對調路線</div>
      <div style="display:flex;align-items:stretch;gap:8px;">
        <div style="flex:1;min-width:0;border:1px solid #e2e8f0;border-radius:6px;padding:6px 8px;background:#fff;">
          <div style="font-size:${fontTitle};font-weight:700;color:#0f172a;">${nameA}</div>
          <div style="font-size:${fontMeta};color:#334155;margin-top:2px;">${slotA}${dateA ? '　' + dateA : ''}</div>
          <div style="font-size:${fontMeta};color:#64748b;margin-top:1px;">${metaA}</div>
        </div>
        <div style="flex-shrink:0;display:flex;align-items:center;font-weight:700;color:#475569;font-size:1rem;">⇄</div>
        <div style="flex:1;min-width:0;border:1px solid #e2e8f0;border-radius:6px;padding:6px 8px;background:#fff;">
          <div style="font-size:${fontTitle};font-weight:700;color:#0f172a;">${nameB}</div>
          <div style="font-size:${fontMeta};color:#334155;margin-top:2px;">${slotB}${dateB ? '　' + dateB : ''}</div>
          <div style="font-size:${fontMeta};color:#64748b;margin-top:1px;">${metaB}</div>
        </div>
      </div>
    </div>
  `;
}

function getPaperSignatureText(group, teacherKey, fallbackName) {
  if (!group || !group.isPaperDraft) return fallbackName || '';
  const map = group.signatureByTeacher || {};
  const name = String(fallbackName || '').trim();
  const key = String(teacherKey || '').trim().toLowerCase();
  return String(map[key] != null ? map[key] : (map[name.toLowerCase()] || '')).trim();
}

function getPaperGroupSignatureText(group, names) {
  const list = (names || []).map(function (name) {
    return getPaperSignatureText(group, name, name);
  }).filter(Boolean);
  return list.join('、');
}

function uniquePrintValues(values) {
  const seen = new Set();
  return (values || []).map(value => String(value == null ? '' : value).trim()).filter(value => {
    if (!value || seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

function stripPrintAdministrativeProxyNote(value) {
  return String(value == null ? '' : value)
    .replace(/\[行政代申請[^\]]*\]/g, '')
    .replace(/行政代申請[：:][^；;\r\n]*/g, '')
    .replace(/^[；;\s]+|[；;\s]+$/g, '')
    .trim();
}

function resolvePrintSerial(record) {
  if (!record) return '';
  const explicit = record.serial || record['單號'] || record.requestSerial || '';
  if (String(explicit).trim()) return String(explicit).trim();
  return resolvePrintRequestId(record);
}

function getPrintAudienceLabels(group, ctx) {
  const rows = getPrintSlotRows(group);
  const getName = ctx && typeof ctx.getTeacherNameByEmail === 'function'
    ? ctx.getTeacherNameByEmail
    : function (value) { return String(value || ''); };
  const names = function (side) {
    return uniquePrintValues((rows || []).map(function (row) {
      const key = getPrintTeacherKey(row, side);
      const raw = side === 'actual' ? row.actualTeacherName : row.originalTeacherName;
      return cleanPrintTeacherName(raw || getName(key) || key);
    }));
  };
  const classes = uniquePrintValues((rows || []).map(row => row.cls || row.className));
  if (group && group.isTriangle) {
    return [
      '教學組留存（請簽名）',
      '三角調教師：' + names('original').join('、'),
      '實際授課教師：' + names('actual').join('、'),
      '班級：' + classes.join('、')
    ];
  }
  if (group && group.isExchange) {
    const requesterKey = String(group.requesterEmail || '').trim().toLowerCase();
    const requesterRecord = (rows || []).find(row => /_2$/.test(String(row && row.id || ''))) || rows[0] || {};
    const targetRecord = (rows || []).find(row => /_1$/.test(String(row && row.id || '')))
      || (rows || []).find(row => {
        const key = getPrintTeacherKey(row, 'original').toLowerCase();
        return requesterKey && key && key !== requesterKey;
      })
      || rows[0]
      || {};
    const requesterName = cleanPrintTeacherName(
      group.requesterName
      || requesterRecord.originalTeacherName
      || getName(getPrintTeacherKey(requesterRecord, 'original'))
      || getPrintTeacherKey(requesterRecord, 'original')
    );
    const targetName = cleanPrintTeacherName(
      targetRecord.originalTeacherName
      || getName(getPrintTeacherKey(targetRecord, 'original'))
      || getPrintTeacherKey(targetRecord, 'original')
    );
    return [
      '教學組留存（請簽名）',
      '請假教師：' + requesterName,
      '代課/調課教師：' + targetName,
      '班級：' + classes.join('、')
    ];
  }
  return [
    '教學組留存（請簽名）',
    '請假教師：' + names('original').join('、'),
    '代課/調課教師：' + names('actual').join('、'),
    '班級：' + classes.join('、')
  ];
}

function withPrintAudienceLabel(form, label) {
  const source = String(form || '').replace(/<div class="[^"]*\bofficial-audience-label\b[^"]*">[\s\S]*?<\/div>\s*/g, '');
  const retainClass = String(label || '').trim() === '教學組留存（請簽名）'
    ? ' official-audience-label-retain'
    : '';
  const labelHtml = `<div class="official-audience-label${retainClass}">${escapePrintHtml(label || '')}</div>`;
  const opening = /(<div\b[^>]*class="[^"]*(?:substitute-form|official-substitution-form)[^"]*"[^>]*>)/i;
  if (opening.test(source)) return source.replace(opening, `$1${labelHtml}`);
  return labelHtml + source;
}

function getPrintDateParts(value) {
  const match = String(value || '').match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (!match) return null;
  const year = parseInt(match[1], 10);
  const month = parseInt(match[2], 10);
  const day = parseInt(match[3], 10);
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return { year, month, day, date, key: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}` };
}

function getPrintWeekKey(value) {
  const parts = getPrintDateParts(value);
  if (!parts) return '';
  const monday = new Date(parts.date);
  const day = monday.getDay();
  monday.setDate(monday.getDate() + (day === 0 ? -6 : 1 - day));
  return `${monday.getFullYear()}-${String(monday.getMonth() + 1).padStart(2, '0')}-${String(monday.getDate()).padStart(2, '0')}`;
}

function getPrintWeekDates(anchor) {
  const parts = getPrintDateParts(anchor);
  if (!parts) return ['', '', '', '', ''];
  const monday = new Date(parts.date);
  const day = monday.getDay();
  monday.setDate(monday.getDate() + (day === 0 ? -6 : 1 - day));
  return Array.from({ length: 5 }, function (_, index) {
    const date = new Date(monday);
    date.setDate(monday.getDate() + index);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  });
}

/** 調課單的五個星期欄只列出實際有異動的日期。 */
function getPrintExchangeDateLists(records) {
  const lists = [[], [], [], [], []];
  (records || []).forEach(record => {
    const parts = getPrintDateParts(record && record.date);
    if (!parts) return;
    const day = parts.date.getDay();
    if (day >= 1 && day <= 5 && !lists[day - 1].includes(parts.key)) {
      lists[day - 1].push(parts.key);
    }
  });
  return lists.map(list => list.sort());
}

function formatPrintMonthDay(value) {
  const parts = getPrintDateParts(value);
  return parts ? `${parts.month}/${parts.day}` : '';
}

function formatPrintRocDate(value, time) {
  const parts = getPrintDateParts(value);
  if (!parts) return '';
  const hourMatch = String(time || '').match(/(?:^|\D)(\d{1,2})(?::\d{2})?/);
  const hour = hourMatch ? parseInt(hourMatch[1], 10) : null;
  return `${parts.year - 1911}年${parts.month}月${parts.day}日${hour != null && !Number.isNaN(hour) ? `${hour}時` : ''}`;
}

function parsePrintTimeRange(records) {
  const source = (records || []).map(record => String(record && record.leaveTime || '').trim()).find(Boolean) || '';
  const type = (records || []).map(record => String(record && record.leaveTimeType || '').trim()).find(Boolean) || '';
  const match = source.match(/(\d{1,2}(?::\d{2})?)\s*[~～至到\-－]\s*(\d{1,2}(?::\d{2})?)/);
  if (match) return { start: match[1], end: match[2] };
  if (/上午/.test(source) || /上午/.test(type)) return { start: '08:00', end: '12:00' };
  if (/下午/.test(source) || /下午/.test(type)) return { start: '12:00', end: '16:00' };
  if (/全天/.test(source) || /全天/.test(type)) return { start: '08:00', end: '16:00' };
  return { start: '', end: '' };
}

function isPrintLeaveLikeReason(reason) {
  const value = String(reason || '').trim();
  if (!value || value === '請假') return true;
  if (value === '合班回原班' || value === '併班上課') return true;
  if (value === '空堂排班') return false;
  return /公假|事假|病假|婚假|喪假|產假|娩假|生理假|身心調適|家庭照顧|育嬰|安胎|產檢|陪產|防疫|特休|休假|補休|其他|公差|公出|外出|研習|進修|請假|假$/.test(value);
}

function isPrintCombinedReturnRecord(record) {
  if (!record) return false;
  const flow = String(record.specialFlow || record['特殊流程'] || '').trim().toLowerCase();
  const reason = String(record.reason || record['請假事由'] || '').trim();
  return flow === 'combined_return' || flow === '合班回原班' || flow === '併班上課'
    || reason === '合班回原班' || reason === '併班上課';
}

function getPrintTeacherKey(record, side) {
  if (!record) return '';
  if (side === 'actual') return String(record.actualTeacherEmail || record.actualTeacherName || '').trim();
  return String(record.originalTeacherEmail || record.originalTeacherName || record.leaveEmail || '').trim();
}

function getPrintMergeTeacherKey(record, side, ctx) {
  if (!record) return '';
  const isActual = side === 'actual';
  const name = String(isActual
    ? (record.actualTeacherName || record.targetTeacherName || '')
    : (record.originalTeacherName || record.requesterName || record.leaveTeacherName || '')).trim();
  const rawValues = (isActual
    ? [record.actualTeacherEmail, record.targetTeacherEmail]
    : [record.originalTeacherEmail, record.requesterEmail, record.leaveEmail])
    .map(value => String(value == null ? '' : value).trim())
    .filter(Boolean);
  const explicitEmail = rawValues.find(value => /@/.test(value));
  if (explicitEmail && ctx && typeof ctx.getTeacherNameByEmail === 'function') {
    const resolved = String(ctx.getTeacherNameByEmail(explicitEmail) || '').trim();
    if (resolved && !/@/.test(resolved)) return normalizePrintMergeKey(resolved);
  }
  if (explicitEmail) return normalizePrintMergeKey(explicitEmail);
  if (name && !/@/.test(name)) return normalizePrintMergeKey(name);
  return normalizePrintMergeKey(name || rawValues[0] || '');
}

function cleanPrintTeacherName(value) {
  return String(value || '').replace(/\s*老師\s*$/, '').trim();
}

function getPrintSlotRows(group) {
  if (group && group.weekRows) return group.weekRows;
  if (!group) return [];
  if (group.isExchange) {
    return (group.records || []).map(record => ({
      date: record.date,
      period: record.period,
      // 網頁交換列的班科已是交換後視圖；紙本改讀原始端欄位。
      cls: record.formClassName || record.className,
      sub: record.formSubject || record.subject,
      originalTeacherEmail: getPrintTeacherKey(record, 'original'),
      originalTeacherName: record.originalTeacherName,
      actualTeacherEmail: getPrintTeacherKey(record, 'actual'),
      actualTeacherName: record.actualTeacherName,
      serial: resolvePrintSerial(record),
      leaveEmail: getPrintTeacherKey(record, 'original'),
      reason: record.reason || group.reason || '',
      note: record.note || group.note || '',
      leaveTimeType: record.leaveTimeType || '',
      leaveTime: record.leaveTime || '',
      subFee: record.subFee || group.subFee || ''
    }));
  }
  if (group.periods && group.periods.length) return group.periods;
  return (group.records || []).map(record => ({
    date: record.date,
    num: record.period,
    cls: record.className,
    sub: record.subject,
     originalTeacherEmail: getPrintTeacherKey(record, 'original'),
     originalTeacherName: record.originalTeacherName,
     actualTeacherEmail: getPrintTeacherKey(record, 'actual'),
     actualTeacherName: record.actualTeacherName,
     serial: resolvePrintSerial(record),
      leaveEmail: getPrintTeacherKey(record, 'original'),
     reason: record.reason || group.reason || '',
     note: record.note || group.note || '',
     leaveTimeType: record.leaveTimeType || '',
     leaveTime: record.leaveTime || '',
     subFee: record.subFee || group.subFee || ''
  }));
}

function resolvePrintProcessingType(group, rows) {
  const explicit = String(group && (group.processingType || group.processType) || '').trim().toLowerCase();
  const type = explicit || String((group && group.records && group.records[0] && group.records[0].type) || '').trim().toLowerCase();
  if ((group && group.isTriangle) || type === 'triangle' || type === '三角調') return '調課';
  if (type === 'exchange' || type === '對調' || type === '調課' || /調課/.test(explicit)) return '調課';
  if (type === 'makeup' || type === '補課' || /補課/.test(explicit)) return '補課';
  if ((rows || []).some(row => /補課/.test(String(row && row.reason || '')))) return '補課';
  return '代課';
}

function renderPrintCheckbox(label, checked) {
  return `<span class="official-checkbox${checked ? ' is-checked' : ''}">${checked ? '■' : '□'}${escapePrintHtml(label)}</span>`;
}

function getPrintSignatureText(group, rows, ctx, getName) {
  const entries = [];
  const signatureSide = 'actual';
  (rows || []).forEach(row => {
    // 紙本格內顯示原位置課程，簽名由實際授課教師簽署。
    const key = String(signatureSide === 'original'
      ? (row.originalTeacherEmail || row.originalTeacherName || '')
      : (row.actualTeacherEmail || row.actualTeacherName || '')).trim();
    const name = cleanPrintTeacherName(signatureSide === 'original'
      ? (row.originalTeacherName || getName(key))
      : (row.actualTeacherName || getName(key)));
    const identity = key.toLowerCase() || name.toLowerCase();
    if (!name || entries.some(entry => entry.identity === identity)) return;
    entries.push({ key, name, identity });
  });
  const admin = ctx.isAdmin === true || !!(ctx.isAdmin && ctx.isAdmin.value === true);
  return entries.map(entry => {
    const fallback = admin ? entry.name : '';
    return group && group.isPaperDraft
      ? getPaperSignatureText(group, entry.key, fallback)
      : fallback;
  }).filter(Boolean).join('、');
}

const OFFICIAL_COL_WIDTHS = Object.freeze([417, 400, 172, 137, 416, 461, 232, 708, 75, 1014, 74, 680, 261, 608, 407, 302, 851]);
const OFFICIAL_DAY_COLS = Object.freeze([3, 3, 1, 3, 2]);
const OFFICIAL_GRID_TOP_MM = 43.43;
const OFFICIAL_GRID_PERIOD_MM = 13.1;
const OFFICIAL_GRID_HEIGHT_MM = OFFICIAL_GRID_PERIOD_MM * 8;

function getOfficialGridLayout() {
  const total = OFFICIAL_COL_WIDTHS.reduce((sum, width) => sum + width, 0);
  let columnOffset = OFFICIAL_COL_WIDTHS.slice(0, 3).reduce((sum, width) => sum + width, 0);
  const dayCenters = [];
  const dayHalfWidths = [];
  let colIndex = 3;
  OFFICIAL_DAY_COLS.forEach(count => {
    const width = OFFICIAL_COL_WIDTHS.slice(colIndex, colIndex + count).reduce((sum, value) => sum + value, 0);
    dayCenters.push(((columnOffset + width / 2) / total) * 100);
    dayHalfWidths.push((width / total) * 50);
    columnOffset += width;
    colIndex += count;
  });
  return { dayCenters, dayHalfWidths };
}

function getOfficialArrowMarkerHtml(markerId) {
  return `<defs><marker id="${markerId}" markerWidth="2.4" markerHeight="2.4" refX="2.4" refY="1.2" orient="auto-start-reverse" markerUnits="userSpaceOnUse"><path d="M 0 0 L 2.4 1.2 L 0 2.4" fill="none" stroke="#111827" stroke-width=".25" stroke-linejoin="round"></path></marker></defs>`;
}

function getExchangeArrowSvg(group, rows, weekDates) {
  if (!group || !group.isExchange) return '';
  const dateLists = Array.isArray(weekDates && weekDates[0])
    ? weekDates
    : (weekDates || []).map(value => value ? [value] : []);
  const points = [];
  (rows || []).forEach(row => {
    if (!row || points.length >= 2) return;
    const date = getPrintDateParts(row.date);
    const period = parseInt(row.num != null ? row.num : row.period, 10);
    if (!date || Number.isNaN(period) || period < 1 || period > 8) return;
    const dayIndex = dateLists.findIndex(values => values.some(value => {
      const candidate = getPrintDateParts(value);
      return candidate && candidate.key === date.key;
    }));
    if (dayIndex < 0 || points.some(point => point.dayIndex === dayIndex && point.period === period)) return;
    points.push({ key: `${date.key}|${period}`, dayIndex, period });
  });
  if (points.length !== 2) return '';

  const layout = getOfficialGridLayout();
  const toPoint = point => ({
    x: layout.dayCenters[point.dayIndex],
    y: (point.period - 1) * OFFICIAL_GRID_PERIOD_MM + OFFICIAL_GRID_PERIOD_MM / 2,
    halfWidth: layout.dayHalfWidths[point.dayIndex],
    halfHeight: OFFICIAL_GRID_PERIOD_MM / 2
  });
  const start = toPoint(points[0]);
  const end = toPoint(points[1]);
  const edgeDistanceFor = (from, to) => {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const scaleX = dx ? from.halfWidth / Math.abs(dx) : Infinity;
    const scaleY = dy ? from.halfHeight / Math.abs(dy) : Infinity;
    const length = Math.hypot(dx, dy) || 1;
    return {
      dx,
      dy,
      length,
      edgeDistance: Math.min(scaleX, scaleY) * length
    };
  };
  const edgePoint = (from, to, inset) => {
    const vector = edgeDistanceFor(from, to);
    const distance = Math.max(0, vector.edgeDistance - inset);
    return {
      x: from.x + (vector.dx / vector.length) * distance,
      y: from.y + (vector.dy / vector.length) * distance
    };
  };
  const startBoundary = edgeDistanceFor(start, end).edgeDistance;
  const endBoundary = edgeDistanceFor(end, start).edgeDistance;
  const centerDistance = Math.hypot(end.x - start.x, end.y - start.y) || 1;
  const boundaryGap = Math.max(0, centerDistance - startBoundary - endBoundary);
  // 相鄰格的雙向箭頭頭部會重疊，短線時將端點收回格內留出清楚間距。
  const endpointInset = 0.35 + Math.max(0, (5.6 - boundaryGap) / 2);
  const startEdge = edgePoint(start, end, endpointInset);
  const endEdge = edgePoint(end, start, endpointInset);
  const markerId = `exchange-arrow-${String(group.requestId || 'route').replace(/[^a-zA-Z0-9_-]+/g, '_')}`;
  const number = value => Number(value.toFixed(2));
  return `<svg xmlns="http://www.w3.org/2000/svg" class="official-exchange-overlay" aria-hidden="true" viewBox="0 0 100 ${OFFICIAL_GRID_HEIGHT_MM}" preserveAspectRatio="none">${getOfficialArrowMarkerHtml(markerId)}<line class="official-exchange-arrow-line" x1="${number(startEdge.x)}" y1="${number(startEdge.y)}" x2="${number(endEdge.x)}" y2="${number(endEdge.y)}" marker-start="url(#${markerId})" marker-end="url(#${markerId})"></line></svg>`;
}

function getTriangleArrowSvg(group, rows, weekDates) {
  if (!group || !group.isTriangle) return '';
  const dateLists = Array.isArray(weekDates && weekDates[0])
    ? weekDates
    : (weekDates || []).map(value => value ? [value] : []);
  const layout = getOfficialGridLayout();
  const findDayIndex = value => {
    const date = getPrintDateParts(value);
    if (!date) return -1;
    return dateLists.findIndex(values => (values || []).some(candidate => {
      const parsed = getPrintDateParts(candidate);
      return parsed && parsed.key === date.key;
    }));
  };
  const toPoint = (date, period) => {
    const dayIndex = findDayIndex(date);
    const periodValue = parseInt(period, 10);
    if (dayIndex < 0 || periodValue < 1 || periodValue > 8) return null;
    return {
      x: layout.dayCenters[dayIndex],
      y: (periodValue - 1) * OFFICIAL_GRID_PERIOD_MM + OFFICIAL_GRID_PERIOD_MM / 2,
      halfWidth: layout.dayHalfWidths[dayIndex],
      halfHeight: OFFICIAL_GRID_PERIOD_MM / 2
    };
  };
  const edgeDistanceFor = (from, to) => {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const scaleX = dx ? from.halfWidth / Math.abs(dx) : Infinity;
    const scaleY = dy ? from.halfHeight / Math.abs(dy) : Infinity;
    const length = Math.hypot(dx, dy) || 1;
    return { dx, dy, length, edgeDistance: Math.min(scaleX, scaleY) * length };
  };
  const edgePoint = (from, to, inset) => {
    const vector = edgeDistanceFor(from, to);
    const distance = Math.max(0, vector.edgeDistance - inset);
    return {
      x: from.x + (vector.dx / vector.length) * distance,
      y: from.y + (vector.dy / vector.length) * distance
    };
  };
  const number = value => Number(value.toFixed(2));
  const markerId = `triangle-arrow-${String(group.requestId || 'route').replace(/[^a-zA-Z0-9_-]+/g, '_')}`;
  const lines = [];
  (rows || []).forEach(row => {
    const source = toPoint(row.sourceDate || row.date, row.sourcePeriod != null ? row.sourcePeriod : row.period);
    const target = toPoint(row.targetDate || row.triangleTargetDate,
      row.targetPeriod != null ? row.targetPeriod : row.triangleTargetPeriod);
    if (!source || !target || (source.x === target.x && source.y === target.y)) return;
    const centerDistance = Math.hypot(target.x - source.x, target.y - source.y) || 1;
    const sourceBoundary = edgeDistanceFor(source, target).edgeDistance;
    const targetBoundary = edgeDistanceFor(target, source).edgeDistance;
    const boundaryGap = Math.max(0, centerDistance - sourceBoundary - targetBoundary);
    const inset = 0.35 + Math.max(0, (5.6 - boundaryGap) / 2);
    const start = edgePoint(source, target, inset);
    const end = edgePoint(target, source, inset);
    lines.push(`<line class="official-exchange-arrow-line" x1="${number(start.x)}" y1="${number(start.y)}" x2="${number(end.x)}" y2="${number(end.y)}" marker-end="url(#${markerId})"></line>`);
  });
  if (!lines.length) return '';
  return `<svg xmlns="http://www.w3.org/2000/svg" class="official-exchange-overlay" aria-hidden="true" viewBox="0 0 100 ${OFFICIAL_GRID_HEIGHT_MM}" preserveAspectRatio="none">${getOfficialArrowMarkerHtml(markerId)}${lines.join('')}</svg>`;
}

function generateFormHtml(g, currentType, ctx) {
  ctx = ctx || {};
  const isClassNotice = String(currentType || '').trim().toLowerCase() === 'noticeclass';
  const getName = typeof ctx.getTeacherNameByEmail === 'function'
    ? ctx.getTeacherNameByEmail
    : function (value) { return String(value || ''); };
  const getJobTitle = typeof ctx.getTeacherJobTitleByEmail === 'function'
    ? ctx.getTeacherJobTitleByEmail
    : function () { return ''; };
  const rows = getPrintSlotRows(g);
  const sourceRecords = (g && g.records && g.records.length) ? g.records : rows;
  const isTriangle = !!(g && g.isTriangle);
  const serials = uniquePrintValues([
    ...((g && g.serials) || []),
    ...(sourceRecords || []).map(resolvePrintSerial),
    ...(rows || []).map(resolvePrintSerial)
  ]);
  const serialMark = serials.length
      ? `<div class="official-serial-mark">單號：${serials.map(escapePrintHtml).join('、')}</div>`
      : '';
  const applicantRecord = g && g.requesterEmail
    ? null
    : (g && g.isExchange
      ? (sourceRecords.find(record => /_2$/.test(String(record.id || ''))) || sourceRecords[0])
      : sourceRecords[0]);
  const applicantKey = String((g && g.requesterEmail) || getPrintTeacherKey(applicantRecord, 'original') || '').trim();
  const rawApplicantName = String((g && g.requesterName) || '').trim();
  const applicantName = isTriangle
    ? cleanPrintTeacherName(rawApplicantName || getName(applicantKey) || applicantKey || '三角調課')
    : cleanPrintTeacherName(
      rawApplicantName && !/@/.test(rawApplicantName) ? rawApplicantName : getName(applicantKey)
    );
  const applicantJob = String((g && g.jobTitle) || getJobTitle(applicantKey) || '').trim() || '教師';
  const processingType = resolvePrintProcessingType(g || {}, rows);
  const reasons = uniquePrintValues([
    ...(g && g.reasons || []),
    ...(rows || []).map(row => row.reason),
    g && g.reason
  ]);
  const isCombinedReturn = [...sourceRecords, ...rows].some(isPrintCombinedReturnRecord);
  const combinedReason = reasons.find(value => !['合班回原班', '併班上課'].includes(String(value || '').trim())) || '';
  const reason = isCombinedReturn ? (combinedReason || '請假') : (reasons[0] || '請假');
  const isLeave = isCombinedReturn || (reasons.length
    ? reasons.every(isPrintLeaveLikeReason)
    : true);
  const notes = uniquePrintValues([
    g && g.note,
    ...(sourceRecords || []).map(record => record && record.note)
  ]);
  const administrativeNote = uniquePrintValues(notes.map(stripPrintAdministrativeProxyNote)).join('；');
  const dateSourceRecords = rows.length ? rows : sourceRecords;
  const rangeRecords = g && (g.isExchange || g.isTriangle)
    ? dateSourceRecords.filter(record => {
      const teacherKey = g.isTriangle
        ? getPrintTeacherKey(record, 'actual')
        : getPrintTeacherKey(record, 'original');
      return teacherKey.toLowerCase() === applicantKey.toLowerCase();
    })
    : dateSourceRecords;
  const dateRecords = (rangeRecords.length ? rangeRecords : sourceRecords).filter(record => getPrintDateParts(record.date));
  const dates = dateRecords.map(record => getPrintDateParts(record.date).key).sort();
  const startDate = dates[0] || '';
  const endDate = dates[dates.length - 1] || startDate;
  const timeRange = parsePrintTimeRange(dateRecords);
  const dateRange = startDate
    ? `自${formatPrintRocDate(startDate, timeRange.start)}<br>至${formatPrintRocDate(endDate, timeRange.end)}`
    : '';
  const weekDates = getPrintWeekDates((g && g.anchorDate) || (rows[0] && rows[0].date));
  const dateLists = g && g.isExchange
    ? getPrintExchangeDateLists(sourceRecords)
    : weekDates.map(date => date ? [date] : []);
  const days = ['一', '二', '三', '四', '五'];
  const periods = [1, 2, 3, 4, 5, 6, 7, 8];
  const dayCols = OFFICIAL_DAY_COLS;
  const colgroup = OFFICIAL_COL_WIDTHS.map(width => `<col style="width:${(width / 7215 * 100).toFixed(4)}%">`).join('');
  const reprintClass = g && g.isReprint ? ' is-reprint' : '';
  const scheduleCell = (datesForDay, period, property) => {
    const dateSet = datesForDay || [];
    const matches = rows.filter(row => dateSet.includes(String(row.date || '').slice(0, 10))
      && parseInt(row.num != null ? row.num : row.period, 10) === period);
    return uniquePrintValues(matches.map(row => row[property])).join('／');
  };
  const headerCells = days.map((day, index) => `
    <th colspan="${dayCols[index]}" class="official-day-header">
      <span>${day}</span>${dateLists[index].length ? `<br><span class="official-day-date">${escapePrintHtml(dateLists[index].map(formatPrintMonthDay).join('／'))}</span>` : ''}
    </th>`).join('');
  const bodyRows = periods.map(period => {
    const periodRows = rows.filter(row => parseInt(row.num != null ? row.num : row.period, 10) === period);
    const subjectCells = days.map((_, index) => {
      const value = scheduleCell(dateLists[index], period, 'sub');
      return `<td colspan="${dayCols[index]}" class="official-slot-value">${escapePrintHtml(value)}</td>`;
    }).join('');
    const classCells = days.map((_, index) => {
      const value = scheduleCell(dateLists[index], period, 'cls');
      return `<td colspan="${dayCols[index]}" class="official-slot-value official-class-value">${escapePrintHtml(value)}</td>`;
    }).join('');
    const label = ['', '第一節', '第二節', '第三節', '第四節', '第五節', '第六節', '第七節', '第八節'][period];
    const periodSignature = getPrintSignatureText(g || {}, periodRows, ctx, getName);
    const signatureCell = `<td colspan="2" class="official-signature-cell">${periodSignature ? `<span class="official-signature-name">${escapePrintHtml(periodSignature)}</span>` : ''}</td>`;
    return `
      <tr class="official-subject-row">
        <td colspan="3" class="official-row-label">${label}</td>${subjectCells}${signatureCell}
      </tr>
      <tr class="official-class-row">
        <td colspan="3" class="official-row-label">班級</td>${classCells}<td colspan="2" class="official-signature-cell"></td>
      </tr>`;
  }).join('');
  const processingBoxes = ['調課', '代課', '補課'].map(label => `<div>${renderPrintCheckbox(label, processingType === label)}</div>`).join('');
  const leaveDate = isLeave ? dateRange : '';
  const courseReason = isLeave
    ? administrativeNote
    : uniquePrintValues([reason === '請假' ? '' : reason, administrativeNote]).join('；') || '課務調整';
  const reasonLine = `假別：${isLeave ? escapePrintHtml(isClassNotice ? '請假' : (reason || '請假')) : ''}`;
  const courseReasonLine = !isClassNotice && courseReason
    ? `原因：${escapePrintHtml(courseReason)}`
    : '';
  const instructions = '1.請於填寫線上假單時填妥課務安排情形，紙本送教務處備查。2.請先確認班級特教學生課務，有特教生抽離請通知特教組。3.代課以同科教師為原則，並先行將課務交代該代課老師。4.補課請自覓時間，於二週內完成。';
  const exchangeArrowSvg = isTriangle
    ? getTriangleArrowSvg(g, rows, dateLists)
    : getExchangeArrowSvg(g, rows, dateLists);

  return `
    <div class="substitute-form official-substitution-form${reprintClass}">
      ${serialMark}
      <div class="official-form-table-wrap">
      <table class="official-form-table">
        <colgroup>${colgroup}</colgroup>
        <tbody>
          <tr class="official-title-row"><td colspan="17">臺北市立建成國民中學代（調、補）課請示單暨班級通知單</td></tr>
          <tr class="official-info-row">
             <td class="official-label">職<br>別</td><td colspan="3" class="official-value official-job-value">${escapePrintHtml(applicantJob)}</td>
             <td class="official-label">姓<br>名</td><td colspan="3" class="official-value official-name-value">${escapePrintHtml(applicantName)}老師</td>
             <td colspan="3" class="official-label">職務<br>代理人</td><td colspan="3" class="official-value official-proxy-value">老師</td>
             <td colspan="2" class="official-label">處理<br>方式</td><td class="official-processing-cell">${processingBoxes}</td>
          </tr>
          <tr class="official-leave-row">
             <td rowspan="2" colspan="2" class="official-label">請勾選</td>
             <td colspan="5" class="official-check-option">${renderPrintCheckbox('請假', isLeave)}</td>
             <td rowspan="2" colspan="5" class="official-date-cell">${leaveDate}</td>
             <td colspan="5" class="official-reason-cell">${reasonLine}</td>
           </tr>
           <tr class="official-course-row">
             <td colspan="5" class="official-check-option">${renderPrintCheckbox('僅課務申請(非請假)', !isLeave)}</td>
             <td colspan="5" class="official-reason-cell">${courseReasonLine}</td>
          </tr>
             <tr class="official-section-row"><td colspan="15"><span class="official-section-caption">代（調、補）課情形★★請註明科目、日期★★</span></td><td colspan="2" class="official-signature-header">代課教師</td></tr>
           <tr class="official-schedule-header">
             <td colspan="3" class="official-row-label">星期<br>節次</td>${headerCells}<td colspan="2" class="official-signature-header"></td>
           </tr>
          ${bodyRows}
         <tr class="official-instruction-row"><td colspan="17">${escapePrintHtml(instructions)}</td></tr>
       </tbody>
      </table>
      ${exchangeArrowSvg}
      </div>
    </div>
  `;
}

/** 申請單 ID：requestId 優先，否則剝掉 _1/_2 */
function resolvePrintRequestId(r) {
  if (!r) return '';
  if (r.triangleId != null && String(r.triangleId).trim() !== '') return String(r.triangleId).trim();
  if (r.requestId != null && String(r.requestId).trim() !== '') return String(r.requestId).trim();
  return String(r.id || '').replace(/_[12]$/, '');
}

function isPrintTriangleRec(r) {
  if (!r) return false;
  const type = String(r.type || '').trim().toLowerCase();
  return type === 'triangle' || type === '三角調' || !!String(r.triangleId || '').trim();
}

function isPrintExchangeRec(r) {
  if (!r) return false;
  if (isPrintTriangleRec(r)) return false;
  const t = String(r.type || '');
  if (t === 'exchange' || t === '對調') return true;
  // 後備：id 為 xxx_1 / xxx_2 且有對調特徵
  return /_[12]$/.test(String(r.id || '')) && !!(r.targetDate || r.targetPeriod);
}

function normalizePrintMergeKey(value) {
  return String(value == null ? '' : value).trim().toLowerCase().replace(/\s+/g, ' ');
}

function getPrintBatchId(record) {
  return normalizePrintMergeKey(record && (record.batchId || record['批次ID']));
}

function getPrintRecordTypeKey(record) {
  if (isPrintTriangleRec(record)) return 'triangle';
  if (isPrintExchangeRec(record)) return 'exchange';
  const type = String(record && record.type || '').trim().toLowerCase();
  const reason = String(record && record.reason || '').trim();
  if (type === 'makeup' || type === '補課' || /補課/.test(type) || /補課/.test(reason)) return 'makeup';
  return 'substitution';
}

function getPrintMergeKey(record, ctx) {
  const type = getPrintRecordTypeKey(record);
  const requestId = resolvePrintRequestId(record);
  const rowId = String(record && record.id || '').trim();
  if (type === 'exchange') return `exchange:${requestId || rowId}`;
  if (type === 'triangle') return `triangle:${requestId || rowId}`;

  const week = getPrintWeekKey(record && record.date);
  const batchId = getPrintBatchId(record);
  const combinedReturn = isPrintCombinedReturnRecord(record);
  // 舊有併班資料可能沒有代課教師欄位，但同一批次仍應可合併。
  const actualTeacher = getPrintMergeTeacherKey(record, 'actual', ctx) || (combinedReturn ? 'combined-return' : '');
  const originalTeacher = getPrintMergeTeacherKey(record, 'original', ctx);
  const className = normalizePrintMergeKey(record && record.className);
  if (!week || !actualTeacher || !originalTeacher || !className) {
    return `request:${requestId || rowId}:row:${rowId}`;
  }

  const leaveMode = isPrintLeaveLikeReason(record && record.reason) ? 'leave' : 'course';
  // 批次同班可合併多節，不同班級必須分開列印。
  if (batchId) return `batch-merge:${JSON.stringify([batchId, week, type, actualTeacher, originalTeacher, className, leaveMode])}`;
  return `merge:${JSON.stringify([week, type, actualTeacher, className, originalTeacher, leaveMode])}`;
}

/**
 * 一般代課／補課可跨申請單合併；調課仍以完整雙向申請單為單位。
 * 批次合併條件：同批次、同週、同處理方式、同代課教師、同請假教師、同班級、同請假模式。
 * 非批次資料另保留同班級限制，避免舊資料被過度合併。
 */
function buildPrintGroups(recordsToPrint, allSubs, ctx) {
  const groups = Object.create(null);
  const records = Array.isArray(recordsToPrint) ? recordsToPrint : [];

  const addRecord = function (group, record) {
    if (!record || group.records.some(item => item.id === record.id)) return;
    const reason = record.reason || '請假';
    group.records.push(record);
    const serial = resolvePrintSerial(record);
    if (serial && !group.serials.includes(serial)) group.serials.push(serial);
    const originalKey = getPrintTeacherKey(record, 'original');
    const actualKey = getPrintTeacherKey(record, 'actual');
    if (originalKey && !group.leaveEmails.includes(originalKey)) group.leaveEmails.push(originalKey);
    if (actualKey && !group.subEmails.includes(actualKey)) group.subEmails.push(actualKey);
    if (record.date && !group.dates.includes(record.date)) group.dates.push(record.date);
    if (reason && !group.reasons.includes(reason)) group.reasons.push(reason);
    if (!group.note && record.note) group.note = record.note;
    if (!group.subFee && record.subFee) group.subFee = record.subFee;
    if (record.printed) group.isReprint = true;
    if (record.isPaperDraft) group.isPaperDraft = true;
    Object.assign(group.signatureByTeacher, record.signatureByTeacher || {});
  };

  records.forEach(function (record) {
    const exchange = isPrintExchangeRec(record);
    const triangle = isPrintTriangleRec(record);
    const requestId = resolvePrintRequestId(record);
    const key = getPrintMergeKey(record, ctx);
    if (!groups[key]) {
      groups[key] = {
        isExchange: exchange,
        isTriangle: triangle,
        requestId: requestId || record.id,
        batchId: getPrintBatchId(record),
        serials: [],
        leaveEmails: [],
        subEmails: [],
        dates: [],
        reasons: [],
        subFee: record.subFee || '',
        note: record.note || '',
        records: [],
        periods: [],
        isReprint: false,
        isPaperDraft: false,
        signatureByTeacher: {}
      };
    }
    addRecord(groups[key], record);
  });

  const groupList = Object.values(groups);
  groupList.forEach(function (group) {
    if (group.isTriangle) {
      const triangleId = String(group.requestId || '');
      (allSubs || []).filter(function (candidate) {
        return candidate && resolvePrintRequestId(candidate) === triangleId;
      }).forEach(function (candidate) {
        addRecord(group, candidate);
      });
    } else if (group.isExchange && group.records.length === 1) {
      const current = group.records[0];
      const requestId = String(group.requestId || '');
      const base = String(current.id || '').replace(/_[12]$/, '');
      const peer = (allSubs || []).find(function (candidate) {
        if (!candidate || candidate.id === current.id) return false;
        const candidateRequestId = resolvePrintRequestId(candidate);
        if (requestId && candidateRequestId && requestId === candidateRequestId) return true;
        const candidateBase = String(candidate.id || '').replace(/_[12]$/, '');
        return !!(base && candidateBase && base === candidateBase && /_[12]$/.test(String(candidate.id || '')));
      });
      if (peer) addRecord(group, peer);
    }

    group.records.sort((a, b) => group.isTriangle
      ? ((parseInt(a.triangleLegIndex, 10) || 0) - (parseInt(b.triangleLegIndex, 10) || 0))
        || String(a.date || '').localeCompare(String(b.date || ''))
        || (parseInt(a.period, 10) || 0) - (parseInt(b.period, 10) || 0)
      : String(a.date || '').localeCompare(String(b.date || ''))
        || (parseInt(a.period, 10) || 0) - (parseInt(b.period, 10) || 0));
    group.reasons = uniquePrintValues(group.reasons);
    group.reason = group.reasons[0] || '請假';
    group.leaveEmail = group.leaveEmails[0] || '';
    group.subEmail = group.subEmails[0] || '';
    group.subEmailAll = group.subEmails.slice();
    const applicant = group.isExchange
      ? (group.records.find(record => /_2$/.test(String(record.id || ''))) || group.records[0])
      : group.records[0];
    const triangleInitiator = group.isTriangle
      ? (group.records.find(record => String(record.triangleInitiatorEmail || '').trim())
        || group.records.find(record => parseInt(record.triangleLegIndex, 10) === 1)
        || group.records[0])
      : null;
    group.requesterEmail = group.isTriangle
      ? String((triangleInitiator && (triangleInitiator.triangleInitiatorEmail || triangleInitiator.actualTeacherEmail)) || '').trim()
      : getPrintTeacherKey(applicant, 'original');
    group.requesterName = group.isTriangle
      ? cleanPrintTeacherName((triangleInitiator && (triangleInitiator.triangleInitiatorName || triangleInitiator.actualTeacherName)) || '')
      : (applicant && applicant.originalTeacherName || '');
    group.periods = group.records.map(function (record) {
      return {
        date: group.isTriangle ? (record.triangleSourceDate || record.sourceDate || record.date) : record.date,
        num: parseInt(group.isTriangle
          ? (record.triangleSourcePeriod != null ? record.triangleSourcePeriod : record.period)
          : record.period, 10),
        cls: group.isTriangle ? record.className : (record.formClassName || record.className),
        sub: group.isTriangle ? record.subject : (record.formSubject || record.subject),
        actualTeacherEmail: getPrintTeacherKey(record, 'actual'),
        actualTeacherName: record.actualTeacherName || '',
        sourceDate: record.triangleSourceDate || record.sourceDate || record.date,
        sourcePeriod: record.triangleSourcePeriod != null ? record.triangleSourcePeriod : record.period,
        targetDate: record.triangleTargetDate || record.targetDate || '',
        targetPeriod: record.triangleTargetPeriod != null ? record.triangleTargetPeriod : (record.targetPeriod != null ? record.targetPeriod : ''),
        leaveEmail: getPrintTeacherKey(record, 'original'),
         reason: record.reason || group.reason,
         leaveTimeType: record.leaveTimeType || '',
         leaveTime: record.leaveTime || '',
         subFee: record.subFee || group.subFee || ''
      };
    });
    group.serials = uniquePrintValues(group.serials);
    group.compactSerials = compactSerials(group.serials);
  });
  return groupList;
}

function splitPrintGroupByWeek(group) {
  const rows = getPrintSlotRows(group);
  const buckets = Object.create(null);
  rows.forEach(function (row) {
    const key = getPrintWeekKey(row.date) || 'unknown';
    if (!buckets[key]) buckets[key] = [];
    buckets[key].push(row);
  });
  const keys = Object.keys(buckets);
  if (!keys.length) return [group];
  return keys.sort().map(function (key) {
    const clone = Object.assign({}, group);
    clone.weekRows = buckets[key].slice();
    clone.anchorDate = clone.weekRows[0] && clone.weekRows[0].date;
    return clone;
    });
}

function getPrintAudienceMergeKey(group, ctx) {
  const records = group && Array.isArray(group.records) ? group.records : [];
  const rows = getPrintSlotRows(group);
  const seed = records[0] || rows[0] || {};
  if (!seed) return '';

  // 對調與三角調課本身就是完整路線單，不跨單據重新組合。
  if (group && (group.isExchange || group.isTriangle)) {
    return `audience-special:${group.isExchange ? 'exchange' : 'triangle'}:${group.requestId || resolvePrintSerial(seed)}`;
  }

  const week = getPrintWeekKey((rows[0] && rows[0].date) || seed.date);
  const type = getPrintRecordTypeKey(seed);
  const batchId = getPrintBatchId(seed);
  const combinedReturn = records.some(isPrintCombinedReturnRecord);
  const actualTeacher = getPrintMergeTeacherKey(seed, 'actual', ctx) || (combinedReturn ? 'combined-return' : '');
  const originalTeacher = getPrintMergeTeacherKey(seed, 'original', ctx);
  const leaveMode = isPrintLeaveLikeReason(seed.reason || (group && group.reason)) ? 'leave' : 'course';
  if (!week || !actualTeacher || !originalTeacher) {
    return `audience-single:${group && (group.requestId || group.batchId) || resolvePrintSerial(seed) || seed.id || ''}`;
  }

  // 教學組與教師收到的內容可跨班合併；班級副本另依班級與週次合併。
  return `audience-merge:${JSON.stringify([batchId, week, type, actualTeacher, originalTeacher, leaveMode])}`;
}

function getPrintClassAudienceMergeKey(group, ctx) {
  const records = group && Array.isArray(group.records) ? group.records : [];
  const rows = getPrintSlotRows(group);
  const seed = records[0] || rows[0] || {};
  if (!seed) return '';

  // 對調與三角調課保留完整路線，不與一般班級通知單合併。
  if (group && (group.isExchange || group.isTriangle)) {
    return `audience-class-special:${group.isExchange ? 'exchange' : 'triangle'}:${group.requestId || resolvePrintSerial(seed)}`;
  }

  const classes = uniquePrintValues([
    ...rows.map(row => row && (row.cls || row.className)),
    seed.formClassName || seed.className
  ]);
  const week = getPrintWeekKey((rows[0] && rows[0].date) || seed.date);
  const type = getPrintRecordTypeKey(seed);
  const originalTeacher = getPrintMergeTeacherKey(seed, 'original', ctx);
  const leaveMode = isPrintLeaveLikeReason(seed.reason || (group && group.reason)) ? 'leave' : 'course';
  if (!week || classes.length !== 1 || !originalTeacher) {
    return `audience-class-single:${group && (group.requestId || group.batchId) || resolvePrintSerial(seed) || seed.id || ''}`;
  }

  return `audience-class-merge:${JSON.stringify([week, type, originalTeacher, normalizePrintMergeKey(classes[0]), leaveMode])}`;
}

function mergePrintAudienceGroups(groups, ctx, audience) {
  const buckets = Object.create(null);
  const order = [];
  (groups || []).forEach(function (group) {
    const key = audience === 'class'
      ? getPrintClassAudienceMergeKey(group, ctx)
      : getPrintAudienceMergeKey(group, ctx);
    const fallbackKey = audience === 'class' ? 'audience-class-single' : 'audience-single';
    const resolvedKey = key || `${fallbackKey}:${order.length}`;
    if (!buckets[resolvedKey]) {
      buckets[resolvedKey] = [];
      order.push(resolvedKey);
    }
    buckets[resolvedKey].push(group);
  });

  const rowKey = function (row) {
    return [
      row && (row.id || row.serial || ''),
      row && row.date || '',
      row && (row.num != null ? row.num : row.period) || '',
      row && (row.cls || row.className) || '',
      row && (row.sub || row.subject) || '',
      row && (row.actualTeacherEmail || row.actualTeacherName) || '',
      row && (row.originalTeacherEmail || row.originalTeacherName) || ''
    ].map(value => String(value)).join('|');
  };
  const sortRows = function (a, b) {
    return String(a && a.date || '').localeCompare(String(b && b.date || ''))
      || ((parseInt(a && (a.num != null ? a.num : a.period), 10) || 0)
        - (parseInt(b && (b.num != null ? b.num : b.period), 10) || 0))
      || String(a && (a.cls || a.className) || '').localeCompare(String(b && (b.cls || b.className) || ''));
  };

  return order.map(function (key) {
    const members = buckets[key];
    const base = Object.assign({}, members[0]);
    const records = [];
    const recordKeys = Object.create(null);
    const periods = [];
    const periodKeys = Object.create(null);
    const rows = [];
    const rowKeys = Object.create(null);
    const serials = [];
    const leaveEmails = [];
    const subEmails = [];
    const dates = [];
    const reasons = [];
    let hasWeekRows = false;
    const addValue = function (list, value) {
      const text = String(value == null ? '' : value).trim();
      if (text && !list.includes(text)) list.push(text);
    };

    members.forEach(function (member) {
      if (member && member.weekRows) hasWeekRows = true;
      (member.records || []).forEach(function (record) {
        const recordKey = String(record && record.id || '') || JSON.stringify(record || {});
        if (!recordKeys[recordKey]) {
          recordKeys[recordKey] = true;
          records.push(record);
        }
      });
      (member.periods || []).forEach(function (period) {
        const keyForPeriod = rowKey(period);
        if (!periodKeys[keyForPeriod]) {
          periodKeys[keyForPeriod] = true;
          periods.push(period);
        }
      });
      getPrintSlotRows(member).forEach(function (row) {
        const keyForRow = rowKey(row);
        if (!rowKeys[keyForRow]) {
          rowKeys[keyForRow] = true;
          rows.push(row);
        }
      });
      (member.serials || []).forEach(value => addValue(serials, value));
      (member.leaveEmails || []).forEach(value => addValue(leaveEmails, value));
      (member.subEmails || []).forEach(value => addValue(subEmails, value));
      (member.dates || []).forEach(value => addValue(dates, value));
      (member.reasons || []).forEach(value => addValue(reasons, value));
      addValue(reasons, member.reason);
      if (!base.note && member.note) base.note = member.note;
      if (!base.subFee && member.subFee) base.subFee = member.subFee;
      if (member.isReprint) base.isReprint = true;
      if (member.isPaperDraft) base.isPaperDraft = true;
      base.signatureByTeacher = Object.assign({}, base.signatureByTeacher || {}, member.signatureByTeacher || {});
    });

    records.sort((a, b) => String(a && a.date || '').localeCompare(String(b && b.date || ''))
      || ((parseInt(a && a.period, 10) || 0) - (parseInt(b && b.period, 10) || 0)));
    periods.sort(sortRows);
    rows.sort(sortRows);
    base.records = records;
    base.periods = periods;
    if (hasWeekRows) {
      base.weekRows = rows;
      base.anchorDate = rows[0] && rows[0].date;
    } else {
      delete base.weekRows;
    }
    base.serials = uniquePrintValues(serials);
    base.leaveEmails = uniquePrintValues(leaveEmails);
    base.subEmails = uniquePrintValues(subEmails);
    base.subEmailsAll = base.subEmails.slice();
    base.dates = uniquePrintValues(dates);
    base.reasons = uniquePrintValues(reasons);
    base.reason = base.reasons[0] || '請假';
    base.leaveEmail = base.leaveEmails[0] || '';
    base.subEmail = base.subEmails[0] || '';
    base.compactSerials = compactSerials(base.serials);
    return { group: base, members };
  });
}

function packPrintForms(forms) {
  const list = Array.isArray(forms) ? forms : [];
  const recipientCopies = Array.isArray(list.printCopies) ? list.printCopies : null;
  if (recipientCopies) {
    const emptyCopy = '<div class="substitute-form official-form-empty" aria-hidden="true"></div>';
    const pages = [];
    for (let index = 0; index < recipientCopies.length; index += 2) {
      const left = recipientCopies[index] || emptyCopy;
      const right = recipientCopies[index + 1] || emptyCopy;
      pages.push(`
        <div class="print-page">
          ${left}
          <div class="cut-line"></div>
          ${right}
        </div>
      `);
    }
    return pages.join('');
  }

  const labelSets = Array.isArray(list.audienceLabelSets) ? list.audienceLabelSets : [];
  const defaultLabels = ['教學組留存（請簽名）', '請假教師：', '代課/調課教師：', '班級：'];
  return list.map(function (form, index) {
    const labels = Array.isArray(labelSets[index]) && labelSets[index].length >= 4
      ? labelSets[index]
      : defaultLabels;
    const copy = label => withPrintAudienceLabel(form, label);
    return `
      <div class="print-page">
        ${copy(labels[0])}
        <div class="cut-line"></div>
        ${copy(labels[1])}
      </div>
      <div class="print-page">
        ${copy(labels[2])}
        <div class="cut-line"></div>
        ${copy(labels[3])}
      </div>
    `;
  }).join('');
}

function getSelectedPrintRecords(ctx) {
  try {
    if (typeof document !== 'undefined') {
      const checkedIds = [];
      const renderedIds = [];
      document.querySelectorAll('.hist-select-cb:checked').forEach((el) => {
        const id = el.getAttribute('data-rec-id') || el.value;
        if (id) checkedIds.push(String(id));
      });
      document.querySelectorAll('.hist-select-cb').forEach((el) => {
        const id = el.getAttribute('data-rec-id') || el.value;
        if (id) renderedIds.push(String(id));
      });
      if (ctx.selectedRecordIds) {
        const renderedSet = new Set(renderedIds);
        const ids = (ctx.selectedRecordIds.value || [])
          .map((id) => String(id))
          .filter((id) => !renderedSet.has(id));
        checkedIds.forEach((id) => {
          if (!ids.includes(id)) ids.push(id);
        });
        ctx.selectedRecordIds.value = ids;
      }
    }
  } catch (eSync) { /* ignore */ }

  const ids = ctx.selectedRecordIds && Array.isArray(ctx.selectedRecordIds.value)
    ? ctx.selectedRecordIds.value.slice()
    : [];
  const records = ctx.substitutionRecords && Array.isArray(ctx.substitutionRecords.value)
    ? ctx.substitutionRecords.value.filter(r => ids.includes(r.id))
    : [];
  return { ids, records };
}

function buildPrintForms(recordsToPrint, allSubs, ctx) {
  const groupList = buildPrintGroups(recordsToPrint, allSubs, ctx);
  const weekGroups = [];
  groupList.forEach(function (group) {
    const groups = group.isExchange || group.isTriangle ? [group] : splitPrintGroupByWeek(group);
    groups.forEach(groupByWeek => weekGroups.push(groupByWeek));
  });
  const audienceBundles = mergePrintAudienceGroups(weekGroups, ctx);
  const forms = [];
  const audienceLabelSets = [];
  const printCopies = [];
  const classGroups = [];
  let staffFormCount = 0;
  let classCopyCount = 0;

  audienceBundles.forEach(function (bundle) {
    const staffForm = generateFormHtml(bundle.group, 'Official', ctx);
    if (!staffForm) return;
    const staffLabels = getPrintAudienceLabels(bundle.group, ctx);
    forms.push(withPrintAudienceLabel(staffForm, staffLabels[0]));
    audienceLabelSets.push(staffLabels);
    printCopies.push(withPrintAudienceLabel(staffForm, staffLabels[0]));
    printCopies.push(withPrintAudienceLabel(staffForm, staffLabels[1]));
    printCopies.push(withPrintAudienceLabel(staffForm, staffLabels[2]));
    staffFormCount += 1;

    bundle.members.forEach(member => classGroups.push(member));
  });

  const classBundles = mergePrintAudienceGroups(classGroups, ctx, 'class');
  classBundles.forEach(function (bundle) {
    const classForm = generateFormHtml(bundle.group, 'NoticeClass', ctx);
    if (!classForm) return;
    const classLabels = getPrintAudienceLabels(bundle.group, ctx);
    const classLabel = classLabels[3] || '班級：';
    forms.push(withPrintAudienceLabel(classForm, classLabel));
    audienceLabelSets.push(classLabels);
    printCopies.push(withPrintAudienceLabel(classForm, classLabel));
    classCopyCount += 1;
  });

  forms.audienceLabelSets = audienceLabelSets;
  forms.printCopies = printCopies;
  forms.staffFormCount = staffFormCount;
  forms.classCopyCount = classCopyCount;
  forms.copyCount = printCopies.length;
  forms.pageCount = Math.ceil(printCopies.length / 2);
  return forms;
}

function getPrintPreviewCss() {
  return `
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; background: #e2e8f0; color: #000; }
    body { font-family: "DFKai-SB", "標楷體", "BiauKai", "Noto Serif TC", serif; font-size: 0; line-height: 0; }
    .print-preview-stack { display: flex; flex-direction: column; align-items: center; gap: 8mm; min-width: 158mm; padding: 8mm 4mm 12mm; }
    .print-preview-item { width: 158mm; min-height: 170mm; padding: 6mm 12.7mm 7mm; background: #fff; box-shadow: 0 1px 8px rgba(15, 23, 42, .18); overflow: visible; font-size: 10pt; line-height: normal; }
     .substitute-form { width: 132.045mm; min-height: 156.5mm; height: auto; padding: 0 !important; margin: 0 !important; position: relative; box-sizing: border-box; background: #fff !important; border: none !important; overflow: visible; font-size: 10pt; line-height: normal; }
       .official-audience-label { position: absolute; top: -5.8mm; left: 0; max-width: 92mm; padding: .8mm 2mm; border: none; background: #e5e7eb; font-size: 10pt; font-weight: 700; line-height: 1.2; text-align: left; white-space: normal; overflow-wrap: anywhere; color: #000; }
      .official-audience-label-retain { border: none; background: #e5e7eb; }
      .official-serial-mark { position: absolute; right: 4.78mm; bottom: -4.5mm; max-width: 78mm; font-size: 6.5pt; line-height: 1.1; text-align: right; white-space: normal; overflow-wrap: anywhere; color: #000; }
     .official-form-table-wrap { position: relative; width: 127.265mm; }
     .official-form-table { width: 127.265mm; border-collapse: collapse; table-layout: fixed; font-family: "DFKai-SB", "標楷體", "BiauKai", "Noto Serif TC", serif; font-size: 10pt; color: #000; line-height: 1.05; }
    .official-form-table td, .official-form-table th { border: .5pt solid #000; box-sizing: border-box; padding: 0 1.9mm; vertical-align: middle; overflow: hidden; }
    .official-title-row { height: 7.34mm; font-size: 11pt; font-weight: 700; text-align: center; }
    .official-info-row { height: 11.57mm; }
    .official-info-row td { text-align: center; }
    .official-info-row .official-label { font-weight: 400; white-space: normal; line-height: 1.05; }
    .official-info-row .official-value { font-size: 9.5pt; }
    .official-job-value { text-align: center !important; }
    .official-name-value { text-align: left !important; }
    .official-proxy-value { text-align: right !important; }
    .official-processing-cell { padding: 0 .8mm !important; font-size: 8.5pt; line-height: 1; }
    .official-leave-row, .official-course-row { height: 4.15mm; }
    .official-leave-row td, .official-course-row td { font-size: 8.3pt; }
    .official-label { text-align: center; }
    .official-check-option { text-align: left; white-space: normal; }
    .official-date-cell { text-align: left !important; white-space: nowrap; font-size: 7.4pt !important; line-height: 1.05; padding-left: 1.2mm !important; }
    .official-reason-cell { text-align: left; white-space: normal; font-size: 7.3pt !important; line-height: 1.05; padding-left: 1.2mm !important; padding-right: .8mm !important; word-break: break-all; }
    .official-checkbox { white-space: normal; }
    .official-checkbox.is-checked { font-weight: 700; }
     .official-section-row { height: 8.11mm; font-weight: 400; text-align: center; }
     .official-section-caption { vertical-align: middle; }
     .official-exchange-overlay { position: absolute; z-index: 3; top: 43.43mm; left: 0; width: 127.265mm; height: 104.8mm; overflow: visible; pointer-events: none; }
     .official-exchange-arrow-line { fill: none; stroke: #111827; stroke-width: .25; stroke-linecap: round; }
    .official-signature-header { text-align: center; font-size: 9pt; }
    .official-signature-cell { text-align: center; font-size: 10pt; line-height: 1.25; }
    .official-signature-name { font-size: 9pt; }
    .official-schedule-header { height: 8.11mm; text-align: center; }
    .official-day-header { font-weight: 400; }
    .official-day-date { font-size: 8.5pt; }
    .official-row-label { text-align: center; font-weight: 400; white-space: nowrap; }
    .official-subject-row { height: 8.11mm; }
    .official-class-row { height: 4.99mm; }
     .official-slot-value { text-align: center; font-size: 9pt; white-space: nowrap; }
     .official-subject-row .official-slot-value { white-space: normal; overflow-wrap: anywhere; word-break: break-all; }
     .official-class-value { font-size: 8.5pt; }
    .official-instruction-row { min-height: 8.11mm; height: auto; }
    .official-instruction-row td { text-align: justify; font-size: 8.5pt; line-height: 1.15; padding-top: .6mm; padding-bottom: .6mm; }
  `;
}

function buildPrintPreviewDocument(forms) {
  const items = (forms || []).map(form => `<div class="print-preview-item">${form}</div>`).join('');
  return `<!doctype html><html lang="zh-Hant"><head><meta charset="UTF-8"><title>調代課單預覽</title><style>${getPrintPreviewCss()}</style></head><body><main class="print-preview-stack">${items}</main></body></html>`;
}

function buildPrintPreview(ctx, options) {
  const opts = options || {};
  const recordsToPrint = Array.isArray(opts.records)
    ? opts.records
    : getSelectedPrintRecords(ctx).records;
  const allSubs = Array.isArray(opts.allSubs)
    ? opts.allSubs
    : ((ctx.substitutionRecords && Array.isArray(ctx.substitutionRecords.value)) ? ctx.substitutionRecords.value : recordsToPrint);
  const forms = buildPrintForms(recordsToPrint, allSubs, ctx);
  if (!forms.length) return null;
  const copyCount = forms.copyCount != null ? forms.copyCount : forms.length * 4;
  return {
    recordCount: recordsToPrint.length,
    formCount: forms.length,
    staffFormCount: forms.staffFormCount != null ? forms.staffFormCount : forms.length,
    classCopyCount: forms.classCopyCount != null ? forms.classCopyCount : forms.length,
    pageCount: forms.pageCount != null ? forms.pageCount : Math.ceil(copyCount / 2),
    copyCount,
    records: recordsToPrint.slice(),
    recordIds: recordsToPrint.map(record => record && record.id != null ? String(record.id) : '').filter(Boolean),
    formsHtml: forms.join(''),
    documentHtml: buildPrintPreviewDocument(forms)
  };
}

function buildPrintPreviewImageSvg(preview) {
  const formsHtml = String(preview && preview.formsHtml || '');
  const formCount = Math.max(1, parseInt(preview && preview.formCount, 10) || 1);
  if (!formsHtml) return '';

  const widthMm = 166;
  const heightMm = 8 + 12 + (formCount * 170) + (Math.max(0, formCount - 1) * 8);
  const pxPerMm = 96 / 25.4;
  const width = Math.ceil(widthMm * pxPerMm);
  const height = Math.ceil(heightMm * pxPerMm);
  const imageCss = getPrintPreviewCss() + `
    html, body { width: ${widthMm}mm !important; height: ${heightMm}mm !important; margin: 0 !important; padding: 0 !important; }
    .print-preview-stack { width: ${widthMm}mm !important; min-width: 0 !important; }
  `;
  // SVG 的 foreignObject 需使用 XHTML 可解析的自閉合標籤，避免圖片轉換時整張失敗。
  const xhtmlForms = formsHtml.replace(/<(br|col)(\s[^>]*?)?\/?\s*>/gi, function (_, tag, attrs) {
    return '<' + tag + (attrs || '') + ' />';
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xhtml="http://www.w3.org/1999/xhtml" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><foreignObject x="0" y="0" width="${width}" height="${height}"><div xmlns="http://www.w3.org/1999/xhtml" style="width:${widthMm}mm;height:${heightMm}mm;background:#e2e8f0;"><style><![CDATA[${imageCss}]]></style><main class="print-preview-stack">${xhtmlForms}</main></div></foreignObject></svg>`;
}

function compactSerials(serials) {
  const list = (serials || []).filter(Boolean);
  if (list.length <= 1) return list;
  const roots = {};
  list.forEach(s => {
    const m = String(s).match(/^(.*?)(?:-(\d+))?$/);
    if (!m) {
      if (!roots._raw) roots._raw = [];
      roots._raw.push(s);
      return;
    }
    const root = m[1];
    const n = m[2] ? parseInt(m[2], 10) : null;
    if (!roots[root]) roots[root] = [];
    if (n != null) roots[root].push(n);
    else roots[root].push(null);
  });
  const out = [];
  Object.keys(roots).forEach(root => {
    if (root === '_raw') {
      out.push(...roots[root]);
      return;
    }
    const nums = roots[root].filter(n => n != null).sort((a, b) => a - b);
    if (!nums.length) {
      out.push(root);
    } else if (nums.length === 1) {
      out.push(root + '-' + nums[0]);
    } else {
      out.push(root + '-' + nums[0] + '～' + nums[nums.length - 1] + '（' + nums.length + '節）');
    }
  });
  return out;
}

async function printSelectedForms(formType, ctx) {
  const selection = Array.isArray(ctx.printRecords)
    ? {
      ids: ctx.printRecords.map(record => record && record.id != null ? String(record.id) : '').filter(Boolean),
      records: ctx.printRecords.slice()
    }
    : getSelectedPrintRecords(ctx);
  if (!selection.ids.length) {
    ctx.showToast('請先勾選歷史紀錄中要列印的單據！', 'warning');
    return;
  }

  if (ctx.loading) ctx.loading.value = true;
  if (ctx.loadingMessage) ctx.loadingMessage.value = '正在整理列印資料...';

  try {
    const forms = buildPrintForms(selection.records, ctx.substitutionRecords.value, ctx);

    if (!forms.length) {
      ctx.showToast('沒有可列印的內容', 'warning');
      if (ctx.loading) ctx.loading.value = false;
      return;
    }

    const htmlContent = packPrintForms(forms);

    let printWin = ctx.printWin || ctx.targetWin || null;
    let targetDoc = null;

    if (!printWin) {
      // 降級備援機制：如果 Chrome / Edge 封鎖了 Pop-up，自動建立隱藏 iframe 本頁直印，100% 免除封鎖！
      let hiddenIframe = document.getElementById('hidden-print-iframe');
      if (!hiddenIframe) {
        hiddenIframe = document.createElement('iframe');
        hiddenIframe.id = 'hidden-print-iframe';
        hiddenIframe.style.position = 'fixed';
        hiddenIframe.style.right = '0';
        hiddenIframe.style.bottom = '0';
        hiddenIframe.style.width = '0px';
        hiddenIframe.style.height = '0px';
        hiddenIframe.style.border = 'none';
        hiddenIframe.style.visibility = 'hidden';
        document.body.appendChild(hiddenIframe);
      }
      printWin = hiddenIframe.contentWindow;
      targetDoc = hiddenIframe.contentDocument || hiddenIframe.contentWindow.document;
    } else {
      targetDoc = printWin.document;
    }

    // 預覽／列印已初始化，主視窗即可解除轉圈圈狀態
    if (ctx.loading) ctx.loading.value = false;

    targetDoc.open();
    targetDoc.write(`
      <html>
      <head>
        <title>建成國中調代課通知單</title>
        <style>
          @page { size: A4 landscape; margin: 0; }
           @media print {
             html, body { margin: 0; padding: 0; background: white !important; }
           }
           body {
             background: white !important;
             color: #000 !important;
             margin: 0;
             padding: 0;
             font-family: "DFKai-SB", "標楷體", "BiauKai", "Noto Serif TC", serif;
             font-size: 0;
             line-height: 0;
             overflow: visible;
           }
           #print-root { display: block; margin: 0; padding: 0; }
           .print-page {
             width: 297mm;
             height: 210mm;
             min-height: 210mm;
              page-break-after: auto;
              break-after: auto;
             box-sizing: border-box;
             padding: 12.7mm;
             display: flex;
             flex-direction: row;
             justify-content: flex-start;
             align-items: flex-start;
             gap: 7.496mm;
             position: relative;
             font-size: 10pt;
             line-height: normal;
             overflow: hidden;
             background: white !important;
            -webkit-print-color-adjust: exact;
            print-color-adjust: exact;
          }
           .print-page + .print-page {
             page-break-before: always;
             break-before: page;
           }
          .cut-line {
            display: none;
          }
           .substitute-form {
            width: 132.045mm;
            flex: 0 0 132.045mm;
            min-height: 156.5mm;
            height: auto;
            padding: 0 !important;
            margin: 0 !important;
            position: relative;
            box-sizing: border-box;
            background: white !important;
            border: none !important;
            page-break-after: avoid;
            page-break-inside: avoid;
             break-inside: avoid;
             overflow: visible;
           }
           .official-form-empty { visibility: hidden; }
             .official-audience-label { position: absolute; top: -5.8mm; left: 0; max-width: 92mm; padding: .8mm 2mm; border: none; background: #e5e7eb; font-size: 10pt; font-weight: 700; line-height: 1.2; text-align: left; white-space: normal; overflow-wrap: anywhere; color: #000; }
             .official-audience-label-retain { border: none; background: #e5e7eb; }
             .official-serial-mark { position: absolute; right: 4.78mm; bottom: -4.5mm; max-width: 78mm; font-size: 6.5pt; line-height: 1.1; text-align: right; white-space: normal; overflow-wrap: anywhere; color: #000; }
           .official-form-table-wrap { position: relative; width: 127.265mm; }
           .official-form-table {
            width: 127.265mm;
            border-collapse: collapse;
            table-layout: fixed;
            font-family: "DFKai-SB", "標楷體", "BiauKai", "Noto Serif TC", serif;
            font-size: 10pt;
            color: #000;
            line-height: 1.05;
          }
          .official-form-table td,
          .official-form-table th {
            border: 0.5pt solid #000;
            box-sizing: border-box;
            padding: 0 1.9mm;
            vertical-align: middle;
            overflow: hidden;
          }
          .official-title-row { height: 7.34mm; font-size: 11pt; font-weight: 700; text-align: center; }
          .official-info-row { height: 11.57mm; }
          .official-info-row td { text-align: center; }
          .official-info-row .official-label { font-weight: 400; white-space: normal; line-height: 1.05; }
          .official-info-row .official-value { font-size: 9.5pt; }
          .official-job-value { text-align: center !important; }
          .official-name-value { text-align: left !important; }
          .official-proxy-value { text-align: right !important; }
          .official-processing-cell { padding: 0 0.8mm !important; font-size: 8.5pt; line-height: 1; }
          .official-leave-row,
          .official-course-row { height: 4.15mm; }
          .official-leave-row td,
          .official-course-row td { font-size: 8.3pt; }
          .official-label { text-align: center; }
          .official-check-option { text-align: left; white-space: normal; }
          .official-date-cell { text-align: left !important; white-space: nowrap; font-size: 7.4pt !important; line-height: 1.05; padding-left: 1.2mm !important; }
          .official-reason-cell { text-align: left; white-space: normal; font-size: 7.3pt !important; line-height: 1.05; padding-left: 1.2mm !important; padding-right: 0.8mm !important; word-break: break-all; }
          .official-checkbox { white-space: normal; }
          .official-checkbox.is-checked { font-weight: 700; }
            .official-section-row { height: 8.11mm; font-weight: 400; text-align: center; }
            .official-section-caption { vertical-align: middle; }
            .official-exchange-overlay { position: absolute; z-index: 3; top: 43.43mm; left: 0; width: 127.265mm; height: 104.8mm; overflow: visible; pointer-events: none; }
            .official-exchange-arrow-line { fill: none; stroke: #111827; stroke-width: 0.25; stroke-linecap: round; }
          .official-signature-header { text-align: center; font-size: 9pt; }
          .official-signature-cell { text-align: center; font-size: 10pt; line-height: 1.25; }
          .official-signature-name { font-size: 9pt; }
          .official-schedule-header { height: 8.11mm; text-align: center; }
          .official-day-header { font-weight: 400; }
          .official-day-date { font-size: 8.5pt; }
          .official-row-label { text-align: center; font-weight: 400; white-space: nowrap; }
          .official-subject-row { height: 8.11mm; }
          .official-class-row { height: 4.99mm; }
           .official-slot-value { text-align: center; font-size: 9pt; white-space: nowrap; }
           .official-subject-row .official-slot-value { white-space: normal; overflow-wrap: anywhere; word-break: break-all; }
           .official-class-value { font-size: 8.5pt; }
          .official-instruction-row { min-height: 8.11mm; height: auto; }
          .official-instruction-row td { text-align: justify; font-size: 8.5pt; line-height: 1.15; padding-top: 0.6mm; padding-bottom: 0.6mm; }
        </style>
      </head>
      <body style="background: white !important;">
        <main id="print-root">${htmlContent}</main>
        <script>
          window.onload = function() {
            setTimeout(function() {
              window.print();
              if (window.opener) {
                try { window.close(); } catch(e) {}
              }
            }, 300);
          }
        <\/script>
      </body>
      </html>
    `);
    targetDoc.close();

    const idsToMark = new Set(selection.ids);
    selection.ids.forEach(id => {
      const rec = ctx.substitutionRecords.value.find(r => r.id === id);
      if (rec && rec.type === 'exchange' && rec.requestId) {
        const peer = ctx.substitutionRecords.value.find(r => r.requestId === rec.requestId && r.id !== id);
        if (peer) idsToMark.add(peer.id);
      }
    });
    const markIds = Array.from(idsToMark);
    if (!ctx.skipMarkPrinted) {
      // G：本地已印（陣列替換觸發 Vue 更新），不再整包 loadWeeklyData
      if (typeof ctx.markLocalPrinted === 'function') {
        ctx.markLocalPrinted(markIds);
      } else {
        markIds.forEach(id => {
          const rec = ctx.substitutionRecords.value.find(r => r.id === id);
          if (rec) rec.printed = true;
          const reqId = String(id).replace(/_[12]$/, '');
          if (ctx.requestsList && ctx.requestsList.value) {
            const req = ctx.requestsList.value.find(r => r.id === reqId);
            if (req) req.printed = true;
          }
        });
      }
    }
    ctx.selectedRecordIds.value = [];

    if (!ctx.skipMarkPrinted) {
      // 等待寫入 GAS，避免列印後立刻關頁造成已列印狀態尚未落地。
      if (typeof ctx.callGasApi === 'function') {
        try {
          await ctx.callGasApi('batchMarkPrinted', { ids: markIds });
        } catch (err) {
          console.error('標記列印出錯：', err);
          if (typeof ctx.showToast === 'function') {
            ctx.showToast('列印完成，但已列印狀態同步失敗，請重新整理確認。', 'warning');
          }
        }
      }
    }
  } catch (err) {
    ctx.showToast('列印失敗：' + (err.message || err), 'error');
    console.error('列印出錯：', err);
  } finally {
    if (ctx.loading) ctx.loading.value = false;
  }
}

window.generateFormHtml = generateFormHtml;
window.printSelectedForms = printSelectedForms;
window.buildExchangeRouteHtml = buildExchangeRouteHtml;
window.getPrintAudienceLabels = getPrintAudienceLabels;
window.buildPrintGroups = buildPrintGroups;
window.buildPrintForms = buildPrintForms;
window.splitPrintGroupByWeek = splitPrintGroupByWeek;
window.packPrintForms = packPrintForms;
window.getPrintPreviewCss = getPrintPreviewCss;
window.buildPrintPreview = buildPrintPreview;
window.buildPrintPreviewImageSvg = buildPrintPreviewImageSvg;
