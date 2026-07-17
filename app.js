// 學校調代課線上系統 - 核心應用程式邏輯 (莫蘭迪現代大鐘點版)


// ── Toast 通知系統 ──────────────────────────────────────────
function showToast(msg, type = 'info', duration = 3500) {
  const container = document.getElementById('toast-container');
  if (!container) { window.alert(String(msg)); return; }
  const toast = document.createElement('div');
  toast.className = 'toast toast-' + type;
  const icons = { success: '✅', error: '❌', warning: '⚠️', info: 'ℹ️' };
  const iconEl = document.createElement('span');
  iconEl.className = 'toast-icon';
  iconEl.textContent = icons[type] || 'ℹ️';
  const msgEl = document.createElement('span');
  msgEl.className = 'toast-msg';
  msgEl.textContent = String(msg == null ? '' : msg);
  toast.appendChild(iconEl);
  toast.appendChild(msgEl);
  container.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('toast-show'));
  setTimeout(() => {
    toast.classList.remove('toast-show');
    toast.addEventListener('transitionend', () => toast.remove(), { once: true });
  }, duration);
}

// ── 自訂確認 Modal ──────────────────────────────────────────
// opts.withNote=true 時回傳 { ok, note }；否則回傳 boolean
function showConfirm(msg, title = '請確認', opts = {}) {
  return new Promise(resolve => {
    const overlay = document.getElementById('confirm-overlay');
    const titleEl = document.getElementById('confirm-title');
    const msgEl   = document.getElementById('confirm-msg');
    const noteWrap = document.getElementById('confirm-note-wrap');
    const noteEl  = document.getElementById('confirm-note');
    const btnOk   = document.getElementById('confirm-ok');
    const btnCan  = document.getElementById('confirm-cancel');
    if (!overlay) {
      const ok = window.confirm(msg);
      resolve(opts.withNote ? { ok, note: '' } : ok);
      return;
    }
    titleEl.textContent = title;
    msgEl.textContent = msg;
    if (noteWrap && noteEl) {
      if (opts.withNote) {
        noteWrap.style.display = 'block';
        noteEl.value = '';
        noteEl.placeholder = opts.notePlaceholder || '備註（選填）';
      } else {
        noteWrap.style.display = 'none';
        noteEl.value = '';
      }
    }
    overlay.classList.add('confirm-show');
    const cleanup = (ok) => {
      overlay.classList.remove('confirm-show');
      btnOk.removeEventListener('click', onOk);
      btnCan.removeEventListener('click', onCancel);
      overlay.removeEventListener('click', onOverlay);
      const note = (noteEl && noteEl.value || '').trim();
      if (noteWrap) noteWrap.style.display = 'none';
      resolve(opts.withNote ? { ok, note } : ok);
    };
    const onOk = () => cleanup(true);
    const onCancel = () => cleanup(false);
    // 點遮罩（外側）＝取消，與其他 modal 一致
    const onOverlay = (e) => {
      if (e.target === overlay) cleanup(false);
    };
    btnOk.addEventListener('click', onOk, { once: true });
    btnCan.addEventListener('click', onCancel, { once: true });
    overlay.addEventListener('click', onOverlay);
  });
}

const fallbackAvatarDataUri = 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(`
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
    <rect width="64" height="64" rx="32" fill="#e2e8f0"/>
    <circle cx="32" cy="25" r="12" fill="#94a3b8"/>
    <path d="M12 58c4-12 14-18 20-18s16 6 20 18" fill="#94a3b8"/>
  </svg>
`);
const { createApp, ref, computed, onMounted, watch, nextTick } = Vue;

