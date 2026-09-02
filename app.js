const { createApp, ref, computed, onMounted, watch, nextTick } = Vue;

createApp({
  setup() {
    // 清空舊有的系統設定快取避免衝突
    localStorage.removeItem('jcjh_google_client_id');
    localStorage.removeItem('jcjh_gas_url');
    localStorage.removeItem('jcjh_gas_mail_api');
    // ID Token 只保留在目前分頁，並清掉舊版 localStorage 憑證。
    try { localStorage.removeItem('jcjh_google_id_token'); } catch (eToken) { /* ignore */ }

    // ════════════════════════════════════════
    // §1 系統狀態 / 登入 / 學期
    // ════════════════════════════════════════
    // 系統狀態
    const user = ref(null);
    const userRole = ref('teacher'); // 'admin' | 'staff' | 'teacher'
    const originalUser = ref(null); // 模擬前的原始管理員身分
    /** 行政代申請：代理對象 Email（請假老師）；空＝只處理自己 */
    const proxyTargetEmail = ref('');
    const PROXY_SUBMIT_EMAILS_LS_KEY = 'jcjh_proxy_submit_emails';
    /** 可代申請人員白名單（Email 小寫）；空＝全關。後端 settings 優先，localStorage 備援 */
    const proxySubmitEmails = ref((() => {
      try {
        const raw = localStorage.getItem('jcjh_proxy_submit_emails') || '';
        return raw.split(/[,，;\s]+/).map(s => s.trim().toLowerCase()).filter(Boolean);
      } catch (e) { return []; }
    })());
    const proxySubmitEnabledBy = ref('');
    const proxySubmitEnabledAt = ref('');
    // 線上調代課總開關：設定缺少時維持既有線上模式。
    const onlineSubstitutionEnabled = ref(true);
    const showProxyTargetDropdown = ref(false);
    const proxyTargetQuery = ref('');
    const proxyGrantQuery = ref('');
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
    const GSI_INIT_STATE_KEY = '__jcjh_gsi_initialized';
    let _gsiInitialized = false;
    let _tokenRefreshP = null;
    let _gsiButtonRendered = false;
    let _gsiWaitTimer = null;
    let _gsiPopupHintTimer = null;
    let _gsiClickGen = 0;
    const gsiButtonReady = ref(true);
    const gsiButtonError = ref('');
    const gsiLoggingIn = ref(false);

    function isGoogleGsiReady() {
      return typeof google !== 'undefined'
        && google.accounts
        && google.accounts.id
        && typeof google.accounts.id.initialize === 'function'
        && typeof google.accounts.id.renderButton === 'function';
    }

    /** 等待 GSI 腳本（async defer 常比 Vue onMounted 晚到） */
    function waitForGoogleGsi(timeoutMs) {
      const limit = timeoutMs != null ? timeoutMs : 15000;
      return new Promise((resolve) => {
        if (isGoogleGsiReady()) {
          resolve(true);
          return;
        }
        const t0 = Date.now();
        const tick = () => {
          if (isGoogleGsiReady()) {
            resolve(true);
            return;
          }
          if (Date.now() - t0 >= limit) {
            resolve(false);
            return;
          }
          setTimeout(tick, 120);
        };
        tick();
      });
    }

    /** GSI 固定橋接：initialize 只綁一次，實際邏輯永遠走最新 handler */
    function gsiCredentialBridge(response) {
      const fn = window.__gsiCredentialHandler || window.handleCredentialResponse;
      if (typeof fn === 'function') {
        try {
          return fn(response);
        } catch (e) {
          console.error('GSI credential handler error', e);
          showToast('登入處理失敗：' + (e && e.message ? e.message : e), 'error');
        }
      } else {
        console.warn('GSI callback 尚未就緒', response);
        showToast('登入回呼尚未就緒，請重新整理後再試', 'warning');
      }
    }

    function isSecureHttpsOrigin() {
      try {
        return String(location.protocol || '') === 'https:';
      } catch (e) {
        return false;
      }
    }

    function isGsiInitialized() {
      if (_gsiInitialized) return true;
      try {
        return window[GSI_INIT_STATE_KEY] === true;
      } catch (e) {
        return false;
      }
    }

    /** 清本站 GSI 狀態（renderButton 已不用；仍供 revoke／殘留清理） */
    function suppressGsiAutoLogin() {
      try {
        if (isGsiInitialized() && typeof google !== 'undefined' && google.accounts && google.accounts.id) {
          if (typeof google.accounts.id.cancel === 'function') google.accounts.id.cancel();
          if (typeof google.accounts.id.disableAutoSelect === 'function') {
            google.accounts.id.disableAutoSelect();
          }
        }
      } catch (e) { /* ignore */ }
      try {
        const host = String(location.hostname || '');
        const expire = 'Thu, 01 Jan 1970 00:00:00 GMT';
        const base = '; path=/; expires=' + expire + '; SameSite=Lax';
        document.cookie = 'g_state=;' + base;
        if (host) document.cookie = 'g_state=; domain=' + host + base;
      } catch (eCookie) { /* ignore */ }
    }

    function ensureGsiInitialized() {
      if (!isGoogleGsiReady() || !googleClientId.value) return false;
      if (isGsiInitialized()) {
        _gsiInitialized = true;
        suppressGsiAutoLogin();
        return true;
      }
      try {
        google.accounts.id.initialize({
          client_id: googleClientId.value,
          callback: gsiCredentialBridge,
          auto_select: false,
          cancel_on_tap_outside: true,
          use_fedcm_for_prompt: false,
          itp_support: true
        });
        _gsiInitialized = true;
        try { window[GSI_INIT_STATE_KEY] = true; } catch (eState) { /* ignore */ }
        suppressGsiAutoLogin();
        return true;
      } catch (e) {
        console.warn('GSI initialize 失敗', e);
        return false;
      }
    }

    function renderGsiLoginButton() {
      gsiButtonReady.value = true;
      return true;
    }

    async function setupGoogleSignInUi() {
      if (classReadonlyMode.value) return;
      gsiButtonReady.value = true;
      gsiLoggingIn.value = false;
      const ready = await waitForGoogleGsi(8000);
      if (ready) {
        ensureGsiInitialized();
        suppressGsiAutoLogin();
      }
    }

    const reloadGsiLoginButton = async () => {
      gsiButtonError.value = '';
      gsiLoggingIn.value = false;
      await setupGoogleSignInUi();
    };

    /**
     * 只允許已在 Google Console 登記的 origin → 固定 redirect_uri。
     * 間歇「要求無效」常見原因：本機/正式站混用、尾斜線不一致、預覽網域未授權。
     */
    const OAUTH_REDIRECT_BY_ORIGIN = {
      'https://jcjh-timetable.vercel.app': 'https://jcjh-timetable.vercel.app/',
      'http://localhost:8000': 'http://localhost:8000/',
      'http://127.0.0.1:8000': 'http://localhost:8000/'
    };
    function getOAuthRedirectUri() {
      try {
        const origin = String(location.origin || '').replace(/\/$/, '');
        if (OAUTH_REDIRECT_BY_ORIGIN[origin]) return OAUTH_REDIRECT_BY_ORIGIN[origin];
        // 未知 origin（如 Vercel 預覽網域）不硬猜，避免隨機 invalid_request
        return '';
      } catch (e) {
        return '';
      }
    }
    function makeOAuthNonce() {
      try {
        if (window.crypto && typeof window.crypto.getRandomValues === 'function') {
          const buf = new Uint8Array(16);
          window.crypto.getRandomValues(buf);
          return Array.prototype.map.call(buf, function (b) {
            return ('0' + b.toString(16)).slice(-2);
          }).join('');
        }
      } catch (e) { /* ignore */ }
      return String(Date.now()) + Math.random().toString(36).slice(2);
    }
    function clearOAuthUrlResidue() {
      try {
        const path = location.pathname || '/';
        const search = String(location.search || '');
        // 清掉 OAuth 帶回的 query error／hash token
        const q = new URLSearchParams(search.charAt(0) === '?' ? search.slice(1) : search);
        let dirty = false;
        ['error', 'error_description', 'state', 'id_token', 'authuser', 'prompt', 'scope', 'hd'].forEach(function (k) {
          if (q.has(k)) { q.delete(k); dirty = true; }
        });
        const nextSearch = q.toString() ? ('?' + q.toString()) : '';
        if (dirty || (location.hash && location.hash.length > 1)) {
          history.replaceState(null, '', path + nextSearch);
        }
      } catch (e) { /* ignore */ }
    }
    function parseOAuthReturnParams() {
      // Google 錯誤有時在 hash、有時在 query；成功 id_token 在 hash
      let fromHash = null;
      let fromQuery = null;
      try {
        const hash = String(location.hash || '');
        if (hash && hash.length > 1) {
          const raw = hash.charAt(0) === '#' ? hash.slice(1) : hash;
          if (raw.indexOf('id_token=') >= 0 || raw.indexOf('error=') >= 0) {
            fromHash = new URLSearchParams(raw);
          }
        }
      } catch (eH) { /* ignore */ }
      try {
        const search = String(location.search || '');
        if (search && search.length > 1) {
          const raw = search.charAt(0) === '?' ? search.slice(1) : search;
          if (raw.indexOf('id_token=') >= 0 || raw.indexOf('error=') >= 0) {
            fromQuery = new URLSearchParams(raw);
          }
        }
      } catch (eQ) { /* ignore */ }
      if (!fromHash && !fromQuery) return null;
      // 合併：hash 優先（id_token 在此）
      const merged = new URLSearchParams();
      if (fromQuery) fromQuery.forEach(function (v, k) { merged.set(k, v); });
      if (fromHash) fromHash.forEach(function (v, k) { merged.set(k, v); });
      return merged;
    }
    function consumeOAuthRedirectToken() {
      try {
        gsiLoggingIn.value = false;
        const q = parseOAuthReturnParams();
        if (!q) return null;
        const expectedState = sessionStorage.getItem('jcjh_oauth_state');
        const returnedState = q.get('state');
        try {
          sessionStorage.removeItem('jcjh_oauth_state');
          sessionStorage.removeItem('jcjh_oauth_redirect');
        } catch (eStateCleanup) { /* ignore */ }
        if (!expectedState || !returnedState || returnedState !== expectedState) {
          clearOAuthUrlResidue();
          showToast('登入驗證失敗（state），請重新登入。', 'error');
          return null;
        }
        const err = q.get('error');
        const token = q.get('id_token');
        clearOAuthUrlResidue();
        if (err) {
          const desc = q.get('error_description') || err;
          const uri = getOAuthRedirectUri() || (String(location.origin || '') + '/');
          try { console.warn('[OAuth] error', err, desc, 'redirect_uri=', uri); } catch (eC) { /* ignore */ }
          if (err === 'redirect_uri_mismatch' || err === 'invalid_request' || /redirect|invalid/i.test(desc)) {
            gsiButtonError.value = 'Google 拒絕登入（' + err + '）。請確認 Console「重新導向 URI」含：' + uri
              + '（正式站與 localhost 都要；含尾斜線）。目前網址：' + location.origin;
            showToast('登入被拒：請檢查 OAuth 重新導向 URI 是否含 ' + uri, 'error', 10000);
          } else {
            gsiButtonError.value = '登入未完成：' + desc;
            showToast('Google 登入未完成：' + desc, 'warning', 6000);
          }
          return null;
        }
        if (!token) return null;
        const expected = sessionStorage.getItem('jcjh_oauth_nonce');
        try { sessionStorage.removeItem('jcjh_oauth_nonce'); } catch (eN) { /* ignore */ }
        if (!expected) {
          showToast('登入驗證失敗（nonce 遺失），請重新登入。', 'error');
          return null;
        }
        try {
          const payload = JSON.parse(
            decodeURIComponent(
              atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))
                .split('').map(function (c) {
                  return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
                }).join('')
            )
          );
          if (!payload || !payload.nonce || payload.nonce !== expected) {
            showToast('登入驗證失敗（nonce），請再試一次', 'error');
            return null;
          }
        } catch (ePay) {
          showToast('登入驗證失敗（Token 格式錯誤），請再試一次', 'error');
          return null;
        }
        return token;
      } catch (e) {
        console.warn('consumeOAuthRedirectToken', e);
        gsiLoggingIn.value = false;
        return null;
      }
    }

    /**
     * 單一 Google 風格按鈕 + OAuth 整頁導向。
     * 官方 renderButton 無法設 prompt=select_account；OAuth select_account 可強制選帳。
     */
    const loginWithGoogle = () => {
      if (gsiLoggingIn.value) return;
      if (!googleClientId.value) {
        showToast('缺少 Google Client ID', 'error');
        return;
      }
      const host = String(location.hostname || '').toLowerCase();
      if (host === '127.0.0.1' || host === '[::1]') {
        gsiButtonError.value = '請改開 http://localhost:8000/ 再登入（勿用 127.0.0.1）';
        showToast('請改用 http://localhost:8000/', 'warning', 5000);
        return;
      }
      const redirectUri = getOAuthRedirectUri();
      if (!redirectUri) {
        gsiButtonError.value = '目前網域未列入 OAuth 白名單：' + location.origin
          + '。請用 https://jcjh-timetable.vercel.app/ 或 http://localhost:8000/';
        showToast('請改用正式站或本機 localhost:8000', 'error', 8000);
        return;
      }
      suppressGsiAutoLogin();
      const nonce = makeOAuthNonce();
      const state = makeOAuthNonce().slice(0, 16);
      try {
        sessionStorage.setItem('jcjh_oauth_nonce', nonce);
        sessionStorage.setItem('jcjh_oauth_state', state);
        sessionStorage.setItem('jcjh_oauth_redirect', redirectUri);
      } catch (eS) { /* ignore */ }
      gsiLoggingIn.value = true;
      gsiButtonError.value = '';
      // 只帶必要參數；多餘參數有時會觸發 Google invalid_request
      const params = new URLSearchParams();
      params.set('client_id', googleClientId.value);
      params.set('redirect_uri', redirectUri);
      params.set('response_type', 'id_token token');
      params.set('scope', 'openid email profile');
      params.set('nonce', nonce);
      params.set('state', state);
      params.set('prompt', 'select_account');
      const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' + params.toString();
      try { console.info('[OAuth] go', { redirect_uri: redirectUri, origin: location.origin }); } catch (eL) { /* ignore */ }
      // 稍延遲再導向，讓 UI 先顯示「正在前往」；失敗返回用 pageshow 解鎖
      setTimeout(function () {
        location.assign(authUrl);
      }, 50);
    };

    // 從 Google 錯誤頁按「上一頁」回來時，解鎖登入鈕
    try {
      window.addEventListener('pageshow', function () {
        try { gsiLoggingIn.value = false; } catch (e) { /* ignore */ }
      });
    } catch (ePs) { /* ignore */ }

    /** 票過期：請再按登入鈕 */
    const refreshGoogleIdToken = () => {
      if (_tokenRefreshP) return _tokenRefreshP;
      _tokenRefreshP = Promise.resolve().then(() => {
        try {
          const cur = sessionStorage.getItem('jcjh_google_id_token');
          if (cur && !isTokenExpired(cur)) return cur;
        } catch (e) { /* ignore */ }
        return null;
      }).finally(() => {
        _tokenRefreshP = null;
      });
      return _tokenRefreshP;
    };

    const {
      callGasApi, fetchInitialData, fetchMetaData, fetchPublicClassData,
      fetchPendingOnly, fetchRequestsDelta, fetchHistoryMonth, fetchMatchCandidates,
      fetchMutualQuotaLedger,
      decodeJwt, isTokenExpired, isTokenExpiringSoon,
      formatError, clearSWR, cancelAll, parseAllowedHd, isEmailDomainAllowed, DEFAULT_ALLOWED_HD
    } = window.GasApi.createClient({
      getApiUrl: () => gasApiUrl.value,
      getSemesterId: () => currentSemester.value,
      refreshIdToken: () => refreshGoogleIdToken(),
      // B：過期只清 user，不 reload（gas-api 已移除 location.reload）
      onAuthExpired: () => {
        user.value = null;
        // 不呼叫 prompt()（One Tap 易無反應）；回登入頁後由 setupGoogleSignInUi 重畫按鈕
        try {
          if (!user.value) {
            gsiButtonReady.value = false;
            nextTick(() => setupGoogleSignInUi());
          }
        } catch (e) { /* ignore */ }
      },
      showToast
    });

    /** 長操作進度：寫入 loadingMessage（匯入／批次核准等） */
    const gasProgressHandler = (label) => (p) => {
      if (!p || !loadingMessage) return;
      const sec = p.elapsed || 0;
      const hint = p.hintSec || 0;
      if (p.phase === 'done') return;
      if (p.phase === 'slow' || (hint > 0 && sec >= hint)) {
        loadingMessage.value = (label || '處理中') + '…已 ' + sec + ' 秒（較久屬正常，請勿關閉）';
      } else if (sec > 0) {
        loadingMessage.value = (label || '處理中') + '…' + sec + ' 秒'
          + (hint ? '／約 ' + hint + ' 秒' : '');
      }
    };
    const callGasApiWithProgress = (action, data, label) =>
      callGasApi(action, data, { onProgress: gasProgressHandler(label || action), longOp: true });
    // 網域白名單：預設 → 後端 settings.allowedHd 覆寫
    const allowedHdList = ref(DEFAULT_ALLOWED_HD.slice());
    const applySettings = (settings) => {
      if (!settings) return;
      allowedHdList.value = parseAllowedHd(settings);
      // 行政代申請：指定行政 Email 白名單
      if (Object.prototype.hasOwnProperty.call(settings, 'proxySubmitEmails')
          || Object.prototype.hasOwnProperty.call(settings, 'PROXY_SUBMIT_EMAILS')) {
        const rawEmails = settings.proxySubmitEmails != null
          ? settings.proxySubmitEmails
          : settings.PROXY_SUBMIT_EMAILS;
        const list = String(rawEmails == null ? '' : rawEmails)
          .split(/[,，;\s]+/)
          .map(s => s.trim().toLowerCase())
          .filter(Boolean);
        proxySubmitEmails.value = list;
        try { localStorage.setItem(PROXY_SUBMIT_EMAILS_LS_KEY, list.join(',')); } catch (e) { /* ignore */ }
      }
      if (settings.proxySubmitEnabledBy) proxySubmitEnabledBy.value = String(settings.proxySubmitEnabledBy);
      if (settings.proxySubmitEnabledAt) proxySubmitEnabledAt.value = String(settings.proxySubmitEnabledAt);
      if (Object.prototype.hasOwnProperty.call(settings, 'onlineSubstitutionEnabled')) {
        const rawOnline = settings.onlineSubstitutionEnabled;
        onlineSubstitutionEnabled.value = !(
          rawOnline === false
          || String(rawOnline).trim().toLowerCase() === 'false'
          || String(rawOnline).trim() === '0'
          || String(rawOnline).trim() === '否'
          || String(rawOnline).trim().toLowerCase() === 'off'
        );
      }
    };
    const assertSchoolDomain = (payload) => {
      const email = payload && payload.email;
      // 後端會先驗證網域；前端尚未取得設定時不可誤拒絕合法帳號。
      if (!allowedHdList.value.length) return true;
      if (!isEmailDomainAllowed(email, payload, allowedHdList.value)) {
        sessionStorage.removeItem('jcjh_google_id_token');
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
     const VALID_ADMIN_SUBTABS = ['billing', 'teachers', 'import', 'classAway', 'schoolSwap', 'settings', 'schoolExport'];
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
    const teachersList = ref([]); // roster [{loginEmail, teacherName, subject, role, baseHours}]
    const allSchedules = ref([]); // name-keyed base schedule
    const schoolSwaps = ref([]); // 全校指定日期節次對調
    const substitutionRecords = ref([]);
    const homeroomRecords = ref([]);
    const homeroomAssignSelections = ref({});
    const homeroomRecordsLoading = ref(false);
    /**
     * 從「已組裝的 substitution 列 + 基礎課表」解析教師在該日該節的有效班科
     * 支援多段調代鏈：沿 original→actual 走到目前 email，班科取鏈上第一筆有值的 record／起點基礎課
     */
    /**
     * 從「已組裝的 substitution 列 + 基礎課表」解析有效班科
     * slotSubs：同日同節的 edge 陣列（建議由 slotIndex 提供，避免每次 filter 全表）
     */
    const resolveCellFromBaseAndSubs = (email, dateStr, period, dayOfWeek, subsSoFar, slotSubsOpt) => {
      if (!email || period == null || period === '') return null;
      const em = String(email).toLowerCase();
      const p = parseInt(period, 10);
      const dateKey = String(dateStr || '');
      const slotSubs = slotSubsOpt || (subsSoFar || []).filter(s =>
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

    /** 已核准集合指紋：未變則 recompute 可略過 convert（H5） */
    let _approvedConvertSig = '';
    const approvedConvertSig = (requests) => {
      const parts = [];
      (requests || []).forEach((r) => {
        if (!r || r.status !== 'approved') return;
        parts.push([
          r.id || '',
          r.type || '',
          r.batchId || '',
          r.requestDate || r.date || '',
          r.requestPeriod != null ? r.requestPeriod : (r.period || ''),
          r.targetDate || '',
          r.targetPeriod != null ? r.targetPeriod : '',
           r.requesterEmail || '',
           r.targetTeacherEmail || '',
           r.triangleId || '',
           r.triangleLegIndex != null ? r.triangleLegIndex : '',
           r.specialFlow || '',
           r.className || '',
           r.subject || '',
           r.targetClassName || '',
           r.targetSubject || '',
           r.subFee || '',
          r.leaveTimeType || '',
          r.leaveTime || '',
          r.printed ? '1' : '0',
          r.updatedAt || r.createdAt || ''
        ].join('\x1f'));
      });
      parts.sort();
      return parts.join('\x1e');
    };

    const isCombinedReturnRequest = (request) => {
      if (window.FieldMap && typeof window.FieldMap.isCombinedReturn === 'function') {
        return window.FieldMap.isCombinedReturn(request);
      }
      let raw = request && request.specialFlow;
      if (String(raw == null ? '' : raw).trim() === '') raw = request && request['特殊流程'];
      const value = String(raw == null ? '' : raw).trim().toLowerCase();
      return value === 'combined_return' || value === '合班回原班';
    };

    const convertRequestsToSubstitutions = (requests) => {
      const subs = [];
      // date|period → edges（邊組邊查，避免 resolve 每次 O(n) filter）
      const slotIndex = Object.create(null);
      const slotKey = (dateStr, period) => String(dateStr || '') + '|' + (parseInt(period, 10) || 0);
      const pushSub = (rec) => {
        if (!rec) return;
        // Keep non-enumerable legacy aliases for calculation modules; the persisted/API key is the name.
        if (!Object.prototype.hasOwnProperty.call(rec, 'originalTeacherEmail')) {
          Object.defineProperty(rec, 'originalTeacherEmail', {
            configurable: true, enumerable: false, get: () => rec.originalTeacherName || ''
          });
        }
        if (!Object.prototype.hasOwnProperty.call(rec, 'actualTeacherEmail')) {
          Object.defineProperty(rec, 'actualTeacherEmail', {
            configurable: true, enumerable: false, get: () => rec.actualTeacherName || ''
          });
        }
        subs.push(rec);
        const k = slotKey(rec.date, rec.period);
        if (!slotIndex[k]) slotIndex[k] = [];
        slotIndex[k].push(rec);
      };
      const resolveAt = (email, dateStr, period, dayOfWeek) =>
        resolveCellFromBaseAndSubs(
          email, dateStr, period, dayOfWeek, subs, slotIndex[slotKey(dateStr, period)] || []
        );

      const approved = (requests || []).filter(r => r && r.status === 'approved');
      // 建立時間優先，讓較早核准的調入可被後續對調引用
      approved.sort((a, b) => {
        const ta = String(a.createdAt || a.requestDate || '');
        const tb = String(b.createdAt || b.requestDate || '');
        if (ta !== tb) return ta.localeCompare(tb);
        return String(a.id || '').localeCompare(String(b.id || ''));
      });

      approved.forEach(req => {
        if (req.type === 'triangle' || req.type === '三角調') {
          // 三角調每條 leg 只建立「目標原課時段」的一組 edge；三條 leg 合併後才是完整循環。
          pushSub({
            // 直接沿用申請單 ID，列印回寫「是否已印」時可對應到後端原列。
            id: req.id,
            date: req.targetDate,
            period: req.targetPeriod,
            dayOfWeek: req.targetDayOfWeek,
            serial: req.serial || req['單號'] || '',
            originalTeacherName: req.targetTeacherName,
            actualTeacherName: req.requesterName,
            className: req.className || '',
            subject: req.subject || '',
             // 三角調是整堂課跟著來源教師移動，目標欄位只代表接手的時段。
             formClassName: req.className || '',
             formSubject: req.subject || '',
            requestId: req.id,
            batchId: req.batchId || '',
            triangleId: req.triangleId || req.batchId || '',
            triangleSourceDate: req.requestDate,
            triangleSourcePeriod: req.requestPeriod,
            triangleSourceDayOfWeek: req.requestPeriodDay,
            triangleTargetTeacherName: req.targetTeacherName,
            type: 'triangle',
            printed: req.printed,
            subFee: '無',
            reason: req.reason,
            leaveTimeType: '',
            leaveTime: '',
            note: req.note
          });
        } else if (req.type === 'substitution' || req.type === '代課') {
          // 請假節可能本身已是調入課：班科以有效課為準，缺才用申請單
          let leaveDay = req.requestPeriodDay;
          if ((leaveDay == null || leaveDay === '') && req.requestDate) {
            const d = new Date(String(req.requestDate).replace(/-/g, '/'));
            if (!Number.isNaN(d.getTime())) leaveDay = d.getDay() === 0 ? 7 : d.getDay();
          }
          const leaveCell = resolveAt(
            req.requesterEmail,
            req.requestDate,
            req.requestPeriod,
            leaveDay
          );
          // 空堂排班：班科以申請單為準（無基礎課可疊）
          const emptyAssign = !!(req.isEmptySlotAssign
            || String(req.reason || '').trim() === '空堂排班'
            || String(req.note || '').indexOf('[空堂排班]') >= 0);
          // 有效課優先（調入再代課／對調時申請單 className 可能是舊基礎課）
          const leaveCls = emptyAssign
            ? (req.className || '')
            : ((leaveCell && leaveCell.className) || req.className || '');
          const leaveSubj = emptyAssign
            ? (req.subject || '')
            : ((leaveCell && leaveCell.subject) || req.subject || '');
           pushSub({
             id: req.id,
             date: req.requestDate,
             period: req.requestPeriod,
             serial: req.serial || req['單號'] || '',
             originalTeacherName: req.requesterName,
             actualTeacherName: req.actualTeacherName || req.targetTeacherName || '',
            className: leaveCls,
            subject: leaveSubj,
            requestId: req.id,
            batchId: req.batchId || '',
             type: req.type === 'triangle' ? 'triangle' : 'substitution',
             triangleId: req.triangleId || '',
             triangleLegIndex: req.triangleLegIndex,
            printed: req.printed,
            subFee: req.subFee,
            reason: req.reason,
            leaveTimeType: req.leaveTimeType || '',
            leaveTime: req.leaveTime || '',
            note: req.note,
            specialFlow: req.specialFlow || '',
            isEmptySlotAssign: emptyAssign
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
          const leaveEff = resolveAt(
            req.requesterEmail, req.requestDate, req.requestPeriod, leaveDay
          );
          const targetEff = resolveAt(
            req.targetTeacherEmail, req.targetDate, req.targetPeriod, dayNum
          );
          // 網頁課表顯示調課後的實際安排：教師帶著自己的班級／科目換到對方時段。
          // 僅「代課義務」再調課：優先使用有效的義務班科。
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

          // _1：目標日由申請人上自己的原課程。
          pushSub({
            id: req.id + '_1',
            date: req.targetDate,
            period: req.targetPeriod,
            serial: req.serial || req['單號'] || '',
            originalTeacherName: req.targetTeacherName,
            actualTeacherName: req.requesterName,
            className: leaveCls,
            subject: leaveSubj,
            // 列印調代課單仍要顯示目標位置原本的班級／科目。
            formClassName: targetCls,
            formSubject: targetSubj,
            requestId: req.id,
            batchId: req.batchId || '',
            type: 'exchange',
            printed: req.printed,
            subFee: '無',
            reason: req.reason,
            leaveTimeType: req.leaveTimeType || '',
            leaveTime: req.leaveTime || '',
            note: req.note
          });

          // _2：原異動日由受邀人上自己的原課程。
          pushSub({
            id: req.id + '_2',
            date: req.requestDate,
            period: req.requestPeriod,
            serial: req.serial || req['單號'] || '',
            originalTeacherName: req.requesterName,
            actualTeacherName: req.targetTeacherName,
            className: targetCls,
            subject: targetSubj,
            // 列印調代課單仍要顯示申請人原位置的班級／科目。
            formClassName: leaveCls,
            formSubject: leaveSubj,
            requestId: req.id,
            batchId: req.batchId || '',
            type: 'exchange',
            printed: req.printed,
            subFee: '無',
            reason: req.reason,
            leaveTimeType: req.leaveTimeType || '',
            leaveTime: req.leaveTime || '',
            note: req.note
          });
        }
      });
      return subs;
    };
    const requestsList = ref([]); // Approved substitutions keyed by teacher names.

    // 單/雙週課輔課輔助
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

    // 空堂事件（畢旅 keep／畢業 reduce）；取代舊「畢業日隱藏九年級」
    const classAwayEvents = ref([]);
    const semesterEndDate = computed(() => {
      const sem = semestersList.value.find(s => s.id === currentSemester.value);
      return sem ? (sem.endDate || '') : '';
    });
    /** 該班該日是否落在空堂事件（視覺淡化用；不再把格子當空堂刪除） */
    const isClassAwayOnDate = (className, dateStr) => {
      if (!className || !window.DomainClassAway) return false;
      const d = dateStr || getTodayString();
      const events = getClassAwayEventsForView();
      return window.DomainClassAway.isClassAwayOnDate(
        className, d, events, semesterEndDate.value
      );
    };
    const getClassAwayEventsForView = () => {
      const useClassViewEvents = classReadonlyMode.value
        || (activeTab.value === 'class' && userRole.value === 'teacher');
      return useClassViewEvents ? classViewClassAwayEvents.value : classAwayEvents.value;
    };
    const getClassAwayEventName = (className, dateStr) => {
      if (!className || !window.DomainClassAway) return '';
      const parseClasses = typeof window.DomainClassAway.parseClassList === 'function'
        ? window.DomainClassAway.parseClassList
        : value => String(value || '').split(/[,，、/／\s]+/).map(item => item.trim()).filter(Boolean);
      const classNames = parseClasses(className);
      if (!classNames.length || typeof window.DomainClassAway.eventsActiveOnDate !== 'function') return '';
      const activeEvents = window.DomainClassAway.eventsActiveOnDate(
        dateStr || getTodayString(), getClassAwayEventsForView(), semesterEndDate.value
      );
      const names = [];
      activeEvents.forEach(event => {
        const eventClasses = typeof window.DomainClassAway.eventClasses === 'function'
          ? window.DomainClassAway.eventClasses(event)
          : parseClasses(event && (event.classes || event.classList || event['班級清單']));
        if (!classNames.some(classValue => eventClasses.includes(classValue))) return;
        const name = String(event && (event.name || event['事件名稱']) || '').trim();
        if (name && !names.includes(name)) names.push(name);
      });
      return names.join('、');
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

    // 全校日期節次對調：獨立於固定週課表保存，僅影響指定實際日期。
    const showSchoolSwapModal = ref(false);
    const schoolSwapModalMode = ref('add');
    const schoolSwapSaving = ref(false);
    const schoolSwapForm = ref({
      id: '',
      name: '',
      dateA: '',
      periodA: 1,
      dateB: '',
      periodB: 1,
      enabled: true,
      note: ''
    });
    const schoolSwapRows = computed(() => {
      const rows = window.DomainSchoolSwap
        ? window.DomainSchoolSwap.normalizeRows(schoolSwaps.value)
        : [];
      return rows.slice().sort((a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')));
    });
    const schoolSwapWeekdayNumber = (dateStr) => {
      const parts = String(dateStr || '').split('-').map(x => parseInt(x, 10));
      if (parts.length !== 3 || parts.some(x => Number.isNaN(x))) return 0;
      const d = new Date(parts[0], parts[1] - 1, parts[2]);
      const day = d.getDay();
      return day === 0 ? 7 : day;
    };
    const schoolSwapWeekdayText = (dateStr) => {
      const day = schoolSwapWeekdayNumber(dateStr);
      return day >= 1 && day <= 5 ? getWeekDayText(day) : '非上課日';
    };
    const openAddSchoolSwapModal = () => {
      const dates = currentWeekDates.value || [];
      schoolSwapModalMode.value = 'add';
      schoolSwapForm.value = {
        id: '',
        name: '',
        dateA: dates[0] || '',
        periodA: 1,
        dateB: dates[1] || '',
        periodB: 1,
        enabled: true,
        note: ''
      };
      showSchoolSwapModal.value = true;
    };
    const openEditSchoolSwapModal = (row) => {
      const mapped = window.FieldMap.mapSchoolSwap(row || {});
      schoolSwapModalMode.value = 'edit';
      schoolSwapForm.value = {
        id: mapped.id,
        name: mapped.name,
        dateA: mapped.dateA,
        periodA: mapped.periodA,
        dateB: mapped.dateB,
        periodB: mapped.periodB,
        enabled: mapped.enabled,
        note: mapped.note
      };
      showSchoolSwapModal.value = true;
    };
    const saveSchoolSwap = async () => {
      const form = schoolSwapForm.value || {};
      if (!String(form.name || '').trim() || !form.dateA || !form.dateB) {
        showToast('請填寫名稱及兩個日期！', 'warning');
        return;
      }
      const dayA = schoolSwapWeekdayNumber(form.dateA);
      const dayB = schoolSwapWeekdayNumber(form.dateB);
      if (dayA < 1 || dayA > 5 || dayB < 1 || dayB > 5) {
        showToast('全校對調日期必須是週一至週五！', 'warning');
        return;
      }
      if (String(form.dateA) + '|' + String(form.periodA) === String(form.dateB) + '|' + String(form.periodB)) {
        showToast('兩個對調端點不可相同！', 'warning');
        return;
      }
      schoolSwapSaving.value = true;
      try {
        const res = await callGasApi('saveSchoolSwap', {
          對調ID: form.id || '',
          事件名稱: String(form.name || '').trim(),
          日期A: form.dateA,
          星期A: dayA,
          節次A: parseInt(form.periodA, 10),
          日期B: form.dateB,
          星期B: dayB,
          節次B: parseInt(form.periodB, 10),
          啟用: !!form.enabled,
          備註: String(form.note || '').trim()
        });
        if (!res || res.success === false) throw new Error(res && res.error ? res.error : '儲存失敗');
        const saved = window.FieldMap.mapSchoolSwap(res.schoolSwap || form);
        const next = schoolSwaps.value.slice();
        const index = next.findIndex(row => String(window.FieldMap.mapSchoolSwap(row).id) === String(saved.id));
        if (index >= 0) next[index] = saved;
        else next.unshift(saved);
        schoolSwaps.value = next;
        showSchoolSwapModal.value = false;
        clearScheduleCache();
        showToast(schoolSwapModalMode.value === 'add' ? '已新增全校對調' : '已更新全校對調', 'success');
        if (typeof softRefreshInBackground === 'function') softRefreshInBackground({ force: true, delay: 300 });
      } catch (err) {
        showToast('儲存全校對調失敗：' + (err && err.message ? err.message : err), 'error');
      } finally {
        schoolSwapSaving.value = false;
      }
    };
    const deleteSchoolSwap = async (row) => {
      const id = String(row && (row.id || row['對調ID']) || '').trim();
      if (!id) return;
      const ok = await showConfirm('確定刪除這筆全校對調設定？\n刪除後不會再影響課表。', '刪除全校對調');
      if (!ok) return;
      try {
        await callGasApi('deleteSchoolSwap', { id: id });
        schoolSwaps.value = schoolSwaps.value.filter(item => String(window.FieldMap.mapSchoolSwap(item).id) !== id);
        clearScheduleCache();
        showToast('已刪除全校對調', 'success');
        if (typeof softRefreshInBackground === 'function') softRefreshInBackground({ force: true, delay: 300 });
      } catch (err) {
        showToast('刪除全校對調失敗：' + (err && err.message ? err.message : err), 'error');
      }
    };

    // 新手引導 UI（簡潔版：置中卡牌，無 spotlight，手機友善）
    // ── 新手 Spotlight 導覽（懶載入 onboarding-tour.js）──
     const ONBOARDING_SCRIPT = 'onboarding-tour.js?v=20260831-combined3';
    const ONBOARDING_PAPER_STORAGE_KEY = 'jcjh_onboarding_paper_v1';
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
      const email = user.value && getTeacherNameByEmail(user.value.email);
      if (!email) return null;
      const dates = currentWeekDates.value || [];
      for (let day = 1; day <= 5; day++) {
        const dateStr = dates[day - 1];
        if (!dateStr) continue;
        const periodList = (window.DateUtils && window.DateUtils.getTimetablePeriods)
          ? window.DateUtils.getTimetablePeriods()
          : [0, 1, 2, 3, 4, 45, 5, 6, 7, 8];
        for (let pi = 0; pi < periodList.length; pi++) {
          const period = periodList[pi];
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

    /** 導覽：切到節次調課模式，僅顯示可調課條件，不選取也不送出 */
    const openExchangeModeDemoForTour = async () => {
      if (!showMatchModal.value) {
        const opened = await openMatchDemoForTour();
        if (!opened) return false;
      }
      matchMode.value = 'exchange';
      matchSearchQuery.value = '';
      matchDisplayCount.value = 10;
      try { clearMatchPreview(); } catch (e) {}
      await nextTick();
      try { fetchRecommendations(); } catch (e) { /* ignore */ }
      await new Promise((resolve) => setTimeout(resolve, 320));
      return !!document.querySelector('[data-tour="exchange-mode-btn"]')
        && !!document.querySelector('[data-tour="exchange-controls"]');
    };

    /** 導覽：選第一位媒合老師並開啟「模擬」視窗（不送出） */
    const openCompareDemoForTour = async () => {
      // 確保媒合已開
      if (!showMatchModal.value) {
        const ok = await openMatchDemoForTour();
        if (!ok) return false;
      }
      await nextTick();
      // 調課介紹後回到代課模擬，避免沿用調課名單造成示範錯位。
      if (matchMode.value !== 'substitution') {
        matchMode.value = 'substitution';
        try { clearMatchPreview(); } catch (e) {}
        try { fetchRecommendations(); } catch (e) { /* ignore */ }
        await new Promise((r) => setTimeout(r, 280));
      }
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

    /** 導覽：顯示送出後的紙本列印預覽（只用虛擬資料，不會送出申請） */
    const openPaperPrintDemoForTour = async () => {
      closeCompareDemoForTour();
      closeMatchDemoForTour();
      try { showSuccessModal.value = false; } catch (e) {}
      const demo = findDemoScheduleCell();
      const classData = (demo && demo.classData) || {};
      const date = (demo && demo.dateStr) || currentWeekDates.value[0] || getTodayString();
      const period = (demo && demo.period) || 3;
      const records = [{
        id: 'tour-paper-print',
        requestId: 'tour-paper-print',
        serial: '導覽示範',
        type: 'substitution',
        originalTeacherEmail: (demo && demo.teacherEmail) || 'tour-owner',
        originalTeacherName: (demo && demo.teacherName) || (user.value && user.value.displayName) || '申請教師',
        actualTeacherEmail: 'tour-substitute',
        actualTeacherName: '王小明（示範）',
        date: date,
        period: period,
        className: classData.className || '701',
        subject: classData.subject || '國文',
        reason: '事假',
        subFee: '自費代課',
        leaveTimeType: '全天',
        leaveTime: '08:00~16:00',
        note: '操作教學示範',
        isPaperDraft: true,
        paperFlow: true,
        printed: false
      }];
      const opened = await openPaperPrintDraft(records, { canPrint: true, source: 'paperTour' });
      await nextTick();
      await new Promise((resolve) => setTimeout(resolve, 160));
      return !!(opened && document.querySelector('[data-tour="print-preview-modal"]'));
    };

    const closePaperPrintDemoForTour = () => {
      try {
        if (showPrintPreviewModal.value) closePrintPreview(false);
        paperPrintDraft.value = null;
        paperSignatureByTeacher.value = {};
      } catch (e) {
        showPrintPreviewModal.value = false;
        printPreview.value = null;
      }
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
        requesterName: '',
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
      successFlowMode.value = 'tour';
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
      let leaveSlot = '03/20(三) 第3節 701國文';
      if (demo && demo.classData) {
        const d = String(demo.dateStr || '');
        const mmdd = d.length >= 10 ? d.slice(5, 10).replace('-', '/') : d;
        const dayTxt = typeof getWeekDayText === 'function' ? getWeekDayText(demo.dayOfWeek) : '';
        const cls = ((demo.classData.className || '') + (demo.classData.subject || '')).trim();
        leaveSlot = mmdd + (dayTxt ? '(' + dayTxt + ')' : '') + ' 第' + demo.period + '節' + (cls ? ' ' + cls : '');
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
        if (isAdmin.value || isStaff.value || classReadonlyMode.value) {
          activeTab.value = 'class';
          return true;
        }
        return false;
      },
      openMatchDemo: () => openMatchDemoForTour(),
      closeMatchDemo: () => { closeMatchDemoForTour(); return true; },
      openExchangeModeDemo: () => openExchangeModeDemoForTour(),
      openCompareDemo: () => openCompareDemoForTour(),
      closeCompareDemo: () => { closeCompareDemoForTour(); return true; },
      openPaperPrintDemo: () => openPaperPrintDemoForTour(),
      closePaperPrintDemo: () => { closePaperPrintDemoForTour(); return true; },
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
        await tour.start({ callbacks: tourCallbacks(), mode: notificationsSuppressed.value ? 'paper' : 'online' });
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
    const matchMode = ref('substitution'); // 'substitution'、'exchange' 或 'triangle'
    const activeCell = ref({ teacherEmail: '', teacherName: '', dayOfWeek: 1, period: 1, classData: null });
    // matchPreview 保留給舊接線／模擬；列表點選改走 plain DOM（見 selectMatchPreview*）
    const matchPreview = ref(null);
    const inputRequestDate = ref('');
    const recommendedTeachers = ref([]);
    const recommendationLoading = ref(false);
    const trianglePickB = ref('');
    const trianglePickC = ref('');
    const triangleReason = ref('');
    const triangleNote = ref('');
    const triangleSubmitting = ref(false);
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
    // 帶隊／請假外出教師（重算額度時排除，不寫入折抵額度）
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
    /** 活動互代領域：首次用到再載 domain-activity-cover.js */
    const ensureDAC = async () => {
      if (window.DomainActivityCover) return window.DomainActivityCover;
      if (typeof window.ensureDomainActivityCover === 'function') {
        await window.ensureDomainActivityCover();
      }
      return window.DomainActivityCover || null;
    };
    // ── 活動互代面板狀態（ui-activity.js → UiMutualPanelState）──
    // 延後 create：需 currentWeekDates / getScheduleForDate / softRefresh 就緒
    let _mutualPanelApi = null;
    /** 延後取空堂事件 ID（UiMutualBridge 較晚 create） */
    let _getMutualImportEventId = () => '';
    const getMutualPanelApi = () => {
      if (_mutualPanelApi) return _mutualPanelApi;
      if (!window.UiMutualPanelState) {
        console.error('UiMutualPanelState 未載入');
        return null;
      }
      // 同步路徑：若尚未載入 DAC，先觸發背景載入（常數有 fallback）
      if (!window.DomainActivityCover && typeof window.ensureDomainActivityCover === 'function') {
        window.ensureDomainActivityCover().catch(function () {});
      }
      _mutualPanelApi = window.UiMutualPanelState.create({
        showToast, showConfirm, callGasApi, isAdmin, loading, loadingMessage,
        isMutualCover, mutualAwayClasses, mutualLeadEmails, mutualSkipNotify, mutualNote, mutualDrafts,
        mutualActivityStart, mutualActivityEnd, currentWeekDates, classList, teachersList, allSchedules, requestsList,
        activeCell, inputRequestDate, recommendedTeachers, showMatchModal, pendingRequestData, batchSubFee, directApproveMode,
        ACTIVITY_PUBLIC_FEE, PERIOD8_FEE, getTeacherNameByEmail, softRefreshInBackground, defaultSubFeeForReason, getScheduleForDate,
        classAwayEvents,
        getMutualImportEventId: function () { return _getMutualImportEventId(); },
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
    const recalculateMutualQuotasFromActivity = async () => {
      await ensureDAC();
      const a = getMutualPanelApi();
      if (a) await a.recalculateMutualQuotasFromActivity();
    };
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
    /**
     * 定位到指定教師課表（搜尋姓名並捲動）
     * opts.date / opts.useActivityWeek：一併切到該日期所在週（活動互代用起日）
     */
    const jumpToTeacherTimetable = (email, opts) => {
      const em = String(email || '').trim();
      if (!em) return;
      const t = lookupTeacher(em);
      if (!t) {
        showToast('找不到該教師', 'warning');
        return;
      }
      opts = opts || {};
      // 活動互代：預設跳到活動起日所在週
      let jumpDate = opts.date ? String(opts.date).slice(0, 10) : '';
      if (!jumpDate && (opts.useActivityWeek || isMutualCover.value)) {
        jumpDate = String(mutualActivityStart.value || mutualActivityEnd.value || '').slice(0, 10);
      }
      if (jumpDate && /^\d{4}-\d{2}-\d{2}$/.test(jumpDate)) {
        selectedWeekDate.value = jumpDate;
      }
      activeTab.value = 'timetable';
      selectedSubject.value = 'all';
      searchQuery.value = t.name || '';
      nextTick(() => {
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
          const weekTip = jumpDate
            ? `（週次 ${formatDateMMDD(currentWeekDates.value[0])}～${formatDateMMDD(currentWeekDates.value[4])}）`
            : '';
          showToast(`已定位：${t.name} 老師課表${weekTip}`, 'success');
        });
      });
    };
    /**
     * 送出後樂觀扣減畫面餘額（真正扣包／流水已在 GAS submit 時完成，勿再打 updateMutualQuotas）
     */
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
         const teacherName = String(r['受邀人姓名'] || r.targetTeacherName || '').trim();
         const key = teacherName.toLowerCase();
         if (!key) return;
         deductMap[key] = (deductMap[key] || 0) + 1;
      });
       Object.keys(deductMap).forEach(key => {
         const t = lookupTeacher(key);
         const prev = t ? (parseFloat(t.mutualQuota) || 0) : 0;
         // 每節扣 1；畫面樂觀更新（不足 1 時後端不會扣）
         const next = Math.round(Math.max(0, prev - deductMap[key]) * 1000) / 1000;
         patchLocalMutualQuota(t ? t.teacherName || t.name : key, next);
      });
    };
    /**
     * 申請作廢時樂觀還原折抵額度（後端已寫回試算表；此處只更新畫面）
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
         const teacherName = String(r.targetTeacherName || r['受邀人姓名'] || r.actualTeacherName || '').trim();
         const key = teacherName.toLowerCase();
         if (!key) return;
         addMap[key] = (addMap[key] || 0) + 1;
      });
       Object.keys(addMap).forEach(key => {
         const t = lookupTeacher(key);
         if (!t) return;
         const prev = parseFloat(t.mutualQuota) || 0;
         const next = Math.round((prev + addMap[key]) * 1000) / 1000;
         patchLocalMutualQuota(t.teacherName || t.name, next);
      });
    };
    const selectedClass = ref('');
    const classReadonlyMode = ref(false);
    const pendingClassView = ref('');
    const classDirectory = ref([]);
    const classViewSchedules = ref([]);
    const classViewSchoolSwaps = ref([]);
    const classViewSubstitutionRecords = ref([]);
    const classViewClassAwayEvents = ref([]);
    const classViewLoadedClass = ref('');
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
      classSubstitutionRows.value.forEach(r => {
        const key = `${r.className}|${r.date}|${r.period}`;
        map[key] = r;
      });
      return map;
    });

    const buildClassSchoolSwapChanges = (className, scheduleRows, swapRows, weekDates, isSingleWeekFn) => {
      const cls = String(className || '').trim();
      if (!cls || !window.DomainSchoolSwap) return [];
      const weekSet = new Set(weekDates || []);
      const parseClasses = (raw) => (window.DateUtils && window.DateUtils.parseCombinedClasses)
        ? window.DateUtils.parseCombinedClasses(raw)
        : String(raw || '').split(/[、,，/／|｜\s]+/).map(s => s.trim()).filter(Boolean);
      const schedules = (scheduleRows || []).filter(schedule => {
        if (!schedule || !schedule.className || schedule.attr === '抽離' || schedule.isPullOut) return false;
        return parseClasses(schedule.className).includes(cls);
      });
      const changes = [];
      window.DomainSchoolSwap.normalizeRows(swapRows || [])
        .filter(row => row.enabled)
        .forEach(row => {
          const rowKey = row.id || `${row.dateA}-${row.periodA}-${row.dateB}-${row.periodB}`;
          [
            { endpoint: 'A', date: row.dateA, day: row.dayA, period: row.periodA, sourceDate: row.dateB, sourceDay: row.dayB, sourcePeriod: row.periodB },
            { endpoint: 'B', date: row.dateB, day: row.dayB, period: row.periodB, sourceDate: row.dateA, sourceDay: row.dayA, sourcePeriod: row.periodA }
          ].forEach(endpoint => {
            schedules.forEach((schedule, index) => {
               if (parseInt(schedule.dayOfWeek, 10) !== parseInt(endpoint.sourceDay, 10)
                   || parseInt(schedule.period, 10) !== parseInt(endpoint.sourcePeriod, 10)) return;
               if (window.DomainSchedule && window.DomainSchedule.isActiveOnDate
                   && !window.DomainSchedule.isActiveOnDate(schedule, endpoint.date)) return;
               const attr = String(schedule.attr || '').trim();
              if (typeof isSingleWeekFn === 'function') {
                if (attr === '單週' && !isSingleWeekFn(endpoint.date)) return;
                if (attr === '雙週' && isSingleWeekFn(endpoint.date)) return;
              }
              changes.push({
                id: `school-swap-${rowKey}-${endpoint.endpoint}-${schedule.id || index}`,
                date: endpoint.date,
                period: endpoint.period,
                dayNum: endpoint.day,
                sourceDate: endpoint.sourceDate,
                sourcePeriod: endpoint.sourcePeriod,
                subject: String(schedule.subject || '').trim() || '課程',
                swapName: row.name,
                inWeek: weekSet.has(endpoint.date)
              });
            });
          });
        });
      return changes;
    };
    const shouldAutoStartOnboarding = () => {
      if (classReadonlyMode.value) return false;
      const storageKey = notificationsSuppressed.value ? ONBOARDING_PAPER_STORAGE_KEY : 'jcjh_onboarding_v2';
      try {
        return !localStorage.getItem(storageKey);
      } catch (e) {
        return true;
      }
    };

    // 該班異動摘要：每節一列；調課雙向各一列
    // 格式：月/日（星期）第○節 改上 ○○課（○○師）
    const classChangeSummary = computed(() => {
      const cls = selectedClass.value;
      if (!cls) return [];
      const weekSet = new Set(selectedClassWeekDates.value || []);
      const rows = [];
      classSubstitutionRows.value.forEach(r => {
        if (String(r.className || '') !== String(cls)) return;
        const isEx = isExchangeLikeRequest(r);
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
        const toName = r.actualTeacherName || getTeacherNameByEmail(r.actualTeacherEmail) || '—';
        const subject = r.subject || '';
        const dayPart = dayNum ? (window.DateUtils.getWeekDayText(dayNum) || '') : '';
        const datePart = dayPart
          ? `${formatDateMMDD(r.date)}(${dayPart})`
          : `${formatDateMMDD(r.date)}`;
        const isMutual = !isEx && isQuotaDeductFee(r.subFee);
        const isCombined = isCombinedReturnRequest(r);
        // 班級摘要：互代不顯示「不結鐘點」字樣
        const line = isEx
          ? `${datePart} ${formatPeriodText(r.period)} 改上 ${subject}（${toName}）`
          : isCombined
             ? `${datePart} ${formatPeriodText(r.period)} ${subject} 併班上課，由${toName}代課`
          : isMutual
            ? `${datePart} ${formatPeriodText(r.period)} ${subject} 由${toName}互代`
            : `${datePart} ${formatPeriodText(r.period)} ${subject} 由${toName}代課`;
        rows.push({
          id: r.id,
          date: r.date,
          period: r.period,
          dayText: dayPart,
           type: isEx ? '調課' : (isCombined ? '併班上課' : (isMutual ? '互代' : '代課')),
          line,
          inWeek: weekSet.has(r.date)
        });
      });
      const classSchoolSwapRows = classUsesPublicData.value
        ? classViewSchoolSwaps.value
        : schoolSwaps.value;
      buildClassSchoolSwapChanges(
        cls,
        classScheduleRows.value,
        classSchoolSwapRows,
        selectedClassWeekDates.value,
        isSingleWeek
      ).forEach(change => {
        const dayPart = change.dayNum ? (window.DateUtils.getWeekDayText(change.dayNum) || '') : '';
        const datePart = dayPart
          ? `${formatDateMMDD(change.date)}(${dayPart})`
          : `${formatDateMMDD(change.date)}`;
        const sourcePart = `${formatDateMMDD(change.sourceDate)} ${formatPeriodText(change.sourcePeriod)}`;
        rows.push({
          id: change.id,
          date: change.date,
          period: change.period,
          dayText: dayPart,
          type: '全校對調',
          line: `${datePart} ${formatPeriodText(change.period)} ${change.subject}（原${sourcePart}）`,
          inWeek: change.inWeek,
          isSchoolSwap: true
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
    const classChangeTypeLabels = Object.freeze({
      '全校對調': '全校',
      '併班上課': '併班',
      '合班回原班': '併班',
      '課務調整': '調課',
      '互代不結': '互代',
      '空堂任務': '空堂'
    });
    const getClassChangeTypeLabel = (type) => {
      const value = String(type || '').trim();
      return classChangeTypeLabels[value] || value;
    };
    const matchSearchQuery = ref('');
    const matchDisplayCount = ref(10);
    const matchShowNoTeacherWarning = ref(false);
    /** 媒合 0 人時的可能原因（字串陣列） */
    const matchEmptyReasons = ref(null);

    // 調課推薦
    const exchangeTeacherEmail = ref('');
    const exchangeTeacherClasses = ref([]);
    const exchangePeriodId = ref('');
    const exchangeTargetDate = ref('');
    const exchangeWeekOffset = ref(0);
    const exchangeWeekdayFilter = ref(0); // 0＝全部；1～5＝週一至週五
    const exchangeWeekdayOptions = [
      { value: 0, label: '全部' },
      { value: 1, label: '週一' },
      { value: 2, label: '週二' },
      { value: 3, label: '週三' },
      { value: 4, label: '週四' },
      { value: 5, label: '週五' }
    ];
    const setExchangeWeekdayFilter = (day) => {
      const value = parseInt(day, 10);
      exchangeWeekdayFilter.value = value >= 1 && value <= 5 ? value : 0;
      matchDisplayCount.value = 10;
    };


    // 雙人對比 Modal 與列印
    const showCompareModal = ref(false);
    const showTriangleTimetablePreview = ref(false);
    const showSuccessModal = ref(false);
    const showLineMessageModal = ref(false);
    const lineMessageTitle = ref('LINE 訊息');
    const lineMessageText = ref('');
    const successModalTitle = ref('');
    const successModalMessage = ref('');
    /** 成功畫面固定步驟：normal 三步／direct 兩步／tour 導覽 */
    const successFlowMode = ref('normal');
    const successActionRequests = ref([]);
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

    const openLineMessageEditor = (text, title = 'LINE 訊息') => {
      // LINE 編輯器取代目前的內容視窗，避免兩個 modal 疊在一起。
      showDetailModal.value = false;
      showCompareModal.value = false;
      showSuccessModal.value = false;
      lineMessageTitle.value = title;
      lineMessageText.value = String(text || '');
      showLineMessageModal.value = true;
    };
    const copyEditedLineMessage = () => copyLineMessage(lineMessageText.value);
    const sendEditedLineMessage = () => sendLineMessage(lineMessageText.value);

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
      const userName = user.value ? String(getTeacherNameByEmail(user.value.email) || '').toLowerCase() : '';
      const requesterName = req.requesterName ? String(req.requesterName).toLowerCase() : '';
      const targetTeacherName = req.targetTeacherName ? String(req.targetTeacherName).toLowerCase() : '';
      const isExchange = isExchangeLikeRequest(req);

      if (isTriangleRequest(req)) {
        const group = getTriangleGroupRequests(req);
        const ownName = user.value
          ? String(getTeacherNameByEmail(user.value.email) || '').toLowerCase()
          : '';
        const own = group.find(row => String(row.requesterName || '').toLowerCase() === ownName) || group[0];
        if (!own || !own.targetDate || own.targetPeriod == null) return null;

        const timeSpan = window.DateUtils.getPeriodTimeSpan(own.targetPeriod);
        if (!timeSpan) return null;
        const timeParts = timeSpan.split('-');
        const datePart = String(own.targetDate).replace(/-/g, '');
        const startIso = datePart + 'T' + timeParts[0].replace(':', '') + '00';
        const endIso = datePart + 'T' + timeParts[1].replace(':', '') + '00';
        const routeLines = group.map(row =>
          `${row.requesterName || ''}：${row.requestDate || ''}第${row.requestPeriod || ''}節 → ${row.targetDate || ''}第${row.targetPeriod || ''}節`
        ).join('\n');
        const slotLabel = `${own.className || ''}${own.subject || ''}`.trim() || '三角調課';
        return {
          title: `【三角調入】${slotLabel}`,
          startIso,
          endIso,
          details: `本節請調入另一位教師的課程。\n${routeLines}\n\n參與教師：${group.map(row => row.requesterName || row.targetTeacherName || '').filter(Boolean).join('、')}\n單號：${req.serial || ''}\n（建成國中線上課表系統）`,
          titleTag: '三角調入'
        };
      }

      const isLeaveSide = !!(userName && userName === requesterName);
      const isCoverSide = !!(userName && userName === targetTeacherName);

      const subs = (substitutionRecords.value || []).filter(r => r && String(r.requestId) === String(req.id));
      const findSubAt = (dateStr, period, asActual) => {
        const p = parseInt(period, 10);
        return subs.find(r =>
          String(r.date || '') === String(dateStr || '')
          && parseInt(r.period, 10) === p
          && (asActual
             ? (r.actualTeacherName && String(r.actualTeacherName).toLowerCase() === userName)
             : (r.originalTeacherName && String(r.originalTeacherName).toLowerCase() === userName))
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

        if (isCombinedReturnRequest(req)) {
          eventDate = req.requestDate;
          eventPeriod = req.requestPeriod;
          className = req.className || '';
          subject = req.subject || '';
          if (isLeaveSide) {
            titleTag = '不用上';
            actionLine = `本節不用上。\n由 ${req.targetTeacherName || '其他併班任課教師'} 代課。`;
          } else if (isCoverSide) {
            titleTag = '代課';
            actionLine = `本節請代課。\n請假教師：${req.requesterName || ''}。`;
          } else {
             titleTag = '併班上課';
            actionLine = `請假：${req.requesterName || ''}　代課：${req.targetTeacherName || ''}`;
          }
       } else if (isExchange) {
        if (isLeaveSide) {
          // 申請人調入：時間＝對方節；班科＝自己的課
          eventDate = req.targetDate || req.requestDate;
          eventPeriod = req.targetPeriod != null ? req.targetPeriod : req.requestPeriod;
          const cs = pickClassSubject(null, req.className, req.subject);
          className = cs.className;
          subject = cs.subject;
          titleTag = '調入';
          actionLine = `本則為您的上課節次（您的課程：${req.className || ''} ${req.subject || ''}）。\n原節 ${req.requestDate || ''}第${req.requestPeriod || ''}節不用上，由 ${req.targetTeacherName || '對方'} 上。`;
        } else if (isCoverSide) {
          // 受邀人調入：時間＝申請人原節；班科＝自己的課（對調目標節原課）
          eventDate = req.requestDate;
          eventPeriod = req.requestPeriod;
          const tgtInfo = getTargetClassAndSubject(req);
          const cs = pickClassSubject(null, tgtInfo.className || req.targetClassName || '', tgtInfo.subject || req.targetSubject || '');
          className = cs.className;
          subject = cs.subject;
          titleTag = '調入';
          actionLine = `本則為您的上課節次（您的課程：${className || ''} ${subject || ''}）。\n您原 ${req.targetDate || ''}第${req.targetPeriod || ''}節不用上，由 ${req.requesterName || '對方'} 上。`;
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
       const periodText = formatPeriodText(eventPeriod);
       const title = `【${titleTag}】${slotLabel}`;
       let details = `${actionLine}\n\n請假教師：${req.requesterName || ''}\n代課／對調教師：${req.targetTeacherName || ''}\n假別事由：${req.reason || '請假'}\n單號：${req.serial || ''}`;
       details += `\n節次：${periodText}`;
        if (isCombinedReturnRequest(req)) {
           details += `\n流程：併班上課（請假教師由其他併班任課教師代課）`;
        }
       if (isExchange) {
         details += `\n對調：${req.requestDate || ''}${formatPeriodText(req.requestPeriod)} ⇄ ${req.targetDate || ''}${formatPeriodText(req.targetPeriod)}`;
      }
      details += `\n（建成國中線上課表系統）`;

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
        'PRODID:-//建成國中線上課表系統//NONSGML v1.0//EN',
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
      if (isExchangeLikeRequest(req)) {
        const info = getTargetClassAndSubject(req);
        return info.subject || req.targetSubject || '';
      }
      return req.targetSubject || req.subject || '';
    };
    const getTargetClassAndSubject = (req) => {
      if (!isExchangeLikeRequest(req)) return { className: '', subject: '' };
      if (isTriangleRequest(req)) {
        // 三角調是整堂原課跟著來源教師移動，不使用目標教師原課班科。
        return {
          className: String(req.className || '').trim(),
          subject: String(req.subject || '').trim()
        };
      }
      const explicitClass = String(req.targetClassName || '').trim();
      const explicitSubject = String(req.targetSubject || '').trim();
      if (explicitClass || explicitSubject) {
        return { className: explicitClass, subject: explicitSubject };
      }
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
       if (!dateStr) return '';
       const d = new Date(dateStr.replace(/-/g, '/'));
       const day = d.getDay() === 0 ? 7 : d.getDay();
       const cell = resolveExchangeTargetCell(req.requesterEmail, dateStr, req.requestPeriod, day);
       return cell ? (cell.subject || '') : '';
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
      if (!isExchangeLikeRequest(req)) return '';
      return getTargetClassAndSubject(req).subject;
    };

    const getOriginalTargetClass = (req) => {
      if (!isExchangeLikeRequest(req)) return '';
      return getTargetClassAndSubject(req).className;
    };


    const resolveDetailRequest = (reqId, subRecord) => {
      let matched = requestsList.value.find(r => r.id === reqId);
      if (!matched) {
        matched = allPendingRequests.value.find(r => r.id === reqId);
      }
      if (matched) return matched;
      if (!subRecord) return null;
      if (isTriangleRequest(subRecord)) {
        return {
          id: subRecord.requestId || subRecord.id,
          serial: subRecord.serial || '---',
          type: 'triangle',
          requesterEmail: subRecord.actualTeacherEmail || subRecord.actualTeacherName || '',
          targetTeacherEmail: subRecord.originalTeacherEmail || subRecord.originalTeacherName || '',
          requesterName: subRecord.actualTeacherName || '',
          targetTeacherName: subRecord.originalTeacherName || '',
          requestDate: subRecord.triangleSourceDate || subRecord.date || '',
          requestPeriod: subRecord.triangleSourcePeriod != null ? subRecord.triangleSourcePeriod : subRecord.period,
          requestPeriodDay: subRecord.triangleSourceDayOfWeek || null,
          targetDate: subRecord.date || '',
          targetPeriod: subRecord.period,
          targetDayOfWeek: subRecord.dayOfWeek || null,
          className: subRecord.className || '',
          subject: subRecord.subject || '',
          targetClassName: subRecord.className || '',
          targetSubject: subRecord.subject || '',
          triangleId: subRecord.triangleId || '',
          triangleLegIndex: subRecord.triangleLegIndex || null,
          reason: subRecord.reason || '三角調課',
          subFee: '無',
          status: subRecord.status || 'approved',
          note: subRecord.note || ''
        };
      }

      let reqDate = subRecord.date;
      let reqPeriod = subRecord.period;
      let reqPeriodDay = subRecord.dayOfWeek;
      let tgtDate = '—';
      let tgtPeriod = null;
      let tgtDayOfWeek = null;

      let requesterEmail = subRecord.originalTeacherEmail;
      let requestClass = subRecord.className;
      let targetTeacherEmail = subRecord.actualTeacherEmail;
      let targetClass = '';
      let reqSubject = subRecord.subject;
      let tgtSubject = '';

        if (isExchangeLikeRequest(subRecord)) {
        const peer = substitutionRecords.value.find(r => r.requestId === reqId && r.id !== subRecord.id);
        if (peer) {
          const isSub1 = String(subRecord.id).endsWith('_1');
          const isSub2 = String(subRecord.id).endsWith('_2');

           if (isSub2) {
            reqDate = subRecord.date;
            reqPeriod = subRecord.period;
             reqPeriodDay = subRecord.dayOfWeek;
             requesterEmail = subRecord.originalTeacherEmail;
              requestClass = subRecord.className;
              reqSubject = subRecord.subject;

            tgtDate = peer.date;
             tgtPeriod = peer.period;
             tgtDayOfWeek = peer.dayOfWeek;
             targetTeacherEmail = peer.originalTeacherEmail;
              targetClass = peer.className;
              tgtSubject = peer.subject;
           } else {
            reqDate = peer.date;
            reqPeriod = peer.period;
             reqPeriodDay = peer.dayOfWeek;
             requesterEmail = peer.originalTeacherEmail;
              requestClass = peer.className;
              reqSubject = peer.subject;

            tgtDate = subRecord.date;
             tgtPeriod = subRecord.period;
             tgtDayOfWeek = subRecord.dayOfWeek;
             targetTeacherEmail = subRecord.originalTeacherEmail;
              targetClass = subRecord.className;
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
        className: requestClass,
        subject: reqSubject,
        targetClassName: targetClass,
        targetSubject: tgtSubject,
         reason: subRecord.reason || '請假',
         subFee: subRecord.subFee || '自費代課',
         specialFlow: subRecord.specialFlow || '',
         status: subRecord.status || 'approved',
        note: subRecord.note || ''
      };
    };

    const printSingleRequest = async (req, formType = 'Notice') => {
      let targetIds = [];
      const triangleId = req && (req.triangleId || req.batchId);
      if (triangleId && isTriangleRequest(req)) {
        targetIds = substitutionRecords.value
          .filter(r => r && r.triangleId && String(r.triangleId) === String(triangleId))
          .map(r => r.id);
      } else if (substitutionRecords.value && substitutionRecords.value.length > 0) {
        targetIds = substitutionRecords.value
          .filter(r => String(r.requestId) === String(req.id))
          .map(r => r.id);
      }
      if (targetIds.length === 0 && detailSubRecord.value) {
        targetIds = [detailSubRecord.value.id];
      }
      const seedRecord = (substitutionRecords.value || []).find(record => targetIds.includes(record.id));
      const batchId = String((req && req.batchId) || (seedRecord && (seedRecord.batchId || seedRecord['批次ID'])) || '').trim().toLowerCase();
      if (batchId && seedRecord) {
        const teacherKey = (record, side) => {
          const email = side === 'original'
            ? (record.originalTeacherEmail || record.requesterEmail || '')
            : (record.actualTeacherEmail || record.targetTeacherEmail || '');
          const name = side === 'original'
            ? (record.originalTeacherName || record.requesterName || '')
            : (record.actualTeacherName || record.targetTeacherName || '');
          return String((email && getTeacherNameByEmail(email)) || name || email || '').trim().toLowerCase();
        };
        const applicantKey = teacherKey(seedRecord, 'original');
        const targetKey = teacherKey(seedRecord, 'actual');
        if (applicantKey && targetKey) {
          targetIds = (substitutionRecords.value || []).filter(record =>
            String(record && (record.batchId || record['批次ID']) || '').trim().toLowerCase() === batchId
            && String(record && record.type || '') === String(seedRecord.type || '')
            && teacherKey(record, 'original') === applicantKey
            && teacherKey(record, 'actual') === targetKey
          ).map(record => record.id);
        }
      }
      if (targetIds.length === 0) {
        showToast("⚠️ 找不到該筆核准的代課明細，無法執行列印。", "error");
        return;
      }
      const prevSelected = [...selectedRecordIds.value];
      selectedRecordIds.value = targetIds;
      try {
        const targetRecords = (substitutionRecords.value || []).filter(record => targetIds.includes(record.id));
        const returnTo = showDetailModal.value ? 'detail' : '';
        await openPrintPreview(formType, { records: targetRecords, returnTo });
      } finally {
        selectedRecordIds.value = prevSelected;
      }
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

    // LINE 範本：短版、先說明需求，再列課務與回覆方式。
    const formatLineSlot = (date, day, period, className, subject, teacherName) => {
      const dateText = formatDateMMDD(date) || date || '';
      const dayText = getWeekDayText(day);
      const periodText = formatPeriodText(period);
      const lesson = [className, subject].filter(value => String(value || '').trim()).join('');
      const teacher = cleanLineTeacherName(teacherName);
      const teacherSuffix = teacher ? `（${teacher}老師）` : '';
      return `${dateText}${dayText ? `(${dayText})` : ''} ${periodText}${lesson ? ` ${lesson}${teacherSuffix}` : ''}`.trim();
    };

    const cleanLineTeacherName = (value) => String(value || '').replace(/\s*老師\s*$/, '').trim();

    const getLineExchangePartner = (value) => {
      const name = shortTeacherName(value);
      return name && name !== '我' ? `${name}老師` : '我';
    };

    const buildLineInviteText = (opts) => {
      const name = shortTeacherName(opts.targetName) || cleanLineTeacherName(opts.targetName) || '對方';
      const requesterName = cleanLineTeacherName(opts.requesterName);
      const courseTeacherA = opts.courseTeacherA || opts.teacherA || opts.requesterName;
      const courseTeacherB = opts.courseTeacherB || opts.teacherB || opts.targetTeacherName || opts.targetName;
      const leaveLine = formatLineSlot(opts.dateA, opts.dayA, opts.periodA, opts.classA, opts.subjectA, courseTeacherA);
      const opening = opts.isExchange
        ? `${name}老師，想問您是否方便和${getLineExchangePartner(requesterName)}調課，`
        : `${name}老師，想問您是否可以協助代課：`;
      let text = `${opening}\n`;
      if (opts.isExchange) {
        const swapLine = formatLineSlot(opts.dateB, opts.dayB, opts.periodB, opts.classB, opts.subjectB, courseTeacherB);
        text += `\n${leaveLine}<->\n${swapLine}`;
      } else {
        text += leaveLine;
      }
      if (opts.notificationOnly) {
        text += '\n\n這筆安排已完成，請依排定時間上課。';
      } else if (opts.agreeLink || opts.declineLink) {
        text += '\n\n請回覆：';
        if (opts.agreeLink) text += `\n✅ 可以：${opts.agreeLink}`;
        if (opts.declineLink) text += `\n❌ 不方便：${opts.declineLink}`;
      }
      if (opts.systemUrl && opts.notificationOnly) text += `\n\n查看詳情：${opts.systemUrl}`;
      text += '\n\n感謝🙏🏻';
      return text;
    };

    /** 取姓名後兩字（先剔除括號註記，避免尾巴被切到） */
    const shortTeacherName = (fullName) => {
      const base = cleanLineTeacherName(String(fullName || '').replace(/[（(].*$/, ''));
      return base.length > 2 ? base.slice(-2) : base;
    };

    // LINE 描述實際處理的課堂；明細列優先用 date/period，申請列才回退 requestDate/requestPeriod。
    const getLineHandledSlot = (row) => {
      const source = row || {};
      const date = source.handledDate || source.dutyDate || source.date
        || source.requestDate || source['異動日期'] || '';
      let period = source.handledPeriod != null ? source.handledPeriod
        : (source.dutyPeriod != null ? source.dutyPeriod
          : (source.period != null ? source.period
            : (source.requestPeriod != null ? source.requestPeriod : source['異動節次'])));
      let day = source.handledDayOfWeek != null ? source.handledDayOfWeek
        : (source.dutyDayOfWeek != null ? source.dutyDayOfWeek
          : (source.dayOfWeek != null ? source.dayOfWeek : source.requestPeriodDay));
      if ((day == null || day === '' || period == null || period === '') && source.timeKey
          && window.DateUtils && typeof window.DateUtils.decodeTimeKey === 'function') {
        const decoded = window.DateUtils.decodeTimeKey(source.timeKey);
        if (day == null || day === '') day = decoded.day;
        if (period == null || period === '') period = decoded.period;
      }
      if ((day == null || day === '') && date) {
        const parsed = new Date(String(date).replace(/-/g, '/'));
        if (!Number.isNaN(parsed.getTime())) day = parsed.getDay() === 0 ? 7 : parsed.getDay();
      }
      return {
        date,
        day,
        period,
        className: source.handledClassName || source.dutyClassName || source.className || source.cls || source['班級'] || '',
        subject: source.handledSubject || source.dutySubject || source.subject || source['科目'] || ''
      };
    };

    /**
     * 送出前「先問對方」LINE 範本：只有詢問，沒有同意／拒絕連結（尚未送出）
     * opts: { targetName, isExchange, dateA, dayA, periodA, classA, subjectA,
     *         dateB, dayB, periodB, classB, subjectB, leaveTime }
     */
    const buildAskFirstLineText = (opts) => {
      const name = shortTeacherName(opts.targetName) || cleanLineTeacherName(opts.targetName) || '對方';
      const requesterName = cleanLineTeacherName(opts.requesterName);
      const courseTeacherA = opts.courseTeacherA || opts.teacherA || opts.requesterName;
      const courseTeacherB = opts.courseTeacherB || opts.teacherB || opts.targetTeacherName || opts.targetName;
      if (opts.isExchange) {
        const lineA = formatLineSlot(opts.dateA, opts.dayA, opts.periodA, opts.classA, opts.subjectA, courseTeacherA);
        const lineB = formatLineSlot(opts.dateB, opts.dayB, opts.periodB, opts.classB, opts.subjectB, courseTeacherB);
        return `${name}老師，想問您是否方便和${getLineExchangePartner(requesterName)}調課，\n\n${lineA}<->\n${lineB}\n\n如果可以，我再拿調課單給您，感謝🙏🏻`;
      }
      const slots = Array.isArray(opts.slots) && opts.slots.length
        ? opts.slots
        : [{
          date: opts.dateA,
          day: opts.dayA,
          period: opts.periodA,
          className: opts.classA,
          subject: opts.subjectA,
          teacherName: courseTeacherA
        }];
      const lines = slots.map((slot, index) => {
        const line = formatLineSlot(slot.date, slot.day, slot.period, slot.className, slot.subject, slot.teacherName || courseTeacherA);
        return `${slots.length > 1 ? `${index + 1}. ` : ''}${line}`;
      });
      return `${name}老師，想問您是否可以協助代課：\n${lines.join('\n')}\n\n如果可以，我再拿代課單給您，感謝🙏🏻`;
    };

    /**
     * 批次 LINE：一則訊息只含「該受邀人」的節次
     * 若該人只有 1 節 → 改用一般單節邀請格式（不出現批次用語）
     * opts: { targetName, requesterName, reason, subFee, systemUrl, batchId, paperFlow, slots: [{ id, date, day, period, className, subject }] }
     */
    const buildLineBatchInviteText = (opts) => {
      const name = shortTeacherName(opts.targetName) || cleanLineTeacherName(opts.targetName) || '對方';
      const slots = opts.slots || [];
      const n = slots.length;
      if (opts.paperFlow) {
        return buildAskFirstLineText({
          targetName: name,
          requesterName: opts.requesterName,
          isExchange: false,
          slots: slots.map((slot) => ({
            date: slot.date,
            day: slot.day,
            period: slot.period,
            className: slot.className,
            subject: slot.subject,
            teacherName: slot.teacherName || opts.requesterName
          }))
        });
      }
      const currentUrl = opts.systemUrl || (window.location.origin + window.location.pathname);
      const batchId = opts.batchId || '';

      // 單節：與一般代課邀請共用短版格式
      if (n === 1) {
        const s = slots[0];
        return buildLineInviteText({
          targetName: name,
          requesterName: opts.requesterName,
          dateA: s.date,
          dayA: s.day,
          periodA: s.period,
          classA: s.className,
          subjectA: s.subject,
          courseTeacherA: s.teacherName || opts.courseTeacherA || opts.requesterName,
          agreeLink: `${currentUrl}?action=respond&id=${encodeURIComponent(s.id)}&status=agree`,
          declineLink: `${currentUrl}?action=respond&id=${encodeURIComponent(s.id)}&status=decline`,
          systemUrl: currentUrl,
          isExchange: false
        });
      }

      let text = `${name}老師，想問您是否可以幫忙協助以下代課：`;
      if (batchId) {
        text += '\n\n請回覆：';
        text += `\n✅ 全部可以：${currentUrl}?action=respondBatch&batchId=${encodeURIComponent(batchId)}&status=agree`;
        text += `\n❌ 全部不便：${currentUrl}?action=respondBatch&batchId=${encodeURIComponent(batchId)}&status=decline`;
      }
      slots.forEach((s, i) => {
        const line = formatLineSlot(s.date, s.day, s.period, s.className, s.subject, s.teacherName || opts.courseTeacherA || opts.requesterName);
        const agree = `${currentUrl}?action=respond&id=${encodeURIComponent(s.id)}&status=agree`;
        const decline = `${currentUrl}?action=respond&id=${encodeURIComponent(s.id)}&status=decline`;
        text += `\n\n${i + 1}. ${line}\n　✅ 可以：${agree}\n　❌ 不方便：${decline}`;
      });
      text += '\n\n感謝🙏🏻';
      return text;
    };

    const copyLineMessageForRequest = (req) => {
      const isExchange = isExchangeLikeRequest(req);
      const paperFlowRequest = isPaperFlowRequest(req);
      const currentUrl = window.location.origin + window.location.pathname;

      // 同批次多筆：只組「同一受邀人」的節次（不混入其他人）
      let lineText = '';
      if (paperFlowRequest) {
        const targetName = String(req.targetTeacherName || '').toLowerCase();
        const peers = req.batchId
          ? (requestsList.value || []).filter(r =>
            r.batchId && r.batchId === req.batchId && isPaperFlowRequest(r)
           && (!targetName || String(r.targetTeacherName || '').toLowerCase() === targetName)
          ).sort((a, b) => {
             const slotA = getLineHandledSlot(a);
             const slotB = getLineHandledSlot(b);
             if (slotA.date !== slotB.date) return String(slotA.date || '').localeCompare(String(slotB.date || ''));
             return (parseInt(slotA.period, 10) || 0) - (parseInt(slotB.period, 10) || 0);
          })
          : [req];
         const rows = peers.length ? peers : [req];
         const first = rows[0];
         const firstIsExchange = first.type === 'exchange' || first.type === '對調';
         const firstSlot = getLineHandledSlot(first);
         const askOptions = {
           targetName: first.targetTeacherName || req.targetTeacherName,
           requesterName: isProxySubmitRequest(first)
             ? (first.requesterName || req.requesterName)
             : '',
           isExchange: firstIsExchange,
            courseTeacherA: first.requesterName || first.originalTeacherName || '',
            courseTeacherB: first.targetTeacherName || first.actualTeacherName || '',
            dateA: firstSlot.date,
           dayA: firstSlot.day,
           periodA: firstSlot.period,
           classA: getOriginalRequestClass(first) || firstSlot.className,
           subjectA: getOriginalRequestSubject(first) || firstSlot.subject
         };
        if (firstIsExchange) {
          askOptions.dateB = first.targetDate;
          askOptions.dayB = first.targetDayOfWeek;
          askOptions.periodB = first.targetPeriod;
          askOptions.classB = getOriginalTargetClass(first) || '';
          askOptions.subjectB = getOriginalTargetSubject(first) || '';
         } else if (rows.length > 1) {
           askOptions.slots = rows.map(row => {
             const slot = getLineHandledSlot(row);
             return {
               date: slot.date,
               day: slot.day,
               period: slot.period,
                className: getOriginalRequestClass(row) || slot.className,
                subject: getOriginalRequestSubject(row) || slot.subject,
                teacherName: row.requesterName || row.originalTeacherName || ''
             };
           });
        }
        lineText = buildAskFirstLineText(askOptions);
      } else if (req.batchId && !isExchange) {
        const targetEmail = String(req.targetTeacherEmail || '').toLowerCase();
        const peers = (requestsList.value || []).filter(r =>
          r.batchId && r.batchId === req.batchId &&
           (r.status === 'pending_teacher' || r.status === req.status) &&
           (!targetEmail || String(r.targetTeacherEmail || '').toLowerCase() === targetEmail)
         ).sort((a, b) => {
           const slotA = getLineHandledSlot(a);
           const slotB = getLineHandledSlot(b);
           if (slotA.date !== slotB.date) return String(slotA.date || '').localeCompare(String(slotB.date || ''));
           return (parseInt(slotA.period, 10) || 0) - (parseInt(slotB.period, 10) || 0);
        });
         const slots = (peers.length ? peers : [req]).map(r => {
           const slot = getLineHandledSlot(r);
           return {
             id: r.id,
             date: slot.date,
             day: slot.day,
             period: slot.period,
              className: getOriginalRequestClass(r) || slot.className,
              subject: getOriginalRequestSubject(r) || slot.subject,
              teacherName: r.requesterName || r.originalTeacherName || ''
           };
         });
        lineText = buildLineBatchInviteText({
          targetName: req.targetTeacherName,
          requesterName: isProxySubmitRequest(req) ? req.requesterName : '',
          reason: req.reason,
          subFee: req.subFee,
          systemUrl: currentUrl,
          batchId: req.batchId,
          slots
        });
      } else {
        const agreeLink = `${currentUrl}?action=respond&id=${req.id}&status=agree`;
        const declineLink = `${currentUrl}?action=respond&id=${req.id}&status=decline`;
         const leaveSlot = getLineHandledSlot(req);
         const leaveClass = getOriginalRequestClass(req) || leaveSlot.className;
         const leaveSubject = getOriginalRequestSubject(req) || leaveSlot.subject;
        let swapClass = '';
        let swapSubject = '';
        if (isExchange) {
          swapClass = getOriginalTargetClass(req) || '';
          swapSubject = getOriginalTargetSubject(req) || '';
        }
        lineText = buildLineInviteText({
          targetName: req.targetTeacherName,
          requesterName: isProxySubmitRequest(req) ? req.requesterName : '',
          courseTeacherA: req.requesterName || req.originalTeacherName || '',
          courseTeacherB: req.targetTeacherName || req.actualTeacherName || '',
           dateA: leaveSlot.date,
           dayA: leaveSlot.day,
           periodA: leaveSlot.period,
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

      openLineMessageEditor(lineText, paperFlowRequest ? '送出前先問對方（LINE 範本）' : 'LINE 邀請訊息');
    };
    const pendingRequestData = ref({
      mode: '', leaveTeacher: '', subTeacher: '', cls: '', subject: '', date: '', timeKey: '',
      reason: '', leaveReasonBeforeCourseAdjustment: '', courseAdjustmentOnly: false,
      subFee: '', dateB: '', timeB: '', subB: '', note: '',
      leaveTimeType: '', leaveTimeStart: '', leaveTimeEnd: '', leaveTime: '',
      submitRequestId: '', submitSerial: '', submitBatchId: ''
    });
    const combinedReturnCandidates = ref([]);
    // 送出前「先問對方」LINE 範本：依當前申請資料即時更新（批次暫不提供）
    const askFirstLineText = computed(() => {
      const p = pendingRequestData.value || {};
      if (!p.mode || p.isBatch) return '';
      const targetEmail = String(p.subTeacher || '').trim();
      if (!targetEmail) return '';
      // 非本人申請（行政代申請／教學組直接核准等）：受話對象是「請假老師」而非「我」
      const leaveEmail = String(p.leaveTeacher || '').trim().toLowerCase();
      const currentEmail = user.value && user.value.email
        ? String(user.value.email).trim().toLowerCase()
        : '';
      const isProxyApplication = !!(leaveEmail && currentEmail && leaveEmail !== currentEmail);
      const handledSlot = getLineHandledSlot(p);
      const opts = {
        targetName: shortTeacherName(getTeacherNameByEmail(targetEmail) || targetEmail),
         requesterName: isProxyApplication
           ? (getTeacherNameByEmail(p.leaveTeacher) || p.leaveTeacher || '')
           : '',
         courseTeacherA: getTeacherNameByEmail(p.leaveTeacher) || p.leaveTeacher || '',
         courseTeacherB: getTeacherNameByEmail(p.subTeacher) || p.subTeacher || '',
         isExchange: p.mode === 'exchange',
        dateA: handledSlot.date,
        dayA: handledSlot.day,
        periodA: handledSlot.period,
        classA: handledSlot.className,
        subjectA: handledSlot.subject
      };
      if (p.mode === 'exchange') {
        const tkB = (window.DateUtils && window.DateUtils.decodeTimeKey)
          ? window.DateUtils.decodeTimeKey(p.timeB)
          : { day: parseInt(String(p.timeB || '').charAt(0), 10), period: parseInt(String(p.timeB || '').slice(-1), 10) };
        opts.dateB = p.dateB;
        opts.dayB = tkB.day;
        opts.periodB = tkB.period;
        opts.classB = p.subBClass || '';
        opts.subjectB = p.subB || '';
      }
      return buildAskFirstLineText(opts);
    });
    const askFirstLineDraft = ref('');
    watch(askFirstLineText, (text) => {
      if (!showLineMessageModal.value) askFirstLineDraft.value = text || '';
    }, { immediate: true });
    const selectedRecordIds = ref([]);
    const showDevDropdown = ref(false);
    const paperPrintDraft = ref(null);
    const paperSignatureByTeacher = ref({});
    const showPrintPreviewModal = ref(false);
    const printPreview = ref(null);
    const printPreviewImageBusy = ref(false);
    // 防連點：送出申請期間鎖住按鈕（含 validate／confirm 等待）
    const isSubmitting = ref(false);

    // 異動詳情對話框 (已經生效或簽核中的調代課格子)
    const showDetailModal = ref(false);
    const consecAlertsA = ref([]);
    const consecAlertsB = ref([]);
    const detailRequest = ref(null);
    const detailSubRecord = ref(null);

    // 內容型 modal 只保留一個，避免詳情、LINE、列印視窗互相遮住。
    watch(showDetailModal, (open) => {
      if (!open) return;
      showLineMessageModal.value = false;
      showPrintPreviewModal.value = false;
      showCompareModal.value = false;
      showSuccessModal.value = false;
    });
    watch(showLineMessageModal, (open) => {
      if (!open) return;
      showDetailModal.value = false;
      showPrintPreviewModal.value = false;
      showCompareModal.value = false;
      showSuccessModal.value = false;
    });
    watch(showPrintPreviewModal, (open) => {
      if (!open) return;
      showDetailModal.value = false;
      showLineMessageModal.value = false;
      showCompareModal.value = false;
      showTriangleTimetablePreview.value = false;
      showSuccessModal.value = false;
    });
    watch(showTriangleTimetablePreview, (open) => {
      if (!open) return;
      showDetailModal.value = false;
      showLineMessageModal.value = false;
      showPrintPreviewModal.value = false;
      showSuccessModal.value = false;
    });
    watch(showSuccessModal, (open) => {
      if (!open) return;
      showDetailModal.value = false;
      showLineMessageModal.value = false;
      showPrintPreviewModal.value = false;
      showCompareModal.value = false;
    });

    // 歷史紀錄篩選與分頁（預設顯示全部，避免新送出的申請被日期篩選排除）
    const historyFilterMode = ref('all');
    const historyTypeFilter = ref('all');
    const historyFilterDate = ref(new Date().toISOString().split('T')[0]);
    const historySearchQuery = ref('');
    const historyPage = ref(1);

    const isHistoryExchangeType = (record) => {
      const type = String(record && record.type || '').trim().toLowerCase();
      return type === 'exchange' || type === '對調' || type === '調課' || type === 'triangle' || type === '三角調';
    };
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
        const normSt = (s) => {
          if (window.FieldMap && window.FieldMap.normalizeRequestStatus) {
            return window.FieldMap.normalizeRequestStatus(s);
          }
          return String(s || '').toLowerCase();
        };
        const isOpenPending = (st) => {
          const n = normSt(st);
          return n === 'pending_teacher' || n === 'pending_admin';
        };
        const serverPendingById = {};
        const mappedPending = rows.map(r => {
          const m = window.FieldMap.mapRequest(r);
          if (m && m.id) serverPendingById[m.id] = m;
          return m;
        }).filter(Boolean);
        // 伺服器回 0 筆、本地仍有進行中 → 可能掃描失敗或空快取，勿全部幽靈取消
        const localOpenN = (requestsList.value || []).filter(r => r && isOpenPending(r.status)).length;
        if (mappedPending.length === 0 && localOpenN > 0) {
          console.warn('pendingOnly 回空但本地有進行中', localOpenN, '筆，略過幽靈取消');
          return false;
        }
        const next = [];
        const seen = {};
        let ghosted = false;
        (requestsList.value || []).forEach(r => {
          if (!r || !r.id) return;
          if (isOpenPending(r.status)) {
            if (serverPendingById[r.id]) {
              // 伺服器仍進行中：合併
              next.push(Object.assign({}, r, serverPendingById[r.id]));
              seen[r.id] = 1;
            } else if (mappedPending.length > 0) {
              // 伺服器有回其他 pending、唯獨本筆消失 → 才幽靈取消（已核准／已駁回）
              next.push(Object.assign({}, r, { status: 'cancelled' }));
              seen[r.id] = 1;
              ghosted = true;
            } else {
              // 伺服器空包：保留本地，交給後續 delta／全量
              next.push(r);
              seen[r.id] = 1;
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
      // 本日／本週／本月：對齊篩選日期到今天（可再改 date 輸入）
      if (mode === 'day' || mode === 'week' || mode === 'month') {
        if (!historyFilterDate.value) {
          historyFilterDate.value = toLocalDateStr(new Date());
        }
        if (mode === 'day') {
          historyFilterDate.value = toLocalDateStr(new Date());
        }
      }
      if (mode === 'month') {
        ensureHistoryMonthLoaded(String(historyFilterDate.value || '').slice(0, 7));
      }
    };

    const setHistoryTypeFilter = (type) => {
      const next = ['all', 'substitution', 'exchange'].includes(type) ? type : 'all';
      historyTypeFilter.value = next;
      historyPage.value = 1;
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
      try {
        await loadWeeklyData({ force: true, silent: false });
        showToast('已恢復近兩週資料視窗', 'info');
      } catch (e) {
        showToast('恢復資料視窗失敗：' + (e && e.message ? e.message : e), 'error');
      }
    };

    // 管理員編輯歷史紀錄（可改全部代／調課欄位）
    const showHistoryEditModal = ref(false);
    const historyEditForm = ref({
      id: '',
      requestId: '',
      specialFlow: '',
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
      leaveTimeType: '',
      leaveTime: '',
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
    const ACCOUNTING_WEEKS_STORAGE_KEY = 'jcjh_accounting_report_weeks';
    const normalizeAccountingWeeksSetting = (value) => {
      const weeks = Number(value);
      return Number.isInteger(weeks) && weeks >= 1 && weeks <= 6 ? weeks : null;
    };
    const loadAccountingWeeksSetting = (month) => {
      try {
        const saved = JSON.parse(window.localStorage.getItem(ACCOUNTING_WEEKS_STORAGE_KEY) || '{}');
        return normalizeAccountingWeeksSetting(saved && saved[month]) || 4;
      } catch (e) {
        return 4;
      }
    };
    const saveAccountingWeeksSetting = (month, value) => {
      const weeks = normalizeAccountingWeeksSetting(value);
      const monthKey = String(month || '');
      if (!weeks || !/^\d{4}-\d{2}$/.test(monthKey)) return;
      try {
        const saved = JSON.parse(window.localStorage.getItem(ACCOUNTING_WEEKS_STORAGE_KEY) || '{}');
        saved[monthKey] = weeks;
        window.localStorage.setItem(ACCOUNTING_WEEKS_STORAGE_KEY, JSON.stringify(saved));
      } catch (e) {
        // 私密瀏覽或瀏覽器封鎖 localStorage 時，仍可正常使用月報。
      }
    };
    const reportWeeksCount = ref(loadAccountingWeeksSetting(reportMonth.value));
    const monthlyReportData = ref([]);
    const accountingPeriod = ref(
      window.ExportAccounting && window.ExportAccounting.loadPeriodSettings
        ? window.ExportAccounting.loadPeriodSettings(reportMonth.value)
        : {}
    );

    const accountingExportLoading = ref(false);
    watch(reportMonth, (month) => {
      reportWeeksCount.value = loadAccountingWeeksSetting(month);
      if (window.ExportAccounting && window.ExportAccounting.loadPeriodSettings) {
        accountingPeriod.value = window.ExportAccounting.loadPeriodSettings(month);
      }
    });
    watch(reportWeeksCount, (weeks) => {
      saveAccountingWeeksSetting(reportMonth.value, weeks);
    });

    // 行政直接審核生效開關
    const directApproveMode = ref(true);

    // 監聽請假日期或對調節次改變，自動推算對調課的具體日期（支援跨週對調）
    watch([inputRequestDate, exchangePeriodId, exchangeWeekOffset], () => {
      if (!inputRequestDate.value || !exchangePeriodId.value) {
        exchangeTargetDate.value = '';
        return;
      }
      try {
        if (window.DateUtils && typeof window.DateUtils.getExchangeTargetDate === 'function') {
          exchangeTargetDate.value = window.DateUtils.getExchangeTargetDate(
            inputRequestDate.value, exchangePeriodId.value, exchangeWeekOffset.value
          );
          return;
        }
        const [targetDayStr] = exchangePeriodId.value.split('-');
        const targetDay = parseInt(targetDayStr);
        const [y, m, d] = inputRequestDate.value.split('-').map(Number);
        const reqDate = new Date(y, m - 1, d);
        const reqDay = reqDate.getDay();
        const currentDayOfWeek = reqDay === 0 ? 7 : reqDay;
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
            calculateMonthlyReport(); // async 延後載入 billing
          }
        }
      );


    // ════════════════════════════════════════
    // §3 計算屬性（課表 / 待辦 / 歷史）
    // ════════════════════════════════════════
    // --- 計算屬性 ---

    // 週日曆
    const classList = computed(() => {
      const set = new Set();
      const pullOutClasses = new Set();
      (classDirectory.value || []).forEach(c => {
        const value = String(c || '').trim();
        if (value && !/^0+$/.test(value)) set.add(value);
      });
      const source = classScheduleRows.value || [];
      if (window.DomainClassAway && window.DomainClassAway.scanClassNames) {
        window.DomainClassAway.scanClassNames(source).forEach(c => set.add(c));
      }
      source.forEach(s => {
        const c = String(s.className || '').trim();
        if (c && !/^0+$/.test(c)) set.add(c);
        if (s.attr === '抽離' || s.isPullOut) {
          const names = (window.DateUtils && window.DateUtils.parseCombinedClasses)
            ? window.DateUtils.parseCombinedClasses(s.className)
            : c.split(/[、,，/／|｜\s]+/).filter(Boolean);
          names.forEach(name => pullOutClasses.add(String(name || '').trim()));
        }
      });
      const isPullOutClass = value => pullOutClasses.has(value) || /英資|特教|資優|抽離/.test(value);
      return [...set].sort((a, b) => {
        const aIsPullOut = isPullOutClass(a);
        const bIsPullOut = isPullOutClass(b);
        if (aIsPullOut !== bIsPullOut) return aIsPullOut ? 1 : -1;
        return a.localeCompare(b, 'zh-Hant', { numeric: true });
      });
    });

    const parseScheduleClasses = (raw) => (window.DateUtils && window.DateUtils.parseCombinedClasses)
      ? window.DateUtils.parseCombinedClasses(raw)
      : String(raw || '').split(/[、,，/／|｜\s]+/).map(s => s.trim()).filter(Boolean);

    // P1：班級索引只隨基礎課表重建，切換班級時不再掃描全校課表。
    const classScheduleIndex = computed(() => {
      const map = {};
      classScheduleRows.value.forEach(s => {
        if (!s.className || s.attr === '抽離' || s.isPullOut) return;
        const classes = parseScheduleClasses(s.className);
        if (!classes.length) return;
        classes.forEach(cls => {
          if (!map[cls]) map[cls] = [];
          map[cls].push({
            schedule: s,
            isCombined: classes.length > 1,
            combinedWith: classes.filter(other => other !== cls).join('、')
          });
        });
      });
      return map;
    });

    // 只建「目前選取班」的格；週次判斷仍在此層處理。
    // 併班：班級欄寫「701、702」時，701 與 702 班級課表都會看到此節
    const classSchedules = computed(() => {
      const map = {};
      const cls = String(selectedClass.value || '').trim();
      if (!cls) return map;
      const weekDates = selectedClassWeekDates.value || [];
      const rows = classScheduleIndex.value[cls] || [];
      const useClassViewSwaps = classReadonlyMode.value || userRole.value === 'teacher';
      const swapIndex = window.DomainSchoolSwap
        ? window.DomainSchoolSwap.buildIndex(useClassViewSwaps ? classViewSchoolSwaps.value : schoolSwaps.value)
        : { rows: [], bySlot: {} };
      const periods = (window.DateUtils && window.DateUtils.getTimetablePeriods)
        ? window.DateUtils.getTimetablePeriods()
        : [0, 1, 2, 3, 4, 45, 5, 6, 7, 8];
      rows.forEach(entry => {
        const s = entry.schedule;
        const sourceDay = parseInt(s.dayOfWeek, 10);
        const sourcePeriod = parseInt(s.period, 10);
        for (let actualDay = 1; actualDay <= 5; actualDay++) {
            const dateStr = weekDates[actualDay - 1];
            if (!dateStr) continue;
            if (window.DomainSchedule && window.DomainSchedule.isActiveOnDate
                && !window.DomainSchedule.isActiveOnDate(s, dateStr)) continue;
          for (let pi = 0; pi < periods.length; pi++) {
            const actualPeriod = periods[pi];
            const resolved = window.DomainSchoolSwap
              ? window.DomainSchoolSwap.resolveSlot(swapIndex, dateStr, actualDay, actualPeriod)
              : { dayOfWeek: actualDay, period: actualPeriod, row: null };
            if (parseInt(resolved.dayOfWeek, 10) !== sourceDay || parseInt(resolved.period, 10) !== sourcePeriod) continue;
            if (s.attr === '單週' && !isSingleWeek(dateStr)) continue;
            if (s.attr === '雙週' && isSingleWeek(dateStr)) continue;
            if (!map[cls]) map[cls] = {};
            const key = `${actualDay}-${actualPeriod}`;
            if (!map[cls][key]) map[cls][key] = [];
            map[cls][key].push(Object.assign({}, s, {
              _isCombined: entry.isCombined,
              _combinedWith: entry.combinedWith,
              _schoolSwap: resolved.row || null,
              _schoolSwapEndpoint: resolved.endpoint || ''
            }));
          }
        }
      });
      return map;
    });

    const timetablePeriods = (window.DateUtils && window.DateUtils.getTimetablePeriods)
      ? window.DateUtils.getTimetablePeriods()
      : [0, 1, 2, 3, 4, 45, 5, 6, 7, 8];
    const getPeriodLabel = (p) =>
      (window.DateUtils && window.DateUtils.getPeriodLabel)
        ? window.DateUtils.getPeriodLabel(p)
        : String(p);
    const formatPeriodText = (p) =>
      (window.DateUtils && window.DateUtils.formatPeriodText)
        ? window.DateUtils.formatPeriodText(p)
         : (Number(p) === 0 ? '早自習' : (Number(p) === 45 ? '午休' : ('第' + p + '節')));
    const isLunchPeriod = (p) =>
      !!(window.DateUtils && window.DateUtils.isLunchPeriod && window.DateUtils.isLunchPeriod(p));
    const getPeriodClass = (p) => {
      const period = Number(p);
      if (period === 0) return 'is-early-period';
      if (isLunchPeriod(p)) return 'is-lunch-period';
      if (period === 8) return 'is-p8-period';
      return '';
    };
    const formatClassName = (raw) =>
      (window.DateUtils && window.DateUtils.formatClassName)
        ? window.DateUtils.formatClassName(raw)
        : String(raw || '');
    const isCombinedClass = (raw) =>
      !!(window.DateUtils && window.DateUtils.isCombinedClass && window.DateUtils.isCombinedClass(raw));
    const getScheduleSpecialTags = (entry) => {
      const raw = entry && (entry.specialTags || entry['特殊標記'] || '');
      if (window.FieldMap && typeof window.FieldMap.normalizeSpecialTags === 'function') {
        return window.FieldMap.normalizeSpecialTags(raw).split('、').filter(Boolean);
      }
      return String(raw || '').split(/[,，、;；\/／|｜\n]+/).map(value => String(value || '').trim()).filter(Boolean);
    };
    const hasScheduleSpecialTag = (entry, tag) => getScheduleSpecialTags(entry).includes(String(tag || '').trim());

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

    const getWeekDatesForCompare = (dateStr) => {
      if (dateStr && window.DateUtils && typeof window.DateUtils.getWeekDatesFrom === 'function') {
        const dates = window.DateUtils.getWeekDatesFrom(dateStr);
        if (Array.isArray(dates) && dates.length === 5) return dates;
      }
      return currentWeekDates.value || [];
    };
    const getBatchCompareSlots = () => {
      const pending = pendingRequestData.value || {};
      if (!pending.isBatch) return [];
      if (Array.isArray(batchSlots.value) && batchSlots.value.length) return batchSlots.value;
      return Array.isArray(pending.batchSlots) ? pending.batchSlots : [];
    };
    const batchCompareWeeks = computed(() => {
      if (!(pendingRequestData.value || {}).isBatch) return [];
      if (window.UiSubmitHelpers && typeof window.UiSubmitHelpers.getBatchCompareWeeks === 'function') {
        return window.UiSubmitHelpers.getBatchCompareWeeks(getBatchCompareSlots());
      }
      return [];
    });
    const batchCompareWeekIndex = ref(0);
    const batchCompareWeekTotal = computed(() => batchCompareWeeks.value.length);
    const batchCompareWeekDates = computed(() => {
      const weeks = batchCompareWeeks.value;
      const index = Math.max(0, Math.min(batchCompareWeekIndex.value, weeks.length - 1));
      if (weeks[index]) return weeks[index];
      const pending = pendingRequestData.value || {};
      return getWeekDatesForCompare(pending.date || inputRequestDate.value);
    });
    const batchCompareWeekSlotCount = computed(() => {
      const dates = new Set(batchCompareWeekDates.value || []);
      return getBatchCompareSlots().filter(slot => {
        const dateStr = String(slot && (slot.dateStr || slot.date) || '').slice(0, 10);
        return dates.has(dateStr);
      }).length;
    });
    const shiftBatchCompareWeek = (delta) => {
      const total = batchCompareWeekTotal.value;
      if (total <= 1) return;
      const current = parseInt(batchCompareWeekIndex.value, 10) || 0;
      const amount = parseInt(delta, 10) || 0;
      batchCompareWeekIndex.value = Math.max(0, Math.min(total - 1, current + amount));
    };
    const compareWeekDatesA = computed(() => {
      const pending = pendingRequestData.value || {};
      if (pending.isBatch) return batchCompareWeekDates.value;
      return getWeekDatesForCompare(pending.date || inputRequestDate.value);
    });
    const compareWeekDatesB = computed(() => {
      const pending = pendingRequestData.value || {};
      if (pending.isBatch) return batchCompareWeekDates.value;
      const date = pending.mode === 'exchange' && pending.dateB
        ? pending.dateB
        : (pending.date || inputRequestDate.value);
      return getWeekDatesForCompare(date);
    });
    const compareWeekSelectionA = ref('source');
    const compareWeekSelectionB = ref('target');
    const compareDisplayDatesA = computed(() =>
      compareWeekSelectionA.value === 'target' ? compareWeekDatesB.value : compareWeekDatesA.value
    );
    const compareDisplayDatesB = computed(() =>
      compareWeekSelectionB.value === 'target' ? compareWeekDatesB.value : compareWeekDatesA.value
    );
    const setCompareWeekSelection = (who, view) => {
      const value = view === 'target' ? 'target' : 'source';
      if (who === 'A') compareWeekSelectionA.value = value;
      if (who === 'B') compareWeekSelectionB.value = value;
    };
    watch(pendingRequestData, (pending) => {
      if (pending && pending.mode === 'exchange') {
        compareWeekSelectionA.value = 'source';
        compareWeekSelectionB.value = 'target';
      }
      if (pending && pending.isBatch) batchCompareWeekIndex.value = 0;
    });
    watch(batchSlots, () => {
      if (!(pendingRequestData.value || {}).isBatch) return;
      const total = batchCompareWeekTotal.value;
      if (!total) {
        batchCompareWeekIndex.value = 0;
        return;
      }
      batchCompareWeekIndex.value = Math.max(
        0,
        Math.min(total - 1, parseInt(batchCompareWeekIndex.value, 10) || 0)
      );
    });
    const isCrossWeekExchange = computed(() => {
      const pending = pendingRequestData.value || {};
      return pending.mode === 'exchange'
        && compareWeekDatesA.value[0]
        && compareWeekDatesB.value[0]
        && compareWeekDatesA.value[0] !== compareWeekDatesB.value[0];
    });
    const getExchangeEndpointText = (which) => {
      const pending = pendingRequestData.value || {};
      const date = which === 'target' ? pending.dateB : pending.date;
      const timeKey = which === 'target' ? pending.timeB : pending.timeKey;
      if (!date || !timeKey) return '';
      const decoded = window.DateUtils && typeof window.DateUtils.decodeTimeKey === 'function'
        ? window.DateUtils.decodeTimeKey(timeKey)
        : { day: parseInt(String(timeKey).split('-')[0], 10), period: parseInt(String(timeKey).split('-')[1], 10) };
      const dayText = getWeekDayText(decoded.day);
      return `${formatDateMMDD(date)}${dayText ? `(${dayText})` : ''} ${formatPeriodText(decoded.period)}`;
    };

    const isAdmin = computed(() => userRole.value === 'admin');
    const isStaff = computed(() => userRole.value === 'staff');
    const classUsesPublicData = computed(() => classReadonlyMode.value || userRole.value === 'teacher');
    const classScheduleRows = computed(() => classUsesPublicData.value ? classViewSchedules.value : allSchedules.value);
    const classSubstitutionRows = computed(() => classUsesPublicData.value ? classViewSubstitutionRecords.value : substitutionRecords.value);
    const classViewerReadonly = computed(() => classUsesPublicData.value);
    const notificationsSuppressed = computed(() => !onlineSubstitutionEnabled.value);
    const paperMode = computed(() => notificationsSuppressed.value && !isAdmin.value);
    const getLeaveTimeDefaults = (leaveEmail) => {
      const t = lookupTeacher(leaveEmail);
      const isAdministrative = !!(t && (t.role === 'admin' || t.role === 'staff'));
      const end = isAdministrative ? '17:00' : '16:00';
      return { type: '全天', start: '08:00', end, range: '08:00~' + end };
    };
    const getLeaveTimePresetRange = (leaveEmail, type) => {
      const d = getLeaveTimeDefaults(leaveEmail);
      if (type === '上午') return d.start + '~12:00';
      if (type === '下午') return '12:00~' + d.end;
      return d.range;
    };
    const setLeaveTimePreset = (type) => {
      const p = pendingRequestData.value || {};
      if (p.mode !== 'substitution') return;
      const d = getLeaveTimeDefaults(p.leaveTeacher);
      const start = type === '下午' ? '12:00' : d.start;
      const end = type === '上午' ? '12:00' : d.end;
      pendingRequestData.value = Object.assign({}, p, {
        leaveTimeType: type,
        leaveTimeStart: start,
        leaveTimeEnd: end,
        leaveTime: start + '~' + end
      });
    };
    const updatePendingLeaveTime = () => {
      const p = pendingRequestData.value || {};
      if (p.mode !== 'substitution') return;
      const start = String(p.leaveTimeStart || '').trim();
      const end = String(p.leaveTimeEnd || '').trim();
      pendingRequestData.value = Object.assign({}, p, {
        leaveTimeType: '自訂',
        leaveTime: start && end ? (start + '~' + end) : ''
      });
    };
    const toggleCourseAdjustmentOnly = (event) => {
      const p = pendingRequestData.value || {};
      if (p.mode !== 'substitution' && p.mode !== 'exchange') return;
      if (p.specialFlow === 'combined_return') return;
      const enabled = event && event.target ? !!event.target.checked : !!p.courseAdjustmentOnly;
      if (enabled) {
        const autoFee = typeof defaultSubFeeForReason === 'function'
          ? defaultSubFeeForReason('課務調整')
          : (p.subFee || (p.mode === 'exchange' ? '無' : '自費代課'));
        pendingRequestData.value = Object.assign({}, p, {
          courseAdjustmentOnly: true,
          leaveReasonBeforeCourseAdjustment: p.reason && p.reason !== '課務調整' ? p.reason : '',
          reason: '課務調整',
          subFee: p.mode === 'exchange' ? '無' : autoFee,
          leaveTimeType: '',
          leaveTimeStart: '',
          leaveTimeEnd: '',
          leaveTime: ''
        });
        return;
      }
      const d = p.mode === 'substitution'
        ? getLeaveTimeDefaults(p.leaveTeacher)
        : { type: '', start: '', end: '', range: '' };
      const restoredReason = p.leaveReasonBeforeCourseAdjustment || (isMutualCover.value ? '公假' : '');
      pendingRequestData.value = Object.assign({}, p, {
        courseAdjustmentOnly: false,
        reason: restoredReason,
        subFee: p.mode === 'exchange'
          ? '無'
          : (typeof defaultSubFeeForReason === 'function'
            ? defaultSubFeeForReason(restoredReason)
            : (p.subFee || '自費代課')),
        leaveReasonBeforeCourseAdjustment: '',
        leaveTimeType: d.type,
        leaveTimeStart: d.start,
        leaveTimeEnd: d.end,
        leaveTime: d.range
      });
    };
    const isSimulating = computed(() => !!originalUser.value);
    /** 目前登入者是否在「可代申請」白名單（Email） */
    const isProxySubmitGranted = computed(() => {
      if (!user.value) return false;
      const me = String(user.value.email || '').trim().toLowerCase();
      if (!me) return false;
      return (proxySubmitEmails.value || []).some(function (e) {
        return String(e || '').trim().toLowerCase() === me;
      });
    });
    /** 可瀏覽全校課表：教學組 or 行政（與代申請授權無關） */
    const canViewAllTimetables = computed(() => isAdmin.value || isStaff.value);
    /**
     * 可代申請：必須是「行政」角色，且被教學組勾進授權名單。
     * 不是一鍵全開所有行政，也不是一般教師。
     */
    const canStaffProxySubmit = computed(() => isStaff.value && isProxySubmitGranted.value);
    /** 後台狀態：至少授權一位行政時為「部分開放」 */
    const proxySubmitEnabled = computed(() => (proxySubmitEmails.value || []).length > 0);
    /** 目前是否處於「代別人申請」模式（代理對象 ≠ 自己） */
    const isProxySubmitActive = computed(() => {
      if (!canStaffProxySubmit.value || !user.value) return false;
      const me = String(getTeacherNameByEmail(user.value.email) || '').toLowerCase();
      const tgt = String(proxyTargetEmail.value || '').toLowerCase();
      return !!(tgt && tgt !== me);
    });
    // 紙本模式：非代理申請與非活動互代一律走「送出並列印」。
    const paperFlow = computed(() =>
      !isMutualCover.value
      && notificationsSuppressed.value
      && !isProxySubmitActive.value
    );
    const proxyTargetName = computed(() => {
      const em = proxyTargetEmail.value;
      if (!em) return '';
      return getTeacherNameByEmail(em) || em;
    });
    const filteredProxyTeachers = computed(() => {
      const q = String(proxyTargetQuery.value || '').trim().toLowerCase();
      const list = teachersList.value || [];
      const me = user.value ? String(getTeacherNameByEmail(user.value.email) || '').toLowerCase() : '';
      return list.filter(t => {
        const em = String(t.teacherName || t.name || '').toLowerCase();
        const loginEmail = String(t.loginEmail || '').toLowerCase();
        if (!em || em === me) return false;
        if (t.role === 'admin') return false;
        if (!q) return true;
        const name = String(t.name || '').toLowerCase();
        const sub = String(t.subject || '').toLowerCase();
        return name.includes(q) || em.includes(q) || loginEmail.includes(q) || sub.includes(q);
      });
    });
    /** 後台：僅「行政」角色可被勾選授權（非全校教師） */
    const proxyGrantCandidateTeachers = computed(() => {
      const q = String(proxyGrantQuery.value || '').trim().toLowerCase();
      return (teachersList.value || []).filter(t => {
        if (t.role !== 'staff') return false;
        const em = String(t.loginEmail || '').toLowerCase();
        if (!em) return false;
        if (!q) return true;
        const name = String(t.name || '').toLowerCase();
        const sub = String(t.subject || '').toLowerCase();
        return name.includes(q) || em.includes(q) || sub.includes(q);
      });
    });
    const proxyGrantedTeachers = computed(() => {
      const set = {};
      (proxySubmitEmails.value || []).forEach(e => { set[e] = 1; });
      return (teachersList.value || []).filter(t =>
        t.role === 'staff' && set[String(t.loginEmail || '').toLowerCase()]
      );
    });
    const isProxySubmitEmailGranted = (email) => {
      const em = String(email || '').toLowerCase();
      return !!(em && (proxySubmitEmails.value || []).indexOf(em) >= 0);
    };

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
      if (isAdmin.value) return '教學組';
      if (isStaff.value) return '行政';
      const match = user.value ? lookupTeacher(user.value.email) : null;
      if (!match) return '教師';
      const domains = parseTeacherSubjects(match.subject);
      if (!domains.length) return '教師';
      return domains.length === 1 ? `${domains[0]}科教師` : `${domains.join('／')}教師`;
    });

    /**
     * 可否對指定教師操作（點格申請／批次）：
     * 自己 / 教學組 / 已授權行政（可對任何教師；點格時自動切代理對象）
     */
    const canOperateOnTeacherEmail = (teacherEmail) => {
      if (!user.value) return false;
      const me = String(getTeacherNameByEmail(user.value.email) || '').toLowerCase();
      const em = String(teacherEmail || '').toLowerCase();
      if (!em) return false;
      if (em === me) return true;
      if (isAdmin.value) return true;
      // 已授權行政：可對全校教師操作（不必先在右上選好才准點）
      if (canStaffProxySubmit.value) return true;
      return false;
    };

    /** 點別人課格時，若是已授權行政，自動把該人設為代申請對象 */
    const ensureProxyTargetForTeacher = (teacherEmail) => {
      if (!canStaffProxySubmit.value || !user.value) return;
      const me = String(getTeacherNameByEmail(user.value.email) || '').toLowerCase();
      const em = String(teacherEmail || '').trim().toLowerCase();
      if (!em || em === me) return;
      if (String(proxyTargetEmail.value || '').toLowerCase() === em) return;
      proxyTargetEmail.value = em;
      try {
        const nm = getTeacherNameByEmail(em) || em;
        if (selectedSubject.value === 'mine') selectedSubject.value = 'all';
        showToast('已切換代申請對象：' + nm, 'info', 2200);
      } catch (e) { /* ignore */ }
    };

    const assertCanSubmitAsLeaveTeacher = (leaveEmail) => {
      if (canOperateOnTeacherEmail(leaveEmail)) {
        ensureProxyTargetForTeacher(leaveEmail);
        return true;
      }
      if (isStaff.value && !isProxySubmitGranted.value) {
        showToast('您是行政，但尚未被教學組勾選授權代申請。', 'warning');
        return false;
      }
      showToast('無法代此教師申請。僅「已授權的行政」可代送。', 'warning');
      return false;
    };

    const getProxyActor = () => {
      // 只要目前登入者有代申請能力就回傳本人（送出時再比對請假人）
      if (!user.value) return null;
      if (!canStaffProxySubmit.value && !isProxySubmitActive.value) return null;
      return {
        email: String(user.value.email || '').toLowerCase(),
        name: (user.value.displayName || getTeacherNameByEmail(user.value.email) || '').replace(/\s*\(模擬\)\s*$/, '')
      };
    };

    /** 請假人不是自己，且目前帳號是已授權行政 → 應走代申請 */
    const shouldProxySubmitForLeave = (leaveName) => {
      if (!canStaffProxySubmit.value || !user.value) return false;
      const me = String(getTeacherNameByEmail(user.value.email) || '').trim().toLowerCase();
      const leave = String(getTeacherNameByEmail(leaveName) || leaveName || '').trim().toLowerCase();
      return !!(me && leave && leave !== me);
    };

    const setProxyTarget = (email) => {
      const em = String(email || '').trim().toLowerCase();
      if (!em) {
        proxyTargetEmail.value = '';
        showProxyTargetDropdown.value = false;
        proxyTargetQuery.value = '';
        return;
      }
      if (!canStaffProxySubmit.value && !isAdmin.value) {
        showToast(isStaff.value
          ? '您是行政，但尚未被教學組勾選授權代申請'
          : '僅授權的行政可代申請', 'warning');
        return;
      }
      proxyTargetEmail.value = em;
      showProxyTargetDropdown.value = false;
      proxyTargetQuery.value = '';
      // 切到該教師課表
      searchQuery.value = getTeacherNameByEmail(em) || em;
      if (selectedSubject.value === 'mine') selectedSubject.value = 'all';
      showToast('代申請對象：' + (getTeacherNameByEmail(em) || em), 'info');
    };

    const clearProxyTarget = () => {
      proxyTargetEmail.value = '';
      proxyTargetQuery.value = '';
      showProxyTargetDropdown.value = false;
      searchQuery.value = '';
      if (isStaff.value) selectedSubject.value = 'mine';
      showToast('已改回處理自己的課', 'info');
    };

    /** 只允許 role=staff 的 Email 進授權名單 */
    const filterStaffEmailsOnly = (emails) => {
      const staffSet = {};
      (teachersList.value || []).forEach(t => {
        if (t.role === 'staff') {
          const em = String(t.loginEmail || '').toLowerCase();
          if (em) staffSet[em] = 1;
        }
      });
      const seen = {};
      const out = [];
      (emails || []).forEach(raw => {
        const e = String(raw || '').trim().toLowerCase();
        if (!e || seen[e] || !staffSet[e]) return;
        seen[e] = 1;
        out.push(e);
      });
      return out;
    };

    const persistProxySubmitEmails = async (nextList, toastOk) => {
      if (!isAdmin.value) {
        showToast('僅教學組可設定代申請行政', 'warning');
        return false;
      }
      const prev = (proxySubmitEmails.value || []).slice();
      const uniq = filterStaffEmailsOnly(nextList);
      proxySubmitEmails.value = uniq;
      const by = user.value
        ? (user.value.displayName || getTeacherNameByEmail(user.value.email) || user.value.email)
        : '';
      const at = new Date().toISOString();
      proxySubmitEnabledBy.value = by;
      proxySubmitEnabledAt.value = at;
      try { localStorage.setItem(PROXY_SUBMIT_EMAILS_LS_KEY, uniq.join(',')); } catch (e) { /* ignore */ }
      try {
        loading.value = true;
        loadingMessage.value = '儲存代申請授權…';
        await callGasApi('saveMailSettings', {
          proxySubmitEmails: uniq.join(','),
          proxySubmitEnabled: uniq.length > 0,
          proxySubmitEnabledBy: by,
          proxySubmitEnabledAt: at
        });
        if (toastOk !== false) {
          showToast(
            uniq.length
              ? ('已授權 ' + uniq.length + ' 位行政可代申請')
              : '已清空授權（所有行政皆不可代申請）',
            'success'
          );
        }
        return true;
      } catch (err) {
        const msg = err && err.message ? String(err.message) : String(err || '');
        if (/未定義|不支援|not support|Unknown action/i.test(msg)) {
          showToast('已寫入本機授權名單（後端尚未同步，請更新 GAS）', 'warning', 4500);
          return true;
        }
        proxySubmitEmails.value = prev;
        try { localStorage.setItem(PROXY_SUBMIT_EMAILS_LS_KEY, prev.join(',')); } catch (e2) { /* ignore */ }
        showToast('儲存失敗：' + msg, 'error');
        return false;
      } finally {
        loading.value = false;
      }
    };

    const toggleProxySubmitEmail = async (email) => {
      const em = String(email || '').trim().toLowerCase();
      if (!em) return;
      const t = (teachersList.value || []).find(x =>
        String(x.loginEmail || '').toLowerCase() === em
      );
      if (!t || t.role !== 'staff') {
        showToast('只能授權「行政」角色', 'warning');
        return;
      }
      const cur = (proxySubmitEmails.value || []).slice();
      const idx = cur.indexOf(em);
      if (idx >= 0) cur.splice(idx, 1);
      else cur.push(em);
      await persistProxySubmitEmails(cur);
    };

    const clearAllProxySubmitEmails = async () => {
      if (!(proxySubmitEmails.value || []).length) return;
      const ok = await showConfirm('確定清空所有行政的代申請授權？清空後沒有行政可代他人申請。', '清空授權');
      if (!ok) return;
      await persistProxySubmitEmails([]);
    };

    /** 相容舊按鈕：不再「一鍵全開所有行政」 */
    const setProxySubmitEnabled = async (enabled) => {
      if (enabled) {
        showToast('請在下方勾選「指定行政」授權，不會一次開放全部行政', 'info');
        return;
      }
      await clearAllProxySubmitEmails();
    };

    const setOnlineSubstitutionEnabled = async (enabled) => {
      if (!isAdmin.value) {
        showToast('僅教學組可切換線上調代課模式', 'warning');
        return;
      }
      const previous = onlineSubstitutionEnabled.value;
      onlineSubstitutionEnabled.value = !!enabled;
      loading.value = true;
      loadingMessage.value = onlineSubstitutionEnabled.value ? '開啟線上調代課…' : '切換紙本模式…';
      try {
        await callGasApi('saveMailSettings', {
          onlineSubstitutionEnabled: onlineSubstitutionEnabled.value
        });
        showToast(
          onlineSubstitutionEnabled.value ? '已開啟線上調代課' : '已切換為紙本模式，媒合與模擬仍可使用',
          'success'
        );
      } catch (err) {
        onlineSubstitutionEnabled.value = previous;
        showToast('切換調代課模式失敗：' + (err && err.message ? err.message : err), 'error');
      } finally {
        loading.value = false;
      }
    };

    const subjectsList = computed(() => {
      const list = new Set();
      teachersList.value.forEach(t => {
        parseTeacherSubjects(t.subject).forEach(s => list.add(s));
      });
      return Array.from(list).sort((a, b) => a.localeCompare(b, 'zh-Hant'));
    });

    const filteredTeachers = computed(() => {
      if (!user.value) return [];
      const myName = String(getTeacherNameByEmail(user.value.email) || '').toLowerCase();
      // 一般教師：只看自己；行政／教學組可看全校
      if (!canViewAllTimetables.value) {
        return teachersList.value.filter(t => String(t.teacherName || t.name || '').toLowerCase() === myName);
      }
      const query = searchQuery.value.trim().toLowerCase();
      const subj = selectedSubject.value;
      // 預設「我的課表」：只顯示自己（有搜尋姓名時改看全校比對）
      if (subj === 'mine' && !query) {
        const self = lookupTeacher(user.value.email);
        return self ? [self] : teachersList.value.filter(t => String(t.teacherName || t.name || '').toLowerCase() === myName);
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
      // 有搜尋／活動互代看別人：不強制把自己掛最上面
      if (query || isMutualCover.value) {
        return list;
      }
      // 無搜尋瀏覽全校時：自己置頂
      const me = [];
      const others = [];
      list.forEach(t => {
        if (String(t.teacherName || t.name || '').toLowerCase() === myName) me.push(t);
        else others.push(t);
      });
      if (!me.length && subj === 'all') {
        const self = lookupTeacher(user.value.email);
        if (self) me.push(self);
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
      const excludeName = activeCell.value?.teacherEmail || getTeacherNameByEmail(user.value?.email);
      return teachersList.value.filter(t => (t.teacherName || t.name) !== excludeName);
    });

    const teachersListDetails = computed(() => teachersList.value);
    const accountingPlanOptions = computed(() => {
      const sources = new Set();
      (teachersList.value || []).forEach((teacher) => {
        if (window.FieldMap && typeof window.FieldMap.expensePlanSources === 'function') {
          window.FieldMap.expensePlanSources(teacher && teacher.expensePlan).forEach(source => sources.add(source));
        } else if (teacher && teacher.expensePlan) {
          sources.add(String(teacher.expensePlan).trim());
        }
      });
      return Array.from(sources).filter(Boolean).sort((a, b) => a.localeCompare(b, 'zh-Hant', { numeric: true }));
    });
    const getExpensePlanSummary = (value) => window.FieldMap && window.FieldMap.formatExpensePlanSummary
      ? window.FieldMap.formatExpensePlanSummary(value)
      : String(value || '預設').trim() || '預設';
    const pendingHomeroomRecords = computed(() => {
      return (homeroomRecords.value || [])
        .filter(r => r && r.enabled !== false && String(r.status || '').toLowerCase() !== 'cancelled')
        .filter(r => !r.actualTeacherName);
    });
    const getHomeroomCoverCandidates = (record) => {
      const original = String(record && record.originalTeacherName || '').toLowerCase();
      return (teachersList.value || [])
        .filter(t => t && (t.teacherName || t.name) && String(t.teacherName || t.name).toLowerCase() !== original)
        .slice()
        .sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'zh-Hant'));
    };
    const loadHomeroomRecords = async (opts = {}) => {
      if (!isAdmin.value || !user.value) return false;
      homeroomRecordsLoading.value = true;
      try {
        const res = await callGasApi('getHomeroomRecords', { semesterId: currentSemester.value });
        if (res && Array.isArray(res.homeroomRecords)) {
          homeroomRecords.value = res.homeroomRecords.map(r => window.FieldMap.mapHomeroomRecord(r));
        }
        return true;
      } catch (e) {
        if (!opts.silent) showToast('載入代導紀錄失敗：' + (e && e.message ? e.message : e), 'warning');
        return false;
      } finally {
        homeroomRecordsLoading.value = false;
      }
    };
    /**
     * 全域 Optimistic UI 樂觀執行器
     * 0 毫秒本地更新 -> 背景同步 -> 成功跳右下氣泡 -> 失敗自動回滾並彈出需手動點擊關閉的警示 Modal
     */
    const executeOptimisticAction = async (opts) => {
      opts = opts || {};
      let snapshot = null;
      if (typeof opts.optimistic === 'function') {
        snapshot = opts.optimistic();
      }
      try {
        const res = typeof opts.apiCall === 'function' ? await opts.apiCall() : null;
        if (typeof opts.onSuccess === 'function') {
          opts.onSuccess(res);
        }
        if (opts.successMessage) {
          showToast(opts.successMessage, 'success', 3000);
        }
        return res;
      } catch (err) {
        console.error('背景同步失敗：', err);
        if (typeof opts.rollback === 'function') {
          opts.rollback(snapshot);
        } else {
          loadWeeklyData({ force: false, silent: true }).catch(function () {});
        }
        const errMsg = err && err.message ? String(err.message) : String(err || '未知錯誤');
        const title = opts.errorTitle || '⚠️ 背景同步失敗警示';
        const msg = (opts.errorMessagePrefix ? (opts.errorMessagePrefix + '：\n\n') : '') + errMsg + '\n\n（系統已嘗試還原本地資料，請檢查網路或數據後再試。）';
        if (typeof showConfirm === 'function') {
          await showConfirm(msg, title, { alertOnly: true });
        } else {
          alert(msg);
        }
        throw err;
      }
    };

    const assignHomeroomTeacher = async (record) => {
      if (!record || !record.id) return;
      const teacherName = String(homeroomAssignSelections.value[record.id] || '').trim();
      if (!teacherName) {
        showToast('請先選擇代導教師', 'info');
        return;
      }
      const actualTeacher = teachersList.value.find(t => (t.teacherName || t.name) === teacherName);
      const actualName = actualTeacher ? (actualTeacher.teacherName || actualTeacher.name) : teacherName;

      await executeOptimisticAction({
        optimistic: () => {
          const snapshot = (homeroomRecords.value || []).slice();
          const next = snapshot.slice();
          const idx = next.findIndex(r => r.id === record.id);
          if (idx >= 0) {
            next[idx] = Object.assign({}, next[idx], {
              actualTeacherName: actualName,
              status: 'assigned'
            });
          }
          homeroomRecords.value = next;
          const nextSelections = Object.assign({}, homeroomAssignSelections.value);
          delete nextSelections[record.id];
          homeroomAssignSelections.value = nextSelections;
          return snapshot;
        },
        rollback: (snapshot) => {
          if (snapshot) homeroomRecords.value = snapshot;
        },
        apiCall: () => callGasApi('saveHomeroomCoverTeacher', {
          semesterId: currentSemester.value,
          recordId: record.id,
           actualTeacherName: actualName
        }),
        successMessage: `✅ 代導教師（${actualName}）指定成功，已同步至雲端`,
        errorMessagePrefix: `指定代導教師（${actualName}）失敗`
      });
    };

    const extractNameFromFormatted = (str) => {
      const raw = String(str || '').trim();
      const idx = raw.indexOf('（');
      if (idx >= 0) return raw.slice(0, idx).trim();
      return raw;
    };

    const onHomeroomInputSelect = (record, nameOrEmail) => {
      if (!record || !record.id) return;
      const cleanVal = extractNameFromFormatted(nameOrEmail);
      if (!cleanVal) {
        homeroomAssignSelections.value[record.id] = '';
        return;
      }
      const candidates = (typeof getHomeroomCoverCandidates === 'function' ? getHomeroomCoverCandidates(record) : []) || [];
      const found = candidates.find(t => t.name === cleanVal || t.email === cleanVal) ||
                    (teachersListDetails.value || []).find(t => t.name === cleanVal || t.email === cleanVal);
      if (found) {
        homeroomAssignSelections.value[record.id] = found.teacherName || found.name;
      } else {
        const partial = candidates.find(t => t.name.indexOf(cleanVal) >= 0) ||
                        (teachersListDetails.value || []).find(t => t.name.indexOf(cleanVal) >= 0);
        if (partial) homeroomAssignSelections.value[record.id] = partial.teacherName || partial.name;
      }
    };

    const onManualCoverTeacherInput = (nameOrEmail) => {
      const cleanVal = extractNameFromFormatted(nameOrEmail);
      if (!cleanVal) {
        manualHomeroomForm.value.actualTeacherEmail = '';
        return;
      }
      const found = (teachersListDetails.value || []).find(t => t.name === cleanVal || t.email === cleanVal);
      if (found) {
        manualHomeroomForm.value.actualTeacherEmail = found.teacherName || found.name;
      } else {
        const partial = (teachersListDetails.value || []).find(t => t.name.indexOf(cleanVal) >= 0);
        if (partial) manualHomeroomForm.value.actualTeacherEmail = partial.teacherName || partial.name;
      }
    };

    const getFilteredHomeroomCandidates = (record, query) => {
      const candidates = (typeof getHomeroomCoverCandidates === 'function' ? getHomeroomCoverCandidates(record) : []) || [];
      const q = String(query || '').trim().toLowerCase();
      if (!q) return candidates;
      return candidates.filter(t => {
        const name = String(t && t.name || '').toLowerCase();
        const email = String(t && t.email || '').toLowerCase();
        const job = String(t && t.jobTitle || '').toLowerCase();
        const subj = String(t && t.subject || '').toLowerCase();
        return name.indexOf(q) >= 0 || email.indexOf(q) >= 0 || job.indexOf(q) >= 0 || subj.indexOf(q) >= 0;
      });
    };

    const filteredManualCoverTeachers = computed(() => {
      const q = String(manualHomeroomSearchQuery.value || '').trim().toLowerCase();
      const list = teachersListDetails.value || [];
      if (!q) return list;
      return list.filter(t => {
        const name = String(t && t.name || '').toLowerCase();
        const email = String(t && t.email || '').toLowerCase();
        const job = String(t && t.jobTitle || '').toLowerCase();
        const subj = String(t && t.subject || '').toLowerCase();
        return name.indexOf(q) >= 0 || email.indexOf(q) >= 0 || job.indexOf(q) >= 0 || subj.indexOf(q) >= 0;
      });
    });

    const getTodayYmdStr = () => {
      const d = new Date();
      return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    };

    const homeroomTeachersList = computed(() => {
      return (teachersList.value || []).filter(t => {
        const title = String(t && t.jobTitle || '').trim();
        return title.indexOf('導師') >= 0;
      }).sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'zh-Hant'));
    });

    const showManualHomeroomModal = ref(false);
    const homeroomStatusFilter = ref('all');
    const manualHomeroomForm = ref({
      leaveEmail: '',
      className: '',
      date: getTodayYmdStr(),
      leaveTimeType: '全天',
      leaveTime: '08:00~16:00',
      actualTeacherEmail: '',
      note: ''
    });

    const openManualHomeroomModal = () => {
      manualHomeroomForm.value = {
        leaveEmail: '',
        className: '',
        date: getTodayYmdStr(),
        leaveTimeType: '全天',
        leaveTime: '08:00~16:00',
        actualTeacherEmail: '',
        note: '導師無課/調課請假，手動新增代導費'
      };
      showManualHomeroomModal.value = true;
    };

    const onManualHomeroomLeaveTeacherChange = () => {
      const email = manualHomeroomForm.value.leaveEmail;
      if (!email) return;
      const t = teachersList.value.find(x => x.email === email);
      if (t) {
        const title = String(t.jobTitle || '').trim();
        const m = title.match(/([0-9一二三四五六七八九十0-9\-]+(?:\s*年\s*[0-9一二三四五六七八九十]+)?(?:\s*班)?)\s*導師/);
        if (m && m[1]) {
          manualHomeroomForm.value.className = m[1].trim();
        } else if (title) {
          manualHomeroomForm.value.className = title.replace(/導師/g, '').trim() || '導師班';
        }
      }
    };

    const currentMonthHomeroomRecords = computed(() => {
      const m = reportMonth.value;
      const list = (homeroomRecords.value || []).filter(r => {
        if (!r || r.enabled === false || String(r.status || '').toLowerCase() === 'cancelled') return false;
        if (!m) return true;
        return String(r.date || '').slice(0, 7) === m;
      });
      return list.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
    });

    const currentMonthHomeroomFeeTotal = computed(() => {
      return (currentMonthHomeroomRecords.value || []).reduce((sum, r) => sum + (Number(r.feeAmount) || 455), 0);
    });

    const currentMonthHomeroomAssignedCount = computed(() => {
      return (currentMonthHomeroomRecords.value || []).filter(r => !!r.actualTeacherName).length;
    });

    const currentMonthHomeroomPendingCount = computed(() => {
      return (currentMonthHomeroomRecords.value || []).filter(r => !r.actualTeacherName).length;
    });

    const saveManualHomeroomRecord = async () => {
      const form = manualHomeroomForm.value;
      if (!form.leaveEmail) { showToast('請選擇請假導師', 'warning'); return; }
      if (!form.date) { showToast('請選擇代導日期', 'warning'); return; }

      const origTeacher = teachersList.value.find(t => t.email === form.leaveEmail);
      const origName = origTeacher ? origTeacher.name : form.leaveEmail;
      const actualTeacher = teachersList.value.find(t => t.email === form.actualTeacherEmail);
      const actualName = actualTeacher ? actualTeacher.name : '';

      showManualHomeroomModal.value = false;

      await executeOptimisticAction({
        optimistic: () => {
          const snapshot = (homeroomRecords.value || []).slice();
          const tempRecord = {
            id: 'mentor_manual_temp_' + Date.now(),
            semesterId: currentSemester.value,
            sourceRequestId: 'manual',
            originalTeacherName: origName,
            className: form.className || '導師班',
            date: form.date,
            leaveTimeType: form.leaveTimeType,
            leaveTime: form.leaveTime,
            actualTeacherName: actualName,
            feeAmount: 455,
            status: form.actualTeacherEmail ? 'assigned' : 'pending',
            enabled: true,
            note: form.note || '管理員手動新增代導費'
          };
          homeroomRecords.value = [tempRecord, ...snapshot];
          return snapshot;
        },
        rollback: (snapshot) => {
          if (snapshot) homeroomRecords.value = snapshot;
        },
        apiCall: () => callGasApi('saveManualHomeroomRecord', {
          semesterId: currentSemester.value,
           leaveName: form.leaveEmail,
          className: form.className,
          date: form.date,
          leaveTimeType: form.leaveTimeType,
          leaveTime: form.leaveTime,
           actualTeacherName: form.actualTeacherEmail,
          note: form.note
        }),
        onSuccess: () => loadHomeroomRecords({ silent: true }),
        successMessage: `✅ 已成功建立【${origName}】代導費，並同步至雲端`,
        errorMessagePrefix: `手動新增代導費失敗`
      });
    };

    const deleteHomeroomRecord = async (record) => {
      if (!record || !record.id) return;
      const ok = await showConfirm(`確定要撤銷／刪除【${record.date} ${record.className || ''} ${record.originalTeacherName}】的代導紀錄嗎？`, '撤銷代導紀錄確認');
      if (!ok || !ok.ok) return;

      await executeOptimisticAction({
        optimistic: () => {
          const snapshot = (homeroomRecords.value || []).slice();
          homeroomRecords.value = snapshot.filter(r => r.id !== record.id);
          return snapshot;
        },
        rollback: (snapshot) => {
          if (snapshot) homeroomRecords.value = snapshot;
        },
        apiCall: () => callGasApi('deleteHomeroomRecord', {
          semesterId: currentSemester.value,
          recordId: record.id
        }),
        successMessage: `✅ 代導紀錄已成功撤銷，並同步至雲端`,
        errorMessagePrefix: `撤銷代導紀錄失敗`
      });
    };

    // 專門用於調課的對調教師選單（過濾條件：必須與請假教師在同一個班級有授課）
    const exchangeTeachersList = computed(() => {
      if (!activeCell.value.classData) return [];
      const myClassName = activeCell.value.classData.className;
      const myTeacherEmail = activeCell.value.teacherEmail;
      const requestDate = String(inputRequestDate.value || '').trim();

      const emailsInSameClass = new Set(
        allSchedules.value
          .filter(s => s.className === myClassName && s.teacherEmail !== myTeacherEmail
            && (!requestDate || !window.DomainSchedule || !window.DomainSchedule.isActiveOnDate
              || window.DomainSchedule.isActiveOnDate(s, requestDate)))
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
      const teacherName = user.value ? String(getTeacherNameByEmail(user.value.email) || '').toLowerCase() : '';
      let filteredRecords = substitutionRecords.value;
      
      // 非教學組：預設只看自己相關；行政另含「我代送」的單
      if (!isAdmin.value && teacherName) {
        filteredRecords = substitutionRecords.value.filter(r => {
          const related =
            (r.originalTeacherName && r.originalTeacherName.toLowerCase() === teacherName) ||
            (r.actualTeacherName && r.actualTeacherName.toLowerCase() === teacherName);
          if (related) return true;
          if (isStaff.value && r.requestId) {
            const req = (requestsList.value || []).find(x => x && x.id === r.requestId);
            if (req && isProxySubmitRequest(req)) {
              const proxyName = String(req.proxyByName || '').toLowerCase();
              if (proxyName && proxyName === teacherName) return true;
            }
          }
          return false;
        });
      }

      // 調課 (exchange) 去重：同一 requestId 只留一列
      // 優先保留「請假日」邊（id 以 _2 結尾，或 original＝申請人），避免 _1 目標日當主列造成班科顛倒
      const exchangeBest = {};
      const triangleBest = {};
      const nonExchange = [];
      filteredRecords.forEach(rec => {
        if (!rec) return;
        if (isTriangleRequest(rec)) {
          const triangleId = String(rec.triangleId || rec.requestId || rec.id || '');
          if (!triangleId || !triangleBest[triangleId]
              || (parseInt(rec.triangleLegIndex, 10) || 0) < (parseInt(triangleBest[triangleId].triangleLegIndex, 10) || 0)) {
            triangleBest[triangleId] = rec;
          }
          return;
        }
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
      const dedupedRecords = nonExchange
        .concat(Object.keys(exchangeBest).map(k => exchangeBest[k]))
        .concat(Object.keys(triangleBest).map(k => triangleBest[k]));

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
        const createdAtFull = getRequestApplicationStamp(matchedReq || rec);
        const createdDate = formatRequestApplicationDate(matchedReq || rec);

        let leaveDate = rec.date;
        let leavePeriod = rec.period;
        let leaveTeacher = rec.originalTeacherName;
        let subTeacher = rec.actualTeacherName;
        let leaveClassName = rec.className || '';
        let leaveSubject = rec.subject || '';
        let targetDate = '---';
        let targetPeriod = '';
        let targetClassName = '';
        let targetSubject = '';

         if (isTriangleRequest(rec)) {
           // 三角調歷史列以一條來源→目標關係代表整組，班科永遠取來源教師的原課。
           if (matchedReq) {
             leaveDate = matchedReq.requestDate || leaveDate;
             leavePeriod = matchedReq.requestPeriod != null ? matchedReq.requestPeriod : leavePeriod;
             leaveTeacher = matchedReq.requesterName || leaveTeacher;
             subTeacher = matchedReq.targetTeacherName || subTeacher;
             targetDate = matchedReq.targetDate || rec.date || targetDate;
             targetPeriod = matchedReq.targetPeriod != null ? matchedReq.targetPeriod : (rec.period || targetPeriod);
             leaveClassName = matchedReq.className || rec.className || '';
             leaveSubject = matchedReq.subject || rec.subject || '';
             targetClassName = leaveClassName;
             targetSubject = leaveSubject;
           } else {
             leaveDate = rec.triangleSourceDate || rec.date || leaveDate;
             leavePeriod = rec.triangleSourcePeriod != null ? rec.triangleSourcePeriod : leavePeriod;
             leaveTeacher = rec.actualTeacherName || leaveTeacher;
             subTeacher = rec.originalTeacherName || subTeacher;
             targetDate = rec.date || targetDate;
             targetPeriod = rec.period != null ? rec.period : targetPeriod;
             leaveClassName = rec.className || '';
             leaveSubject = rec.subject || '';
             targetClassName = leaveClassName;
             targetSubject = leaveSubject;
           }
         } else if (rec.type === 'exchange' || rec.type === '對調') {
          const peers = peerByRequestId[rec.requestId] || [];
          // leaveEdge：原異動日（申請人原位置的課）；targetEdge：目標日（受邀人原位置的課）
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
            // 歷史／申請單欄位維持原始位置，不跟著網頁課表的交換後班科走。
            leaveClassName = matchedReq.className
              || (leaveEdge && (leaveEdge.formClassName || leaveEdge.className))
              || leaveClassName;
            leaveSubject = matchedReq.subject
              || (leaveEdge && (leaveEdge.formSubject || leaveEdge.subject))
              || leaveSubject;
            // 對調班科：受邀人原位置的課＝目標日 edge _1 的表單欄位。
            targetClassName = matchedReq.targetClassName
              || (targetEdge && (targetEdge.formClassName || targetEdge.className))
              || '';
            targetSubject = matchedReq.targetSubject
              || (targetEdge && (targetEdge.formSubject || targetEdge.subject))
              || '';
          } else {
            // 無申請單：用兩邊 edge
            if (leaveEdge) {
              leaveDate = leaveEdge.date;
              leavePeriod = leaveEdge.period;
              leaveTeacher = leaveEdge.originalTeacherName;
              subTeacher = leaveEdge.actualTeacherName;
            }
            if (targetEdge) {
              targetDate = targetEdge.date;
              targetPeriod = targetEdge.period;
              leaveClassName = (leaveEdge && (leaveEdge.formClassName || leaveEdge.className)) || leaveClassName;
              leaveSubject = (leaveEdge && (leaveEdge.formSubject || leaveEdge.subject)) || leaveSubject;
            }
            if (targetEdge) {
              targetClassName = targetEdge.formClassName || targetEdge.className || '';
              targetSubject = targetEdge.formSubject || targetEdge.subject || '';
            }
          }
        }

        return {
          ...rec,
          // 歷史列統一：original＝請假師、actual＝代課／對調師
          originalTeacherName: leaveTeacher || rec.originalTeacherName,
          actualTeacherName: subTeacher || rec.actualTeacherName,
          className: leaveClassName || rec.className,
          subject: leaveSubject || rec.subject,
          serial: matchedReq ? (matchedReq.serial || '---') : '---',
          batchId: (matchedReq && matchedReq.batchId) || rec.batchId || '',
          note: (matchedReq && matchedReq.note) || rec.note || '',
          directApprove: !!(matchedReq && matchedReq.directApprove),
          requesterName: leaveTeacher || rec.originalTeacherName || '',
          targetTeacherName: subTeacher || rec.actualTeacherName || '',
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

      if (historyTypeFilter.value !== 'all') {
        records = records.filter(r => {
          const isExchange = isHistoryExchangeType(r);
          return historyTypeFilter.value === 'exchange' ? isExchange : !isExchange;
        });
      }

      // 搜尋：單號／教師／班級／科目／日期／假別
      const q = (historySearchQuery.value || '').trim().toLowerCase();
      if (q) {
        records = records.filter(r => {
          const blob = [
            r.serial, r.requesterName, r.targetTeacherName,
            r.className, r.subject, r.targetClassName, r.targetSubject,
            r.requestDate, r.date, r.targetDate, r.reason, r.note, r.status
          ].map(x => String(x || '').toLowerCase()).join(' ');
          return blob.indexOf(q) >= 0;
        });
      }

      if (historyFilterMode.value === 'all' || !historyFilterDate.value) return records;

      return records.filter(r => {
        // 請假日或對調目標日落在篩選範圍皆算
        const dates = [r.date, r.requestDate, r.targetDate].filter(Boolean).map(String);
        if (historyFilterMode.value === 'day') {
          const d = String(historyFilterDate.value);
          return dates.some(x => x.slice(0, 10) === d.slice(0, 10));
        }
        if (historyFilterMode.value === 'week') {
          const wk = getWeekStart(historyFilterDate.value);
          return dates.some(x => getWeekStart(x) === wk);
        }
        if (historyFilterMode.value === 'month') {
          const mo = getMonthStart(historyFilterDate.value);
          return dates.some(x => getMonthStart(x) === mo);
        }
        return true;
      });
    });

    // 批次申請：以批次為單位分頁，批次標題預設收合；展開後仍保留每筆操作。
    const batchGroupExpanded = ref({});
    const getBatchGroupStateKey = (scope, batchId) =>
      String(scope || '') + '|' + String(batchId || '').trim().toLowerCase();
    const isBatchGroupExpanded = (scope, batchId) =>
      !!batchGroupExpanded.value[getBatchGroupStateKey(scope, batchId)];
    const toggleBatchGroup = (scope, batchId) => {
      const key = getBatchGroupStateKey(scope, batchId);
      const next = Object.assign({}, batchGroupExpanded.value);
      if (next[key]) delete next[key];
      else next[key] = true;
      batchGroupExpanded.value = next;
    };
    const isCollapsibleBatchRecord = (record) => {
      if (!record || !String(record.batchId || '').trim()) return false;
      const type = String(record.type || '').trim().toLowerCase();
      // 三角調有自己的整組流程，不與一般批次代課混在一起。
      return type !== 'triangle' && type !== '三角調' && !String(record.triangleId || '').trim();
    };
    const makeBatchItemRow = (record, displayKey, batchGroupKey) => Object.assign({}, record || {}, {
      displayKind: 'item',
      displayKey,
      batchGroupKey: batchGroupKey || ''
    });
    const buildBatchDisplayGroups = (records, scope) => {
      const entries = [];
      const groups = new Map();
      (records || []).forEach((record, index) => {
        if (!record) return;
        if (!isCollapsibleBatchRecord(record)) {
          entries.push(makeBatchItemRow(record, `${scope}:item:${record.id || index}`));
          return;
        }
        const batchId = String(record.batchId).trim();
        const groupLookupKey = batchId.toLowerCase();
        let group = groups.get(groupLookupKey);
        if (!group) {
          group = {
            displayKind: 'batch',
            displayKey: `${scope}:batch:${groupLookupKey}`,
            batchId,
            items: []
          };
          groups.set(groupLookupKey, group);
          entries.push(group);
        }
        group.items.push(record);
      });
      // 篩選後只剩一筆時，直接維持單筆列，避免製造空洞的批次標題。
      return entries.map(entry => {
        if (entry.displayKind === 'batch' && entry.items.length < 2) {
          const item = entry.items[0];
          return makeBatchItemRow(item, `${scope}:item:${item && item.id ? item.id : entry.displayKey}`);
        }
        return entry;
      });
    };
    const flattenBatchDisplayGroups = (entries, scope) => {
      const rows = [];
      (entries || []).forEach(entry => {
        rows.push(entry);
        if (entry.displayKind !== 'batch' || !isBatchGroupExpanded(scope, entry.batchId)) return;
        entry.items.forEach((record, index) => {
          rows.push(makeBatchItemRow(
            record,
            `${entry.displayKey}:item:${record && record.id ? record.id : index}`,
            entry.displayKey
          ));
        });
      });
      return rows;
    };
    const getBatchGroupSlotSummary = (group, formatter) => {
      const values = [...new Set((group && group.items ? group.items : []).map(item => {
        try { return String(typeof formatter === 'function' ? formatter(item) : '').trim(); } catch (e) { return ''; }
      }).filter(value => value && value !== '—' && value !== '---'))];
      if (!values.length) return '—';
      if (values.length === 1) return values[0];
      return `${values[0]} 等 ${group.items.length} 筆`;
    };
    const getBatchGroupTeacherSummary = (group) => {
      const values = [];
      const seen = new Set();
      (group && group.items ? group.items : []).forEach(item => {
        const value = String(
          (item && (item.targetTeacherName || item['受邀人姓名']))
          || (item && (item.targetTeacherEmail || item['受邀人Email']))
          || ''
        ).trim();
        const key = value.toLowerCase();
        if (!key || seen.has(key)) return;
        seen.add(key);
        values.push(value);
      });
      return values.length ? values.join('、') : '—';
    };
    const getBatchGroupStatusValues = (group) => [...new Set((group && group.items ? group.items : [])
      .map(item => String(item && item.status || '').trim().toLowerCase()).filter(Boolean))];
    const getBatchGroupStatusText = (group) => {
      const statuses = getBatchGroupStatusValues(group);
      if (!statuses.length) return '批次';
      return statuses.length === 1 ? getStatusText(statuses[0]) : '多種狀態';
    };
    const getBatchGroupStatusClass = (group) => {
      const statuses = getBatchGroupStatusValues(group);
      return statuses.length === 1 ? `status-${statuses[0]}` : 'tag-gray';
    };

    const historyBatchGroups = computed(() =>
      buildBatchDisplayGroups(dateFilteredHistoryRecords.value, 'history')
    );
    const historyTotalPages = computed(() => Math.max(1, Math.ceil(historyBatchGroups.value.length / historyPageSize.value)));

    const paginatedHistoryRecords = computed(() => {
      const start = (historyPage.value - 1) * historyPageSize.value;
      return flattenBatchDisplayGroups(
        historyBatchGroups.value.slice(start, start + historyPageSize.value),
        'history'
      );
    });

    // 待辦分頁＋搜尋
    const pendingMyPendingPage = ref(1);
    const pendingMySentPage = ref(1);
    const pendingAdminPage = ref(1);
    const pendingSearchQuery = ref('');

    const matchPendingSearch = (req, q) => {
      if (!q) return true;
      const blob = [
        req.serial, req.requesterName, req.targetTeacherName,
        req.className, req.subject, req.targetClassName, req.targetSubject,
        req.requestDate, req.targetDate, req.reason, req.note, req.status, req.batchId
      ].map(x => String(x || '').toLowerCase()).join(' ');
      return blob.indexOf(q) >= 0;
    };

    const filteredMyPendingRequests = computed(() => {
      const q = (pendingSearchQuery.value || '').trim().toLowerCase();
      if (!q) return myPendingRequests.value || [];
      return (myPendingRequests.value || []).filter(r => matchPendingSearch(r, q));
    });
    const filteredMySentRequests = computed(() => {
      const q = (pendingSearchQuery.value || '').trim().toLowerCase();
      if (!q) return mySentRequests.value || [];
      return (mySentRequests.value || []).filter(r => matchPendingSearch(r, q));
    });
    const filteredAdminPendingRequests = computed(() => {
      const q = (pendingSearchQuery.value || '').trim().toLowerCase();
      if (!q) return adminPendingRequests.value || [];
      return (adminPendingRequests.value || []).filter(r => matchPendingSearch(r, q));
    });

    const paginatedMyPending = computed(() => {
      const s = (pendingMyPendingPage.value - 1) * pendingPageSize;
      return filteredMyPendingRequests.value.slice(s, s + pendingPageSize);
    });
    const sentBatchGroups = computed(() =>
      buildBatchDisplayGroups(filteredMySentRequests.value, 'sent')
    );
    const adminPendingBatchGroups = computed(() =>
      buildBatchDisplayGroups(filteredAdminPendingRequests.value, 'admin')
    );
    const paginatedMySent = computed(() => {
      const s = (pendingMySentPage.value - 1) * pendingPageSize;
      return flattenBatchDisplayGroups(sentBatchGroups.value.slice(s, s + pendingPageSize), 'sent');
    });
    const paginatedAdminPending = computed(() => {
      const s = (pendingAdminPage.value - 1) * pendingPageSize;
      return flattenBatchDisplayGroups(adminPendingBatchGroups.value.slice(s, s + pendingPageSize), 'admin');
    });

    const pendingMyPendingTotal = computed(() => Math.max(1, Math.ceil(filteredMyPendingRequests.value.length / pendingPageSize)));
    const pendingMySentTotal = computed(() => Math.max(1, Math.ceil(sentBatchGroups.value.length / pendingPageSize)));
    const pendingAdminTotal = computed(() => Math.max(1, Math.ceil(adminPendingBatchGroups.value.length / pendingPageSize)));

    watch(pendingSearchQuery, () => {
      pendingMyPendingPage.value = 1;
      pendingMySentPage.value = 1;
      pendingAdminPage.value = 1;
    });

    // 調課推薦（domain-match）
    // 調課週次以已選定的異動日期為基準，不受目前課表看板週次影響。
    const getExchangeWeekDates = () => {
      const dateStr = String(inputRequestDate.value || '').trim();
      if (dateStr && window.DateUtils && typeof window.DateUtils.getWeekDatesFrom === 'function') {
        const dates = window.DateUtils.getWeekDatesFrom(dateStr);
        if (Array.isArray(dates) && dates.length === 5) return dates;
      }
      return currentWeekDates.value || [];
    };
    const recommendedExchangeList = computed(() => {
      if (matchMode.value !== 'exchange' || !activeCell.value.dayOfWeek || !inputRequestDate.value) return [];
      const leaveCell = activeCell.value.classData || null;

      const offset = parseInt(exchangeWeekOffset.value, 10) || 0;
      const baseDates = getExchangeWeekDates();
      const targetWeekDates = baseDates.map(dStr => {
        if (!dStr) return '';
        if (offset === 0) return dStr;
        const d = new Date(String(dStr).replace(/-/g, '/'));
        if (isNaN(d.getTime())) return dStr;
        d.setDate(d.getDate() + offset * 7);
        return toLocalDateStr(d);
      });

      return window.DomainMatch.listExchangeCandidates({
        allSchedules: allSchedules.value,
        className: leaveCell ? leaveCell.className : '',
        leaveEmail: activeCell.value.teacherEmail,
        leaveDate: inputRequestDate.value,
        leavePeriod: activeCell.value.period,
        leaveDay: activeCell.value.dayOfWeek,
         leaveCell: leaveCell,
         leaveAttr: leaveCell ? leaveCell.attr : '',
         weekDates: targetWeekDates,
         isSingleWeek,
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
        const tk = (window.DateUtils && window.DateUtils.decodeTimeKey)
          ? window.DateUtils.decodeTimeKey(p.timeKey)
          : { period: parseInt(String(p.timeKey).slice(-1), 10) };
        const n = parseInt(tk.period, 10);
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
        const before = t ? (parseFloat(t.mutualQuota) || 0) : 0;
        const deduct = counts[em];
        // 須餘額 ≥ 本次扣節數（每節 1）；0.5 不夠扣 1
        const short = before + 1e-9 < deduct;
        const after = short ? before : Math.round((before - deduct) * 1000) / 1000;
        return { email: em, name, before, deduct, after: Math.max(0, after), short };
      });
      return lines.length ? lines : null;
    });
    const quotaDeductInsufficient = computed(() =>
      !!(quotaDeductPreview.value && quotaDeductPreview.value.some(q => q.short))
    );
    /** 額度不足時改經費：活動互代→活動公費；一般→自費 */
    const switchQuotaDeductToSelfPay = () => {
      if (pendingRequestData.value.mode !== 'substitution') return;
      if (isPeriod8FeeLocked.value) {
        showToast('第8節須使用計畫經費，無法改自費', 'warning');
        return;
      }
      if (isMutualCover.value) {
        pendingRequestData.value.subFee = ACTIVITY_PUBLIC_FEE;
        batchSubFee.value = ACTIVITY_PUBLIC_FEE;
        showToast('額度不足，已改為活動公費', 'info');
        return;
      }
      pendingRequestData.value.subFee = '自費代課';
      batchSubFee.value = '自費代課';
      showToast('已改為自費代課，請再確認後送出', 'info');
    };
    /**
     * 選「扣額度」且額度不足：
     * - 活動互代 → 自動改「活動公費」並允許送出
     * - 一般 → 擋送出（請改自費或換人）
     */
    const assertQuotaDeductAllowed = () => {
      if (pendingRequestData.value.mode !== 'substitution') return true;
      if (pendingRequestData.value.subFee !== QUOTA_DEDUCT_FEE) return true;
      if (isPeriod8FeeLocked.value) return true;
      const lines = quotaDeductPreview.value;
      if (!lines || !lines.length) {
        if (isMutualCover.value) {
          pendingRequestData.value.subFee = ACTIVITY_PUBLIC_FEE;
          batchSubFee.value = ACTIVITY_PUBLIC_FEE;
          showToast('找不到可用額度，已改為活動公費', 'info');
          return true;
        }
        showToast('找不到代課老師的折抵額度，請改用自費代課或其他經費', 'warning');
        return false;
      }
      const shorts = lines.filter(q => q.short);
      if (!shorts.length) return true;
      const tip = shorts.map(q => `${q.name}（現有 ${q.before}，需扣 ${q.deduct}）`).join('、');
      if (isMutualCover.value) {
        pendingRequestData.value.subFee = ACTIVITY_PUBLIC_FEE;
        batchSubFee.value = ACTIVITY_PUBLIC_FEE;
        showToast(`額度不足（${tip}），已自動改為活動公費`, 'info');
        return true;
      }
      showToast(`額度不足，不可用「扣額度」：${tip}。請改自費排代，或另選有額度的老師。`, 'warning');
      return false;
    };

    // 個人調代課摘要 (未來排前，過去排後且淡化)
    const personalChanges = computed(() => {
      if (!user.value) return [];
       const email = String(getTeacherNameByEmail(user.value.email) || '').toLowerCase();
      const todayStr = getTodayString();
       const relatedRecords = substitutionRecords.value.filter(r =>
         (r.originalTeacherName && r.originalTeacherName.toLowerCase() === email) ||
         (r.actualTeacherName && r.actualTeacherName.toLowerCase() === email)
       );
       const triangleGroups = Object.create(null);
       relatedRecords.forEach(r => {
         if (!isTriangleRequest(r)) return;
         const key = String(r.triangleId || r.requestId || r.id || '');
         if (!key) return;
         if (!triangleGroups[key]) triangleGroups[key] = [];
         triangleGroups[key].push(r);
       });
       const triangleSummaries = Object.keys(triangleGroups).map(key => {
         const group = triangleGroups[key];
         const outgoing = group.find(r => String(r.actualTeacherName || '').toLowerCase() === email);
         const incoming = group.find(r => String(r.originalTeacherName || '').toLowerCase() === email);
         const base = outgoing || incoming || group[0];
         return base ? Object.assign({}, base, {
           _triangleOutgoing: outgoing || null,
           _triangleIncoming: incoming || null,
           triangleId: key,
           date: (outgoing && outgoing.date) || (incoming && incoming.date) || base.date
         }) : null;
       }).filter(Boolean);
       const records = relatedRecords.filter(r => !isTriangleRequest(r));
      const exchangePeersByRequestId = Object.create(null);
       substitutionRecords.value.forEach(r => {
        if (!r || r.type !== 'exchange' || !r.requestId) return;
        const key = String(r.requestId);
        if (!exchangePeersByRequestId[key]) exchangePeersByRequestId[key] = [];
        exchangePeersByRequestId[key].push(r);
      });

      // 調課去重：優先保留自己去上課（actualTeacherEmail 是自己）的那一筆
      const deduped = [];
      const seenExchange = new Set();
      
      records.forEach(r => {
        if (r.type === 'exchange') {
           if (r.actualTeacherName && r.actualTeacherName.toLowerCase() === email) {
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
       triangleSummaries.forEach(r => deduped.push(r));

      const fmtClassLine = (dateStr, period, className, subject, verb) => {
        const mmdd = formatDateMMDD(dateStr);
        const dow = new Date(dateStr.replace(/-/g, '/')).getDay();
        const day = getWeekDayText(dow);
        const v = verb != null ? verb : '上';
        return v ? `${mmdd}(${day}) 第${period}節 ${v} ${className}${subject}` : `${mmdd}(${day}) 第${period}節 ${className}${subject}`;
      };

      const fmtPeerSlot = (dateStr, period) => {
        const mmdd = formatDateMMDD(dateStr);
        const dow = new Date(dateStr.replace(/-/g, '/')).getDay();
        const day = getWeekDayText(dow);
        return `${mmdd}(${day})`;
      };

      /** 是否空堂排班／空堂任務（原＝實＝本人） */
      const isEmptySlotRec = (r) => {
        if (!r) return false;
        if (r.isEmptySlotAssign === true) return true;
        const reason = String(r.reason || '').trim();
        const note = String(r.note || '');
        if (reason === '空堂排班' || note.indexOf('[空堂排班]') >= 0) return true;
         const o = String(r.originalTeacherName || '').toLowerCase();
         const a = String(r.actualTeacherName || '').toLowerCase();
        return !!(o && a && o === a && (reason === '空堂排班' || note.indexOf('空堂') >= 0));
      };
      const isMutualRec = (r) => {
        if (!r) return false;
        if (isQuotaDeductFee(r.subFee)) return true;
        const f = String(r.subFee || '');
        // 「第8節代課」是第八節的一般代課經費代碼，不代表活動互代。
        return f === '活動公費';
      };
      /** 事由是否屬「請假」類（否則用「課務異動／代課」） */
      const isLeaveLikeReason = (reason) => {
        const s = String(reason || '').trim();
        if (!s) return true; // 舊資料缺事由，保守當請假
        if (s === '空堂排班') return false;
        if (s === '合班回原班' || s === '併班上課') return true;
        if (/公假|事假|病假|婚假|喪假|產假|娩假|生理假|家庭照顧|防疫|特休|休假|公差|公出|外出|研習|進修/.test(s)) return true;
        if (/請假/.test(s)) return true;
        return false;
      };

      const list = deduped.map(r => {
        const isPast = r.date < todayStr;
         const isRequester = r.originalTeacherName && r.originalTeacherName.toLowerCase() === email;
         const isTriangle = isTriangleRequest(r);
         const isSwap = r.type === 'exchange';

        let classLine = '';
        let desc = '';

         if (isTriangle) {
           const outgoing = r._triangleOutgoing || {};
           const incoming = r._triangleIncoming || {};
           const sourceDate = outgoing.triangleSourceDate || outgoing.date || r.triangleSourceDate || r.date;
           const sourcePeriod = outgoing.triangleSourcePeriod != null ? outgoing.triangleSourcePeriod : (outgoing.period != null ? outgoing.period : r.period);
           const targetDate = outgoing.date || r.date;
           const targetPeriod = outgoing.period != null ? outgoing.period : r.period;
           classLine = fmtClassLine(sourceDate, sourcePeriod, outgoing.className || r.className || '', outgoing.subject || r.subject || '', '');
           const targetText = `${fmtPeerSlot(targetDate, targetPeriod)}第${targetPeriod}節`;
           const incomingText = incoming
             ? `原課時段由 ${incoming.actualTeacherName || '其他教師'} 接手 ${incoming.className || ''}${incoming.subject || ''}`
             : '等待其他教師完成閉環';
           desc = `△ 三角調：您的原課移至 ${targetText}；${incomingText}`;
         } else if (isSwap) {
          const peer = (exchangePeersByRequestId[String(r.requestId)] || []).find(x => x.id !== r.id);
          classLine = fmtClassLine(r.date, r.period, r.className, r.subject);
          if (peer) {
            const peerTeacherName = getTeacherNameByEmail(peer.actualTeacherEmail);
            const peerSlot = fmtPeerSlot(peer.date, peer.period);
            desc = `🔄 原${peerSlot}第${peer.period}節 由 ${peerTeacherName}老師上課（${peer.subject}）`;
          } else {
             const otherName = r.actualTeacherName && r.actualTeacherName.toLowerCase() === email
               ? r.originalTeacherName : r.actualTeacherName;
            desc = `🔄 與 ${otherName} 老師調課`;
          }
        } else if (isEmptySlotRec(r)) {
          // 空堂任務：自己排任務進空堂，不是請假代課
          const task = String(r.subject || '').trim() || '空堂任務';
          classLine = fmtClassLine(r.date, r.period, r.className || '', task, '');
          desc = `📌 空堂任務：${task}`;
        } else {
          classLine = fmtClassLine(r.date, r.period, r.className, r.subject, isRequester ? '' : '上');
           const otherSub = r.actualTeacherName || '';
           const otherLeave = r.originalTeacherName || '';
          const reason = String(r.reason || '').trim();
          if (isRequester) {
            if (isMutualRec(r)) {
              desc = `🔁 活動互代／外出，由 ${otherSub} 老師代課`;
            } else if (isLeaveLikeReason(reason)) {
              desc = `🏖️ 請假，由 ${otherSub} 老師代課`;
            } else {
              desc = `📋 課務由 ${otherSub} 老師代課` + (reason ? `（${reason}）` : '');
            }
          } else if (isMutualRec(r)) {
            desc = `🔁 互代：代 ${otherLeave} 老師`;
          } else if (isLeaveLikeReason(reason)) {
            desc = `📝 代課：協助 ${otherLeave} 老師`;
          } else {
            desc = `📝 代課：${otherLeave} 老師` + (reason ? `（${reason}）` : '');
          }
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

      // 全校對調不是申請單，依教師在對調來源節次的固定課表補進個人摘要。
      const schoolSwapChanges = [];
      const ownSchedules = (allSchedules.value || []).filter(s =>
        String(s && s.teacherName || '').trim().toLowerCase() === email
      );
      const isPatrolSchedule = (schedule) => {
        if (!schedule) return false;
        if (schedule.isPatrol === true) return true;
        const attr = String(schedule.attr || '').trim();
        const className = String(schedule.className || '').trim();
        const subject = String(schedule.subject || '').trim();
        return attr === '巡堂' || attr.includes('巡堂') || className === '巡堂' || subject === '巡堂';
      };
      if (window.DomainSchoolSwap && ownSchedules.length) {
        const activeSwaps = window.DomainSchoolSwap.normalizeRows(schoolSwaps.value || [])
          .filter(row => row.enabled);
        activeSwaps.forEach(row => {
          const endpoints = [
            { endpoint: 'A', date: row.dateA, period: row.periodA, sourceDate: row.dateB, sourceDay: row.dayB, sourcePeriod: row.periodB },
            { endpoint: 'B', date: row.dateB, period: row.periodB, sourceDate: row.dateA, sourceDay: row.dayA, sourcePeriod: row.periodA }
          ];
          // 只要任一端是巡堂，這位教師整筆對調不套用。
          if (endpoints.some(endpoint => ownSchedules.some(s =>
             parseInt(s.dayOfWeek, 10) === parseInt(endpoint.sourceDay, 10)
               && parseInt(s.period, 10) === parseInt(endpoint.sourcePeriod, 10)
               && (!window.DomainSchedule || !window.DomainSchedule.isActiveOnDate
                 || window.DomainSchedule.isActiveOnDate(s, endpoint.date))
               && isPatrolSchedule(s)
          ))) return;
          endpoints.forEach(endpoint => {
            ownSchedules
              .filter(s => {
                 if (parseInt(s.dayOfWeek, 10) !== parseInt(endpoint.sourceDay, 10)
                     || parseInt(s.period, 10) !== parseInt(endpoint.sourcePeriod, 10)) return false;
                 if (window.DomainSchedule && window.DomainSchedule.isActiveOnDate
                     && !window.DomainSchedule.isActiveOnDate(s, endpoint.date)) return false;
                const attr = String(s.attr || '').trim();
                if (attr === '單週' && !isSingleWeek(endpoint.date)) return false;
                if (attr === '雙週' && isSingleWeek(endpoint.date)) return false;
                if (isPatrolSchedule(s)) return false;
                return !!(String(s.className || '').trim() || String(s.subject || '').trim() || attr);
              })
              .forEach((schedule, index) => {
                const className = String(schedule.className || '').trim();
                const subject = String(schedule.subject || '').trim();
                const attr = String(schedule.attr || '').trim();
                schoolSwapChanges.push({
                  id: `school-swap-${row.id}-${endpoint.endpoint}-${index}`,
                  requestId: '',
                  date: endpoint.date,
                  period: endpoint.period,
                  classLine: fmtClassLine(endpoint.date, endpoint.period, className || (attr === '巡堂' ? '巡堂' : ''), subject, ''),
                  desc: `🔁 全校對調：${row.name}（原${formatDateMMDD(endpoint.sourceDate)} ${formatPeriodText(endpoint.sourcePeriod)}）`,
                  serial: row.id || 'SWAP',
                  isPast: endpoint.date < todayStr,
                  statusClass: 'tag-blue',
                  statusText: '全校對調',
                  isSchoolSwap: true
                });
              });
          });
        });
      }

      // 排序：未來的升序，過去的降序
      const allChanges = list.concat(schoolSwapChanges);
      const future = allChanges.filter(x => !x.isPast).sort((a,b) => a.date.localeCompare(b.date) || a.period - b.period);
      const past = allChanges.filter(x => x.isPast).sort((a,b) => b.date.localeCompare(a.date) || b.period - a.period);
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
        matchShowNoTeacherWarning, matchEmptyReasons, recommendedTeachers,
        scheduleScope,
        fetchMatchCandidates: typeof fetchMatchCandidates === 'function' ? fetchMatchCandidates : null
      });
    };

    // 媒合列表：每次多載 10 人，無總人數上限
    const MATCH_PAGE_SIZE = 10;
    const loadMoreMatches = () => {
      const total = matchMode.value === 'exchange'
        ? filteredExchangeList.value.length
        : filteredRecommendedTeachers.value.length;
      matchDisplayCount.value = Math.min(matchDisplayCount.value + MATCH_PAGE_SIZE, total);
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

    const filteredExchangeList = computed(() => {
      let list = (recommendedExchangeList.value || []).slice();
      const q = String(matchSearchQuery.value || '').trim().toLowerCase();
      if (q) {
        list = list.filter((r) => [
          r.teacherName,
          r.teacherEmail,
          r.className,
          r.subject,
          r.dayOfWeek,
          r.period,
          getWeekDayText(r.dayOfWeek),
          formatPeriodText(r.period)
        ].map(value => String(value == null ? '' : value).toLowerCase()).join(' ').includes(q));
      }
      const day = parseInt(exchangeWeekdayFilter.value, 10);
      if (!day) return list;
      return list.filter(r => parseInt(r.dayOfWeek, 10) === day);
    });

    const displayedRecommendedTeachers = computed(() =>
      filteredRecommendedTeachers.value.slice(0, matchDisplayCount.value)
    );

    // 調課媒合同樣分頁
    const displayedExchangeList = computed(() => {
      const list = filteredExchangeList.value || [];
      return list.slice(0, matchDisplayCount.value);
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
         formatDateMMDD, getWeekDayText, exchangePeriodId, exchangeWeekOffset, exchangeTargetDate, isSingleWeek,
        consecAlertsA, consecAlertsB, isMutualCover, assignMutualDraftFromMatch, PERIOD8_FEE,
        pendingRequestData, showMatchModal, showCompareModal, getLeaveTimeDefaults
      }, mode, targetEmail, periodIdVal, subjectVal, classVal);
    };

    const startCombinedReturn = () => {
      const cell = activeCell.value || {};
      const classData = cell.classData || {};
      const className = String(classData.className || '').trim();
      const hasCombinedTag = typeof hasScheduleSpecialTag === 'function'
        && hasScheduleSpecialTag(classData, '併班');
      if (!isAdmin.value) {
        showToast('併班上課僅限教學組建立', 'warning');
        return false;
      }
      if (!cell.teacherEmail || !cell.dayOfWeek || cell.period == null || !className) {
        showToast('請先點選一堂完整的併班課程', 'warning');
        return false;
      }
      if (classData.isPatrol || classData.attr === '巡堂') {
        showToast('巡堂節不適用併班上課', 'warning');
        return false;
      }
      if (!isCombinedClass(className) && !hasCombinedTag) {
        showToast('此功能僅適用於併班課堂', 'warning');
        return false;
      }
      const candidates = findCombinedReturnCandidates(cell);
      if (!candidates.length) {
        showToast('找不到同節次的其他併班任課教師，請先確認課表資料', 'warning');
        return false;
      }
      combinedReturnCandidates.value = candidates;
      const dateStr = inputRequestDate.value || (currentWeekDates.value[cell.dayOfWeek - 1] || '');
      const timeKey = (window.DateUtils && window.DateUtils.encodeTimeKey)
        ? window.DateUtils.encodeTimeKey(cell.dayOfWeek, cell.period)
        : (String(cell.dayOfWeek) + '-' + String(cell.period));
      pendingRequestData.value = {
        mode: 'substitution',
        specialFlow: (window.FieldMap && window.FieldMap.SPECIAL_FLOW_COMBINED_RETURN) || 'combined_return',
        leaveTeacher: cell.teacherEmail,
        subTeacher: candidates.length === 1 ? candidates[0].email : '',
        combinedReturnCandidates: candidates,
        cls: className,
        subject: classData.subject || '',
        date: dateStr,
        timeKey: timeKey,
        reason: '',
        courseAdjustmentOnly: false,
        leaveReasonBeforeCourseAdjustment: '',
        subFee: parseInt(cell.period, 10) === 8 ? PERIOD8_FEE : '',
        dateB: '',
        timeB: '',
        subB: '',
        subBClass: '',
        note: '',
        leaveTimeType: '',
        leaveTimeStart: '',
        leaveTimeEnd: '',
        leaveTime: '',
        submitRequestId: 'req_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9),
        submitSerial: 'SUB' + (1000 + Math.floor(Math.random() * 9000)),
        mutualPreview: false
      };
      isMutualCover.value = false;
      consecAlertsA.value = [];
      consecAlertsB.value = [];
      matchPreview.value = null;
      showMatchModal.value = false;
      showCompareModal.value = true;
      return true;
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
    const getCompareCellText = (who, day, period, view) => {
      if (!window.UiSubmitHelpers || !window.UiSubmitHelpers.getCompareCellText) return '';
      return window.UiSubmitHelpers.getCompareCellText({
         pendingRequestData, currentWeekDates, compareWeekDatesA, compareWeekDatesB,
         getScheduleForDate, isClassAwayOnDate,
        resolveCompareBEmail, isBatchSlotAt, getBatchSlotForCompareB,
        mutualDrafts, isMutualCover
      }, who, day, period, view);
    };
    const getCompareCellClass = (who, day, period, view) => {
      if (!window.UiSubmitHelpers || !window.UiSubmitHelpers.getCompareCellClass) return '';
      return window.UiSubmitHelpers.getCompareCellClass({
         pendingRequestData, currentWeekDates, compareWeekDatesA, compareWeekDatesB,
         getScheduleForDate, isClassAwayOnDate,
        resolveCompareBEmail, isBatchSlotAt, getBatchSlotForCompareB, isSlotConflict,
        mutualDrafts, isMutualCover
      }, who, day, period, view);
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
      const tk = (window.DateUtils && window.DateUtils.decodeTimeKey)
        ? window.DateUtils.decodeTimeKey(timeKey)
        : { day: parseInt(timeKey.slice(0, -1), 10), period: parseInt(timeKey.slice(-1), 10) };
      const day = parseInt(tk.day, 10);
      const period = parseInt(tk.period, 10);
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
         hasSubTeacherConflict, assertQuotaDeductAllowed,
         activeCell, allSchedules, getScheduleForDate, isSingleWeek,
        isProxySubmitActive: function () { return isProxySubmitActive.value; },
        assertCanSubmitAsLeaveTeacher: assertCanSubmitAsLeaveTeacher
      });
    };

    const buildSubmitPayload = (requestId, serial) => {
      if (!window.UiSubmitHelpers) {
        throw new Error('UiSubmitHelpers 未載入');
      }
      return window.UiSubmitHelpers.buildSubmitPayload({
        pendingRequestData, currentSemester, getTeacherNameByEmail, isAdmin, directApproveMode,
        isMutualCover, PERIOD8_FEE, ACTIVITY_PUBLIC_FEE, defaultSubFeeForReason, activeCell, DAC,
        paperFlow,
        isProxySubmitActive: function () { return isProxySubmitActive.value; },
        canStaffProxySubmit: function () { return canStaffProxySubmit.value; },
        shouldProxySubmitForLeave: shouldProxySubmitForLeave,
        getProxyActor: getProxyActor,
        userEmail: function () { return user.value ? user.value.email : ''; }
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
      getLeaveTimeDefaults: getLeaveTimeDefaults,
      getTeacherSubjectByEmail: function (em) { return getTeacherSubjectByEmail(em); },
      getScheduleForDate: function (a, b, c, d) { return getScheduleForDate(a, b, c, d); },
      formatDateMMDD: function (d) { return formatDateMMDD(d); },
      getTimetableApi: function () { return getTimetableApi(); },
      defaultSubFeeForReason: function (r) { return defaultSubFeeForReason(r); },
      softRefreshInBackground: function (opts) { return softRefreshInBackground(opts || {}); },
      optimisticUpsertRequest: function (r) { return optimisticUpsertRequest(r); },
      sheetRequestToFront: function (r) { return sheetRequestToFront(r); },
      isAdmin: isAdmin,
      isProxySubmitActive: function () { return isProxySubmitActive.value; },
      canStaffProxySubmit: function () { return canStaffProxySubmit.value; },
      shouldProxySubmitForLeave: shouldProxySubmitForLeave,
      getProxyActor: getProxyActor,
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
      matchEmptyReasons: matchEmptyReasons,
      consecAlertsA: consecAlertsA,
      consecAlertsB: consecAlertsB,
      directApproveMode: directApproveMode,
      paperMode: paperMode,
      paperFlow: paperFlow,
      notificationsSuppressed: notificationsSuppressed,
      openPaperPrintDraft: function (requests) {
        return requests && requests.length
          ? openPaperPrintDraftForSubmittedRequests(requests)
          : openPaperPrintDraftFromCompare();
      },
      openPaperPrintMutualDrafts: function () { return openPaperPrintMutualDrafts(); },
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
      successActionRequests: successActionRequests,
      buildLineBatchInviteText: buildLineBatchInviteText,
      successFlowMode: successFlowMode
    });

    // ── 主函數③：執行提交（ui-request.js）──
    const executeSubmitRequest = async () => {
      if (paperMode.value && !isAdmin.value && isMutualCover.value && !paperFlow.value) {
        openPaperPrintDraftFromCompare();
        return;
      }
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
        activeCell, inputRequestDate,
        isMutualCover, mutualSkipNotify, isAdmin, directApproveMode, directApproveSkipNotify,
        callGasApi, showCompareModal, showMatchModal, optimisticUpsertRequest, sheetRequestToFront,
        deductMutualQuotaForRows, softRefreshInBackground, isQuotaDeductFee, buildLineInviteText,
         successModalTitle, successModalMessage, lineCopyText, hasLineTemplate, showSuccessModal, successActionRequests, showToast,
        successFlowMode, paperMode, paperFlow, notificationsSuppressed,
        openPaperPrintDraft: function (requests) {
          return requests && requests.length
            ? openPaperPrintDraftForSubmittedRequests(requests)
            : openPaperPrintDraftFromCompare();
        },
        canStaffProxySubmit: function () { return canStaffProxySubmit.value; },
        shouldProxySubmitForLeave: shouldProxySubmitForLeave,
        getProxyActor: getProxyActor,
        getTeacherNameByEmail: getTeacherNameByEmail,
        userEmail: function () { return user.value ? user.value.email : ''; }
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
         allSchedules, schoolSwaps, substitutionRecords, substitutionsLookup, allPendingRequests,
        // 只用目前可見頁的教師建 grid，全校模式才真正省算力
        displayTimetableTeachers: visibleTimetableTeachers, currentWeekDates,
        getTeacherNameByEmail, getTeacherSubjectByEmail, formatDateMMDD, isSingleWeek,
        isClassAwayOnDate, getWeekDayText,
        batchSelectMode, isBatchSlotSelected, isMutualCover, getMutualDraftAt,
        mutualDrafts, mutualAwayClasses, mutualActivityStart, mutualActivityEnd, DAC
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

    // 併班上課只能指定同節、同併班課堂中的其他任課教師。
    const findCombinedReturnCandidates = (cell) => {
      const source = cell || {};
      const sourceTeacherKey = String(getTeacherNameByEmail(source.teacherEmail || source.teacherName) || source.teacherEmail || source.teacherName || '')
        .trim().toLowerCase();
      const sourceDay = parseInt(source.dayOfWeek, 10);
      const sourcePeriod = parseInt(source.period, 10);
      const sourceDate = String(inputRequestDate.value || (currentWeekDates.value[sourceDay - 1] || '')).slice(0, 10);
      if (!sourceTeacherKey
          || !Number.isFinite(sourceDay) || !Number.isFinite(sourcePeriod)) return [];

      const availableByTeacher = Object.create(null);
      const candidatesByTeacher = Object.create(null);
      (allSchedules.value || []).forEach(schedule => {
        if (!schedule) return;
        const rawTeacher = String(schedule.teacherEmail || schedule.teacherName || '').trim();
        const teacherKey = String(getTeacherNameByEmail(rawTeacher) || rawTeacher).trim().toLowerCase();
        if (!teacherKey || teacherKey === sourceTeacherKey) return;
        if (parseInt(schedule.dayOfWeek, 10) !== sourceDay
            || parseInt(schedule.period, 10) !== sourcePeriod) return;

        const scheduleClass = String(schedule.className || '').trim();
        const scheduleTags = getScheduleSpecialTags(schedule);
        const isCombined = isCombinedClass(scheduleClass) || scheduleTags.includes('併班');
        // 音樂班等特殊班級的名稱不會與八、九年級班名重疊，不能用班名交集判斷。
        if (!isCombined) return;
        if (schedule.isPatrol || schedule.attr === '巡堂' || schedule.attr === '抽離'
            || scheduleTags.includes('抽離')) return;
        if (sourceDate && window.DomainSchedule && typeof window.DomainSchedule.isActiveOnDate === 'function'
            && !window.DomainSchedule.isActiveOnDate(schedule, sourceDate)) return;
        if (sourceDate && schedule.attr === '單週' && !isSingleWeek(sourceDate)) return;
        if (sourceDate && schedule.attr === '雙週' && isSingleWeek(sourceDate)) return;

        if (availableByTeacher[teacherKey] === undefined) {
          const current = typeof getScheduleForDate === 'function'
            ? getScheduleForDate(rawTeacher, sourceDate, sourcePeriod, sourceDay)
            : null;
          availableByTeacher[teacherKey] = !current
            || (!current.isPending && !current.isSubstituted && !current.isSubstitutionDuty);
        }
        if (!availableByTeacher[teacherKey]) return;

        const rosterTeacher = lookupTeacher(rawTeacher);
        const candidate = candidatesByTeacher[teacherKey] || {
          email: (rosterTeacher && (rosterTeacher.email || rosterTeacher.teacherName || rosterTeacher.name)) || rawTeacher,
          name: (rosterTeacher && (rosterTeacher.name || rosterTeacher.teacherName))
            || getTeacherNameByEmail(rawTeacher) || rawTeacher,
          classNames: [],
          subjects: []
        };
        if (scheduleClass && !candidate.classNames.includes(scheduleClass)) candidate.classNames.push(scheduleClass);
        const subject = String(schedule.subject || '').trim();
        if (subject && !candidate.subjects.includes(subject)) candidate.subjects.push(subject);
        candidatesByTeacher[teacherKey] = candidate;
      });

      return Object.keys(candidatesByTeacher).map(key => {
        const candidate = candidatesByTeacher[key];
        return Object.assign({}, candidate, {
          teacherName: candidate.name,
          className: candidate.classNames.join('、'),
          subject: candidate.subjects.join('、'),
          dayOfWeek: sourceDay,
          period: sourcePeriod
        });
      }).sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'zh-Hant')
        || String(a.email || '').localeCompare(String(b.email || '')));
    };

    const weekScheduleGrid = computed(() => {
      const a = getTimetableApi();
      return a ? a.weekScheduleGrid.value : {};
    });

    const triangleTeacherKey = (value) => String(value || '').trim().toLowerCase();
    const triangleSlotKey = (slot) => {
      if (!slot) return '';
      return `${String(slot.date || '').slice(0, 10)}|${parseInt(slot.period, 10)}`;
    };
    const triangleCellIsUsable = (cell) => !!(cell
      && String(cell.className || '').trim()
      && String(cell.subject || '').trim()
      && !cell.isPending
      && !cell.isSubstituted
      && !cell.isSubstitutionDuty
      && !cell.isClassAway
      && !cell.isPatrol
      && cell.attr !== '巡堂');

    /** 以目前週課表列出可作為第二、第三位教師原課的有效課堂。 */
    const triangleCandidates = computed(() => {
      const source = activeCell.value || {};
      const sourceTeacher = triangleTeacherKey(source.teacherEmail || source.teacherName);
      const sourceDate = String(inputRequestDate.value || '').slice(0, 10);
      const sourceClass = String(source.classData && source.classData.className || '').trim();
      const sameClass = (left, right) => {
        const a = String(left || '').trim();
        const b = String(right || '').trim();
        if (!a || !b) return false;
        if (a === b) return true;
        if (window.DateUtils && typeof window.DateUtils.classListIncludes === 'function') {
          return window.DateUtils.classListIncludes(a, b) || window.DateUtils.classListIncludes(b, a);
        }
        return false;
      };
      if (!sourceTeacher || !sourceDate || !source.classData || !triangleCellIsUsable(source.classData)) return [];
      const dates = [];
      (currentWeekDates.value || []).forEach((date) => {
        if (date && dates.indexOf(date) < 0) dates.push(date);
      });
      if (dates.indexOf(sourceDate) < 0) dates.push(sourceDate);
      const periods = Array.isArray(timetablePeriods) && timetablePeriods.length
        ? timetablePeriods : [0, 1, 2, 3, 4, 45, 5, 6, 7, 8];
      const seen = Object.create(null);
      const result = [];
      (teachersList.value || []).forEach((teacher) => {
        if (!teacher) return;
        const email = teacher.email || teacher.teacherName || teacher.name || '';
        const teacherName = teacher.teacherName || teacher.name || email;
        if (!email || triangleTeacherKey(email) === sourceTeacher) return;
        if (!(allSchedules.value || []).some(schedule =>
          triangleTeacherKey(schedule.teacherEmail || schedule.teacherName) === triangleTeacherKey(email)
          && sameClass(schedule.className, sourceClass)
        )) return;
        dates.forEach((date, dateIndex) => {
          const day = dateIndex < 5 ? dateIndex + 1 : (() => {
            const parsed = new Date(String(date).replace(/-/g, '/'));
            if (Number.isNaN(parsed.getTime())) return 0;
            const raw = parsed.getDay();
            return raw === 0 ? 7 : raw;
          })();
          if (!day) return;
          periods.forEach((period) => {
            const cell = getScheduleForDate(email, date, period, day);
            if (!triangleCellIsUsable(cell)) return;
            if (!sameClass(cell.className, sourceClass)) return;
            const key = `${triangleTeacherKey(email)}|${date}|${parseInt(period, 10)}`;
            if (seen[key]) return;
            seen[key] = true;
            result.push({
              key,
              email,
              teacherName,
              date,
              dayOfWeek: day,
              period: parseInt(period, 10),
               className: String(cell.className || '').trim(),
               subject: String(cell.subject || '').trim(),
               attr: String(cell.attr || '').trim(),
               restriction: cell.restriction || '',
               specialTags: cell.specialTags || cell['特殊標記'] || '',
               isPullOut: !!(cell.isPullOut || cell.attr === '抽離')
             });
          });
        });
      });
      return result.sort((a, b) => String(a.teacherName).localeCompare(String(b.teacherName), 'zh-Hant')
        || String(a.date).localeCompare(String(b.date))
        || (a.period - b.period));
    });
    const triangleCandidateB = computed(() =>
      triangleCandidates.value.find((candidate) => candidate.key === trianglePickB.value) || null
    );
    const triangleCandidateCList = computed(() => {
      const b = triangleCandidateB.value;
      const bTeacher = b ? triangleTeacherKey(b.email) : '';
      return triangleCandidates.value.filter((candidate) => triangleTeacherKey(candidate.email) !== bTeacher);
    });
    const triangleCandidateC = computed(() =>
      triangleCandidateCList.value.find((candidate) => candidate.key === trianglePickC.value) || null
    );
    const triangleCandidateSearch = ref('');
    const triangleCandidateDisplayCount = ref(18);
    const triangleSourceParticipant = () => {
      const source = activeCell.value || {};
      const classData = source.classData || {};
      return {
        email: source.teacherEmail || source.teacherName || '',
        teacherName: source.teacherName || getTeacherNameByEmail(source.teacherEmail),
        slot: {
          date: String(inputRequestDate.value || '').slice(0, 10),
          day: parseInt(source.dayOfWeek, 10),
          period: parseInt(source.period, 10)
        },
        course: {
          className: String(classData.className || '').trim(),
          subject: String(classData.subject || '').trim(),
           attr: String(classData.attr || '').trim(),
           restriction: classData.restriction || '',
           specialTags: classData.specialTags || classData['特殊標記'] || '',
           isPatrol: !!classData.isPatrol,
          isPending: !!classData.isPending,
          isSubstituted: !!classData.isSubstituted
        }
      };
    };
    const triangleCandidateParticipant = (candidate) => candidate ? {
        email: candidate.email,
        teacherName: candidate.teacherName,
        slot: { date: candidate.date, day: candidate.dayOfWeek, period: candidate.period },
        course: {
           className: candidate.className,
           subject: candidate.subject,
           attr: candidate.attr,
           restriction: candidate.restriction || '',
           specialTags: candidate.specialTags || '',
           isPullOut: candidate.isPullOut
        }
       } : null;
    const triangleCandidateIsRestricted = (candidate) => !!(candidate && (
      candidate.restriction === 'restricted'
      || candidate.restriction === '限制'
      || hasScheduleSpecialTag(candidate, '綁課')
    ));
    const triangleParticipants = computed(() => [
      triangleSourceParticipant(),
      triangleCandidateParticipant(triangleCandidateB.value),
      triangleCandidateParticipant(triangleCandidateC.value)
    ]);
    const buildTriangleOccupiedByTeacher = (participants, scheduleGetter) => {
      const list = (participants || []).filter(Boolean);
      const occupied = {};
      const getCell = scheduleGetter || getScheduleForDate;
      list.forEach((participant) => {
        const teacherKey = participant.teacherName || participant.email;
        occupied[teacherKey] = [];
        list.forEach((other) => {
          const cell = getCell(
            participant.email,
            other.slot.date,
            other.slot.period,
            other.slot.day
          );
          if (!cell || (!cell.className && !cell.subject)) return;
          occupied[teacherKey].push({
            teacher: teacherKey,
            date: other.slot.date,
            period: other.slot.period,
            className: cell.className,
            subject: cell.subject
          });
        });
      });
      return occupied;
    };
    const triangleCandidateSearchText = (candidate) => [
      candidate && candidate.teacherName,
      candidate && candidate.email,
      candidate && candidate.className,
      candidate && candidate.subject,
      candidate && candidate.date,
      candidate && candidate.dayOfWeek,
      candidate && candidate.period,
      candidate && getWeekDayText(candidate.dayOfWeek)
    ].map(value => String(value == null ? '' : value).toLowerCase()).join(' ');
    const triangleCandidateOptions = computed(() => {
      const query = String(triangleCandidateSearch.value || '').trim().toLowerCase();
      const list = (triangleCandidates.value || []).slice();
      if (!query) return list;
      return list.filter(candidate => triangleCandidateSearchText(candidate).includes(query));
    });
    const createTriangleScheduleGetter = () => {
      const cache = Object.create(null);
      return (email, date, period, day) => {
        const key = `${String(email || '').toLowerCase()}|${String(date || '').slice(0, 10)}|${parseInt(period, 10)}|${parseInt(day, 10)}`;
        if (Object.prototype.hasOwnProperty.call(cache, key)) return cache[key];
        const cell = getScheduleForDate(email, date, period, day);
        cache[key] = cell;
        return cell;
      };
    };
    const validateTriangleSelection = (candidateB, candidateC, scheduleGetter) => {
      const source = triangleSourceParticipant();
      const b = triangleCandidateParticipant(candidateB);
      const c = triangleCandidateParticipant(candidateC);
      if (!source || !b || !c || !window.DomainTriangle || !window.DomainTriangle.buildCycleLegs) {
        return { ok: false, errors: ['三角調資料尚未選完整'] };
      }
      const participants = [source, b, c];
      const legs = window.DomainTriangle.buildCycleLegs(participants.map((participant) => ({
        teacher: participant.teacherName,
        slot: participant.slot,
        course: participant.course
      })));
      return window.DomainTriangle.validateTriangle(
        { legs },
        { occupiedByTeacher: buildTriangleOccupiedByTeacher(participants, scheduleGetter) }
      );
    };
    const triangleCandidateCanMoveTo = (candidate, targetSlot, scheduleGetter) => {
      if (!candidate || !targetSlot) return false;
      const sourceSlot = candidate.slot || candidate;
      const destination = targetSlot.slot || targetSlot;
      if (triangleSlotKey(sourceSlot) === triangleSlotKey(destination)) return true;
      const getCell = scheduleGetter || getScheduleForDate;
      const cell = getCell(candidate.email, destination.date, destination.period, destination.day || destination.dayOfWeek);
      return !cell || (!cell.className && !cell.subject && !cell.isPending && !cell.isSubstituted && !cell.isSubstitutionDuty);
    };
    const triangleCandidateSort = (a, b) => {
      const dayA = parseInt(a && a.dayOfWeek, 10) || 99;
      const dayB = parseInt(b && b.dayOfWeek, 10) || 99;
      return dayA - dayB
        || String(a && a.date || '').localeCompare(String(b && b.date || ''))
        || ((parseInt(a && a.period, 10) || 0) - (parseInt(b && b.period, 10) || 0))
        || String(a && a.teacherName || '').localeCompare(String(b && b.teacherName || ''), 'zh-Hant');
    };
    const triangleCandidatePriority = (candidate, availableKey) => {
      if (!candidate || !candidate[availableKey]) return 2;
      return candidate.triangleCanDirectExchange ? 1 : 0;
    };
    const triangleCandidateBPriority = (candidate) =>
      triangleCandidatePriority(candidate, 'triangleHasC');
    const triangleDirectExchangeKeys = computed(() => {
      const keys = Object.create(null);
      const source = triangleSourceParticipant();
      const sourceClass = source && source.course ? String(source.course.className || '').trim() : '';
      if (!source || !source.email || !source.slot.date || !sourceClass
          || !window.DomainMatch || typeof window.DomainMatch.listExchangeCandidates !== 'function') {
        return keys;
      }
      const directCandidates = window.DomainMatch.listExchangeCandidates({
        allSchedules: allSchedules.value,
        className: sourceClass,
        leaveEmail: source.email,
        leaveDate: source.slot.date,
        leavePeriod: source.slot.period,
        leaveDay: source.slot.day,
        leaveCell: activeCell.value && activeCell.value.classData
          ? activeCell.value.classData : source.course,
        leaveAttr: source.course.attr,
        weekDates: getExchangeWeekDates(),
        isSingleWeek,
        getScheduleForDate,
        getTeacherNameByEmail,
        awayClasses: isMutualCover.value ? mutualAwayClasses.value : []
      });
      const weekDates = getExchangeWeekDates();
      (directCandidates || []).forEach(candidate => {
        const day = parseInt(candidate.dayOfWeek, 10);
        const date = weekDates[day - 1] || candidate.date || '';
        const key = `${triangleTeacherKey(candidate.teacherEmail)}|${String(date).slice(0, 10)}|${parseInt(candidate.period, 10)}`;
        keys[key] = true;
      });
      return keys;
    });
    const triangleCandidateCOptions = computed(() => {
      const source = triangleSourceParticipant();
      const b = triangleCandidateB.value;
      const sourceTeacher = triangleTeacherKey(source.email || source.teacherName);
      const getCachedSchedule = createTriangleScheduleGetter();
      const bTeacher = b ? triangleTeacherKey(b.email) : '';
      if (!b) return [];
      return triangleCandidateOptions.value
        .filter(candidate => triangleTeacherKey(candidate.email) !== sourceTeacher
          && triangleTeacherKey(candidate.email) !== bTeacher)
        .map(candidate => {
          const canComplete = triangleCandidateCanMoveTo(b, candidate, getCachedSchedule)
            && triangleCandidateCanMoveTo(candidate, source.slot, getCachedSchedule);
          return Object.assign({}, candidate, {
            triangleHasB: canComplete,
            triangleIsRestricted: triangleCandidateIsRestricted(candidate)
          });
        })
        .sort((a, b) => Number(b.triangleHasB) - Number(a.triangleHasB)
          || triangleCandidateSort(a, b));
    });
    const triangleCandidateCReadyCount = computed(() =>
      triangleCandidateCOptions.value.filter(candidate => candidate.triangleHasB).length
    );
    const triangleCandidateBOptions = computed(() => {
      const source = triangleSourceParticipant();
      const allCandidates = triangleCandidates.value || [];
      const getCachedSchedule = createTriangleScheduleGetter();
      const sourceTeacher = triangleTeacherKey(source.email || source.teacherName);
      return triangleCandidateOptions.value
        .filter(candidate => triangleTeacherKey(candidate.email) !== sourceTeacher)
        .map(candidate => {
          const canMoveA = triangleCandidateCanMoveTo(source, candidate, getCachedSchedule);
          const hasC = canMoveA && allCandidates.some(c =>
            triangleTeacherKey(c.email) !== sourceTeacher
            && triangleTeacherKey(c.email) !== triangleTeacherKey(candidate.email)
            && triangleCandidateCanMoveTo(candidate, c, getCachedSchedule)
            && triangleCandidateCanMoveTo(c, source.slot, getCachedSchedule)
          );
          return Object.assign({}, candidate, {
            triangleHasC: hasC,
            triangleCanDirectExchange: !!triangleDirectExchangeKeys.value[candidate.key],
            triangleIsRestricted: triangleCandidateIsRestricted(candidate)
          });
        })
        .sort((a, b) => triangleCandidateBPriority(a) - triangleCandidateBPriority(b)
          || triangleCandidateSort(a, b));
    });
    const triangleCandidateBReadyCount = computed(() =>
      triangleCandidateBOptions.value.filter(candidate => candidate.triangleHasC).length
    );
    const displayedTriangleCOptions = computed(() =>
      triangleCandidateCOptions.value.slice(0, triangleCandidateDisplayCount.value)
    );
    const displayedTriangleBOptions = computed(() =>
      triangleCandidateBOptions.value.slice(0, triangleCandidateDisplayCount.value)
    );
    const selectTriangleCandidateB = (candidate) => {
      if (!candidate || candidate.triangleHasC === false) return;
      trianglePickB.value = candidate.key;
      trianglePickC.value = '';
      triangleCandidateSearch.value = '';
    };
    const selectTriangleCandidateC = (candidate) => {
      if (!candidate || candidate.triangleHasB === false) return;
      trianglePickC.value = candidate.key;
      triangleCandidateSearch.value = '';
    };
    const loadMoreTriangleCandidates = () => {
      const total = triangleCandidateB.value
        ? triangleCandidateCOptions.value.length
        : triangleCandidateBOptions.value.length;
      triangleCandidateDisplayCount.value = Math.min(
        triangleCandidateDisplayCount.value + 18,
        total
      );
    };
    watch(triangleCandidateSearch, () => {
      triangleCandidateDisplayCount.value = 18;
    });
    const triangleLegs = computed(() => {
      const participants = triangleParticipants.value;
      if (participants.some((participant) => !participant)) return [];
      if (window.DomainTriangle && window.DomainTriangle.buildCycleLegs) {
        return window.DomainTriangle.buildCycleLegs(participants.map((participant) => ({
          teacher: participant.teacherName,
          slot: participant.slot,
          course: participant.course
        })));
      }
      return [];
    });
    const triangleValidation = computed(() => {
      if (!trianglePickB.value || !trianglePickC.value) {
        return { ok: false, errors: ['請選擇另外兩位教師的有效原課'] };
      }
      if (!window.DomainTriangle || !window.DomainTriangle.validateTriangle) {
        return { ok: false, errors: ['三角調模組尚未載入'] };
      }
      return validateTriangleSelection(triangleCandidateB.value, triangleCandidateC.value);
    });
    const trianglePreviewRows = computed(() => triangleLegs.value.map((leg) => ({
      index: leg.index,
      sourceTeacher: leg.sourceTeacher,
      targetTeacher: leg.targetTeacher,
      sourceSlot: leg.sourceSlot,
      targetSlot: leg.targetSlot,
      sourceCourse: leg.sourceCourse
    })));
    const trianglePreviewWeekDates = computed(() => getExchangeWeekDates().map((date, index) => ({
      date,
      day: index + 1,
      weekDay: getWeekDayText(index + 1),
      shortDate: formatDateMMDD(date)
    })));
    const triangleTimetablePreview = computed(() => {
      const participants = triangleParticipants.value;
      if (participants.length !== 3 || participants.some(participant => !participant || !participant.email)) return [];
      const periods = Array.isArray(timetablePeriods) && timetablePeriods.length
        ? timetablePeriods : [0, 1, 2, 3, 4, 45, 5, 6, 7, 8];
      const dates = trianglePreviewWeekDates.value;
      return participants.map((participant, index) => ({
        role: ['A', 'B', 'C'][index],
        email: participant.email,
        teacherName: participant.teacherName,
        sourceSlot: participant.slot,
        sourceCourse: participant.course,
        targetSlot: participants[(index + 1) % participants.length].slot,
        rows: periods.map(period => ({
          period,
          cells: dates.map(dayInfo => {
            const isMovedFrom = triangleSlotKey(participant.slot) === triangleSlotKey({
              date: dayInfo.date,
              period
            });
            const isMovedTo = triangleSlotKey(participants[(index + 1) % participants.length].slot) === triangleSlotKey({
              date: dayInfo.date,
              period
            });
            const rawCell = getScheduleForDate(participant.email, dayInfo.date, period, dayInfo.day);
            const cell = isMovedTo
              ? participant.course
              : (isMovedFrom ? {} : (rawCell || {}));
            return {
              date: dayInfo.date,
              day: dayInfo.day,
              period,
              className: String(cell.className || '').trim(),
              subject: String(cell.subject || '').trim(),
              attr: String(cell.attr || '').trim(),
              restriction: cell.restriction || '',
              specialTags: cell.specialTags || cell['特殊標記'] || '',
              isPullOut: !!(cell.isPullOut || cell.attr === '抽離'),
              isRestricted: triangleCandidateIsRestricted(cell),
              isPending: !!cell.isPending,
              isSubstituted: !!cell.isSubstituted,
              isMovedFrom,
              isMovedTo
            };
          })
        }))
      }));
    });
    const openTriangleTimetablePreview = () => {
      if (!triangleReady.value) {
        showToast('請先選定可完成的 B、C，才能預覽三人課表', 'warning');
        return false;
      }
      showTriangleTimetablePreview.value = true;
      return true;
    };
    const triangleReady = computed(() => !!(triangleValidation.value && triangleValidation.value.ok));
    const resetTriangleDraft = () => {
      trianglePickB.value = '';
      trianglePickC.value = '';
      triangleReason.value = '';
      triangleNote.value = '';
      triangleCandidateSearch.value = '';
      triangleCandidateDisplayCount.value = 18;
    };
    const formatTriangleSlot = (slot, course, teacherName) => {
      if (!slot) return '—';
      const source = course || {};
      return formatLineSlot(
        slot.date,
        slot.day != null ? slot.day : slot.dayOfWeek,
        slot.period,
        source.className,
        source.subject,
        teacherName || source.teacherName || source.teacher
      );
    };
    const buildTriangleLineText = (request, groupRows) => {
      const row = request || {};
      const rows = groupRows || [];
      const participants = rows.map((item) => `${item.requesterName || ''}→${item.targetTeacherName || ''}`).join('、');
      const lines = rows.map((item, index) => {
         const source = formatLineSlot(item.requestDate, item.requestPeriodDay, item.requestPeriod, item.className, item.subject, item.requesterName || item.originalTeacherName);
         // 三角調是整堂課跟著來源教師走，目標時段仍顯示這條 leg 移入的原課。
          const target = formatLineSlot(item.targetDate, item.targetDayOfWeek, item.targetPeriod, item.className, item.subject, item.requesterName || item.originalTeacherName);
        const agree = `${window.location.origin}${window.location.pathname}?action=respond&id=${encodeURIComponent(item.id)}&status=agree`;
        const decline = `${window.location.origin}${window.location.pathname}?action=respond&id=${encodeURIComponent(item.id)}&status=decline`;
        return `${index + 1}. ${item.requesterName || '教師'}：${source} → ${target}\n　✅ 同意：${agree}\n　❌ 拒絕整組：${decline}`;
      });
      return `${row.targetTeacherName || '老師'}老師，這是一組三位教師的三角調課，需全部同意後才送教學組核准。\n\n假別／課務類型：${row.reason || '請假'}\n\n參與關係：${participants}\n\n${lines.join('\n\n')}\n\n感謝。`;
    };
    const submitTriangleRequest = async () => {
      if (triangleSubmitting.value) return;
      const validation = triangleValidation.value;
      if (!validation || !validation.ok) {
        showToast((validation && validation.errors && validation.errors[0]) || '請先完成三角調選擇', 'warning');
        return;
      }
      const reason = String(triangleReason.value || '').trim() || '請假';
      const trianglePaperFlow = !onlineSubstitutionEnabled.value;
      const participants = triangleParticipants.value;
      const triangleId = `tri_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const serial = `TRI${Math.floor(1000 + Math.random() * 9000)}`;
      const legs = validation.legs.map((leg, index) => {
        const source = participants[index];
        const target = participants[(index + 1) % participants.length];
        return Object.assign({}, leg, {
          sourceTeacherEmail: source.email,
          targetTeacherEmail: target.email,
          note: triangleNote.value
        });
      });
      triangleSubmitting.value = true;
      loading.value = true;
      loadingMessage.value = '正在送出三角調整組…';
      try {
         const result = await callGasApi('submitTriangleRequest', {
          triangleId,
           serial,
           legs,
           reason,
           note: triangleNote.value,
           skipNotify: trianglePaperFlow
         });
         const ids = result && Array.isArray(result.ids) ? result.ids : [];
        const actualTrianglePaperFlow = result && result.paperFlow != null
          ? !!result.paperFlow
          : trianglePaperFlow;
        const triangleStatus = actualTrianglePaperFlow ? 'pending_admin' : 'pending_teacher';
        const triangleConsentStatus = actualTrianglePaperFlow ? 'paper_pending' : 'pending';
        const frontRows = legs.map((leg, index) => sheetRequestToFront({
          '學期代號': currentSemester.value,
          '申請單ID': ids[index] || `${triangleId}_${index + 1}`,
          '單號': `${serial}-${index + 1}`,
          '批次ID': triangleId,
           '狀態': triangleStatus,
           '紙本流程': actualTrianglePaperFlow ? 'TRUE' : 'FALSE',
           paperFlow: actualTrianglePaperFlow,
          '申請人姓名': leg.sourceTeacher,
          '受邀人姓名': leg.targetTeacher,
          '班級': leg.sourceCourse.className,
          '科目': leg.sourceCourse.subject,
          '異動日期': leg.sourceSlot.date,
          '異動星期': leg.sourceSlot.day,
          '異動節次': leg.sourceSlot.period,
          '異動類型': 'triangle',
          '對調目標日期': leg.targetSlot.date,
          '對調目標星期': leg.targetSlot.day,
          '對調目標節次': leg.targetSlot.period,
          '對調目標班級': leg.targetCourse.className,
          '對調目標科目': leg.targetCourse.subject,
          '三角調ID': triangleId,
          '三角腳次': index + 1,
           '三角同意狀態': triangleConsentStatus,
           '三角組狀態': triangleStatus,
          '經費來源': '無',
          '請假事由': reason,
          '備註': triangleNote.value
        }));
        frontRows.forEach((row) => optimisticUpsertRequest(row));
        successActionRequests.value = frontRows;
        softRefreshInBackground({ delay: 2500 });
         if (actualTrianglePaperFlow) {
           showMatchModal.value = false;
           hasLineTemplate.value = false;
           lineCopyText.value = '';
           lineBatchParts.value = [];
           showSuccessModal.value = false;
           resetTriangleDraft();
          // openPrintPreview 需要 loading 已解除，才能像一般紙本流程一樣直接開啟列印預覽。
          loading.value = false;
          await openPaperPrintDraftForSubmittedRequests(frontRows);
          showToast('三角調申請已建立，請列印後由三位教師簽名，再交教學組核審。', 'success', 6000);
          return;
        }
        successModalTitle.value = '🎉 三角調申請已送出';
        successModalMessage.value = `三角調（${serial}）已建立，三位教師都同意後才會送交教學組核准。系統已寄出各自的簽核邀請。`;
        successFlowMode.value = 'normal';
        lineBatchParts.value = frontRows.map((row) => ({
          name: row.targetTeacherName,
          count: 1,
          text: buildTriangleLineText(row, frontRows)
        }));
        lineCopyText.value = '';
        hasLineTemplate.value = lineBatchParts.value.length > 0;
        resetTriangleDraft();
        showMatchModal.value = false;
        showSuccessModal.value = true;
      } catch (error) {
        console.error('三角調送出失敗：', error);
        showToast('三角調送出失敗：' + (error && error.message ? error.message : error), 'error');
      } finally {
        loading.value = false;
        triangleSubmitting.value = false;
      }
    };

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
      matchShowNoTeacherWarning.value = false;
      matchEmptyReasons.value = null;
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

    // ── 各 Modal：Esc 關閉 + 焦點陷阱 + aria-modal ──
    const _modalA11yDisposers = {};
    const bindVueModalA11y = (flag, closeFn, sel, label) => {
      watch(flag, (open) => {
        const key = sel;
        if (_modalA11yDisposers[key]) {
          try { _modalA11yDisposers[key](); } catch (e) { /* ignore */ }
          _modalA11yDisposers[key] = null;
        }
        if (!open) return;
        nextTick(() => {
          const overlay = document.querySelector(sel);
          if (!overlay) return;
          _modalA11yDisposers[key] = installModalA11y(overlay, {
            label: label || '對話框',
            onClose: () => {
              try { closeFn(); } catch (eC) { /* ignore */ }
            }
          });
        });
      });
    };
    bindVueModalA11y(showMatchModal, () => { closeMatchModal(); }, '.match-drawer-overlay', '智慧媒合');
    bindVueModalA11y(showCompareModal, () => { showCompareModal.value = false; }, '[data-tour="compare-modal"]', '模擬對照');
    bindVueModalA11y(showLineMessageModal, () => { showLineMessageModal.value = false; }, '[data-tour="line-message-modal"]', 'LINE 訊息');
    bindVueModalA11y(showSuccessModal, () => { showSuccessModal.value = false; }, '[data-tour="success-modal"]', '送出成功');
    // 其餘後台 modal：開啟時抓目前顯示的 .modal-overlay
    const bindFlagModal = (flag, closeFn, label) => {
      if (!flag || typeof flag !== 'object' || !('value' in flag)) return;
      watch(flag, (open) => {
        const key = 'flag:' + label;
        if (_modalA11yDisposers[key]) {
          try { _modalA11yDisposers[key](); } catch (e) { /* ignore */ }
          _modalA11yDisposers[key] = null;
        }
        if (!open) return;
        nextTick(() => {
          const overlays = document.querySelectorAll('.modal-overlay');
          let overlay = null;
          for (let i = overlays.length - 1; i >= 0; i--) {
            const el = overlays[i];
            const st = window.getComputedStyle(el);
            if (st.display !== 'none' && st.visibility !== 'hidden') {
              overlay = el;
              break;
            }
          }
          if (!overlay && overlays.length) overlay = overlays[overlays.length - 1];
          if (!overlay) return;
          _modalA11yDisposers[key] = installModalA11y(overlay, {
            label: label,
            onClose: () => { try { closeFn(); } catch (eC) { /* ignore */ } }
          });
        });
      });
    };
    bindFlagModal(showDetailModal, () => { showDetailModal.value = false; }, '異動詳情');
    bindFlagModal(showPrintPreviewModal, () => { closePrintPreview(true); }, '調代課單列印預覽');
    bindFlagModal(showSemesterModal, () => { showSemesterModal.value = false; }, '學期設定');
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
         const isEx = matchMode.value === 'exchange' || matchMode.value === 'triangle';
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
         showDetailModal, resolveDetailRequest, classReadonlyMode: classViewerReadonly, isAdmin, getTeacherNameByEmail,
        activeCell, inputRequestDate, matchMode, exchangeTargetDate, exchangeWeekOffset, exchangePeriodId,
        exchangeTeacherEmail, matchPreview, recommendedTeachers, matchSearchQuery, matchDisplayCount,
        showMatchModal, fetchRecommendations,
        canOperateOnTeacherEmail: canOperateOnTeacherEmail,
        ensureProxyTargetForTeacher: ensureProxyTargetForTeacher
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
        getTeacherNameByEmail, exchangeTargetDate, exchangeWeekOffset, exchangePeriodId, exchangeTeacherEmail,
        canOperateOnTeacherEmail: canOperateOnTeacherEmail,
        ensureProxyTargetForTeacher: ensureProxyTargetForTeacher,
        openEmptySlotAssign: openEmptySlotAssign
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
       const exchangeDate = String(inputRequestDate.value || '').trim();
       exchangeTeacherClasses.value = allSchedules.value.filter(s =>
         s.teacherEmail === exchangeTeacherEmail.value &&
         s.className === activeCell.value.classData.className &&
         (!exchangeDate || !window.DomainSchedule || !window.DomainSchedule.isActiveOnDate
           || window.DomainSchedule.isActiveOnDate(s, exchangeDate))
       );
    };


    /** 批次一次全部同意／全部拒絕 */
    // 月底大鐘點統計（domain-billing 延後載入）
    const ensureBillingReady = async () => {
      if (typeof window.ensureDomainBilling === 'function') {
        await window.ensureDomainBilling();
      }
      if (!window.DomainBilling) throw new Error('大鐘點模組未載入');
    };
    const calculateMonthlyReport = async () => {
      try {
        await ensureBillingReady();
      } catch (e) {
        monthlyReportData.value = [];
        return;
      }
      monthlyReportData.value = window.DomainBilling.buildMonthlyReportRows({
        teachers: teachersList.value,
        allSchedules: allSchedules.value,
        schoolSwaps: schoolSwaps.value,
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
        await ensureBillingReady();
        if (typeof window.ensureXlsx === 'function') await window.ensureXlsx();
      } catch (e) {
        showToast('Excel 模組載入失敗', 'error');
        return;
      }
      if (typeof XLSX === 'undefined') {
        showToast('Excel 模組未載入', 'error');
        return;
      }
      if (!monthlyReportData.value || !monthlyReportData.value.length) await calculateMonthlyReport();
      const data = window.DomainBilling.toExcelRows(monthlyReportData.value);
      const ws = XLSX.utils.json_to_sheet(data);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, `${reportMonth.value}大鐘點1-7午休`);
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
       XLSX.writeFile(wb, `全校大鐘點早自習1-7午休與第8節費_${reportMonth.value}.xlsx`);
    };

    // 匯出會計版五類 Excel（套用範本；扣勞健保／實際金額留白）
    const exportSubFeeToExcel = async () => {
      if (accountingExportLoading.value) return;
      accountingExportLoading.value = true;
      try {
        await ensureBillingReady();
        if (typeof window.ensureExportAccounting === 'function') await window.ensureExportAccounting();
        if (typeof window.ensureExcelJS === 'function') await window.ensureExcelJS();
      } catch (e) {
        accountingExportLoading.value = false;
        showToast('會計匯出模組或 ExcelJS 載入失敗', 'error');
        return;
      }
      try {
        if (!window.ExportAccounting || !window.ExportAccounting.buildExportData || !window.ExportAccounting.exportWorkbook) {
          throw new Error('會計匯出模組未載入');
        }
        if ((!accountingPeriod.value || !accountingPeriod.value.start || !accountingPeriod.value.end) && window.ExportAccounting.loadPeriodSettings) {
          accountingPeriod.value = window.ExportAccounting.loadPeriodSettings(reportMonth.value);
        }
        if (!monthlyReportData.value.length) await calculateMonthlyReport();
        const periodDefault = window.ExportAccounting.defaultPeriodSettings
          ? window.ExportAccounting.defaultPeriodSettings(reportMonth.value)
          : accountingPeriod.value;
        const normalizeAccountingPeriod = (period) => {
          const start = String(period && period.start || '').trim();
          const end = String(period && period.end || '').trim();
          if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end) || start > end) return null;
          return { start, end };
        };
        const initialPeriod = normalizeAccountingPeriod(accountingPeriod.value) || normalizeAccountingPeriod(periodDefault);
        if (!initialPeriod) throw new Error('會計匯出期間無效，請重新整理後再試。');
        const normalizeReportWeeks = (value) => {
          const weeks = Number(value);
          return Number.isInteger(weeks) && weeks >= 1 && weeks <= 6 ? weeks : null;
        };
        const initialWeeks = normalizeReportWeeks(reportWeeksCount.value) || 4;
        let monthlyRowsCache = null;
        let monthlyRowsCacheWeeks = null;
        const buildMonthlyRowsForExport = (weeks) => {
          if (monthlyRowsCache && monthlyRowsCacheWeeks === weeks) return monthlyRowsCache;
          let rows = monthlyReportData.value;
          if (window.DomainBilling && typeof window.DomainBilling.buildMonthlyReportRows === 'function') {
            rows = window.DomainBilling.buildMonthlyReportRows({
              teachers: teachersList.value,
              allSchedules: allSchedules.value,
              schoolSwaps: schoolSwaps.value,
              substitutionRecords: substitutionRecords.value,
              reportMonth: reportMonth.value,
              reportWeeksCount: weeks,
              getTeacherNameByEmail,
              classAwayEvents: classAwayEvents.value,
              semesterEndDate: semesterEndDate.value,
              isSingleWeek
            });
          }
          monthlyRowsCacheWeeks = weeks;
          monthlyRowsCache = rows;
          return rows;
        };
        const exportOpts = {
          reportMonth: reportMonth.value,
          reportWeeksCount: initialWeeks,
          periods: initialPeriod,
          teachers: teachersList.value,
          allSchedules: allSchedules.value,
          schoolSwaps: schoolSwaps.value,
          substitutionRecords: substitutionRecords.value,
          homeroomRecords: homeroomRecords.value,
          monthlyReportRows: buildMonthlyRowsForExport(initialWeeks),
          getTeacherNameByEmail,
          classAwayEvents: classAwayEvents.value,
          semesterEndDate: semesterEndDate.value,
          isSingleWeek
        };
        const buildPopupState = (period) => {
          const reportWeeks = initialWeeks;
          const monthlyRows = buildMonthlyRowsForExport(reportWeeks);
           const preview = window.ExportAccounting.buildExportData({
             ...exportOpts,
             reportWeeksCount: reportWeeks,
             monthlyReportRows: monthlyRows,
             periods: period
           });
           const summaryLines = preview.summary.map((item) => item.label + '：' + item.count + ' 筆／' + Number(item.hours || 0).toLocaleString() + ' 節／NT$ ' + Number(item.amount || 0).toLocaleString());
           const blockingLines = (preview.blocking || []).length
             ? '\n\n無法匯出：\n' + preview.blocking.map((w) => '⛔ ' + w).join('\n')
             : '';
           const warningLines = preview.warnings.length
             ? '\n\n匯出前提示：\n' + preview.warnings.map((w) => '⚠️ ' + w).join('\n')
             : '';
          return {
            period,
            reportWeeksCount: reportWeeks,
            monthlyReportRows: monthlyRows,
             blocking: preview.blocking || [],
             message: '將套用會計範本下載單一 Excel：\n\n授課週數：' + reportWeeks + ' 週\n\n' + summaryLines.join('\n') + blockingLines + warningLines + '\n\n扣勞健保與實際金額欄位會留白。'
           };
        };
        let popupState = buildPopupState(initialPeriod);
        const confirmed = await showConfirm(
          popupState.message,
          '匯出會計版五類 Excel',
          {
            withAccountingPeriod: true,
            periodStart: popupState.period.start,
            periodEnd: popupState.period.end,
            periodDefault,
            onAccountingPeriodChange: (draftPeriod) => {
               const nextPeriod = normalizeAccountingPeriod(draftPeriod);
               if (!nextPeriod) return '請先填寫有效的會計匯出起訖日，再確認下載。';
               popupState = buildPopupState(nextPeriod);
               return popupState.message;
            },
            validateAccountingPeriod: (draftPeriod) => {
               const nextPeriod = normalizeAccountingPeriod(draftPeriod);
               if (!nextPeriod) return false;
               popupState = buildPopupState(nextPeriod);
               return !(popupState.blocking && popupState.blocking.length);
             }
           }
         );
         if (!confirmed || !confirmed.ok) return;
         if (popupState.blocking && popupState.blocking.length) {
           showToast('請先補齊超鐘點經費來源，才能匯出會計 Excel。', 'warning');
           return;
         }
        const finalPeriod = normalizeAccountingPeriod(confirmed.period) || popupState.period;
        const finalWeeks = initialWeeks;
        const finalPopupState = buildPopupState(finalPeriod);
        exportOpts.periods = finalPeriod;
        exportOpts.reportWeeksCount = finalWeeks;
        exportOpts.monthlyReportRows = finalPopupState.monthlyReportRows;
        monthlyReportData.value = finalPopupState.monthlyReportRows;
        accountingPeriod.value = finalPeriod;
        if (window.ExportAccounting.savePeriodSettings) {
          window.ExportAccounting.savePeriodSettings(reportMonth.value, finalPeriod);
        }
        const result = await window.ExportAccounting.exportWorkbook(exportOpts);
        const blob = new Blob([result.buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = result.fileName;
        document.body.appendChild(link);
        link.click();
        setTimeout(() => {
          try { document.body.removeChild(link); } catch (e) { /* ignore */ }
          try { URL.revokeObjectURL(url); } catch (e) { /* ignore */ }
        }, 1200);
        showToast('已下載：' + result.fileName, 'success');
      } catch (e) {
        console.error(e);
        showToast('會計版 Excel 匯出失敗：' + (e.message || e), 'error');
      } finally {
        accountingExportLoading.value = false;
      }
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

    // 活動輪值通知單（套版 Word）：從空堂事件列一鍵匯出
    const ensureActivityCoverReady = async () => {
      if (typeof window.ensureJSZip === 'function') {
        await window.ensureJSZip();
      }
      if (typeof window.ensureExportActivityCover === 'function') {
        await window.ensureExportActivityCover();
      }
      if (!window.ExportActivityCover || !window.ExportActivityCover.exportWord) {
        throw new Error('輪值通知單匯出模組尚未載入');
      }
      if (!(window.JSZip || (typeof JSZip !== 'undefined' && JSZip))) {
        throw new Error('JSZip 未載入');
      }
    };
    const exportActivityCoverWord = async (evArg) => {
      if (!isAdmin.value) {
        showToast('僅管理員可匯出輪值通知單', 'warning');
        return;
      }
      try {
        await ensureActivityCoverReady();
      } catch (e) {
        showToast((e && e.message) || '匯出模組載入失敗', 'error');
        return;
      }
      let ev = evArg && typeof evArg === 'object' && evArg.id != null ? evArg : null;
      if (!ev && evArg) {
        const id = String(evArg || '');
        ev = (classAwayEvents.value || []).find(e => e && String(e.id) === id) || null;
      }
      if (!ev) {
        showToast('請從空堂事件列點「匯出輪值單」', 'warning');
        return;
      }
      const startDate = String(ev.startDate || '').slice(0, 10);
      let endDate = String(ev.endDate || ev.startDate || '').slice(0, 10);
      if (!startDate) {
        showToast('此事件沒有起日，無法匯出', 'warning');
        return;
      }
      if (!endDate) endDate = startDate;
      const activityName = String(ev.name || '').trim() || '活動';
      const grade = window.ExportActivityCover.gradesFromClasses
        ? window.ExportActivityCover.gradesFromClasses(ev.classes || [])
        : '';
      const awayClasses = (ev.classes || []).slice();
      // 僅活動互代經費（扣額度／活動公費／第8節代課）；排除一般公費／自費
      const isActFee = (fee, period) => {
        const f = String(fee || '').trim();
        const p = parseInt(period, 10) || 0;
        if (f === '扣額度' || f === '互代不結' || f === '活動公費' || f === '第8節代課') return true;
        if (p === 8 && (!f || f === '計畫經費' || f.indexOf('第8') >= 0)) return true;
        return false;
      };
      const allReqs = (requestsList.value || []).filter((r) => {
        if (!r || r.type === 'exchange') return false;
        const st = String(r.status || '').toLowerCase();
        if (st === 'cancelled' || st === 'rejected' || st === 'admin_rejected' || st === 'withdrawn') return false;
        const p = parseInt(r.requestPeriod != null ? r.requestPeriod : r.period, 10) || 0;
        return isActFee(r.subFee, p);
      });

      // OO＝釋出堂數（與「＋發放額度」合計釋出同口徑：非帶隊、有外出班課之釋出加總）
      // XX＝1～7 扣額度已排（export 內算）；尚有＝OO−XX
      let demand = 0;
      const dac = await ensureDAC();
      if (dac && dac.buildQuotaRecalcRows) {
        try {
          const leaders = [];
          // 帶隊：期間內有活動互代申請的請假端（與面板帶隊近似；無面板時不排除）
          // 發放額度用面板 mutualLeadEmails；匯出從事件無帶隊名單 → 不排除，與「全校釋出」一致
          // 若畫面互代面板有勾帶隊，優先用該名單（與發放額度完全一致）
          try {
            if (mutualLeadEmails && mutualLeadEmails.value && mutualLeadEmails.value.length) {
              mutualLeadEmails.value.forEach((e) => {
                const em = String(e || '').toLowerCase();
                if (em) leaders.push(em);
              });
            }
          } catch (eL) { /* ignore */ }
          const rows = dac.buildQuotaRecalcRows({
            mode: 'add',
            teachers: teachersList.value || [],
            awayClasses,
            startDate,
            endDate,
            allSchedules: allSchedules.value || [],
            excludeEmails: leaders
          });
          // 輪值單 OO＝釋出堂數（節），非額度 0.5 單位
          demand = (rows || []).reduce((sum, r) => {
            if (!r || r.skipped) return sum;
            const slots = r.releasedSlots != null ? parseInt(r.releasedSlots, 10) : 0;
            if (slots > 0) return sum + slots;
            // 後備：若僅有額度 released（0.5／節）→ 還原堂數
            const earn = parseFloat(r.released) || 0;
            return sum + Math.round(earn / 0.5);
          }, 0);
        } catch (eRel) { /* ignore */ }
      }

      const res = await window.ExportActivityCover.exportWord({
        startDate,
        endDate,
        activityName,
        grade,
        requests: allReqs,
        demand,
        getTeacherName: (em) => getTeacherNameByEmail(em),
        onlyActivityFee: true
      });
      if (!res || !res.ok) {
        showToast((res && res.error) || '匯出失敗', 'warning');
        return;
      }
      if (res.warning) showToast(res.warning, 'info');
      const p8 = res.period8Count ? `，第8節附註 ${res.period8Count} 筆` : '';
      showToast(`已下載：${res.fileName}（釋出 ${res.demand}／扣額度安排 ${res.arranged}／尚有 ${res.remaining}${p8}）`, 'success');
    };

    // 段考監考表：與全校課表共用 schoolExportStart/End；標題在點匯出後再輸入
    // 預設標題依學期代號：114-1 → 114學年度第一學期；114-2 → 第二學期
    const buildDefaultInvigilationTitle = () => {
      const sid = String(currentSemester.value || '').trim();
      const m = sid.match(/^(\d{2,3})\s*[-_]?\s*([12])$/);
      let semesterPart = '';
      if (m) {
        const termZh = m[2] === '2' ? '第二' : '第一';
        semesterPart = m[1] + '學年度' + termZh + '學期';
      } else {
        const sem = (semestersList.value || []).find(s => s && s.id === sid);
        const name = sem && sem.name ? String(sem.name).trim() : '';
        // 學期名稱常見「114學年度第1學期」→ 正規成「第一／第二」
        if (name) {
          semesterPart = name
            .replace(/第\s*1\s*學期/, '第一學期')
            .replace(/第\s*2\s*學期/, '第二學期')
            .replace(/\s+/g, '');
        } else {
          semesterPart = sid || '本學期';
        }
      }
      return '臺北市立建成國民中學' + semesterPart + '第一次段考監考表';
    };
    const invigilationExportTitle = ref('');
    const ensureInvigilationExportReady = async () => {
      if (typeof window.ensureExcelJS === 'function') {
        await window.ensureExcelJS();
      }
      // 多份分發打 ZIP 用
      if (typeof window.ensureJSZip === 'function') {
        try { await window.ensureJSZip(); } catch (eZ) { /* 單份可不需 */ }
      }
      if (typeof window.ensureExportInvigilation === 'function') {
        await window.ensureExportInvigilation();
      }
      if (!window.ExportInvigilation || !window.ExportInvigilation.exportWorkbook) {
        throw new Error('監考表匯出模組尚未載入');
      }
      if (!(window.ExcelJS || (typeof ExcelJS !== 'undefined' && ExcelJS))) {
        throw new Error('ExcelJS 未載入（套版需要）');
      }
    };
    const exportInvigilationWorkbook = async () => {
      if (!isAdmin.value) {
        showToast('僅管理員可匯出監考表', 'warning');
        return;
      }
      if (!schoolExportStart.value || !schoolExportEnd.value) {
        showToast('請先選擇起迄日期', 'warning');
        return;
      }
      const defaultTitle = buildDefaultInvigilationTitle();
      const titleResult = await showConfirm(
        '將匯出「全校監考表 × 每人一份」。\n請確認或修改標題後按確認匯出。',
        '匯出監考表',
        {
          withNote: true,
          noteLabel: '監考表標題',
          notePlaceholder: defaultTitle,
          noteDefault: defaultTitle
        }
      );
      if (!titleResult || !titleResult.ok) return;
      const title = (titleResult.note || '').trim() || defaultTitle;
      invigilationExportTitle.value = title;

      try {
        await ensureInvigilationExportReady();
      } catch (e) {
        showToast('匯出模組載入失敗：' + (e && e.message ? e.message : e), 'error');
        return;
      }
      // 全校表內容＝全體教師；分發份數＝下方勾選（少勾可大幅加速）
      const teachers = (teachersList.value || []).filter(t => t && t.email);
      if (!teachers.length) {
        showToast('尚無教師名單', 'warning');
        return;
      }
      const selectedSet = {};
      (schoolExportSelectedEmails.value || []).forEach(e => {
        selectedSet[String(e || '').toLowerCase()] = 1;
      });
      let recipients = teachers.filter(t => selectedSet[String(t.email || '').toLowerCase()]);
      if (!recipients.length) {
        showToast('請在下方勾選要分發的教師（至少一位）', 'warning');
        return;
      }
      loading.value = true;
      loadingMessage.value = '產生監考表中…';
      try {
        // dayOfWeek：系統課表為 1=一…7=日；同時備援 Date.getDay()(0=日)
        const getCellFn = (email, dateStr, period, dayOfWeek) => {
          let cell = null;
          if (typeof getScheduleForDate === 'function') {
            cell = getScheduleForDate(email, dateStr, period, dayOfWeek);
          } else if (typeof getApprovedScheduleForDate === 'function') {
            cell = getApprovedScheduleForDate(email, dateStr, period, dayOfWeek);
          }
          // 若空，改試 JS getDay（0=日）再查一次
          if (!cell && dateStr) {
            const d = new Date(String(dateStr).replace(/-/g, '/') + (String(dateStr).indexOf('T') >= 0 ? '' : ''));
            const gd = !Number.isNaN(d.getTime()) ? d.getDay() : null;
            if (gd != null && gd !== dayOfWeek) {
              if (typeof getScheduleForDate === 'function') {
                cell = getScheduleForDate(email, dateStr, period, gd);
              } else if (typeof getApprovedScheduleForDate === 'function') {
                cell = getApprovedScheduleForDate(email, dateStr, period, gd);
              }
            }
          }
          // 仍空：直接掃基礎課表補巡堂（attr／班／科＝巡堂）
          if (!cell && Array.isArray(allSchedules.value)) {
            const em = String(email || '').toLowerCase();
            const p = parseInt(period, 10);
            const dow = parseInt(dayOfWeek, 10);
            const hit = allSchedules.value.find((s) => {
              if (!s || String(s.teacherEmail || '').toLowerCase() !== em) return false;
               if (parseInt(s.period, 10) !== p) return false;
               if (parseInt(s.dayOfWeek, 10) !== dow) return false;
               if (window.DomainSchedule && window.DomainSchedule.isActiveOnDate
                   && !window.DomainSchedule.isActiveOnDate(s, dateStr)) return false;
               const a = String(s.attr || '').trim();
              const cn = String(s.className || '').trim();
              const sub = String(s.subject || '').trim();
              return a === '巡堂' || a.indexOf('巡堂') >= 0 || cn === '巡堂' || sub === '巡堂';
            });
            if (hit) {
              cell = {
                className: '巡堂',
                subject: '巡堂',
                attr: '巡堂',
                isPatrol: true,
                teacherEmail: email,
                dayOfWeek: dayOfWeek,
                period: period
              };
            }
          }
          return cell;
        };
        const res = await window.ExportInvigilation.exportWorkbook({
          title: title,
          startDate: schoolExportStart.value,
          endDate: schoolExportEnd.value,
          teachers: teachers,
          recipients: recipients,
          getCell: getCellFn,
          requests: requestsList.value || [],
          allSchedules: allSchedules.value || [],
          onProgress: (p) => {
            if (p && p.message) loadingMessage.value = p.message;
          }
        });
        if (!res || !res.ok) {
          showToast((res && res.error) || '匯出失敗', 'warning');
          return;
        }
        if (res.warning) showToast(res.warning, 'info');
        showToast(
          '已下載：' + res.fileName
          + '（表內全校 ' + res.teacherCount + ' 人 × 分發 ' + res.copyCount + ' 份 × '
          + res.dayCount + ' 日；異動 '
          + (res.changedMarked != null ? res.changedMarked : '?')
          + ' 格、基礎巡堂 '
          + (res.patrolCount != null ? res.patrolCount : '?') + ' 格）',
          'success'
        );
      } catch (err) {
        console.error(err);
        showToast('監考表匯出失敗：' + (err && err.message ? err.message : err), 'error');
      } finally {
        loading.value = false;
      }
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

    // 產生學校原版代（調、補）課請示單 HTML
    // ── 橋接外部印表模組 (已抽離至 print-helper.js) ─────────────────────
    const generateFormHtml = (g, currentType) => {
      if (typeof window.generateFormHtml !== 'function') {
        showToast('列印模組載入中，請稍候再試', 'warning');
        return '';
      }
      return window.generateFormHtml(g, currentType, {
        getTeacherNameByEmail,
        getTeacherSubjectByEmail,
        getTeacherJobTitleByEmail,
        getWeekDayText,
        showToast,
        allSchedules,
        isAdmin: isAdmin.value,
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
    const createPrintContext = (printWin = null, printOptions = {}) => ({
      selectedRecordIds,
      substitutionRecords,
      requestsList,
      callGasApi,
      markLocalPrinted,
      getTeacherNameByEmail,
      getTeacherSubjectByEmail,
      getTeacherJobTitleByEmail,
      getWeekDayText,
      showToast,
      loading,
      isAdmin: isAdmin.value,
      loadingMessage,
      allSchedules,
      getScheduleForDate,
      printWin,
      printRecords: Array.isArray(printOptions.records) ? printOptions.records : null,
      skipMarkPrinted: !!printOptions.skipMarkPrinted
    });
    const ensureExportReady = async () => {
      if (typeof window.ensureExportSchoolTimetable === 'function') {
        await window.ensureExportSchoolTimetable();
      }
      if (!window.ExportSchoolTimetable) {
        throw new Error('課表匯出模組尚未載入');
      }
    };

    /** 歷史紀錄：批次後發通知信（依受邀人合併；寄前同步 DOM 勾選） */
    const sendSelectedBatchNotices = async () => {
      if (!isAdmin.value) {
        showToast('僅管理員可批次發通知', 'warning');
        return;
      }
      if (notificationsSuppressed.value) {
        showToast('目前為紙本模式，不寄送通知信', 'info');
        return;
      }
      // 與列印相同：勾選可能只在 DOM，先同步再取 id
      try {
        if (typeof syncHistorySelectionFromDom === 'function') syncHistorySelectionFromDom();
        else {
          const domIds = [];
          document.querySelectorAll('.hist-select-cb:checked').forEach((el) => {
            const id = el.getAttribute('data-rec-id') || el.value;
            if (id) domIds.push(id);
          });
          if (domIds.length) selectedRecordIds.value = domIds;
        }
      } catch (eSync) { /* ignore */ }
      const ids = (selectedRecordIds.value || []).slice();
      if (!ids.length) {
        showToast('請先勾選歷史紀錄', 'warning');
        return;
      }
      // 轉成申請單 ID（調課 id 可能為 xxx_1 / xxx_2；每筆申請只算一次）
      const requestIds = [...new Set(ids.map(id => {
        const rec = (substitutionRecords.value || []).find(r => r && r.id === id);
        if (rec && rec.requestId) return String(rec.requestId);
        return String(id || '').replace(/_[12]$/, '');
      }).filter(Boolean))];
      if (!requestIds.length) {
        showToast('無法解析申請單 ID', 'warning');
        return;
      }
      // 預覽：核准信寄雙方（申請人＋受邀人）；邀請信只寄受邀人。同人合併後計「約幾封」
      const recipientMap = {}; // email -> { name, roles: Set, n }
      let approvedN = 0;
      let pendingN = 0;
      const addRecipient = (email, name, role) => {
        const em = String(email || '').toLowerCase().trim();
        if (!em || em.indexOf('@') === -1) return;
        if (!recipientMap[em]) recipientMap[em] = { name: name || em, roles: {}, n: 0 };
        if (name && !recipientMap[em].name) recipientMap[em].name = name;
        recipientMap[em].roles[role] = true;
        recipientMap[em].n++;
      };
      requestIds.forEach(rid => {
        const req = (requestsList.value || []).find(r => r && String(r.id) === String(rid));
        const rec = !req ? (substitutionRecords.value || []).find(r =>
          r && (String(r.requestId) === String(rid) || String(r.id || '').replace(/_[12]$/, '') === String(rid))
        ) : null;
        const st = String((req && req.status) || (rec && rec.status) || 'approved').toLowerCase();
        const isApproved = !st || st === 'approved';
        const leaveEm = (req && req.requesterEmail) || (rec && rec.originalTeacherEmail) || '';
        const coverEm = (req && req.targetTeacherEmail) || (rec && rec.actualTeacherEmail) || '';
        const leaveName = (req && (req.requesterName || getTeacherNameByEmail(leaveEm)))
          || getTeacherNameByEmail(leaveEm) || leaveEm;
        const coverName = (req && (req.targetTeacherName || getTeacherNameByEmail(coverEm)))
          || getTeacherNameByEmail(coverEm) || coverEm;
        if (isApproved) {
          approvedN++;
          addRecipient(leaveEm, leaveName, '申請人');
          addRecipient(coverEm, coverName, '受邀人');
        } else {
          pendingN++;
          addRecipient(coverEm, coverName, '受邀人');
        }
      });
      const recipients = Object.keys(recipientMap);
      const mailEst = recipients.length;
      const previewLines = recipients.slice(0, 12).map(em => {
        const g = recipientMap[em];
        const roles = Object.keys(g.roles || {}).join('／');
        return `• ${g.name}${roles ? '（' + roles + '）' : ''}`;
      });
      if (recipients.length > 12) previewLines.push(`…另有 ${recipients.length - 12} 人`);
      const typeTip = approvedN && pendingN
        ? `已核准 ${approvedN} 筆（雙方）＋待簽核 ${pendingN} 筆（僅受邀）`
        : approvedN
          ? `已核准 ${approvedN} 筆（核准信寄雙方）`
          : `待簽核 ${pendingN} 筆（僅寄受邀人）`;
      const ok = await showConfirm(
        `後發通知：${typeTip}\n共 ${requestIds.length} 筆申請 → 約 ${mailEst} 封信（同人合併）\n\n收件人：\n${previewLines.join('\n') || '（依後端）'}\n\n確定寄出？`,
        '批次發通知信'
      );
      if (!ok) return;
      loading.value = true;
      loadingMessage.value = '正在寄送通知…';
      try {
        const res = await callGasApi('sendBatchNotices', { requestIds });
        const mailCount = res && res.mailCount != null ? res.mailCount : mailEst;
        const failed = res && res.failed ? res.failed : 0;
        const found = res && res.found != null ? res.found : requestIds.length;
        showToast(
          failed
            ? `已處理 ${found} 筆，約寄 ${mailCount} 封，失敗 ${failed} 組`
            : `已處理 ${found} 筆申請，約寄出 ${mailCount} 封（雙方／同人合併）`,
          failed ? 'warning' : 'success'
        );
      } catch (e) {
        console.error(e);
        showToast('批次通知失敗：' + (e && e.message ? e.message : String(e)), 'error');
      } finally {
        loading.value = false;
      }
    };

    const printSelectedForms = async (formType, existingWin = null, printOptions = {}) => {
      const printWin = existingWin || window.open('', '_blank');
      try {
        await ensurePrintReady();
      } catch (e) {
        if (printWin) printWin.close();
        showToast('列印模組載入失敗，請重新整理後再試', 'error');
        return;
      }
      await window.printSelectedForms(formType, createPrintContext(printWin, printOptions));
    };

    const openPrintPreview = async (formType = 'Notice', options = {}) => {
      const opts = options || {};
      if (typeof window.buildPrintPreview !== 'function') {
        try {
          await ensurePrintReady();
        } catch (e) {
          showToast('列印模組載入失敗，請重新整理後再試', 'error');
          return false;
        }
      }
      if (typeof window.buildPrintPreview !== 'function') {
        showToast('列印預覽模組尚未載入，請重新整理後再試', 'error');
        return false;
      }

      if (loading.value) return false;
      loading.value = true;
      loadingMessage.value = '正在產生列印預覽…';
      try {
        const preview = window.buildPrintPreview(
          createPrintContext(null, { skipMarkPrinted: !!opts.skipMarkPrinted }),
          {
            records: Array.isArray(opts.records) ? opts.records : undefined,
            allSubs: Array.isArray(opts.allSubs) ? opts.allSubs : undefined
          }
        );
        if (!preview || !preview.records || !preview.records.length) {
          showToast('請先勾選歷史紀錄中要列印的單據！', 'warning');
          return false;
        }

        printPreview.value = Object.assign({}, preview, {
          formType,
          source: opts.source || 'selection',
          canPrint: opts.canPrint !== false,
          returnTo: opts.returnTo || '',
          skipMarkPrinted: !!opts.skipMarkPrinted,
          recordIds: (preview.recordIds || preview.records.map(r => String(r.id || ''))).filter(Boolean)
        });
        showPrintPreviewModal.value = true;
        return true;
      } catch (e) {
        console.error('產生列印預覽失敗：', e);
        showToast('產生列印預覽失敗：' + (e && e.message ? e.message : e), 'error');
        return false;
      } finally {
        loading.value = false;
      }
    };

    const closePrintPreview = (returnToSource = true) => {
      const returnTo = printPreview.value && printPreview.value.returnTo;
      showPrintPreviewModal.value = false;
      printPreview.value = null;
      printPreviewImageBusy.value = false;
      if (!returnToSource) return;
      if (returnTo === 'detail') showDetailModal.value = true;
      if (returnTo === 'compare') showCompareModal.value = true;
    };

    const confirmPrintPreview = async () => {
      const snapshot = printPreview.value;
      if (!snapshot) return;
      if (snapshot.canPrint === false) {
        showToast('調代課申請尚未送出，送出申請後才能列印。', 'warning');
        return;
      }
      if (snapshot.source === 'paperTour') {
        showToast('這是紙本流程教學示範，實際操作請在送出成功後點選「確認列印」。', 'info');
        return;
      }
      showPrintPreviewModal.value = false;
      printPreview.value = null;
      printPreviewImageBusy.value = false;

      if (snapshot.source === 'paperDraft') {
        await printPaperDraft();
        return;
      }

      selectedRecordIds.value = (snapshot.recordIds || []).slice();
      await printSelectedForms(snapshot.formType || 'Notice', null, {
        skipMarkPrinted: !!snapshot.skipMarkPrinted,
        records: snapshot.records || []
      });
    };

    const getPrintPreviewPngBlob = async () => {
      if (!printPreview.value || typeof window.buildPrintPreviewImageSvg !== 'function') {
        throw new Error('圖片預覽模組尚未載入');
      }
      const svg = window.buildPrintPreviewImageSvg(printPreview.value);
      if (!svg) throw new Error('沒有可轉出的預覽內容');
      // Blob URL 內含 foreignObject 時，Chrome 會把 canvas 標成 tainted；data URL 可保留同源圖片輸出能力。
      const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
      const image = new Image();
      image.decoding = 'async';
      await new Promise((resolve, reject) => {
        image.onload = resolve;
        image.onerror = () => reject(new Error('瀏覽器無法轉換預覽圖片'));
        image.src = url;
      });
      if (!image.naturalWidth || !image.naturalHeight) {
        throw new Error('預覽圖片尺寸無效');
      }

      let scale = 2;
      const maxDimension = 12000;
      const maxArea = 60000000;
      scale = Math.min(scale, maxDimension / image.naturalWidth, maxDimension / image.naturalHeight);
      scale = Math.min(scale, Math.sqrt(maxArea / (image.naturalWidth * image.naturalHeight)));
      scale = Math.max(1, scale);
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      const canvasContext = canvas.getContext('2d');
      if (!canvasContext) throw new Error('瀏覽器不支援圖片畫布');
      canvasContext.fillStyle = '#ffffff';
      canvasContext.fillRect(0, 0, canvas.width, canvas.height);
      canvasContext.drawImage(image, 0, 0, canvas.width, canvas.height);
      return await new Promise((resolve, reject) => {
        canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('圖片輸出失敗')), 'image/png');
      });
    };

    const getPrintPreviewFileName = () => {
      const stamp = new Date().toISOString().slice(0, 10);
      return '調代課單預覽-' + stamp + '.png';
    };

    const downloadPrintPreviewImage = async () => {
      if (printPreviewImageBusy.value) return;
      if (printPreview.value && printPreview.value.canPrint === false) {
        showToast('調代課申請尚未送出，送出申請後才能下載單據。', 'warning');
        return;
      }
      if (printPreview.value && printPreview.value.source === 'paperTour') {
        showToast('這是紙本流程教學示範，實際操作請在送出成功後下載單據。', 'info');
        return;
      }
      printPreviewImageBusy.value = true;
      try {
        const blob = await getPrintPreviewPngBlob();
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = getPrintPreviewFileName();
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 0);
        showToast('預覽圖片已下載', 'success');
      } catch (e) {
        console.error('下載預覽圖片失敗：', e);
        showToast('下載圖片失敗：' + (e && e.message ? e.message : e), 'warning');
      } finally {
        printPreviewImageBusy.value = false;
      }
    };

    const copyPrintPreviewImage = async () => {
      if (printPreviewImageBusy.value) return;
      if (printPreview.value && printPreview.value.canPrint === false) {
        showToast('調代課申請尚未送出，送出申請後才能複製單據。', 'warning');
        return;
      }
      if (printPreview.value && printPreview.value.source === 'paperTour') {
        showToast('這是紙本流程教學示範，實際操作請在送出成功後複製單據。', 'info');
        return;
      }
      if (!navigator.clipboard || typeof window.ClipboardItem !== 'function') {
        showToast('目前瀏覽器不支援複製圖片，請改用下載圖片', 'warning');
        return;
      }
      printPreviewImageBusy.value = true;
      try {
        const blob = await getPrintPreviewPngBlob();
        await navigator.clipboard.write([new window.ClipboardItem({ 'image/png': blob })]);
        showToast('預覽圖片已複製，可直接貼到文件或訊息', 'success');
      } catch (e) {
        console.error('複製預覽圖片失敗：', e);
        showToast('複製圖片失敗，請改用下載圖片', 'warning');
      } finally {
        printPreviewImageBusy.value = false;
      }
    };

    const decodePaperTimeKey = (timeKey) => {
      if (window.DateUtils && window.DateUtils.decodeTimeKey) {
        return window.DateUtils.decodeTimeKey(timeKey);
      }
      const raw = String(timeKey || '');
      return {
        day: parseInt(raw.split('-')[0], 10),
        period: parseInt(raw.split('-')[1] || raw.slice(-1), 10)
      };
    };

    const buildPaperDraftRecords = (meta = {}) => {
      const p = pendingRequestData.value || {};
      const root = meta.requestId || ('PAPER' + Date.now());
      const serialRoot = meta.serial || root;
      const combinedReturn = isCombinedReturnRequest(p);
      const courseAdjustmentOnly = !combinedReturn && !!p.courseAdjustmentOnly;
      const common = {
        type: p.mode || 'substitution',
        reason: p.reason || '請假',
        subFee: combinedReturn
          ? (typeof defaultSubFeeForReason === 'function'
            ? defaultSubFeeForReason(p.reason)
            : (p.subFee || '自費代課'))
          : (p.subFee || '無'),
        note: p.note || '',
        printed: false,
        isPaperDraft: true,
        requestId: root,
        batchId: p.isBatch ? (meta.batchId || p.submitBatchId || root) : '',
        paperFlow: !!meta.submitted
      };
      if (p.isBatch) {
        return (batchSlots.value || []).map((slot, index) => {
          const subEmail = slot.subTeacherEmail || p.subTeacher || '';
          return Object.assign({}, common, {
            id: root + '-' + (index + 1),
            serial: serialRoot + '-' + (index + 1),
            originalTeacherEmail: slot.teacherEmail,
            actualTeacherEmail: subEmail,
            date: slot.dateStr,
            period: slot.period,
            className: slot.className,
            subject: slot.subject,
             leaveTimeType: courseAdjustmentOnly ? '' : (p.leaveTimeType || ''),
             leaveTime: courseAdjustmentOnly ? '' : (p.leaveTime || '')
          });
        }).filter(r => r.originalTeacherEmail && r.actualTeacherEmail && r.date);
      }
      if (p.mode === 'exchange') {
        const timeA = decodePaperTimeKey(p.timeKey);
        const timeB = decodePaperTimeKey(p.timeB);
        return [
          Object.assign({}, common, {
             id: root + '_1',
             serial: serialRoot,
             originalTeacherEmail: p.subTeacher,
             actualTeacherEmail: p.leaveTeacher,
             originalTeacherName: getTeacherNameByEmail(p.subTeacher),
             actualTeacherName: getTeacherNameByEmail(p.leaveTeacher),
             date: p.dateB,
             period: timeB.period,
              className: p.subBClass || p.cls,
              subject: p.subB || p.subject
          }),
          Object.assign({}, common, {
             id: root + '_2',
             serial: serialRoot,
             originalTeacherEmail: p.leaveTeacher,
             actualTeacherEmail: p.subTeacher,
             originalTeacherName: getTeacherNameByEmail(p.leaveTeacher),
             actualTeacherName: getTeacherNameByEmail(p.subTeacher),
             date: p.date,
             period: timeA.period,
              className: p.cls || p.subBClass,
              subject: p.subject || p.subB
          })
        ].filter(r => r.originalTeacherEmail && r.actualTeacherEmail && r.date && r.period != null);
      }
      return [Object.assign({}, common, {
        id: root,
        serial: serialRoot,
        originalTeacherEmail: p.leaveTeacher,
         actualTeacherEmail: p.subTeacher,
        date: p.date,
        period: decodePaperTimeKey(p.timeKey).period,
        className: p.cls,
        subject: p.subject,
        specialFlow: p.specialFlow || '',
         leaveTimeType: courseAdjustmentOnly ? '' : (p.leaveTimeType || ''),
         leaveTime: courseAdjustmentOnly ? '' : (p.leaveTime || '')
      })].filter(r => r.originalTeacherEmail && r.actualTeacherEmail && r.date && r.period != null);
    };

    const buildPaperRecordsForSubmittedRequests = (requests) => {
      const sourceRows = Array.isArray(requests) ? requests : (requests ? [requests] : []);
      const resolvePaperTeacher = (value) => {
        const raw = String(value || '').trim();
        if (!raw) return '';
        const key = raw.toLowerCase();
        const hit = (teachersList.value || []).find(t => [t.loginEmail, t.email, t.teacherName, t.name]
          .filter(Boolean)
          .some(v => String(v).trim().toLowerCase() === key));
        return hit ? (hit.loginEmail || hit.email || hit.teacherName || hit.name || raw) : raw;
      };
      const getValue = (source, names, fallback = '') => {
        for (const name of names) {
          if (source[name] !== undefined && source[name] !== null && String(source[name]).trim() !== '') {
            return source[name];
          }
        }
        return fallback;
      };
      const resolveSubmittedTargetCourse = (source, targetDate, targetPeriod) => {
        const targetEmail = getValue(source, ['受邀人Email', 'targetTeacherEmail', '受邀人姓名', 'targetTeacherName']);
        const targetDay = getValue(source, ['對調目標星期', 'targetDayOfWeek']);
        let cell = null;
        if (targetEmail && targetPeriod != null && targetPeriod !== '' && typeof resolveExchangeTargetCell === 'function') {
          try {
            cell = resolveExchangeTargetCell(targetEmail, targetDate, targetPeriod, targetDay);
          } catch (e) { /* 課表尚未就緒時改用基礎課表 */ }
        }
        if (cell && (cell.isPending || String(cell.className || '').trim() === '(pending)')) cell = null;
        if (!cell && targetEmail && targetPeriod != null && targetPeriod !== '' && typeof findBaseScheduleSlot === 'function') {
          try {
            let day = targetDay;
            if ((day == null || day === '') && targetDate) {
              const date = new Date(String(targetDate).replace(/-/g, '/'));
              if (!Number.isNaN(date.getTime())) day = date.getDay() === 0 ? 7 : date.getDay();
            }
            cell = findBaseScheduleSlot(targetEmail, day, targetPeriod, targetDate);
          } catch (e2) { /* 課表尚未就緒 */ }
        }
        return cell || {};
      };
      const records = [];
      sourceRows.forEach((source, index) => {
        const requestId = String(getValue(source, ['申請單ID', 'id'], 'paper-' + Date.now() + '-' + index));
        const serial = getValue(source, ['單號', 'serial'], requestId);
        const typeRaw = String(getValue(source, ['異動類型', 'type'], 'substitution')).toLowerCase();
        const isExchange = typeRaw === 'exchange' || typeRaw === '對調' || typeRaw === '調課';
        const original = resolvePaperTeacher(getValue(source, ['申請人Email', 'requesterEmail', '申請人姓名', 'requesterName']));
        const combinedReturn = isCombinedReturnRequest(source);
        const actual = resolvePaperTeacher(getValue(source, ['受邀人Email', 'targetTeacherEmail', '受邀人姓名', 'targetTeacherName']));
        const date = getValue(source, ['異動日期', 'requestDate', 'date']);
        const period = getValue(source, ['異動節次', 'requestPeriod', 'period']);
        const printedRaw = getValue(source, ['是否已印', 'printed']);
        const printed = printedRaw === true || String(printedRaw || '').trim().toLowerCase() === 'true' || String(printedRaw || '').trim() === '1' || String(printedRaw || '').trim() === '是';
        const isTriangle = typeRaw === 'triangle' || typeRaw === '三角調';
        const reasonValue = getValue(source, ['請假事由', 'reason'], '請假');
        const base = {
          reason: reasonValue,
          subFee: getValue(source, ['經費來源', 'subFee'], '自費代課'),
          note: getValue(source, ['備註', 'note']),
          printed: printed,
          isPaperDraft: true,
          paperFlow: true,
          requestId: requestId,
          serial: serial,
          batchId: getValue(source, ['批次ID', 'batchId'])
        };
        if (combinedReturn) {
          const isPublicReason = /公假|公差|婚假|喪假|產前|分娩|身心調適/.test(String(reasonValue || '').trim());
          base.subFee = Number(period) === 8
            ? '第8節代課'
            : (isPublicReason ? '公費代課' : '自費代課');
        }
        if (isTriangle) {
           const targetDate = getValue(source, ['對調目標日期', 'targetDate']);
           const targetDay = getValue(source, ['對調目標星期', 'targetDayOfWeek']);
           const targetPeriod = getValue(source, ['對調目標節次', 'targetPeriod']);
           const initiatorName = getValue(source, ['申請人姓名', 'requesterName'], getTeacherNameByEmail(original));
           const sourceDay = getValue(source, ['異動星期', 'requestPeriodDay']);
           const sourceClass = getValue(source, ['班級', 'className']);
           const sourceSubject = getValue(source, ['科目', 'subject']);
           records.push(Object.assign({}, base, {
            id: requestId,
            type: 'triangle',
            triangleId: getValue(source, ['三角調ID', 'triangleId', '批次ID', 'batchId']),
            triangleLegIndex: getValue(source, ['三角腳次', 'triangleLegIndex']),
             originalTeacherEmail: actual,
             actualTeacherEmail: original,
             originalTeacherName: getTeacherNameByEmail(actual),
             actualTeacherName: getTeacherNameByEmail(original),
             triangleInitiatorEmail: original,
             triangleInitiatorName: initiatorName,
             triangleSourceDate: date,
             triangleSourceDayOfWeek: sourceDay,
             triangleSourcePeriod: period,
             triangleTargetDate: targetDate,
             triangleTargetDayOfWeek: targetDay,
             triangleTargetPeriod: targetPeriod,
             date,
             period,
             className: sourceClass,
             subject: sourceSubject,
            formClassName: sourceClass,
            formSubject: sourceSubject
          }));
        } else if (isExchange) {
          const targetDate = getValue(source, ['對調目標日期', 'targetDate']);
          const targetPeriod = getValue(source, ['對調目標節次', 'targetPeriod']);
          const targetCourse = resolveSubmittedTargetCourse(source, targetDate, targetPeriod);
          const targetClass = getValue(source, ['對調目標班級', 'targetClassName'], targetCourse.className || getValue(source, ['班級', 'className']));
          const targetSubject = getValue(source, ['對調目標科目', 'targetSubject'], targetCourse.subject || getValue(source, ['科目', 'subject']));
          records.push(Object.assign({}, base, {
            id: requestId + '_1',
            type: 'exchange',
             originalTeacherEmail: actual,
             actualTeacherEmail: original,
             originalTeacherName: getTeacherNameByEmail(actual),
             actualTeacherName: getTeacherNameByEmail(original),
             date: targetDate,
            period: targetPeriod,
             className: targetClass,
             subject: targetSubject
          }));
          records.push(Object.assign({}, base, {
            id: requestId + '_2',
            type: 'exchange',
             originalTeacherEmail: original,
             actualTeacherEmail: actual,
             originalTeacherName: getTeacherNameByEmail(original),
             actualTeacherName: getTeacherNameByEmail(actual),
             date: date,
            period: period,
             className: getValue(source, ['班級', 'className']),
             subject: getValue(source, ['科目', 'subject'])
          }));
        } else {
          records.push(Object.assign({}, base, {
            id: requestId,
            type: 'substitution',
            originalTeacherEmail: original,
            actualTeacherEmail: actual,
            date: date,
            period: period,
            className: getValue(source, ['班級', 'className']),
            subject: getValue(source, ['科目', 'subject']),
            specialFlow: combinedReturn ? 'combined_return' : '',
            leaveTimeType: getValue(source, ['請假時間類型', 'leaveTimeType']),
            leaveTime: getValue(source, ['請假時間', 'leaveTime', 'timeRange'])
          }));
        }
      });
      return records.filter(r => r.originalTeacherEmail && r.actualTeacherEmail && r.date && r.period != null);
    };

    const buildTrianglePaperDraftRecords = () => {
      const participants = triangleParticipants.value || [];
      const legs = triangleLegs.value || [];
      if (participants.length !== 3 || legs.length !== 3 || participants.some(participant => !participant)) return [];
      const requestId = 'TRI-PREVIEW-' + Date.now();
      const serial = requestId;
      return legs.map((leg, index) => {
        const source = participants[index];
        const target = participants[(index + 1) % participants.length];
        return {
          id: `${requestId}_${index + 1}`,
          requestId,
          triangleId: requestId,
          triangleLegIndex: index + 1,
          serial,
          type: 'triangle',
          reason: triangleReason.value || '請假',
          subFee: '無',
          note: triangleNote.value || '',
          isPaperDraft: true,
          printed: false,
          originalTeacherEmail: target.email,
          originalTeacherName: target.teacherName,
          actualTeacherEmail: source.email,
          actualTeacherName: source.teacherName,
          triangleInitiatorEmail: participants[0].email,
          triangleInitiatorName: participants[0].teacherName,
          triangleSourceDate: leg.sourceSlot.date,
          triangleSourceDayOfWeek: leg.sourceSlot.day,
          triangleSourcePeriod: leg.sourceSlot.period,
          triangleTargetDate: leg.targetSlot.date,
          triangleTargetDayOfWeek: leg.targetSlot.day,
          triangleTargetPeriod: leg.targetSlot.period,
          date: leg.sourceSlot.date,
          period: leg.sourceSlot.period,
          className: source.course.className,
          subject: source.course.subject,
          formClassName: source.course.className,
          formSubject: source.course.subject
        };
      });
    };

    const openPaperPrintDraft = (records, options = {}) => {
      const list = records || buildPaperDraftRecords();
      if (!list.length) {
        showToast('請先完成媒合模擬並選擇代課／調課教師', 'warning');
        return false;
      }
       const signatureMap = {};
       list.forEach(r => {
         [r.actualTeacherEmail, r.originalTeacherEmail].forEach(email => {
           const name = String(getTeacherNameByEmail(email) || email || '').trim();
           if (name) signatureMap[name.toLowerCase()] = isAdmin.value ? name : '';
         });
       });
      paperPrintDraft.value = {
        records: list,
        returnTo: options.returnTo || '',
        canPrint: options.canPrint === true,
        source: options.source || 'paperDraft'
      };
      paperSignatureByTeacher.value = signatureMap;
      return openPaperDraftPreview();
    };

    const openPaperPrintDraftForSubmittedRequests = (requests) =>
      openPaperPrintDraft(buildPaperRecordsForSubmittedRequests(requests), { canPrint: true });

    const openPaperPrintForRequest = (request) => {
      if (!request) return false;
      const batchId = String(request.batchId || '').trim();
      const requestPaperFlow = isPaperFlowRequest(request);
      const rows = batchId
        ? (requestsList.value || []).filter(r => r && isPaperFlowRequest(r) === requestPaperFlow && String(r.batchId || '').trim() === batchId)
        : [];
      return openPaperPrintDraftForSubmittedRequests(rows.length ? rows : [request]);
    };

    const openPaperPrintDraftFromCompare = () => openPaperPrintDraft(null, { returnTo: 'compare', canPrint: false });

    const openTrianglePaperPreview = () => {
      if (!triangleReady.value) {
        showToast('請先選定可完成的 B、C，才能預覽調課單', 'warning');
        return false;
      }
      const records = buildTrianglePaperDraftRecords();
      if (!records.length) {
        showToast('目前沒有可預覽的三角調課單', 'warning');
        return false;
      }
      showTriangleTimetablePreview.value = false;
      return openPaperPrintDraft(records, { canPrint: false, source: 'triangleDraft' });
    };

    const openPaperPrintMutualDrafts = () => {
      const root = 'PAPER-MUTUAL-' + Date.now();
      const records = (mutualDrafts.value || []).map((d, index) => ({
        id: root + '-' + index,
        serial: root,
        requestId: root,
        type: 'substitution',
        originalTeacherEmail: d.leaveEmail,
        actualTeacherEmail: d.subEmail,
        date: d.dateStr,
        period: d.period,
        className: d.className,
        subject: d.subject,
        subFee: d.fee || '活動公費',
        reason: '公假',
        note: d.note || mutualNote.value || '',
        isPaperDraft: true,
        printed: false
      }));
      return openPaperPrintDraft(records, { canPrint: false });
    };

    const printPaperDraft = async () => {
      const draft = paperPrintDraft.value;
      if (!draft || !draft.records || !draft.records.length) return;
      if (draft.source === 'paperTour') {
        showToast('這是紙本流程教學示範，未建立真實申請單。', 'info');
        return;
      }
      if (draft.canPrint !== true) {
        showToast('調代課申請尚未送出，送出申請後才能列印。', 'warning');
        return;
      }
      const signatureMap = isAdmin.value ? Object.assign({}, paperSignatureByTeacher.value) : {};
      const ids = draft.records.map((r, index) => String(r.id || ('paper-' + Date.now() + '-' + index)));
      const records = draft.records.map((r, index) => Object.assign({}, r, {
        id: ids[index],
        signatureByTeacher: signatureMap
      }));
      const previous = substitutionRecords.value;
      substitutionRecords.value = previous.concat(records);
      selectedRecordIds.value = ids.slice();
      try {
        await printSelectedForms('Notice', null, { skipMarkPrinted: true, records });
      } finally {
        substitutionRecords.value = previous;
        selectedRecordIds.value = [];
        paperPrintDraft.value = null;
        paperSignatureByTeacher.value = {};
      }
    };

    const openPaperDraftPreview = async () => {
      const draft = paperPrintDraft.value;
      if (!draft || !draft.records || !draft.records.length) {
        showToast('目前沒有可預覽的紙本單據', 'warning');
        return false;
      }
      const signatureMap = isAdmin.value ? Object.assign({}, paperSignatureByTeacher.value) : {};
      const records = draft.records.map((record, index) => Object.assign({}, record, {
        id: String(record.id || ('paper-preview-' + Date.now() + '-' + index)),
        signatureByTeacher: signatureMap
      }));
      return openPrintPreview('Notice', {
        records,
        allSubs: (substitutionRecords.value || []).concat(records),
        source: draft.source || 'paperDraft',
        canPrint: draft.canPrint === true,
        returnTo: draft.returnTo || '',
        skipMarkPrinted: true
      });
    };

    const openSuccessPrintPreview = () => {
      const requests = (successActionRequests.value || []).filter(Boolean);
      if (!requests.length) {
        showToast('目前沒有可列印的申請單', 'warning');
        return false;
      }
      showSuccessModal.value = false;
      return openPaperPrintDraftForSubmittedRequests(requests);
    };

    const addSuccessToCalendar = () => {
      const request = (successActionRequests.value || [])[0];
      if (!request) {
        showToast('目前沒有可加入行事曆的申請單', 'warning');
        return;
      }
      addEventToCalendar(request);
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
        showToast('巡堂節不需系統調代課或三角調，請私下安排代巡', 'info');
        matchMode.value = 'substitution';
        clearMatchPreview();
        return;
      }
      if (mode !== matchMode.value) matchSearchQuery.value = '';
      if (mode === 'triangle') {
        const source = activeCell.value || {};
        if (!source.classData || !triangleCellIsUsable(source.classData)) {
          showToast('三角調只能從尚未異動的有效一般課程開始', 'warning');
          return;
        }
        matchMode.value = 'triangle';
        clearMatchPreview();
        resetTriangleDraft();
        return;
      }
      // 抽離：可調課，但僅限與另一節抽離互調（候選列表已過濾；此處提示）
      if (mode === 'exchange' && activeCell.value && activeCell.value.classData &&
          (activeCell.value.classData.isPullOut || activeCell.value.classData.attr === '抽離')) {
        const tip = (window.DomainSchedule && window.DomainSchedule.PULL_OUT_EXCHANGE_TIP)
          || '抽離課僅可與另一節「抽離」互調，不可與一般課調課。';
        showToast(tip, 'info', 4500);
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
      if (mode === 'exchange' && matchMode.value !== 'exchange') {
        exchangeWeekdayFilter.value = 0;
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

    // P4：name/loginEmail → teacher O(1) lookup.
    const teachersByEmail = computed(() => {
      const map = Object.create(null);
      (teachersList.value || []).forEach(t => {
        if (!t) return;
        [t.teacherName || t.name, t.loginEmail].filter(Boolean).forEach(rawValue => {
          const raw = String(rawValue);
          map[raw] = t;
          const low = raw.toLowerCase();
          if (low !== raw) map[low] = t;
        });
      });
      return map;
    });
    const lookupTeacher = (email) => {
      if (!email) return null;
      const m = teachersByEmail.value;
      const key = String(email).trim();
      return m[key] || m[key.toLowerCase()] || null;
    };

    const getTeacherNameByEmail = (email) => {
      if (!email) return '';
      const t = lookupTeacher(email);
      return t ? t.name : String(email).split('@')[0];
    };

    const getTeacherSubjectByEmail = (email) => {
      if (!email) return '';
      const t = lookupTeacher(email);
      return t ? (t.subject || t['授課科目'] || t['任課科目'] || '') : '';
    };

    // 與排課系統教師課表一致：基本鐘點取教師設定，超鐘點取本週正式排課差額。
    const teacherTimetableHours = computed(() => {
      const map = Object.create(null);
      (teachersList.value || []).forEach(teacher => {
        const basicHours = teacher.baseHours === 0 || teacher.baseHours === '0'
          ? 0
          : (parseInt(teacher.baseHours, 10) || 16);
        const scheduledHours = window.DomainSchedule && typeof window.DomainSchedule.countTeacherFormalScheduleHours === 'function'
          ? window.DomainSchedule.countTeacherFormalScheduleHours(teacher, allSchedules.value, currentWeekDates.value)
          : 0;
        const summary = {
          basicHours,
          overtimeHours: Math.max(0, scheduledHours - basicHours)
        };
        [teacher.email, teacher.loginEmail, teacher.teacherEmail, teacher.teacherName, teacher.name]
          .filter(Boolean)
          .forEach(key => {
            map[String(key).trim().toLowerCase()] = summary;
          });
      });
      return map;
    });
    const getTeacherTimetableHours = (teacher) => {
      const map = teacherTimetableHours.value || {};
      const keys = [teacher && teacher.email, teacher && teacher.loginEmail, teacher && teacher.teacherName, teacher && teacher.name]
        .filter(Boolean)
        .map(key => String(key).trim().toLowerCase());
      for (const key of keys) {
        if (map[key]) return map[key];
      }
      return { basicHours: 0, overtimeHours: 0 };
    };

    const getTeacherJobTitleByEmail = (email) => {
      if (!email) return '';
      const t = lookupTeacher(email);
      return t ? (t.jobTitle || t.job || '') : '';
    };
    const chineseClassNumber = (raw) => {
      const value = String(raw || '').trim();
      if (/^\d+$/.test(value)) return parseInt(value, 10);
      if (value === '十') return 10;
      if (value.startsWith('十')) return 10 + parseInt(({ 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }[value.slice(1)] || ''), 10);
      return ({ 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }[value] || 0);
    };
    const getHomeroomClassCodes = (value) => {
      const raw = String(value || '').replace(/\s+/g, '');
      if (!raw) return [];
      const codes = new Set((raw.match(/[789]\d{2}/g) || []));
      const namedClasses = raw.match(/[789七八九]年(?:級)?[0-9一二三四五六七八九十]+班/g) || [];
      namedClasses.forEach(named => {
        const match = named.match(/^([789七八九])年(?:級)?([0-9一二三四五六七八九十]+)班$/);
        if (!match) return;
        const grade = ({ 七: '7', 八: '8', 九: '9' }[match[1]] || match[1]);
        const classNumber = chineseClassNumber(match[2]);
        if (classNumber > 0) codes.add(grade + String(classNumber).padStart(2, '0'));
      });
      return Array.from(codes);
    };
    const isHomeroomTeacher = (teacher, className) => {
      const targetClass = className || (activeCell.value && activeCell.value.classData && activeCell.value.classData.className);
      if (!teacher || !targetClass) return false;
      const directTitle = teacher.jobTitle || teacher.job || teacher['職務'] || '';
      const title = String(directTitle || getTeacherJobTitleByEmail(
        teacher.loginEmail || teacher.email || teacher.teacherName || teacher.name
      ) || '').trim();
      if (!title.includes('導師')) return false;
      const targetCodes = getHomeroomClassCodes(targetClass);
      if (!targetCodes.length) return false;
      const teacherCodes = getHomeroomClassCodes(title);
      return targetCodes.some(code => teacherCodes.includes(code));
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

    // 100% 複製排課系統 (scheduling-system) 的 11 大領域官方色票
    const SUBJECT_COLOR_GROUPS = [
      { key: 'chinese', label: '國文', aliases: ['國文', '國語文', '國語'], color: { bg: '#dbeafe', text: '#1e3a8a' } },
      { key: 'english', label: '英語', aliases: ['英語', '英文', '英語文'], color: { bg: '#dcfce7', text: '#166534' } },
      { key: 'local', label: '本土語', aliases: ['本土語', '本土語文', '閩南語', '台語', '臺語', '客語', '原住民族語', '族語'], color: { bg: '#ccfbf1', text: '#115e59' } },
      { key: 'math', label: '數學', aliases: ['數學'], color: { bg: '#fef3c7', text: '#92400e' } },
      { key: 'science', label: '自然、理化、生物', aliases: ['自然', '自然科', '自然科學', '理化', '物理', '化學', '生物', '地球科學'], color: { bg: '#e0f2fe', text: '#075985' } },
      { key: 'social', label: '地理、歷史、公民', aliases: ['地理', '歷史', '公民', '公民與社會', '社會'], color: { bg: '#ede9fe', text: '#5b21b6' } },
      { key: 'health', label: '體育、健康教育', aliases: ['體育', '健康教育', '健康與體育', '健康'], color: { bg: '#ffedd5', text: '#9a3412' } },
      { key: 'comprehensive', label: '家政、童軍、輔導', aliases: ['家政', '童軍', '輔導', '課輔', '綜合活動', '綜合'], color: { bg: '#fce7f3', text: '#9d174d' } },
      { key: 'technology', label: '生活科技、資訊科技', aliases: ['生活科技', '資訊科技', '資訊', '電腦', '科技'], color: { bg: '#e0e7ff', text: '#3730a3' } },
      { key: 'arts', label: '表演藝術、視覺藝術、音樂', aliases: ['表演藝術', '視覺藝術', '音樂', '藝術', '視覺藝'], color: { bg: '#fae8ff', text: '#86198f' } },
      { key: 'other', label: '其他彈性課程', aliases: ['其他彈性課程', '彈性課程', '彈性', '班週會', '週會', '班會', '社團', '閱讀', '閱讀課', '校訂課程'], color: { bg: '#f1f5f9', text: '#475569' } }
    ];

    const normalizeSubjectColorName = (value) => {
      return String(value || '').trim().replace(/\s+/g, '').replace(/[（(]輔[）)]/gi, '');
    };

    const getSubjectStyle = (subCode) => {
      if (!subCode) return {};
      const normalized = normalizeSubjectColorName(subCode);
      const group = SUBJECT_COLOR_GROUPS.find(g => g.aliases.some(alias => {
        const candidate = normalizeSubjectColorName(alias);
        return normalized === candidate || normalized.startsWith(candidate);
      })) || SUBJECT_COLOR_GROUPS.find(g => g.key === 'other');
      
      return {
        backgroundColor: group.color.bg,
        color: group.color.text,
        border: 'none'
      };
    };

    const getClassBadgeStyle = (className) => {
      if (!className) return {};
      const cleanCls = String(className).trim();
      let hash = 0;
      for (let i = 0; i < cleanCls.length; i++) {
        hash = cleanCls.charCodeAt(i) + ((hash << 5) - hash);
      }
      const idx = Math.abs(hash) % SUBJECT_COLOR_GROUPS.length;
      const group = SUBJECT_COLOR_GROUPS[idx];
      return {
        backgroundColor: group.color.bg,
        color: group.color.text,
        border: 'none'
      };
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

    const isProxySubmitRequest = (r) => {
      if (!r) return false;
      if (r.isProxySubmit === true) return true;
      if (r.proxyByName) return true;
      const note = String(r.note || '');
      return note.indexOf('[行政代申請') >= 0;
    };

    const isTriangleRequest = (r) => !!(r && (r.type === 'triangle' || r.type === '三角調' || r.triangleId));
    const isExchangeLikeRequest = (r) => !!(r && (
      r.type === 'exchange' || r.type === '對調' || isTriangleRequest(r)
    ));
    const getTriangleGroupRequests = (request) => {
      if (!isTriangleRequest(request)) return request ? [request] : [];
      const triangleId = String(request.triangleId || request.batchId || '').trim();
      const rows = (requestsList.value || []).filter((row) => {
        if (!isTriangleRequest(row)) return false;
        return triangleId && String(row.triangleId || row.batchId || '').trim() === triangleId;
      });
      return (rows.length ? rows : [request]).slice().sort((a, b) =>
        (parseInt(a.triangleLegIndex, 10) || 0) - (parseInt(b.triangleLegIndex, 10) || 0)
      );
    };

    const isPaperFlowValue = (value) => {
      if (value === true || value === 1) return true;
      const normalized = String(value == null ? '' : value).trim().toLowerCase();
      return normalized === 'true' || normalized === '1' || normalized === '是' || normalized === '紙本';
    };

    /** 舊申請可能沒有紙本欄位；紙本作業期間的待處理單仍視為紙本流程。 */
    const isPaperFlowRequest = (request) => {
      if (!request) return false;
      if (isPaperFlowValue(request.paperFlow)) return true;
      // 紙本模式下，非代申請的待處理單仍應使用紙本通知格式。
      const pendingPaperStatus = request.status === 'pending_admin' || request.status === 'pending_teacher';
      if (notificationsSuppressed.value && pendingPaperStatus
          && !isProxySubmitRequest(request)) return true;
      if (request.paperFlowSpecified === true) return false;
      if (Object.prototype.hasOwnProperty.call(request, '紙本流程')) {
        return isPaperFlowValue(request['紙本流程']);
      }
      return !!(notificationsSuppressed.value && pendingPaperStatus && !isProxySubmitRequest(request));
    };

    /** 目前 UI 身分 Email（含模擬身份；列表／權限一律用此，不用 JWT 原帳） */
    const effectiveUserEmail = computed(() => {
      if (!user.value || !user.value.email) return '';
      return String(user.value.email).toLowerCase().trim();
    });

    /**
     * 是否為「我送出的申請」（email＝effectiveUserEmail，模擬時用被模擬者）
     * - 代申請：只有代申請人是我才算（請假人本人不進此列表）
     * - 一般：申請人是我，且不是別人代送
     */
    const isMySentRequest = (r, email) => {
      if (!r || !email) return false;
      if (isAdminDirectRequest(r)) return false;
      const me = String(email).toLowerCase().trim();
      const myName = String(getTeacherNameByEmail(me) || '').toLowerCase().trim();
      const reqName = String(r.requesterName || '').toLowerCase().trim();
      const proxyName = String(r.proxyByName || '').toLowerCase().trim();
      const note = String(r.note || '');
      const noteIsProxy = note.indexOf('[行政代申請') >= 0;
      // 只要有代申請跡象：絕不能用「請假人＝我」混進來
      if (proxyName || noteIsProxy || r.isProxySubmit === true) {
        if (proxyName) return proxyName === myName;
        // 無代申請人 Email 欄時：用備註姓名對 lookup（模擬 displayName 去「(模擬)」）
        const m = note.match(/\[行政代申請[：:]\s*([^代\]]+?)\s*代/);
        if (m) {
          const proxyName = String(m[1] || '').trim();
           const noteMyName = String(getTeacherNameByEmail(me) || '')
            .trim()
            .replace(/\s*\(模擬\)\s*$/, '');
          const disp = String((user.value && user.value.displayName) || '')
            .trim()
            .replace(/\s*\(模擬\)\s*$/, '');
           if (proxyName && (proxyName === noteMyName || proxyName === disp)) return true;
        }
        return false;
      }
      return reqName === myName;
    };

    const applyInitialPayload = (res) => {
      if (!res) return;
      if (res.userRole && ['admin', 'staff', 'teacher'].includes(String(res.userRole))) {
        userRole.value = String(res.userRole);
      }
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
      if (Array.isArray(res.classNames)) {
        classDirectory.value = res.classNames.map(c => String(c || '').trim()).filter(Boolean);
      }
      if (res.schedules) {
        allSchedules.value = res.schedules.map(s => window.FieldMap.mapSchedule(s));
      }
      if (Array.isArray(res.schoolSwaps)) {
        schoolSwaps.value = res.schoolSwaps.map(s => window.FieldMap.mapSchoolSwap(s));
      }
      if (Array.isArray(res.homeroomRecords)) {
        homeroomRecords.value = res.homeroomRecords.map(r => window.FieldMap.mapHomeroomRecord(r));
      }
      if (res.requests) {
        const allRequests = res.requests.map(r => window.FieldMap.mapRequest(r));
        const sortedAll = sortRequestListDesc(allRequests);
        requestsList.value = sortedAll;
        // 關鍵：動態從 requestsList 轉換出 substitutionRecords（公開唯讀也需要）
        substitutionRecords.value = convertRequestsToSubstitutions(sortedAll);
        _approvedConvertSig = approvedConvertSig(sortedAll);
        bumpRequestsWatermarkFromRows(sortedAll);
        if (user.value) {
          // 模擬身份時用被模擬者 Email（user.value.email），不用 JWT 原帳
           const email = effectiveUserEmail.value || String(user.value.email || '').toLowerCase();
           const name = String(getTeacherNameByEmail(email) || '').toLowerCase();
           mySentRequests.value = sortedAll.filter(r => isMySentRequest(r, email));
           myPendingRequests.value = sortedAll.filter(r => r.targetTeacherName && r.targetTeacherName.toLowerCase() === name && r.status === 'pending_teacher');
          // 待核准僅教學組；模擬成行政／教師時清空，避免誤以為「我的送出」
          const stOf = (r) => (window.FieldMap && window.FieldMap.normalizeRequestStatus)
            ? window.FieldMap.normalizeRequestStatus(r && r.status)
            : String((r && r.status) || '').toLowerCase();
           adminPendingRequests.value = (userRole.value === 'admin')
             ? collapseTriangleRows(sortedAll.filter(r => stOf(r) === 'pending_admin'))
             : [];
          allPendingRequests.value = sortedAll.filter(r => {
            const s = stOf(r);
            return s === 'pending_teacher' || s === 'pending_admin';
          });
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
    const requestTimestampText = (value) => {
      if (value === undefined || value === null || value === '') return '';
      if (Object.prototype.toString.call(value) === '[object Date]' && !Number.isNaN(value.getTime())) {
        const y = value.getFullYear();
        const m = String(value.getMonth() + 1).padStart(2, '0');
        const d = String(value.getDate()).padStart(2, '0');
        const hh = String(value.getHours()).padStart(2, '0');
        const mm = String(value.getMinutes()).padStart(2, '0');
        const ss = String(value.getSeconds()).padStart(2, '0');
        return `${y}-${m}-${d} ${hh}:${mm}:${ss}`;
      }
      const text = String(value).trim();
      return /^(?:---|undefined|null)$/i.test(text) ? '' : text;
    };
    const firstRequestTimestamp = (request, fields) => {
      for (const field of fields) {
        const value = requestTimestampText(request && request[field]);
        if (value) return value;
      }
      return '';
    };
    const getRequestApplicationStamp = (request) => {
      const created = firstRequestTimestamp(request, [
        'createdAt', 'requestCreatedAt', '建立時間', '申請時間', '建立日期', '申請日期'
      ]);
      if (created) return created;
      const updated = firstRequestTimestamp(request, ['updatedAt', '更新時間', 'updated_at']);
      if (updated) return updated;
      return firstRequestTimestamp(request, ['createdDate', 'requestDate', '異動日期', 'date']);
    };
    const formatRequestApplicationDate = (request) => {
      const stamp = getRequestApplicationStamp(request);
      const match = String(stamp || '').replace(/\//g, '-').match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
      if (match) return `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`;
      return stamp ? String(stamp).slice(0, 10) : '---';
    };

    const serialRoot = (serial) => {
      const s = String(serial || '').trim();
      if (!s) return '';
      return s.replace(/-\d+$/, '') || s;
    };
    const parseTimeMs = (raw) => {
      const t = requestTimestampText(raw);
      if (!t) return 0;
      const direct = Date.parse(t);
      if (Number.isFinite(direct)) return direct;
      // 支援 "YYYY-MM-DD HH:mm:ss" / ISO / 僅日期；保留完整時分秒排序。
      const norm = t.replace('T', ' ').replace(/-/g, '/');
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
      return parseTimeMs(getRequestApplicationStamp(r));
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

    const collapseTriangleRows = (rows) => {
      const result = [];
      const seen = Object.create(null);
      (rows || []).forEach((row) => {
        if (!isTriangleRequest(row)) {
          result.push(row);
          return;
        }
        const key = String(row.triangleId || row.batchId || row.id || '');
        if (!key || seen[key]) return;
        seen[key] = true;
        result.push(row);
      });
      return result;
    };

    const recomputeRequestBuckets = () => {
      if (!user.value) return;
      // 模擬身份：一律用目前 user.value.email（被模擬者），勿用 originalUser／JWT
      const email = effectiveUserEmail.value || String(user.value.email || '').toLowerCase().trim();
      const name = String(getTeacherNameByEmail(email) || '').toLowerCase().trim();
      const all = sortRequestListDesc(requestsList.value || []);
      requestsList.value = all;
      const stOf = (r) => (window.FieldMap && window.FieldMap.normalizeRequestStatus)
        ? window.FieldMap.normalizeRequestStatus(r && r.status)
        : String((r && r.status) || '').toLowerCase();
      mySentRequests.value = all.filter(r => isMySentRequest(r, email));
      myPendingRequests.value = all.filter(r =>
        r.targetTeacherName && String(r.targetTeacherName).toLowerCase() === name
        && stOf(r) === 'pending_teacher'
      );
      adminPendingRequests.value = (userRole.value === 'admin')
        ? collapseTriangleRows(all.filter(r => stOf(r) === 'pending_admin'))
        : [];
      allPendingRequests.value = all.filter(r => {
        const s = stOf(r);
        return s === 'pending_teacher' || s === 'pending_admin';
      });

      // H5：已核准集合未變時略過 convert（pending 狀態變更最常見）
      const sig = approvedConvertSig(all);
      if (sig !== _approvedConvertSig) {
        substitutionRecords.value = convertRequestsToSubstitutions(all);
        _approvedConvertSig = sig;
        clearScheduleCache();
      }
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

    const optimisticPatchRequestStatuses = (updates) => {
      const statusById = Object.create(null);
      (updates || []).forEach(update => {
        if (!update || update.id == null) return;
        statusById[String(update.id)] = update.status;
      });
      if (!Object.keys(statusById).length) return false;
      let found = false;
      let changed = false;
      const next = requestsList.value.map(r => {
        const key = r && r.id != null ? String(r.id) : '';
        if (!Object.prototype.hasOwnProperty.call(statusById, key)) return r;
        found = true;
        const status = statusById[key];
        if (r.status === status) return r;
        changed = true;
        return Object.assign({}, r, { status });
      });
      if (!found) return false;
      if (!changed) return true;
      requestsList.value = next;
      // 批次狀態一次寫入，避免每筆都觸發列表與課表重算。
      recomputeRequestBuckets();
      return true;
    };

    const optimisticPatchRequestStatus = (id, status) => {
      return optimisticPatchRequestStatuses([{ id, status }]);
    };

    const optimisticPatchTriangleGroup = (request, groupStatus, responseStatus) => {
      if (!request) return false;
      const triangleId = String(request.triangleId || request.batchId || '').trim();
      if (!triangleId) return optimisticPatchRequestStatus(request.id, groupStatus);
      const status = String(groupStatus || '').trim();
      const next = requestsList.value.map((row) => {
        if (!row || String(row.triangleId || row.batchId || '').trim() !== triangleId) return row;
        const patch = {};
        if (status) {
          patch.status = status;
          patch.triangleGroupStatus = status;
        }
        if (String(row.id) === String(request.id) && responseStatus) {
          patch.triangleConsentStatus = responseStatus;
          patch.triangleConsentAt = new Date().toISOString();
        }
        return Object.keys(patch).length ? Object.assign({}, row, patch) : row;
      });
      requestsList.value = next;
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
    let _dataLoadSeq = 0;
    /** 畫面「更新於 HH:mm」；手動刷新／softRefresh／全量載入成功時寫入 */
    const dataUpdatedAt = ref(null);
    const dataRefreshing = ref(false);
    /** 背景 softRefresh 進行中（不擋全螢幕，只顯示 nav 小標） */
    const softSyncing = ref(false);
    const markDataUpdated = () => {
      dataUpdatedAt.value = Date.now();
      _softRefreshLastAt = dataUpdatedAt.value;
    };
    const dataUpdatedLabel = computed(() => {
      if (!dataUpdatedAt.value) return '尚未同步';
      const d = new Date(dataUpdatedAt.value);
      const hh = String(d.getHours()).padStart(2, '0');
      const mm = String(d.getMinutes()).padStart(2, '0');
      return '更新於 ' + hh + ':' + mm;
    });
    const manualRefreshData = async () => {
      if (!user.value || dataRefreshing.value) return;
      dataRefreshing.value = true;
      try {
        await loadWeeklyData({ force: true, silent: false });
        showToast('資料已重新整理', 'success', 2000);
      } catch (e) {
        showToast('重新整理失敗：' + (e && e.message ? e.message : e), 'error');
      } finally {
        dataRefreshing.value = false;
      }
    };
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
      softSyncing.value = true;
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
        softSyncing.value = true;
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
          if (isAdmin.value && user.value) await loadHomeroomRecords({ silent: true });
          markDataUpdated();
        } catch (e) {
          console.warn('背景同步失敗：', e);
          showToast('背景同步失敗，可按 ↻ 手動重整', 'warning', 2800);
        } finally {
          _softRefreshRunning = false;
          if (_softRefreshQueued) {
            const q = _softRefreshQueued;
            _softRefreshQueued = null;
            softRefreshInBackground(q);
          } else {
            softSyncing.value = false;
          }
        }
      }, runDelay);
    };

    const resolveUserRoleFromTeachers = async () => {
      if (!user.value) return true;
      const email = user.value.email.toLowerCase();
      const currentTeacher = lookupTeacher(email);
      if (currentTeacher) {
        const raw = currentTeacher.role || 'teacher';
        userRole.value = (window.FieldMap && window.FieldMap.normalizeRole)
          ? window.FieldMap.normalizeRole(raw)
          : raw;
        return true;
      }
      if (teachersList.value.length === 0) {
        if (userRole.value === 'admin') return true;
        logout();
        showToast('目前學期尚未建立教師名單，請由系統管理員先設定 SUPER_ADMIN_EMAILS 並完成初始化。', 'error');
        return false;
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
        if (res.userRole && ['admin', 'staff', 'teacher'].includes(String(res.userRole))) {
          userRole.value = String(res.userRole);
        }
        if (semestersList.value.length === 0) {
          semestersList.value = [{ id: '114-1', name: '114學年度第1學期', startDate: '', endDate: '', isDefault: true }];
        }
      } catch (e) {
        console.warn('載入學期失敗：', e);
        semestersList.value = [{ id: '114-1', name: '114學年度第1學期', startDate: '', endDate: '', isDefault: true }];
      }
    };

    const mapPublicClassRequests = (rows, className) => {
      const out = [];
      (rows || []).forEach((req) => {
        if (!req || String(req.status || req['狀態'] || '').toLowerCase() !== 'approved') return;
          const base = {
            requestId: req.id || req['申請單ID'] || '',
            serial: req.serial || req['單號'] || '',
            reason: req.reason || req['請假事由'] || '',
            subFee: req.subFee || req['經費來源'] || '',
          note: req.note || req['備註'] || '',
          printed: req.printed === true || req.printed === 'TRUE'
        };
        const classValue = String(className || req.className || req['班級'] || '').trim();
        const subjectValue = req.subject || req['科目'] || '';
        const targetDateValue = req.targetDate || req['對調目標日期'] || '';
        const targetPeriodValue = req.targetPeriod != null ? req.targetPeriod : req['對調目標節次'];
        const targetDayValue = req.targetDayOfWeek || req['對調目標星期'] || (() => {
          const date = new Date(String(targetDateValue || '').replace(/-/g, '/'));
          return Number.isNaN(date.getTime()) ? 0 : (date.getDay() === 0 ? 7 : date.getDay());
        })();
        const targetEmailValue = String(req.targetTeacherEmail || req['受邀人Email'] || req.targetTeacherName || req['受邀人姓名'] || '').trim().toLowerCase();
        const targetSchedule = (classViewSchedules.value || []).find(schedule =>
          String(schedule.teacherEmail || schedule.teacherName || '').trim().toLowerCase() === targetEmailValue
          && parseInt(schedule.dayOfWeek, 10) === parseInt(targetDayValue, 10)
          && parseInt(schedule.period, 10) === parseInt(targetPeriodValue, 10)
          && (typeof window === 'undefined' || !window.DomainSchedule || !window.DomainSchedule.isActiveOnDate
            || window.DomainSchedule.isActiveOnDate(schedule, targetDateValue))
        );
        const targetClassValue = String(req.targetClassName || req['對調目標班級'] || (targetSchedule && targetSchedule.className) || classValue).trim();
        const targetSubjectValue = req.targetSubject || req['對調目標科目'] || (targetSchedule && targetSchedule.subject) || (targetClassValue === classValue ? subjectValue : '');
        const type = req.type || req['異動類型'] || 'substitution';
        const requestDate = req.requestDate || req['異動日期'] || '';
        const requestPeriod = req.requestPeriod != null ? req.requestPeriod : req['異動節次'];
        const requesterName = req.requesterName || req['申請人姓名'] || '';
        const targetName = req.targetTeacherName || req['受邀人姓名'] || '';
        if (type === 'exchange' || type === '對調') {
          out.push(Object.assign({}, base, {
            id: String(base.requestId) + '_class_1',
            requestId: base.requestId,
            date: targetDateValue,
            period: targetPeriodValue,
            originalTeacherName: targetName,
            actualTeacherName: requesterName,
             className: targetClassValue,
             subject: targetSubjectValue || subjectValue,
            type: 'exchange'
          }));
          out.push(Object.assign({}, base, {
            id: String(base.requestId) + '_class_2',
            requestId: base.requestId,
            date: requestDate,
            period: requestPeriod,
            originalTeacherName: requesterName,
            actualTeacherName: targetName,
             className: classValue,
             subject: subjectValue,
            type: 'exchange'
          }));
          return;
        }
        out.push(Object.assign({}, base, {
          id: base.requestId,
          requestId: base.requestId,
          date: requestDate,
          period: requestPeriod,
          originalTeacherName: requesterName,
          actualTeacherName: targetName,
          className: classValue,
          subject: subjectValue,
          type: 'substitution'
        }));
      });
      return out.filter(r => r.date && r.period != null);
    };

    const applyClassPayload = (res, className) => {
      if (!res) return;
      if (Array.isArray(res.classNames)) {
        classDirectory.value = res.classNames.map(c => String(c || '').trim()).filter(Boolean);
      }
      if (res.semesters) {
        semestersList.value = res.semesters.map(s => window.FieldMap.mapSemester(s));
        semestersList.value.sort((a, b) => a.id.localeCompare(b.id));
      }
      classViewSchedules.value = (res.schedules || []).map(s => window.FieldMap.mapSchedule(s));
      classViewSchoolSwaps.value = (res.schoolSwaps || []).map(s => window.FieldMap.mapSchoolSwap(s));
      classViewLoadedClass.value = String(className || res.className || '').trim();
      classViewSubstitutionRecords.value = mapPublicClassRequests(res.requests || [], classViewLoadedClass.value);
      classViewClassAwayEvents.value = (res.classAwayEvents || []).map(e => window.FieldMap.mapClassAwayEvent(e));
    };

    const preflightGoogleLogin = async (payload) => {
      try {
        const res = await fetchMetaData({ semesterId: currentSemester.value, force: true });
        if (!res || res.success === false || !['admin', 'staff', 'teacher'].includes(String(res.userRole || ''))) {
          throw new Error('您的帳號不在目前學期教師名單中，無法登入本系統。');
        }
        const resolvedSemester = String(res.semesterId || '').trim();
        if (resolvedSemester && resolvedSemester !== currentSemester.value) {
          currentSemester.value = resolvedSemester;
          localStorage.setItem('jcjh_semester', resolvedSemester);
        }
        if (res.teachers) teachersList.value = res.teachers.map(t => window.FieldMap.mapTeacher(t));
        if (res.settings) applySettings(res.settings);
        return res;
      } catch (err) {
        try { sessionStorage.removeItem('jcjh_google_id_token'); } catch (e) { /* ignore */ }
        user.value = null;
        loading.value = false;
        const raw = err && err.message ? String(err.message) : String(err || '登入驗證失敗');
        const message = /不在|名單|開通/.test(raw)
          ? '此 Google 帳號不在本校教師名單內，請聯繫教學組開通。'
          : '登入驗證失敗：' + raw;
        gsiButtonError.value = message;
        showToast(message, 'error', 6000);
        return null;
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
      if (typeof cancelAll === 'function') cancelAll();
      const loadSeq = ++_dataLoadSeq;
      const requestedSemester = currentSemester.value;
      const isCurrentLoad = () => loadSeq === _dataLoadSeq;
      const guestLoad = !user.value;
      loading.value = true;
      loadingMessage.value = '載入班級課表中...';
      if (guestLoad) classReadonlyMode.value = true;
      activeTab.value = 'class';
      selectedClass.value = cls;
      pendingClassView.value = cls;
      try {
        const res = await fetchPublicClassData({
          className: cls,
          semesterId: requestedSemester
         });
         if (!isCurrentLoad()) return false;
         applyClassPayload(res, cls);
         if (res.semesterId) {
           currentSemester.value = res.semesterId;
           localStorage.setItem('jcjh_semester', res.semesterId);
         }
         if (guestLoad) resolvePendingClassView();
         else pendingClassView.value = '';
         loading.value = false;
        return true;
      } catch (err) {
        console.error('公開班級課表載入失敗：', err);
        showToast('載入班級課表失敗：' + (err.message || err), 'error');
        loading.value = false;
        return false;
      }
    };

    const selectClassForView = (className) => {
      const cls = String(className || '').trim();
      if (!cls) return;
      selectedClass.value = cls;
      if (user.value && classUsesPublicData.value) {
        loadPublicClassData(cls).catch(function () {});
      }
    };

    const loadWeeklyData = async (opts) => {
      if (!user.value) return;
      if (typeof cancelAll === 'function') cancelAll();
      opts = opts || {};
      const silent = !!opts.silent;
      const force = !!opts.force;
      const loadSeq = ++_dataLoadSeq;
      const requestedSemester = currentSemester.value;
      const isCurrentLoad = () => loadSeq === _dataLoadSeq && requestedSemester === currentSemester.value;

      if (!silent) {
        loading.value = true;
        loadingMessage.value = '同步基本資料中...';
      }

      const url = gasApiUrl.value;
      if (!url) {
        if (!silent) loading.value = false;
        throw new Error('主要資料庫 GAS API 網址尚未設定！');
      }

      try {
        // 0) SWR 分鍵先畫舊畫面（structure 可較久；requests 較短）
        const stale = window.GasApi.readSWR(currentSemester.value, {
          meta: 180000,
          structure: 300000,
          requests: 120000
        });
        if (stale && isCurrentLoad()) {
          applyInitialPayload(stale);
          loadingMessage.value = '正在更新最新資料...';
        }

        // 全量回應已包含學期、教師、課表與申請，避免首載先打 meta 再打全量。
        if (!isCurrentLoad()) return false;
        loadingMessage.value = '同步課表與異動中...';
        const res = await fetchInitialData({
          semesterId: requestedSemester,
          force: force
        });
        if (!isCurrentLoad()) return false;
        applyInitialPayload(res);
        await resolveUserRoleFromTeachers();
        if (!isCurrentLoad() || !user.value) return false;
        recomputeRequestBuckets();
        resolvePendingClassView();
        if (isAdmin.value && user.value && !Array.isArray(res.homeroomRecords)) {
          await loadHomeroomRecords({ silent: true });
        }
        if (!isCurrentLoad()) return false;
        markDataUpdated();
        if (!silent) loading.value = false;
        return true;
      } catch (err) {
        if (!isCurrentLoad()) return false;
         console.error("載入課表系統資料失敗：", err);
        if (!silent) {
          showToast("載入資料失敗：" + err.message, 'error');
          loading.value = false;
        }
        throw err;
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
        if (typeof cancelAll === 'function') cancelAll();
        loadWeeklyData().catch(function () {});
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
             "教師Email": t.loginEmail || t.email,
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

    // ── 空堂事件管理（ui-activity.js → UiClassAwayAdmin）──
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
      isSingleWeek,
      persistMutualPanelDraft,
      clearScheduleCache,
      ensureMutualActivityRange,
      DAC
    });
    _getMutualImportEventId = () => (mutualImportEventId && mutualImportEventId.value) || '';

    // ════════════════════════════════════════
    // §6 後台：核准 / 匯入 / 教師 / 課表編輯
    // ════════════════════════════════════════

    // ── 待辦摘要 / 格子白話 / 行政批次 ──
    // 請假課堂：07/23(四) 第3節 804走讀
    /** 類型旁標籤：經費／第8節（不進「狀態」欄） */
    const getRequestTypeTags = (req) => {
      if (!req) return [];
      const tags = [];
      if (isCombinedReturnRequest(req)) {
         tags.push({ key: 'combined-return', label: '併班上課' });
      }
      const period = parseInt(req.requestPeriod != null ? req.requestPeriod : req.period, 10);
      // 代申請已在申請人欄下方標示，不再加 Tag
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
    const formatCourseDisplayText = (className, subject, teacherName) => {
      const course = [className, subject].filter(value => String(value || '').trim()).join('');
      const teacher = String(teacherName || '').replace(/\s*老師\s*$/, '').trim();
      return course + (teacher ? `（${teacher}老師）` : '');
    };
    const _fmtSlot = (dateStr, day, period, clsSubj) => {
      const m = dateStr && dateStr !== '—' && dateStr.length >= 10 ? dateStr.slice(5, 10).replace('-', '/') : (dateStr || '—');
      const rawDay = String(day == null ? '' : day).trim();
      const dayText = /^\d+$/.test(rawDay)
        ? getWeekDayText(Number(rawDay))
        : rawDay.replace(/^週/, '');
      const daySuffix = dayText && dayText !== '—' ? `(${dayText})` : '';
      const periodText = period == null || period === '' ? '—' : formatPeriodText(period);
      const course = formatCourseDisplayText(clsSubj, '');
      return `${m}${daySuffix} ${periodText}${course ? ` ${course}` : ''}`.trim();
    };
    /** 同節先前義務（此人為 actual 的代課／調入），可排除本筆及本申請單 */
    const findPriorDutyAtSlot = (email, dateStr, period, excludeId, excludeRequestId) => {
      const em = String(email || '').toLowerCase();
      const p = parseInt(period, 10);
      const dk = String(dateStr || '');
      if (!em || !dk || Number.isNaN(p)) return null;
      const all = substitutionRecords.value || [];
      for (let i = all.length - 1; i >= 0; i--) {
        const s = all[i];
        if (!s || (excludeId && s.id === excludeId)) continue;
        if (excludeRequestId && String(s.requestId || '') === String(excludeRequestId)) continue;
        if (String(s.date) !== dk || parseInt(s.period, 10) !== p) continue;
        if (s.actualTeacherEmail && String(s.actualTeacherEmail).toLowerCase() === em
            && (s.className || s.subject)) {
          return s;
        }
      }
      return null;
    };

    /** 再異動判斷用：同一申請的 _1／_2 邊不可算成自己的前一筆。 */
    const normalizeRechangeRequestId = (value) => String(value || '').trim().replace(/_(?:class_)?[12]$/, '');
    /** 只有已核准生效的異動才會成為下一筆的前次異動。 */
    const isEffectiveChangedDuty = (record) => {
      if (!record || record.enabled === false || record.isPaperDraft) return false;
      const recordRequestId = normalizeRechangeRequestId(record.requestId || record.id);
      let rawStatus = record.status;
      if (rawStatus == null || String(rawStatus).trim() === '') rawStatus = record['狀態'];

      // 以申請單最新狀態為準，避免已核准後撤回／駁回的舊紀錄仍被算入。
      if (recordRequestId && typeof requestsList !== 'undefined'
          && requestsList && Array.isArray(requestsList.value)) {
        const request = requestsList.value.find(row =>
          row && normalizeRechangeRequestId(row.id || row.requestId) === recordRequestId
        );
        const requestStatus = request && (request.status || request['狀態']);
        if (requestStatus != null && String(requestStatus).trim() !== '') rawStatus = requestStatus;
      }

      const status = String(rawStatus == null ? '' : rawStatus).trim().toLowerCase();
      if (!status) return true; // 舊歷史列沒有狀態欄時，沿用既有有效紀錄。
      return [
        'approved', 'active', 'effective', 'approved_active',
        '核准生效', '已核准', '核准', '已生效', '生效', '有效', '啟用'
      ].includes(status);
    };
    const hasOtherChangedDutyAtSlot = (email, dateStr, period, excludeRequestId) => {
      const em = String(email || '').trim().toLowerCase();
      const dk = String(dateStr || '').trim();
      const p = parseInt(period, 10);
      const excluded = normalizeRechangeRequestId(excludeRequestId);
      if (!em || !dk || Number.isNaN(p)) return false;
      return (substitutionRecords.value || []).some(s => {
        if (!isEffectiveChangedDuty(s)) return false;
        const rowRequestId = normalizeRechangeRequestId(s.requestId || s.id);
        if (excluded && rowRequestId === excluded) return false;
        if (String(s.date || s.requestDate || '').trim() !== dk) return false;
        if (parseInt(s.period != null ? s.period : s.requestPeriod, 10) !== p) return false;
        if (!(s.className || s.subject)) return false;
        const original = String(s.originalTeacherEmail || '').trim().toLowerCase();
        const actual = String(s.actualTeacherEmail || '').trim().toLowerCase();
        return original === em || actual === em;
      });
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
      // 僅「代課義務」覆蓋；對調 edge 已保存該日期原課，不可互相覆蓋。
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

    /** 原始位置是否為「再異動」；請假與調課都套用同一規則。 */
    const isHistoryLeaveRechanged = (rec) => {
      if (!rec) return false;
      const dateStr = String(rec.date || rec.requestDate || '');
      const period = rec.period != null ? rec.period : rec.requestPeriod;
      const em = rec.originalTeacherEmail || rec.requesterEmail;
      return hasOtherChangedDutyAtSlot(em, dateStr, period, rec.requestId || rec.id);
    };

    /** 對調目標位置是否為「再異動」；只看目標端，不把標籤放到原始端。 */
    const isHistoryExchangeRechanged = (rec) => {
      if (!rec || !isExchangeLikeRequest(rec)) return false;
      const requestId = rec.requestId || rec.id;
      const all = substitutionRecords.value || [];
      const targetEdge = requestId
        ? all.find(x => x && x.requestId === requestId && String(x.id || '').endsWith('_1'))
          || all.find(x => x && x.requestId === requestId && x.id !== rec.id)
        : null;
      const targetDate = (targetEdge && targetEdge.date) || rec.targetDate;
      const targetPeriod = targetEdge && targetEdge.period != null ? targetEdge.period : rec.targetPeriod;
      const targetTeacher = (targetEdge && targetEdge.originalTeacherEmail)
        || rec.targetTeacherEmail
        || rec.actualTeacherEmail;
      return hasOtherChangedDutyAtSlot(targetTeacher, targetDate, targetPeriod, requestId);
    };

    /** 申請單：原始位置是否再異動（進行中列表用）。 */
    const isRequestLeaveRechanged = (req) => {
      if (!req) return false;
      const sourceDate = req.requestDate || req.date;
      const sourcePeriod = req.requestPeriod != null ? req.requestPeriod : req.period;
      const sourceTeacher = req.requesterEmail || req.originalTeacherEmail;
      return hasOtherChangedDutyAtSlot(sourceTeacher, sourceDate, sourcePeriod, req.id);
    };

    /** 申請單：對調目標節是否再異動（進行中列表用）。 */
    const isRequestExchangeRechanged = (req) => {
      if (!req || !isExchangeLikeRequest(req)) return false;
      if (!req.targetTeacherEmail || !req.targetDate) return false;
      return hasOtherChangedDutyAtSlot(req.targetTeacherEmail, req.targetDate, req.targetPeriod, req.id);
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
       const cls = formatCourseDisplayText(resolved.className, resolved.subject);
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
      if (!rec || !isExchangeLikeRequest(rec)) return '—';
      if (isTriangleRequest(rec)) {
        const dateStr = rec.targetDate || rec.date || '';
        let dayNum = rec.targetDayOfWeek;
        if ((dayNum == null || dayNum === '') && dateStr) {
          const d = new Date(String(dateStr).replace(/-/g, '/'));
          if (!Number.isNaN(d.getTime())) dayNum = d.getDay() === 0 ? 7 : d.getDay();
        }
        const movedCourse = formatCourseDisplayText(rec.className, rec.subject);
        return _fmtSlot(dateStr, dayNum != null ? getWeekDayText(dayNum) : '—', rec.targetPeriod || rec.period, movedCourse);
      }
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
         const cls = formatCourseDisplayText(clsName, subj);
         return _fmtSlot(targetDate, day, targetPeriod, cls || '');
      }
      // 備援：目標日 edge _1 的班科就是目標位置原本的課堂。
      let peerTargetEdge = null;
      if (rec.requestId) {
        const peers = (substitutionRecords.value || []).filter(x =>
          x && x.requestId === rec.requestId
        );
        peerTargetEdge = peers.find(x => String(x.id || '').endsWith('_1'))
          || peers.find(x => x.id !== rec.id)
          || null;
        if (peerTargetEdge) {
          if (!targetDate || targetDate === '---' || targetDate === '—') {
            targetDate = peerTargetEdge.date;
            targetPeriod = peerTargetEdge.period;
          }
          if (!clsName) clsName = String(peerTargetEdge.className || '').trim();
          if (!subj) subj = String(peerTargetEdge.subject || '').trim();
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
       const cls = formatCourseDisplayText(clsName, subj);
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
        cands = window.DomainSchedule.getCandidates(idx, em, dow, p, allSchedules.value, dateStr) || [];
      } else {
        cands = (allSchedules.value || []).filter(s =>
          s.teacherEmail && String(s.teacherEmail).toLowerCase() === em
          && parseInt(s.dayOfWeek, 10) === dow
          && parseInt(s.period, 10) === p
          && (!window.DomainSchedule || !window.DomainSchedule.isActiveOnDate
            || window.DomainSchedule.isActiveOnDate(s, dateStr))
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
        req.requesterEmail, req.requestDate, req.requestPeriod, null, req.id
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
      if (!req || !isExchangeLikeRequest(req) || !req.targetTeacherEmail || !req.targetPeriod) return false;
      let dayNum = req.targetDayOfWeek;
      if ((dayNum == null || dayNum === '') && req.targetDate) {
        const d = new Date(String(req.targetDate).replace(/-/g, '/'));
        if (!Number.isNaN(d.getTime())) dayNum = d.getDay() === 0 ? 7 : d.getDay();
      }
      const prior = findPriorDutyAtSlot(
        req.targetTeacherEmail, req.targetDate, req.targetPeriod, null, req.id
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
      if (!rec || !isExchangeLikeRequest(rec) || !rec.targetDate || rec.targetDate === '—' || rec.targetPeriod == null) {
        return false;
      }
      return resolveRestrictionForHistoryRec(rec, 'exchange');
    };

    const formatLeaveClassSlot = (req) => {
      if (!req) return '—';
      const day = getWeekDayText(req.requestPeriodDay);
       const cls = formatCourseDisplayText(req.className, req.subject);
      return _fmtSlot(req.requestDate, day, req.requestPeriod, cls || '');
    };
    // 對調課堂：受邀人在目標節的有效班／科（含調入／代課）；勿回退申請人班科
    const formatExchangeClassSlot = (req) => {
       if (!req || !isExchangeLikeRequest(req)) return '—';
       if (isTriangleRequest(req)) {
         let dayNum = req.targetDayOfWeek;
         if ((dayNum == null || dayNum === '') && req.targetDate) {
           const d = new Date(String(req.targetDate).replace(/-/g, '/'));
           if (!Number.isNaN(d.getTime())) dayNum = d.getDay() === 0 ? 7 : d.getDay();
         }
          const movedCourse = formatCourseDisplayText(req.className, req.subject);
          return _fmtSlot(req.targetDate, getWeekDayText(dayNum), req.targetPeriod, movedCourse || '');
       }
       let dayNum = req.targetDayOfWeek;
      if ((dayNum == null || dayNum === '') && req.targetDate) {
        const d = new Date(String(req.targetDate).replace(/-/g, '/'));
        if (!Number.isNaN(d.getTime())) dayNum = d.getDay() === 0 ? 7 : d.getDay();
      }
       const cell = resolveExchangeTargetCell(
        req.targetTeacherEmail,
        req.targetDate,
        req.targetPeriod,
        dayNum
      );
      const clsName = cell ? (cell.className || '') : (req.targetClassName || '');
      const subj = cell ? (cell.subject || '') : (req.targetSubject || '');
       const cls = formatCourseDisplayText(clsName, subj);
       return _fmtSlot(req.targetDate, getWeekDayText(dayNum), req.targetPeriod, cls || '');
    };

    /** 快速待辦節次：7/24(五)第7節國文 */
    const formatQuickSlotCompact = (dateStr, dayHint, period, className, subject) => {
      let md = '—';
      if (dateStr && String(dateStr).length >= 10) {
        const mm = parseInt(String(dateStr).slice(5, 7), 10);
        const dd = parseInt(String(dateStr).slice(8, 10), 10);
        if (!isNaN(mm) && !isNaN(dd)) md = mm + '/' + dd;
      }
      let day = '';
      if (typeof dayHint === 'number' || (dayHint != null && String(dayHint).match(/^\d+$/))) {
        day = getWeekDayText(parseInt(dayHint, 10)) || '';
      } else if (dayHint) {
        day = String(dayHint);
      } else if (dateStr) {
        try {
          const d = new Date(String(dateStr).replace(/-/g, '/'));
          if (!isNaN(d.getTime())) day = getWeekDayText(d.getDay() === 0 ? 7 : d.getDay()) || '';
        } catch (e) { /* ignore */ }
      }
      const dayPart = day ? '(' + day + ')' : '';
      const perPart = formatPeriodText(period) || '';
      const subj = String(subject || className || '').replace(/\s+/g, '');
      return [md + dayPart, perPart, subj].filter(Boolean).join(' ');
    };

    /**
     * 快速待辦標題（調／代課用上方小 tag）
     * 調課：7/24五7國文（我）⇄ 7/20一6數學（對方）
     * @param {'incoming'|'sent'} role
     */
    const formatQuickTodoTitle = (req, role) => {
      if (!req) return '—';
      const isEx = isExchangeLikeRequest(req);
      const leaveSlot = formatQuickSlotCompact(
        req.requestDate, req.requestPeriodDay, req.requestPeriod, req.className, req.subject
      );
      if (isCombinedReturnRequest(req)) {
         return '併班上課 · ' + leaveSlot;
      }
      if (isEx) {
        let dayNum = req.targetDayOfWeek;
        if ((dayNum == null || dayNum === '') && req.targetDate) {
          const d = new Date(String(req.targetDate).replace(/-/g, '/'));
          if (!Number.isNaN(d.getTime())) dayNum = d.getDay() === 0 ? 7 : d.getDay();
        }
         const cell = isTriangleRequest(req) ? null : resolveExchangeTargetCell(
           req.targetTeacherEmail, req.targetDate, req.targetPeriod, dayNum
         );
         const peerSlot = formatQuickSlotCompact(
           req.targetDate,
           dayNum,
           req.targetPeriod,
           cell ? cell.className : (isTriangleRequest(req) ? req.className : (req.targetClassName || '')),
           cell ? cell.subject : (isTriangleRequest(req) ? req.subject : (req.targetSubject || ''))
         );
        // sent＝申請人視角；incoming＝受邀人視角；括號內放真實姓名
        const meName = role === 'sent'
          ? (req.requesterName || '我')
          : (req.targetTeacherName || '我');
        const peerName = role === 'sent'
          ? (req.targetTeacherName || '對方')
          : (req.requesterName || '對方');
        const mySlot = role === 'sent' ? leaveSlot : peerSlot;
        const otherSlot = role === 'sent' ? peerSlot : leaveSlot;
        return mySlot + '（' + meName + '）⇄ ' + otherSlot + '（' + peerName + '）';
      }
      if (role === 'sent') {
        return (req.targetTeacherName || '對方') + ' · ' + leaveSlot;
      }
      return (req.requesterName || '申請人') + ' · ' + leaveSlot;
    };

    /** 核准前風險黃燈（綁課／第8／額度／再異動／跨日等） */
    const getApproveRiskFlags = (req) => {
      const flags = [];
      if (!req) return flags;
      const isEx = isExchangeLikeRequest(req);
      const period = parseInt(req.requestPeriod != null ? req.requestPeriod : req.period, 10);
      try {
        if (typeof isLeaveClassRestricted === 'function' && isLeaveClassRestricted(req)) {
          flags.push({ key: 'leave-restricted', label: '原課綁課', level: 'warn' });
        }
        if (isEx && typeof isExchangeClassRestricted === 'function' && isExchangeClassRestricted(req)) {
          flags.push({ key: 'ex-restricted', label: '對調綁課', level: 'warn' });
        }
        if (isEx && typeof isRequestExchangeRechanged === 'function' && isRequestExchangeRechanged(req)) {
          flags.push({ key: 'chain', label: '再異動', level: 'warn' });
        }
      } catch (eR) { /* ignore */ }
      if (period === 8) flags.push({ key: 'p8', label: '第8節', level: 'info' });
      if (!isEx && isQuotaDeductFee(req.subFee)) {
        flags.push({ key: 'quota', label: '扣額度', level: 'info' });
        const t = typeof lookupTeacher === 'function'
          ? lookupTeacher(req.targetTeacherEmail)
          : (teachersList.value || []).find(x =>
              x.email && String(x.email).toLowerCase() === String(req.targetTeacherEmail || '').toLowerCase()
            );
        const q = t ? (parseFloat(t.mutualQuota) || 0) : 0;
        if (q <= 0) flags.push({ key: 'quota0', label: '額度不足', level: 'danger' });
      } else if (!isEx && (req.subFee === '公費代課' || req.subFee === '學校移撥' || req.subFee === ACTIVITY_PUBLIC_FEE || req.subFee === '活動公費')) {
        flags.push({ key: 'public', label: '公費', level: 'info' });
      }
      if (isEx && req.targetDate && req.requestDate && String(req.targetDate) !== String(req.requestDate)) {
        flags.push({ key: 'crossday', label: '跨日', level: 'info' });
      }
      return flags;
    };

    const formatRequestSummary = (req) => {
      if (!req) return '（無申請資料）';
       const isEx = isExchangeLikeRequest(req);
       const typeLabel = isTriangleRequest(req) ? '三角調' : (isEx ? '調課' : '代課');
      const flags = getApproveRiskFlags(req);
      const risks = flags.map(f => f.label);

       let s = `【${typeLabel}】${req.serial || '—'}\n`;
       s += isCombinedReturnRequest(req)
         ? `申請教師：${req.requesterName || '—'}（核准後回原班）\n`
         : `${req.requesterName || '—'} → ${req.targetTeacherName || '—'}\n`;
      s += `請假：${formatLeaveClassSlot(req)}\n`;
      if (isEx) {
        s += `對調：${formatExchangeClassSlot(req)}\n`;
        s += `經費：無`;
      } else {
        s += `經費：${req.subFee || '—'} · 事由：${req.reason || '—'}`;
      }
      if (req.note) s += `\n備註：${req.note}`;
      if (risks.length) s += `\n⚠ 風險：${risks.join('、')}`;
      return s;
    };

    /** 多筆核准前：彙整黃燈摘要 */
    const formatApproveBatchRiskSummary = (ids) => {
      const lines = [];
      let warnN = 0;
      (ids || []).forEach(id => {
        const r = (allPendingRequests.value || []).find(x => x.id === id)
          || (adminPendingRequests.value || []).find(x => x.id === id)
          || (requestsList.value || []).find(x => x.id === id);
        if (!r) return;
        const flags = getApproveRiskFlags(r).filter(f => f.level === 'warn' || f.level === 'danger');
        if (!flags.length) return;
        warnN++;
        lines.push(`• ${r.serial || id}：${flags.map(f => f.label).join('、')}`);
      });
      if (!warnN) return '';
      return `\n\n⚠ 風險提醒（${warnN} 筆）：\n${lines.slice(0, 12).join('\n')}${lines.length > 12 ? '\n…另有 ' + (lines.length - 12) + ' 筆' : ''}`;
    };

    // ── 簽核／行政核准（ui-approval.js → UiApproval）──
    const {
      selectedAdminPendingIds, lastBatchPrintIds, showBatchPrintPrompt,
      findRequestById, isAdminPendingSelected, toggleAdminPendingSelect,
      isAdminBatchGroupSelected, toggleAdminBatchGroupSelection,
      toggleSelectAllAdminPending, clearAdminPendingSelection,
      checkUrlCallback, respondToRequest, respondToBatch,
      adminApprove, adminReject, batchAdminApprove, batchAdminReject,
      printLastBatchNotices, dismissBatchPrintPrompt,
      cancelRequest, deleteSubstitutionRecord
    } = window.UiApproval.create({
      ref,
      callGasApi,
      callGasApiWithProgress,
      showToast,
      showConfirm,
      loading,
      loadingMessage,
       getStatusText,
       getTeacherNameByEmail,
       isTriangleRequest,
       restoreMutualQuotaForRows,
       optimisticPatchRequestStatus,
       optimisticPatchRequestStatuses,
       optimisticPatchTriangleGroup,
      softRefreshInBackground,
      formatRequestSummary,
      formatApproveBatchRiskSummary,
       getApproveRiskFlags,
       printSelectedForms,
       openPrintPreview,
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

    const openBatchPendingPrintPreview = () => {
      const ids = (selectedAdminPendingIds.value || []).map(id => String(id));
      if (!ids.length) {
        showToast('請先勾選要預覽列印的申請單', 'warning');
        return false;
      }
      const requests = (adminPendingRequests.value || []).filter(request =>
        request && ids.includes(String(request.id))
      );
      if (!requests.length) {
        showToast('找不到已勾選的待核准申請單', 'warning');
        return false;
      }
      return openPaperPrintDraftForSubmittedRequests(requests);
    };

    const isAdminPendingPageFullySelected = () => {
      const ids = [];
      (paginatedAdminPending.value || []).forEach(row => {
        if (row && row.displayKind === 'batch') {
          (row.items || []).forEach(item => {
            if (item && item.type !== 'triangle' && item.id != null) ids.push(item.id);
          });
        } else if (row && row.displayKind === 'item' && row.type !== 'triangle' && row.id != null) {
          ids.push(row.id);
        }
      });
      return ids.length > 0 && ids.every(id => isAdminPendingSelected(id));
    };


    const getRequestProgressSteps = (req) => {
      // 線上流程：受邀 → 教學組 → 出單；紙本流程不顯示不存在的「對方同意」階段。
      const status = (req && req.status) || 'pending_teacher';
      const name = (req && req.targetTeacherName) || '受邀人';
      const isPaperFlow = isPaperFlowRequest(req);
      const isProxyFlow = isProxySubmitRequest(req);
      const isNoTeacherApprovalFlow = isPaperFlow || isProxyFlow;
      const createdStamp = req && req.createdAt ? String(req.createdAt).trim() : '';
      const updatedStamp = req && req.updatedAt ? String(req.updatedAt).trim() : '';
      // 完成步驟下方顯示用：有時分則 MM/DD HH:mm，否則 MM/DD
      const formatProgressAt = (stamp) => {
        if (!stamp) return '';
        const raw = String(stamp).trim().replace('T', ' ').replace(/\//g, '-');
        const m = raw.match(/(\d{4})-(\d{1,2})-(\d{1,2})(?:[ ]+(\d{1,2}):(\d{2})(?::\d{2})?)?/);
        if (m) {
          const md = `${m[2].padStart(2, '0')}/${m[3].padStart(2, '0')}`;
          if (m[4] != null) return `${md} ${m[4].padStart(2, '0')}:${m[5]}`;
          return md;
        }
        if (raw.length >= 16) return raw.slice(5, 16).replace('-', '/');
        if (raw.length >= 10) return raw.slice(5, 10).replace('-', '/');
        return raw;
      };
      const createdAtLabel = formatProgressAt(createdStamp);
      const updatedAtLabel = formatProgressAt(updatedStamp);
      // updated 明顯晚於 created 才當成「後續動作時間」（同意／核准）
      const hasLaterUpdate = !!(updatedStamp && createdStamp && updatedStamp !== createdStamp
        && String(updatedStamp) > String(createdStamp));
      const noteStr = String((req && req.note) || '');
      const isDirectApprove = status === 'approved' && (
        req.directApprove === true ||
        noteStr.indexOf('[直接核准]') >= 0 ||
        noteStr.indexOf('行政直接核准') >= 0 ||
        (req.skipTeacherConfirm === true)
      );

      if (isDirectApprove || (status === 'approved' && req && req.forceDirectProgress)) {
        const atDirect = updatedAtLabel || createdAtLabel;
        return {
          steps: [
            { key: 'admin', label: '教學組直接核准', short: '直接核准', done: true, current: false, fail: false, at: atDirect },
            { key: 'done', label: '已出單生效', short: '出單', done: true, current: false, fail: false, at: atDirect }
          ],
          active: 1,
          failed: false,
          summary: '教學組直接核准出單，課表已更新',
          overdue: false,
          overdueHint: ''
        };
      }

      const steps = isNoTeacherApprovalFlow
        ? [
          { key: 'admin', label: '等教學組核准', short: '行政' },
          { key: 'done', label: '已出單生效', short: '出單' }
        ]
        : [
          { key: 'invite', label: `等 ${name} 同意`, short: '受邀' },
          { key: 'admin', label: '等教學組核准', short: '行政' },
          { key: 'done', label: '已出單生效', short: '出單' }
        ];
      let active = 0;
      let summary = '';
      let overdue = false;
      let overdueHint = '';

      // 逾時起算：教師階段＝送出日(createdAt)；行政階段＝進入行政日(updatedAt，通常為對方同意時間)
      const parseAgeDays = (stamp) => {
        if (!stamp) return 0;
        const t = new Date(String(stamp).replace(/-/g, '/'));
        if (isNaN(t.getTime())) return 0;
        return (Date.now() - t.getTime()) / (1000 * 60 * 60 * 24);
      };
      const createdAgeDays = parseAgeDays(req && req.createdAt)
        || parseAgeDays(req && req.requestDate);
      let adminWaitAgeDays = 0;
      if (updatedStamp) {
        const uAge = parseAgeDays(updatedStamp);
        const cAge = parseAgeDays(createdStamp);
        if (!createdStamp || uAge + 0.02 < cAge) {
          adminWaitAgeDays = uAge;
        }
      }

      if (status === 'pending_teacher') {
        active = 0;
        summary = isPaperFlow
          ? '目前：紙本通知已送出，等待教學組核准出單'
          : (isProxyFlow
            ? '目前：已代送申請，等待教學組核准出單'
            : `目前：等待 ${name} 老師線上同意`);
        if (createdAgeDays >= 2) {
          overdue = true;
          overdueHint = isNoTeacherApprovalFlow
            ? `已超過 ${Math.floor(createdAgeDays)} 天待行政核准`
            : `已超過 ${Math.floor(createdAgeDays)} 天未回覆，可再傳 LINE 或改請他人`;
        }
      } else if (status === 'pending_admin') {
        active = isNoTeacherApprovalFlow ? 0 : 1;
        summary = isPaperFlow
          ? '目前：紙本通知已送出，等待教學組核准出單'
          : (isProxyFlow
            ? '目前：已代送申請，等待教學組核准出單'
            : '目前：對方已同意，等待教學組核准出單');
        if (adminWaitAgeDays >= 2) {
          overdue = true;
          overdueHint = `已超過 ${Math.floor(adminWaitAgeDays)} 天待行政核准`;
        }
      } else if (status === 'approved') {
        active = isNoTeacherApprovalFlow ? 1 : 2;
        summary = '已核准生效，課表已更新';
      } else if (status === 'rejected') {
        return {
          steps: [{ key: 'rej', label: `${name} 已拒絕`, short: '拒絕', done: true, fail: true, current: false, at: updatedAtLabel || createdAtLabel }],
          active: 0, failed: true, failLabel: '已拒絕',
          summary: `${name} 老師已拒絕此邀請`,
          overdue: false, overdueHint: ''
        };
      } else if (status === 'admin_rejected') {
        return {
          steps: [{ key: 'rej', label: '教學組已駁回', short: '駁回', done: true, fail: true, current: false, at: updatedAtLabel || createdAtLabel }],
          active: 0, failed: true, failLabel: '已駁回',
          summary: '教學組已駁回此申請',
          overdue: false, overdueHint: ''
        };
      } else if (status === 'cancelled' || status === 'withdrawn') {
        const lab = status === 'withdrawn' ? '已撤回' : '已取消';
        return {
          steps: [{ key: 'can', label: lab, short: lab, done: true, fail: true, current: false, at: updatedAtLabel || createdAtLabel }],
          active: 0, failed: true, failLabel: lab,
          summary: lab,
          overdue: false, overdueHint: ''
        };
      }
      return {
        steps: steps.map((st, i) => {
          const done = i < active || (i === active && status === 'approved');
          const current = i === active && status !== 'approved';
          let at = '';
          if (done) {
            if (st.key === 'invite') {
              // 已完成受邀：pending_admin 時 updated≈同意時間；approved 時難還原，改標送出時間
              if (status === 'pending_admin' && (hasLaterUpdate || updatedAtLabel)) {
                at = updatedAtLabel || createdAtLabel;
              } else {
                at = createdAtLabel;
              }
            } else if (st.key === 'admin' || st.key === 'done') {
              // 核准／出單：優先更新時間，否則送出時間
              at = (status === 'approved' ? (updatedAtLabel || createdAtLabel) : (updatedAtLabel || createdAtLabel));
            }
          }
          return { ...st, done, current, fail: false, at };
        }),
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

      let scopeSubCount = 0;
      let scopePublic = 0;
      let scopeP8 = 0;
      let unprinted = 0;
      substitutionRecords.value.forEach(r => {
        if (!inScope(r.date)) return;
        scopeSubCount += 1;
        if (r.type === 'substitution' && (r.subFee === '公費代課' || r.subFee === '學校移撥' || r.subFee === '活動公費')) {
          scopePublic += 1;
        }
        if (parseInt(r.period) === 8) scopeP8 += 1;
        if (!r.printed) unprinted += 1;
      });

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
      const swapName = cell.schoolSwap && cell.schoolSwap.name ? String(cell.schoolSwap.name) : '';
      const head = (cls || '有課') + (swapName ? `\n↔ 全校對調：${swapName}` : '');
      if (cell.isPending) {
        if (cell.pendingType === 'combined_return_out') {
           return `${head}\n⏳ 併班上課申請中\n${cell.pendingText || '待教學組核准'}`;
        }
        if (cell.pendingType === 'substitution_out') {
          return `${head}\n⏳ 代課申請中\n${cell.pendingText || '待對方或行政確認'}`;
        }
        if (cell.pendingType === 'substitution_in') {
          return `${head}\n⏳ 待代課\n${cell.pendingText || '請至待辦簽核'}`;
        }
        if (cell.pendingType === 'combined_return_in') {
          return `${head}\n⏳ 合班代課申請中\n${cell.pendingText || '待教學組核准'}`;
        }
        if (cell.pendingType === 'exchange_out') {
          return `${head}\n⏳ 調出申請中\n${cell.pendingText || ''}`;
        }
        if (cell.pendingType === 'exchange_in') {
          return `${head}\n⏳ 調入申請中\n${cell.pendingText || ''}`;
        }
        if (cell.pendingType === 'triangle' || cell.pendingType === 'triangle_out' || cell.pendingType === 'triangle_in') {
          return `${head}\n⏳ 三角調申請中\n${cell.pendingText || '等待三位教師完成同意'}`;
        }
        return `${head}\n${cell.pendingText || '申請處理中'}`;
      }
      if (cell.isCombinedReturn) {
         return `${head}\n↩ 併班上課\n${cell.subText || ''}`;
      }
      if (cell.isSubstituted) {
        if (cell.subType === 'exchange' || cell.subType === 'triangle') {
          return `${head}\n⇄ 本節已調出\n${cell.subText || ''}`;
        }
        // 被代課：不一定是請假（公假／活動／課務異動等）
        return `${head}\n➔ 本節已由他人代課\n${cell.subText || ''}`;
      }
      if (cell.isSubstitutionDuty) {
        if (cell.subType === 'exchange' || cell.subType === 'triangle') {
          return `${head}\n⇄ 本節為調入課\n${cell.subText || ''}`;
        }
        if (cell.isEmptySlotAssign) {
          return `${head}\n📌 本節為空堂任務\n${cell.subText || ''}`;
        }
        return `${head}\n➔ 本節為代課\n${cell.subText || ''}`;
      }
      return head;
    };


    // 儲存 GAS / GSI 設定值
    // 登出
    const logout = () => {
      loading.value = true;
      const prevEmail = user.value && user.value.email ? user.value.email : '';
      _dataLoadSeq += 1;
      if (typeof cancelAll === 'function') cancelAll();
      sessionStorage.removeItem('jcjh_google_id_token');
      clearSWR();
      // 不記憶本站上次帳號：revoke + disableAutoSelect + 清 g_state
      try {
        if (prevEmail && isGsiInitialized() && isGoogleGsiReady() && typeof google.accounts.id.revoke === 'function') {
          google.accounts.id.revoke(String(prevEmail), function () { /* ignore */ });
        }
      } catch (eRev) { /* ignore */ }
      suppressGsiAutoLogin();
      gsiLoggingIn.value = false;
      resetAppState();
      loading.value = false;
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
    const getHistoryPageSelectableIds = () => {
      const ids = [];
      const seen = new Set();
      const add = (id) => {
        if (id == null || String(id) === '') return;
        const key = String(id);
        if (seen.has(key)) return;
        seen.add(key);
        ids.push(key);
      };
      (paginatedHistoryRecords.value || []).forEach(row => {
        if (row && row.displayKind === 'batch') {
          (row.items || []).forEach(item => add(item && item.id));
        } else if (row && row.displayKind === 'item') {
          add(row.id);
        }
      });
      return ids;
    };
    const setHistorySelection = (ids, on) => {
      const selected = new Set((selectedRecordIds.value || []).map(id => String(id)));
      (ids || []).forEach(id => {
        const key = String(id);
        if (on) selected.add(key);
        else selected.delete(key);
      });
      selectedRecordIds.value = Array.from(selected);
      const idSet = new Set((ids || []).map(id => String(id)));
      try {
        document.querySelectorAll('.hist-select-cb').forEach(el => {
          const id = el.getAttribute('data-rec-id') || el.value;
          if (idSet.has(String(id))) el.checked = on;
        });
        const pageIds = getHistoryPageSelectableIds();
        const pageSelected = pageIds.length > 0 && pageIds.every(id => selected.has(String(id)));
        document.querySelectorAll('.hist-select-all').forEach(el => {
          el.checked = pageSelected;
        });
      } catch (e) { /* ignore */ }
    };
    const isHistoryRecordSelected = (id) =>
      (selectedRecordIds.value || []).some(selectedId => String(selectedId) === String(id));
    const isHistoryBatchGroupSelected = (group) => {
      const ids = (group && group.items || []).map(item => item && item.id).filter(id => id != null).map(String);
      if (!ids.length) return false;
      const selected = new Set((selectedRecordIds.value || []).map(id => String(id)));
      return ids.every(id => selected.has(id));
    };
    const toggleHistoryBatchGroupSelection = (group, event) => {
      const ids = (group && group.items || []).map(item => item && item.id).filter(id => id != null).map(String);
      if (ids.length) setHistorySelection(ids, !!(event && event.target && event.target.checked));
    };
    const syncHistorySelectionFromDom = () => {
      const checkedIds = readHistoryCheckedIds();
      const renderedIds = [];
      try {
        document.querySelectorAll('.hist-select-cb').forEach(el => {
          const id = el.getAttribute('data-rec-id') || el.value;
          if (id) renderedIds.push(String(id));
        });
      } catch (e) { /* ignore */ }
      const renderedSet = new Set(renderedIds);
      const next = [];
      // 收合批次的子列不在 DOM，保留它們原本的選取狀態。
      (selectedRecordIds.value || []).forEach(id => {
        if (!renderedSet.has(String(id)) && !next.includes(String(id))) next.push(String(id));
      });
      checkedIds.forEach(id => {
        if (!next.includes(String(id))) next.push(String(id));
      });
      selectedRecordIds.value = next;
      const selected = new Set(next);
      const pageIds = getHistoryPageSelectableIds();
      const pageSelected = pageIds.length > 0 && pageIds.every(id => selected.has(String(id)));
      try {
        document.querySelectorAll('.hist-select-all').forEach(el => { el.checked = pageSelected; });
      } catch (eHeader) { /* ignore */ }
    };
    const toggleSelectAllRecords = (e) => {
      const ids = getHistoryPageSelectableIds();
      if (!ids.length) {
        if (e && e.target) e.target.checked = false;
        return;
      }
      const selected = new Set((selectedRecordIds.value || []).map(id => String(id)));
      const allOn = ids.every(id => selected.has(String(id)));
      const on = e && e.target ? !!e.target.checked : !allOn;
      setHistorySelection(ids, on);
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

    // ── 後台匯入／教師／課表編輯（ui-admin.js lazy：教師首屏不載）──
    const showImportTeachersModal = ref(false);
    const teacherExcelData = ref([]);
    const teacherExcelHeaders = ref([]);
    const teacherMappingFields = ref({ name: '', email: '', subject: '', jobTitle: '', baseHours: '', role: '' });
    const teacherImportPreview = ref(null);
    const showScheduleEditModal = ref(false);
    const scheduleForm = ref({
      id: null, teacherEmail: '', teacherName: '', dayOfWeek: 1, period: 1,
       className: '', subject: '', attr: '一般', restriction: '', activeFrom: '', activeTo: '',
       _newVersion: false, _previousId: ''
    });
    const showTeacherModal = ref(false);
    const teacherModalMode = ref('add');
    const teacherForm = ref({ email: '', name: '', subject: '', jobTitle: '', expensePlan: '', role: 'teacher', baseHours: 16, mutualQuota: 0 });
    const showOvertimePlanModal = ref(false);
    const overtimePlanTeacher = ref(null);
    const overtimePlanRows = ref([]);
    const excelData = ref([]);
    const excelHeaders = ref([]);
    const mappingFields = ref({
      teacherName: '', subject: '', dayOfWeek: '',
      period: '', className: '', attr: '', restriction: '', specialTags: '', activeFrom: '', activeTo: ''
    });
    const importPreview = ref(null);

    let _uiAdminApi = null;
    let _uiAdminModalsBound = false;
    const ensureUiAdminApi = async () => {
      if (_uiAdminApi) return _uiAdminApi;
      if (typeof window.ensureUiAdmin === 'function') {
        await window.ensureUiAdmin();
      }
      if (!window.UiAdmin || !window.UiAdmin.create) {
        throw new Error('後台模組未載入');
      }
      _uiAdminApi = window.UiAdmin.create({
        ref,
        callGasApi,
        callGasApiWithProgress,
        showToast,
        showConfirm,
        loading,
        loadingMessage,
        softRefreshInBackground,
        clearScheduleCache,
        loadWeeklyData,
         getTeacherNameByEmail,
         currentSemester,
         semesterStartDate,
         semesterEndDate,
           teachersList,
        allSchedules,
        leaveReasonOptions,
        getHistoryEditDefaultSubFee: function (reason, period) {
          return getHistoryEditDefaultSubFee(reason, period);
        },
        historyEditForm,
        showHistoryEditModal,
        requestsList,
        // 注入既有 ref，模板持續綁定同一物件
        showImportTeachersModal,
        teacherExcelData,
        teacherExcelHeaders,
        teacherMappingFields,
        teacherImportPreview,
        showScheduleEditModal,
        scheduleForm,
        showTeacherModal,
         teacherModalMode,
         teacherForm,
         showOvertimePlanModal,
         overtimePlanTeacher,
         overtimePlanRows,
         accountingPlanOptions,
         excelData,
        excelHeaders,
        mappingFields,
        importPreview
      });
      if (!_uiAdminModalsBound) {
        _uiAdminModalsBound = true;
        bindFlagModal(showImportTeachersModal, () => { showImportTeachersModal.value = false; }, '匯入教師');
        bindFlagModal(showTeacherModal, () => { showTeacherModal.value = false; }, '教師資料');
        bindFlagModal(showOvertimePlanModal, () => { showOvertimePlanModal.value = false; }, '超鐘點經費來源');
        bindFlagModal(showScheduleEditModal, () => { showScheduleEditModal.value = false; }, '編輯課表');
        bindFlagModal(showHistoryEditModal, () => { showHistoryEditModal.value = false; }, '編輯歷史');
      }
      return _uiAdminApi;
    };
    const needUiAdmin = async (fnName, ...args) => {
      try {
        const api = await ensureUiAdminApi();
        if (!api || typeof api[fnName] !== 'function') {
          showToast('後台功能未就緒', 'error');
          return;
        }
        return await api[fnName](...args);
      } catch (e) {
        showToast((e && e.message) || '後台模組載入失敗', 'error');
      }
    };
    const runTeacherImportPreview = (...a) => needUiAdmin('runTeacherImportPreview', ...a);
    const importSchedules = (...a) => needUiAdmin('importSchedules', ...a);
    const migrateNameKeySchema = (...a) => needUiAdmin('migrateNameKeySchema', ...a);
    const runImportPreview = (...a) => needUiAdmin('runImportPreview', ...a);
    const downloadScheduleTemplate = (...a) => needUiAdmin('downloadScheduleTemplate', ...a);
    const downloadCurrentSchedules = (...a) => needUiAdmin('downloadCurrentSchedules', ...a);
    const openScheduleEditModal = (...a) => needUiAdmin('openScheduleEditModal', ...a);
    const pickScheduleAttr = (...a) => needUiAdmin('pickScheduleAttr', ...a);
    const getSchedule = (...a) => {
      if (_uiAdminApi && typeof _uiAdminApi.getSchedule === 'function') return _uiAdminApi.getSchedule(...a);
      return null;
    };
    const saveScheduleCell = (...a) => needUiAdmin('saveScheduleCell', ...a);
    const clearScheduleCell = (...a) => needUiAdmin('clearScheduleCell', ...a);
    const updateTeacherBaseHours = (...a) => needUiAdmin('updateTeacherBaseHours', ...a);
    const openAddTeacherModal = (...a) => needUiAdmin('openAddTeacherModal', ...a);
    const openEditTeacherModal = (...a) => needUiAdmin('openEditTeacherModal', ...a);
    const saveTeacher = (...a) => needUiAdmin('saveTeacher', ...a);
    const getOvertimeExpenseSourceOptions = (...a) => {
      if (_uiAdminApi && typeof _uiAdminApi.getOvertimeExpenseSourceOptions === 'function') return _uiAdminApi.getOvertimeExpenseSourceOptions(...a);
      return accountingPlanOptions.value || [];
    };
    const openOvertimePlanModal = (...a) => needUiAdmin('openOvertimePlanModal', ...a);
    const saveOvertimePlan = (...a) => needUiAdmin('saveOvertimePlan', ...a);
    const deleteTeacher = (...a) => needUiAdmin('deleteTeacher', ...a);
    const handleTeacherExcelChange = (...a) => needUiAdmin('handleTeacherExcelChange', ...a);
    const importTeachersBatch = (...a) => needUiAdmin('importTeachersBatch', ...a);
    const handleFileChange = (...a) => needUiAdmin('handleFileChange', ...a);
    const getMappingLabel = (...a) => {
      if (_uiAdminApi && typeof _uiAdminApi.getMappingLabel === 'function') return _uiAdminApi.getMappingLabel(...a);
      return String(a[0] || '');
    };
    const openHistoryEditModal = (...a) => needUiAdmin('openHistoryEditModal', ...a);
    const saveHistoryEdit = (...a) => needUiAdmin('saveHistoryEdit', ...a);
    const onHistoryEditDateChange = (...a) => needUiAdmin('onHistoryEditDateChange', ...a);

    bindFlagModal(showClassAwayModal, () => { showClassAwayModal.value = false; }, '空堂事件');
    bindFlagModal(showBatchPrintPrompt, () => { dismissBatchPrintPrompt(); }, '批次列印');

    // 管理員進後台時預載 ui-admin（不擋首屏）
    watch([paperMode, isAdmin, activeTab], ([paper, admin, tab]) => {
      if (paper && !admin && tab === 'pending' && isMutualCover.value && !paperFlow.value) {
        setActiveTab('timetable');
      }
    });
    watch([isAdmin, activeTab], ([adm, tab]) => {
      if (adm && tab === 'admin' && typeof window.ensureUiAdmin === 'function') {
        ensureUiAdminApi().catch(function () {});
      }
    });

    // ── 後台：折抵額度歷程（額度帳本）──
    const showQuotaLedgerModal = ref(false);
    const quotaLedgerLoading = ref(false);
    const quotaLedgerTeacher = ref(null); // { email, name, balance, sheetQuota }
    const quotaLedgerRows = ref([]);
    /** 前端快取：同師 3 分鐘內再開不重打 GAS */
    const _quotaLedgerCache = Object.create(null);
    const QUOTA_LEDGER_CACHE_MS = 180000;
    try {
      window.__quotaLedgerCacheBust = function () {
        Object.keys(_quotaLedgerCache).forEach(function (k) { delete _quotaLedgerCache[k]; });
      };
    } catch (eQ) { /* ignore */ }
    const openQuotaLedger = async (t) => {
      if (!t || !t.email) return;
      if (!isAdmin.value) {
        showToast('僅管理員可查看額度歷程', 'warning');
        return;
      }
      if (typeof fetchMutualQuotaLedger !== 'function') {
        showToast('額度歷程 API 未載入，請重新整理', 'error');
        return;
      }
      const emKey = String(t.email).toLowerCase();
      // 先開 modal＋顯示名單餘額，體感較快
      showQuotaLedgerModal.value = true;
      quotaLedgerTeacher.value = {
        email: t.email,
        name: t.name || t.email,
        balance: parseFloat(t.mutualQuota) || 0,
        sheetQuota: parseFloat(t.mutualQuota) || 0
      };
      const hit = _quotaLedgerCache[emKey];
      if (hit && (Date.now() - hit.ts) < QUOTA_LEDGER_CACHE_MS) {
        quotaLedgerRows.value = hit.rows;
        if (hit.meta) quotaLedgerTeacher.value = hit.meta;
        quotaLedgerLoading.value = false;
        return;
      }
      // 有舊資料先顯示，背景刷新；無資料才清空＋ loading
      const hasStale = !!(hit && hit.rows && hit.rows.length);
      if (hasStale) {
        quotaLedgerRows.value = hit.rows;
        if (hit.meta) quotaLedgerTeacher.value = Object.assign({}, hit.meta, {
          balance: parseFloat(t.mutualQuota) || hit.meta.balance,
          sheetQuota: parseFloat(t.mutualQuota) || hit.meta.sheetQuota
        });
      } else {
        quotaLedgerRows.value = [];
      }
      quotaLedgerLoading.value = !hasStale;
      try {
        const res = await fetchMutualQuotaLedger({ name: t.teacherName || t.name, limit: 50 });
        // 後端已倒序；前端再保險排一次
        const rows = ((res && res.ledger) || []).slice().sort((a, b) => {
          const ta = String((a && a.time) || '').replace('T', ' ').trim();
          const tb = String((b && b.time) || '').replace('T', ' ').trim();
          if (tb !== ta) return tb < ta ? -1 : 1;
          const ida = String((a && a.id) || '');
          const idb = String((b && b.id) || '');
          if (idb !== ida) return idb < ida ? -1 : 1;
          return 0;
        });
        const meta = {
          email: (res && res.email) || t.email,
          name: (res && res.name) || t.name || t.email,
          balance: res && res.balance != null ? res.balance : (parseFloat(t.mutualQuota) || 0),
          sheetQuota: res && res.sheetQuota != null ? res.sheetQuota : (parseFloat(t.mutualQuota) || 0)
        };
        quotaLedgerRows.value = rows;
        quotaLedgerTeacher.value = meta;
        _quotaLedgerCache[emKey] = { ts: Date.now(), rows: rows, meta: meta };
      } catch (e) {
        console.error(e);
        if (!hasStale) showToast('載入額度歷程失敗：' + (e && e.message ? e.message : e), 'error');
      } finally {
        quotaLedgerLoading.value = false;
      }
    };
    const closeQuotaLedger = () => {
      showQuotaLedgerModal.value = false;
    };
    const quotaTypeClass = (type) => {
      const k = String(type || '').toLowerCase();
      if (k === 'earn') return 'quota-type-earn';
      if (k === 'spend') return 'quota-type-spend';
      if (k === 'restore') return 'quota-type-restore';
      if (k === 'adjust') return 'quota-type-adjust';
      return '';
    };
    bindFlagModal(showQuotaLedgerModal, () => { showQuotaLedgerModal.value = false; }, '額度歷程');

    // ── 空堂排班（扣額度；預設不寄信；班級可選）──
    const showEmptySlotModal = ref(false);
    const emptySlotForm = ref({
      teacherEmail: '',
      teacherName: '',
      dateStr: '',
      dayOfWeek: 1,
      period: 1,
      taskName: '',
      className: '',
      note: '',
      quota: 0
    });
    const openEmptySlotAssign = async (teacherEmail, dayOfWeek, period, dateStr, cell) => {
      if (paperMode.value && !isAdmin.value) {
        showToast('目前為紙本模式，空堂排班不建立線上申請', 'info');
        return;
      }
      if (!isAdmin.value) {
        showToast('僅教學組可使用空堂排班', 'warning');
        return;
      }
      if (isMutualCover.value) {
        showToast('請先關閉活動互代模式再使用空堂排班', 'info');
        return;
      }
      if (batchSelectMode.value) {
        showToast('請先結束批次選取再使用空堂排班', 'info');
        return;
      }
      const DAC0 = await ensureDAC();
      if (DAC0 && DAC0.isEmptySlotAssignable && cell && !DAC0.isEmptySlotAssignable(cell)) {
        showToast('此格非空堂，無法空堂排班', 'warning');
        return;
      }
      const t = lookupTeacher(teacherEmail);
      const q = t ? (parseFloat(t.mutualQuota) || 0) : 0;
      const isPatrolCell = !!(cell && (cell.isPatrol || cell.attr === '巡堂'));
      const freedBySub = !!(cell && cell.isSubstituted);
      emptySlotForm.value = {
        teacherEmail: String(teacherEmail || '').trim().toLowerCase(),
        teacherName: getTeacherNameByEmail(teacherEmail) || teacherEmail,
        dateStr: String(dateStr || '').slice(0, 10),
        dayOfWeek: parseInt(dayOfWeek, 10) || 1,
        period: parseInt(period, 10) || 1,
        taskName: (isPatrolCell || freedBySub) ? '巡堂' : '',
        className: '',
        note: freedBySub ? '調開／被代後空堂排班' : '',
        quota: q
      };
      showEmptySlotModal.value = true;
    };
    /** 詳情框：原授課老師該節已調開／被代 → 開空堂排班 */
    const openEmptySlotFromDetail = () => {
      const sub = detailSubRecord.value;
      if (!sub || !sub.originalTeacherEmail) {
        showToast('找不到原課老師，無法空堂排班', 'warning');
        return;
      }
      const dateStr = String(sub.date || (detailRequest.value && detailRequest.value.requestDate) || '').slice(0, 10);
      const period = parseInt(sub.period != null ? sub.period : (detailRequest.value && detailRequest.value.requestPeriod), 10) || 0;
      let dayOfWeek = parseInt(sub.dayOfWeek, 10);
      if (!dayOfWeek && dateStr) {
        const d = new Date(dateStr.replace(/-/g, '/'));
        if (!Number.isNaN(d.getTime())) dayOfWeek = d.getDay() === 0 ? 7 : d.getDay();
      }
      if (!dateStr || !Number.isFinite(period)) {
        showToast('缺少日期或節次', 'warning');
        return;
      }
      showDetailModal.value = false;
      openEmptySlotAssign(
        sub.originalTeacherEmail,
        dayOfWeek || 1,
        period,
        dateStr,
        { isSubstituted: true }
      );
    };
    const closeEmptySlotModal = () => {
      showEmptySlotModal.value = false;
    };
    const emptySlotQuotaZero = computed(() => {
      const DAC0 = DAC();
      if (DAC0 && DAC0.quotaZeroNeedsRepay) {
        return DAC0.quotaZeroNeedsRepay(emptySlotForm.value.quota);
      }
      return (parseInt(emptySlotForm.value.quota, 10) || 0) <= 0;
    });
    const executeEmptySlotAssign = async () => {
      if (paperMode.value && !isAdmin.value) {
        showToast('目前為紙本模式，空堂排班不建立線上申請', 'info');
        return;
      }
      if (!isAdmin.value) {
        showToast('僅教學組可使用空堂排班', 'warning');
        return;
      }
      await ensureDAC();
      const f = emptySlotForm.value;
      const task = String(f.taskName || '').trim();
      if (!task) {
        showToast('請填寫任務名稱（例如：段考巡堂）', 'info');
        return;
      }
      if (!f.teacherEmail || !f.dateStr || !f.period) {
        showToast('缺少日期／節次／老師', 'warning');
        return;
      }
      if (emptySlotQuotaZero.value) {
        const ok = await showConfirm(
          f.teacherName + ' 老師目前折抵額度為 0。\n仍要排入並扣額度？\n（送出後請安排由他人還一節）',
          '額度為 0'
        );
        if (!ok) return;
      }
      if (isSubmitting.value) {
        showToast('送出中，請稍候…', 'info');
        return;
      }
      isSubmitting.value = true;
      loading.value = true;
      loadingMessage.value = '正在送出空堂排班…';
      try {
        const requestId = 'req_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
        const serial = 'SUB' + (1000 + Math.floor(Math.random() * 9000));
        const DAC0 = DAC();
        if (!DAC0 || !DAC0.buildEmptySlotPayload) {
          throw new Error('空堂排班模組未載入');
        }
        const built = DAC0.buildEmptySlotPayload({
          date: f.dateStr,
          period: f.period,
          dayOfWeek: f.dayOfWeek,
          teacherEmail: f.teacherEmail,
          teacherName: f.teacherName,
          taskName: task,
          className: String(f.className || '').trim(),
          note: f.note,
          semesterId: currentSemester.value,
          requestId: requestId,
          serial: serial
        });
        await callGasApi('submitRequest', {
          request: built.request,
          directApprove: true,
          skipNotify: true
        });
        optimisticUpsertRequest(sheetRequestToFront(built.newRequest));
        await deductMutualQuotaForRows([built.newRequest]);
        softRefreshInBackground({ delay: 2500 });
        showEmptySlotModal.value = false;
        const qTip = emptySlotQuotaZero.value
          ? '（額度為 0，請安排他人還一節）'
          : '（已扣 1 額度）';
        showToast(
          '已排入「' + task + '」→ ' + f.teacherName + '　'
          + f.dateStr + ' 第' + f.period + '節' + qTip + '　未寄系統信',
          'success'
        );
      } catch (err) {
        console.error('空堂排班失敗：', err);
        showToast('空堂排班失敗：' + (err && err.message ? err.message : String(err)), 'error');
      } finally {
        loading.value = false;
        isSubmitting.value = false;
      }
    };
    bindFlagModal(showEmptySlotModal, () => { showEmptySlotModal.value = false; }, '空堂排班');

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
    const getHistoryEditDefaultSubFee = (reason, period) => {
      if (parseInt(period, 10) === 8) return PERIOD8_FEE;
      return isPublicFeeReason(reason) ? '公費代課' : '自費代課';
    };
    /** 假別變更時自動帶入預設經費（第8節／活動模式不覆寫） */
    const onLeaveReasonChange = () => {
      if (pendingRequestData.value.mode !== 'substitution') return;
      if (pendingRequestData.value.courseAdjustmentOnly) return;
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
    const setMutualCover = async (on) => {
      if (on) await ensureDAC();
      const a = getMutualPanelApi();
      if (a) a.setMutualCover(on);
    };
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
    /** 從暫定列再開模擬對照（不重寫暫定） */
    const previewMutualDraft = (d) => {
      if (!d || !d.subEmail) return;
      activeCell.value = {
        teacherEmail: d.leaveEmail,
        teacherName: d.leaveName,
        dayOfWeek: d.dayOfWeek,
        period: d.period,
        classData: {
          className: d.className || '',
          subject: d.subject || '',
          restriction: d.restriction || ''
        }
      };
      inputRequestDate.value = d.dateStr;
      selectedWeekDate.value = d.dateStr;
      prepCompare('substitution', d.subEmail);
    };

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
         hasLineTemplate, lineBatchParts, lineCopyText, showSuccessModal, buildLineBatchInviteText, DAC,
          successFlowMode, paperMode, notificationsSuppressed,
         openPaperPrintMutualDrafts: function () { return openPaperPrintMutualDrafts(); }
       });
    };
    const toggleMutualCover = async () => {
      if (!isMutualCover.value) await ensureDAC();
      const a = getMutualPanelApi();
      if (a) a.toggleMutualCover();
    };

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
       schoolSwaps.value = [];
      classDirectory.value = [];
      classViewSchedules.value = [];
      classViewSchoolSwaps.value = [];
      classViewSubstitutionRecords.value = [];
      classViewClassAwayEvents.value = [];
      classViewLoadedClass.value = '';
      substitutionRecords.value = [];
      homeroomRecords.value = [];
      homeroomAssignSelections.value = {};
       mySentRequests.value = [];
       myPendingRequests.value = [];
       adminPendingRequests.value = [];
       batchGroupExpanded.value = {};
       showMatchModal.value = false;
       showPrintPreviewModal.value = false;
      printPreview.value = null;
      printPreviewImageBusy.value = false;
      proxyTargetEmail.value = '';
      proxyTargetQuery.value = '';
      showProxyTargetDropdown.value = false;
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
    // 注意：列表／權限用被模擬者 Email；後端 API 仍用 JWT（真正送出仍是原管理員帳號）
    const devSwitchUser = (email) => {
      if (!isAdmin.value && !isSimulating.value) return;
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
          displayName: match.name + ' (模擬)',
          photoURL: 'https://www.gstatic.com/images/branding/product/1x/avatar_circle_blue_512dp.png'
        };
        const raw = match.role || 'teacher';
        userRole.value = (window.FieldMap && window.FieldMap.normalizeRole)
          ? window.FieldMap.normalizeRole(raw)
          : raw;
        proxyTargetEmail.value = '';
        // 先用目前已載入的全量資料，依「被模擬者 Email」重算待辦／送出列表
        recomputeRequestBuckets();
        loadWeeklyData().catch(function () {});
      }
    };

    // 回到管理員身分
    const restoreAdmin = () => {
      if (!originalUser.value) return;
      user.value = {
        email: originalUser.value.email,
        displayName: '管理員 (已還原)',
        photoURL: 'https://www.gstatic.com/images/branding/product/1x/avatar_circle_blue_512dp.png'
      };
      userRole.value = originalUser.value.role;
      originalUser.value = null;
      proxyTargetEmail.value = '';
      recomputeRequestBuckets();
       loadWeeklyData().catch(function () {});
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

      // OAuth 回傳 #id_token=…（prompt=select_account，每次強制選帳）
      const redirectToken = consumeOAuthRedirectToken();
      if (redirectToken) {
        try { sessionStorage.setItem('jcjh_google_id_token', redirectToken); } catch (eR) { /* ignore */ }
      }

      // 檢查是否已有登入之 Google ID Token 快取
      const idToken = sessionStorage.getItem('jcjh_google_id_token');
      if (idToken && !isTokenExpired(idToken)) {
         const payload = decodeJwt(idToken);
         if (payload) {
            if (!assertSchoolDomain(payload)) return;
            const loginMeta = await preflightGoogleLogin(payload);
            if (!loginMeta) {
              if (hasClassLink) await loadPublicClassData(pendingClassView.value || selectedClass.value);
              return;
            }
           user.value = {
            email: payload.email,
            displayName: payload.name,
            photoURL: payload.picture
          };
          loading.value = true;
          loadingMessage.value = '同步系統中...';

           try {
             await loadWeeklyData();
             if (hasClassLink) await loadPublicClassData(pendingClassView.value || selectedClass.value);
             await checkUrlCallback(user.value);
            // 資料載入與簽核 callback 後再還原分頁，避免被中間流程蓋掉
            if (!hasClassLink && !classReadonlyMode.value) restoreNavAfterLogin();
            else _navPersistReady = true;

             if (shouldAutoStartOnboarding()) {
               setTimeout(() => startOnboarding(), 800);
             }
          } catch (eRest) {
            console.error('還原登入同步失敗', eRest);
            loading.value = false;
            showToast('登入後同步失敗：' + (eRest && eRest.message ? eRest.message : eRest), 'error', 5000);
          }
        } else {
          sessionStorage.removeItem('jcjh_google_id_token');
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
        sessionStorage.removeItem('jcjh_google_id_token');
        user.value = null;
        // 免登入：?class=701 直接載入公開班級課表
        if (hasClassLink) {
          await loadPublicClassData(pendingClassView.value || selectedClass.value);
        } else {
          loading.value = false;
          restoreNavAfterLogin();
        }
      }

      // 初始化 Google Sign-in（等 GSI 腳本就緒再 init／render，避免 async 競態）
      if (googleClientId.value && !classReadonlyMode.value) {
        const onCredential = async (response) => {
          const token = response && response.credential;
          if (!token) {
            console.warn('[GSI] credential 空白', response);
            showToast('Google 未回傳登入憑證，請確認 OAuth 來源含目前網址', 'warning', 5000);
            return;
          }
          // 成功拿到票：取消「彈窗被擋」延遲提示（選帳常超過數秒，不可誤報）
          _gsiClickGen += 1;
          try { if (_gsiPopupHintTimer) { clearTimeout(_gsiPopupHintTimer); _gsiPopupHintTimer = null; } } catch (eTm) { /* ignore */ }
          try { gsiButtonError.value = ''; } catch (eClr) { /* ignore */ }
          sessionStorage.setItem('jcjh_google_id_token', token);
          const payload = decodeJwt(token);
          if (!payload) {
            showToast('無法解析 Google 登入憑證', 'error');
            return;
          }
           if (!assertSchoolDomain(payload)) return;
           const loginMeta = await preflightGoogleLogin(payload);
           if (!loginMeta) return;
           user.value = {
            email: payload.email,
            displayName: payload.name,
            photoURL: payload.picture
          };
          loading.value = true;
          loadingMessage.value = '登入成功，同步系統中...';

           try {
             await loadWeeklyData();
             if (hasClassLink) await loadPublicClassData(pendingClassView.value || selectedClass.value);
             await checkUrlCallback(user.value);
            if (!classReadonlyMode.value) restoreNavAfterLogin();
            else _navPersistReady = true;

             if (shouldAutoStartOnboarding()) {
               setTimeout(() => startOnboarding(), 800);
             }
          } catch (eLogin) {
            console.error('登入後同步失敗', eLogin);
            loading.value = false;
            showToast('登入後同步失敗：' + (eLogin && eLogin.message ? eLogin.message : eLogin), 'error', 5000);
          }
        };
        window.handleCredentialResponse = onCredential;
        window.__gsiCredentialHandler = onCredential;

        // A：定時檢查 Token，快過期就靜默換票（約每 4 分鐘）
        const tokenKeepAlive = () => {
          try {
            const tok = sessionStorage.getItem('jcjh_google_id_token');
            if (!tok || !user.value) return;
            if (typeof isTokenExpiringSoon === 'function' && isTokenExpiringSoon(tok, 6 * 60 * 1000)) {
              refreshGoogleIdToken().catch(() => {});
            }
          } catch (e) { /* ignore */ }
        };
        setInterval(tokenKeepAlive, 4 * 60 * 1000);
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible') {
            tokenKeepAlive();
            // 回到登入頁且按鈕不見時補渲染
            if (!user.value && !classReadonlyMode.value && !gsiButtonReady.value) {
              setupGoogleSignInUi();
            }
          }
        });

        // 未登入：一定要等到 GSI + 登入 DOM 就緒再畫按鈕
        if (!user.value) {
          setupGoogleSignInUi();
        } else {
          // 已登入仍 init，供 refresh token
          waitForGoogleGsi(10000).then((ok) => {
            if (ok) ensureGsiInitialized();
          });
        }
      }
    });

    // 登出回到登入畫面時重畫按鈕
    watch(user, (u, prev) => {
      if (!u && prev && !classReadonlyMode.value) {
        _gsiButtonRendered = false;
        gsiButtonReady.value = false;
        nextTick(() => setupGoogleSignInUi());
      }
    });
    


    const closeSuccessGoPending = () => {
      showSuccessModal.value = false;
      activeTab.value = 'pending';
    };
    const closeSuccessGoRecords = () => {
      showSuccessModal.value = false;
      activeTab.value = 'records';
      showMatchModal.value = false;
      showCompareModal.value = false;
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

    const getMatchSlotDateMMDD = (dayOfWeek) => {
      if (!dayOfWeek) return '';
      const dates = getExchangeWeekDates();
      if (dates && dates[dayOfWeek - 1]) {
        const baseStr = dates[dayOfWeek - 1];
        const offset = parseInt(exchangeWeekOffset.value, 10) || 0;
        if (offset === 0) return formatDateMMDD(baseStr);
        const d = new Date(String(baseStr).replace(/-/g, '/'));
        if (!isNaN(d.getTime())) {
          d.setDate(d.getDate() + offset * 7);
          return formatDateMMDD(toLocalDateStr(d));
        }
        return formatDateMMDD(baseStr);
      }
      return '';
    };

    // 返回 Vue 拋出變數
    return {
      getMatchSlotDateMMDD,
      user, userRole, loading, loadingMessage, activeTab, setActiveTab, isSimulating, originalUser, avatarSrc, handleAvatarError,
      dataUpdatedLabel, dataRefreshing, softSyncing, manualRefreshData,
      visibleTimetableTeachers, ttPage, ttPageSize, ttTotalPages, ttNeedPager, changeTtPage,
      requestWindowInfo, historyFullLoaded, historyLoadingFull, historyLoadedMonths, historyMonthLoading,
      loadHistoryMonth, setHistoryFilterMode, setHistoryTypeFilter, ensureHistoryMonthLoaded, loadFullSemesterHistory, reloadWindowedHistory,
      selectedMobileDay, isMobile, checkMobile, initMobileDay,
      currentSemester, availableSemesters, currentSemesterName, semestersList, showSemesterModal, semesterModalMode, semesterForm,
       currentWeekDates, compareWeekDatesA, compareWeekDatesB, compareWeekSelectionA, compareWeekSelectionB, compareDisplayDatesA, compareDisplayDatesB, setCompareWeekSelection, batchCompareWeekIndex, batchCompareWeekTotal, batchCompareWeekSlotCount, shiftBatchCompareWeek, isCrossWeekExchange, getExchangeEndpointText, selectedWeekDate, currentWeekNumber,
       classList, classSchedules, selectedClass, classReadonlyMode, classViewerReadonly, selectClassForView, getClassReadonlyLink, copyClassReadonlyLink,
       searchQuery, selectedSubject, teachersList, allSchedules, schoolSwaps, substitutionRecords, homeroomRecords, requestsList,
      mySentRequests, myPendingRequests, adminPendingRequests, allPendingRequests,
       matchMode, activeCell, inputRequestDate, recommendedTeachers, recommendationLoading,
       trianglePickB, trianglePickC, triangleNote, triangleSubmitting, triangleCandidates, triangleCandidateB, triangleCandidateCList, triangleCandidateC,
        triangleParticipants, triangleLegs, trianglePreviewRows, trianglePreviewWeekDates, triangleTimetablePreview, triangleValidation, triangleReady, formatTriangleSlot, openTriangleTimetablePreview, submitTriangleRequest,
      batchSelectMode, batchSlots, showBatchConfirmModal, batchSubTeacher, batchReason, batchSubFee, batchNote,
      isMutualCover, toggleMutualCover, setMutualCover, MUTUAL_COVER_FEE, ACTIVITY_PUBLIC_FEE, QUOTA_DEDUCT_FEE, PERIOD8_FEE,
      mutualAwayClasses, mutualActivityStart, mutualActivityEnd, setMutualActivityThisWeek,
      toggleMutualAwayClass, selectAwayGrade, mutualCoverStats,
      mutualLeadEmails, toggleMutualLead, isMutualLead, onMutualLeadChipClick, jumpToTeacherTimetable,
      mutualSkipNotify, directApproveSkipNotify, mutualNote, mutualDrafts, getMutualDraftAt, removeMutualDraft, clearMutualDrafts,
      clearMutualPanel, assignMutualDraftFromMatch, previewMutualDraft, submitAllMutualDrafts, recalculateMutualQuotasFromActivity,
      persistMutualPanelDraft, isAwayClassCell,
      batchAssignMode, batchActiveSlotKey, isBatchMatchFlow, isBatchPerSlotMode, batchAssignedCount, batchAllSlotsAssigned, batchActiveSlot,
      batchCompareViewEmail, batchCompareSubGroups, setBatchCompareViewEmail, resolveCompareBEmail,
      setBatchAssignMode, selectBatchSlotForMatch, assignBatchSlotSub, clearBatchSlotSub, prepBatchPerSlotCompare,
      toggleBatchSelectMode, clearBatchSlots, isBatchSlotSelected,
      openBatchMatch, prepBatchCompare, executeBatchSubmit,
      matchSearchQuery, matchDisplayCount, matchShowNoTeacherWarning, matchEmptyReasons,
      filteredRecommendedTeachers, displayedRecommendedTeachers,
       exchangeTeacherEmail, exchangeTeacherClasses, exchangePeriodId, exchangeTargetDate, exchangeWeekOffset,
       exchangeWeekdayFilter, exchangeWeekdayOptions, setExchangeWeekdayFilter, filteredExchangeList,
       showCompareModal, showTriangleTimetablePreview, showMatchModal, pendingRequestData, combinedReturnCandidates, askFirstLineText, askFirstLineDraft, selectedRecordIds, showDevDropdown, devTeacherQuery, filteredDevTeachers,
             paperPrintDraft, paperSignatureByTeacher, openPaperPrintDraftFromCompare, openPaperPrintForRequest, openPaperPrintMutualDrafts, openTrianglePaperPreview, printPaperDraft, openPaperDraftPreview,
           showPrintPreviewModal, printPreview, printPreviewImageBusy, openPrintPreview, closePrintPreview, confirmPrintPreview, copyPrintPreviewImage, downloadPrintPreviewImage,
      showDetailModal, consecAlertsA, consecAlertsB, detailRequest, detailSubRecord,
       showLineMessageModal, lineMessageTitle, lineMessageText, openLineMessageEditor, copyEditedLineMessage, sendEditedLineMessage,
       showSuccessModal,
       successModalTitle, successModalMessage, successFlowMode, successActionRequests, lineCopyText, hasLineTemplate, lineBatchParts,
       openSuccessPrintPreview, addSuccessToCalendar,
       copyLineMessage, sendLineMessage, copyLineBatchPart, sendLineBatchPart, copyLineMessageForRequest, addToGoogleCalendar, downloadIcsCalendar, addEventToCalendar, printSingleRequest, showDetailForRecord, getTargetSubject, getTargetClassAndSubject, getOriginalRequestSubject, getOriginalRequestClass, getOriginalTargetSubject, getOriginalTargetClass, getTriangleGroupRequests,
      adminSubTab,
      showImportTeachersModal, teacherExcelData, teacherExcelHeaders, teacherMappingFields, teacherImportPreview, runTeacherImportPreview, handleTeacherExcelChange, importTeachersBatch,
      isScheduleEditMode, showScheduleEditModal, scheduleForm,
       showTeacherModal, teacherModalMode, teacherForm, showOvertimePlanModal, overtimePlanTeacher, overtimePlanRows,
      showQuotaLedgerModal, quotaLedgerLoading, quotaLedgerTeacher, quotaLedgerRows, openQuotaLedger, closeQuotaLedger, quotaTypeClass,
      showEmptySlotModal, emptySlotForm, emptySlotQuotaZero, openEmptySlotAssign, openEmptySlotFromDetail, closeEmptySlotModal, executeEmptySlotAssign,
      reportMonth, reportWeeksCount, monthlyReportData,
      accountingPeriod, accountingExportLoading,
      excelData, excelHeaders, mappingFields, importPreview, runImportPreview, downloadScheduleTemplate, downloadCurrentSchedules,
         directApproveMode, onlineSubstitutionEnabled, paperMode, paperFlow, notificationsSuppressed, setOnlineSubstitutionEnabled, googleClientId, gasApiUrl, saveClientSettings,
      isSubFeeLockedToSelf, isPeriod8FeeLocked, quotaDeductPreview, quotaDeductInsufficient, switchQuotaDeductToSelfPay, hasSubTeacherConflict,
      isAdmin, isStaff, canViewAllTimetables, canStaffProxySubmit, isProxySubmitActive, isProxySubmitGranted,
      proxySubmitEnabled, proxySubmitEnabledBy, proxySubmitEnabledAt, setProxySubmitEnabled,
      proxySubmitEmails, proxyGrantQuery, proxyGrantCandidateTeachers, proxyGrantedTeachers,
      isProxySubmitEmailGranted, toggleProxySubmitEmail, clearAllProxySubmitEmails, persistProxySubmitEmails,
      proxyTargetEmail, proxyTargetName, proxyTargetQuery, showProxyTargetDropdown, filteredProxyTeachers,
      setProxyTarget, clearProxyTarget, canOperateOnTeacherEmail, ensureProxyTargetForTeacher,
       userRoleText, subjectsList, filteredTeachers, displayTimetableTeachers, pendingCount, myInviteCount, adminTodoCount, hasQuickTodo, quickTodoSentOpen, allTeachersList, teachersListDetails, accountingPlanOptions, getExpensePlanSummary,
      pendingHomeroomRecords, homeroomAssignSelections, homeroomRecordsLoading, getHomeroomCoverCandidates, loadHomeroomRecords, assignHomeroomTeacher, homeroomTeachersList, onHomeroomInputSelect, onManualCoverTeacherInput,
      showManualHomeroomModal, homeroomStatusFilter, manualHomeroomForm, openManualHomeroomModal, onManualHomeroomLeaveTeacherChange, currentMonthHomeroomRecords, currentMonthHomeroomFeeTotal, currentMonthHomeroomAssignedCount, currentMonthHomeroomPendingCount, saveManualHomeroomRecord, deleteHomeroomRecord,
      matchPreview,
       exchangeTeachersList, myTeacherProfile, isRequestValid, isHistoryExchangeType, filteredHistoryRecords, formatRequestApplicationDate,
       dateFilteredHistoryRecords, paginatedHistoryRecords, historyTotalPages,
       historyFilterMode, historyTypeFilter, historyFilterDate, historySearchQuery, historyPage, historyPageSize,
        pendingSearchQuery, getLeaveTimeDefaults, getLeaveTimePresetRange, setLeaveTimePreset, updatePendingLeaveTime, toggleCourseAdjustmentOnly,
      showHistoryEditModal, historyEditForm, leaveReasonOptions, onLeaveReasonChange, defaultSubFeeForReason,
       pendingMyPendingPage, pendingMySentPage, pendingAdminPage,
       paginatedMyPending, paginatedMySent, paginatedAdminPending,
       pendingMyPendingTotal, pendingMySentTotal, pendingAdminTotal, filteredAdminPendingRequests,
         isBatchGroupExpanded, toggleBatchGroup, getBatchGroupSlotSummary, getBatchGroupTeacherSummary, getBatchGroupStatusText, getBatchGroupStatusClass, isAdminPendingPageFullySelected,
      reportMonthOptions, personalChanges, recommendedExchangeList, displayedExchangeList,
      loginWithGoogle, logout, gsiButtonReady, gsiButtonError, gsiLoggingIn, reloadGsiLoginButton,
      changeWeek,       getPeriodTimeSpan, getWeekDayText, formatDateMMDD,
       timetablePeriods, getPeriodLabel, formatPeriodText, isLunchPeriod, getPeriodClass, formatClassName, isCombinedClass, getScheduleSpecialTags, hasScheduleSpecialTag,
      getClassCellClassForDate, getClassCellClassForClass, getScheduleForDate, weekScheduleGrid, cellFromGrid, handleCellClick, handleClassCellClick,
      isMatchSourceCell, isMatchSourceEntry, isMatchHoverCell, isMatchHoverEntry,
      selectMatchPreviewSub, selectMatchPreviewExchange, clearMatchPreview, closeMatchModal, isMatchPreviewSelected,
       selectedClassDate, selectedClassWeekDates, classWeekNumber, classSubstitutionMap, classChangeSummary, getClassChangeTypeLabel, changeClassWeek, goToClassThisWeek,
       prepCompare, startCombinedReturn, getCompareCellText, getCompareCellClass, executeSubmitRequest, isSubmitting,
       getStatusText, changeMatchMode, respondToRequest, respondToBatch, adminApprove, adminReject, cancelRequest, deleteSubstitutionRecord, loadMoreMatches,
       isTriangleRequest, isExchangeLikeRequest,
        triangleCandidateSearch, triangleCandidateDisplayCount, triangleCandidateOptions, triangleCandidateCOptions, triangleCandidateCReadyCount, triangleCandidateBOptions, triangleCandidateBReadyCount, displayedTriangleBOptions, displayedTriangleCOptions, triangleCandidateIsRestricted, selectTriangleCandidateB, selectTriangleCandidateC, loadMoreTriangleCandidates,
        formatRequestSummary, formatLeaveClassSlot, formatExchangeClassSlot, formatQuickTodoTitle, formatHistoryLeaveSlot, formatHistoryExchangeSlot, getRequestRiskTags, getRequestTypeTags, getApproveRiskFlags, formatApproveBatchRiskSummary, isHistoryLeaveRechanged, isHistoryExchangeRechanged, isRequestLeaveRechanged, isRequestExchangeRechanged, getCellPlainStatus, getRequestProgressSteps, isPaperFlowRequest, isLeaveClassRestricted, isExchangeClassRestricted, isHistoryLeaveRestricted, isHistoryExchangeRestricted,
      dashboardScope, dashboardStats,
       selectedAdminPendingIds, isAdminPendingSelected, toggleAdminPendingSelect, toggleSelectAllAdminPending, clearAdminPendingSelection,
       isAdminBatchGroupSelected, toggleAdminBatchGroupSelection,
        batchAdminApprove, batchAdminReject, openBatchPendingPrintPreview, lastBatchPrintIds, showBatchPrintPrompt, printLastBatchNotices, dismissBatchPrintPrompt,
       closeSuccessGoPending, closeSuccessGoRecords, closeSuccessStayTimetable, closeSuccessCopyLine,
       openScheduleEditModal, saveScheduleCell, clearScheduleCell, updateTeacherBaseHours, pickScheduleAttr, getOvertimeExpenseSourceOptions, openOvertimePlanModal, saveOvertimePlan,
      openAddTeacherModal, openEditTeacherModal, saveTeacher, deleteTeacher,
        handleFileChange, getMappingLabel, importSchedules, migrateNameKeySchema, toggleSelectAllRecords, isHistoryRecordSelected, isHistoryBatchGroupSelected, toggleHistoryBatchGroupSelection, loadTeacherClassesForExchange,
      printSelectedForms, sendSelectedBatchNotices, calculateMonthlyReport, exportReportToExcel, exportSubFeeToExcel,
      schoolExportStart, schoolExportEnd, schoolExportIncludeWeekend, schoolExportOnlyChanged,
      schoolExportSelectedEmails, schoolExportTeacherFilter, filteredSchoolExportTeachers,
      isSchoolExportTeacherSelected, toggleSchoolExportTeacher, selectAllSchoolExportTeachers, clearSchoolExportTeachers,
      setSchoolExportThisWeek, exportSchoolTimetableWord,
      exportActivityCoverWord,
      invigilationExportTitle, exportInvigilationWorkbook,
      devSwitchUser, restoreAdmin,
       getTeacherNameByEmail, getTeacherSubjectByEmail, getTeacherTimetableHours, getRealTeacherName, startSecondSub,
        getTeacherJobTitleByEmail, isHomeroomTeacher,
      getSubjectStyle, getClassBadgeStyle,
      changeHistoryPage, openHistoryEditModal, saveHistoryEdit, onHistoryEditDateChange, changePendingPage,
      openAddSemesterModal, openEditSemesterModal, saveSemester, deleteSemester, setDefaultSemester,
      // 工具函數
      toLocalDateStr,
      // 單/雙週課輔課
      isSingleWeek, semesterStartDate,
       // 空堂事件
        classAwayEvents, semesterEndDate, activeAwayBanner, isClassAwayOnDate, getClassAwayEventName,
       showClassAwayModal, classAwayModalMode, classAwayForm,
       openAddClassAwayModal, openEditClassAwayModal, toggleClassAwayFormClass,
       isClassAwayFormClassSelected, selectClassAwayGrade, saveClassAwayEvent, deleteClassAwayEvent,
       // 全校日期節次對調
       schoolSwapRows, showSchoolSwapModal, schoolSwapModalMode, schoolSwapSaving, schoolSwapForm,
       schoolSwapWeekdayText, openAddSchoolSwapModal, openEditSchoolSwapModal, saveSchoolSwap, deleteSchoolSwap,
      mutualImportableEvents, mutualImportEventId, applyClassAwayEventById, applyClassAwayToMutualPanel,
      // 新手引導
      showOnboarding, onboardingStep, onboardingSteps,
      startOnboarding, nextOnboardingStep, prevOnboardingStep, skipOnboarding,
      tourDemoInvite, tourDemoInviteRespond
    };
  }
}).mount('#app');



