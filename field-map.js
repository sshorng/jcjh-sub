/**
 * 前後端欄位對照層 (field-map.js)
 * Sheets 存中文欄位；前端用英文 camelCase。
 * 讀取時支援別名（相容舊表頭 / 新表頭）。
 */
window.FieldMap = (function () {
  const SPECIAL_FLOW_COMBINED_RETURN = 'combined_return';
  const SPECIAL_FLOW_COMBINED_RETURN_LABEL = '合班回原班';

  function normalizeSpecialFlow(raw) {
    const value = String(raw == null ? '' : raw).trim();
    if (!value) return '';
    if (value.toLowerCase() === SPECIAL_FLOW_COMBINED_RETURN
        || value === SPECIAL_FLOW_COMBINED_RETURN_LABEL) {
      return SPECIAL_FLOW_COMBINED_RETURN;
    }
    return value;
  }

  function isCombinedReturn(rowOrValue) {
    const raw = rowOrValue && typeof rowOrValue === 'object'
      ? pick(rowOrValue, ['特殊流程', 'specialFlow'])
      : rowOrValue;
    return normalizeSpecialFlow(raw) === SPECIAL_FLOW_COMBINED_RETURN;
  }

  function pick(row, keys) {
    if (!row) return undefined;
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      if (Object.prototype.hasOwnProperty.call(row, k) && row[k] !== undefined && row[k] !== null && row[k] !== '') {
        return row[k];
      }
    }
    for (let j = 0; j < keys.length; j++) {
      const k2 = keys[j];
      if (Object.prototype.hasOwnProperty.call(row, k2) && row[k2] !== undefined && row[k2] !== null) {
        return row[k2];
      }
    }
    return undefined;
  }

  function alias(obj, property, getter) {
    Object.defineProperty(obj, property, {
      configurable: true,
      enumerable: false,
      get: getter
    });
    return obj;
  }

  function asBool(v) {
    if (v === true || v === 1) return true;
    const s = String(v == null ? '' : v).trim().toLowerCase();
    return s === 'true' || s === '1' || s === '是' || s === '紙本';
  }

  function asInt(v, fallback) {
    // 明確允許 0（基本鐘點打 0 就是 0，不可被預設蓋掉）
    if (v === undefined || v === null || v === '') return fallback;
    if (v === 0 || v === '0') return 0;
    const n = parseInt(v, 10);
    return Number.isNaN(n) ? fallback : n;
  }

  function asTimestamp(v) {
    if (v === undefined || v === null || v === '') return '';
    if (Object.prototype.toString.call(v) === '[object Date]' && !isNaN(v.getTime())) {
      return v.getFullYear() + '-' + String(v.getMonth() + 1).padStart(2, '0') + '-' + String(v.getDate()).padStart(2, '0')
        + ' ' + String(v.getHours()).padStart(2, '0') + ':' + String(v.getMinutes()).padStart(2, '0') + ':' + String(v.getSeconds()).padStart(2, '0');
    }
    return String(v).trim();
  }

  function asDateStr(v) {
    if (v === undefined || v === null || v === '') return '';
    if (Object.prototype.toString.call(v) === '[object Date]' && !isNaN(v.getTime())) {
      return v.getFullYear() + '-' + String(v.getMonth() + 1).padStart(2, '0') + '-' + String(v.getDate()).padStart(2, '0');
    }
    const raw = String(v).trim().split(/[T ]/)[0].replace(/\//g, '-');
    const match = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (!match) return raw.slice(0, 10);
    return match[1] + '-' + String(match[2]).padStart(2, '0') + '-' + String(match[3]).padStart(2, '0');
  }

  /** 折抵額度可為 0.5 倍數 */
  function asFloat(v, fallback) {
    if (v === undefined || v === null || v === '') return fallback;
    if (v === 0 || v === '0') return 0;
    const n = parseFloat(v);
    if (Number.isNaN(n)) return fallback;
    return Math.round(n * 1000) / 1000;
  }

  function mapSemester(s) {
    return {
      id: pick(s, ['學期代號', 'id']),
      name: pick(s, ['學期名稱', 'name']),
      startDate: pick(s, ['開始日期', 'startDate']) || '',
      endDate: pick(s, ['結束日期', 'endDate']) || '',
      isDefault: asBool(pick(s, ['是否預設', 'isDefault']))
    };
  }

  function mapClassAwayEvent(e) {
    // 試算表常把單一「901」存成數字、或把清單弄成 0／日期；交給 DomainClassAway 淨化
    const classesRaw = pick(e, ['班級清單', 'classes', 'classList']);
    let classes = [];
    if (window.DomainClassAway && window.DomainClassAway.parseClassList) {
      classes = window.DomainClassAway.parseClassList(classesRaw);
    } else if (Array.isArray(classesRaw)) {
      classes = classesRaw.map(function (x) { return String(x == null ? '' : x).trim(); }).filter(function (x) { return x && !/^0+$/.test(x); });
    } else if (classesRaw !== undefined && classesRaw !== null && classesRaw !== '') {
      if (typeof classesRaw === 'number' && (!classesRaw || classesRaw < 1)) {
        classes = [];
      } else {
        classes = String(classesRaw)
          .split(/[,，、;\s]+/)
          .map(function (x) { return String(x || '').trim(); })
          .filter(function (x) { return x && !/^0+$/.test(x); });
      }
    }
    let rule = String(pick(e, ['鐘點規則', 'billingRule']) || 'keep').toLowerCase();
    if (rule === '調降' || rule === 'reduce') rule = 'reduce';
    else rule = 'keep';
    // 日期欄若被 Sheets 轉成 Date，轉回 YYYY-MM-DD
    function asDateStr(v) {
      if (v === undefined || v === null || v === '') return '';
      if (Object.prototype.toString.call(v) === '[object Date]' && !isNaN(v.getTime())) {
        const y = v.getFullYear();
        const m = String(v.getMonth() + 1).padStart(2, '0');
        const d = String(v.getDate()).padStart(2, '0');
        return y + '-' + m + '-' + d;
      }
      return String(v).trim().slice(0, 10);
    }
    return {
      id: String(pick(e, ['事件ID', 'id']) || ''),
      semesterId: String(pick(e, ['學期代號', 'semesterId']) || ''),
      name: String(pick(e, ['事件名稱', 'name']) || ''),
      startDate: asDateStr(pick(e, ['起日', 'startDate'])),
      endDate: asDateStr(pick(e, ['迄日', 'endDate'])),
      classes: classes,
      billingRule: rule,
      forMutual: asBool(pick(e, ['可進互代', 'forMutual'])),
      enabled: pick(e, ['啟用', 'enabled']) === undefined || pick(e, ['啟用', 'enabled']) === null || pick(e, ['啟用', 'enabled']) === ''
        ? true
        : asBool(pick(e, ['啟用', 'enabled'])),
      note: String(pick(e, ['備註', 'note']) || '')
    };
  }

  function mapSchoolSwap(row) {
    function dateText(value) {
      if (value === undefined || value === null || value === '') return '';
      if (Object.prototype.toString.call(value) === '[object Date]' && !isNaN(value.getTime())) {
        return value.getFullYear() + '-' + String(value.getMonth() + 1).padStart(2, '0') + '-' + String(value.getDate()).padStart(2, '0');
      }
      return String(value).trim().slice(0, 10);
    }
    const dateA = dateText(pick(row, ['日期A', 'dateA']));
    const dateB = dateText(pick(row, ['日期B', 'dateB']));
    const periodA = asInt(pick(row, ['節次A', 'periodA']), null);
    const periodB = asInt(pick(row, ['節次B', 'periodB']), null);
    return {
      id: String(pick(row, ['對調ID', 'id', 'swapId']) || ''),
      semesterId: String(pick(row, ['學期代號', 'semesterId']) || ''),
      name: String(pick(row, ['事件名稱', 'name', 'title']) || '全校對調'),
      dateA: dateA,
      dayA: asInt(pick(row, ['星期A', 'dayA']), 0),
      periodA: periodA,
      dateB: dateB,
      dayB: asInt(pick(row, ['星期B', 'dayB']), 0),
      periodB: periodB,
      enabled: pick(row, ['啟用', 'enabled']) === undefined || pick(row, ['啟用', 'enabled']) === null || pick(row, ['啟用', 'enabled']) === ''
        ? true
        : asBool(pick(row, ['啟用', 'enabled'])),
      createdAt: String(pick(row, ['建立時間', 'createdAt']) || ''),
      updatedAt: String(pick(row, ['更新時間', 'updatedAt']) || ''),
      note: String(pick(row, ['備註', 'note']) || '')
    };
  }

  /** 系統角色正規化：admin／staff／teacher */
  function normalizeRole(raw) {
    const s = String(raw == null ? '' : raw).trim().toLowerCase();
    if (!s) return 'teacher';
    if (s === 'admin' || s.indexOf('管理') >= 0 || s.indexOf('教學組') >= 0
        || s.indexOf('主管') >= 0 || s === 'administrator') return 'admin';
    if (s === 'staff' || s === '行政' || s.indexOf('行政') >= 0 || s === 'clerk') return 'staff';
    if (s === 'teacher' || s.indexOf('教師') >= 0 || s.indexOf('老師') >= 0) return 'teacher';
    return 'teacher';
  }

  /**
   * 超鐘點經費配置共用格式：教師名單的單一儲存格存 JSON 陣列。
   * 舊資料若是一般文字，視為該教師所有超鐘點的單一來源。
   */
  function normalizeExpenseSource(raw) {
    return String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim();
  }

  function expenseClassTokens(raw) {
    return String(raw == null ? '' : raw).trim()
      .split(/[,，、\/／;；|｜\s]+/)
      .map(function (value) { return value.trim(); })
      .filter(function (value) { return value && !/^0+$/.test(value); });
  }

  function expenseClassesOverlap(left, right) {
    const leftTokens = expenseClassTokens(left);
    const rightTokens = expenseClassTokens(right);
    if (!leftTokens.length || !rightTokens.length) return true;
    return leftTokens.some(function (value) { return rightTokens.indexOf(value) >= 0; });
  }

  function isExpensePeriod(value) {
    const period = parseInt(value, 10);
    return period === 0 || period === 45 || (period >= 1 && period <= 8);
  }

  function normalizeExpenseSlot(item, inheritedSource) {
    if (!item || typeof item !== 'object') return null;
    const source = normalizeExpenseSource(inheritedSource || item.source || item.plan
      || item['經費來源'] || item['支出計畫'] || item['計畫']);
    const day = parseInt(item.day !== undefined ? item.day
      : (item.dayOfWeek !== undefined ? item.dayOfWeek : item['星期']), 10);
    const period = parseInt(item.period !== undefined ? item.period : item['節次'], 10);
    const className = String(item.className !== undefined ? item.className
      : (item['班級'] !== undefined ? item['班級'] : '')).trim();
    if (!source || !Number.isFinite(day) || day < 1 || day > 7 || !isExpensePeriod(period)) return null;
    return { day: day, period: period, className: className, source: source };
  }

  function parseExpensePlan(value) {
    const empty = { mode: 'empty', slots: [], legacySource: '', invalid: false, invalidCount: 0 };
    if (Array.isArray(value)) value = JSON.stringify(value);
    const text = String(value == null ? '' : value).trim();
    if (!text) return empty;

    let raw;
    if (text.charAt(0) !== '[') {
      return { mode: 'legacy', slots: [], legacySource: normalizeExpenseSource(text), invalid: false, invalidCount: 0 };
    }
    try {
      raw = JSON.parse(text);
    } catch (e) {
      return { mode: 'invalid', slots: [], legacySource: '', invalid: true, invalidCount: 1 };
    }
    if (!Array.isArray(raw)) {
      return { mode: 'invalid', slots: [], legacySource: '', invalid: true, invalidCount: 1 };
    }

    const slots = [];
    const seen = {};
    let invalidCount = 0;
    raw.forEach(function (item) {
      if (item && Array.isArray(item.slots)) {
        const inherited = item.source || item.plan || item['經費來源'] || item['支出計畫'] || item['計畫'];
        item.slots.forEach(function (slot) {
          const normalized = normalizeExpenseSlot(slot, inherited);
          if (!normalized) {
            invalidCount += 1;
            return;
          }
          const key = normalized.day + '|' + normalized.period + '|' + normalized.className;
          if (seen[key]) {
            invalidCount += 1;
            return;
          }
          seen[key] = true;
          slots.push(normalized);
        });
        return;
      }
      const normalized = normalizeExpenseSlot(item);
      if (!normalized) {
        invalidCount += 1;
        return;
      }
      const key = normalized.day + '|' + normalized.period + '|' + normalized.className;
      if (seen[key]) {
        invalidCount += 1;
        return;
      }
      seen[key] = true;
      slots.push(normalized);
    });
    return {
      mode: 'slots',
      slots: slots,
      legacySource: '',
      invalid: invalidCount > 0,
      invalidCount: invalidCount
    };
  }

  function expensePlanSourceForSlot(value, slot) {
    const parsed = value && value.mode ? value : parseExpensePlan(value);
    if (!slot) return '';
    if (parsed.mode === 'legacy') return parsed.legacySource;
    if (parsed.mode !== 'slots') return '';
    const day = parseInt(slot.day !== undefined ? slot.day : slot.dayOfWeek, 10);
    const period = parseInt(slot.period, 10);
    const className = slot.className !== undefined ? slot.className : slot['班級'];
    const hits = parsed.slots.filter(function (item) {
      return item.day === day && item.period === period && expenseClassesOverlap(item.className, className);
    });
    const sources = [];
    hits.forEach(function (item) {
      if (sources.indexOf(item.source) < 0) sources.push(item.source);
    });
    return sources.length === 1 ? sources[0] : '';
  }

  function expensePlanSources(value) {
    const parsed = value && value.mode ? value : parseExpensePlan(value);
    const sources = [];
    if (parsed.mode === 'legacy' && parsed.legacySource) return [parsed.legacySource];
    (parsed.slots || []).forEach(function (item) {
      if (sources.indexOf(item.source) < 0) sources.push(item.source);
    });
    return sources;
  }

  function serializeExpensePlanSlots(slots) {
    const normalized = [];
    const seen = {};
    (slots || []).forEach(function (slot) {
      const item = normalizeExpenseSlot(slot);
      if (!item) return;
      const key = item.day + '|' + item.period + '|' + item.className;
      if (seen[key]) return;
      seen[key] = true;
      normalized.push(item);
    });
    return JSON.stringify(normalized);
  }

  function formatExpensePlanSummary(value) {
    const parsed = value && value.mode ? value : parseExpensePlan(value);
    if (parsed.mode === 'legacy') return parsed.legacySource || '預設';
    if (parsed.mode !== 'slots') return parsed.invalid ? '配置格式錯誤' : '預設';
    const counts = {};
    const order = [];
    (parsed.slots || []).forEach(function (item) {
      if (!counts[item.source]) {
        counts[item.source] = 0;
        order.push(item.source);
      }
      counts[item.source] += 1;
    });
    return order.length ? order.map(function (source) {
      return source + '（' + counts[source] + '節）';
    }).join('、') : '預設';
  }

  function normalizeSpecialTags(raw) {
    const aliases = {
      '合班': '併班',
      '綁班': '綁課',
      '綁課': '綁課',
      '併班': '併班',
      '抽離': '抽離',
      '超鐘點': '超鐘點',
      '實支': '實支',
      '預排': '預排'
    };
    const seen = {};
    return String(raw == null ? '' : raw)
      .split(/[,，、;；\/／|｜\n]+/)
      .map(function (value) { return aliases[String(value || '').trim()] || String(value || '').trim(); })
      .filter(function (value) {
        if (!value || seen[value]) return false;
        seen[value] = true;
        return true;
      })
      .join('、');
  }

  function isRestrictedScheduleValue(raw) {
    const value = String(raw == null ? '' : raw).trim().toLowerCase();
    return value === 'restricted' || value === '限制' || value === '綁課' || value === '綁班'
      || value.indexOf('綁') >= 0 || value.indexOf('限制') >= 0
      || value === 'y' || value === 'yes' || value === '是' || value === 'true';
  }

  function mapTeacher(t) {
    const loginEmail = String(pick(t, ['教師Email', 'loginEmail', 'email']) || '').trim().toLowerCase();
    const name = pick(t, ['教師姓名', 'teacherName', 'name']) || '';
    return {
      loginEmail: loginEmail,
      // Email is retained only as the roster login field; domain keys use teacherName.
      email: name,
      teacherName: name,
      name: name,
      subject: pick(t, ['授課科目', '任課科目', 'subject']) || '',
      jobTitle: String(pick(t, ['職務', '職稱', 'jobTitle']) || ''),
      expensePlan: String(pick(t, ['鐘點支出計畫', '鐘點支出來源', '支出計畫', '計畫', 'expensePlan', 'plan']) || '').trim(),
      role: normalizeRole(pick(t, ['系統角色', 'role']) || 'teacher'),
      baseHours: asInt(pick(t, ['基本鐘點', 'baseHours']), 16),
      // 折抵額度：釋出 1 節＝0.5；扣額度須滿 1 才扣 1
      mutualQuota: asFloat(pick(t, ['折抵額度', 'mutualQuota']), 0)
    };
  }

  function mapSchedule(s) {
    let cn = pick(s, ['班級', 'className']);
    if (cn !== undefined && cn !== null && cn !== '') {
      cn = String(cn).trim();
      // 過濾 Sheets 污染：0 / 000
      if (/^0+$/.test(cn)) cn = '';
    } else {
      cn = '';
    }
    let subj = String(pick(s, ['科目', 'subject']) || '').trim();
    let attr = String(pick(s, ['課堂屬性', 'attr']) || '').trim();
    const specialTags = normalizeSpecialTags(pick(s, ['特殊標記', 'specialTags', 'specialTagsText']) || '');
    const specialTagList = specialTags.split('、').filter(Boolean);
    if (attr.indexOf('超鐘點') >= 0) attr = '超鐘點';
    if ((!attr || attr === '一般' || attr === '基本') && specialTagList.indexOf('抽離') >= 0) attr = '抽離';
    else if ((!attr || attr === '一般' || attr === '基本') && specialTagList.indexOf('超鐘點') >= 0) attr = '超鐘點';
    else if ((!attr || attr === '一般' || attr === '基本') && specialTagList.indexOf('實支') >= 0) attr = '實支';
    else if ((!attr || attr === '一般' || attr === '基本') && specialTagList.indexOf('預排') >= 0) attr = '預排';
    // 基礎課表常見：科目或班級寫「巡堂」、屬性空白 → 正規成 attr=巡堂
    const isPatrol = attr.indexOf('巡堂') >= 0 || cn.indexOf('巡堂') >= 0 || subj.indexOf('巡堂') >= 0;
    if (isPatrol) {
      attr = '巡堂';
      cn = '';
      subj = '';
    }
    const mapped = {
      id: pick(s, ['課表ID', 'id']),
      teacherName: pick(s, ['教師姓名', 'teacherName']) || '',
      dayOfWeek: asInt(pick(s, ['星期', 'dayOfWeek']), 0),
      period: asInt(pick(s, ['節次', 'period']), 0),
      className: cn,
      subject: subj,
      attr: attr,
      activeFrom: asDateStr(pick(s, ['啟用起日', '啟用開始日', 'activeFrom', 'activationStartDate', 'effectiveStartDate'])),
      activeTo: asDateStr(pick(s, ['啟用迄日', '啟用結束日', 'activeTo', 'activationEndDate', 'effectiveEndDate'])),
      restriction: (function () {
        const raw = pick(s, ['調課限制', 'restriction']) || '';
        return isRestrictedScheduleValue(raw) || specialTagList.indexOf('綁課') >= 0 ? 'restricted' : raw;
      })(),
      specialTags: specialTags,
      isPreplanned: attr === '預排' || specialTagList.indexOf('預排') >= 0
    };
    alias(mapped, 'teacherEmail', function () { return mapped.teacherName; });
    return mapped;
  }

  function mapSubstitution(sub) {
    const mapped = {
      id: pick(sub, ['紀錄ID', 'id']),
      date: asDateStr(pick(sub, ['異動日期', 'date'])),
      period: asInt(pick(sub, ['節次', 'period']), 0),
      originalTeacherName: pick(sub, ['原授課教師姓名', '原任課教師姓名', '原導師姓名', 'originalTeacherName']) || '',
      actualTeacherName: pick(sub, ['\u5be6\u969b\u6388\u8ab2\u6559\u5e2b\u59d3\u540d', '\u4ee3\u8ab2\u6559\u5e2b\u59d3\u540d', 'actualTeacherName']) || '',
      className: String(pick(sub, ['班級', 'className']) || ''),
      subject: pick(sub, ['科目', 'subject']) || '',
      requestId: pick(sub, ['申請單ID', 'requestId']) || '',
      type: pick(sub, ['異動類型', 'type']),
      specialFlow: normalizeSpecialFlow(pick(sub, ['特殊流程', 'specialFlow'])),
      printed: asBool(pick(sub, ['是否已印', 'printed'])),
      subFee: pick(sub, ['經費來源', 'subFee']) || '',
      reason: pick(sub, ['請假事由', 'reason']) || '',
      note: pick(sub, ['備註', 'note']) || '',
      leaveTimeType: pick(sub, ['請假時間類型', 'leaveTimeType']) || '',
      leaveTime: pick(sub, ['請假時間', 'leaveTime', 'timeRange']) || '',
      isEmptySlotAssign: (function () {
        const reason = String(pick(sub, ['請假事由', 'reason']) || '').trim();
        const note = String(pick(sub, ['備註', 'note']) || '');
        return reason === '空堂排班' || note.indexOf('[空堂排班]') >= 0 || sub.isEmptySlotAssign === true;
      })()
    };
    alias(mapped, 'originalTeacherEmail', function () { return mapped.originalTeacherName; });
    alias(mapped, 'actualTeacherEmail', function () { return mapped.actualTeacherName; });
    return mapped;
  }

  /** 狀態：中文表頭／舊別名 → 英文碼（前端過濾用） */
  function normalizeRequestStatus(raw) {
    const s = String(raw == null ? '' : raw).trim();
    if (!s) return '';
    const en = s.toLowerCase();
    if (en === 'pending_teacher' || en === 'pending_admin' || en === 'approved'
        || en === 'rejected' || en === 'admin_rejected' || en === 'cancelled' || en === 'withdrawn') {
      return en;
    }
    const map = {
      '待受邀人簽核': 'pending_teacher',
      '待行政審核': 'pending_admin',
      '送交教學組': 'pending_admin',
      '已核准': 'approved',
      '核准生效': 'approved',
      '受邀人已拒絕': 'rejected',
      '行政已退回': 'admin_rejected',
      '行政駁回': 'admin_rejected',
      '已取消': 'cancelled',
      '已撤銷': 'cancelled',
      '已撤回': 'withdrawn'
    };
    return map[s] || s;
  }

  function normalizeRequestType(raw) {
    const value = String(raw == null ? '' : raw).trim();
    const lower = value.toLowerCase();
    if (lower === 'triangle' || value === '三角調') return 'triangle';
    if (lower === 'exchange' || value === '對調') return 'exchange';
    if (lower === 'substitution' || value === '代課') return 'substitution';
    return value;
  }

  function mapRequest(r) {
    const targetDay = pick(r, ['對調目標星期', 'targetDayOfWeek']);
    const targetPeriod = pick(r, ['對調目標節次', 'targetPeriod']);
    const paperFlowRaw = pick(r, ['紙本流程', 'paperFlow', 'isPaperFlow']);
    const directApproveRaw = pick(r, ['直接核准', '是否直接核准', 'directApprove']);
    const createdAtRaw = pick(r, ['建立時間', 'createdAt', '建立日期', '申請時間', '申請日期', 'createdDate', 'requestCreatedAt', 'created_at', 'timestamp']);
    const updatedAtRaw = pick(r, ['更新時間', 'updatedAt', 'updated_at']);
    const mapped = {
      id: pick(r, ['申請單ID', 'id']),
      serial: pick(r, ['單號', 'serial']),
      batchId: pick(r, ['批次ID', 'batchId']) || '',
      status: normalizeRequestStatus(pick(r, ['狀態', 'status'])),
      paperFlow: asBool(paperFlowRaw),
      paperFlowSpecified: paperFlowRaw !== undefined && paperFlowRaw !== null
        && String(paperFlowRaw).trim() !== '',
      requesterName: pick(r, ['申請人姓名', 'requesterName']),
      targetTeacherName: pick(r, ['受邀人姓名', 'targetTeacherName']),
      actualTeacherName: pick(r, ['實際授課教師姓名', 'actualTeacherName']) || '',
      className: String(pick(r, ['班級', 'className']) || ''),
      subject: pick(r, ['科目', 'subject']) || '',
      requestDate: asDateStr(pick(r, ['異動日期', 'requestDate'])),
      requestPeriodDay: asInt(pick(r, ['異動星期', 'requestPeriodDay']), null),
      requestPeriod: asInt(pick(r, ['異動節次', 'requestPeriod']), null),
      type: normalizeRequestType(pick(r, ['異動類型', 'type'])),
      specialFlow: normalizeSpecialFlow(pick(r, ['特殊流程', 'specialFlow'])),
      targetDate: asDateStr(pick(r, ['對調目標日期', 'targetDate'])),
      targetDayOfWeek: targetDay === undefined || targetDay === null || targetDay === '' ? null : asInt(targetDay, null),
      targetPeriod: targetPeriod === undefined || targetPeriod === null || targetPeriod === '' ? null : asInt(targetPeriod, null),
      targetClassName: String(pick(r, ['對調目標班級', 'targetClassName']) || ''),
      targetSubject: pick(r, ['對調目標科目', 'targetSubject']) || '',
      subFee: pick(r, ['經費來源', 'subFee']) || '',
      reason: pick(r, ['請假事由', 'reason']) || '',
      leaveTimeType: pick(r, ['請假時間類型', 'leaveTimeType']) || '',
      leaveTime: pick(r, ['請假時間', 'leaveTime', 'timeRange']) || '',
      note: pick(r, ['備註', 'note']) || '',
      printed: asBool(pick(r, ['是否已印', 'printed'])),
      createdAt: asTimestamp(createdAtRaw),
      updatedAt: asTimestamp(updatedAtRaw),
      triangleId: String(pick(r, ['三角調ID', 'triangleId']) || ''),
      triangleLegIndex: asInt(pick(r, ['三角腳次', 'triangleLegIndex']), null),
      triangleConsentStatus: String(pick(r, ['三角同意狀態', 'triangleConsentStatus']) || ''),
      triangleConsentAt: asTimestamp(pick(r, ['三角同意時間', 'triangleConsentAt'])),
      triangleGroupStatus: normalizeRequestStatus(pick(r, ['三角組狀態', 'triangleGroupStatus']) || ''),
      // 舊資料仍以備註標記相容；新資料使用獨立欄位，不污染備註。
      directApprove: (function () {
        if (asBool(directApproveRaw)) return true;
        const n = String(pick(r, ['備註', 'note']) || '');
        return n.indexOf('[直接核准]') >= 0 || r.directApprove === true;
      })(),
      // 行政代申請：代申請人 Email；備註 [行政代申請…] 備援
      proxyByName: String(pick(r, ['代申請人姓名', 'proxyByName']) || ''),
      isProxySubmit: (function () {
        if (r.isProxySubmit === true || r.proxySubmit === true) return true;
        const em = pick(r, ['代申請人Email', 'proxyByEmail', 'proxySubmitBy']);
        if (em || pick(r, ['代申請人姓名', 'proxyByName'])) return true;
        const n = String(pick(r, ['備註', 'note']) || '');
        return n.indexOf('[行政代申請') >= 0;
      })(),
      isEmptySlotAssign: (function () {
        if (r.isEmptySlotAssign === true) return true;
        const reason = String(pick(r, ['請假事由', 'reason']) || '').trim();
        const note = String(pick(r, ['備註', 'note']) || '');
        return reason === '空堂排班' || note.indexOf('[空堂排班]') >= 0;
      })()
    };
    alias(mapped, 'requesterEmail', function () { return mapped.requesterName || ''; });
    alias(mapped, 'targetTeacherEmail', function () { return mapped.targetTeacherName || ''; });
    alias(mapped, 'proxyByEmail', function () { return mapped.proxyByName || ''; });
    return mapped;
  }

  /** 前端 → Sheets：教師寫入列（同時寫入授課科目/任課科目別名，相容舊表頭） */
  function teacherToSheet(t, semesterId) {
    const subject = t.subject || t["授課科目"] || t["任課科目"] || '';
    const rawExpensePlan = t.expensePlan !== undefined ? t.expensePlan
      : (t["鐘點支出計畫"] !== undefined ? t["鐘點支出計畫"]
        : (t["鐘點支出來源"] !== undefined ? t["鐘點支出來源"] : (t["計畫"] || "")));
    const expensePlan = Array.isArray(rawExpensePlan)
      ? serializeExpensePlanSlots(rawExpensePlan)
      : String(rawExpensePlan == null ? '' : rawExpensePlan).trim();
    const quota = t.mutualQuota !== undefined ? t.mutualQuota
      : (t["折抵額度"] !== undefined ? t["折抵額度"] : 0);
    return {
      "學期代號": semesterId || t.semesterId || '',
      "教師Email": t.loginEmail || t["教師Email"] || t.email,
      "教師姓名": t.name || t["教師姓名"],
      "授課科目": subject,
      "任課科目": subject,
      "職務": t.jobTitle || t["職務"] || t["職稱"] || "",
      "鐘點支出計畫": expensePlan,
      "系統角色": normalizeRole(t.role || t["系統角色"] || 'teacher'),
      "基本鐘點": (function () {
        if (t.baseHours === 0 || t.baseHours === '0') return 0;
        if (t.baseHours !== undefined && t.baseHours !== null && t.baseHours !== '') {
          const n = parseInt(t.baseHours, 10);
          return Number.isNaN(n) ? 16 : n;
        }
        if (t["基本鐘點"] === 0 || t["基本鐘點"] === '0') return 0;
        if (t["基本鐘點"] !== undefined && t["基本鐘點"] !== null && t["基本鐘點"] !== '') {
          const n2 = parseInt(t["基本鐘點"], 10);
          return Number.isNaN(n2) ? 16 : n2;
        }
        return 16;
      })(),
      "折抵額度": parseInt(quota, 10) || 0
    };
  }

  /** 代導紀錄：Sheets → 前端 */
  function mapHomeroomRecord(r) {
    const mapped = {
      id: String(pick(r, ['代導紀錄ID', 'id']) || ''),
      semesterId: String(pick(r, ['學期代號', 'semesterId']) || ''),
      sourceRequestId: String(pick(r, ['來源申請單ID', 'sourceRequestId']) || ''),
      originalTeacherName: String(pick(r, ['原導師姓名', 'originalTeacherName']) || ''),
      className: String(pick(r, ['班級', 'className']) || ''),
      date: String(pick(r, ['代導日期', 'date']) || '').slice(0, 10),
      leaveTimeType: String(pick(r, ['請假時間類型', 'leaveTimeType']) || ''),
      leaveTime: String(pick(r, ['請假時間', 'leaveTime', 'timeRange']) || ''),
      actualTeacherName: String(pick(r, ['代導教師姓名', 'actualTeacherName']) || ''),
      periodCount: asFloat(pick(r, ['代導節數', 'periodCount']), 1),
      feeAmount: asFloat(pick(r, ['鐘點費', 'feeAmount']), 455),
      status: String(pick(r, ['狀態', 'status']) || ''),
      enabled: pick(r, ['啟用', 'enabled']) === undefined || pick(r, ['啟用', 'enabled']) === '' ? true : asBool(pick(r, ['啟用', 'enabled'])),
      createdAt: String(pick(r, ['建立時間', 'createdAt']) || ''),
      updatedAt: String(pick(r, ['更新時間', 'updatedAt']) || ''),
      operatorName: String(pick(r, ['操作者', 'operatorName']) || ''),
      note: String(pick(r, ['備註', 'note']) || '')
    };
    alias(mapped, 'originalTeacherEmail', function () { return mapped.originalTeacherName; });
    alias(mapped, 'actualTeacherEmail', function () { return mapped.actualTeacherName; });
    alias(mapped, 'operatorEmail', function () { return mapped.operatorName; });
    return mapped;
  }

  /** 前端 → Sheets：調代課紀錄寫入列（同時寫入原授課/原任課別名） */
  function substitutionToSheet(opts) {
    const original = opts.originalTeacherName || opts.originalTeacherEmail;
    return {
      "學期代號": opts.semesterId,
      "紀錄ID": opts.id,
      "申請單ID": opts.requestId,
      "異動日期": opts.date,
      "節次": opts.period,
      "原授課教師姓名": original,
      "原任課教師姓名": original,
      "實際授課教師姓名": opts.actualTeacherName || opts.actualTeacherEmail,
      "班級": opts.className,
      "科目": opts.subject,
      "異動類型": opts.type,
      "特殊流程": normalizeSpecialFlow(opts.specialFlow),
      "經費來源": opts.subFee || '無',
      "請假事由": opts.reason || '',
      "請假時間類型": opts.leaveTimeType || '',
      "請假時間": opts.leaveTime || '',
      "是否已印": opts.printed === true || opts.printed === 'TRUE' ? 'TRUE' : 'FALSE',
      "備註": opts.note || ''
    };
  }

  const STATUS_TEXT = {
    pending_teacher: '待受邀確認',
    pending_admin: '送交教學組',
    approved: '核准生效',
    rejected: '不成立',
    admin_rejected: '行政駁回',
    cancelled: '已撤銷',
    withdrawn: '已撤回'
  };

  function getStatusText(status) {
    return STATUS_TEXT[status] || status;
  }

  /**
   * 將 GAS / 網路錯誤轉成可讀中文
   * @param {any} err
   * @param {string} [action]
   */
  function formatGasError(err, action) {
    const raw = err && err.message ? String(err.message) : String(err || '未知錯誤');
    const cleaned = raw
      .replace(/^Error:\s*/i, '')
      .replace(/^Exception:\s*/i, '')
      .trim();

    const actionLabel = {
      submitRequest: '送出申請',
      respondToRequest: '簽核回應',
      adminApprove: '行政核准',
      adminApproveBatch: '批次行政核准',
      adminRejectBatch: '批次行政駁回',
      getMatchCandidates: '智慧媒合',
      getMutualQuotaLedger: '額度歷程',
      adminReject: '行政駁回',
      cancelRequest: '撤回申請',
      deleteSubstitutionRecord: '撤銷異動',
      saveTeacher: '儲存教師',
      deleteTeacher: '刪除教師',
      saveScheduleCell: '儲存課表',
      clearScheduleCell: '清除課表',
      importSchedulesBatch: '匯入課表',
      importTeachersBatch: '匯入教師',
      saveSemester: '儲存學期',
      deleteSemester: '刪除學期',
      setDefaultSemester: '設定預設學期',
      saveClassAwayEvent: '儲存空堂事件',
      deleteClassAwayEvent: '刪除空堂事件',
      saveHistoryEdit: '編輯歷史紀錄',
      batchMarkPrinted: '標記已列印',
      saveMailSettings: '儲存系統設定',
      getInitialData: '載入資料'
    }[action] || (action || '操作');

    // 課表驗證失敗是資料衝突／欄位錯誤，不是登入失效；保留後端原訊息供管理員處理。
    if (/課表(?:匯入)?資料驗證失敗|同一星期與節次只能安排一位巡堂教師|啟用期間重疊|啟用起日|啟用迄日|課表新版本/.test(cleaned)) {
      return actionLabel + '失敗：' + cleaned;
    }
    if (/登入憑證已過期|登入驗證失敗|Google 登入驗證失敗|身分認證\s*Token|aud 不符|id_token|Token/i.test(cleaned)) {
      return '登入憑證已過期或無效，請重新登入後再試。';
    }
    if (/Failed to fetch|NetworkError|網路連線失敗|Load failed/i.test(cleaned)) {
      return '無法連線至伺服器，請檢查網路後再試。';
    }
    if (/無管理員權限/.test(cleaned)) {
      return '此操作需要管理員權限。';
    }
    if (/找不到該申請單|找不到此申請單|找不到該紀錄/.test(cleaned)) {
      return cleaned;
    }
    if (/無權/.test(cleaned)) {
      return cleaned;
    }
    if (/未定義的 POST Action/.test(cleaned)) {
      return '後端尚未支援此操作，請確認 code.gs 已部署最新版。';
    }
    if (/主要資料庫 GAS API 網址尚未設定/.test(cleaned)) {
      return cleaned;
    }

    return actionLabel + '失敗：' + cleaned;
  }

  return {
    SPECIAL_FLOW_COMBINED_RETURN,
    SPECIAL_FLOW_COMBINED_RETURN_LABEL,
    pick,
    asBool,
    asInt,
    asFloat,
    normalizeRole,
    normalizeExpenseSource,
    expenseClassesOverlap,
    parseExpensePlan,
    expensePlanSourceForSlot,
    expensePlanSources,
    serializeExpensePlanSlots,
    formatExpensePlanSummary,
    normalizeSpecialFlow,
    isCombinedReturn,
    normalizeRequestStatus,
       mapSemester,
       mapClassAwayEvent,
       mapSchoolSwap,
    mapTeacher,
    normalizeSpecialTags,
    isRestrictedScheduleValue,
    mapSchedule,
    mapSubstitution,
    mapHomeroomRecord,
    mapRequest,
    teacherToSheet,
    substitutionToSheet,
    getStatusText,
    formatGasError,
    STATUS_TEXT
  };
})();