createApp({
  setup() {
    // 清空舊有的系統設定快取避免衝突
    localStorage.removeItem('jcjh_google_client_id');
    localStorage.removeItem('jcjh_gas_url');
    localStorage.removeItem('jcjh_gas_mail_api');

    // ════════════════════════════════════════
    // §1 系統狀態 / 登入 / 學期
    // ════════════════════════════════════════
    // 系統狀態
    const user = ref(null);
    const userRole = ref('teacher'); // 'admin' 或 'teacher'
    const originalUser = ref(null); // 模擬前的原始管理員身分
    const avatarLoadFailed = ref(false);
    const avatarSrc = computed(() => {
      const src = user.value && user.value.photoURL ? String(user.value.photoURL).trim() : '';
      return (!src || avatarLoadFailed.value) ? fallbackAvatarDataUri : src;
    });
    const handleAvatarError = (event) => {
      avatarLoadFailed.value = true;
      if (event && event.target) {
        event.target.src = fallbackAvatarDataUri;
      }
    };
    watch(user, () => {
      avatarLoadFailed.value = false;
    });
    
    // GAS & GSI 設定
    const googleClientId = ref(atob('MTA4MTQ5MTA4NTI3OC12ZWZqY3BrdW0xM3Iydm0zbnVuZ3ZuNnZiMjU5bzJhdC5hcHBzLmdvb2dsZXVzZXJjb250ZW50LmNvbQ=='));
    const gasApiUrl = ref(atob('aHR0cHM6Ly9zY3JpcHQuZ29vZ2xlLmNvbS9tYWNyb3Mvcy9BS2Z5Y2J3Q0UwZm5JVWlyd2x3QWQ2WXJoZFJDWnNBX0tYczMxQW16Y2RZY2EwU05DY0dTWVdnTGUxYXpFY3l4MlA3bmlkb01NZy9leGVj'));


    // 統一呼叫 GAS API（抽離至 gas-api.js）
    /** 靜默刷新 Google ID Token（A）；供 gas-api 請求前／背景換票 */
    let _gsiInitialized = false;
    let _tokenRefreshP = null;
    const refreshGoogleIdToken = () => {
      if (_tokenRefreshP) return _tokenRefreshP;
      _tokenRefreshP = new Promise((resolve) => {
        try {
          if (!googleClientId.value || typeof google === 'undefined'
              || !google.accounts || !google.accounts.id) {
            resolve(null);
            return;
          }
          // 確保已 initialize（onMounted 也會 init；這裡防尚未就緒）
          if (!_gsiInitialized) {
            try {
              google.accounts.id.initialize({
                client_id: googleClientId.value,
                callback: function (resp) {
                  // 預設 callback；實際 refresh 用下方覆寫式 callback
                  if (resp && resp.credential) {
                    localStorage.setItem('jcjh_google_id_token', resp.credential);
                  }
                },
                auto_select: true,
                cancel_on_tap_outside: false
              });
              _gsiInitialized = true;
            } catch (eInit) { /* may already init */ }
          }
          let settled = false;
          const finish = (tok) => {
            if (settled) return;
            settled = true;
            resolve(tok || null);
          };
          // 暫時掛一次性 callback 接 silent credential
          const prev = window.handleCredentialResponse;
          window.handleCredentialResponse = async (response) => {
            try {
              const token = response && response.credential;
              if (!token) {
                finish(null);
                return;
              }
              const payload = decodeJwt(token);
              if (!payload || !assertSchoolDomain(payload)) {
                finish(null);
                return;
              }
              localStorage.setItem('jcjh_google_id_token', token);
              // 若已有 user 只更新欄位；若被清掉則補回（不整頁重整）
              if (!user.value || String(user.value.email || '').toLowerCase() !== String(payload.email || '').toLowerCase()) {
                user.value = {
                  email: payload.email,
                  displayName: payload.name,
                  photoURL: payload.picture
                };
              } else {
                user.value = Object.assign({}, user.value, {
                  displayName: payload.name || user.value.displayName,
                  photoURL: payload.picture || user.value.photoURL
                });
              }
              finish(token);
            } catch (e) {
              finish(null);
            } finally {
              // 還原正式登入 callback
              if (typeof prev === 'function') window.handleCredentialResponse = prev;
            }
          };
          try {
            google.accounts.id.initialize({
              client_id: googleClientId.value,
              callback: window.handleCredentialResponse,
              auto_select: true,
              cancel_on_tap_outside: false
            });
            _gsiInitialized = true;
          } catch (e2) { /* ignore */ }
          // 超時：One Tap 可能被擋
          setTimeout(() => finish(null), 4500);
          try {
            google.accounts.id.prompt((notification) => {
              try {
                if (notification && typeof notification.isNotDisplayed === 'function'
                    && notification.isNotDisplayed()) {
                  finish(null);
                } else if (notification && typeof notification.isSkippedMoment === 'function'
                    && notification.isSkippedMoment()) {
                  finish(null);
                }
              } catch (eN) { /* ignore */ }
            });
          } catch (eP) {
            finish(null);
          }
        } catch (e) {
          resolve(null);
        }
      }).finally(() => {
        _tokenRefreshP = null;
      });
      return _tokenRefreshP;
    };

    const {
      callGasApi, fetchInitialData, fetchMetaData, fetchPublicClassData,
      fetchPendingOnly, fetchRequestsDelta, fetchHistoryMonth, fetchMatchCandidates,
      decodeJwt, isTokenExpired, isTokenExpiringSoon,
      formatError, clearSWR, parseAllowedHd, isEmailDomainAllowed, DEFAULT_ALLOWED_HD
    } = window.GasApi.createClient({
      getApiUrl: () => gasApiUrl.value,
      getSemesterId: () => currentSemester.value,
      refreshIdToken: () => refreshGoogleIdToken(),
      // B：過期只清 user，不 reload（gas-api 已移除 location.reload）
      onAuthExpired: () => {
        user.value = null;
        try {
          // 再觸發一次 One Tap／登入鈕，方便立刻登回
          if (typeof google !== 'undefined' && google.accounts && google.accounts.id) {
            google.accounts.id.prompt();
          }
        } catch (e) { /* ignore */ }
      },
      showToast
    });
    // 網域白名單：預設 → 後端 settings.allowedHd 覆寫
    const allowedHdList = ref(DEFAULT_ALLOWED_HD.slice());
    const applySettings = (settings) => {
      if (!settings) return;
      allowedHdList.value = parseAllowedHd(settings);
    };
    const assertSchoolDomain = (payload) => {
      const email = payload && payload.email;
      if (!isEmailDomainAllowed(email, payload, allowedHdList.value)) {
        localStorage.removeItem('jcjh_google_id_token');
        showToast('⚠️ 非本校網域帳號，無法登入本系統。', 'error');
        resetAppState();
        loading.value = false;
        return false;
      }
      return true;
    };

    
    // 手機板星期選擇狀態與偵測
    const selectedMobileDay = ref(1);
    const isMobile = ref(false);
    const showMatchModal = ref(false);

    const checkMobile = () => {
      isMobile.value = window.innerWidth <= 768;
    };
    const initMobileDay = () => {
      const day = new Date().getDay();
      if (day >= 1 && day <= 5) {
        selectedMobileDay.value = day;
      } else {
        selectedMobileDay.value = 1;
      }
    };
    const loading = ref(true);
    const loadingMessage = ref('初始化系統中...');
    // 分頁記憶：URL hash 優先（#records），localStorage 備援
    const TAB_LS_KEY = 'jcjh_active_tab';
    const ADMIN_SUBTAB_LS_KEY = 'jcjh_admin_sub_tab';
    const VALID_TABS = ['timetable', 'pending', 'records', 'class', 'admin'];
    const VALID_ADMIN_SUBTABS = ['billing', 'teachers', 'import', 'settings', 'schoolExport'];
    const readHashTab = () => {
      try {
        const h = String(window.location.hash || '').replace(/^#/, '').split('?')[0].trim().toLowerCase();
        // 相容 #admin/billing 這類寫法
        const base = h.split('/')[0];
        return VALID_TABS.includes(base) ? base : '';
      } catch (e) { return ''; }
    };
    const readHashAdminSub = () => {
      try {
        const h = String(window.location.hash || '').replace(/^#/, '').trim().toLowerCase();
        const parts = h.split('/');
        if (parts[0] === 'admin' && parts[1] && VALID_ADMIN_SUBTABS.includes(parts[1])) return parts[1];
        return '';
      } catch (e) { return ''; }
    };
    const readStoredTab = () => {
      try {
        const fromHash = readHashTab();
        if (fromHash) return fromHash;
        const t = String(localStorage.getItem(TAB_LS_KEY) || '').trim();
        return VALID_TABS.includes(t) ? t : 'timetable';
      } catch (e) { return 'timetable'; }
    };
    const readStoredAdminSubTab = () => {
      try {
        const fromHash = readHashAdminSub();
        if (fromHash) return fromHash;
        const t = String(localStorage.getItem(ADMIN_SUBTAB_LS_KEY) || '').trim();
        return VALID_ADMIN_SUBTABS.includes(t) ? t : 'billing';
      } catch (e) { return 'billing'; }
    };
    const activeTab = ref(readStoredTab());
    const adminSubTab = ref(readStoredAdminSubTab());
    let _navPersistReady = false;
    const persistNavPosition = () => {
      try {
        if (!VALID_TABS.includes(activeTab.value)) return;
        localStorage.setItem(TAB_LS_KEY, activeTab.value);
        if (VALID_ADMIN_SUBTABS.includes(adminSubTab.value)) {
          localStorage.setItem(ADMIN_SUBTAB_LS_KEY, adminSubTab.value);
        }
        // 寫入 hash，重整可直接還原（略過公開 ?class= 唯讀）
        if (!classReadonlyMode || !classReadonlyMode.value) {
          const nextHash = activeTab.value === 'admin'
            ? ('#admin/' + (adminSubTab.value || 'billing'))
            : ('#' + activeTab.value);
          if (window.location.hash !== nextHash) {
            window.history.replaceState(null, '', window.location.pathname + window.location.search + nextHash);
          }
        }
      } catch (e) { /* ignore */ }
    };
    const setActiveTab = (tab) => {
      if (!VALID_TABS.includes(tab)) return;
      activeTab.value = tab;
      persistNavPosition();
    };
    watch(activeTab, () => { if (_navPersistReady) persistNavPosition(); });
    watch(adminSubTab, () => { if (_navPersistReady) persistNavPosition(); });

    // 學期設定
    const currentSemester = ref(localStorage.getItem('jcjh_semester') || '114-1');
    // 學期列表（動態從 GAS 讀取）
    const semestersList = ref([]);
    const availableSemesters = computed(() => semestersList.value.map(s => s.id));
    const currentSemesterName = computed(() => {
      const sem = semestersList.value.find(s => s.id === currentSemester.value);
      return sem ? sem.name : currentSemester.value;
    });
    const showSemesterModal = ref(false);
    const semesterModalMode = ref('add');
    const semesterForm = ref({ id: '', name: '', startDate: '', endDate: '' });

    // 課表看板資料
    const toLocalDateStr = (date) => window.DateUtils.toLocalDateStr(date);

    const selectedWeekDate = ref(toLocalDateStr(new Date())); 
    const searchQuery = ref('');
    // 管理員課表範圍：mine＝只看自己（預設）；all＝全校；其餘＝依科目篩選
    const selectedSubject = ref('mine');
    // I：切到全校時輕提示（分頁＋搜尋）
    let _allSchoolTipOnce = false;
    watch(selectedSubject, (v) => {
      if (v === 'all' && !_allSchoolTipOnce) {
        _allSchoolTipOnce = true;
        showToast('全校課表已分頁；可用上方搜尋姓名快速定位', 'info', 2800);
      }
    });
    const teachersList = ref([]); // 所有教師 [{email, name, subject, role, baseHours}]
    const allSchedules = ref([]); // 基礎課表 [{id, teacherEmail, teacherName, dayOfWeek, period, className, subject, attr}]
    const substitutionRecords = ref([]);
    /**
     * 從「已組裝的 substitution 列 + 基礎課表」解析教師在該日該節的有效班科
     * 支援多段調代鏈：沿 original→actual 走到目前 email，班科取鏈上第一筆有值的 record／起點基礎課
     */
    const resolveCellFromBaseAndSubs = (email, dateStr, period, dayOfWeek, subsSoFar) => {
      if (!email || period == null || period === '') return null;
      const em = String(email).toLowerCase();
      const p = parseInt(period, 10);
      const dateKey = String(dateStr || '');
      const slotSubs = (subsSoFar || []).filter(s =>
        s && String(s.date) === dateKey && parseInt(s.period, 10) === p
      );

      // 1) 直接：此人是 actual（調入／代課中）
      const asActual = slotSubs.filter(s =>
        s.actualTeacherEmail && String(s.actualTeacherEmail).toLowerCase() === em
      );
      if (asActual.length) {
        // 取鏈末端（若同格多筆，後寫入的較新）
        const hit = asActual[asActual.length - 1];
        let cls = hit.className || '';
        let subj = hit.subject || '';
        // 班科空：沿 forward 鏈回推起點
        if (!cls || !subj) {
          const byOrig = {};
          slotSubs.forEach(s => {
            if (s.originalTeacherEmail && s.actualTeacherEmail) {
              byOrig[String(s.originalTeacherEmail).toLowerCase()] = s;
            }
          });
          // 反查：誰一路轉到 em
          let start = null;
          Object.keys(byOrig).forEach(o => {
            let cur = o;
            const vis = new Set();
            while (byOrig[cur] && !vis.has(cur)) {
              vis.add(cur);
              const next = String(byOrig[cur].actualTeacherEmail).toLowerCase();
              if (next === em) { start = o; break; }
              cur = next;
            }
          });
          if (start) {
            let cur = start;
            const vis = new Set();
            while (byOrig[cur] && !vis.has(cur)) {
              vis.add(cur);
              const rec = byOrig[cur];
              if (!cls && rec.className) cls = rec.className;
              if (!subj && rec.subject) subj = rec.subject;
              cur = String(rec.actualTeacherEmail).toLowerCase();
            }
            if ((!cls || !subj) && typeof findBaseScheduleSlot === 'function') {
              let dayNum = dayOfWeek;
              if ((dayNum == null || dayNum === '') && dateStr) {
                const d = new Date(String(dateStr).replace(/-/g, '/'));
                if (!Number.isNaN(d.getTime())) dayNum = d.getDay() === 0 ? 7 : d.getDay();
              }
              const base = findBaseScheduleSlot(start, dayNum, period, dateStr);
              if (base) {
                if (!cls) cls = base.className || '';
                if (!subj) subj = base.subject || '';
              }
            }
          }
        }
        if (cls || subj) {
          return {
            className: cls,
            subject: subj,
            fromSub: true,
            isSubstitutionDuty: true,
            dutyType: hit.type || ''
          };
        }
      }

      // 2) 此人是 original（已調出）→ 無有效課可再對調，回 null 讓上層顯示空
      const asOrig = slotSubs.find(s =>
        s.originalTeacherEmail && String(s.originalTeacherEmail).toLowerCase() === em
      );
      if (asOrig) return null;

      let dayNum = dayOfWeek;
      if ((dayNum == null || dayNum === '') && dateStr) {
        const d = new Date(String(dateStr).replace(/-/g, '/'));
        if (!Number.isNaN(d.getTime())) dayNum = d.getDay() === 0 ? 7 : d.getDay();
      }
      // 3) 執行期有效課表
      if (dateStr && typeof getScheduleForDate === 'function') {
        try {
          const cell = getScheduleForDate(email, dateStr, period, dayNum);
          if (cell && cell.isSubstitutionDuty && (cell.className || cell.subject)) return cell;
          if (cell && (cell.className || cell.subject) && !cell.isSubstituted) return cell;
        } catch (e) { /* 尚未就緒 */ }
      }
      const base = typeof findBaseScheduleSlot === 'function'
        ? findBaseScheduleSlot(email, dayNum, period, dateStr)
        : null;
      return base;
    };

    const convertRequestsToSubstitutions = (requests) => {
      const subs = [];
      const approved = (requests || []).filter(r => r && r.status === 'approved');
      // 建立時間優先，讓較早核准的調入可被後續對調引用
      approved.sort((a, b) => {
        const ta = String(a.createdAt || a.requestDate || '');
        const tb = String(b.createdAt || b.requestDate || '');
        if (ta !== tb) return ta.localeCompare(tb);
        return String(a.id || '').localeCompare(String(b.id || ''));
      });

      approved.forEach(req => {
        if (req.type === 'substitution' || req.type === '代課') {
          // 請假節可能本身已是調入課：班科以有效課為準，缺才用申請單
          let leaveDay = req.requestPeriodDay;
          if ((leaveDay == null || leaveDay === '') && req.requestDate) {
            const d = new Date(String(req.requestDate).replace(/-/g, '/'));
            if (!Number.isNaN(d.getTime())) leaveDay = d.getDay() === 0 ? 7 : d.getDay();
          }
          const leaveCell = resolveCellFromBaseAndSubs(
            req.requesterEmail,
            req.requestDate,
            req.requestPeriod,
            leaveDay,
            subs
          );
          // 有效課優先（調入再代課／對調時申請單 className 可能是舊基礎課）
          const leaveCls = ((leaveCell && leaveCell.className) || req.className || '');
          const leaveSubj = ((leaveCell && leaveCell.subject) || req.subject || '');
          subs.push({
            id: req.id,
            date: req.requestDate,
            period: req.requestPeriod,
            originalTeacherEmail: req.requesterEmail,
            actualTeacherEmail: req.targetTeacherEmail,
            className: leaveCls,
            subject: leaveSubj,
            requestId: req.id,
            type: 'substitution',
            printed: req.printed,
            subFee: req.subFee,
            reason: req.reason,
            note: req.note
          });
        } else if (req.type === 'exchange' || req.type === '對調') {
          // 請假節若已是「代課／調入義務」（空堂代生物），再調出必須寫生物，不可回退基礎數學
          // 否則科目＝自己的基礎／專長
          let dayNum = req.targetDayOfWeek;
          if ((dayNum == null || dayNum === '') && req.targetDate) {
            const d = new Date(String(req.targetDate).replace(/-/g, '/'));
            if (!Number.isNaN(d.getTime())) dayNum = d.getDay() === 0 ? 7 : d.getDay();
          }
          let leaveDay = req.requestPeriodDay;
          if ((leaveDay == null || leaveDay === '') && req.requestDate) {
            const d2 = new Date(String(req.requestDate).replace(/-/g, '/'));
            if (!Number.isNaN(d2.getTime())) leaveDay = d2.getDay() === 0 ? 7 : d2.getDay();
          }
          const ownSubject = (email, dateStr, period, day) => {
            let base = null;
            if (typeof findBaseScheduleSlot === 'function') {
              base = findBaseScheduleSlot(email, day, period, dateStr);
            }
            return (base && base.subject)
              || (typeof getTeacherSubjectByEmail === 'function' ? getTeacherSubjectByEmail(email) : '')
              || '';
          };
          const leaveEff = resolveCellFromBaseAndSubs(
            req.requesterEmail, req.requestDate, req.requestPeriod, leaveDay, subs
          );
          const targetEff = resolveCellFromBaseAndSubs(
            req.targetTeacherEmail, req.targetDate, req.targetPeriod, dayNum, subs
          );
          // 對調＝時間互換、各自帶自己的班科到新時段（不用教師專長欄覆寫）
          // 僅「代課義務」再對調：帶來的是義務班科
          const leaveSubDuty = !!(leaveEff && leaveEff.fromSub && (
            leaveEff.dutyType === 'substitution' || leaveEff.dutyType === '代課'
          ));
          const leaveCls = leaveSubDuty
            ? ((leaveEff && leaveEff.className) || req.className || '')
            : (req.className || (leaveEff && leaveEff.className) || '');
          const leaveSubj = leaveSubDuty
            ? ((leaveEff && leaveEff.subject) || req.subject || '')
            : (req.subject
              || (leaveEff && leaveEff.subject)
              || ownSubject(req.requesterEmail, req.requestDate, req.requestPeriod, leaveDay)
              || '');
          const targetSubDuty = !!(targetEff && targetEff.fromSub && (
            targetEff.dutyType === 'substitution' || targetEff.dutyType === '代課'
          ));
          const targetCls = targetSubDuty
            ? ((targetEff && targetEff.className) || req.targetClassName || '')
            : (req.targetClassName || (targetEff && targetEff.className) || '');
          const targetSubj = targetSubDuty
            ? ((targetEff && targetEff.subject) || req.targetSubject || '')
            : (req.targetSubject
              || (targetEff && targetEff.subject)
              || ownSubject(req.targetTeacherEmail, req.targetDate, req.targetPeriod, dayNum)
              || '');

          // _1：目標日 — 原師＝受邀人（調出），實師＝申請人（帶來自己請假節的班科）
          subs.push({
            id: req.id + '_1',
            date: req.targetDate,
            period: req.targetPeriod,
            originalTeacherEmail: req.targetTeacherEmail,
            actualTeacherEmail: req.requesterEmail,
            className: leaveCls,
            subject: leaveSubj,
            requestId: req.id,
            type: 'exchange',
            printed: req.printed,
            subFee: '無',
            reason: req.reason,
            note: req.note
          });

          // _2：請假日 — 原師＝申請人（調出），實師＝受邀人（帶來自己目標節的班科）
          subs.push({
            id: req.id + '_2',
            date: req.requestDate,
            period: req.requestPeriod,
            originalTeacherEmail: req.requesterEmail,
            actualTeacherEmail: req.targetTeacherEmail,
            className: targetCls,
            subject: targetSubj,
            requestId: req.id,
            type: 'exchange',
            printed: req.printed,
            subFee: '無',
            reason: req.reason,
            note: req.note
          });
        }
      });
      return subs;
    };
    const requestsList = ref([]); // 已核准 substitutions [{id, date, period, originalTeacherEmail, actualTeacherEmail, className, subject, requestId, type, printed, subFee, reason, note}]

    // 單/雙週輔導課輔助
    const semesterStartDate = computed(() => {
      const sem = semestersList.value.find(s => s.id === currentSemester.value);
      return sem ? sem.startDate : '';
    });
    const getWeekNumber = (dateStr) => {
      if (!dateStr || !semesterStartDate.value) return 0;
      const refDate = new Date(semesterStartDate.value.replace(/-/g, '/'));
      // 以學期 startDate 所在「週的週一」為第 1 週起點
      const refDay = refDate.getDay();
      const monDiff = refDay === 0 ? -6 : 1 - refDay;
      const refMonday = new Date(refDate);
      refMonday.setDate(refDate.getDate() + monDiff);
      const targetDate = new Date(dateStr.replace(/-/g, '/'));
      const diffDays = Math.floor((targetDate - refMonday) / (1000 * 60 * 60 * 24));
      return Math.floor(diffDays / 7) + 1;
    };

    const currentWeekNumber = computed(() => {
      if (!currentWeekDates.value.length) return '';
      const wn = getWeekNumber(currentWeekDates.value[0]);
      return wn > 0 ? `第 ${wn} 週` : '';
    });

    const isSingleWeek = (dateStr) => {
      const wn = getWeekNumber(dateStr);
      return wn === 0 || wn % 2 === 1;
    };

    // 班級空堂事件（畢旅 keep／畢業 reduce）；取代舊「畢業日隱藏九年級」
    const classAwayEvents = ref([]);
    const semesterEndDate = computed(() => {
      const sem = semestersList.value.find(s => s.id === currentSemester.value);
      return sem ? (sem.endDate || '') : '';
    });
    /** 該班該日是否落在空堂事件（視覺淡化用；不再把格子當空堂刪除） */
    const isClassAwayOnDate = (className, dateStr) => {
      if (!className || !window.DomainClassAway) return false;
      const d = dateStr || getTodayString();
      return window.DomainClassAway.isClassAwayOnDate(
        className, d, classAwayEvents.value, semesterEndDate.value
      );
    };
    // 空堂契約：畫面 is-away-class 淡化；邏輯 isClassAway（媒合／衝堂／模擬／匯出當空堂）
    // 已廢止 shouldHideClass（勿再回傳 false 的殭屍函式）
    const activeAwayBanner = computed(() => {
      if (!window.DomainClassAway) return null;
      const today = getTodayString();
      const active = window.DomainClassAway.eventsActiveOnDate(
        today, classAwayEvents.value, semesterEndDate.value
      );
      if (!active.length) return null;
      const names = active.map(e => e.name || '未命名').join('、');
      const classes = window.DomainClassAway.getActiveAwayClasses(
        today, classAwayEvents.value, semesterEndDate.value
      );
      return { names, classes, count: classes.length };
    });

    // 新手引導 UI（簡潔版：置中卡牌，無 spotlight，手機友善）
    // ── 新手 Spotlight 導覽（懶載入 onboarding-tour.js）──
    const ONBOARDING_SCRIPT = 'onboarding-tour.js?v=20260717-tour30';
    /** 導覽用虛擬「收到的邀請」（不寫入後端） */
    const tourDemoInvite = ref(null);
    let _onboardingLoadP = null;
    let _tourDemoCellCache = null; // 重用示範格，少重算／少重複 API
    const ensureOnboardingTour = () => {
      if (window.OnboardingTour && typeof window.OnboardingTour.start === 'function') {
        return Promise.resolve(window.OnboardingTour);
      }
      if (_onboardingLoadP) return _onboardingLoadP;
      _onboardingLoadP = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = ONBOARDING_SCRIPT;
        s.async = true;
        s.onload = () => resolve(window.OnboardingTour);
        s.onerror = () => {
          _onboardingLoadP = null;
          reject(new Error('無法載入操作教學'));
        };
        document.head.appendChild(s);
      });
      return _onboardingLoadP;
    };

    /** 導覽用：找登入者本週第一格有課（非巡堂、非調出）；同一次導覽快取 */
    const findDemoScheduleCell = () => {
      if (_tourDemoCellCache) return _tourDemoCellCache;
      const email = user.value && user.value.email;
      if (!email) return null;
      const dates = currentWeekDates.value || [];
      for (let day = 1; day <= 5; day++) {
        const dateStr = dates[day - 1];
        if (!dateStr) continue;
        for (let period = 1; period <= 8; period++) {
          try {
            const cell = getScheduleForDate(email, dateStr, period, day);
            if (!cell) continue;
            if (cell.isSubstituted) continue;
            if (cell.isPatrol || cell.attr === '巡堂') continue;
            if (cell.isPending) continue;
            if (!cell.className && !cell.subject) continue;
            _tourDemoCellCache = {
              teacherEmail: email,
              teacherName: getTeacherNameByEmail(email),
              dayOfWeek: day,
              period: period,
              dateStr: dateStr,
              classData: cell
            };
            return _tourDemoCellCache;
          } catch (e) { /* ignore */ }
        }
      }
      return null;
    };

    const openMatchDemoForTour = async () => {
      activeTab.value = 'timetable';
      await nextTick();
      const demo = findDemoScheduleCell();
      if (!demo) {
        showToast('本週找不到可示範的課堂，已略過媒合相關步驟（有課的週再點 ❓ 重播）', 'info');
        return false;
      }
      // 同一格且抽屜已開：不重打媒合
      const sameCell = activeCell.value
        && String(activeCell.value.teacherEmail || '').toLowerCase() === String(demo.teacherEmail).toLowerCase()
        && parseInt(activeCell.value.dayOfWeek, 10) === demo.dayOfWeek
        && parseInt(activeCell.value.period, 10) === demo.period
        && String(inputRequestDate.value || '') === String(demo.dateStr || '');
      if (showMatchModal.value && sameCell && document.querySelector('[data-tour="match-drawer"]')) {
        return true;
      }
      activeCell.value = {
        teacherEmail: demo.teacherEmail,
        teacherName: demo.teacherName,
        dayOfWeek: demo.dayOfWeek,
        period: demo.period,
        classData: demo.classData
      };
      inputRequestDate.value = demo.dateStr;
      matchMode.value = 'substitution';
      showMatchModal.value = true;
      await nextTick();
      try {
        fetchRecommendations();
      } catch (e) { /* ignore */ }
      await new Promise((r) => setTimeout(r, 280));
      return !!document.querySelector('[data-tour="match-drawer"]');
    };

    const closeMatchDemoForTour = () => {
      try {
        if (typeof closeMatchModal === 'function') closeMatchModal();
        else {
          showMatchModal.value = false;
          if (typeof clearMatchPreview === 'function') clearMatchPreview();
        }
      } catch (e) {
        showMatchModal.value = false;
      }
    };

    /** 導覽：選第一位媒合老師並開啟「模擬」視窗（不送出） */
    const openCompareDemoForTour = async () => {
      // 確保媒合已開
      if (!showMatchModal.value) {
        const ok = await openMatchDemoForTour();
        if (!ok) return false;
      }
      await nextTick();
      // 等名單出現（真實 API 可能稍慢）
      let list = recommendedTeachers.value || [];
      for (let i = 0; i < 12 && (!list || !list.length); i++) {
        await new Promise((r) => setTimeout(r, 200));
        list = recommendedTeachers.value || [];
      }
      const cand = (list || []).find((t) => t && t.email);
      if (!cand) {
        showToast('目前沒有可模擬的代課人選，已略過模擬畫面步驟', 'info');
        return false;
      }
      try {
        // 代課模式模擬（與點「模擬」相同）
        const result = await prepCompare('substitution', cand.email);
        if (result === 'cancelled') return false;
      } catch (e) {
        console.warn(e);
        showToast('無法開啟模擬畫面', 'warning');
        return false;
      }
      await nextTick();
      await new Promise((r) => setTimeout(r, 200));
      return !!document.querySelector('[data-tour="compare-modal"]');
    };

    const closeCompareDemoForTour = () => {
      try { showCompareModal.value = false; } catch (e) {}
    };

    /** 導覽：示範「送出成功」視窗與 LINE 範本（與正式 buildLineInviteText 同格式，不真的送出） */
    const openLineDemoForTour = async () => {
      try {
        showCompareModal.value = false;
        showMatchModal.value = false;
      } catch (e) {}
      const demo = findDemoScheduleCell();
      const currentUrl = window.location.origin + window.location.pathname;
      // 與正式送出後範本同一套 buildLineInviteText
      const dateA = demo ? demo.dateStr : '2026-03-20';
      const dayA = demo ? demo.dayOfWeek : 3;
      const periodA = demo ? demo.period : 3;
      const classA = (demo && demo.classData && demo.classData.className) || '701';
      const subjectA = (demo && demo.classData && demo.classData.subject) || '國文';
      // 示範用假 id（格式與正式連結相同，點了不會對到真實單）
      const demoId = 'demo_tour_invite';
      lineCopyText.value = buildLineInviteText({
        targetName: '王小明',
        dateA: dateA,
        dayA: dayA,
        periodA: periodA,
        classA: classA,
        subjectA: subjectA,
        isExchange: false,
        agreeLink: `${currentUrl}?action=respond&id=${encodeURIComponent(demoId)}&status=agree`,
        declineLink: `${currentUrl}?action=respond&id=${encodeURIComponent(demoId)}&status=decline`,
        systemUrl: currentUrl
      });
      // 文末加註：導覽示範
      lineCopyText.value += '\n\n（以上為操作教學示範範本，與正式送出後格式相同；此連結不會對應真實申請單。）';
      successModalTitle.value = '🎉 申請已送出（導覽示範）';
      successModalMessage.value = '這是送出成功後的畫面示範，並未真正送出申請。下方 LINE 範本格式與正式通知相同。';
      hasLineTemplate.value = true;
      lineBatchParts.value = [];
      showSuccessModal.value = true;
      await nextTick();
      await new Promise((r) => setTimeout(r, 200));
      return !!document.querySelector('[data-tour="success-modal"]');
    };

    const closeLineDemoForTour = () => {
      try {
        showSuccessModal.value = false;
        hasLineTemplate.value = false;
        lineCopyText.value = '';
        lineBatchParts.value = [];
      } catch (e) {}
    };

    const clearTourDemoInvite = () => { tourDemoInvite.value = null; };

    /** 導覽：把所有可捲動層歸零，並把 target 頂到 sticky 導覽列下方 */
    const scrollMainToTop = (targetEl) => {
      try {
        const zero = (el) => {
          if (!el) return;
          try {
            if (typeof el.scrollTo === 'function') el.scrollTo(0, 0);
            el.scrollTop = 0;
            el.scrollLeft = 0;
          } catch (e0) { /* ignore */ }
        };
        zero(window);
        zero(document.documentElement);
        zero(document.body);
        zero(document.scrollingElement);
        // 掃所有目前有 scrollTop 的節點
        document.querySelectorAll('body *').forEach((el) => {
          try {
            if (el.scrollTop > 0 || el.scrollLeft > 0) zero(el);
          } catch (e1) { /* ignore */ }
        });
        if (targetEl && targetEl.nodeType === 1) {
          // 從目標往上把可捲動祖先歸零
          let p = targetEl.parentElement;
          while (p) {
            try {
              const st = window.getComputedStyle(p);
              const oy = st.overflowY;
              if ((oy === 'auto' || oy === 'scroll' || oy === 'overlay') && p.scrollHeight > p.clientHeight) {
                zero(p);
              }
            } catch (e2) { /* ignore */ }
            p = p.parentElement;
          }
          targetEl.scrollIntoView({ block: 'start', inline: 'nearest', behavior: 'auto' });
          const nav = document.querySelector('.navbar');
          const navH = nav ? Math.ceil(nav.getBoundingClientRect().height) : 0;
          const top = targetEl.getBoundingClientRect().top;
          // 固定把目標頂緣對齊導覽列下緣
          window.scrollBy(0, top - navH - 10);
        }
      } catch (e) { /* ignore */ }
    };

    const showTourDemoInvite = async () => {
      activeTab.value = 'pending';
      await nextTick();
      scrollMainToTop();
      const me = (user.value && user.value.displayName) || '您';
      const demo = findDemoScheduleCell();
      let leaveSlot = '03/20（三）第3節 · 701 國文';
      if (demo && demo.classData) {
        const d = String(demo.dateStr || '');
        const mmdd = d.length >= 10 ? d.slice(5, 10).replace('-', '/') : d;
        const dayTxt = typeof getWeekDayText === 'function' ? getWeekDayText(demo.dayOfWeek) : '';
        const cls = ((demo.classData.className || '') + ' ' + (demo.classData.subject || '')).trim();
        leaveSlot = mmdd + (dayTxt ? '（' + dayTxt + '）' : '') + '第' + demo.period + '節' + (cls ? ' · ' + cls : '');
      }
      const today = typeof getTodayString === 'function' ? getTodayString() : new Date().toISOString().slice(0, 10);
      tourDemoInvite.value = {
        serial: 'DEMO-導覽',
        createdAt: today,
        requesterName: '王小明（示範）',
        targetTeacherName: me,
        leaveSlot: leaveSlot,
        type: 'substitution'
      };
      await nextTick();
      for (let i = 0; i < 20; i++) {
        if (document.querySelector('[data-tour="pending-invite-demo"]')) break;
        await new Promise((r) => setTimeout(r, 60));
        await nextTick();
      }
      const row = document.querySelector('[data-tour="pending-invite-demo"]');
      const card = document.querySelector('[data-tour="pending-invite"]');
      scrollMainToTop(row || card);
      await new Promise((r) => setTimeout(r, 40));
      scrollMainToTop(row || card);
      return !!document.querySelector('[data-tour="pending-invite-demo"]')
        || !!document.querySelector('[data-tour="pending-invite"]');
    };

    const tourDemoInviteRespond = (action) => {
      if (action === 'agree') {
        showToast('（導覽）您按了「同意」— 真實操作時會通知行政繼續核准。此為示範，未送出。', 'success');
      } else {
        showToast('（導覽）您按了「拒絕」— 真實操作時申請會取消。此為示範，未送出。', 'info');
      }
    };

    /** 導覽：切到課表並強制捲到最頂（週次列／批次鈕框選才準） */
    const goTimetableForTour = async () => {
      clearTourDemoInvite();
      activeTab.value = 'timetable';
      await nextTick();
      // 等課表區掛上
      for (let i = 0; i < 12; i++) {
        if (document.querySelector('[data-tour="week-nav"]')
          || document.querySelector('[data-tour="week-and-grid"]')
          || document.querySelector('[data-tour="batch-btn"]')) break;
        await new Promise((r) => setTimeout(r, 40));
        await nextTick();
      }
      const weekNav = document.querySelector('[data-tour="week-nav"]');
      const weekGrid = document.querySelector('[data-tour="week-and-grid"]');
      const batchBtn = document.querySelector('[data-tour="batch-btn"]');
      // 兩次：第一次整頁歸零，第二次對準週次列（優先，才看得到切週）
      scrollMainToTop(weekNav || weekGrid || batchBtn);
      await new Promise((r) => setTimeout(r, 50));
      scrollMainToTop(weekNav || weekGrid || batchBtn);
      await new Promise((r) => setTimeout(r, 50));
      return true;
    };

    const tourCallbacks = () => ({
      scrollToTop: (el) => { scrollMainToTop(el || null); return true; },
      goTimetable: () => goTimetableForTour(),
      goPending: () => { activeTab.value = 'pending'; return true; },
      goRecords: async () => {
        clearTourDemoInvite();
        activeTab.value = 'records';
        await nextTick();
        for (let i = 0; i < 10; i++) {
          if (document.querySelector('[data-tour="history-panel"]')) break;
          await new Promise((r) => setTimeout(r, 40));
          await nextTick();
        }
        const hist = document.querySelector('[data-tour="history-panel"]');
        scrollMainToTop(hist);
        await new Promise((r) => setTimeout(r, 40));
        scrollMainToTop(hist);
        return true;
      },
      goClass: () => {
        clearTourDemoInvite();
        if (isAdmin.value || classReadonlyMode.value) {
          activeTab.value = 'class';
          return true;
        }
        return false;
      },
      openMatchDemo: () => openMatchDemoForTour(),
      closeMatchDemo: () => { closeMatchDemoForTour(); return true; },
      openCompareDemo: () => openCompareDemoForTour(),
      closeCompareDemo: () => { closeCompareDemoForTour(); return true; },
      openLineDemo: () => openLineDemoForTour(),
      closeLineDemo: () => { closeLineDemoForTour(); return true; },
      closeLineCompareMatchGoPending: () => {
        closeLineDemoForTour();
        closeCompareDemoForTour();
        closeMatchDemoForTour();
        clearTourDemoInvite();
        activeTab.value = 'pending';
        return true;
      },
      closeLineAndShowDemoInvite: async () => {
        closeLineDemoForTour();
        closeCompareDemoForTour();
        closeMatchDemoForTour();
        await nextTick();
        return showTourDemoInvite();
      },
      showDemoInvite: () => showTourDemoInvite(),
      clearDemoInvite: () => { clearTourDemoInvite(); return true; }
    });

    const startOnboarding = async () => {
      try {
        clearTourDemoInvite();
        _tourDemoCellCache = null;
        showToast('載入操作教學…', 'info');
        const tour = await ensureOnboardingTour();
        if (!tour || typeof tour.start !== 'function') throw new Error('教學模組未就緒');
        await tour.start({ callbacks: tourCallbacks() });
      } catch (e) {
        console.error(e);
        showToast('無法載入操作教學：' + (e && e.message ? e.message : e), 'error');
      }
    };
    const nextOnboardingStep = () => {};
    const prevOnboardingStep = () => {};
    const skipOnboarding = () => {
      if (window.OnboardingTour && window.OnboardingTour.isActive && window.OnboardingTour.isActive()) {
        window.OnboardingTour.stop(true);
      }
    };
    // 舊模板殘留用不到；保留 ref 避免 return 解構報錯
    const showOnboarding = ref(false);
    const onboardingStep = ref(0);
    const onboardingSteps = [];
    
    // 申請單紀錄
    const mySentRequests = ref([]);
    const myPendingRequests = ref([]);
    const adminPendingRequests = ref([]);
    const allPendingRequests = ref([]);

    // 智慧媒合與調課
    const matchMode = ref('substitution'); // 'substitution' 或 'exchange'
    const activeCell = ref({ teacherEmail: '', teacherName: '', dayOfWeek: 1, period: 1, classData: null });
    // matchPreview 保留給舊接線／模擬；列表點選改走 plain DOM（見 selectMatchPreview*）
    const matchPreview = ref(null);
    const inputRequestDate = ref('');
    const recommendedTeachers = ref([]);
    const recommendationLoading = ref(false);
    // 批次調代課（方案 A：多筆申請＋同一 batchId；可同一人全代或每節不同人）
    const batchSelectMode = ref(false);
    const batchSlots = ref([]); // [{ key, teacherEmail, teacherName, dateStr, dayOfWeek, period, className, subject, restriction, subTeacherEmail?, subTeacherName? }]
    const showBatchConfirmModal = ref(false);
    const batchSubTeacher = ref('');
    const batchReason = ref('');
    const batchSubFee = ref('自費代課');
    const batchNote = ref('');
    const batchAssignMode = ref('same'); // 'same' | 'perSlot'
    const batchActiveSlotKey = ref(''); // 每節不同人：目前正在媒合的節次 key
    // 活動互代（僅管理員）：額度>0→扣額度；＝0→活動公費；第8節→第8節代課
    const isMutualCover = ref(false);
    // 常數與純邏輯見 domain-activity-cover.js
    // MUTUAL_COVER_FEE 與 QUOTA_DEDUCT_FEE 同值「扣額度」（活動／一般統一）
    const QUOTA_DEDUCT_FEE = (window.DomainActivityCover && window.DomainActivityCover.QUOTA_DEDUCT_FEE) || '扣額度';
    const MUTUAL_COVER_FEE = (window.DomainActivityCover && window.DomainActivityCover.MUTUAL_COVER_FEE) || QUOTA_DEDUCT_FEE;
    const ACTIVITY_PUBLIC_FEE = (window.DomainActivityCover && window.DomainActivityCover.ACTIVITY_PUBLIC_FEE) || '活動公費';
    const isQuotaDeductFee = (fee) => {
      if (DAC() && DAC().isQuotaDeductFee) return DAC().isQuotaDeductFee(fee);
      return String(fee || '') === QUOTA_DEDUCT_FEE || String(fee || '') === '互代不結';
    };
    const PERIOD8_FEE = (window.DomainActivityCover && window.DomainActivityCover.PERIOD8_FEE) || '第8節代課';
    const MUTUAL_PANEL_LS_KEY = 'jcjh_mutual_panel_draft_v1';
    const mutualAwayClasses = ref([]);
    // 帶隊／請假外出教師（重算額度時排除，不寫入互代額度）
    const mutualLeadEmails = ref([]);
    // 活動互代：先寫單不寄信（稍後用 LINE 手動通知）
    const mutualSkipNotify = ref(true);
    // 一般代課：直接核准送出時可選不寄通知信（預設會寄；待審核准一律寄）
    const directApproveSkipNotify = ref(false);
    // 活動統一備註（寫入每筆申請「備註」）
    const mutualNote = ref('');
    // 活動互代草稿：課表上先暫定代課，全部排完再一次送出
    // [{ key, leaveEmail, leaveName, dateStr, dayOfWeek, period, className, subject, restriction, subEmail, subName, fee }]
    const mutualDrafts = ref([]);
    // 活動期間（預設本週一～五，避免釋出節數算到整份課表）
    const mutualActivityStart = ref('');
    const mutualActivityEnd = ref('');
    const DAC = () => window.DomainActivityCover;
    // ── 活動互代面板狀態（ui-activity.js → UiMutualPanelState）──
    // 延後 create：需 currentWeekDates / getScheduleForDate / softRefresh 就緒
    let _mutualPanelApi = null;
    const getMutualPanelApi = () => {
      if (_mutualPanelApi) return _mutualPanelApi;
      if (!window.UiMutualPanelState) {
        console.error('UiMutualPanelState 未載入');
        return null;
      }
      _mutualPanelApi = window.UiMutualPanelState.create({
        showToast, showConfirm, callGasApi, isAdmin, loading, loadingMessage,
        isMutualCover, mutualAwayClasses, mutualLeadEmails, mutualSkipNotify, mutualNote, mutualDrafts,
        mutualActivityStart, mutualActivityEnd, currentWeekDates, classList, teachersList, allSchedules, requestsList,
        activeCell, inputRequestDate, recommendedTeachers, showMatchModal, pendingRequestData, batchSubFee, directApproveMode,
        ACTIVITY_PUBLIC_FEE, PERIOD8_FEE, getTeacherNameByEmail, softRefreshInBackground, defaultSubFeeForReason, getScheduleForDate,
        DAC
      });
      return _mutualPanelApi;
    };
    const persistMutualPanelDraft = () => { const a = getMutualPanelApi(); if (a) a.persistMutualPanelDraft(); };
    const restoreMutualPanelDraft = () => { const a = getMutualPanelApi(); return a ? a.restoreMutualPanelDraft() : null; };
    const applyMutualPanelDraft = (saved) => { const a = getMutualPanelApi(); if (a) a.applyMutualPanelDraft(saved); };
    const clearMutualPanel = async () => { const a = getMutualPanelApi(); if (a) await a.clearMutualPanel(); };
    const ensureMutualActivityRange = () => { const a = getMutualPanelApi(); if (a) a.ensureMutualActivityRange(); };
    const setMutualActivityThisWeek = () => { const a = getMutualPanelApi(); if (a) a.setMutualActivityThisWeek(); };
    const activityBalanceCtx = (extra) => { const a = getMutualPanelApi(); return a ? a.activityBalanceCtx(extra) : {}; };
    const patchLocalMutualQuota = (email, nextQuota) => { const a = getMutualPanelApi(); if (a) a.patchLocalMutualQuota(email, nextQuota); };
    const recalculateMutualQuotasFromActivity = async () => { const a = getMutualPanelApi(); if (a) await a.recalculateMutualQuotasFromActivity(); };
    const toggleMutualLead = (email) => { const a = getMutualPanelApi(); if (a) a.toggleMutualLead(email); };
    const isMutualLead = (email) => { const a = getMutualPanelApi(); return a ? a.isMutualLead(email) : false; };

    /** 點帶隊老師：未選→加入；已選→取消（跳課表請用下方「各帶隊老師課務」） */
    const onMutualLeadChipClick = (email) => {
      const em = String(email || '').trim();
      if (!em) return;
      const wasLead = isMutualLead(em);
      toggleMutualLead(em);
      const t = lookupTeacher(em);
      const name = t ? t.name : em;
      if (wasLead) showToast(`已取消帶隊：${name}`, 'info');
      else showToast(`已加入帶隊：${name}`, 'info');
    };
    /** 定位到指定教師課表（搜尋姓名並捲動） */
    const jumpToTeacherTimetable = (email) => {
      const em = String(email || '').trim();
      if (!em) return;
      const t = lookupTeacher(em);
      if (!t) {
        showToast('找不到該教師', 'warning');
        return;
      }
      activeTab.value = 'timetable';
      selectedSubject.value = 'all';
      searchQuery.value = t.name || '';
      nextTick(() => {
        // 分頁：把目標老師所在頁打開
        const list = displayTimetableTeachers.value || [];
        const idx = list.findIndex(x => String(x.email || '').toLowerCase() === String(t.email).toLowerCase());
        if (idx >= 0) {
          const size = ttPageSize.value || TT_PAGE_SIZE_DEFAULT;
          ttPage.value = Math.floor(idx / size) + 1;
        }
        nextTick(() => {
          const id = 'tt-teacher-' + String(t.email).replace(/[^a-zA-Z0-9_-]/g, '_');
          const el = document.getElementById(id);
          if (el) {
            el.scrollIntoView({ behavior: 'smooth', block: 'start' });
            el.classList.add('tt-teacher-flash');
            setTimeout(() => el.classList.remove('tt-teacher-flash'), 1600);
          }
          showToast(`已定位：${t.name} 老師課表`, 'success');
        });
      });
    };
    /** 送出後依經費扣減代課老師互代額度（經費＝扣額度） */
    const deductMutualQuotaForRows = async (rows) => {
      if (!rows || !rows.length) return;
      const shouldDeduct = (fee) => {
        if (DAC() && DAC().shouldDeductQuota) {
          return DAC().shouldDeductQuota(fee, !!isMutualCover.value);
        }
        return isQuotaDeductFee(fee);
      };
      const deductMap = {};
      rows.forEach(r => {
        const fee = r['經費來源'] || r.subFee || '';
        if (!shouldDeduct(fee)) return;
        const em = String(r['受邀人Email'] || r.targetTeacherEmail || '').toLowerCase();
        if (!em) return;
        deductMap[em] = (deductMap[em] || 0) + 1;
      });
      const emails = Object.keys(deductMap);
      if (!emails.length) return;
      if (!isAdmin.value) return; // 僅管理員可改額度
      const updates = [];
      emails.forEach(em => {
        const t = lookupTeacher(em);
        const prev = t ? (parseInt(t.mutualQuota, 10) || 0) : 0;
        const next = Math.max(0, prev - deductMap[em]);
        updates.push({ email: t ? t.email : em, mutualQuota: next });
        patchLocalMutualQuota(t ? t.email : em, next);
      });
      try {
        await callGasApi('updateMutualQuotas', { list: updates });
      } catch (e) {
        console.warn('扣減互代額度失敗（申請已送出）', e);
        showToast('申請已送出，但互代額度寫回失敗，請用「重算額度」校正', 'warning');
      }
    };
    /**
     * 申請作廢時樂觀還原互代額度（後端已寫回試算表；此處只更新畫面）
     * 請傳入「改狀態前」的申請單；已作廢狀態不重複加回
     * @param {object|object[]} reqs 前端申請單或 sheet 列
     */
    const restoreMutualQuotaForRows = (reqs) => {
      const list = Array.isArray(reqs) ? reqs : (reqs ? [reqs] : []);
      if (!list.length) return;
      const terminal = { cancelled: 1, rejected: 1, admin_rejected: 1, withdrawn: 1 };
      const addMap = {};
      list.forEach(r => {
        if (!r) return;
        const st = String(r.status || r['狀態'] || '').toLowerCase();
        if (terminal[st]) return;
        const fee = r.subFee || r['經費來源'] || '';
        if (!isQuotaDeductFee(fee)) return;
        const em = String(r.targetTeacherEmail || r['受邀人Email'] || r.actualTeacherEmail || '').toLowerCase();
        if (!em) return;
        addMap[em] = (addMap[em] || 0) + 1;
      });
      Object.keys(addMap).forEach(em => {
        const t = lookupTeacher(em);
        if (!t) return;
        const prev = parseInt(t.mutualQuota, 10) || 0;
        patchLocalMutualQuota(t.email, prev + addMap[em]);
      });
    };
    const selectedClass = ref('');
    const classReadonlyMode = ref(false);
    const pendingClassView = ref('');
    const selectedClassDate = ref(toLocalDateStr(new Date()));
    const selectedClassWeekDates = computed(() => {
      const dates = [];
      const current = new Date(selectedClassDate.value + 'T00:00:00');
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
    });
    const classWeekNumber = computed(() => {
      if (!selectedClassWeekDates.value.length) return '';
      const wn = getWeekNumber(selectedClassWeekDates.value[0]);
      return wn > 0 ? `第 ${wn} 週` : '';
    });

    const classSubstitutionMap = computed(() => {
      const map = {};
      substitutionRecords.value.forEach(r => {
        const key = `${r.className}|${r.date}|${r.period}`;
        map[key] = r;
      });
      return map;
    });

    // 該班代調課異動摘要：每節一列；調課雙向各一列
    // 格式：月/日（星期）第○節 改上 ○○課（○○師）
    const classChangeSummary = computed(() => {
      const cls = selectedClass.value;
      if (!cls) return [];
      const weekSet = new Set(selectedClassWeekDates.value || []);
      const rows = [];
      substitutionRecords.value.forEach(r => {
        if (String(r.className || '') !== String(cls)) return;
        const isEx = r.type === 'exchange' || r.type === '對調';
        // 用 YYYY-MM-DD 或 YYYY/MM/DD 皆可；勿接 T00:00:00 以免部分瀏覽器解析失敗
        let dayNum = 0;
        if (r.date) {
          const raw = String(r.date).trim();
          const d = new Date(raw.includes('T') ? raw : raw.replace(/-/g, '/'));
          if (!Number.isNaN(d.getTime())) {
            const gd = d.getDay();
            dayNum = gd === 0 ? 7 : gd;
          } else {
            const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
            if (m) {
              const d2 = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
              if (!Number.isNaN(d2.getTime())) {
                const gd = d2.getDay();
                dayNum = gd === 0 ? 7 : gd;
              }
            }
          }
        }
        const toName = getTeacherNameByEmail(r.actualTeacherEmail) || '—';
        const subject = r.subject || '';
        const dayPart = dayNum ? (window.DateUtils.getWeekDayText(dayNum) || '') : '';
        const datePart = dayPart
          ? `${formatDateMMDD(r.date)}（${dayPart}）`
          : `${formatDateMMDD(r.date)}`;
        const isMutual = !isEx && isQuotaDeductFee(r.subFee);
        // 班級摘要：互代不顯示「不結鐘點」字樣
        const line = isEx
          ? `${datePart}第${r.period}節 改上 ${subject}（${toName}）`
          : isMutual
            ? `${datePart}第${r.period}節 ${subject} 由${toName}互代`
            : `${datePart}第${r.period}節 ${subject} 由${toName}代課`;
        rows.push({
          id: r.id,
          date: r.date,
          period: r.period,
          dayText: dayPart,
          type: isEx ? '調課' : (isMutual ? '互代' : '代課'),
          line,
          inWeek: weekSet.has(r.date)
        });
      });
      rows.sort((a, b) => {
        if (a.inWeek !== b.inWeek) return a.inWeek ? -1 : 1;
        const c = String(a.date).localeCompare(String(b.date));
        if (c !== 0) return c;
        return parseInt(a.period, 10) - parseInt(b.period, 10);
      });
      return rows;
    });
    const matchSearchQuery = ref('');
    const matchDisplayCount = ref(10);
    const matchShowNoTeacherWarning = ref(false);

    // 調課推薦
    const exchangeTeacherEmail = ref('');
    const exchangeTeacherClasses = ref([]);
    const exchangePeriodId = ref('');
    const exchangeTargetDate = ref('');
    const exchangeWeekOffset = ref(0);


    // 雙人對比 Modal 與列印
    const showCompareModal = ref(false);
    const showSuccessModal = ref(false);
    const successModalTitle = ref('');
    const successModalMessage = ref('');
    const lineCopyText = ref('');
    const hasLineTemplate = ref(false);
    // 多受邀人：[{ name, text }] 方便分開複製／傳送
    const lineBatchParts = ref([]);

    const copyLineMessage = async (text) => {
      const payload = (text != null && String(text).length) ? String(text) : lineCopyText.value;
      try {
        await navigator.clipboard.writeText(payload);
        showToast("📋 LINE 邀請訊息已複製至剪貼簿！可以直接貼給對方老師囉～", 'success');
      } catch (err) {
        console.error("複製失敗：", err);
        showToast("複製失敗，請手動複製文字框內的內容。", 'error');
      }
    };

    const sendLineMessage = (text) => {
      const payload = (text != null && String(text).length) ? String(text) : lineCopyText.value;
      if (!payload) return;
      try {
        navigator.clipboard.writeText(payload);
      } catch (e) {}
      const url = `https://line.me/R/msg/text/?${encodeURIComponent(payload)}`;
      window.open(url, '_blank');
    };

    const copyLineBatchPart = (idx) => {
      const part = lineBatchParts.value[idx];
      if (part && part.text) copyLineMessage(part.text);
    };

    const sendLineBatchPart = (idx) => {
      const part = lineBatchParts.value[idx];
      if (part && part.text) sendLineMessage(part.text);
    };

    /**
     * 行事曆內容：依登入者角色
     * - 請假／調出方：標【不用上】＋原課節次
     * - 代課／調入方：標【代課】／【調入】＋實際要上的節次
     * 按鈕文案固定「行事曆」
     */
    const getCalendarDetails = (req) => {
      if (!req) return null;
      const userEmail = user.value ? String(user.value.email).toLowerCase() : '';
      const requesterEmail = req.requesterEmail ? String(req.requesterEmail).toLowerCase() : '';
      const targetTeacherEmail = req.targetTeacherEmail ? String(req.targetTeacherEmail).toLowerCase() : '';
      const isExchange = req.type === 'exchange' || req.type === '對調';
      const isLeaveSide = !!(userEmail && userEmail === requesterEmail);
      const isCoverSide = !!(userEmail && userEmail === targetTeacherEmail);

      const subs = (substitutionRecords.value || []).filter(r => r && String(r.requestId) === String(req.id));
      const findSubAt = (dateStr, period, asActual) => {
        const p = parseInt(period, 10);
        return subs.find(r =>
          String(r.date || '') === String(dateStr || '')
          && parseInt(r.period, 10) === p
          && (asActual
            ? (r.actualTeacherEmail && String(r.actualTeacherEmail).toLowerCase() === userEmail)
            : (r.originalTeacherEmail && String(r.originalTeacherEmail).toLowerCase() === userEmail))
        ) || null;
      };
      const pickClassSubject = (rec, fallbackClass, fallbackSubj) => {
        if (rec && (rec.className || rec.subject)) {
          return {
            className: rec.className || fallbackClass || '',
            subject: rec.subject || fallbackSubj || ''
          };
        }
        return { className: fallbackClass || '', subject: fallbackSubj || '' };
      };

      // eventDate/Period：寫進行事曆的時間（對使用者有意義的那一節）
      let eventDate = req.requestDate;
      let eventPeriod = req.requestPeriod;
      let titleTag = '代課';
      let className = req.className || '';
      let subject = req.subject || '';
      let actionLine = '';

      if (isExchange) {
        if (isLeaveSide) {
          // 申請人：原節不用上；同時要去上對方節 → 預設記「要上的那節」（較常漏）
          // 標題仍清楚；details 寫兩邊
          eventDate = req.targetDate || req.requestDate;
          eventPeriod = req.targetPeriod != null ? req.targetPeriod : req.requestPeriod;
          const inRec = findSubAt(eventDate, eventPeriod, true)
            || subs.find(r => r.actualTeacherEmail && String(r.actualTeacherEmail).toLowerCase() === userEmail);
          const cs = pickClassSubject(inRec, req.targetClassName || req.className, req.targetSubject || req.subject);
          className = cs.className;
          subject = cs.subject;
          titleTag = '調入';
          actionLine = `本則為您的上課節次。\n原節 ${req.requestDate || ''}第${req.requestPeriod || ''}節（${req.className || ''} ${req.subject || ''}）不用上，由 ${req.targetTeacherName || '對方'} 上。`;
        } else if (isCoverSide) {
          // 受邀人：去上申請人原節
          eventDate = req.requestDate;
          eventPeriod = req.requestPeriod;
          const inRec = findSubAt(eventDate, eventPeriod, true)
            || subs.find(r => r.actualTeacherEmail && String(r.actualTeacherEmail).toLowerCase() === userEmail);
          const cs = pickClassSubject(inRec, req.className, req.subject);
          className = cs.className;
          subject = cs.subject;
          titleTag = '調入';
          actionLine = `本則為您的上課節次。\n您原 ${req.targetDate || ''}第${req.targetPeriod || ''}節 不用上，由 ${req.requesterName || '對方'} 上。`;
        } else {
          eventDate = req.requestDate;
          eventPeriod = req.requestPeriod;
          titleTag = '調課';
          className = req.className || '';
          subject = req.subject || '';
          actionLine = `對調：${req.requestDate || ''}第${req.requestPeriod || ''}節 ⇄ ${req.targetDate || ''}第${req.targetPeriod || ''}節`;
        }
      } else {
        // 代課
        if (isLeaveSide) {
          eventDate = req.requestDate;
          eventPeriod = req.requestPeriod;
          const outRec = findSubAt(eventDate, eventPeriod, false) || subs[0];
          const cs = pickClassSubject(outRec, req.className, req.subject);
          className = cs.className;
          subject = cs.subject;
          titleTag = '不用上';
          actionLine = `本節不用上。\n由 ${req.targetTeacherName || '代課教師'} 代課。`;
        } else if (isCoverSide) {
          eventDate = req.requestDate;
          eventPeriod = req.requestPeriod;
          const inRec = findSubAt(eventDate, eventPeriod, true) || subs[0];
          const cs = pickClassSubject(inRec, req.className, req.subject);
          className = cs.className;
          subject = cs.subject;
          titleTag = '代課';
          actionLine = `本節請代課。\n請假教師：${req.requesterName || ''}。`;
        } else {
          eventDate = req.requestDate;
          eventPeriod = req.requestPeriod;
          titleTag = '代課';
          className = req.className || '';
          subject = req.subject || '';
          actionLine = `請假：${req.requesterName || ''}　代課：${req.targetTeacherName || ''}`;
        }
      }

      if (!eventDate || eventPeriod == null || eventPeriod === '') return null;
      const timeSpan = window.DateUtils.getPeriodTimeSpan(eventPeriod);
      if (!timeSpan) return null;
      const parts = timeSpan.split('-');
      const datePart = String(eventDate).replace(/-/g, '');
      const startIso = datePart + 'T' + parts[0].replace(':', '') + '00';
      const endIso = datePart + 'T' + parts[1].replace(':', '') + '00';

      const slotLabel = `${className || ''}${subject || ''}`.trim() || '課堂';
      const title = `【${titleTag}】${slotLabel}`;
      let details = `${actionLine}\n\n請假教師：${req.requesterName || ''}\n代課／對調教師：${req.targetTeacherName || ''}\n假別事由：${req.reason || '請假'}\n單號：${req.serial || ''}`;
      if (isExchange) {
        details += `\n對調：${req.requestDate || ''}第${req.requestPeriod || ''}節 ⇄ ${req.targetDate || ''}第${req.targetPeriod || ''}節`;
      }
      details += `\n（建成國中調代課系統）`;

      return {
        title,
        startIso,
        endIso,
        details,
        titleTag
      };
    };

    const addToGoogleCalendar = (req) => {
      const cal = getCalendarDetails(req);
      if (!cal) {
        showToast('無法產生行事曆（缺少日期或節次）', 'warning');
        return;
      }

      const url = `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent(cal.title)}&dates=${cal.startIso}/${cal.endIso}&details=${encodeURIComponent(cal.details)}`;
      window.open(url, '_blank');
    };

    const downloadIcsCalendar = (req) => {
      const cal = getCalendarDetails(req);
      if (!cal) {
        showToast('無法產生行事曆（缺少日期或節次）', 'warning');
        return;
      }

      const icsDetails = cal.details.replace(/\n/g, '\\n');
      const stamp = new Date().toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
      const icsContent = [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//建成國中線上調代課系統//NONSGML v1.0//EN',
        'BEGIN:VEVENT',
        `UID:${req.id || Date.now()}@substitution.sys`,
        `DTSTAMP:${stamp}`,
        `DTSTART:${cal.startIso}`,
        `DTEND:${cal.endIso}`,
        `SUMMARY:${cal.title}`,
        `DESCRIPTION:${icsDetails}`,
        'END:VEVENT',
        'END:VCALENDAR'
      ].join('\r\n');

      // 針對 iOS 進行特別體驗優化：直接以 data URI 開啟，Safari 會自動彈出原生「加入行事曆」畫面，免除下載後再去檔案 App 打開的繁瑣步驟
      const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
      if (isIOS) {
        window.location.href = 'data:text/calendar;charset=utf-8,' + encodeURIComponent(icsContent);
      } else {
        const blob = new Blob([icsContent], { type: 'text/calendar;charset=utf-8' });
        const link = document.createElement('a');
        link.href = window.URL.createObjectURL(blob);
        link.download = `${req.serial || 'event'}_substitution.ics`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
      }
    };

    const addEventToCalendar = (req) => {
      const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
      if (isIOS) {
        downloadIcsCalendar(req);
      } else {
        addToGoogleCalendar(req);
      }
    };
    const getTargetSubject = (req) => {
      if (!req) return '';
      if (req.type === 'exchange') {
        const info = getTargetClassAndSubject(req);
        return info.subject || req.targetSubject || '';
      }
      return req.targetSubject || req.subject || '';
    };
    const getTargetClassAndSubject = (req) => {
      if (!req || req.type !== 'exchange') return { className: '', subject: '' };
      let dayNum = req.targetDayOfWeek;
      if ((dayNum == null || dayNum === '') && req.targetDate) {
        const d = new Date(String(req.targetDate).replace(/-/g, '/'));
        if (!Number.isNaN(d.getTime())) dayNum = d.getDay() === 0 ? 7 : d.getDay();
      }
      const cell = resolveExchangeTargetCell(req.targetTeacherEmail, req.targetDate, req.targetPeriod, dayNum);
      return {
        className: cell ? (cell.className || '') : (req.targetClassName || ''),
        subject: cell ? (cell.subject || '') : (req.targetSubject || '')
      };
    };
    const getOriginalRequestSubject = (req) => {
      if (!req) return '';
      // 請假課堂以申請單為準；有效課表僅在缺欄時補
      if (req.subject) return req.subject;
      const dateStr = req.requestDate || '';
      if (!dateStr) return '自習';
      const d = new Date(dateStr.replace(/-/g, '/'));
      const day = d.getDay() === 0 ? 7 : d.getDay();
      const cell = resolveExchangeTargetCell(req.requesterEmail, dateStr, req.requestPeriod, day);
      return cell ? (cell.subject || '自習') : '自習';
    };

    const getOriginalRequestClass = (req) => {
      if (!req) return '';
      if (req.className) return req.className;
      const dateStr = req.requestDate || '';
      if (!dateStr) return '';
      const d = new Date(dateStr.replace(/-/g, '/'));
      const day = d.getDay() === 0 ? 7 : d.getDay();
      const cell = resolveExchangeTargetCell(req.requesterEmail, dateStr, req.requestPeriod, day);
      return cell ? (cell.className || '') : '';
    };

    const getOriginalTargetSubject = (req) => {
      if (!req || req.type !== 'exchange') return '';
      let dayNum = req.targetDayOfWeek;
      if ((dayNum == null || dayNum === '') && req.targetDate) {
        const d = new Date(String(req.targetDate).replace(/-/g, '/'));
        if (!Number.isNaN(d.getTime())) dayNum = d.getDay() === 0 ? 7 : d.getDay();
      }
      const cell = resolveExchangeTargetCell(req.targetTeacherEmail, req.targetDate, req.targetPeriod, dayNum);
      return cell ? (cell.subject || '') : (req.targetSubject || '');
    };

    const getOriginalTargetClass = (req) => {
      if (!req || req.type !== 'exchange') return '';
      let dayNum = req.targetDayOfWeek;
      if ((dayNum == null || dayNum === '') && req.targetDate) {
        const d = new Date(String(req.targetDate).replace(/-/g, '/'));
        if (!Number.isNaN(d.getTime())) dayNum = d.getDay() === 0 ? 7 : d.getDay();
      }
      const cell = resolveExchangeTargetCell(req.targetTeacherEmail, req.targetDate, req.targetPeriod, dayNum);
      return cell ? (cell.className || '') : (req.targetClassName || '');
    };


    const resolveDetailRequest = (reqId, subRecord) => {
      let matched = requestsList.value.find(r => r.id === reqId);
      if (!matched) {
        matched = allPendingRequests.value.find(r => r.id === reqId);
      }
      if (matched) return matched;
      if (!subRecord) return null;

      let reqDate = subRecord.date;
      let reqPeriod = subRecord.period;
      let reqPeriodDay = subRecord.dayOfWeek;
      let tgtDate = '—';
      let tgtPeriod = null;
      let tgtDayOfWeek = null;

      let requesterEmail = subRecord.originalTeacherEmail;
      let targetTeacherEmail = subRecord.actualTeacherEmail;
      let reqSubject = subRecord.subject;
      let tgtSubject = '';

      if (subRecord.type === 'exchange') {
        const peer = substitutionRecords.value.find(r => r.requestId === reqId && r.id !== subRecord.id);
        if (peer) {
          const isSub1 = String(subRecord.id).endsWith('_1');
          const isSub2 = String(subRecord.id).endsWith('_2');

          if (isSub2) {
            reqDate = subRecord.date;
            reqPeriod = subRecord.period;
            reqPeriodDay = subRecord.dayOfWeek;
            requesterEmail = subRecord.originalTeacherEmail;
            reqSubject = subRecord.subject;

            tgtDate = peer.date;
            tgtPeriod = peer.period;
            tgtDayOfWeek = peer.dayOfWeek;
            targetTeacherEmail = peer.originalTeacherEmail;
            tgtSubject = peer.subject;
          } else {
            reqDate = peer.date;
            reqPeriod = peer.period;
            reqPeriodDay = peer.dayOfWeek;
            requesterEmail = peer.originalTeacherEmail;
            reqSubject = peer.subject;

            tgtDate = subRecord.date;
            tgtPeriod = subRecord.period;
            tgtDayOfWeek = subRecord.dayOfWeek;
            targetTeacherEmail = subRecord.originalTeacherEmail;
            tgtSubject = subRecord.subject;
          }
        }
      }

      return {
        id: reqId || 'N/A',
        serial: subRecord.serial || '---',
        type: subRecord.type,
        requesterEmail,
        targetTeacherEmail,
        requesterName: getTeacherNameByEmail(requesterEmail),
        targetTeacherName: getTeacherNameByEmail(targetTeacherEmail),
        requestDate: reqDate,
        requestPeriod: reqPeriod,
        requestPeriodDay: reqPeriodDay,
        targetDate: tgtDate,
        targetPeriod: tgtPeriod,
        targetDayOfWeek: tgtDayOfWeek,
        className: subRecord.className,
        subject: reqSubject,
        targetSubject: tgtSubject,
        reason: subRecord.reason || '請假',
        subFee: subRecord.subFee || '自費代課',
        status: subRecord.status || 'approved',
        note: subRecord.note || ''
      };
    };

    const printSingleRequest = async (req, formType = 'Notice') => {
      let targetIds = [];
      if (substitutionRecords.value && substitutionRecords.value.length > 0) {
        targetIds = substitutionRecords.value
          .filter(r => String(r.requestId) === String(req.id))
          .map(r => r.id);
      }
      if (targetIds.length === 0 && detailSubRecord.value) {
        targetIds = [detailSubRecord.value.id];
      }
      if (targetIds.length === 0) {
        showToast("⚠️ 找不到該筆核准的代課明細，無法執行列印。", "error");
        return;
      }
      const prevSelected = [...selectedRecordIds.value];
      selectedRecordIds.value = targetIds;
      await printSelectedForms(formType);
      selectedRecordIds.value = prevSelected;
    };

    const showDetailForRecord = (recId, requestId) => {
      const subRec = substitutionRecords.value.find(r => r.id === recId);
      detailSubRecord.value = subRec || null;
      
      const resolved = resolveDetailRequest(requestId, subRec);
      if (resolved) {
        detailRequest.value = resolved;
      } else {
        showToast("⚠️ 找不到該筆異動詳情資料。", "error");
        return;
      }
      showDetailModal.value = true;
    };

    // LINE 邀請訊息（單節：語氣＋同意／拒絕連結）
    const buildLineInviteText = (opts) => {
      const name = opts.targetName || '老師';
      const dayA = getWeekDayText(opts.dayA);
      const leaveLine = `📅 異動課堂：${opts.dateA || ''} (${dayA})第 ${opts.periodA || ''} 節 ${opts.classA || ''} ${opts.subjectA || ''}`.replace(/\s+/g, ' ').trim();
      let text = `【調代課系統訊息】
${name} 老師您好！我剛剛發起了一筆調代課申請，再麻煩您有空幫我確認一下喔～非常感謝！

詳細如下：
${leaveLine}`;
      if (opts.isExchange) {
        const dayB = getWeekDayText(opts.dayB);
        const swapLine = `🔄 對調課堂：${opts.dateB || ''} (${dayB})第 ${opts.periodB || ''} 節 ${opts.classB || ''} ${opts.subjectB || ''}`.replace(/\s+/g, ' ').trim();
        text += `\n${swapLine}`;
      }
      if (opts.agreeLink) text += `\n\n👉 線上同意：${opts.agreeLink}`;
      if (opts.declineLink) text += `\n👉 線上拒絕：${opts.declineLink}`;
      if (opts.systemUrl) text += `\n📝 系統詳情：${opts.systemUrl}`;
      text += `\n\n祝順心！`;
      return text;
    };

    /**
     * 批次 LINE：一則訊息只含「該受邀人」的節次
     * 若該人只有 1 節 → 改用一般單節邀請格式（不出現批次用語）
     * opts: { targetName, requesterName, reason, subFee, systemUrl, batchId, slots: [{ id, date, day, period, className, subject }] }
     */
    const buildLineBatchInviteText = (opts) => {
      const name = opts.targetName || '老師';
      const slots = opts.slots || [];
      const n = slots.length;
      const currentUrl = opts.systemUrl || (window.location.origin + window.location.pathname);
      const batchId = opts.batchId || '';

      // 單節：與一般代課邀請相同語氣
      if (n === 1) {
        const s = slots[0];
        return buildLineInviteText({
          targetName: name,
          dateA: s.date,
          dayA: s.day,
          periodA: s.period,
          classA: s.className,
          subjectA: s.subject,
          agreeLink: `${currentUrl}?action=respond&id=${encodeURIComponent(s.id)}&status=agree`,
          declineLink: `${currentUrl}?action=respond&id=${encodeURIComponent(s.id)}&status=decline`,
          systemUrl: currentUrl,
          isExchange: false
        });
      }

      let text = `【調代課系統訊息 · 給 ${name} 老師】
${name} 老師您好！我剛剛發起了代課申請（共 ${n} 節請您代），再麻煩您有空確認一下喔～非常感謝！

請假教師：${opts.requesterName || ''}
假別事由：${opts.reason || '請假'}
經費來源：${opts.subFee || '自費代課'}
`;
      if (batchId) {
        text += `\n【一次處理您這 ${n} 節】`;
        text += `\n👉 全部同意：${currentUrl}?action=respondBatch&batchId=${encodeURIComponent(batchId)}&status=agree`;
        text += `\n👉 全部拒絕：${currentUrl}?action=respondBatch&batchId=${encodeURIComponent(batchId)}&status=decline`;
        text += `\n\n【或逐節確認】`;
      } else {
        text += `\n【節次確認】`;
      }
      slots.forEach((s, i) => {
        const dayT = getWeekDayText(s.day);
        const mmdd = formatDateMMDD(s.date) || s.date || '';
        const line = `${i + 1}. ${mmdd}（${dayT}）第${s.period || ''}節 ${s.className || ''} ${s.subject || ''}`.replace(/\s+/g, ' ').trim();
        const agree = `${currentUrl}?action=respond&id=${encodeURIComponent(s.id)}&status=agree`;
        const decline = `${currentUrl}?action=respond&id=${encodeURIComponent(s.id)}&status=decline`;
        text += `\n\n${line}\n👉 同意此節：${agree}\n👉 拒絕此節：${decline}`;
      });
      text += `\n\n📝 系統詳情：${currentUrl}`;
      text += `\n\n祝順心！`;
      return text;
    };

    const copyLineMessageForRequest = async (req) => {
      const serial = req.serial;
      const isExchange = req.type === 'exchange' || req.type === '對調';
      const currentUrl = window.location.origin + window.location.pathname;

      // 同批次多筆：只組「同一受邀人」的節次（不混入其他人）
      let lineText = '';
      if (req.batchId && !isExchange) {
        const targetEmail = String(req.targetTeacherEmail || '').toLowerCase();
        const peers = (requestsList.value || []).filter(r =>
          r.batchId && r.batchId === req.batchId &&
          (r.status === 'pending_teacher' || r.status === req.status) &&
          (!targetEmail || String(r.targetTeacherEmail || '').toLowerCase() === targetEmail)
        ).sort((a, b) => {
          if ((a.requestDate || '') !== (b.requestDate || '')) return String(a.requestDate || '').localeCompare(String(b.requestDate || ''));
          return (parseInt(a.requestPeriod) || 0) - (parseInt(b.requestPeriod) || 0);
        });
        const slots = (peers.length ? peers : [req]).map(r => ({
          id: r.id,
          date: r.requestDate,
          day: r.requestPeriodDay,
          period: r.requestPeriod,
          className: getOriginalRequestClass(r) || r.className || '',
          subject: getOriginalRequestSubject(r) || r.subject || ''
        }));
        lineText = buildLineBatchInviteText({
          targetName: req.targetTeacherName,
          requesterName: req.requesterName,
          reason: req.reason,
          subFee: req.subFee,
          systemUrl: currentUrl,
          batchId: req.batchId,
          slots
        });
      } else {
        const agreeLink = `${currentUrl}?action=respond&id=${req.id}&status=agree`;
        const declineLink = `${currentUrl}?action=respond&id=${req.id}&status=decline`;
        const leaveClass = getOriginalRequestClass(req) || req.className || '';
        const leaveSubject = getOriginalRequestSubject(req) || req.subject || '';
        let swapClass = '';
        let swapSubject = '';
        if (isExchange) {
          swapClass = getOriginalTargetClass(req) || '';
          swapSubject = getOriginalTargetSubject(req) || '';
        }
        lineText = buildLineInviteText({
          targetName: req.targetTeacherName,
          dateA: req.requestDate,
          dayA: req.requestPeriodDay,
          periodA: req.requestPeriod,
          classA: leaveClass,
          subjectA: leaveSubject,
          isExchange,
          dateB: req.targetDate,
          dayB: req.targetDayOfWeek,
          periodB: req.targetPeriod,
          classB: swapClass,
          subjectB: swapSubject,
          agreeLink,
          declineLink,
          systemUrl: currentUrl
        });
      }

      try {
        await navigator.clipboard.writeText(lineText);
        const tip = req.batchId ? `批次共 ${(lineText.match(/同意此節/g) || []).length || '多'} 節` : `單號【${serial}】`;
        showToast(`📋 ${tip} 的 LINE 邀請已複製，正開啟 LINE…`, 'success');
      } catch (err) {
        console.error("複製失敗：", err);
      }
      const url = `https://line.me/R/msg/text/?${encodeURIComponent(lineText)}`;
      window.open(url, '_blank');
    };
    const pendingRequestData = ref({
      mode: '', leaveTeacher: '', subTeacher: '', cls: '', subject: '', date: '', timeKey: '',
      reason: '', subFee: '', dateB: '', timeB: '', subB: '', note: ''
    });
    const selectedRecordIds = ref([]);
    const showDevDropdown = ref(false);
    // 防連點：送出申請期間鎖住按鈕（含 validate／confirm 等待）
    const isSubmitting = ref(false);

    // 異動詳情對話框 (已經生效或簽核中的調代課格子)
    const showDetailModal = ref(false);
    const consecAlertsA = ref([]);
    const consecAlertsB = ref([]);
    const detailRequest = ref(null);
    const detailSubRecord = ref(null);

    // 歷史紀錄篩選與分頁
    const historyFilterMode = ref('all');
    const historyFilterDate = ref(new Date().toISOString().split('T')[0]);
    const historySearchQuery = ref('');
    const historyPage = ref(1);
    const historyPageSize = ref(20);

    // ── 申請時間窗／歷史按月／待辦輕量對齊 ──
    const requestWindowInfo = ref(null);
    const historyFullLoaded = ref(false);
    const historyLoadingFull = ref(false);
    const historyLoadedMonths = ref([]); // 已合併的 YYYY-MM
    const historyMonthLoading = ref(false);

    /** 合併伺服器回傳的申請列（不丟既有、同 id 以伺服器為準） */
    // 申請水位線：增量 softRefresh 用（更新時間優先，其次建立時間）
    let _requestsWatermark = '';
    const requestRowStamp = (r) => {
      if (!r) return '';
      const u = String(r.updatedAt || '').trim();
      if (u) return u;
      return String(r.createdAt || '').trim();
    };
    const stampIsNewer = (a, b) => {
      // 字串 YYYY-MM-DD HH:mm:ss 可直接比；缺則舊
      const sa = String(a || '').trim();
      const sb = String(b || '').trim();
      if (!sa) return false;
      if (!sb) return true;
      return sa > sb;
    };
    const bumpRequestsWatermarkFromRows = (rows) => {
      let max = _requestsWatermark;
      (rows || []).forEach(r => {
        const s = requestRowStamp(r);
        if (stampIsNewer(s, max)) max = s;
      });
      if (stampIsNewer(max, _requestsWatermark)) _requestsWatermark = max;
      return _requestsWatermark;
    };
    const watermarkAgeMs = () => {
      const s = String(_requestsWatermark || '').trim();
      if (!s) return Infinity;
      const t = s.replace('T', ' ');
      const norm = t.includes('/') ? t : t.replace(/-/g, '/');
      const ms = Date.parse(norm);
      if (!Number.isFinite(ms)) return Infinity;
      return Date.now() - ms;
    };

    const mergeRequestsFromServer = (serverRows) => {
      if (!serverRows || !serverRows.length) return 0;
      const mapped = serverRows.map(r => window.FieldMap.mapRequest(r));
      const byId = {};
      (requestsList.value || []).forEach(r => { if (r && r.id) byId[r.id] = r; });
      mapped.forEach(r => {
        if (!r || !r.id) return;
        byId[r.id] = Object.assign({}, byId[r.id] || {}, r);
      });
      requestsList.value = sortRequestListDesc(Object.keys(byId).map(k => byId[k]));
      recomputeRequestBuckets();
      bumpRequestsWatermarkFromRows(mapped);
      return mapped.length;
    };

    /**
     * 輕量：只同步進行中申請（同意／核准後背景用）
     * 回傳：true | 'ghost'（有本地 pending 被暫標 cancelled）| false
     */
    const softSyncPendingOnly = async () => {
      if (!user.value || !fetchPendingOnly) return false;
      try {
        const res = await fetchPendingOnly({ semesterId: currentSemester.value });
        const rows = (res && res.requests) || [];
        const serverPendingById = {};
        const mappedPending = rows.map(r => {
          const m = window.FieldMap.mapRequest(r);
          if (m && m.id) serverPendingById[m.id] = m;
          return m;
        });
        const next = [];
        const seen = {};
        let ghosted = false;
        (requestsList.value || []).forEach(r => {
          if (!r || !r.id) return;
          const st = String(r.status || '').toLowerCase();
          if (st === 'pending_teacher' || st === 'pending_admin') {
            if (serverPendingById[r.id]) {
              // 伺服器仍進行中：合併
              next.push(Object.assign({}, r, serverPendingById[r.id]));
              seen[r.id] = 1;
            } else {
              // J：幽靈 pending（伺服器已無）→ 標 cancelled，清待辦紅點；後續 delta／全窗補真實狀態
              next.push(Object.assign({}, r, { status: 'cancelled' }));
              seen[r.id] = 1;
              ghosted = true;
            }
          } else {
            next.push(r);
            seen[r.id] = 1;
          }
        });
        mappedPending.forEach(m => {
          if (m && m.id && !seen[m.id]) {
            next.push(m);
            seen[m.id] = 1;
          }
        });
        requestsList.value = sortRequestListDesc(next);
        recomputeRequestBuckets();
        bumpRequestsWatermarkFromRows(mappedPending);
        return ghosted ? 'ghost' : true;
      } catch (e) {
        console.warn('pendingOnly 同步失敗：', e);
        return false;
      }
    };

    /**
     * 增量：只合併 updatedSince 之後變更的申請列
     * 回傳：true=有變更合併、'empty'=成功但 0 筆、false=失敗／跳過
     * 水位線過舊（>48h）或無水位 → false，改走全窗
     */
    const softSyncRequestsDelta = async () => {
      if (!user.value || !fetchRequestsDelta) return false;
      if (!_requestsWatermark) return false;
      // 過舊：增量可能漏幽靈結案，改全窗
      if (watermarkAgeMs() > 48 * 3600 * 1000) return false;
      try {
        const res = await fetchRequestsDelta({
          semesterId: currentSemester.value,
          updatedSince: _requestsWatermark
        });
        if (!res || res.success === false) return false;
        let n = 0;
        if (res.requests && res.requests.length) {
          n = mergeRequestsFromServer(res.requests);
          clearScheduleCache();
        }
        if (res.serverTime && stampIsNewer(res.serverTime, _requestsWatermark)) {
          _requestsWatermark = String(res.serverTime).trim();
        }
        return n > 0 ? true : 'empty';
      } catch (e) {
        console.warn('requestsDelta 同步失敗：', e);
        return false;
      }
    };

    /** 中量：只同步申請窗＋空堂（不含課表；核准後課表異動對齊） */
    const softSyncRequestsOnly = async () => {
      if (!user.value || !fetchInitialData) return false;
      try {
        const res = await fetchInitialData({
          semesterId: currentSemester.value,
          requestsOnly: true,
          force: false
        });
        if (!res || res.success === false) return false;
        // 合併申請（不整表覆寫，避免清掉已載入的月份歷史）
        if (res.requests) mergeRequestsFromServer(res.requests);
        if (res.classAwayEvents) {
          classAwayEvents.value = res.classAwayEvents.map(e => window.FieldMap.mapClassAwayEvent(e));
        }
        if (res.requestWindow) requestWindowInfo.value = res.requestWindow;
        if (res.serverTime && stampIsNewer(res.serverTime, _requestsWatermark)) {
          _requestsWatermark = String(res.serverTime).trim();
        }
        // soft 只更新 requests 分鍵；課表 structure 保留
        try {
          if (window.GasApi && window.GasApi.writeSWRPart) {
            window.GasApi.writeSWRPart(currentSemester.value, 'requests', {
              requests: res.requests,
              classAwayEvents: res.classAwayEvents,
              requestWindow: res.requestWindow,
              serverTime: res.serverTime || _requestsWatermark
            });
          }
        } catch (swrE) { /* ignore */ }
        clearScheduleCache();
        return true;
      } catch (e) {
        console.warn('requestsOnly 同步失敗：', e);
        return false;
      }
    };

    /** G：本地標記已列印（不整包重抓） */
    const markLocalPrinted = (ids) => {
      const idSet = new Set((ids || []).map(id => String(id)));
      const reqIds = new Set();
      idSet.forEach(id => {
        reqIds.add(String(id).replace(/_[12]$/, ''));
      });
      if (requestsList.value && requestsList.value.length) {
        requestsList.value = requestsList.value.map(r => {
          if (r && r.id && reqIds.has(String(r.id))) {
            return Object.assign({}, r, { printed: true });
          }
          return r;
        });
      }
      if (substitutionRecords.value && substitutionRecords.value.length) {
        substitutionRecords.value = substitutionRecords.value.map(rec => {
          if (!rec) return rec;
          const rid = String(rec.requestId || rec.id || '').replace(/_[12]$/, '');
          if (idSet.has(String(rec.id)) || reqIds.has(rid)) {
            return Object.assign({}, rec, { printed: true });
          }
          return rec;
        });
      }
    };

    /**
     * 載入指定月歷史
     * opts.silent：不開全螢幕 loading、不 toast 成功（自動觸發用）
     * opts.force：已載入過仍重抓
     */
    const loadHistoryMonth = async (monthStr, opts) => {
      opts = opts || {};
      if (!user.value) return;
      let ym = String(monthStr || '').slice(0, 7);
      if (!/^\d{4}-\d{2}$/.test(ym)) {
        const d = historyFilterDate.value || toLocalDateStr(new Date());
        ym = String(d).slice(0, 7);
      }
      const already = historyLoadedMonths.value.indexOf(ym) >= 0 || historyFullLoaded.value;
      if (already && !opts.force) {
        historyFilterMode.value = 'month';
        if (!String(historyFilterDate.value || '').startsWith(ym)) {
          historyFilterDate.value = ym + '-15';
        }
        historyPage.value = 1;
        return;
      }
      historyMonthLoading.value = true;
      if (!opts.silent) {
        loading.value = true;
        loadingMessage.value = '載入 ' + ym + ' 歷史中...';
      }
      try {
        if (!fetchHistoryMonth) throw new Error('請更新 gas-api 後重新整理（或先部署 code.gs）');
        const res = await fetchHistoryMonth({
          semesterId: currentSemester.value,
          month: ym
        });
        const n = mergeRequestsFromServer((res && res.requests) || []);
        if (historyLoadedMonths.value.indexOf(ym) < 0) {
          historyLoadedMonths.value = historyLoadedMonths.value.concat([ym]);
        }
        historyFilterMode.value = 'month';
        if (!String(historyFilterDate.value || '').startsWith(ym)) {
          historyFilterDate.value = ym + '-15';
        }
        historyPage.value = 1;
        if (!opts.silent) showToast('已合併 ' + ym + ' 共 ' + n + ' 筆', 'success');
      } catch (e) {
        console.error(e);
        if (!opts.silent) showToast('載入月份歷史失敗：' + (e.message || e), 'error');
      } finally {
        historyMonthLoading.value = false;
        if (!opts.silent) loading.value = false;
      }
    };

    /** 點「本月」或改日期：自動補抓該月（未載入過才打 API） */
    const ensureHistoryMonthLoaded = (ym) => {
      const m = String(ym || historyFilterDate.value || toLocalDateStr(new Date())).slice(0, 7);
      if (!/^\d{4}-\d{2}$/.test(m)) return;
      if (historyFullLoaded.value || historyLoadedMonths.value.indexOf(m) >= 0) return;
      if (historyMonthLoading.value) return;
      loadHistoryMonth(m, { silent: true });
    };

    const setHistoryFilterMode = (mode) => {
      historyFilterMode.value = mode;
      historyPage.value = 1;
      if (mode === 'month') {
        ensureHistoryMonthLoaded(String(historyFilterDate.value || '').slice(0, 7));
      }
    };

    watch(historyFilterDate, (d) => {
      if (historyFilterMode.value !== 'month') return;
      ensureHistoryMonthLoaded(String(d || '').slice(0, 7));
    });

    /** 完整學期（較慢，後備） */
    const loadFullSemesterHistory = async () => {
      if (!user.value) return;
      historyLoadingFull.value = true;
      loading.value = true;
      loadingMessage.value = '載入完整學期歷史中（可能較慢）...';
      try {
        const res = await fetchInitialData({
          semesterId: currentSemester.value,
          force: true,
          historyAll: true
        });
        applyInitialPayload(res);
        historyFullLoaded.value = true;
        showToast('已載入完整學期申請紀錄', 'success');
      } catch (e) {
        console.error(e);
        showToast('載入完整歷史失敗：' + (e.message || e), 'error');
      } finally {
        historyLoadingFull.value = false;
        loading.value = false;
      }
    };
    const reloadWindowedHistory = async () => {
      historyFullLoaded.value = false;
      historyLoadedMonths.value = [];
      await loadWeeklyData({ force: true, silent: false });
      showToast('已恢復近兩週資料視窗', 'info');
    };

    // 管理員編輯歷史紀錄（可改全部代／調課欄位）
    const showHistoryEditModal = ref(false);
    const historyEditForm = ref({
      id: '',
      requestId: '',
      type: 'substitution',
      requesterEmail: '',
      targetTeacherEmail: '',
      className: '',
      subject: '',
      requestDate: '',
      requestPeriodDay: 1,
      requestPeriod: 1,
      targetDate: '',
      targetDayOfWeek: 1,
      targetPeriod: 1,
      reason: '',
      subFee: '自費代課',
      note: '',
      printed: false
    });

    // 待辦分頁
    const pendingPage = { pending: ref(1), sent: ref(1), admin: ref(1) };
    const pendingPageSize = 10;

    // 基礎課表編輯模式
    const isScheduleEditMode = ref(false);
    // 月底報表統計
    const reportMonth = ref(new Date().toISOString().slice(0, 7)); // 格式: YYYY-MM
    const reportWeeksCount = ref(4); 
    const monthlyReportData = ref([]);

    // 行政直接審核生效開關
    const directApproveMode = ref(true);

    // 監聽請假日期或對調節次改變，自動推算對調課的具體日期（支援跨週對調）
    watch([inputRequestDate, exchangePeriodId, exchangeWeekOffset], () => {
      if (!inputRequestDate.value || !exchangePeriodId.value) {
        exchangeTargetDate.value = '';
        return;
      }
      try {
        const [targetDayStr] = exchangePeriodId.value.split('-');
        const targetDay = parseInt(targetDayStr);
        const [y, m, d] = inputRequestDate.value.split('-').map(Number);
        const reqDate = new Date(y, m - 1, d);
        const reqDay = reqDate.getDay(); 
        const currentDayOfWeek = reqDay === 0 ? 7 : reqDay;
        // 天數差 = (目標星期 - 請假星期) + (週數偏移 * 7)
        const diffDays = (targetDay - currentDayOfWeek) + (exchangeWeekOffset.value * 7);
        
        const targetDateObj = new Date(reqDate);
        targetDateObj.setDate(reqDate.getDate() + diffDays);
        
        const year = targetDateObj.getFullYear();
        const month = String(targetDateObj.getMonth() + 1).padStart(2, '0');
        const dateVal = String(targetDateObj.getDate()).padStart(2, '0');
        exchangeTargetDate.value = `${year}-${month}-${dateVal}`;
      } catch (err) {
        console.error("推算對調日期失敗：", err);
        exchangeTargetDate.value = '';
      }
    });

      // P2：月報只在後台「經費／鐘點」分頁時重算（避免全校異動就掃全表）
      watch(
        [substitutionRecords, teachersList, allSchedules, reportMonth, reportWeeksCount, adminSubTab, activeTab],
        () => {
          if (activeTab.value === 'admin' && adminSubTab.value === 'billing') {
            calculateMonthlyReport();
          }
        }
      );


    // ════════════════════════════════════════
    // §3 計算屬性（課表 / 待辦 / 歷史）
    // ════════════════════════════════════════
    // --- 計算屬性 ---

    // 週日曆
    const classList = computed(() => {
      if (window.DomainClassAway && window.DomainClassAway.scanClassNames) {
        return window.DomainClassAway.scanClassNames(allSchedules.value);
      }
      const set = new Set();
      allSchedules.value.forEach(s => {
        const c = String(s.className || '').trim();
        if (c && !/^0+$/.test(c)) set.add(c);
      });
      return [...set].sort((a, b) => a.localeCompare(b, 'zh-Hant', { numeric: true }));
    });

    // P2：只建「目前選取班」的格（全校班 map 太重）
    const classSchedules = computed(() => {
      const map = {};
      const cls = String(selectedClass.value || '').trim();
      if (!cls) return map;
      const weekDates = selectedClassWeekDates.value || [];
      allSchedules.value.forEach(s => {
        if (!s.className || String(s.className).trim() !== cls) return;
        if (s.attr === '抽離') return;
        const dateStr = weekDates[parseInt(s.dayOfWeek, 10) - 1];
        if (s.attr === '單週' && dateStr && !isSingleWeek(dateStr)) return;
        if (s.attr === '雙週' && dateStr && isSingleWeek(dateStr)) return;
        if (!map[cls]) map[cls] = {};
        const key = `${s.dayOfWeek}-${s.period}`;
        if (!map[cls][key]) map[cls][key] = [];
        map[cls][key].push(s);
      });
      return map;
    });

    const currentWeekDates = computed(() => {
      const dates = [];
      const current = new Date(selectedWeekDate.value);
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
    });

    const isAdmin = computed(() => userRole.value === 'admin');
    const isSimulating = computed(() => !!originalUser.value);

    const parseTeacherSubjects = (raw) => {
      if (window.DomainMatch && typeof window.DomainMatch.parseSubjects === 'function') {
        return window.DomainMatch.parseSubjects(raw);
      }
      return String(raw || '')
        .split(/[、,，/／|｜\s]+/)
        .map(s => s.trim())
        .filter(Boolean);
    };

    const userRoleText = computed(() => {
      const match = user.value ? lookupTeacher(user.value.email) : null;
      if (!match) return '教師';
      const domains = parseTeacherSubjects(match.subject);
      if (!domains.length) return '教師';
      return domains.length === 1 ? `${domains[0]}科教師` : `${domains.join('／')}教師`;
    });

    const subjectsList = computed(() => {
      const list = new Set();
      teachersList.value.forEach(t => {
        parseTeacherSubjects(t.subject).forEach(s => list.add(s));
      });
      return Array.from(list).sort((a, b) => a.localeCompare(b, 'zh-Hant'));
    });

    const filteredTeachers = computed(() => {
      if (!user.value) return [];
      const myEmail = String(user.value.email || '').toLowerCase();
      // 一般教師：只看自己
      if (!isAdmin.value) {
        return teachersList.value.filter(t => String(t.email || '').toLowerCase() === myEmail);
      }
      const query = searchQuery.value.trim().toLowerCase();
      const subj = selectedSubject.value;
      // 預設「我的課表」：只顯示自己（有搜尋姓名時改看全校比對）
      if (subj === 'mine' && !query) {
        const self = lookupTeacher(myEmail);
        return self ? [self] : teachersList.value.filter(t => String(t.email || '').toLowerCase() === myEmail);
      }
      // all＝全校；指定科目＝該領域；mine+搜尋＝用姓名在全校找
      let list = teachersList.value.slice();
      if (query || (subj && subj !== 'all' && subj !== 'mine')) {
        list = list.filter(t => {
          const nameVal = t.name || '';
          const matchesName = !query || nameVal.toLowerCase().includes(query);
          if (subj === 'all' || subj === 'mine') return matchesName;
          const domains = parseTeacherSubjects(t.subject);
          const matchesSubj = domains.includes(subj) || t.subject === subj;
          return matchesName && matchesSubj;
        });
      }
      // 自己置頂
      const me = [];
      const others = [];
      list.forEach(t => {
        if (String(t.email || '').toLowerCase() === myEmail) me.push(t);
        else others.push(t);
      });
      if (!me.length && (subj === 'all' || !query)) {
        const self = lookupTeacher(myEmail);
        if (self && (subj === 'all' || subj === 'mine')) me.push(self);
      }
      return me.concat(others);
    });

    // 媒合開啟時只釘「申請人自己」課表，不彈出對方課表
    const displayTimetableTeachers = computed(() => {
      const base = filteredTeachers.value.slice();
      if (!showMatchModal.value || !activeCell.value?.teacherEmail) return base;
      const key = String(activeCell.value.teacherEmail).toLowerCase();
      if (base.some(t => String(t.email || '').toLowerCase() === key)) return base;
      const found = lookupTeacher(key);
      if (found) base.push(found);
      return base;
    });

    // ── 第 1 階 A：全校課表教師分頁（避免一次畫 60+ 人）──
    const TT_PAGE_SIZE_DEFAULT = 10;
    const ttPageSize = ref(TT_PAGE_SIZE_DEFAULT);
    const ttPage = ref(1);
    const ttTotalPages = computed(() =>
      Math.max(1, Math.ceil((displayTimetableTeachers.value || []).length / (ttPageSize.value || TT_PAGE_SIZE_DEFAULT)))
    );
    const visibleTimetableTeachers = computed(() => {
      const list = displayTimetableTeachers.value || [];
      // 人數少於一頁：不分頁（一般教師／我的課表）
      if (list.length <= ttPageSize.value) return list;
      const size = ttPageSize.value || TT_PAGE_SIZE_DEFAULT;
      const page = Math.min(Math.max(1, ttPage.value), Math.max(1, Math.ceil(list.length / size)));
      const start = (page - 1) * size;
      return list.slice(start, start + size);
    });
    const ttNeedPager = computed(() => (displayTimetableTeachers.value || []).length > ttPageSize.value);
    watch([searchQuery, selectedSubject, () => (displayTimetableTeachers.value || []).length], () => {
      ttPage.value = 1;
    });
    watch(ttPageSize, () => { ttPage.value = 1; });
    watch(ttTotalPages, (max) => {
      if (ttPage.value > max) ttPage.value = max;
    });
    const changeTtPage = (n) => {
      ttPage.value = Math.max(1, Math.min(n, ttTotalPages.value));
    };

    const pendingCount = computed(() => {
      let count = myPendingRequests.value.length;
      if (isAdmin.value) count += adminPendingRequests.value.length;
      return count;
    });
    const myInviteCount = computed(() => myPendingRequests.value.length);
    const adminTodoCount = computed(() => isAdmin.value ? adminPendingRequests.value.length : 0);
    // 快速待辦：避免模板每次 filter
    const quickTodoSentOpen = computed(() =>
      (mySentRequests.value || []).filter(r =>
        r.status === 'pending_teacher' || r.status === 'pending_admin'
      )
    );
    const hasQuickTodo = computed(() =>
      (myPendingRequests.value || []).length > 0 || quickTodoSentOpen.value.length > 0
    );

    const allTeachersList = computed(() => {
      const excludeEmail = activeCell.value?.teacherEmail || user.value?.email;
      return teachersList.value.filter(t => t.email !== excludeEmail);
    });

    const teachersListDetails = computed(() => teachersList.value);

    // 專門用於調課的對調教師選單（過濾條件：必須與請假教師在同一個班級有授課）
    const exchangeTeachersList = computed(() => {
      if (!activeCell.value.classData) return [];
      const myClassName = activeCell.value.classData.className;
      const myTeacherEmail = activeCell.value.teacherEmail;
      
      const emailsInSameClass = new Set(
        allSchedules.value
          .filter(s => s.className === myClassName && s.teacherEmail !== myTeacherEmail)
          .map(s => s.teacherEmail)
      );
      return teachersList.value.filter(t => emailsInSameClass.has(t.email));
    });

    // 我的教師資料
    const myTeacherProfile = computed(() => {
      return user.value ? lookupTeacher(user.value.email) : null;
    });

    // 檢查調代課申請的欄位是否填妥
    const isRequestValid = computed(() => {
      if (!inputRequestDate.value) return false;
      if (matchMode.value === 'substitution') {
        return !!pendingRequestData.value.subTeacher;
      } else {
        return !!pendingRequestData.value.subTeacher && !!pendingRequestData.value.timeB && !!pendingRequestData.value.dateB;
      }
    });



    // 月底報表月份選項 — 只顯示有資料的月份
    const reportMonthOptions = computed(() => {
      const months = new Set();
      substitutionRecords.value.forEach(r => {
        if (r.date) months.add(r.date.slice(0, 7));
      });
      if (months.size === 0) {
        const d = new Date();
        months.add(d.toISOString().slice(0, 7));
      }
      return Array.from(months).sort().reverse();
    });

    watch(substitutionRecords, (records) => {
      if (records.length > 0) {
        const months = [...new Set(records.map(r => r.date ? r.date.slice(0, 7) : null).filter(Boolean))].sort();
        if (months.length > 0) {
          const latest = months[months.length - 1];
          if (!reportMonthOptions.value.includes(reportMonth.value)) {
            reportMonth.value = latest;
          }
        }
      }
    }, { immediate: true });

    // 所有歷史紀錄 (掛載虛擬屬性以供前端表格渲染)
    // P3：reqById／peerByRequestId 一次建表，避免 map 內 O(n) find
    const filteredHistoryRecords = computed(() => {
      const email = user.value ? user.value.email.toLowerCase() : '';
      let filteredRecords = substitutionRecords.value;
      
      // 非管理員教師，限制只能看到與自己相關的調代課紀錄 (自己請假或自己代課)
      if (!isAdmin.value && email) {
        filteredRecords = substitutionRecords.value.filter(r => 
          (r.originalTeacherEmail && r.originalTeacherEmail.toLowerCase() === email) ||
          (r.actualTeacherEmail && r.actualTeacherEmail.toLowerCase() === email)
        );
      }

      // 調課 (exchange) 去重：同一 requestId 只留一列
      // 優先保留「請假日」邊（id 以 _2 結尾，或 original＝申請人），避免 _1 目標日當主列造成班科顛倒
      const exchangeBest = {};
      const nonExchange = [];
      filteredRecords.forEach(rec => {
        if (!rec) return;
        if (rec.type !== 'exchange' && rec.type !== '對調') {
          nonExchange.push(rec);
          return;
        }
        const rid = rec.requestId || rec.id;
        if (!rid) return;
        const prev = exchangeBest[rid];
        if (!prev) {
          exchangeBest[rid] = rec;
          return;
        }
        // 偏好 _2（請假日邊）；否則保留已有
        if (String(rec.id || '').endsWith('_2')) exchangeBest[rid] = rec;
      });
      const dedupedRecords = nonExchange.concat(Object.keys(exchangeBest).map(k => exchangeBest[k]));

      const reqById = {};
      (requestsList.value || []).forEach(x => {
        if (x && x.id) reqById[x.id] = x;
      });
      const peerByRequestId = {};
      (substitutionRecords.value || []).forEach(x => {
        if (!x || !x.requestId || (x.type !== 'exchange' && x.type !== '對調')) return;
        if (!peerByRequestId[x.requestId]) peerByRequestId[x.requestId] = [];
        peerByRequestId[x.requestId].push(x);
      });

      const mapped = dedupedRecords.map(rec => {
        const matchedReq = reqById[rec.requestId];
        const createdAtFull = (matchedReq && matchedReq.createdAt) ? String(matchedReq.createdAt) : '';
        const createdDate = createdAtFull ? createdAtFull.slice(0, 10) : '---';

        let leaveDate = rec.date;
        let leavePeriod = rec.period;
        let leaveTeacher = rec.originalTeacherEmail;
        let subTeacher = rec.actualTeacherEmail;
        let leaveClassName = rec.className || '';
        let leaveSubject = rec.subject || '';
        let targetDate = '---';
        let targetPeriod = '';
        let targetClassName = '';
        let targetSubject = '';

        if (rec.type === 'exchange' || rec.type === '對調') {
          const peers = peerByRequestId[rec.requestId] || [];
          // leaveEdge：請假日（申請人調出）；targetEdge：目標日（受邀人調出）
          // convert 後：leaveEdge.className＝受邀人帶來的課；targetEdge.className＝申請人帶來的課
          let leaveEdge = peers.find(x => String(x.id || '').endsWith('_2')) || null;
          let targetEdge = peers.find(x => String(x.id || '').endsWith('_1')) || null;
          if (!leaveEdge || !targetEdge) {
            peers.forEach(x => {
              if (!x || x.id === (leaveEdge && leaveEdge.id) || x.id === (targetEdge && targetEdge.id)) return;
              if (!leaveEdge) leaveEdge = x;
              else if (!targetEdge) targetEdge = x;
            });
          }
          // 申請單為準（請假／對調人、日期節次）
          if (matchedReq) {
            leaveDate = matchedReq.requestDate || leaveDate;
            leavePeriod = matchedReq.requestPeriod != null ? matchedReq.requestPeriod : leavePeriod;
            leaveTeacher = matchedReq.requesterEmail || leaveTeacher;
            subTeacher = matchedReq.targetTeacherEmail || subTeacher;
            targetDate = matchedReq.targetDate || targetDate;
            targetPeriod = matchedReq.targetPeriod != null ? matchedReq.targetPeriod : targetPeriod;
            // 請假班科：申請單欄＝請假課堂；edge _1 存「申請人帶來的課」可備援
            leaveClassName = matchedReq.className
              || (targetEdge && targetEdge.className)
              || leaveClassName;
            leaveSubject = matchedReq.subject
              || (targetEdge && targetEdge.subject)
              || leaveSubject;
            // 對調班科：受邀人原課＝edge _2 上寫的「帶來的課」；勿用申請單 className
            targetClassName = (leaveEdge && leaveEdge.className)
              || matchedReq.targetClassName
              || '';
            targetSubject = (leaveEdge && leaveEdge.subject)
              || matchedReq.targetSubject
              || '';
          } else {
            // 無申請單：用兩邊 edge
            if (leaveEdge) {
              leaveDate = leaveEdge.date;
              leavePeriod = leaveEdge.period;
              leaveTeacher = leaveEdge.originalTeacherEmail;
              subTeacher = leaveEdge.actualTeacherEmail;
            }
            if (targetEdge) {
              targetDate = targetEdge.date;
              targetPeriod = targetEdge.period;
              leaveClassName = targetEdge.className || leaveClassName;
              leaveSubject = targetEdge.subject || leaveSubject;
            }
            if (leaveEdge) {
              targetClassName = leaveEdge.className || '';
              targetSubject = leaveEdge.subject || '';
            }
          }
        }

        return {
          ...rec,
          // 歷史列統一：original＝請假師、actual＝代課／對調師
          originalTeacherEmail: leaveTeacher || rec.originalTeacherEmail,
          actualTeacherEmail: subTeacher || rec.actualTeacherEmail,
          className: leaveClassName || rec.className,
          subject: leaveSubject || rec.subject,
          serial: matchedReq ? (matchedReq.serial || '---') : '---',
          batchId: (matchedReq && matchedReq.batchId) || rec.batchId || '',
          note: (matchedReq && matchedReq.note) || rec.note || '',
          directApprove: !!(matchedReq && matchedReq.directApprove),
          requesterName: getTeacherNameByEmail(leaveTeacher || rec.originalTeacherEmail),
          targetTeacherName: getTeacherNameByEmail(subTeacher || rec.actualTeacherEmail),
          requestDate: leaveDate,
          requestPeriod: leavePeriod,
          createdAt: createdAtFull,
          createdDate,
          targetDate,
          targetPeriod,
          targetClassName,
          targetSubject
        };
      });
      return sortRequestListDesc(mapped);
    });

    // 歷史紀錄按週/月篩選
    const getWeekStart = (dateStr) => {
      const d = new Date(dateStr.replace(/-/g, '/'));
      const dow = d.getDay();
      const monday = new Date(d);
      monday.setDate(d.getDate() - (dow === 0 ? 6 : dow - 1));
      return monday.toISOString().slice(0, 10);
    };
    const getMonthStart = (dateStr) => dateStr.slice(0, 7);

    const dateFilteredHistoryRecords = computed(() => {
      let records = filteredHistoryRecords.value;

      // 搜尋（單號或教師姓名）
      const q = (historySearchQuery.value || '').trim().toLowerCase();
      if (q) {
        records = records.filter(r =>
          (r.serial && r.serial.toLowerCase().includes(q)) ||
          (r.requesterName && r.requesterName.toLowerCase().includes(q)) ||
          (r.targetTeacherName && r.targetTeacherName.toLowerCase().includes(q))
        );
      }

      if (historyFilterMode.value === 'all' || !historyFilterDate.value) return records;

      return records.filter(r => {
        if (historyFilterMode.value === 'week') {
          return getWeekStart(r.date) === getWeekStart(historyFilterDate.value);
        }
        if (historyFilterMode.value === 'month') {
          return getMonthStart(r.date) === getMonthStart(historyFilterDate.value);
        }
        return true;
      });
    });

    const historyTotalPages = computed(() => Math.max(1, Math.ceil(dateFilteredHistoryRecords.value.length / historyPageSize.value)));

    const paginatedHistoryRecords = computed(() => {
      const start = (historyPage.value - 1) * historyPageSize.value;
      return dateFilteredHistoryRecords.value.slice(start, start + historyPageSize.value);
    });

    // 待辦分頁
    const pendingMyPendingPage = ref(1);
    const pendingMySentPage = ref(1);
    const pendingAdminPage = ref(1);

    const paginatedMyPending = computed(() => { const s = (pendingMyPendingPage.value - 1) * pendingPageSize; return myPendingRequests.value.slice(s, s + pendingPageSize); });
    const paginatedMySent = computed(() => { const s = (pendingMySentPage.value - 1) * pendingPageSize; return mySentRequests.value.slice(s, s + pendingPageSize); });
    const paginatedAdminPending = computed(() => { const s = (pendingAdminPage.value - 1) * pendingPageSize; return adminPendingRequests.value.slice(s, s + pendingPageSize); });

    const pendingMyPendingTotal = computed(() => Math.max(1, Math.ceil(myPendingRequests.value.length / pendingPageSize)));
    const pendingMySentTotal = computed(() => Math.max(1, Math.ceil(mySentRequests.value.length / pendingPageSize)));
    const pendingAdminTotal = computed(() => Math.max(1, Math.ceil(adminPendingRequests.value.length / pendingPageSize)));

    // 調課推薦（domain-match）
    const recommendedExchangeList = computed(() => {
      if (matchMode.value !== 'exchange' || !activeCell.value.dayOfWeek || !inputRequestDate.value) return [];
      return window.DomainMatch.listExchangeCandidates({
        allSchedules: allSchedules.value,
        className: activeCell.value.classData ? activeCell.value.classData.className : '',
        leaveEmail: activeCell.value.teacherEmail,
        leaveDate: inputRequestDate.value,
        leavePeriod: activeCell.value.period,
        leaveDay: activeCell.value.dayOfWeek,
        weekDates: currentWeekDates.value,
        getScheduleForDate,
        getTeacherNameByEmail,
        // 調課：外出班／空堂事件釋出視同空堂（不特別優先排序）
        awayClasses: isMutualCover.value ? mutualAwayClasses.value : []
      });
    });

    // 第8節代課：經費鎖定「第8節代課」（計畫經費），不可改公費／自費／互代
    const resolvePendingPeriods = () => {
      const p = pendingRequestData.value || {};
      if (p.isBatch && batchSlots.value && batchSlots.value.length) {
        return batchSlots.value.map(s => parseInt(s.period, 10)).filter(n => !isNaN(n));
      }
      if (p.isBatch && p.batchSlots && p.batchSlots.length) {
        return p.batchSlots.map(s => parseInt(s.period, 10)).filter(n => !isNaN(n));
      }
      if (p.timeKey) {
        const n = parseInt(String(p.timeKey).slice(-1), 10);
        if (!isNaN(n)) return [n];
      }
      if (activeCell.value && activeCell.value.period != null) {
        return [parseInt(activeCell.value.period, 10)];
      }
      return [];
    };
    const isPeriod8FeeLocked = computed(() => {
      if (pendingRequestData.value.mode !== 'substitution') return false;
      const periods = resolvePendingPeriods();
      if (!periods.length) return false;
      // 單節第8、或批次全是第8 → 鎖定；混批不鎖 UI（送出時仍逐節強制第8）
      return periods.every(n => n === 8);
    });
    // 舊名相容（曾誤鎖為自費）
    const isSubFeeLockedToSelf = isPeriod8FeeLocked;

    /** 扣額度預覽：目前額度／本次扣幾／扣後剩幾（依代課老師） */
    const quotaDeductPreview = computed(() => {
      if (pendingRequestData.value.mode !== 'substitution') return null;
      if (pendingRequestData.value.subFee !== QUOTA_DEDUCT_FEE) return null;
      if (isPeriod8FeeLocked.value) return null;
      const counts = {};
      const p = pendingRequestData.value;
      if (p.isPerSlot && p.batchSlots && p.batchSlots.length) {
        p.batchSlots.forEach(s => {
          const em = String(s.subTeacherEmail || '').toLowerCase();
          if (!em) return;
          counts[em] = (counts[em] || 0) + 1;
        });
      } else if (p.isBatch && batchSlots.value && batchSlots.value.length) {
        const em = String(p.subTeacher || '').toLowerCase();
        if (em) counts[em] = batchSlots.value.length;
      } else {
        const em = String(p.subTeacher || '').toLowerCase();
        if (em) counts[em] = 1;
      }
      const lines = Object.keys(counts).map(em => {
        const t = lookupTeacher(em);
        const name = (t && t.name) || getTeacherNameByEmail(em) || em;
        const before = t ? (parseInt(t.mutualQuota, 10) || 0) : 0;
        const deduct = counts[em];
        const short = before < deduct;
        const after = short ? before : (before - deduct);
        return { email: em, name, before, deduct, after: Math.max(0, after), short };
      });
      return lines.length ? lines : null;
    });
    const quotaDeductInsufficient = computed(() =>
      !!(quotaDeductPreview.value && quotaDeductPreview.value.some(q => q.short))
    );
    /** 額度不足時改為自費排代 */
    const switchQuotaDeductToSelfPay = () => {
      if (pendingRequestData.value.mode !== 'substitution') return;
      if (isPeriod8FeeLocked.value) {
        showToast('第8節須使用計畫經費，無法改自費', 'warning');
        return;
      }
      pendingRequestData.value.subFee = '自費代課';
      batchSubFee.value = '自費代課';
      showToast('已改為自費代課，請再確認後送出', 'info');
    };
    /** 選「扣額度」且額度不足 → 擋送出 */
    const assertQuotaDeductAllowed = () => {
      if (pendingRequestData.value.mode !== 'substitution') return true;
      if (pendingRequestData.value.subFee !== QUOTA_DEDUCT_FEE) return true;
      if (isPeriod8FeeLocked.value) return true;
      const lines = quotaDeductPreview.value;
      if (!lines || !lines.length) {
        showToast('找不到代課老師的互代額度，請改用自費代課或其他經費', 'warning');
        return false;
      }
      const shorts = lines.filter(q => q.short);
      if (!shorts.length) return true;
      const tip = shorts.map(q => `${q.name}（現有 ${q.before}，需扣 ${q.deduct}）`).join('、');
      showToast(`額度不足，不可用「扣額度」：${tip}。請改自費排代，或另選有額度的老師。`, 'warning');
      return false;
    };

    // 個人調代課摘要 (未來排前，過去排後且淡化)
    const personalChanges = computed(() => {
      if (!user.value) return [];
      const email = user.value.email.toLowerCase();
      const todayStr = getTodayString();
      const records = substitutionRecords.value.filter(r => 
        (r.originalTeacherEmail && r.originalTeacherEmail.toLowerCase() === email) || 
        (r.actualTeacherEmail && r.actualTeacherEmail.toLowerCase() === email)
      );

      // 調課去重：優先保留自己去上課（actualTeacherEmail 是自己）的那一筆
      const deduped = [];
      const seenExchange = new Set();
      
      records.forEach(r => {
        if (r.type === 'exchange') {
          if (r.actualTeacherEmail && r.actualTeacherEmail.toLowerCase() === email) {
            deduped.push(r);
            seenExchange.add(r.requestId);
          }
        } else {
          deduped.push(r);
        }
      });
      
      records.forEach(r => {
        if (r.type === 'exchange' && !seenExchange.has(r.requestId)) {
          deduped.push(r);
          seenExchange.add(r.requestId);
        }
      });

      const fmtClassLine = (dateStr, period, className, subject) => {
        const mmdd = formatDateMMDD(dateStr);
        const dow = new Date(dateStr.replace(/-/g, '/')).getDay();
        const day = getWeekDayText(dow);
        return `${mmdd}(${day})第${period}節 上 ${className}${subject}`;
      };

      const fmtPeerSlot = (dateStr, period) => {
        const mmdd = formatDateMMDD(dateStr);
        const dow = new Date(dateStr.replace(/-/g, '/')).getDay();
        const day = getWeekDayText(dow);
        return `${mmdd}(${day})`;
      };

      const list = deduped.map(r => {
        const isPast = r.date < todayStr;
        const isRequester = r.originalTeacherEmail && r.originalTeacherEmail.toLowerCase() === email;
        const isSwap = r.type === 'exchange';

        let classLine = '';
        let desc = '';

        if (isSwap) {
          const peer = substitutionRecords.value.find(x => x.requestId === r.requestId && x.id !== r.id);
          classLine = fmtClassLine(r.date, r.period, r.className, r.subject);
          if (peer) {
            const peerTeacherName = getTeacherNameByEmail(peer.actualTeacherEmail);
            const peerSlot = fmtPeerSlot(peer.date, peer.period);
            desc = `🔄 原${peerSlot}第${peer.period}節 由 ${peerTeacherName}老師上課（${peer.subject}）`;
          } else {
            const otherEmail = r.actualTeacherEmail && r.actualTeacherEmail.toLowerCase() === email ? r.originalTeacherEmail : r.actualTeacherEmail;
            const otherName = getTeacherNameByEmail(otherEmail);
            desc = `🔄 與 ${otherName} 老師調課`;
          }
        } else {
          classLine = fmtClassLine(r.date, r.period, r.className, r.subject);
          desc = isRequester
            ? `🏖️ 請假，由 ${getTeacherNameByEmail(r.actualTeacherEmail)} 老師代課`
            : `📝 代課：協助 ${getTeacherNameByEmail(r.originalTeacherEmail)} 老師`;
        }

        let statusClass = 'tag-gray';
        let statusText = '已出單';
        if (r.status === 'pending_teacher') { statusClass = 'tag-red'; statusText = '確認中'; }

        return {
          id: r.id,
          requestId: r.requestId,
          date: r.date,
          dayOfWeek: new Date(r.date.replace(/-/g, '/')).getDay(),
          period: r.period,
          classLine,
          desc,
          serial: r.serial || 'SUB',
          isPast,
          statusClass,
          statusText
        };
      });

      // 排序：未來的升序，過去的降序
      const future = list.filter(x => !x.isPast).sort((a,b) => a.date.localeCompare(b.date) || a.period - b.period);
      const past = list.filter(x => x.isPast).sort((a,b) => b.date.localeCompare(a.date) || b.period - a.period);
      return [...future, ...past].slice(0, 10);
    });

    // --- 方法與業務邏輯 ---

    // 智慧代課媒合（ui-timetable.js）
    const scheduleScope = ref('full'); // full | teacher_self_and_class
    const fetchRecommendations = () => {
      const a = getTimetableApi();
      if (!a) return;
      a.fetchRecommendations({
        matchMode, inputRequestDate, activeCell, teachersList, getTeacherSubjectByEmail,
        activityBalanceCtx, recommendationLoading, matchSearchQuery, matchDisplayCount,
        matchShowNoTeacherWarning, recommendedTeachers,
        scheduleScope,
        fetchMatchCandidates: typeof fetchMatchCandidates === 'function' ? fetchMatchCandidates : null
      });
    };

    // H：媒合列表分頁上限（無搜尋最多 30；有搜尋最多 50）
    const MATCH_PAGE_SIZE = 10;
    const MATCH_MAX_NO_SEARCH = 30;
    const MATCH_MAX_WITH_SEARCH = 50;
    const matchListCap = computed(() =>
      matchSearchQuery.value.trim() ? MATCH_MAX_WITH_SEARCH : MATCH_MAX_NO_SEARCH
    );
    const loadMoreMatches = () => {
      const cap = matchListCap.value;
      const total = filteredRecommendedTeachers.value.length;
      const next = Math.min(matchDisplayCount.value + MATCH_PAGE_SIZE, cap, total);
      if (next === matchDisplayCount.value && matchDisplayCount.value >= cap && total > cap) {
        showToast('請用上方搜尋姓名／科目，以縮小名單', 'info');
        return;
      }
      matchDisplayCount.value = next;
    };

    const filteredRecommendedTeachers = computed(() => {
      const q = matchSearchQuery.value.trim().toLowerCase();
      let list = (recommendedTeachers.value || []).slice();
      if (q) {
        list = list.filter(t => t.name.toLowerCase().includes(q) || (t.subject || '').toLowerCase().includes(q));
      }
      // 活動互代：額度多／有釋出優先（搜尋後仍維持）
      if (isMutualCover.value) {
        list.sort((a, b) => {
          const qa = typeof a.remainingReleased === 'number' ? a.remainingReleased : (a.mutualQuota || 0);
          const qb = typeof b.remainingReleased === 'number' ? b.remainingReleased : (b.mutualQuota || 0);
          if (qb !== qa) return qb - qa;
          const ra = a.isReleasedByAway ? 1 : 0;
          const rb = b.isReleasedByAway ? 1 : 0;
          if (rb !== ra) return rb - ra;
          return (b.score || 0) - (a.score || 0) || (a.todayPeriodCount || 0) - (b.todayPeriodCount || 0);
        });
      }
      return list;
    });

    const displayedRecommendedTeachers = computed(() => {
      const cap = Math.min(matchDisplayCount.value, matchListCap.value);
      return filteredRecommendedTeachers.value.slice(0, cap);
    });

    // 調課媒合同樣分頁
    const displayedExchangeList = computed(() => {
      const list = recommendedExchangeList.value || [];
      const cap = Math.min(matchDisplayCount.value, matchListCap.value);
      return list.slice(0, cap);
    });
    watch(matchSearchQuery, () => {
      matchDisplayCount.value = MATCH_PAGE_SIZE;
    });

    // 準備模擬對比 Modal（ui-request.js → UiSubmitHelpers.prepCompare）
    const prepCompare = async (mode, targetEmail, periodIdVal = '', subjectVal = '', classVal = '') => {
      if (!window.UiSubmitHelpers || !window.UiSubmitHelpers.prepCompare) {
        showToast('申請模組未載入', 'error');
        return;
      }
      return window.UiSubmitHelpers.prepCompare({
        activeCell, inputRequestDate, allSchedules, showConfirm, getScheduleForDate,
        formatDateMMDD, getWeekDayText, exchangePeriodId, exchangeWeekOffset, exchangeTargetDate,
        consecAlertsA, consecAlertsB, isMutualCover, assignMutualDraftFromMatch, PERIOD8_FEE,
        pendingRequestData, showMatchModal, showCompareModal
      }, mode, targetEmail, periodIdVal, subjectVal, classVal);
    };

    // 批次：該日該節是否在選定清單
    const isBatchSlotAt = (dateStr, day, period) => {
      if (!pendingRequestData.value.isBatch || !batchSlots.value.length) return false;
      return batchSlots.value.some(s =>
        s.dateStr === dateStr &&
        parseInt(s.dayOfWeek) === parseInt(day) &&
        parseInt(s.period) === parseInt(period)
      );
    };

    // 每節不同人：模擬對照右側目前檢視的受邀人
    const batchCompareViewEmail = ref('');

    const batchCompareSubGroups = computed(() => {
      if (!pendingRequestData.value.isBatch) return [];
      return groupBatchSlotsBySub(batchSlots.value);
    });

    const resolveCompareBEmail = () => {
      if (pendingRequestData.value.isBatch && (pendingRequestData.value.isPerSlot || batchAssignMode.value === 'perSlot')) {
        return batchCompareViewEmail.value
          || (batchCompareSubGroups.value[0] && batchCompareSubGroups.value[0].subEmail)
          || '';
      }
      return pendingRequestData.value.subTeacher || '';
    };

    /** B 欄：此格是否為「目前檢視受邀人」要代入的批次節次（須日期＋節次＋受邀人全符合） */
    const getBatchSlotForCompareB = (dateStr, day, period) => {
      if (!pendingRequestData.value.isBatch || !dateStr) return null;
      const bEmail = resolveCompareBEmail();
      if (!bEmail) return null;
      const d = parseInt(day, 10);
      const p = parseInt(period, 10);
      const em = String(bEmail).toLowerCase();
      return batchSlots.value.find(s =>
        String(s.dateStr || '') === String(dateStr || '') &&
        parseInt(s.dayOfWeek, 10) === d &&
        parseInt(s.period, 10) === p &&
        String(s.subTeacherEmail || '').toLowerCase() === em
      ) || null;
    };

    // 活動模式：外出班釋出不視為衝堂；巡堂可當空堂
    const isSlotConflict = (cell) => {
      if (window.DomainSchedule && window.DomainSchedule.isPatrolCell && window.DomainSchedule.isPatrolCell(cell)) {
        return false;
      }
      if (DAC() && isMutualCover.value) {
        return DAC().isConflictCell(cell, true, mutualAwayClasses.value);
      }
      return !!(cell && !cell.isSubstituted);
    };

    /** 代課／調入落在對方「巡堂」節：提醒但不擋（私下代巡） */
    const confirmIfTargetPatrol = async (targetEmail, dateStr, period, dayOfWeek) => {
      if (!targetEmail || !dateStr || period == null) return true;
      const cell = getScheduleForDate(targetEmail, dateStr, period, dayOfWeek);
      if (!(window.DomainSchedule && window.DomainSchedule.isPatrolCell && window.DomainSchedule.isPatrolCell(cell))) {
        return true;
      }
      const name = getTeacherNameByEmail(targetEmail) || '該教師';
      const tip = (window.DomainSchedule && window.DomainSchedule.PATROL_INCOMING_TIP)
        || '對方本節為【巡堂】。排入後請私下協調代巡堂或互換。';
      return !!(await showConfirm(
        name + ' 老師 ' + String(dateStr).slice(5) + ' 第' + period + '節：\n\n' + tip + '\n\n仍要繼續？',
        '巡堂提醒'
      ));
    };

    // 模擬對比 Grid（ui-request.js → UiSubmitHelpers）
    const getCompareCellText = (who, day, period) => {
      if (!window.UiSubmitHelpers || !window.UiSubmitHelpers.getCompareCellText) return '';
      return window.UiSubmitHelpers.getCompareCellText({
        pendingRequestData, currentWeekDates, getScheduleForDate, isClassAwayOnDate,
        resolveCompareBEmail, isBatchSlotAt, getBatchSlotForCompareB
      }, who, day, period);
    };
    const getCompareCellClass = (who, day, period) => {
      if (!window.UiSubmitHelpers || !window.UiSubmitHelpers.getCompareCellClass) return '';
      return window.UiSubmitHelpers.getCompareCellClass({
        pendingRequestData, currentWeekDates, getScheduleForDate, isClassAwayOnDate,
        resolveCompareBEmail, isBatchSlotAt, getBatchSlotForCompareB, isSlotConflict
      }, who, day, period);
    };

    // 輔助：檢查 B 師是否與請假節次衝堂（含批次全節／每節不同人）
    const hasSubTeacherConflict = computed(() => {
      if (pendingRequestData.value.mode !== 'substitution') return false;
      if (pendingRequestData.value.isBatch && batchSlots.value.length) {
        if (pendingRequestData.value.isPerSlot || batchAssignMode.value === 'perSlot') {
          return batchSlots.value.some(s => {
            if (!s.subTeacherEmail) return false;
            const cell = getScheduleForDate(s.subTeacherEmail, s.dateStr, s.period, s.dayOfWeek);
            return isSlotConflict(cell);
          });
        }
        const subEmail = pendingRequestData.value.subTeacher;
        if (!subEmail) return false;
        return batchSlots.value.some(s => {
          const cell = getScheduleForDate(subEmail, s.dateStr, s.period, s.dayOfWeek);
          return isSlotConflict(cell);
        });
      }
      const subEmail = pendingRequestData.value.subTeacher;
      if (!subEmail) return false;
      const timeKey = pendingRequestData.value.timeKey;
      const dateStr = pendingRequestData.value.date;
      if (!timeKey || !dateStr) return false;
      const day = parseInt(timeKey.slice(0, -1));
      const period = parseInt(timeKey.slice(-1));
      const cell = getScheduleForDate(subEmail, dateStr, period, day);
      return isSlotConflict(cell);
    });

    // ── 子函數①②：表單驗證／組裝 payload（ui-request.js → UiSubmitHelpers）──
    const validateSubmitRequest = async () => {
      if (!window.UiSubmitHelpers) {
        showToast('送出模組未載入', 'error');
        return false;
      }
      return window.UiSubmitHelpers.validateSubmitRequest({
        pendingRequestData, showToast, showConfirm, isAdmin, getTeacherNameByEmail,
        hasSubTeacherConflict, assertQuotaDeductAllowed
      });
    };

    const buildSubmitPayload = (requestId, serial) => {
      if (!window.UiSubmitHelpers) {
        throw new Error('UiSubmitHelpers 未載入');
      }
      return window.UiSubmitHelpers.buildSubmitPayload({
        pendingRequestData, currentSemester, getTeacherNameByEmail, isAdmin, directApproveMode,
        isMutualCover, PERIOD8_FEE, ACTIVITY_PUBLIC_FEE, defaultSubFeeForReason, activeCell, DAC
      }, requestId, serial);
    };


    // ════════════════════════════════════════
    // §4 提交申請 / 課表渲染 / 簽核
    // ════════════════════════════════════════
    // ── 批次選節／媒合（ui-activity.js → UiBatchPanel）──
    const {
      batchSlotKey, isBatchSlotSelected, clearBatchSlots,
      isBatchMatchFlow, isBatchPerSlotMode, batchAssignedCount, batchAllSlotsAssigned, batchActiveSlot,
      groupBatchSlotsBySub, setBatchAssignMode, toggleBatchSelectMode, toggleBatchSlot,
      fetchSingleSlotRecommendations, fetchBatchRecommendations, selectBatchSlotForMatch,
      openBatchMatch, prepBatchCompare, assignBatchSlotSub, clearBatchSlotSub,
      prepBatchPerSlotCompare, setBatchCompareViewEmail, executeBatchSubmit
    } = window.UiBatchPanel.create({
      computed: computed,
      showToast: showToast,
      showConfirm: showConfirm,
      // 下列函式定義在後方：一律用 wrapper，避免 const TDZ
      getTeacherNameByEmail: function (em) { return getTeacherNameByEmail(em); },
      getTeacherSubjectByEmail: function (em) { return getTeacherSubjectByEmail(em); },
      getScheduleForDate: function (a, b, c, d) { return getScheduleForDate(a, b, c, d); },
      formatDateMMDD: function (d) { return formatDateMMDD(d); },
      getTimetableApi: function () { return getTimetableApi(); },
      defaultSubFeeForReason: function (r) { return defaultSubFeeForReason(r); },
      softRefreshInBackground: function (opts) { return softRefreshInBackground(opts || {}); },
      optimisticUpsertRequest: function (r) { return optimisticUpsertRequest(r); },
      sheetRequestToFront: function (r) { return sheetRequestToFront(r); },
      isAdmin: isAdmin,
      isMutualCover: isMutualCover,
      DAC: DAC,
      mutualAwayClasses: mutualAwayClasses,
      batchSlots: batchSlots,
      batchSelectMode: batchSelectMode,
      batchAssignMode: batchAssignMode,
      batchActiveSlotKey: batchActiveSlotKey,
      batchSubTeacher: batchSubTeacher,
      batchReason: batchReason,
      batchSubFee: batchSubFee,
      batchNote: batchNote,
      batchCompareViewEmail: batchCompareViewEmail,
      showBatchConfirmModal: showBatchConfirmModal,
      showMatchModal: showMatchModal,
      showCompareModal: showCompareModal,
      activeCell: activeCell,
      inputRequestDate: inputRequestDate,
      matchMode: matchMode,
      matchPreview: matchPreview,
      pendingRequestData: pendingRequestData,
      recommendedTeachers: recommendedTeachers,
      recommendationLoading: recommendationLoading,
      matchSearchQuery: matchSearchQuery,
      matchDisplayCount: matchDisplayCount,
      matchShowNoTeacherWarning: matchShowNoTeacherWarning,
      consecAlertsA: consecAlertsA,
      consecAlertsB: consecAlertsB,
      directApproveMode: directApproveMode,
      teachersList: teachersList,
      activityBalanceCtx: activityBalanceCtx,
      QUOTA_DEDUCT_FEE: QUOTA_DEDUCT_FEE,
      ACTIVITY_PUBLIC_FEE: ACTIVITY_PUBLIC_FEE,
      PERIOD8_FEE: PERIOD8_FEE,
      isSlotConflict: isSlotConflict,
      mutualSkipNotify: mutualSkipNotify,
      isQuotaDeductFee: isQuotaDeductFee,
      assertQuotaDeductAllowed: assertQuotaDeductAllowed,
      loading: loading,
      loadingMessage: loadingMessage,
      isSubmitting: isSubmitting,
      currentSemester: currentSemester,
      directApproveSkipNotify: directApproveSkipNotify,
      callGasApi: callGasApi,
      deductMutualQuotaForRows: deductMutualQuotaForRows,
      successModalTitle: successModalTitle,
      successModalMessage: successModalMessage,
      hasLineTemplate: hasLineTemplate,
      lineBatchParts: lineBatchParts,
      lineCopyText: lineCopyText,
      showSuccessModal: showSuccessModal,
      buildLineBatchInviteText: buildLineBatchInviteText
    });

    // ── 主函數③：執行提交（ui-request.js）──
    const executeSubmitRequest = async () => {
      if (isSubmitting.value || loading.value) {
        showToast('申請送出中，請稍候…', 'info');
        return;
      }
      if (!window.UiSubmitHelpers || !window.UiSubmitHelpers.executeSubmitRequest) {
        showToast('申請模組未載入', 'error');
        return;
      }
      return window.UiSubmitHelpers.executeSubmitRequest({
        validateSubmitRequest, buildSubmitPayload, loading, loadingMessage, isSubmitting, pendingRequestData,
        isMutualCover, mutualSkipNotify, isAdmin, directApproveMode, directApproveSkipNotify,
        callGasApi, showCompareModal, showMatchModal, optimisticUpsertRequest, sheetRequestToFront,
        deductMutualQuotaForRows, softRefreshInBackground, isQuotaDeductFee, buildLineInviteText,
        successModalTitle, successModalMessage, lineCopyText, hasLineTemplate, showSuccessModal, showToast
      });
    };

    // 調代課 lookup（domain-schedule）
    const substitutionsLookup = computed(() =>
      window.DomainSchedule.buildSubstitutionsLookup(substitutionRecords.value)
    );

    // ── 課表存取層（ui-timetable.js）──
    // 延後建立：isBatchSlotSelected / getMutualDraftAt 定義在後，首次取用時再 create
    let _timetableApi = null;
    const getTimetableApi = () => {
      if (_timetableApi) return _timetableApi;
      if (!window.UiTimetable) {
        console.error('UiTimetable 未載入');
        return null;
      }
      _timetableApi = window.UiTimetable.create({
        computed,
        allSchedules, substitutionRecords, substitutionsLookup, allPendingRequests,
        // 只用目前可見頁的教師建 grid，全校模式才真正省算力
        displayTimetableTeachers: visibleTimetableTeachers, currentWeekDates,
        getTeacherNameByEmail, getTeacherSubjectByEmail, formatDateMMDD, isSingleWeek,
        isClassAwayOnDate, getWeekDayText,
        batchSelectMode, isBatchSlotSelected, isMutualCover, getMutualDraftAt,
        mutualAwayClasses, mutualActivityStart, mutualActivityEnd, DAC
      });
      return _timetableApi;
    };
    const scheduleIndex = computed(() => {
      const a = getTimetableApi();
      return a ? a.scheduleIndex.value : window.DomainSchedule.buildScheduleIndex(allSchedules.value);
    });
    const getApprovedScheduleForDate = (teacherEmail, dateStr, period, dayOfWeek) => {
      const a = getTimetableApi();
      return a ? a.getApprovedScheduleForDate(teacherEmail, dateStr, period, dayOfWeek) : null;
    };
    const getScheduleForDate = (teacherEmail, dateStr, period, dayOfWeek) => {
      const a = getTimetableApi();
      return a ? a.getScheduleForDate(teacherEmail, dateStr, period, dayOfWeek) : null;
    };
    const clearScheduleCache = () => { const a = getTimetableApi(); if (a) a.clearScheduleCache(); };
    const weekScheduleGrid = computed(() => {
      const a = getTimetableApi();
      return a ? a.weekScheduleGrid.value : {};
    });

    /**
     * 列表選取 = 純 CSS（label 勾 radio + :has(:checked)）。
     * JS 只聽 change，且只做綠格，絕不在按下當幀動列表。
     */
    let _matchListKey = '';
    let _matchPreviewPlain = null;
    let _matchNativeBound = false;

    const clearMatchHoverDom = () => {
      try {
        document.querySelectorAll('.grid-cell-class.is-match-hover')
          .forEach((el) => { el.classList.remove('is-match-hover'); });
      } catch (e) { /* ignore */ }
    };

    const paintMatchHoverCell = (day, period) => {
      clearMatchHoverDom();
      if (!activeCell.value || day == null || period == null) return;
      const leaveEm = String(activeCell.value.teacherEmail || '').toLowerCase();
      if (!leaveEm) return;
      try {
        const nodes = document.querySelectorAll(
          '.grid-cell-class[data-tt-email="' + leaveEm + '"][data-tt-day="' + parseInt(day, 10) + '"][data-tt-period="' + parseInt(period, 10) + '"]'
        );
        for (let i = 0; i < nodes.length; i++) nodes[i].classList.add('is-match-hover');
      } catch (e) { /* ignore */ }
    };

    const syncMatchStateFromRow = (tr) => {
      if (!tr) return;
      const mode = tr.getAttribute('data-match-mode') || 'sub';
      const email = String(tr.getAttribute('data-match-email') || '').toLowerCase();
      if (!email) return;
      if (mode === 'exc') {
        const day = parseInt(tr.getAttribute('data-match-day'), 10);
        const period = parseInt(tr.getAttribute('data-match-period'), 10);
        const key = email + '|' + day + '|' + period;
        _matchListKey = key;
        _matchPreviewPlain = {
          mode: 'exchange',
          email: email,
          name: tr.getAttribute('data-match-name') || '',
          dayOfWeek: day,
          period: period,
          className: tr.getAttribute('data-match-class') || '',
          subject: tr.getAttribute('data-match-subject') || ''
        };
        requestAnimationFrame(() => {
          if (_matchListKey === key) paintMatchHoverCell(day, period);
        });
        return;
      }
      _matchListKey = email;
      _matchPreviewPlain = {
        mode: 'substitution',
        email: email,
        name: tr.getAttribute('data-match-name') || '',
        dayOfWeek: activeCell.value ? parseInt(activeCell.value.dayOfWeek, 10) : 0,
        period: activeCell.value ? parseInt(activeCell.value.period, 10) : 0
      };
      requestAnimationFrame(() => {
        if (_matchListKey === email) clearMatchHoverDom();
      });
    };

    /** radio change：列表已由瀏覽器著色，這裡只同步狀態＋綠格 */
    const onMatchRadioChange = (evt) => {
      const t = evt && evt.target;
      if (!t || !t.classList || !t.classList.contains('match-pick-radio')) return;
      if (!t.checked) return;
      const tr = t.closest('tr.match-row');
      if (!tr) return;
      syncMatchStateFromRow(tr);
    };

    const clearMatchRadios = () => {
      try {
        document.querySelectorAll('.match-drawer .match-pick-radio:checked')
          .forEach((r) => { r.checked = false; });
      } catch (e) { /* ignore */ }
    };

    const bindMatchNativeSelect = () => {
      if (_matchNativeBound) return;
      _matchNativeBound = true;
      // 只聽 change（在瀏覽器勾選並 paint 之後）
      document.addEventListener('change', onMatchRadioChange, true);
    };
    const unbindMatchNativeSelect = () => {
      if (!_matchNativeBound) return;
      _matchNativeBound = false;
      document.removeEventListener('change', onMatchRadioChange, true);
    };

    const selectMatchPreviewSub = () => {};
    const selectMatchPreviewExchange = () => {};

    const clearMatchPreview = () => {
      clearMatchRadios();
      _matchListKey = '';
      _matchPreviewPlain = null;
      requestAnimationFrame(clearMatchHoverDom);
    };
    const closeMatchModal = () => {
      clearMatchPreview();
      showMatchModal.value = false;
    };
    watch(showMatchModal, (open) => {
      if (open) {
        bindMatchNativeSelect();
        if (typeof requestAnimationFrame === 'function') {
          requestAnimationFrame(paintMatchSourceDom);
        }
      } else {
        clearMatchPreview();
        unbindMatchNativeSelect();
        try {
          document.querySelectorAll('.grid-cell-class.is-match-source')
            .forEach((el) => {
              el.classList.remove('is-match-source', 'is-match-exchange-source');
            });
        } catch (e) { /* ignore */ }
      }
    });
    const isMatchPreviewSelected = () => false;
    // 媒合來源格：開抽屜時 DOM 標一次（不在模板每格呼叫 isMatchSourceCell）
    const paintMatchSourceDom = () => {
      try {
        document.querySelectorAll('.grid-cell-class.is-match-source')
          .forEach((el) => {
            el.classList.remove('is-match-source', 'is-match-exchange-source');
          });
        if (!showMatchModal.value || !activeCell.value) return;
        const em = String(activeCell.value.teacherEmail || '').toLowerCase();
        const day = parseInt(activeCell.value.dayOfWeek, 10);
        const period = parseInt(activeCell.value.period, 10);
        if (!em || isNaN(day) || isNaN(period)) return;
        const nodes = document.querySelectorAll(
          '.grid-cell-class[data-tt-email="' + em + '"][data-tt-day="' + day + '"][data-tt-period="' + period + '"]'
        );
        const isEx = matchMode.value === 'exchange';
        for (let i = 0; i < nodes.length; i++) {
          nodes[i].classList.add('is-match-source');
          if (isEx) nodes[i].classList.add('is-match-exchange-source');
        }
      } catch (e) { /* ignore */ }
    };
    const isMatchSourceCell = () => false;
    const isMatchSourceEntry = () => false;
    const isMatchHoverCell = () => false;
    const isMatchHoverEntry = () => false;
    watch([showMatchModal, matchMode, activeCell], () => {
      if (showMatchModal.value) {
        if (typeof requestAnimationFrame === 'function') {
          requestAnimationFrame(paintMatchSourceDom);
        } else {
          paintMatchSourceDom();
        }
      }
    });

    const isAwayClassCell = (className, dateStr) => {
      const a = getTimetableApi();
      return a ? a.isAwayClassCell(className, dateStr) : false;
    };
    const getClassCellClassForDate = (teacherEmail, dateStr, period, dayOfWeek) => {
      const a = getTimetableApi();
      return a ? a.getClassCellClassForDate(teacherEmail, dateStr, period, dayOfWeek) : 'is-empty';
    };

    const getClassCellClassForClass = (className, day, period) => {
      const a = getTimetableApi();
      return a
        ? a.getClassCellClassForClass({ classSchedules, selectedClassWeekDates, classSubstitutionMap }, className, day, period)
        : 'is-empty';
    };

    // 點擊課表格子的處理邏輯
    const changeClassWeek = (offset) => {
      const d = new Date(selectedClassDate.value + 'T00:00:00');
      d.setDate(d.getDate() + offset * 7);
      selectedClassDate.value = toLocalDateStr(d);
    };

    const goToClassThisWeek = () => {
      selectedClassDate.value = toLocalDateStr(new Date());
    };

    const applyClassViewFromUrl = () => {
      const urlParams = new URLSearchParams(window.location.search);
      // 唯讀深連結：?class=701（相容舊式 ?view=class&class=701）
      const cls = String(urlParams.get('class') || urlParams.get('cls') || '').trim();
      if (!cls) return false;
      classReadonlyMode.value = true;
      pendingClassView.value = cls;
      activeTab.value = 'class';
      selectedClass.value = cls;
      return true;
    };

    const resolvePendingClassView = () => {
      if (!pendingClassView.value) return;
      const target = String(pendingClassView.value).trim();
      const list = classList.value || [];
      const matched = list.find(c => String(c) === target)
        || list.find(c => String(c).toLowerCase() === target.toLowerCase())
        || list.find(c => String(c).includes(target) || target.includes(String(c)));
      selectedClass.value = matched || target;
      activeTab.value = 'class';
      classReadonlyMode.value = true;
      pendingClassView.value = '';
    };

    const getClassReadonlyLink = (cls) => {
      const c = encodeURIComponent(cls || selectedClass.value || '');
      return `${window.location.origin}${window.location.pathname}?class=${c}`;
    };

    const copyClassReadonlyLink = async (cls) => {
      const link = getClassReadonlyLink(cls || selectedClass.value);
      if (!cls && !selectedClass.value) {
        showToast('請先選擇班級', 'warning');
        return;
      }
      try {
        await navigator.clipboard.writeText(link);
        showToast('已複製該班唯讀課表連結', 'success');
      } catch (e) {
        window.prompt('請手動複製連結：', link);
      }
    };

    const handleClassCellClick = (cls, day, period, entryOrIndex) => {
      const a = getTimetableApi();
      if (!a) return;
      a.handleClassCellClick({
        classSchedules, selectedClassWeekDates, classSubstitutionMap, detailSubRecord, detailRequest,
        showDetailModal, resolveDetailRequest, classReadonlyMode, isAdmin, getTeacherNameByEmail,
        activeCell, inputRequestDate, matchMode, exchangeTargetDate, exchangeWeekOffset, exchangePeriodId,
        exchangeTeacherEmail, matchPreview, recommendedTeachers, matchSearchQuery, matchDisplayCount,
        showMatchModal, fetchRecommendations
      }, cls, day, period, entryOrIndex);
    };

    const handleCellClick = async (teacherEmail, dayOfWeek, period, dateStr) => {
      const a = getTimetableApi();
      if (!a) {
        showToast('課表模組未載入', 'error');
        return;
      }
      return a.handleCellClick({
        isScheduleEditMode, openScheduleEditModal, showToast, showConfirm,
        isMutualLead, getMutualDraftAt, removeMutualDraft, activeCell, inputRequestDate,
        matchMode, matchPreview, showCompareModal, showMatchModal,
        fetchRecommendations, batchSelectMode, isAdmin, user, toggleBatchSlot,
        detailRequest, detailSubRecord, showDetailModal, resolveDetailRequest,
        getTeacherNameByEmail, exchangeTargetDate, exchangeWeekOffset, exchangePeriodId, exchangeTeacherEmail
      }, teacherEmail, dayOfWeek, period, dateStr);
    };

    // 當前異動需再次轉移（二次調代課）— ui-timetable
    const startSecondSub = () => {
      const a = getTimetableApi();
      if (!a) return;
      a.startSecondSub({
        detailSubRecord, getTeacherNameByEmail, activeCell, inputRequestDate, showDetailModal,
        exchangeTargetDate, exchangeWeekOffset, exchangePeriodId, exchangeTeacherEmail,
        matchMode, fetchRecommendations, matchPreview, showMatchModal
      });
    };

    // 載入欲對調教師的所有排課節次 (僅限同班有課)
    const loadTeacherClassesForExchange = () => {
      if (!exchangeTeacherEmail.value) {
        exchangeTeacherClasses.value = [];
        return;
      }
      exchangeTeacherClasses.value = allSchedules.value.filter(s => 
        s.teacherEmail === exchangeTeacherEmail.value &&
        s.className === activeCell.value.classData.className
      );
    };


    /** 批次一次全部同意／全部拒絕 */
    // 月底大鐘點統計（domain-billing）
    const calculateMonthlyReport = () => {
      monthlyReportData.value = window.DomainBilling.buildMonthlyReportRows({
        teachers: teachersList.value,
        allSchedules: allSchedules.value,
        substitutionRecords: substitutionRecords.value,
        reportMonth: reportMonth.value,
        reportWeeksCount: reportWeeksCount.value,
        getTeacherNameByEmail,
        classAwayEvents: classAwayEvents.value,
        semesterEndDate: semesterEndDate.value,
        isSingleWeek
      });
    };

    // 匯出 Excel：1～7 一表＋第8節明細一表（誰上誰拿）
    const exportReportToExcel = async () => {
      try {
        if (typeof window.ensureXlsx === 'function') await window.ensureXlsx();
      } catch (e) {
        showToast('Excel 模組載入失敗', 'error');
        return;
      }
      if (typeof XLSX === 'undefined') {
        showToast('Excel 模組未載入', 'error');
        return;
      }
      if (!monthlyReportData.value || !monthlyReportData.value.length) calculateMonthlyReport();
      const data = window.DomainBilling.toExcelRows(monthlyReportData.value);
      const ws = XLSX.utils.json_to_sheet(data);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, `${reportMonth.value}大鐘點1-7`);
      if (window.DomainBilling.toPeriod8ExcelRows) {
        const p8 = window.DomainBilling.toPeriod8ExcelRows({
          reportMonth: reportMonth.value,
          allSchedules: allSchedules.value,
          substitutionRecords: substitutionRecords.value,
          classAwayEvents: classAwayEvents.value,
          semesterEndDate: semesterEndDate.value,
          getTeacherNameByEmail,
          isSingleWeek
        });
        const ws8 = XLSX.utils.json_to_sheet(p8.length ? p8 : [{ "日期": "", "說明": "本月無第8節應發或空堂列" }]);
        XLSX.utils.book_append_sheet(wb, ws8, `${reportMonth.value}第8節明細`);
      }
      XLSX.writeFile(wb, `全校大鐘點與第8節費_${reportMonth.value}.xlsx`);
    };

    // 全校課表彙整 Word 匯出（後台）：.docx、試算表順序、可選教師
    // export 腳本延後載入：預設區間空，進後台或點「本週」再填
    const schoolExportStart = ref('');
    const schoolExportEnd = ref('');
    const schoolExportIncludeWeekend = ref(false);
    const schoolExportOnlyChanged = ref(false);
    const schoolExportSelectedEmails = ref([]); // 小寫 email，預設全選（見 watch）
    const schoolExportTeacherFilter = ref('');
    let _schoolExportKnownEmails = {};

    watch(teachersList, (list) => {
      if (!list || !list.length) return;
      const all = list.map(t => String(t.email || '').toLowerCase()).filter(Boolean);
      const selected = {};
      schoolExportSelectedEmails.value.forEach(e => { selected[e] = 1; });
      const known = _schoolExportKnownEmails;
      const isFirst = Object.keys(known).length === 0;
      const next = [];
      all.forEach(em => {
        if (isFirst || selected[em] || !known[em]) next.push(em);
      });
      schoolExportSelectedEmails.value = next;
      const nextKnown = {};
      all.forEach(em => { nextKnown[em] = 1; });
      _schoolExportKnownEmails = nextKnown;
    }, { immediate: true });

    const filteredSchoolExportTeachers = computed(() => {
      const q = String(schoolExportTeacherFilter.value || '').trim().toLowerCase();
      const list = teachersList.value || [];
      if (!q) return list;
      return list.filter(t => {
        const name = String(t.name || '').toLowerCase();
        const subj = String(t.subject || '').toLowerCase();
        const em = String(t.email || '').toLowerCase();
        return name.indexOf(q) >= 0 || subj.indexOf(q) >= 0 || em.indexOf(q) >= 0;
      });
    });

    const isSchoolExportTeacherSelected = (email) => {
      const em = String(email || '').toLowerCase();
      return schoolExportSelectedEmails.value.indexOf(em) >= 0;
    };

    const toggleSchoolExportTeacher = (email) => {
      const em = String(email || '').toLowerCase();
      if (!em) return;
      const arr = schoolExportSelectedEmails.value.slice();
      const i = arr.indexOf(em);
      if (i >= 0) arr.splice(i, 1);
      else arr.push(em);
      schoolExportSelectedEmails.value = arr;
    };

    const selectAllSchoolExportTeachers = () => {
      // 若有篩選字，只全選目前可見；否則全校
      const src = schoolExportTeacherFilter.value
        ? filteredSchoolExportTeachers.value
        : (teachersList.value || []);
      const set = {};
      schoolExportSelectedEmails.value.forEach(e => { set[e] = 1; });
      src.forEach(t => {
        const em = String(t.email || '').toLowerCase();
        if (em) set[em] = 1;
      });
      schoolExportSelectedEmails.value = Object.keys(set);
    };

    const clearSchoolExportTeachers = () => {
      if (schoolExportTeacherFilter.value) {
        // 只清目前可見
        const hide = {};
        filteredSchoolExportTeachers.value.forEach(t => {
          const em = String(t.email || '').toLowerCase();
          if (em) hide[em] = 1;
        });
        schoolExportSelectedEmails.value = schoolExportSelectedEmails.value.filter(e => !hide[e]);
      } else {
        schoolExportSelectedEmails.value = [];
      }
    };

    const setSchoolExportThisWeek = async () => {
      try {
        await ensureExportReady();
      } catch (e) {
        showToast('匯出模組載入失敗', 'error');
        return;
      }
      if (!window.ExportSchoolTimetable || !window.ExportSchoolTimetable.thisWeekRange) {
        showToast('匯出模組未載入', 'error');
        return;
      }
      const r = window.ExportSchoolTimetable.thisWeekRange();
      schoolExportStart.value = r.startDate;
      schoolExportEnd.value = r.endDate;
      schoolExportIncludeWeekend.value = false;
    };

    const exportSchoolTimetableWord = async () => {
      if (!isAdmin.value) {
        showToast('僅管理員可匯出全校課表', 'warning');
        return;
      }
      try {
        await ensureExportReady();
      } catch (e) {
        showToast('匯出模組載入失敗，請重新整理頁面', 'error');
        return;
      }
      if (!window.ExportSchoolTimetable || !window.ExportSchoolTimetable.exportWord) {
        showToast('匯出模組未載入，請重新整理頁面', 'error');
        return;
      }
      const selected = {};
      schoolExportSelectedEmails.value.forEach(e => { selected[e] = 1; });
      // 維持 teachersList 順序（＝試算表順序），只留勾選
      const teachers = (teachersList.value || []).filter(t => {
        const em = String(t.email || '').toLowerCase();
        return em && selected[em];
      });
      if (!teachers.length) {
        showToast('請至少勾選一位教師', 'warning');
        return;
      }
      const res = window.ExportSchoolTimetable.exportWord({
        startDate: schoolExportStart.value,
        endDate: schoolExportEnd.value,
        includeWeekend: !!schoolExportIncludeWeekend.value,
        onlyChanged: !!schoolExportOnlyChanged.value,
        teachers,
        getCell: (email, dateStr, period, dayOfWeek) =>
          getApprovedScheduleForDate(email, dateStr, period, dayOfWeek),
        // 空堂事件班：匯出留白（與課表邏輯一致；畫面仍淡化）
        isClassAway: (className, dateStr) => isClassAwayOnDate(className, dateStr)
      });
      if (!res || !res.ok) {
        showToast((res && res.error) || '匯出失敗', 'warning');
        return;
      }
      if (res.warning) showToast(res.warning, 'info');
      showToast(`已下載：${res.fileName}（${res.teacherCount} 位教師 × ${res.dayCount} 天）`, 'success');
    };

    // 將日期字串轉為該週週一 YYYY-MM-DD
    const getMonday = (dateStr) => {
      const d = new Date(dateStr);
      const day = d.getDay();
      const diff = (day === 0 ? -6 : 1) - day;
      const mon = new Date(d);
      mon.setDate(d.getDate() + diff);
      return mon.toISOString().slice(0, 10);
    };

    // 產生統一官方交錯表格格式的單張通知單 HTML
    // ── 橋接外部印表模組 (已抽離至 print-helper.js) ─────────────────────
    const generateFormHtml = (g, currentType) => {
      if (typeof window.generateFormHtml !== 'function') {
        showToast('列印模組載入中，請稍候再試', 'warning');
        return '';
      }
      return window.generateFormHtml(g, currentType, {
        getTeacherNameByEmail,
        getTeacherSubjectByEmail,
        getWeekDayText,
        showToast,
        allSchedules,
        getScheduleForDate
      });
    };

    /** P1：列印／匯出前確保延後腳本已載入 */
    const ensurePrintReady = async () => {
      if (typeof window.ensurePrintHelper === 'function') {
        await window.ensurePrintHelper();
      }
      if (typeof window.generateFormHtml !== 'function') {
        throw new Error('列印模組尚未載入');
      }
    };
    const ensureExportReady = async () => {
      if (typeof window.ensureExportSchoolTimetable === 'function') {
        await window.ensureExportSchoolTimetable();
      }
      if (!window.ExportSchoolTimetable) {
        throw new Error('課表匯出模組尚未載入');
      }
    };

    /** 歷史紀錄：批次後發通知信（依代課老師合併） */
    const sendSelectedBatchNotices = async () => {
      if (!isAdmin.value) {
        showToast('僅管理員可批次發通知', 'warning');
        return;
      }
      const ids = (selectedRecordIds.value || []).slice();
      if (!ids.length) {
        showToast('請先勾選歷史紀錄', 'warning');
        return;
      }
      // 轉成申請單 ID（substitution 紀錄 id 可能帶 _1/_2）
      const requestIds = [...new Set(ids.map(id => {
        const rec = (substitutionRecords.value || []).find(r => r.id === id);
        return rec ? (rec.requestId || String(id).replace(/_[12]$/, '')) : String(id).replace(/_[12]$/, '');
      }).filter(Boolean))];
      if (!requestIds.length) {
        showToast('無法解析申請單 ID', 'warning');
        return;
      }
      // 預覽：依代課老師分組
      const bySub = {};
      requestIds.forEach(rid => {
        const req = (requestsList.value || []).find(r => r.id === rid);
        if (!req) return;
        const em = String(req.targetTeacherEmail || '').toLowerCase();
        const name = req.targetTeacherName || em;
        if (!bySub[em]) bySub[em] = { name, n: 0 };
        bySub[em].n++;
      });
      const preview = Object.values(bySub).map(g => `${g.name}（${g.n}節）`).join('、') || '（依後端分組）';
      const ok = await showConfirm(
        `將後發通知信給代課老師（同人合併一封）\n共 ${requestIds.length} 筆申請 → 約 ${Object.keys(bySub).length || '？'} 封信\n\n${preview}\n\n確定寄出？`,
        '批次發通知信'
      );
      if (!ok) return;
      loading.value = true;
      loadingMessage.value = '正在寄送通知…';
      try {
        const res = await callGasApi('sendBatchNotices', { requestIds });
        const sent = res && res.sent != null ? res.sent : Object.keys(bySub).length;
        const failed = res && res.failed ? res.failed : 0;
        showToast(failed ? `已寄 ${sent} 組，失敗 ${failed} 組` : `已寄出 ${sent} 組通知（依代課老師合併）`, failed ? 'warning' : 'success');
      } catch (e) {
        console.error(e);
        showToast('批次通知失敗：' + (e && e.message ? e.message : String(e)), 'error');
      } finally {
        loading.value = false;
      }
    };

    const printSelectedForms = async (formType) => {
      try {
        await ensurePrintReady();
      } catch (e) {
        showToast('列印模組載入失敗，請重新整理後再試', 'error');
        return;
      }
      await window.printSelectedForms(formType, {
        selectedRecordIds,
        substitutionRecords,
        requestsList,
        callGasApi,
        markLocalPrinted,
        getTeacherNameByEmail,
        getTeacherSubjectByEmail,
        getWeekDayText,
        showToast,
        loading,
        loadingMessage,
        allSchedules
      });
    };


    // ════════════════════════════════════════
    // §5 輔助函式 / 載入資料 / 生命週期
    // ════════════════════════════════════════
// --- 輔助與生命週期函數 ---

    const getStatusText = (status) => window.FieldMap.getStatusText(status);

    const changeMatchMode = async (mode) => {
      // 巡堂不可調課／代課（點格已擋；此為保險）
      if (activeCell.value && activeCell.value.classData &&
          (activeCell.value.classData.isPatrol || activeCell.value.classData.attr === '巡堂')) {
        showToast('巡堂節不需系統調代課，請私下安排代巡', 'info');
        matchMode.value = 'substitution';
        clearMatchPreview();
        return;
      }
      // 綁課：可調課，但需確認提醒（特殊狀況）
      if (mode === 'exchange' && activeCell.value && activeCell.value.classData &&
          activeCell.value.classData.restriction === 'restricted') {
        const ok = await showConfirm(
          '此堂為綁課／特殊課程，原則上建議申請代課。\n\n特殊狀況仍可調課，請確認已與相關人員（領域／導師／教學組）溝通後再繼續。\n\n仍要切換到「節次調課」？',
          '綁課提醒'
        );
        if (!ok) {
          matchMode.value = 'substitution';
          clearMatchPreview();
          if (activeCell.value.dayOfWeek) fetchRecommendations();
          return;
        }
      }
      matchMode.value = mode;
      clearMatchPreview();
      if (activeCell.value.dayOfWeek) {
        fetchRecommendations();
      }
    };

    const changeWeek = (direction) => {
      const current = new Date(selectedWeekDate.value);
      current.setDate(current.getDate() + (direction * 7));
      selectedWeekDate.value = toLocalDateStr(current);
      // 不需要重新拉資料，課表格子由 currentWeekDates computed 自動更新
    };

    const getPeriodTimeSpan = (p) => window.DateUtils.getPeriodTimeSpan(p);
    const getWeekDayText = (d) => window.DateUtils.getWeekDayText(d);
    const formatDateMMDD = (dateStr) => window.DateUtils.formatDateMMDD(dateStr);
    const getTodayString = () => window.DateUtils.getTodayString();

    // P4：email → 教師 O(1) 查表（大小寫皆可）
    const teachersByEmail = computed(() => {
      const map = Object.create(null);
      (teachersList.value || []).forEach(t => {
        if (!t || !t.email) return;
        const raw = String(t.email);
        map[raw] = t;
        const low = raw.toLowerCase();
        if (low !== raw) map[low] = t;
      });
      return map;
    });
    const lookupTeacher = (email) => {
      if (!email) return null;
      const m = teachersByEmail.value;
      return m[email] || m[String(email).toLowerCase()] || null;
    };

    const getTeacherNameByEmail = (email) => {
      if (!email) return '';
      const t = lookupTeacher(email);
      return t ? t.name : String(email).split('@')[0];
    };

    const getTeacherSubjectByEmail = (email) => {
      if (!email) return '自習';
      const t = lookupTeacher(email);
      return t ? t.subject : '自習';
    };

    const getRealTeacherName = (s) => {
      if (!s) return '';
      const rawName = s.teacherName || '';
      if (rawName && !rawName.includes('(') && !rawName.includes(')') && !/^\d/.test(rawName)) {
        return rawName;
      }
      if (s.teacherEmail) {
        const t = lookupTeacher(s.teacherEmail);
        if (t && t.name) return t.name;
      }
      return rawName.includes('(') ? '' : rawName;
    };

    // 模擬身份：搜尋過濾（避免一次渲染 60+ li）
    const devTeacherQuery = ref('');
    const filteredDevTeachers = computed(() => {
      const q = String(devTeacherQuery.value || '').trim().toLowerCase();
      const list = teachersList.value || [];
      if (!q) return list;
      return list.filter(t => {
        const name = String(t.name || '').toLowerCase();
        const em = String(t.email || '').toLowerCase();
        const sub = String(t.subject || '').toLowerCase();
        return name.includes(q) || em.includes(q) || sub.includes(q);
      });
    });


    // ── 資料載入（SWR + FieldMap）──────────────────────────
    /** 教學組直接申請／直接核准：進歷史與課表，不進「送出的申請」 */
    const isAdminDirectRequest = (r) => {
      if (!r) return false;
      if (r.directApprove === true) return true;
      const note = String(r.note || '');
      return note.indexOf('[直接核准]') >= 0 || note.indexOf('行政直接核准') >= 0;
    };

    const applyInitialPayload = (res) => {
      if (!res) return;
      if (res.scheduleScope) scheduleScope.value = String(res.scheduleScope);
      else if (res.scope === 'teacher') scheduleScope.value = 'teacher_self_and_class';
      else if (res.scope === 'admin') scheduleScope.value = 'full';
      if (res.semesters) {
        semestersList.value = res.semesters.map(s => window.FieldMap.mapSemester(s));
        semestersList.value.sort((a, b) => a.id.localeCompare(b.id));
        if (semestersList.value.length > 0 && (!currentSemester.value || !semestersList.value.find(s => s.id === currentSemester.value))) {
          const defaultSem = semestersList.value.find(s => s.isDefault);
          const latest = defaultSem || semestersList.value[semestersList.value.length - 1];
          currentSemester.value = latest.id;
          localStorage.setItem('jcjh_semester', latest.id);
        }
      }
      if (res.teachers) {
        teachersList.value = res.teachers.map(t => window.FieldMap.mapTeacher(t));
      }
      if (res.schedules) {
        allSchedules.value = res.schedules.map(s => window.FieldMap.mapSchedule(s));
      }
      if (res.requests) {
        const allRequests = res.requests.map(r => window.FieldMap.mapRequest(r));
        const sortedAll = sortRequestListDesc(allRequests);
        requestsList.value = sortedAll;
        // 關鍵：動態從 requestsList 轉換出 substitutionRecords（公開唯讀也需要）
        substitutionRecords.value = convertRequestsToSubstitutions(sortedAll);
        bumpRequestsWatermarkFromRows(sortedAll);
        if (user.value) {
          const email = user.value.email.toLowerCase();
          mySentRequests.value = sortedAll.filter(r =>
            r.requesterEmail && r.requesterEmail.toLowerCase() === email
            && !isAdminDirectRequest(r)
          );
          myPendingRequests.value = sortedAll.filter(r => r.targetTeacherEmail && r.targetTeacherEmail.toLowerCase() === email && r.status === 'pending_teacher');
          adminPendingRequests.value = sortedAll.filter(r => r.status === 'pending_admin');
          allPendingRequests.value = sortedAll.filter(r => r.status === 'pending_teacher' || r.status === 'pending_admin');
        } else {
          mySentRequests.value = [];
          myPendingRequests.value = [];
          adminPendingRequests.value = [];
          allPendingRequests.value = [];
        }
      }
      if (res.classAwayEvents) {
        classAwayEvents.value = res.classAwayEvents.map(e => window.FieldMap.mapClassAwayEvent(e));
      } else if (res.classAwayEvents === undefined) {
        // 舊快取可能沒此欄
      } else {
        classAwayEvents.value = [];
      }
      if (res.settings) applySettings(res.settings);
      if (res.requestWindow) {
        requestWindowInfo.value = res.requestWindow;
        if (res.requestWindow.historyAll) historyFullLoaded.value = true;
      }
      // 伺服器時間推進水位（即使本包無申請列）
      if (res.serverTime && stampIsNewer(res.serverTime, _requestsWatermark)) {
        _requestsWatermark = String(res.serverTime).trim();
      }
      clearScheduleCache();
    };

    // ── 樂觀更新：本地改 state，背景再 soft refresh ──
    /**
     * 列表排序：申請時間倒序；同批次／同單號根（SUB1234-1、-2）聚攏
     * 組內再依異動日期、節次正序（同批節次依序看）
     */
    const serialRoot = (serial) => {
      const s = String(serial || '').trim();
      if (!s) return '';
      return s.replace(/-\d+$/, '') || s;
    };
    const parseTimeMs = (raw) => {
      const t = String(raw || '').trim().replace('T', ' ');
      if (!t) return 0;
      // 支援 "YYYY-MM-DD HH:mm:ss" / ISO / 僅日期
      const norm = t.includes('/') ? t : t.replace(/-/g, '/');
      const ms = Date.parse(norm);
      return Number.isFinite(ms) ? ms : 0;
    };
    const requestGroupKey = (r) => {
      if (r && r.batchId) return 'bat:' + String(r.batchId);
      const root = serialRoot(r && r.serial);
      if (root) return 'ser:' + root;
      return 'id:' + String((r && (r.id || r.requestId)) || '');
    };
    const requestTimeMs = (r) => {
      const c = parseTimeMs(r && r.createdAt);
      if (c) return c;
      // 歷史列可能只有 createdDate（YYYY-MM-DD）
      const d = parseTimeMs((r && (r.createdDate || r.requestDate || r.date)) || '');
      return d;
    };
    const sortListRowsDesc = (a, b) => {
      const ga = requestGroupKey(a);
      const gb = requestGroupKey(b);
      if (ga !== gb) {
        // 不同組：以組內最新時間倒序（先掃一遍不划算，改比各自時間；同秒再比 groupKey）
        const ta = requestTimeMs(a);
        const tb = requestTimeMs(b);
        if (tb !== ta) return tb - ta;
        return String(gb).localeCompare(String(ga));
      }
      // 同組：日期→節次 正序（方便連看）
      const da = String(a.requestDate || a.date || '');
      const db = String(b.requestDate || b.date || '');
      if (da !== db) return da.localeCompare(db);
      const pa = parseInt(a.requestPeriod != null ? a.requestPeriod : a.period, 10) || 0;
      const pb = parseInt(b.requestPeriod != null ? b.requestPeriod : b.period, 10) || 0;
      if (pa !== pb) return pa - pb;
      return String(a.id || '').localeCompare(String(b.id || ''));
    };
    /** 整表：先依「組最新時間」倒序，再把同組排在一起 */
    const sortRequestListDesc = (list) => {
      const arr = (list || []).slice();
      const groupMax = {};
      arr.forEach(r => {
        const g = requestGroupKey(r);
        const t = requestTimeMs(r);
        if (!groupMax[g] || t > groupMax[g]) groupMax[g] = t;
      });
      return arr.sort((a, b) => {
        const ga = requestGroupKey(a);
        const gb = requestGroupKey(b);
        if (ga !== gb) {
          const ta = groupMax[ga] || 0;
          const tb = groupMax[gb] || 0;
          if (tb !== ta) return tb - ta;
          return String(gb).localeCompare(String(ga));
        }
        return sortListRowsDesc(a, b);
      });
    };
    const sortRequestsDesc = (a, b) => sortListRowsDesc(a, b);

    const recomputeRequestBuckets = () => {
      if (!user.value) return;
      const email = user.value.email.toLowerCase();
      const all = sortRequestListDesc(requestsList.value || []);
      requestsList.value = all;
      // 送出的申請：僅教師本人發起；教學組代申請／直接核准不列（見歷史紀錄）
      mySentRequests.value = all.filter(r =>
        r.requesterEmail && r.requesterEmail.toLowerCase() === email
        && !isAdminDirectRequest(r)
      );
      myPendingRequests.value = all.filter(r => r.targetTeacherEmail && r.targetTeacherEmail.toLowerCase() === email && r.status === 'pending_teacher');
      adminPendingRequests.value = all.filter(r => r.status === 'pending_admin');
      allPendingRequests.value = all.filter(r => r.status === 'pending_teacher' || r.status === 'pending_admin');
      
      // 關鍵：每次 recompute 亦同步重算虛擬 substitutions
      substitutionRecords.value = convertRequestsToSubstitutions(all);
      
      clearScheduleCache();
    };

    const sheetRequestToFront = (nr) => window.FieldMap.mapRequest(nr);

    const optimisticUpsertRequest = (frontReq) => {
      const list = requestsList.value.slice();
      const idx = list.findIndex(r => r.id === frontReq.id);
      if (idx >= 0) list[idx] = Object.assign({}, list[idx], frontReq);
      else list.unshift(frontReq);
      requestsList.value = list;
      recomputeRequestBuckets();
    };

    const optimisticPatchRequestStatus = (id, status) => {
      const list = requestsList.value.slice();
      const idx = list.findIndex(r => r.id === id);
      if (idx < 0) return false;
      list[idx] = Object.assign({}, list[idx], { status });
      requestsList.value = list;
      // recomputeRequestBuckets 會重算 substitutionRecords 與課表快取
      recomputeRequestBuckets();
      return true;
    };

    const optimisticRemoveRequest = (id) => {
      requestsList.value = requestsList.value.filter(r => r.id !== id);
      recomputeRequestBuckets();
    };

    /**
     * 寫入後背景同步（局部優先）
     * - 預設：pendingOnly → 失敗再 requestsOnly → 再全量
     * - requestsOnly:true：跳過 pending，直接申請窗對齊（核准後課表異動）
     * - force:true：課表／教師結構有變，全量重抓
     * - skip:true 略過（批次內層用）
     * - 最短間隔 3.5s，避免同意→核准連打兩次整包
     */
    let _softRefreshTimer = null;
    let _softRefreshRunning = false;
    let _softRefreshQueued = null; // null | { force, delay, requestsOnly }
    let _softRefreshLastAt = 0;
    const SOFT_REFRESH_MIN_GAP_MS = 3500;
    const softRefreshInBackground = (opts) => {
      opts = opts || {};
      if (opts.skip) return;
      const force = !!opts.force;
      const requestsOnly = !!opts.requestsOnly;
      // local 預設：狀態類操作延後對齊
      const delay = opts.delay != null
        ? opts.delay
        : (force ? 450 : 2800);
      const nextForce = force || !!(_softRefreshQueued && _softRefreshQueued.force);
      const nextReqOnly = !nextForce && (requestsOnly || !!(_softRefreshQueued && _softRefreshQueued.requestsOnly));
      const nextDelay = _softRefreshQueued
        ? Math.min(_softRefreshQueued.delay != null ? _softRefreshQueued.delay : delay, delay)
        : delay;
      _softRefreshQueued = { force: nextForce, delay: nextDelay, requestsOnly: nextReqOnly };
      if (_softRefreshTimer) clearTimeout(_softRefreshTimer);
      const runDelay = _softRefreshQueued.delay;
      const runForce = _softRefreshQueued.force;
      const runReqOnly = _softRefreshQueued.requestsOnly;
      _softRefreshTimer = setTimeout(async () => {
        _softRefreshTimer = null;
        _softRefreshQueued = null;
        if (_softRefreshRunning) {
          _softRefreshQueued = { force: runForce, delay: 500, requestsOnly: runReqOnly };
          return;
        }
        const since = Date.now() - _softRefreshLastAt;
        if (!runForce && since < SOFT_REFRESH_MIN_GAP_MS && _softRefreshLastAt > 0) {
          softRefreshInBackground({
            force: false,
            requestsOnly: runReqOnly,
            delay: SOFT_REFRESH_MIN_GAP_MS - since + 200
          });
          return;
        }
        _softRefreshRunning = true;
        try {
          if (runForce) {
            await loadWeeklyData({ force: true, silent: true });
          } else if (runReqOnly) {
            // 核准後課表／狀態：增量有變更即夠；empty／false → 全窗 → 全量
            const d = await softSyncRequestsDelta();
            if (d !== true) {
              const okRo = await softSyncRequestsOnly();
              if (!okRo) await loadWeeklyData({ force: false, silent: true });
            }
          } else {
            // 預設：pending → 增量
            // - delta 有變更：完成
            // - pending 幽靈結案或 delta 失敗：全窗 → 全量
            // - 無幽靈且 empty：完成（省一次全窗）
            const p = await softSyncPendingOnly();
            const d = await softSyncRequestsDelta();
            if (d === true) {
              // ok
            } else if (p === false || p === 'ghost' || d === false) {
              const okR = await softSyncRequestsOnly();
              if (!okR) await loadWeeklyData({ force: false, silent: true });
            }
            // p===true && d==='empty'：無異動，結束
          }
          _softRefreshLastAt = Date.now();
        } catch (e) {
          console.warn('背景同步失敗：', e);
        } finally {
          _softRefreshRunning = false;
          if (_softRefreshQueued) {
            const q = _softRefreshQueued;
            _softRefreshQueued = null;
            softRefreshInBackground(q);
          }
        }
      }, runDelay);
    };

    const resolveUserRoleFromTeachers = async () => {
      if (!user.value) return true;
      const email = user.value.email.toLowerCase();
      const currentTeacher = lookupTeacher(email);
      if (currentTeacher) {
        userRole.value = currentTeacher.role || 'teacher';
        return true;
      }
      if (teachersList.value.length === 0) {
        userRole.value = 'admin';
        try {
          const bootstrapPayload = {
            "教師Email": email,
            "教師姓名": user.value.displayName || email.split('@')[0],
            "授課科目": "系統管理",
            "系統角色": "admin",
            "基本鐘點": 16
          };
          await callGasApi('saveTeacher', bootstrapPayload);
          showToast("🎉 偵測到此學期尚未建立教師名單，已將您的帳號自動註冊為此學期的【系統管理員】！", 'success');
          teachersList.value.push({
            email: email,
            name: bootstrapPayload["教師姓名"],
            subject: bootstrapPayload["授課科目"],
            role: bootstrapPayload["系統角色"],
            baseHours: bootstrapPayload["基本鐘點"]
          });
          return true;
        } catch (bootstrapErr) {
          console.error("自動註冊管理員失敗：", bootstrapErr);
          return false;
        }
      }
      logout();
      showToast(`⚠️ 登入失敗：您的帳號 (${user.value.email}) 不在本校教師名單中，請聯繫教學組協助開通。`, 'error');
      return false;
    };

    const loadSemesters = async () => {
      const url = gasApiUrl.value;
      if (!url) {
        semestersList.value = [{ id: '114-1', name: '114學年度第1學期', startDate: '', endDate: '', isDefault: true }];
        return;
      }
      try {
        const res = await fetchMetaData({ semesterId: currentSemester.value });
        if (res.success && res.semesters) {
          semestersList.value = res.semesters.map(s => window.FieldMap.mapSemester(s));
          semestersList.value.sort((a, b) => a.id.localeCompare(b.id));
        }
        if (res.teachers) {
          teachersList.value = res.teachers.map(t => window.FieldMap.mapTeacher(t));
        }
        if (res.settings) applySettings(res.settings);
        if (semestersList.value.length === 0) {
          semestersList.value = [{ id: '114-1', name: '114學年度第1學期', startDate: '', endDate: '', isDefault: true }];
        }
      } catch (e) {
        console.warn('載入學期失敗：', e);
        semestersList.value = [{ id: '114-1', name: '114學年度第1學期', startDate: '', endDate: '', isDefault: true }];
      }
    };

    // 非管理員監聽預設學期變動
    watch([semestersList, isAdmin], ([list, admin]) => {
      if (admin) return;
      const def = list.find(s => s.isDefault);
      if (def && def.id !== currentSemester.value) {
        currentSemester.value = def.id;
        localStorage.setItem('jcjh_semester', def.id);
      }
    });

    const loadPublicClassData = async (className) => {
      const cls = String(className || pendingClassView.value || selectedClass.value || '').trim();
      if (!cls) return false;
      loading.value = true;
      loadingMessage.value = '載入班級課表中...';
      classReadonlyMode.value = true;
      activeTab.value = 'class';
      selectedClass.value = cls;
      pendingClassView.value = cls;
      try {
        const res = await fetchPublicClassData({
          className: cls,
          semesterId: currentSemester.value
        });
        applyInitialPayload(res);
        if (res.semesterId) {
          currentSemester.value = res.semesterId;
          localStorage.setItem('jcjh_semester', res.semesterId);
        }
        resolvePendingClassView();
        loading.value = false;
        return true;
      } catch (err) {
        console.error('公開班級課表載入失敗：', err);
        showToast('載入班級課表失敗：' + (err.message || err), 'error');
        loading.value = false;
        return false;
      }
    };

    const loadWeeklyData = async (opts) => {
      if (!user.value) return;
      opts = opts || {};
      const silent = !!opts.silent;
      const force = !!opts.force;

      if (!silent) {
        loading.value = true;
        loadingMessage.value = '同步基本資料中...';
      }

      const url = gasApiUrl.value;
      if (!url) {
        if (!silent) loading.value = false;
        // 無 GAS 網址時不強制改分頁，保留使用者上次位置
        return;
      }

      try {
        // 0) SWR 分鍵先畫舊畫面（structure 可較久；requests 較短）
        const stale = window.GasApi.readSWR(currentSemester.value, {
          meta: 180000,
          structure: 300000,
          requests: 120000
        });
        if (stale) {
          applyInitialPayload(stale);
          loadingMessage.value = '正在更新最新資料...';
        }

        // 1) meta：SWR 新鮮且非 force 時略過（減少雙次請求）
        const skipMeta = !force && !!stale && !!(stale.teachers || stale.semesters);
        if (!skipMeta) {
          try {
            const meta = await fetchMetaData({ semesterId: currentSemester.value });
            if (meta.semesters) {
              semestersList.value = meta.semesters.map(s => window.FieldMap.mapSemester(s));
              semestersList.value.sort((a, b) => a.id.localeCompare(b.id));
            }
            if (meta.teachers) {
              teachersList.value = meta.teachers.map(t => window.FieldMap.mapTeacher(t));
            }
            if (meta.settings) applySettings(meta.settings);
            await resolveUserRoleFromTeachers();
            loadingMessage.value = '同步課表與異動中...';
          } catch (metaErr) {
            console.warn('meta 載入失敗，改拉全量：', metaErr);
          }
        }

        // 2) 全量：課表 + 異動 + 申請
        const res = await fetchInitialData({
          semesterId: currentSemester.value,
          force: force
        });
        applyInitialPayload(res);
        await resolveUserRoleFromTeachers();
        resolvePendingClassView();
        if (!silent) loading.value = false;
      } catch (err) {
        console.error("載入調代課系統資料失敗：", err);
        if (!silent) {
          showToast("載入資料失敗：" + err.message, 'error');
          loading.value = false;
        }
      }
    };

    const cellFromGrid = (email, day, period) => {
      const a = getTimetableApi();
      return a ? a.cellFromGrid(email, day, period) : null;
    };

    // 連線設定固定內建，不寫入／不讀取 localStorage
    const saveClientSettings = () => {
      showToast('連線設定已固定，無法於介面修改', 'info');
    };


    // 切換學期
    watch(currentSemester, (newSem, oldSem) => {
      if (newSem && newSem !== oldSem) {
        localStorage.setItem('jcjh_semester', newSem);
        loadWeeklyData();
      }
    });

    // 學期管理函數
    const openAddSemesterModal = () => {
      semesterModalMode.value = 'add';
      semesterForm.value = { id: '', name: '', startDate: '', endDate: '' };
      showSemesterModal.value = true;
    };

    const openEditSemesterModal = (sem) => {
      semesterModalMode.value = 'edit';
      semesterForm.value = { id: sem.id, name: sem.name, startDate: sem.startDate, endDate: sem.endDate };
      showSemesterModal.value = true;
    };

    const saveSemester = async () => {
      const form = semesterForm.value;
      if (!form.id.trim()) { showToast('請輸入學期代號（如 114-2）', 'info'); return; }
      loading.value = true;
      try {
        const data = {
          "學期代號": form.id.trim(),
          "學期名稱": form.name || form.id.trim(),
          "開始日期": form.startDate,
          "結束日期": form.endDate,
          "是否預設": semesterModalMode.value === 'add' ? "FALSE" : undefined
        };
        
        if (semesterModalMode.value === 'add') {
          const teachersToCopy = teachersList.value.map(t => ({
            "學期代號": form.id.trim(),
            "教師Email": t.email,
            "教師姓名": t.name,
            "授課科目": t.subject,
            "系統角色": t.role,
            "基本鐘點": t.baseHours
          }));
          data.teachersToCopy = teachersToCopy;
        }

        await callGasApi('saveSemester', data);
        showToast('✅ 學期已儲存！', 'success');
        showSemesterModal.value = false;
        await loadSemesters();
        await loadWeeklyData();
      } catch (e) {
        console.error('儲存學期失敗', e);
        showToast('❌ 儲存學期失敗：' + e.message, 'error');
      } finally {
        loading.value = false;
      }
    };
    

    const deleteSemester = async (semId) => {
      if (semId === currentSemester.value) {
        showToast('⚠️ 無法刪除目前使用中的學期，請先切換到其他學期', 'warning');
        return;
      }
      if (!await showConfirm(`確定要刪除學期「${semId}」及其所有資料嗎？此操作不可復原！`)) return;
      loading.value = true;
      try {
        await callGasApi('deleteSemester', { semesterId: semId });
        showToast('✅ 學期已刪除', 'success');
        await loadSemesters();
      } catch (e) {
        console.error('刪除學期失敗', e);
        showToast('❌ 刪除學期失敗：' + e.message, 'error');
      } finally {
        loading.value = false;
      }
    };
    

    const setDefaultSemester = async (semId) => {
      loading.value = true;
      try {
        await callGasApi('setDefaultSemester', { semesterId: semId });
        showToast('✅ 已將「' + (semestersList.value.find(s => s.id === semId)?.name || semId) + '」設為預設學期', 'success');
        await loadSemesters();
      } catch (e) {
        console.error('設定預設學期失敗', e);
        showToast('❌ 設定失敗：' + e.message, 'error');
      } finally {
        loading.value = false;
      }
    };

    // ── 班級空堂事件管理（ui-activity.js → UiClassAwayAdmin）──
    const {
      showClassAwayModal, classAwayModalMode, classAwayForm,
      openAddClassAwayModal, openEditClassAwayModal, toggleClassAwayFormClass,
      isClassAwayFormClassSelected, selectClassAwayGrade, saveClassAwayEvent, deleteClassAwayEvent
    } = window.UiClassAwayAdmin.create({
      ref,
      callGasApi,
      showToast,
      showConfirm,
      classAwayEvents,
      classList,
      currentSemester,
      loading,
      clearScheduleCache,
      softRefreshInBackground
    });

    // ── 活動互代 ↔ 空堂橋接（ui-activity.js → UiMutualBridge）──
    const {
      mutualImportableEvents, mutualImportEventId,
      applyClassAwayEventById, applyClassAwayToMutualPanel, mutualCoverStats
    } = window.UiMutualBridge.create({
      ref,
      computed,
      showToast,
      classAwayEvents,
      classList,
      semesterEndDate,
      mutualActivityStart,
      mutualActivityEnd,
      mutualAwayClasses,
      mutualNote,
      mutualLeadEmails,
      mutualDrafts,
      isMutualCover,
      batchSlots,
      allSchedules,
      requestsList,
      teachersList,
      currentWeekDates,
      getScheduleForDate,
      persistMutualPanelDraft,
      clearScheduleCache,
      ensureMutualActivityRange,
      DAC
    });

    // ════════════════════════════════════════
    // §6 後台：核准 / 匯入 / 教師 / 課表編輯
    // ════════════════════════════════════════

    // ── 待辦摘要 / 格子白話 / 行政批次 ──
    // 請假課堂：2026-07-23（四）第3節 · 804 走讀
    /** 類型旁標籤：經費／第8節（不進「狀態」欄） */
    const getRequestTypeTags = (req) => {
      if (!req) return [];
      const tags = [];
      const period = parseInt(req.requestPeriod != null ? req.requestPeriod : req.period, 10);
      if (req.type !== 'exchange' && isQuotaDeductFee(req.subFee)) {
        tags.push({ key: 'quota', label: '扣額度' });
      } else if (req.type !== 'exchange' && req.subFee === ACTIVITY_PUBLIC_FEE) {
        tags.push({ key: 'actpub', label: '活動公費' });
      } else if (req.type !== 'exchange' && (req.subFee === '公費代課' || req.subFee === '學校移撥' || req.subFee === '活動公費')) {
        tags.push({ key: 'public', label: '公費' });
      }
      if (period === 8) tags.push({ key: 'p8', label: '第8節' });
      return tags;
    };
    // 相容舊呼叫（快速待辦等）
    const getRequestRiskTags = (req) => getRequestTypeTags(req);

    // 歷史紀錄列 → 請假課堂字串
    const _fmtSlot = (dateStr, day, period, clsSubj) => {
      const m = dateStr && dateStr !== '—' && dateStr.length >= 10 ? dateStr.slice(5, 10).replace('-', '/') : (dateStr || '—');
      return `${m}(${day || '—'})第${period}節` + (clsSubj ? ` · ${clsSubj}` : '');
    };
    /** 同節先前義務（此人為 actual 的代課／調入），excludeId 排除本筆 */
    const findPriorDutyAtSlot = (email, dateStr, period, excludeId) => {
      const em = String(email || '').toLowerCase();
      const p = parseInt(period, 10);
      const dk = String(dateStr || '');
      if (!em || !dk || Number.isNaN(p)) return null;
      const all = substitutionRecords.value || [];
      for (let i = all.length - 1; i >= 0; i--) {
        const s = all[i];
        if (!s || (excludeId && s.id === excludeId)) continue;
        if (String(s.date) !== dk || parseInt(s.period, 10) !== p) continue;
        if (s.actualTeacherEmail && String(s.actualTeacherEmail).toLowerCase() === em
            && (s.className || s.subject)) {
          return s;
        }
      }
      return null;
    };

    /**
     * 歷史「請假課堂」班科：
     * 1) 申請單／歷史列已寫的 className+subject（請假課堂本身）
     * 2) 同節先前代課義務（空堂代生物再調出）
     * 3) 請假師該節基礎課（不可用專長欄當主標）
     */
    const resolveHistoryLeaveClassSubject = (rec) => {
      if (!rec) return { className: '', subject: '', priorDuty: null };
      const dateStr = String(rec.requestDate || rec.date || '');
      const period = rec.requestPeriod != null ? rec.requestPeriod : rec.period;
      const p = parseInt(period, 10);
      const em = String(rec.originalTeacherEmail || rec.requesterEmail || '').toLowerCase();
      // 歷史 mapped 列已對齊請假班科時直接用
      let clsName = String(rec.className || '').trim();
      let subj = String(rec.subject || '').trim();
      if (clsName && subj) {
        return { className: clsName, subject: subj, priorDuty: null };
      }
      if (!em || !dateStr || Number.isNaN(p)) {
        return { className: clsName, subject: subj, priorDuty: null };
      }
      const priorDuty = findPriorDutyAtSlot(em, dateStr, period, rec.id);
      // 僅「代課義務」覆蓋；對調 edge 上 className 是對方帶來的課，不可當請假課堂
      if (priorDuty && (priorDuty.type === 'substitution' || priorDuty.type === '代課')) {
        return {
          className: priorDuty.className || clsName,
          subject: priorDuty.subject || subj,
          priorDuty
        };
      }
      let dayNum = null;
      const d = new Date(dateStr.replace(/-/g, '/'));
      if (!Number.isNaN(d.getTime())) dayNum = d.getDay() === 0 ? 7 : d.getDay();
      const base = typeof findBaseScheduleSlot === 'function'
        ? findBaseScheduleSlot(em, dayNum, period, dateStr)
        : null;
      if (!clsName && base) clsName = base.className || '';
      if (!subj && base) subj = base.subject || '';
      return { className: clsName, subject: subj, priorDuty: null };
    };

    /** 有效課的綁課：義務課看原課老師該節限制；否則看本師基礎 */
    const resolveRestrictionForHistoryRec = (rec, side) => {
      // side: 'leave' | 'exchange'
      if (!rec) return false;
      let dateStr, period, email, excludeId, prior;
      if (side === 'exchange') {
        dateStr = rec.targetDate || '';
        period = rec.targetPeriod;
        // peer 列：原師＝對方
        if (rec.requestId) {
          const peer = (substitutionRecords.value || []).find(x =>
            x && x.requestId === rec.requestId && x.id !== rec.id
          );
          if (peer) {
            dateStr = peer.date || dateStr;
            period = peer.period != null ? peer.period : period;
            email = peer.originalTeacherEmail;
            excludeId = peer.id;
            prior = findPriorDutyAtSlot(email, dateStr, period, excludeId);
            if (prior) {
              // 義務課綁課＝義務原師在該節的基礎限制
              let dayNum = null;
              const d = new Date(String(dateStr).replace(/-/g, '/'));
              if (!Number.isNaN(d.getTime())) dayNum = d.getDay() === 0 ? 7 : d.getDay();
              const base = findBaseScheduleSlot(prior.originalTeacherEmail, dayNum, period, dateStr);
              return cellIsRestricted(base);
            }
            let dayNum2 = null;
            const d2 = new Date(String(dateStr).replace(/-/g, '/'));
            if (!Number.isNaN(d2.getTime())) dayNum2 = d2.getDay() === 0 ? 7 : d2.getDay();
            return cellIsRestricted(findBaseScheduleSlot(email, dayNum2, period, dateStr));
          }
        }
        email = rec.actualTeacherEmail || rec.targetTeacherEmail;
        dateStr = rec.targetDate || dateStr;
        period = rec.targetPeriod != null ? rec.targetPeriod : period;
      } else {
        dateStr = rec.requestDate || rec.date || '';
        period = rec.requestPeriod != null ? rec.requestPeriod : rec.period;
        email = rec.originalTeacherEmail || rec.requesterEmail;
        excludeId = rec.id;
        prior = findPriorDutyAtSlot(email, dateStr, period, excludeId);
        if (prior) {
          let dayNum = null;
          const d = new Date(String(dateStr).replace(/-/g, '/'));
          if (!Number.isNaN(d.getTime())) dayNum = d.getDay() === 0 ? 7 : d.getDay();
          // 空堂代生物再調出：綁課看「生物」原課老師該節，不是 A 的數學
          const base = findBaseScheduleSlot(prior.originalTeacherEmail, dayNum, period, dateStr);
          return cellIsRestricted(base);
        }
      }
      if (!email || !dateStr || period == null) return false;
      let dayNum = null;
      const d = new Date(String(dateStr).replace(/-/g, '/'));
      if (!Number.isNaN(d.getTime())) dayNum = d.getDay() === 0 ? 7 : d.getDay();
      return cellIsRestricted(findBaseScheduleSlot(email, dayNum, period, dateStr));
    };

    /** 請假節是否為「再異動」（原師同節有先前義務） */
    const isHistoryLeaveRechanged = (rec) => {
      if (!rec) return false;
      const dateStr = String(rec.date || rec.requestDate || '');
      const period = rec.period != null ? rec.period : rec.requestPeriod;
      const em = rec.originalTeacherEmail || rec.requesterEmail;
      return !!findPriorDutyAtSlot(em, dateStr, period, rec.id);
    };

    /** 對調節是否為「再異動」（對方該節已是義務／異動格） */
    const isHistoryExchangeRechanged = (rec) => {
      if (!rec || (rec.type !== 'exchange' && rec.type !== '對調')) return false;
      let peerDate = rec.targetDate;
      let peerPeriod = rec.targetPeriod;
      let peerOrig = rec.actualTeacherEmail || rec.targetTeacherEmail;
      let peerExclude = null;
      if (rec.requestId) {
        const peer = (substitutionRecords.value || []).find(x =>
          x && x.requestId === rec.requestId && x.id !== rec.id
        );
        if (peer) {
          peerDate = peer.date || peerDate;
          peerPeriod = peer.period != null ? peer.period : peerPeriod;
          peerOrig = peer.originalTeacherEmail || peerOrig;
          peerExclude = peer.id;
        }
      }
      if (findPriorDutyAtSlot(peerOrig, peerDate, peerPeriod, peerExclude)) return true;
      if (!peerDate || peerPeriod == null) return false;
      const all = substitutionRecords.value || [];
      const p = parseInt(peerPeriod, 10);
      const dk = String(peerDate);
      const be = String(peerOrig || '').toLowerCase();
      return all.some(s => {
        if (!s || (peerExclude && s.id === peerExclude)) return false;
        if (String(s.date) !== dk || parseInt(s.period, 10) !== p) return false;
        const o = String(s.originalTeacherEmail || '').toLowerCase();
        const a = String(s.actualTeacherEmail || '').toLowerCase();
        return be && (o === be || a === be);
      });
    };

    /** 申請單：對調目標節是否再異動（進行中列表用） */
    const isRequestExchangeRechanged = (req) => {
      if (!req || (req.type !== 'exchange' && req.type !== '對調')) return false;
      if (!req.targetTeacherEmail || !req.targetDate) return false;
      if (findPriorDutyAtSlot(req.targetTeacherEmail, req.targetDate, req.targetPeriod, null)) return true;
      const all = substitutionRecords.value || [];
      const p = parseInt(req.targetPeriod, 10);
      const dk = String(req.targetDate);
      const be = String(req.targetTeacherEmail).toLowerCase();
      return all.some(s => {
        if (!s) return false;
        if (String(s.date) !== dk || parseInt(s.period, 10) !== p) return false;
        const o = String(s.originalTeacherEmail || '').toLowerCase();
        const a = String(s.actualTeacherEmail || '').toLowerCase();
        return o === be || a === be;
      });
    };

    const formatHistoryLeaveSlot = (rec) => {
      if (!rec) return '—';
      const dateStr = rec.requestDate || rec.date || '';
      const period = rec.requestPeriod != null ? rec.requestPeriod : rec.period;
      let dayNum = null;
      if (dateStr) {
        const d = new Date(String(dateStr).replace(/-/g, '/'));
        if (!Number.isNaN(d.getTime())) dayNum = d.getDay() === 0 ? 7 : d.getDay();
      }
      const day = dayNum != null ? getWeekDayText(dayNum) : '—';
      const resolved = resolveHistoryLeaveClassSubject(rec);
      const cls = `${resolved.className || ''} ${resolved.subject || ''}`.trim();
      return _fmtSlot(dateStr, day, period, cls || '');
    };
    /**
     * 對調目標節：受邀人在該日該節的「有效課」
     * 含已核准調入／代課；不可只查基礎課表（調入格無基礎列會查空）
     */
    const resolveExchangeTargetCell = (teacherEmail, dateStr, period, dayOfWeek) => {
      if (!teacherEmail || period == null || period === '') return null;
      let dayNum = dayOfWeek;
      if ((dayNum == null || dayNum === '') && dateStr) {
        const d = new Date(String(dateStr).replace(/-/g, '/'));
        if (!Number.isNaN(d.getTime())) dayNum = d.getDay() === 0 ? 7 : d.getDay();
      }
      // 1) 有效課表（含已核准異動＋pending 疊加）
      if (dateStr && typeof getScheduleForDate === 'function') {
        try {
          const cell = getScheduleForDate(teacherEmail, dateStr, period, dayNum);
          if (cell && (cell.className || cell.subject) && !cell.isSubstituted) return cell;
          // 調出格：用 subRecord 對側資訊不夠；優先找 isSubstitutionDuty
          if (cell && cell.isSubstitutionDuty) return cell;
        } catch (e) { /* timetable 未就緒 */ }
      }
      if (dateStr && typeof getApprovedScheduleForDate === 'function') {
        try {
          const cell = getApprovedScheduleForDate(teacherEmail, dateStr, period, dayNum);
          if (cell && (cell.className || cell.subject) && !cell.isSubstituted) return cell;
          if (cell && cell.isSubstitutionDuty) return cell;
        } catch (e2) { /* ignore */ }
      }
      // 2) 基礎課表（含單雙週）
      return findBaseScheduleSlot(teacherEmail, dayNum, period, dateStr);
    };

    const formatHistoryExchangeSlot = (rec) => {
      if (!rec || (rec.type !== 'exchange' && rec.type !== '對調')) return '—';
      let targetDate = rec.targetDate;
      let targetPeriod = rec.targetPeriod;
      let clsName = String(rec.targetClassName || '').trim();
      let subj = String(rec.targetSubject || '').trim();
      // 有完整 target 班科（mapped 已對齊）直接顯示
      if (targetDate && targetDate !== '---' && targetDate !== '—' && (clsName || subj)) {
        let dayNum = null;
        const d = new Date(String(targetDate).replace(/-/g, '/'));
        if (!Number.isNaN(d.getTime())) dayNum = d.getDay() === 0 ? 7 : d.getDay();
        const day = dayNum != null ? getWeekDayText(dayNum) : '—';
        const cls = `${clsName} ${subj}`.trim();
        return _fmtSlot(targetDate, day, targetPeriod, cls || '');
      }
      // 備援：peer _2 的 className＝受邀人帶來的課＝對調課堂
      let peerLeaveEdge = null;
      if (rec.requestId) {
        const peers = (substitutionRecords.value || []).filter(x =>
          x && x.requestId === rec.requestId
        );
        peerLeaveEdge = peers.find(x => String(x.id || '').endsWith('_2'))
          || peers.find(x => x.id !== rec.id)
          || null;
        if (peerLeaveEdge) {
          if (!targetDate || targetDate === '---' || targetDate === '—') {
            // 若 rec 是 leave edge，peer 應是 target edge
            const targetEdge = peers.find(x => String(x.id || '').endsWith('_1'))
              || peers.find(x => x.id !== peerLeaveEdge.id);
            if (targetEdge) {
              targetDate = targetEdge.date;
              targetPeriod = targetEdge.period;
            }
          }
          if (!clsName) clsName = String(peerLeaveEdge.className || '').trim();
          if (!subj) subj = String(peerLeaveEdge.subject || '').trim();
        }
      }
      // 再備援：受邀人目標節基礎課
      if ((!clsName || !subj) && rec.actualTeacherEmail && targetDate && targetPeriod != null) {
        let dayNum = null;
        const d2 = new Date(String(targetDate).replace(/-/g, '/'));
        if (!Number.isNaN(d2.getTime())) dayNum = d2.getDay() === 0 ? 7 : d2.getDay();
        const cell = resolveExchangeTargetCell(
          rec.actualTeacherEmail, targetDate, targetPeriod, dayNum
        );
        if (cell) {
          if (!clsName) clsName = cell.className || '';
          if (!subj) subj = cell.subject || '';
        }
      }
      let dayNumOut = null;
      if (targetDate && targetDate !== '—' && targetDate !== '---') {
        const d3 = new Date(String(targetDate).replace(/-/g, '/'));
        if (!Number.isNaN(d3.getTime())) dayNumOut = d3.getDay() === 0 ? 7 : d3.getDay();
      }
      const day = dayNumOut != null ? getWeekDayText(dayNumOut) : '—';
      const cls = `${clsName} ${subj}`.trim();
      return _fmtSlot(targetDate, day, targetPeriod, cls || '');
    };

    /**
     * 基礎課表格（未疊代課）
     * @param {string} [dateStr] 有日期時依單／雙週挑選
     */
    const findBaseScheduleSlot = (email, dayOfWeek, period, dateStr) => {
      if (!email || dayOfWeek == null || dayOfWeek === '' || period == null || period === '') return null;
      const em = String(email).toLowerCase();
      const dow = parseInt(dayOfWeek, 10);
      const p = parseInt(period, 10);
      if (Number.isNaN(dow) || Number.isNaN(p)) return null;
      let cands = [];
      const idx = scheduleIndex.value;
      if (idx && window.DomainSchedule && window.DomainSchedule.getCandidates) {
        cands = window.DomainSchedule.getCandidates(idx, em, dow, p, allSchedules.value) || [];
      } else {
        cands = (allSchedules.value || []).filter(s =>
          s.teacherEmail && String(s.teacherEmail).toLowerCase() === em
          && parseInt(s.dayOfWeek, 10) === dow
          && parseInt(s.period, 10) === p
        );
      }
      if (!cands.length) return null;
      if (dateStr && typeof isSingleWeek === 'function') {
        const single = isSingleWeek(dateStr);
        const byWeek = cands.find(s => {
          if (s.attr === '單週') return single;
          if (s.attr === '雙週') return !single;
          return false;
        });
        if (byWeek) return byWeek;
      }
      return cands.find(s => s.attr !== '單週' && s.attr !== '雙週') || cands[0];
    };
    const cellIsRestricted = (cell) => !!(cell && (cell.restriction === 'restricted' || cell.restriction === '限制'));
    const isLeaveClassRestricted = (req) => {
      if (!req || !req.requesterEmail || !req.requestPeriod) return false;
      // 申請中：以請假人該節有效義務／基礎限制
      const prior = findPriorDutyAtSlot(
        req.requesterEmail, req.requestDate, req.requestPeriod, null
      );
      let dayNum = req.requestPeriodDay;
      if ((dayNum == null || dayNum === '') && req.requestDate) {
        const d = new Date(String(req.requestDate).replace(/-/g, '/'));
        if (!Number.isNaN(d.getTime())) dayNum = d.getDay() === 0 ? 7 : d.getDay();
      }
      if (prior) {
        return cellIsRestricted(
          findBaseScheduleSlot(prior.originalTeacherEmail, dayNum, req.requestPeriod, req.requestDate)
        );
      }
      return cellIsRestricted(
        findBaseScheduleSlot(req.requesterEmail, dayNum, req.requestPeriod, req.requestDate)
      );
    };
    const isExchangeClassRestricted = (req) => {
      if (!req || req.type !== 'exchange' || !req.targetTeacherEmail || !req.targetPeriod) return false;
      let dayNum = req.targetDayOfWeek;
      if ((dayNum == null || dayNum === '') && req.targetDate) {
        const d = new Date(String(req.targetDate).replace(/-/g, '/'));
        if (!Number.isNaN(d.getTime())) dayNum = d.getDay() === 0 ? 7 : d.getDay();
      }
      const prior = findPriorDutyAtSlot(
        req.targetTeacherEmail, req.targetDate, req.targetPeriod, null
      );
      if (prior) {
        return cellIsRestricted(
          findBaseScheduleSlot(prior.originalTeacherEmail, dayNum, req.targetPeriod, req.targetDate)
        );
      }
      return cellIsRestricted(
        findBaseScheduleSlot(req.targetTeacherEmail, dayNum, req.targetPeriod, req.targetDate)
      );
    };
    const isHistoryLeaveRestricted = (rec) => {
      if (!rec) return false;
      // history 列可能只有 date/period
      const dateStr = rec.requestDate || rec.date;
      const period = rec.requestPeriod != null ? rec.requestPeriod : rec.period;
      if (!rec.originalTeacherEmail || !dateStr || period == null) return false;
      return resolveRestrictionForHistoryRec(
        Object.assign({}, rec, { requestDate: dateStr, requestPeriod: period }),
        'leave'
      );
    };
    const isHistoryExchangeRestricted = (rec) => {
      if (!rec || rec.type !== 'exchange' || !rec.targetDate || rec.targetDate === '—' || rec.targetPeriod == null) {
        return false;
      }
      return resolveRestrictionForHistoryRec(rec, 'exchange');
    };

    const formatLeaveClassSlot = (req) => {
      if (!req) return '—';
      const day = getWeekDayText(req.requestPeriodDay);
      const m = req.requestDate ? req.requestDate.slice(5, 10).replace('-', '/') : '—';
      const cls = `${req.className || ''} ${req.subject || ''}`.trim();
      return `${m}(${day})第${req.requestPeriod}節` + (cls ? ` · ${cls}` : '');
    };
    // 對調課堂：受邀人在目標節的有效班／科（含調入／代課）；勿回退申請人班科
    const formatExchangeClassSlot = (req) => {
      if (!req || req.type !== 'exchange') return '—';
      let dayNum = req.targetDayOfWeek;
      if ((dayNum == null || dayNum === '') && req.targetDate) {
        const d = new Date(String(req.targetDate).replace(/-/g, '/'));
        if (!Number.isNaN(d.getTime())) dayNum = d.getDay() === 0 ? 7 : d.getDay();
      }
      const day = getWeekDayText(dayNum);
      const cell = resolveExchangeTargetCell(
        req.targetTeacherEmail,
        req.targetDate,
        req.targetPeriod,
        dayNum
      );
      const clsName = cell ? (cell.className || '') : (req.targetClassName || '');
      const subj = cell ? (cell.subject || '') : (req.targetSubject || '');
      const cls = `${clsName} ${subj}`.trim();
      const m = req.targetDate && String(req.targetDate).length >= 10
        ? String(req.targetDate).slice(5, 10).replace('-', '/')
        : (req.targetDate || '—');
      return `${m}(${day || '—'})第${req.targetPeriod}節` + (cls ? ` · ${cls}` : '');
    };

    const formatRequestSummary = (req) => {
      if (!req) return '（無申請資料）';
      const isEx = req.type === 'exchange';
      const typeLabel = isEx ? '調課' : '代課';
      const period = parseInt(req.requestPeriod, 10);
      const risks = [];
      if (!isEx && isQuotaDeductFee(req.subFee)) risks.push('扣額度');
      else if (!isEx && (req.subFee === '公費代課' || req.subFee === '學校移撥' || req.subFee === '活動公費')) risks.push('公費');
      if (period === 8) risks.push('第8節');
      if (isEx && req.targetDate && req.requestDate && req.targetDate !== req.requestDate) risks.push('跨日調課');
      if (isEx && req.targetDayOfWeek && req.requestPeriodDay &&
          parseInt(req.targetDayOfWeek) !== parseInt(req.requestPeriodDay)) risks.push('跨週調課');

      let s = `【${typeLabel}】${req.serial || '—'}\n`;
      s += `${req.requesterName || '—'} → ${req.targetTeacherName || '—'}\n`;
      s += `請假：${formatLeaveClassSlot(req)}\n`;
      if (isEx) {
        s += `對調：${formatExchangeClassSlot(req)}\n`;
        s += `經費：無`;
      } else {
        s += `經費：${req.subFee || '—'} · 事由：${req.reason || '—'}`;
      }
      if (req.note) s += `\n備註：${req.note}`;
      if (risks.length) s += `\n⚠ ${risks.join('、')}`;
      return s;
    };

    // ── 簽核／行政核准（ui-approval.js → UiApproval）──
    const {
      selectedAdminPendingIds, lastBatchPrintIds, showBatchPrintPrompt,
      findRequestById, isAdminPendingSelected, toggleAdminPendingSelect,
      toggleSelectAllAdminPending, clearAdminPendingSelection,
      checkUrlCallback, respondToRequest, respondToBatch,
      adminApprove, adminReject, batchAdminApprove, batchAdminReject,
      printLastBatchNotices, dismissBatchPrintPrompt,
      cancelRequest, deleteSubstitutionRecord
    } = window.UiApproval.create({
      ref,
      callGasApi,
      showToast,
      showConfirm,
      loading,
      loadingMessage,
      getStatusText,
      restoreMutualQuotaForRows,
      optimisticPatchRequestStatus,
      softRefreshInBackground,
      formatRequestSummary,
      printSelectedForms,
      applyClassViewFromUrl,
      resolvePendingClassView,
      mySentRequests,
      myPendingRequests,
      adminPendingRequests,
      allPendingRequests,
      requestsList,
      paginatedAdminPending,
      selectedRecordIds,
      activeTab,
      showDetailModal,
      detailRequest,
      detailSubRecord
    });


    const getRequestProgressSteps = (req) => {
      // 三階段：受邀 → 教學組 → 出單；教學組直接核准則略過「對方同意」
      const status = (req && req.status) || 'pending_teacher';
      const name = (req && req.targetTeacherName) || '受邀人';
      // 直接核准：狀態直接 approved，且從未經過 pending_admin（備註或 note 含直接／或建立後即核准）
      // 實務：directApprove 送出的單 status=approved，不會有 pending_admin 軌跡；
      // 用 note/reason 不易判斷，改以：approved 且（備註含「直接」或 createdAt 很新且無對方回覆痕跡）
      // 更穩：若申請 note 有 admin 直接相關，或 status 為 approved 且 requester 就是操作流程中
      // 最簡可靠：approved 時若 note 含「直接核准」標記，或 sub 有 directApprove 欄位
      const noteStr = String((req && req.note) || '');
      const isDirectApprove = status === 'approved' && (
        req.directApprove === true ||
        noteStr.indexOf('[直接核准]') >= 0 ||
        noteStr.indexOf('行政直接核准') >= 0 ||
        // 活動互代／admin 送出常無 pending_admin：若建立後狀態就是 approved 且沒有 teacher 同意時間
        (req.skipTeacherConfirm === true)
      );

      if (isDirectApprove || (status === 'approved' && req && req.forceDirectProgress)) {
        return {
          steps: [
            { key: 'admin', label: '教學組直接核准', short: '直接核准', done: true, current: false, fail: false },
            { key: 'done', label: '已出單生效', short: '出單', done: true, current: false, fail: false }
          ],
          active: 1,
          failed: false,
          summary: '教學組直接核准出單，課表已更新',
          overdue: false,
          overdueHint: ''
        };
      }

      const steps = [
        { key: 'invite', label: `等 ${name} 同意`, short: '受邀' },
        { key: 'admin', label: '等教學組核准', short: '行政' },
        { key: 'done', label: '已出單生效', short: '出單' }
      ];
      let active = 0;
      let summary = '';
      let overdue = false;
      let overdueHint = '';

      let ageDays = 0;
      if (req && req.createdAt) {
        const t = new Date(String(req.createdAt).replace(/-/g, '/'));
        if (!isNaN(t.getTime())) {
          ageDays = (Date.now() - t.getTime()) / (1000 * 60 * 60 * 24);
        }
      } else if (req && req.requestDate) {
        const t = new Date(String(req.requestDate).replace(/-/g, '/'));
        if (!isNaN(t.getTime())) {
          ageDays = (Date.now() - t.getTime()) / (1000 * 60 * 60 * 24);
        }
      }

      if (status === 'pending_teacher') {
        active = 0;
        summary = `目前：等待 ${name} 老師線上同意`;
        if (ageDays >= 2) {
          overdue = true;
          overdueHint = `已超過 ${Math.floor(ageDays)} 天未回覆，可再傳 LINE 或改請他人`;
        }
      } else if (status === 'pending_admin') {
        active = 1;
        summary = '目前：對方已同意，等待教學組核准出單';
        if (ageDays >= 2) {
          overdue = true;
          overdueHint = `已超過 ${Math.floor(ageDays)} 天待行政核准`;
        }
      } else if (status === 'approved') {
        // 若從未 pending_admin：多半是直接核准 → 兩步顯示
        // 無法從狀態機 100% 還原時，用「有對方同意過程」判斷：
        // 有 batch 邀請回覆軌跡較難；簡化：approved 且 note 無直接標記時仍顯示三步全完成
        active = 2;
        summary = '已核准生效，課表已更新';
      } else if (status === 'rejected') {
        return {
          steps: [{ key: 'rej', label: `${name} 已拒絕`, short: '拒絕', done: true, fail: true, current: false }],
          active: 0, failed: true, failLabel: '已拒絕',
          summary: `${name} 老師已拒絕此邀請`,
          overdue: false, overdueHint: ''
        };
      } else if (status === 'admin_rejected') {
        return {
          steps: [{ key: 'rej', label: '教學組已駁回', short: '駁回', done: true, fail: true, current: false }],
          active: 0, failed: true, failLabel: '已駁回',
          summary: '教學組已駁回此申請',
          overdue: false, overdueHint: ''
        };
      } else if (status === 'cancelled' || status === 'withdrawn') {
        const lab = status === 'withdrawn' ? '已撤回' : '已取消';
        return {
          steps: [{ key: 'can', label: lab, short: lab, done: true, fail: true, current: false }],
          active: 0, failed: true, failLabel: lab,
          summary: lab,
          overdue: false, overdueHint: ''
        };
      }
      return {
        steps: steps.map((st, i) => ({
          ...st,
          done: i < active || (i === active && status === 'approved'),
          current: i === active && status !== 'approved',
          fail: false
        })),
        active,
        failed: false,
        summary,
        overdue,
        overdueHint
      };
    };

    // 今日／本週儀表板
    const dashboardScope = ref('today'); // today | week
    const dashboardStats = computed(() => {
      const today = getTodayString();
      const weekDates = currentWeekDates.value || [];
      const w0 = weekDates[0] || today;
      const w4 = weekDates[4] || today;
      const inScope = (dateStr) => {
        if (!dateStr) return false;
        if (dashboardScope.value === 'today') return dateStr === today;
        return dateStr >= w0 && dateStr <= w4;
      };

      const myPend = myPendingRequests.value.length;
      const adminPend = isAdmin.value ? adminPendingRequests.value.length : 0;
      const mySentOpen = mySentRequests.value.filter(r =>
        r.status === 'pending_teacher' || r.status === 'pending_admin').length;

      const scopeSubs = substitutionRecords.value.filter(r => inScope(r.date));
      const scopeSubCount = scopeSubs.length;
      const scopePublic = scopeSubs.filter(r =>
        r.type === 'substitution' && (r.subFee === '公費代課' || r.subFee === '學校移撥' || r.subFee === '活動公費')).length;
      const scopeP8 = scopeSubs.filter(r => parseInt(r.period) === 8).length;
      const unprinted = scopeSubs.filter(r => !r.printed).length;

      return {
        myPend, adminPend, mySentOpen,
        scopeSubCount, scopePublic, scopeP8, unprinted,
        label: dashboardScope.value === 'today' ? '今日' : '本週'
      };
    });

    const getCellPlainStatus = (cell) => {
      // 空堂：不提示可調代課（空堂本身不能當申請來源）
      if (!cell) return '';
      const isPatrol = cell.isPatrol || cell.attr === '巡堂';
      if (isPatrol) return '巡堂';
      const cls = `${cell.className || ''} ${cell.subject || ''}`.trim();
      const head = cls || '有課';
      if (cell.isPending) {
        if (cell.pendingType === 'substitution_out') {
          return `${head}\n⏳ 請假申請中\n${cell.pendingText || '待對方或行政確認'}`;
        }
        if (cell.pendingType === 'substitution_in') {
          return `${head}\n⏳ 待代課\n${cell.pendingText || '請至待辦簽核'}`;
        }
        if (cell.pendingType === 'exchange_out') {
          return `${head}\n⏳ 調出申請中\n${cell.pendingText || ''}`;
        }
        if (cell.pendingType === 'exchange_in') {
          return `${head}\n⏳ 調入申請中\n${cell.pendingText || ''}`;
        }
        return `${head}\n${cell.pendingText || '申請處理中'}`;
      }
      if (cell.isSubstituted) {
        return cell.subType === 'exchange'
          ? `${head}\n⇄ 本節已調出\n${cell.subText || ''}`
          : `${head}\n➔ 本節請假（已代課）\n${cell.subText || ''}`;
      }
      if (cell.isSubstitutionDuty) {
        return cell.subType === 'exchange'
          ? `${head}\n⇄ 本節為調入課\n${cell.subText || ''}`
          : `${head}\n➔ 本節為代課\n${cell.subText || ''}`;
      }
      return head;
    };


    // 儲存 GAS / GSI 設定值
    // 登出
    const logout = () => {
      loading.value = true;
      localStorage.removeItem('jcjh_google_id_token');
      clearSWR();
      resetAppState();
      loading.value = false;
    };

    // Google 登入 (GSI 代替)
    const loginWithGoogle = () => {
      showToast("請點擊下方的 Google 官方登入按鈕進行安全驗證。", 'info');
    };


    // 列印多選
    /** 歷史勾選：只動 DOM checkbox，讀取時再同步 ref（避免 v-model 重繪長表） */
    const readHistoryCheckedIds = () => {
      const ids = [];
      try {
        document.querySelectorAll('.hist-select-cb:checked').forEach((el) => {
          const id = el.getAttribute('data-rec-id') || el.value;
          if (id) ids.push(id);
        });
      } catch (e) { /* ignore */ }
      return ids;
    };
    const syncHistorySelectionFromDom = () => {
      selectedRecordIds.value = readHistoryCheckedIds();
    };
    const toggleSelectAllRecords = (e) => {
      const on = !!(e && e.target && e.target.checked);
      try {
        document.querySelectorAll('.hist-select-cb').forEach((el) => {
          el.checked = on;
        });
      } catch (err) { /* ignore */ }
      // 延後寫 ref：列印／按鈕用；勾選當幀不重繪
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(syncHistorySelectionFromDom);
      } else {
        setTimeout(syncHistorySelectionFromDom, 0);
      }
    };
    // 單勾：原生 checkbox 已亮；延後同步 ref
    if (typeof document !== 'undefined') {
      document.addEventListener('change', (evt) => {
        const t = evt && evt.target;
        if (!t || !t.classList) return;
        if (t.classList.contains('hist-select-cb')) {
          if (typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(syncHistorySelectionFromDom);
          } else {
            syncHistorySelectionFromDom();
          }
        }
      }, true);
    }

    // 歷史紀錄分頁導航
    const changeHistoryPage = (n) => {
      historyPage.value = Math.max(1, Math.min(n, historyTotalPages.value));
    };

    // 管理員編輯歷史紀錄
    // 申請／編輯共用假別（順序即下拉顯示序；公費組在前）
    const leaveReasonOptions = [
      '公假', '婚假', '喪假', '產前假/分娩假', '身心調適假',
      '休假', '病假', '事假', '補休',
      '其他'
    ];

    // ── 後台匯入／教師／課表編輯（ui-admin.js → UiAdmin）──
    const {
      showImportTeachersModal, teacherExcelData, teacherExcelHeaders, teacherMappingFields,
      showScheduleEditModal, scheduleForm,
      showTeacherModal, teacherModalMode, teacherForm,
      excelData, excelHeaders, mappingFields,
      importSchedules, openScheduleEditModal, pickScheduleAttr, getSchedule,
      saveScheduleCell, clearScheduleCell, updateTeacherBaseHours,
      openAddTeacherModal, openEditTeacherModal, saveTeacher, deleteTeacher,
      handleTeacherExcelChange, importTeachersBatch, handleFileChange, getMappingLabel,
      openHistoryEditModal, saveHistoryEdit, onHistoryEditDateChange
    } = window.UiAdmin.create({
      ref,
      callGasApi,
      showToast,
      showConfirm,
      loading,
      loadingMessage,
      softRefreshInBackground,
      clearScheduleCache,
      loadWeeklyData,
      getTeacherNameByEmail,
      currentSemester,
      teachersList,
      allSchedules,
      leaveReasonOptions,
      historyEditForm,
      showHistoryEditModal,
      requestsList
    });

    // 預設公費：公假／婚假／喪假／產前假/分娩假／身心調適假
    const PUBLIC_FEE_REASONS = ['公假', '婚假', '喪假', '產前假/分娩假', '身心調適假'];
    const isPublicFeeReason = (reason) => {
      const r = String(reason || '').trim();
      if (!r) return false;
      if (PUBLIC_FEE_REASONS.includes(r)) return true;
      // 相容舊資料：公差、分娩假
      if (r.includes('公假') || r.includes('公差') || r.includes('婚假') || r.includes('喪假')) return true;
      if (r.includes('分娩') || r.includes('產前') || r.includes('身心調適')) return true;
      return false;
    };
    const defaultSubFeeForReason = (reason) => {
      if (isPeriod8FeeLocked.value) return PERIOD8_FEE;
      if (isMutualCover.value) return ACTIVITY_PUBLIC_FEE;
      return isPublicFeeReason(reason) ? '公費代課' : '自費代課';
    };
    /** 假別變更時自動帶入預設經費（第8節／活動模式不覆寫） */
    const onLeaveReasonChange = () => {
      if (pendingRequestData.value.mode !== 'substitution') return;
      if (isPeriod8FeeLocked.value) {
        pendingRequestData.value.subFee = PERIOD8_FEE;
        batchSubFee.value = PERIOD8_FEE;
        return;
      }
      if (isMutualCover.value) return;
      const reason = pendingRequestData.value.reason;
      if (!reason) return;
      pendingRequestData.value.subFee = defaultSubFeeForReason(reason);
      batchSubFee.value = pendingRequestData.value.subFee;
    };
    // 第8節：表單一開就鎖經費
    watch(
      () => [
        isPeriod8FeeLocked.value,
        pendingRequestData.value && pendingRequestData.value.mode,
        pendingRequestData.value && pendingRequestData.value.timeKey,
        pendingRequestData.value && pendingRequestData.value.isBatch
      ],
      () => {
        if (!isPeriod8FeeLocked.value) return;
        if (pendingRequestData.value.mode !== 'substitution') return;
        pendingRequestData.value.subFee = PERIOD8_FEE;
        batchSubFee.value = PERIOD8_FEE;
      }
    );
    const setMutualCover = (on) => { const a = getMutualPanelApi(); if (a) a.setMutualCover(on); };
    const mutualDraftKey = (leaveEmail, dateStr, period) =>
      (window.UiMutualPanelState && window.UiMutualPanelState.mutualDraftKey)
        ? window.UiMutualPanelState.mutualDraftKey(leaveEmail, dateStr, period)
        : (String(leaveEmail || '').toLowerCase() + '|' + dateStr + '|' + period);
    const getMutualDraftAt = (leaveEmail, dateStr, period) => {
      const a = getMutualPanelApi();
      return a ? a.getMutualDraftAt(leaveEmail, dateStr, period) : null;
    };
    const removeMutualDraft = (key) => { const a = getMutualPanelApi(); if (a) a.removeMutualDraft(key); };
    const clearMutualDrafts = () => { const a = getMutualPanelApi(); if (a) a.clearMutualDrafts(); };
    const assignMutualDraftFromMatch = (subEmail) => { const a = getMutualPanelApi(); if (a) a.assignMutualDraftFromMatch(subEmail); };

    /** 全部暫定一次送出（ui-activity.js → UiMutualSubmit） */
    const submitAllMutualDrafts = async () => {
      if (isSubmitting.value || loading.value) {
        showToast('申請送出中，請稍候…', 'info');
        return;
      }
      if (!window.UiMutualSubmit) {
        showToast('送出模組未載入', 'error');
        return;
      }
      await window.UiMutualSubmit.submitAllMutualDrafts({
        isMutualCover, mutualDrafts, mutualNote, mutualSkipNotify,
        showConfirm, showToast, loading, loadingMessage, isSubmitting, currentSemester,
        isAdmin, directApproveMode, callGasApi, optimisticUpsertRequest, sheetRequestToFront,
        deductMutualQuotaForRows, softRefreshInBackground, persistMutualPanelDraft, activityBalanceCtx,
        PERIOD8_FEE, ACTIVITY_PUBLIC_FEE, successModalTitle, successModalMessage,
        hasLineTemplate, lineBatchParts, lineCopyText, showSuccessModal, buildLineBatchInviteText, DAC
      });
    };
    const toggleMutualCover = () => { const a = getMutualPanelApi(); if (a) a.toggleMutualCover(); };

    // 面板勾選變更時自動暫存
    watch(mutualSkipNotify, () => { persistMutualPanelDraft(); });
    watch(mutualNote, () => { persistMutualPanelDraft(); });
    watch([mutualActivityStart, mutualActivityEnd], () => { persistMutualPanelDraft(); });

    const toggleMutualAwayClass = (cls) => { const a = getMutualPanelApi(); if (a) a.toggleMutualAwayClass(cls); };
    const selectAwayGrade = (grade) => { const a = getMutualPanelApi(); if (a) a.selectAwayGrade(grade); };
    // mutualCoverStats 已由 UiMutualBridge 提供

    // 待辦分頁
    const changePendingPage = (section, n) => {
      const maxPages = { pending: pendingMyPendingTotal, sent: pendingMySentTotal, admin: pendingAdminTotal };
      const refs = { pending: pendingMyPendingPage, sent: pendingMySentPage, admin: pendingAdminPage };
      const max = maxPages[section].value;
      refs[section].value = Math.max(1, Math.min(n, max));
    };

    const resetAppState = () => {
      user.value = null;
      userRole.value = 'teacher';
      // 登出不強制改分頁；重整／再登入仍依 localStorage 還原上次位置
      teachersList.value = [];
      allSchedules.value = [];
      substitutionRecords.value = [];
      mySentRequests.value = [];
      myPendingRequests.value = [];
      adminPendingRequests.value = [];
      showMatchModal.value = false;
    };

    /** 登入後還原分頁；公開班級連結與非管理員進 admin 時校正 */
    const restoreNavAfterLogin = () => {
      if (classReadonlyMode.value) {
        activeTab.value = 'class';
        return;
      }
      let tab = readStoredTab();
      if (tab === 'admin' && userRole.value !== 'admin') tab = 'timetable';
      activeTab.value = tab;
      adminSubTab.value = readStoredAdminSubTab();
      _navPersistReady = true;
      persistNavPosition();
    };

    // 模擬切換使用者身分 (僅限管理員 Dev 工具)
    const devSwitchUser = (email) => {
      if (!isAdmin.value && !isSimulating.value) return;
      // 如果點選的就是原管理員，直接還原
      if (originalUser.value && email === originalUser.value.email) {
        restoreAdmin();
        return;
      }
      const match = lookupTeacher(email);
      if (match) {
        if (!originalUser.value) {
          originalUser.value = { email: user.value.email, role: userRole.value };
        }
        user.value = {
          email: match.email,
          displayName: match.name + " (模擬)",
          photoURL: "https://www.gstatic.com/images/branding/product/1x/avatar_circle_blue_512dp.png"
        };
        userRole.value = match.role || 'teacher';
        loadWeeklyData();
      }
    };

    // 回到管理員身分
    const restoreAdmin = () => {
      if (!originalUser.value) return;
      user.value = {
        email: originalUser.value.email,
        displayName: "管理員 (已還原)",
        photoURL: "https://www.gstatic.com/images/branding/product/1x/avatar_circle_blue_512dp.png"
      };
      userRole.value = originalUser.value.role;
      originalUser.value = null;
      loadWeeklyData();
    };

    onMounted(async () => {
      checkMobile();
      initMobileDay();
      window.addEventListener('resize', checkMobile);

      // 連線設定固定內建（setup 開頭已清除舊 localStorage 鍵，不在此覆寫）

      // 還原活動互代面板暫存（期間／外出班／帶隊／暫定）
      try {
        const saved = restoreMutualPanelDraft();
        if (saved) applyMutualPanelDraft(saved);
      } catch (e) { /* ignore */ }

      // 先解析班級唯讀深連結
      const hasClassLink = applyClassViewFromUrl();

      // 檢查是否已有登入之 Google ID Token 快取
      const idToken = localStorage.getItem('jcjh_google_id_token');
      if (idToken && !isTokenExpired(idToken)) {
        const payload = decodeJwt(idToken);
        if (payload) {
          if (!assertSchoolDomain(payload)) return;
          user.value = {
            email: payload.email,
            displayName: payload.name,
            photoURL: payload.picture
          };
          loading.value = true;
          loadingMessage.value = '同步系統中...';
          
          await loadWeeklyData();
          await checkUrlCallback(user.value);
          // 資料載入與簽核 callback 後再還原分頁，避免被中間流程蓋掉
          if (!hasClassLink && !classReadonlyMode.value) restoreNavAfterLogin();
          else _navPersistReady = true;
          
          if (!localStorage.getItem('jcjh_onboarding_v2') && !classReadonlyMode.value) {
            setTimeout(() => startOnboarding(), 800);
          }
        } else {
          localStorage.removeItem('jcjh_google_id_token');
          // 勿呼叫 resetAppState：會清掉 classReadonlyMode
          user.value = null;
          if (hasClassLink) {
            await loadPublicClassData(pendingClassView.value || selectedClass.value);
          } else {
            loading.value = false;
            restoreNavAfterLogin();
          }
        }
      } else {
        localStorage.removeItem('jcjh_google_id_token');
        user.value = null;
        // 免登入：?class=701 直接載入公開班級課表
        if (hasClassLink) {
          await loadPublicClassData(pendingClassView.value || selectedClass.value);
        } else {
          loading.value = false;
          restoreNavAfterLogin();
        }
      }

      // 初始化 Google Sign-in 與 One Tap（公開唯讀時不強制 One Tap）
      if (googleClientId.value && typeof google !== 'undefined' && !classReadonlyMode.value) {
        window.handleCredentialResponse = async (response) => {
          const token = response.credential;
          localStorage.setItem('jcjh_google_id_token', token);
          const payload = decodeJwt(token);
          if (payload) {
            if (!assertSchoolDomain(payload)) return;
            user.value = {
              email: payload.email,
              displayName: payload.name,
              photoURL: payload.picture
            };
            loading.value = true;
            loadingMessage.value = '登入成功，同步系統中...';
            
            await loadWeeklyData();
            await checkUrlCallback(user.value);
            if (!classReadonlyMode.value) restoreNavAfterLogin();
            else _navPersistReady = true;
            
            if (!localStorage.getItem('jcjh_onboarding_v2')) {
              setTimeout(() => startOnboarding(), 800);
            }
          }
        };

        google.accounts.id.initialize({
          client_id: googleClientId.value,
          callback: window.handleCredentialResponse,
          auto_select: true,
          cancel_on_tap_outside: false
        });
        _gsiInitialized = true;

        // 嘗試在背景無感自動登入
        google.accounts.id.prompt();

        // A：定時檢查 Token，快過期就靜默換票（約每 4 分鐘）
        const tokenKeepAlive = () => {
          try {
            const tok = localStorage.getItem('jcjh_google_id_token');
            if (!tok || !user.value) return;
            if (typeof isTokenExpiringSoon === 'function' && isTokenExpiringSoon(tok, 6 * 60 * 1000)) {
              refreshGoogleIdToken().catch(() => {});
            }
          } catch (e) { /* ignore */ }
        };
        setInterval(tokenKeepAlive, 4 * 60 * 1000);
        // 頁面重新可見時也檢查一次
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible') tokenKeepAlive();
        });

        // 嘗試在 UI 容器渲染按鈕
        setTimeout(() => {
          const btnContainer = document.getElementById("gsi-button-container");
          if (btnContainer && typeof google !== 'undefined') {
            google.accounts.id.renderButton(
              btnContainer,
              { theme: "outline", size: "large", width: 280 }
            );
          }
        }, 500);
      }
    });
    


    const closeSuccessGoPending = () => {
      showSuccessModal.value = false;
      activeTab.value = 'pending';
    };
    const closeSuccessStayTimetable = () => {
      showSuccessModal.value = false;
      activeTab.value = 'timetable';
      showMatchModal.value = false;
      showCompareModal.value = false;
    };
    const closeSuccessCopyLine = async () => {
      if (hasLineTemplate.value && lineCopyText.value) {
        await copyLineMessage();
      }
      // 保持 Modal 開啟或關閉皆可；複製後仍可選其他按鈕
    };

    // 返回 Vue 拋出變數
    return {
      user, userRole, loading, loadingMessage, activeTab, setActiveTab, isSimulating, originalUser, avatarSrc, handleAvatarError, avatarSrc, handleAvatarError,
      visibleTimetableTeachers, ttPage, ttPageSize, ttTotalPages, ttNeedPager, changeTtPage,
      requestWindowInfo, historyFullLoaded, historyLoadingFull, historyLoadedMonths, historyMonthLoading,
      loadHistoryMonth, setHistoryFilterMode, ensureHistoryMonthLoaded, loadFullSemesterHistory, reloadWindowedHistory,
      selectedMobileDay, isMobile, checkMobile, initMobileDay,
      currentSemester, availableSemesters, currentSemesterName, semestersList, showSemesterModal, semesterModalMode, semesterForm,
      currentWeekDates, selectedWeekDate, currentWeekNumber,
      classList, classSchedules, selectedClass, classReadonlyMode, getClassReadonlyLink, copyClassReadonlyLink,
      searchQuery, selectedSubject, teachersList, allSchedules, substitutionRecords, requestsList,
      mySentRequests, myPendingRequests, adminPendingRequests, allPendingRequests,
      matchMode, activeCell, inputRequestDate, recommendedTeachers, recommendationLoading,
      batchSelectMode, batchSlots, showBatchConfirmModal, batchSubTeacher, batchReason, batchSubFee, batchNote,
      isMutualCover, toggleMutualCover, setMutualCover, MUTUAL_COVER_FEE, ACTIVITY_PUBLIC_FEE, QUOTA_DEDUCT_FEE, PERIOD8_FEE,
      mutualAwayClasses, mutualActivityStart, mutualActivityEnd, setMutualActivityThisWeek,
      toggleMutualAwayClass, selectAwayGrade, mutualCoverStats,
      mutualLeadEmails, toggleMutualLead, isMutualLead, onMutualLeadChipClick, jumpToTeacherTimetable,
      mutualSkipNotify, directApproveSkipNotify, mutualNote, mutualDrafts, getMutualDraftAt, removeMutualDraft, clearMutualDrafts,
      clearMutualPanel, assignMutualDraftFromMatch, submitAllMutualDrafts, recalculateMutualQuotasFromActivity,
      persistMutualPanelDraft, isAwayClassCell,
      batchAssignMode, batchActiveSlotKey, isBatchMatchFlow, isBatchPerSlotMode, batchAssignedCount, batchAllSlotsAssigned, batchActiveSlot,
      batchCompareViewEmail, batchCompareSubGroups, setBatchCompareViewEmail, resolveCompareBEmail,
      setBatchAssignMode, selectBatchSlotForMatch, assignBatchSlotSub, clearBatchSlotSub, prepBatchPerSlotCompare,
      toggleBatchSelectMode, clearBatchSlots, isBatchSlotSelected,
      openBatchMatch, prepBatchCompare, executeBatchSubmit,
      matchSearchQuery, matchDisplayCount, matchShowNoTeacherWarning,
      filteredRecommendedTeachers, displayedRecommendedTeachers,
      exchangeTeacherEmail, exchangeTeacherClasses, exchangePeriodId, exchangeTargetDate, exchangeWeekOffset,
      showCompareModal, showMatchModal, pendingRequestData, selectedRecordIds, showDevDropdown, devTeacherQuery, filteredDevTeachers,
      showDetailModal, consecAlertsA, consecAlertsB, detailRequest, detailSubRecord,
      showSuccessModal,
      successModalTitle, successModalMessage, lineCopyText, hasLineTemplate, lineBatchParts,
      copyLineMessage, sendLineMessage, copyLineBatchPart, sendLineBatchPart, copyLineMessageForRequest, addToGoogleCalendar, downloadIcsCalendar, addEventToCalendar, printSingleRequest, showDetailForRecord, getTargetSubject, getTargetClassAndSubject, getOriginalRequestSubject, getOriginalRequestClass, getOriginalTargetSubject, getOriginalTargetClass,
      adminSubTab,
      showImportTeachersModal, teacherExcelData, teacherExcelHeaders, teacherMappingFields, handleTeacherExcelChange, importTeachersBatch,
      isScheduleEditMode, showScheduleEditModal, scheduleForm,
      showTeacherModal, teacherModalMode, teacherForm,
      reportMonth, reportWeeksCount, monthlyReportData,
      excelData, excelHeaders, mappingFields, directApproveMode, googleClientId, gasApiUrl, saveClientSettings,
      isSubFeeLockedToSelf, isPeriod8FeeLocked, quotaDeductPreview, quotaDeductInsufficient, switchQuotaDeductToSelfPay, hasSubTeacherConflict,
      isAdmin, userRoleText, subjectsList, filteredTeachers, displayTimetableTeachers, pendingCount, myInviteCount, adminTodoCount, hasQuickTodo, quickTodoSentOpen, allTeachersList, teachersListDetails,
      matchPreview,
      exchangeTeachersList, myTeacherProfile, isRequestValid, filteredHistoryRecords,
      dateFilteredHistoryRecords, paginatedHistoryRecords, historyTotalPages,
      historyFilterMode, historyFilterDate, historySearchQuery, historyPage, historyPageSize,
      showHistoryEditModal, historyEditForm, leaveReasonOptions, onLeaveReasonChange, defaultSubFeeForReason,
      pendingMyPendingPage, pendingMySentPage, pendingAdminPage,
      paginatedMyPending, paginatedMySent, paginatedAdminPending,
      pendingMyPendingTotal, pendingMySentTotal, pendingAdminTotal,
      reportMonthOptions, personalChanges, recommendedExchangeList, displayedExchangeList, matchListCap,
      loginWithGoogle, logout, changeWeek, getPeriodTimeSpan, getWeekDayText, formatDateMMDD,
      getClassCellClassForDate, getClassCellClassForClass, getScheduleForDate, weekScheduleGrid, cellFromGrid, handleCellClick, handleClassCellClick,
      isMatchSourceCell, isMatchSourceEntry, isMatchHoverCell, isMatchHoverEntry,
      selectMatchPreviewSub, selectMatchPreviewExchange, clearMatchPreview, closeMatchModal, isMatchPreviewSelected,
      selectedClassDate, selectedClassWeekDates, classWeekNumber, classSubstitutionMap, classChangeSummary, changeClassWeek, goToClassThisWeek,
      prepCompare, getCompareCellText, getCompareCellClass, executeSubmitRequest, isSubmitting,
      getStatusText, changeMatchMode, respondToRequest, respondToBatch, adminApprove, adminReject, cancelRequest, deleteSubstitutionRecord, loadMoreMatches,
      formatRequestSummary, formatLeaveClassSlot, formatExchangeClassSlot, formatHistoryLeaveSlot, formatHistoryExchangeSlot, getRequestRiskTags, getRequestTypeTags, isHistoryLeaveRechanged, isHistoryExchangeRechanged, isRequestExchangeRechanged, getCellPlainStatus, getRequestProgressSteps, isLeaveClassRestricted, isExchangeClassRestricted, isHistoryLeaveRestricted, isHistoryExchangeRestricted,
      dashboardScope, dashboardStats,
      selectedAdminPendingIds, isAdminPendingSelected, toggleAdminPendingSelect, toggleSelectAllAdminPending, clearAdminPendingSelection,
      batchAdminApprove, batchAdminReject, lastBatchPrintIds, showBatchPrintPrompt, printLastBatchNotices, dismissBatchPrintPrompt,
      closeSuccessGoPending, closeSuccessStayTimetable, closeSuccessCopyLine,
      openScheduleEditModal, saveScheduleCell, clearScheduleCell, updateTeacherBaseHours, pickScheduleAttr,
      openAddTeacherModal, openEditTeacherModal, saveTeacher, deleteTeacher,
      handleFileChange, getMappingLabel, importSchedules, toggleSelectAllRecords, loadTeacherClassesForExchange,
      printSelectedForms, sendSelectedBatchNotices, calculateMonthlyReport, exportReportToExcel,
      schoolExportStart, schoolExportEnd, schoolExportIncludeWeekend, schoolExportOnlyChanged,
      schoolExportSelectedEmails, schoolExportTeacherFilter, filteredSchoolExportTeachers,
      isSchoolExportTeacherSelected, toggleSchoolExportTeacher, selectAllSchoolExportTeachers, clearSchoolExportTeachers,
      setSchoolExportThisWeek, exportSchoolTimetableWord,
      devSwitchUser, restoreAdmin,
      getTeacherNameByEmail, getTeacherSubjectByEmail, getRealTeacherName, startSecondSub,
      changeHistoryPage, openHistoryEditModal, saveHistoryEdit, onHistoryEditDateChange, changePendingPage,
      openAddSemesterModal, openEditSemesterModal, saveSemester, deleteSemester, setDefaultSemester,
      // 工具函數
      toLocalDateStr,
      // 單/雙週輔導課
      isSingleWeek, semesterStartDate,
      // 班級空堂事件
      classAwayEvents, semesterEndDate, activeAwayBanner, isClassAwayOnDate,
      showClassAwayModal, classAwayModalMode, classAwayForm,
      openAddClassAwayModal, openEditClassAwayModal, toggleClassAwayFormClass,
      isClassAwayFormClassSelected, selectClassAwayGrade, saveClassAwayEvent, deleteClassAwayEvent,
      mutualImportableEvents, mutualImportEventId, applyClassAwayEventById, applyClassAwayToMutualPanel,
      // 新手引導
      showOnboarding, onboardingStep, onboardingSteps,
      startOnboarding, nextOnboardingStep, prevOnboardingStep, skipOnboarding,
      tourDemoInvite, tourDemoInviteRespond
    };
  }
}).mount('#app');



