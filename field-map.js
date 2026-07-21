/**
 * 前後端欄位對照層 (field-map.js)
 * Sheets 存中文欄位；前端用英文 camelCase。
 * 讀取時支援別名（相容舊表頭 / 新表頭）。
 */
window.FieldMap = (function () {
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

  function asBool(v) {
    return v === true || v === 'TRUE' || v === 'true' || v === 1 || v === '1';
  }

  function asInt(v, fallback) {
    // 明確允許 0（基本鐘點打 0 就是 0，不可被預設蓋掉）
    if (v === undefined || v === null || v === '') return fallback;
    if (v === 0 || v === '0') return 0;
    const n = parseInt(v, 10);
    return Number.isNaN(n) ? fallback : n;
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

  function mapTeacher(t) {
    return {
      email: pick(t, ['教師Email', 'email']),
      name: pick(t, ['教師姓名', 'name']),
      subject: pick(t, ['授課科目', '任課科目', 'subject']) || '',
      role: normalizeRole(pick(t, ['系統角色', 'role']) || 'teacher'),
      baseHours: asInt(pick(t, ['基本鐘點', 'baseHours']), 16),
      // 互代額度：活動釋出可寫回；送出扣額度時扣 1；可手動調整
      mutualQuota: asInt(pick(t, ['互代額度', 'mutualQuota']), 0)
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
    return {
      id: pick(s, ['課表ID', 'id']),
      teacherEmail: pick(s, ['教師Email', 'teacherEmail']),
      teacherName: pick(s, ['教師姓名', 'teacherName']),
      dayOfWeek: asInt(pick(s, ['星期', 'dayOfWeek']), 0),
      period: asInt(pick(s, ['節次', 'period']), 0),
      className: cn,
      subject: pick(s, ['科目', 'subject']) || '',
      attr: pick(s, ['課堂屬性', 'attr']) || '',
      restriction: pick(s, ['調課限制', 'restriction']) || ''
    };
  }

  function mapSubstitution(sub) {
    return {
      id: pick(sub, ['紀錄ID', 'id']),
      date: pick(sub, ['異動日期', 'date']),
      period: asInt(pick(sub, ['節次', 'period']), 0),
      originalTeacherEmail: pick(sub, ['原授課教師Email', '原任課教師Email', 'originalTeacherEmail']),
      actualTeacherEmail: pick(sub, ['實際授課教師Email', 'actualTeacherEmail']),
      className: String(pick(sub, ['班級', 'className']) || ''),
      subject: pick(sub, ['科目', 'subject']) || '',
      requestId: pick(sub, ['申請單ID', 'requestId']) || '',
      type: pick(sub, ['異動類型', 'type']),
      printed: asBool(pick(sub, ['是否已印', 'printed'])),
      subFee: pick(sub, ['經費來源', 'subFee']) || '',
      reason: pick(sub, ['請假事由', 'reason']) || '',
      note: pick(sub, ['備註', 'note']) || ''
    };
  }

  function mapRequest(r) {
    const targetDay = pick(r, ['對調目標星期', 'targetDayOfWeek']);
    const targetPeriod = pick(r, ['對調目標節次', 'targetPeriod']);
    return {
      id: pick(r, ['申請單ID', 'id']),
      serial: pick(r, ['單號', 'serial']),
      batchId: pick(r, ['批次ID', 'batchId']) || '',
      status: pick(r, ['狀態', 'status']),
      requesterEmail: pick(r, ['申請人Email', 'requesterEmail']),
      requesterName: pick(r, ['申請人姓名', 'requesterName']),
      targetTeacherEmail: pick(r, ['受邀人Email', 'targetTeacherEmail']),
      targetTeacherName: pick(r, ['受邀人姓名', 'targetTeacherName']),
      className: String(pick(r, ['班級', 'className']) || ''),
      subject: pick(r, ['科目', 'subject']) || '',
      requestDate: pick(r, ['異動日期', 'requestDate']),
      requestPeriodDay: asInt(pick(r, ['異動星期', 'requestPeriodDay']), null),
      requestPeriod: asInt(pick(r, ['異動節次', 'requestPeriod']), null),
      type: pick(r, ['異動類型', 'type']),
      targetDate: pick(r, ['對調目標日期', 'targetDate']) || '',
      targetDayOfWeek: targetDay === undefined || targetDay === null || targetDay === '' ? null : asInt(targetDay, null),
      targetPeriod: targetPeriod === undefined || targetPeriod === null || targetPeriod === '' ? null : asInt(targetPeriod, null),
      subFee: pick(r, ['經費來源', 'subFee']) || '',
      reason: pick(r, ['請假事由', 'reason']) || '',
      note: pick(r, ['備註', 'note']) || '',
      printed: asBool(pick(r, ['是否已印', 'printed'])),
      createdAt: pick(r, ['建立時間', 'createdAt']) || '',
      updatedAt: pick(r, ['更新時間', 'updatedAt']) || '',
      // 備註含 [直接核准] 或前端帶入 → 簽核進度略過「等對方同意」
      directApprove: (function () {
        const n = String(pick(r, ['備註', 'note']) || '');
        return n.indexOf('[直接核准]') >= 0 || r.directApprove === true;
      })(),
      // 行政代申請：代申請人 Email；備註 [行政代申請…] 備援
      proxyByEmail: (function () {
        const em = pick(r, ['代申請人Email', 'proxyByEmail', 'proxySubmitBy']);
        if (em) return String(em).trim().toLowerCase();
        return '';
      })(),
      proxyByName: String(pick(r, ['代申請人姓名', 'proxyByName']) || ''),
      isProxySubmit: (function () {
        if (r.isProxySubmit === true || r.proxySubmit === true) return true;
        const em = pick(r, ['代申請人Email', 'proxyByEmail', 'proxySubmitBy']);
        if (em) return true;
        const n = String(pick(r, ['備註', 'note']) || '');
        return n.indexOf('[行政代申請') >= 0;
      })()
    };
  }

  /** 前端 → Sheets：教師寫入列（同時寫入授課科目/任課科目別名，相容舊表頭） */
  function teacherToSheet(t, semesterId) {
    const subject = t.subject || t["授課科目"] || t["任課科目"] || '';
    const quota = t.mutualQuota !== undefined ? t.mutualQuota
      : (t["互代額度"] !== undefined ? t["互代額度"] : 0);
    return {
      "學期代號": semesterId || t.semesterId || '',
      "教師Email": t.email || t["教師Email"],
      "教師姓名": t.name || t["教師姓名"],
      "授課科目": subject,
      "任課科目": subject,
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
      "互代額度": parseInt(quota, 10) || 0
    };
  }

  /** 前端 → Sheets：調代課紀錄寫入列（同時寫入原授課/原任課別名） */
  function substitutionToSheet(opts) {
    const original = opts.originalTeacherEmail;
    return {
      "學期代號": opts.semesterId,
      "紀錄ID": opts.id,
      "申請單ID": opts.requestId,
      "異動日期": opts.date,
      "節次": opts.period,
      "原授課教師Email": original,
      "原任課教師Email": original,
      "實際授課教師Email": opts.actualTeacherEmail,
      "班級": opts.className,
      "科目": opts.subject,
      "異動類型": opts.type,
      "經費來源": opts.subFee || '無',
      "請假事由": opts.reason || '',
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

    if (/登入憑證已過期|驗證失敗|verification failed|Token/i.test(cleaned)) {
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
    pick,
    asBool,
    asInt,
    normalizeRole,
    mapSemester,
    mapClassAwayEvent,
    mapTeacher,
    mapSchedule,
    mapSubstitution,
    mapRequest,
    teacherToSheet,
    substitutionToSheet,
    getStatusText,
    formatGasError,
    STATUS_TEXT
  };
})();

