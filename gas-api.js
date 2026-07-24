/**
 * 學校調代課線上系統 - GAS API 客戶端 (gas-api.js)
 * JWT / Token 檢查 / 錯誤格式化 / callGasApi（讀寫皆 POST，Token 不進 URL）/ SWR 分鍵
 */
window.GasApi = (function () {
  var APP_VERSION = '2026-07-17-api6';
  // 正式建議在系統設定 allowedHd 覆寫校內網域；* 僅測試
  var DEFAULT_ALLOWED_HD = ['*'];
  var WRITE_ACTIONS = {
    submitRequest: 1, submitRequestBatch: 1, respondToRequest: 1, respondToBatch: 1,
    adminApprove: 1, adminReject: 1, adminApproveBatch: 1, adminRejectBatch: 1,
    cancelRequest: 1, withdrawRequest: 1, deleteSubstitutionRecord: 1,
    saveTeacher: 1, deleteTeacher: 1, importTeachersBatch: 1, updateMutualQuotas: 1,
    earnMutualQuotaFromActivity: 1,
    saveScheduleCell: 1, clearScheduleCell: 1, importSchedulesBatch: 1,
    saveSemester: 1, deleteSemester: 1, setDefaultSemester: 1,
    saveClassAwayEvent: 1, deleteClassAwayEvent: 1,
    saveHistoryEdit: 1, batchMarkPrinted: 1, saveMailSettings: 1, sendBatchNotices: 1
  };
  /** 只動申請／空堂對齊 → 只清 requests 分鍵，保留 meta／structure 快取 */
  var REQUEST_WRITE_ACTIONS = {
    submitRequest: 1, submitRequestBatch: 1, respondToRequest: 1, respondToBatch: 1,
    adminApprove: 1, adminReject: 1, adminApproveBatch: 1, adminRejectBatch: 1,
    cancelRequest: 1, withdrawRequest: 1, deleteSubstitutionRecord: 1,
    saveHistoryEdit: 1, batchMarkPrinted: 1, sendBatchNotices: 1
  };
  /** 課表／教師／學期結構變更 → 清全部分鍵 */
  var STRUCTURE_WRITE_ACTIONS = {
    saveTeacher: 1, deleteTeacher: 1, importTeachersBatch: 1, updateMutualQuotas: 1,
    earnMutualQuotaFromActivity: 1,
    saveScheduleCell: 1, clearScheduleCell: 1, importSchedulesBatch: 1,
    saveSemester: 1, deleteSemester: 1, setDefaultSemester: 1,
    saveClassAwayEvent: 1, deleteClassAwayEvent: 1, saveMailSettings: 1
  };

  function decodeJwt(token) {
    try {
      const base64Url = token.split('.')[1];
      const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
      const jsonPayload = decodeURIComponent(
        window.atob(base64).split('').map(function (c) {
          return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
        }).join('')
      );
      return JSON.parse(jsonPayload);
    } catch (e) {
      console.error('Failed to decode JWT:', e);
      return null;
    }
  }

  /** token 剩餘毫秒；無效回 -1 */
  function tokenTtlMs(token) {
    if (!token || token === 'mock-admin-token') return -1;
    const payload = decodeJwt(token);
    if (!payload || !payload.exp) return -1;
    return payload.exp * 1000 - Date.now();
  }

  function isTokenExpired(token) {
    // 剩餘不足 15 秒視為不可用（給請求一點緩衝）
    return tokenTtlMs(token) < 15000;
  }

  /** 快過期：剩餘不足 withinMs（預設 5 分鐘）→ 應背景換票 */
  function isTokenExpiringSoon(token, withinMs) {
    var ttl = tokenTtlMs(token);
    if (ttl < 0) return true;
    return ttl < (withinMs != null ? withinMs : 5 * 60 * 1000);
  }

  function getStoredIdToken() {
    const idToken = localStorage.getItem('jcjh_google_id_token');
    if (!idToken || idToken === 'mock-admin-token') return null;
    return idToken;
  }

  function requireIdToken() {
    const idToken = getStoredIdToken();
    if (!idToken || isTokenExpired(idToken)) return null;
    return idToken;
  }

  function formatError(err, action) {
    if (window.FieldMap && typeof window.FieldMap.formatGasError === 'function') {
      return window.FieldMap.formatGasError(err, action);
    }
    const raw = err && err.message ? String(err.message) : String(err || '未知錯誤');
    return raw.replace(/^Error:\s*/i, '').trim();
  }

  function parseAllowedHd(settings) {
    var list = DEFAULT_ALLOWED_HD.slice();
    if (!settings) return list;
    var raw = settings.allowedHd || settings.ALLOWED_HD || '';
    if (!raw) return list;
    var parts = String(raw).split(',').map(function (s) { return s.trim().toLowerCase(); }).filter(Boolean);
    return parts.length ? parts : list;
  }

  function isEmailDomainAllowed(email, payload, allowedList) {
    var list = allowedList && allowedList.length ? allowedList : DEFAULT_ALLOWED_HD;
    // * 或空清單 = 不限制（測試用）
    if (!list.length || list.indexOf('*') !== -1) return true;
    var em = String(email || (payload && payload.email) || '').toLowerCase();
    var domain = em.split('@')[1] || '';
    var hd = String((payload && payload.hd) || domain).toLowerCase();
    return list.indexOf(hd) !== -1 || list.indexOf(domain) !== -1;
  }

  /** 舊整包 key（相容讀） */
  function cacheKey(semesterId) {
    return 'jcjh_swr_' + APP_VERSION + '_' + (semesterId || '');
  }

  /** 分鍵：meta | structure | requests */
  function partKey(semesterId, part) {
    return 'jcjh_swr_' + APP_VERSION + '_' + (semesterId || '') + '_' + String(part || 'full');
  }

  function readPart(semesterId, part, maxAgeMs) {
    try {
      const raw = sessionStorage.getItem(partKey(semesterId, part));
      if (!raw) return null;
      const obj = JSON.parse(raw);
      if (!obj || !obj.ts || obj.data === undefined) return null;
      if (Date.now() - obj.ts > (maxAgeMs || 120000)) return null;
      return obj.data;
    } catch (e) {
      return null;
    }
  }

  function writePart(semesterId, part, data) {
    var key = partKey(semesterId, part);
    var payload = JSON.stringify({ ts: Date.now(), data: data });
    try {
      sessionStorage.setItem(key, payload);
    } catch (e1) {
      // QuotaExceeded：清舊 SWR 後重試一次
      try {
        Object.keys(sessionStorage).forEach(function (k) {
          if (k.indexOf('jcjh_swr_') === 0) sessionStorage.removeItem(k);
        });
        sessionStorage.setItem(key, payload);
      } catch (e2) {
        try { console.warn('SWR writePart failed:', part, e2); } catch (e3) {}
      }
    }
  }

  function removePart(semesterId, part) {
    try {
      sessionStorage.removeItem(partKey(semesterId, part));
    } catch (e) {}
  }

  /**
   * 讀 SWR：優先合併分鍵；無分鍵時讀舊整包
   * maxAgeMs 預設 120s；可傳 { meta, structure, requests } 各別秒數
   */
  function readSWR(semesterId, maxAgeMs) {
    var ages = typeof maxAgeMs === 'object' && maxAgeMs
      ? maxAgeMs
      : { meta: maxAgeMs || 120000, structure: maxAgeMs || 120000, requests: maxAgeMs || 120000 };
    var metaAge = ages.meta != null ? ages.meta : 120000;
    var structAge = ages.structure != null ? ages.structure : 300000; // 課表結構可留較久
    var reqAge = ages.requests != null ? ages.requests : 120000;

    var meta = readPart(semesterId, 'meta', metaAge);
    var structure = readPart(semesterId, 'structure', structAge);
    var requests = readPart(semesterId, 'requests', reqAge);
    if (meta || structure || requests) {
      var out = { success: true };
      if (meta) {
        if (meta.semesters) out.semesters = meta.semesters;
        if (meta.teachers) out.teachers = meta.teachers;
        if (meta.settings) out.settings = meta.settings;
      }
      if (structure) {
        if (structure.schedules) out.schedules = structure.schedules;
        // structure 可帶 teachers 備援
        if (structure.teachers && !out.teachers) out.teachers = structure.teachers;
      }
      if (requests) {
        if (requests.requests) out.requests = requests.requests;
        if (requests.classAwayEvents !== undefined) out.classAwayEvents = requests.classAwayEvents;
        if (requests.requestWindow) out.requestWindow = requests.requestWindow;
        if (requests.serverTime) out.serverTime = requests.serverTime;
      }
      return out;
    }

    // 相容：舊整包
    try {
      const raw = sessionStorage.getItem(cacheKey(semesterId));
      if (!raw) return null;
      const obj = JSON.parse(raw);
      if (!obj || !obj.ts || !obj.data) return null;
      if (Date.now() - obj.ts > (typeof maxAgeMs === 'number' ? maxAgeMs : 120000)) return null;
      return obj.data;
    } catch (e) {
      return null;
    }
  }

  /** 只寫分鍵（不再寫整包 full bag，避免 sessionStorage 爆量） */
  function writeSWR(semesterId, data) {
    if (!data) return;
    // 清掉舊版整包 key（若仍存在）
    try { sessionStorage.removeItem(cacheKey(semesterId)); } catch (e0) {}
    writeSWRParts(semesterId, data);
  }

  /** 依 payload 拆寫 meta / structure / requests */
  function writeSWRParts(semesterId, data) {
    if (!data) return;
    if (data.semesters || data.teachers || data.settings) {
      writePart(semesterId, 'meta', {
        semesters: data.semesters,
        teachers: data.teachers,
        settings: data.settings
      });
    }
    if (data.schedules || data.teachers) {
      writePart(semesterId, 'structure', {
        schedules: data.schedules,
        teachers: data.teachers
      });
    }
    if (data.requests || data.classAwayEvents !== undefined || data.requestWindow || data.serverTime) {
      writePart(semesterId, 'requests', {
        requests: data.requests,
        classAwayEvents: data.classAwayEvents,
        requestWindow: data.requestWindow,
        serverTime: data.serverTime
      });
    }
  }

  /** 只更新某一分鍵（softRefresh 用） */
  function writeSWRPart(semesterId, part, data) {
    if (!part || !data) return;
    writePart(semesterId, part, data);
  }

  /**
   * 清除 SWR
   * clearSWR() — 全清
   * clearSWR(semesterId) — 該學期全部分鍵
   * clearSWR(semesterId, { parts: ['requests'] }) — 只清指定分鍵
   */
  function clearSWR(semesterId, opts) {
    try {
      opts = opts || {};
      var parts = opts.parts;
      if (semesterId && parts && parts.length) {
        parts.forEach(function (p) {
          if (p === 'full') sessionStorage.removeItem(cacheKey(semesterId));
          else removePart(semesterId, p);
        });
        return;
      }
      if (semesterId) {
        sessionStorage.removeItem(cacheKey(semesterId));
        ['meta', 'structure', 'requests'].forEach(function (p) {
          removePart(semesterId, p);
        });
        return;
      }
      Object.keys(sessionStorage).forEach(function (k) {
        if (k.indexOf('jcjh_swr_') === 0) sessionStorage.removeItem(k);
      });
    } catch (e) {}
  }

  function createClient(opts) {
    var _authExpiredNotified = false;
    var _refreshInflight = null;

    function handleAuthExpired(msg) {
      localStorage.removeItem('jcjh_google_id_token');
      clearSWR();
      if (opts.onAuthExpired) {
        try { opts.onAuthExpired(); } catch (e) {}
      }
      // B：不 location.reload()，只提示重新登入，保留畫面較不突兀
      if (!_authExpiredNotified) {
        _authExpiredNotified = true;
        if (opts.showToast) {
          opts.showToast(msg || '⚠️ 登入已過期，請再按一次 Google 登入（不必整頁重整）。', 'warning');
        }
        setTimeout(function () { _authExpiredNotified = false; }, 8000);
      }
    }

    /**
     * 取得可用 ID Token：
     * - 尚有效：直接回傳；若快過期則背景換票
     * - 已過期：先 await 靜默換票，成功則繼續
     */
    async function ensureIdToken(options) {
      options = options || {};
      var forceRefresh = !!options.forceRefresh;
      var token = getStoredIdToken();
      if (token && !isTokenExpired(token) && !forceRefresh) {
        if (isTokenExpiringSoon(token) && typeof opts.refreshIdToken === 'function') {
          // 背景換票，不擋本次請求
          if (!_refreshInflight) {
            _refreshInflight = Promise.resolve()
              .then(function () { return opts.refreshIdToken(); })
              .catch(function () { return null; })
              .finally(function () { _refreshInflight = null; });
          }
        }
        return token;
      }
      // 過期或缺票：嘗試靜默刷新
      if (typeof opts.refreshIdToken === 'function') {
        try {
          if (!_refreshInflight) {
            _refreshInflight = Promise.resolve()
              .then(function () { return opts.refreshIdToken(); })
              .finally(function () { _refreshInflight = null; });
          }
          var fresh = await _refreshInflight;
          if (fresh && !isTokenExpired(fresh)) {
            _authExpiredNotified = false;
            return fresh;
          }
        } catch (e) { /* ignore */ }
      }
      return null;
    }

    /** 長操作預估秒數（僅 UI 進度提示用） */
    var LONG_ACTION_HINT_SEC = {
      importSchedulesBatch: 90,
      importTeachersBatch: 45,
      adminApproveBatch: 60,
      adminRejectBatch: 40,
      submitRequestBatch: 50,
      sendBatchNotices: 40,
      getInitialData: 25,
      earnMutualQuotaFromActivity: 45
    };

    async function postJson(action, data, options) {
      options = options || {};
      const url = opts.getApiUrl();
      if (!url) {
        throw new Error(formatError(new Error('主要資料庫 GAS API 網址尚未設定！'), action));
      }
      let idToken = '';
      if (!options.skipAuth) {
        idToken = await ensureIdToken();
        if (!idToken) {
          handleAuthExpired();
          throw new Error(formatError(new Error('登入憑證已過期，請重新登入！'), action));
        }
      }
      const payload = {
        idToken: idToken,
        apiKey: '',
        action: action,
        semesterId: opts.getSemesterId(),
        currentUrl: window.location.origin + window.location.pathname,
        data: data || {}
      };

      // 長操作：每秒回報經過秒數，避免畫面像卡住
      var progressTimer = null;
      var t0 = Date.now();
      var onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
      var hintSec = LONG_ACTION_HINT_SEC[action] || (options.longOp ? 60 : 0);
      if (onProgress && hintSec > 0) {
        try {
          onProgress({ action: action, elapsed: 0, hintSec: hintSec, phase: 'start' });
        } catch (e0) { /* ignore */ }
        progressTimer = setInterval(function () {
          var elapsed = Math.floor((Date.now() - t0) / 1000);
          try {
            onProgress({
              action: action,
              elapsed: elapsed,
              hintSec: hintSec,
              phase: elapsed >= hintSec ? 'slow' : 'wait'
            });
          } catch (eP) { /* ignore */ }
        }, 1000);
      }

      let response;
      try {
        response = await fetch(url, {
          method: 'POST',
          mode: 'cors',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: JSON.stringify(payload)
        });
      } catch (netErr) {
        if (progressTimer) clearInterval(progressTimer);
        var netMsg = String(netErr && netErr.message ? netErr.message : netErr);
        if (/abort|timeout|timed out|Failed to fetch|NetworkError|network/i.test(netMsg)) {
          throw new Error(formatError(new Error(
            '連線逾時或中斷（可能 GAS 處理較久）。請稍候再試；若剛完成寫入，可按 ↻ 重新整理確認。'
          ), action));
        }
        throw new Error(formatError(netErr, action));
      }
      if (progressTimer) clearInterval(progressTimer);
      if (!response.ok) {
        throw new Error(
          formatError(new Error('網路連線失敗：HTTP ' + response.status + ' ' + (response.statusText || '')), action)
        );
      }
      let res;
      try {
        res = await response.json();
      } catch (parseErr) {
        throw new Error(formatError(new Error('伺服器回應格式錯誤，請確認 GAS 部署是否正常。'), action));
      }
      if (!res.success) {
        const errMsg = res.error || '未知錯誤';
        // Token 類錯誤：先試一次換票重送，再失敗才當登出
        if (/驗證失敗|verification failed|Token|登入憑證|id_token|expired|過期|aud 不符/i.test(String(errMsg))) {
          if (!options._retriedAuth && typeof opts.refreshIdToken === 'function') {
            try {
              var retryTok = await ensureIdToken({ forceRefresh: true });
              if (retryTok) {
                return postJson(action, data, Object.assign({}, options, { _retriedAuth: true }));
              }
            } catch (eR) { /* fallthrough */ }
          }
          handleAuthExpired();
        }
        if (/exceeded maximum execution time|Maximum execution time|逾時|timeout/i.test(String(errMsg))) {
          throw new Error(formatError(new Error(
            'GAS 執行逾時。請減少單次筆數後再試，或稍候按 ↻ 確認是否已部分寫入。'
          ), action));
        }
        throw new Error(formatError(new Error(errMsg), action));
      }
      if (onProgress && hintSec > 0) {
        try {
          onProgress({
            action: action,
            elapsed: Math.floor((Date.now() - t0) / 1000),
            hintSec: hintSec,
            phase: 'done'
          });
        } catch (eD) { /* ignore */ }
      }
      return res;
    }

    const callGasApi = async (action, data, callOpts) => {
      callOpts = callOpts || {};
      const res = await postJson(action, data || {}, callOpts);
      if (WRITE_ACTIONS[action]) {
        var sid = opts.getSemesterId();
        if (REQUEST_WRITE_ACTIONS[action] && !STRUCTURE_WRITE_ACTIONS[action]) {
          // 申請類寫入：只髒 requests（下次 soft 可先畫 meta／課表）
          clearSWR(sid, { parts: ['requests', 'full'] });
        } else {
          clearSWR(sid);
        }
      }
      return res;
    };

    /**
     * 輕量讀取：學期 + 教師 + 設定（POST，Token 不進 URL）
     */
    async function fetchMetaData(options) {
      options = options || {};
      const semesterId = options.semesterId || opts.getSemesterId();
      // 暫時覆寫 semester：postJson 用 opts.getSemesterId
      const prevGet = opts.getSemesterId;
      if (options.semesterId) {
        opts.getSemesterId = function () { return semesterId; };
      }
      try {
        const res = await postJson('getMetaData', {});
        if (res) {
          writePart(semesterId, 'meta', {
            semesters: res.semesters,
            teachers: res.teachers,
            settings: res.settings
          });
        }
        return res;
      } finally {
        opts.getSemesterId = prevGet;
      }
    }

    /**
     * 全量讀取：含課表／異動／申請（POST + SWR）
     * options.historyAll=true：不裁時間窗（完整學期申請）
     * options.windowDays：已結案保留天數，預設 14
     * options.requestsOnly=true：只拉申請窗＋空堂（不寫 structure，只寫 requests）
     */
    async function fetchInitialData(options) {
      options = options || {};
      const semesterId = options.semesterId || opts.getSemesterId();
      const force = !!options.force;
      const historyAll = !!options.historyAll;
      const requestsOnly = !!options.requestsOnly;
      const windowDays = options.windowDays != null ? options.windowDays : 14;

      if (!force && !historyAll && !requestsOnly) {
        const stale = readSWR(semesterId, 120000);
        if (stale && options.onStale) options.onStale(stale);
      }

      const prevGet = opts.getSemesterId;
      if (options.semesterId) {
        opts.getSemesterId = function () { return semesterId; };
      }
      try {
        const res = await postJson('getInitialData', {
          scope: force ? 'fresh' : 'full',
          historyAll: historyAll,
          windowDays: windowDays,
          requestsOnly: requestsOnly
        });
        if (historyAll) {
          // 完整歷史不覆寫預設 SWR
        } else if (requestsOnly) {
          writeSWRPart(semesterId, 'requests', {
            requests: res.requests,
            classAwayEvents: res.classAwayEvents,
            requestWindow: res.requestWindow,
            serverTime: res.serverTime
          });
        } else {
          writeSWR(semesterId, res);
        }
        return res;
      } finally {
        opts.getSemesterId = prevGet;
      }
    }

    /** 公開班級課表（免登入） */
    async function fetchPublicClassData(options) {
      options = options || {};
      const className = options.className || options.class || '';
      const semesterId = options.semesterId || opts.getSemesterId();
      const prevGet = opts.getSemesterId;
      if (options.semesterId) {
        opts.getSemesterId = function () { return semesterId; };
      }
      try {
        return await postJson('getPublicClassData', { className: className, class: className }, { skipAuth: true });
      } finally {
        opts.getSemesterId = prevGet;
      }
    }

    /** 極輕量：只拉進行中申請（不含課表） */
    async function fetchPendingOnly(options) {
      options = options || {};
      const semesterId = options.semesterId || opts.getSemesterId();
      const prevGet = opts.getSemesterId;
      if (options.semesterId) {
        opts.getSemesterId = function () { return semesterId; };
      }
      try {
        return await postJson('getPendingOnly', {});
      } finally {
        opts.getSemesterId = prevGet;
      }
    }

    /**
     * 申請增量：updatedSince 之後有變的列（合併用，不寫 SWR）
     * options.updatedSince：本地水位線字串 YYYY-MM-DD HH:mm:ss
     */
    async function fetchRequestsDelta(options) {
      options = options || {};
      const semesterId = options.semesterId || opts.getSemesterId();
      const updatedSince = String(options.updatedSince || '').trim();
      if (!updatedSince) {
        throw new Error('fetchRequestsDelta 需要 updatedSince');
      }
      const prevGet = opts.getSemesterId;
      if (options.semesterId) {
        opts.getSemesterId = function () { return semesterId; };
      }
      try {
        return await postJson('getInitialData', {
          requestsDelta: true,
          updatedSince: updatedSince
        });
      } finally {
        opts.getSemesterId = prevGet;
      }
    }

    /** 歷史按月：YYYY-MM，只回申請列 */
    async function fetchHistoryMonth(options) {
      options = options || {};
      const semesterId = options.semesterId || opts.getSemesterId();
      const month = String(options.month || '').slice(0, 7);
      const prevGet = opts.getSemesterId;
      if (options.semesterId) {
        opts.getSemesterId = function () { return semesterId; };
      }
      try {
        return await postJson('getHistoryMonth', { month: month });
      } finally {
        opts.getSemesterId = prevGet;
      }
    }

    /**
     * 代課媒合候選（後端算；教師端無全校課表時用）
     * options: leaveEmail, dateStr, dayOfWeek, period, myCourse, myDomain, myClass, awayClasses, activityMode, limit
     */
    async function fetchMatchCandidates(options) {
      options = options || {};
      const semesterId = options.semesterId || opts.getSemesterId();
      const prevGet = opts.getSemesterId;
      if (options.semesterId) {
        opts.getSemesterId = function () { return semesterId; };
      }
      try {
        return await postJson('getMatchCandidates', {
          leaveEmail: options.leaveEmail,
          dateStr: options.dateStr,
          dayOfWeek: options.dayOfWeek != null ? options.dayOfWeek : options.targetDay,
          period: options.period != null ? options.period : options.targetPeriod,
          myCourse: options.myCourse,
          myDomain: options.myDomain,
          myClass: options.myClass,
          className: options.myClass || options.className,
          subject: options.myCourse || options.subject,
          awayClasses: options.awayClasses || [],
          activityMode: !!options.activityMode,
          limit: options.limit != null ? options.limit : 40
        });
      } finally {
        opts.getSemesterId = prevGet;
      }
    }

    /** 折抵額度帳本歷程（email 可選；管理員可查他人） */
    async function fetchMutualQuotaLedger(options) {
      options = options || {};
      const semesterId = options.semesterId || opts.getSemesterId();
      const prevGet = opts.getSemesterId;
      if (options.semesterId) {
        opts.getSemesterId = function () { return semesterId; };
      }
      try {
        return await postJson('getMutualQuotaLedger', {
          email: options.email || options.teacherEmail || '',
          limit: options.limit != null ? options.limit : 50
        });
      } finally {
        opts.getSemesterId = prevGet;
      }
    }

    return {
      callGasApi,
      fetchInitialData,
      fetchMetaData,
      fetchPublicClassData,
      fetchPendingOnly,
      fetchRequestsDelta,
      fetchHistoryMonth,
      fetchMatchCandidates,
      fetchMutualQuotaLedger,
      decodeJwt,
      isTokenExpired,
      isTokenExpiringSoon,
      tokenTtlMs,
      ensureIdToken,
      formatError,
      requireIdToken,
      clearSWR,
      writeSWRPart,
      parseAllowedHd,
      isEmailDomainAllowed,
      DEFAULT_ALLOWED_HD,
      APP_VERSION
    };
  }

  return {
    decodeJwt,
    isTokenExpired,
    isTokenExpiringSoon,
    tokenTtlMs,
    createClient,
    formatError,
    requireIdToken,
    readSWR,
    writeSWR,
    writeSWRPart,
    writeSWRParts,
    clearSWR,
    parseAllowedHd,
    isEmailDomainAllowed,
    DEFAULT_ALLOWED_HD,
    APP_VERSION
  };
})();
