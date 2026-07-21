/**
 * ui-activity.js — 空堂事件 + 活動互代（方案甲）
 * 合併：class-away-admin / mutual-bridge / mutual-panel-state / mutual-submit / batch-submit
 * 對外 API 不變：UiClassAwayAdmin, UiMutualBridge, UiMutualPanelState, UiMutualSubmit, UiBatchSubmit
 */
/**
  * 後台：空堂事件 CRUD（從 app.js 抽出）
 * create(deps) → { refs + methods } 供 Vue setup 解構
 */
window.UiClassAwayAdmin = (function () {
  function create(deps) {
    var ref = deps.ref;
    var callGasApi = deps.callGasApi;
    var showToast = deps.showToast;
    var showConfirm = deps.showConfirm;
    var classAwayEvents = deps.classAwayEvents; // ref
    var classList = deps.classList; // computed/ref
    var currentSemester = deps.currentSemester; // ref
    var loading = deps.loading; // ref
    var clearScheduleCache = deps.clearScheduleCache || function () {};
    var softRefreshInBackground = deps.softRefreshInBackground || function () {};

    var showClassAwayModal = ref(false);
    var classAwayModalMode = ref('add');
    var classAwayForm = ref({
      id: '', name: '', startDate: '', endDate: '',
      classes: [], billingRule: 'keep', forMutual: true, enabled: true, note: ''
    });

    function sanitizeClassNames(list) {
      if (window.DomainClassAway && window.DomainClassAway.parseClassList) {
        return window.DomainClassAway.parseClassList(list || []);
      }
      return (list || []).map(function (c) { return String(c || '').trim(); })
        .filter(function (c) { return c && !/^0+$/.test(c); });
    }

    function openAddClassAwayModal() {
      classAwayModalMode.value = 'add';
      classAwayForm.value = {
        id: '', name: '', startDate: '', endDate: '',
        classes: [], billingRule: 'keep', forMutual: true, enabled: true, note: ''
      };
      showClassAwayModal.value = true;
    }

    function openEditClassAwayModal(ev) {
      classAwayModalMode.value = 'edit';
      var clean = sanitizeClassNames(ev.classes || []);
      classAwayForm.value = {
        id: ev.id,
        name: ev.name || '',
        startDate: ev.startDate || '',
        endDate: ev.endDate || '',
        classes: clean,
        billingRule: ev.billingRule === 'reduce' ? 'reduce' : 'keep',
        forMutual: !!ev.forMutual,
        enabled: ev.enabled !== false,
        note: ev.note || ''
      };
      showClassAwayModal.value = true;
    }

    function toggleClassAwayFormClass(cls) {
      var c = (window.DomainClassAway && window.DomainClassAway.normClass)
        ? window.DomainClassAway.normClass(cls)
        : String(cls || '').trim();
      if (!c) return;
      var arr = sanitizeClassNames(classAwayForm.value.classes || []);
      var i = arr.indexOf(c);
      if (i >= 0) arr.splice(i, 1);
      else arr.push(c);
      classAwayForm.value = Object.assign({}, classAwayForm.value, { classes: arr.sort() });
    }

    function isClassAwayFormClassSelected(cls) {
      var c = (window.DomainClassAway && window.DomainClassAway.normClass)
        ? window.DomainClassAway.normClass(cls)
        : String(cls || '').trim();
      return sanitizeClassNames(classAwayForm.value.classes || []).indexOf(c) >= 0;
    }

    function selectClassAwayGrade(grade) {
      if (!window.DomainClassAway) return;
      var all = (classList && classList.value) ? classList.value : [];
      var gradeClasses = window.DomainClassAway.filterClassesByGrade(all, grade);
      var set = {};
      sanitizeClassNames(classAwayForm.value.classes || []).forEach(function (c) { set[c] = 1; });
      gradeClasses.forEach(function (c) { set[c] = 1; });
      classAwayForm.value = Object.assign({}, classAwayForm.value, {
        classes: Object.keys(set).sort(function (a, b) {
          return a.localeCompare(b, 'zh-Hant', { numeric: true });
        })
      });
    }

    async function saveClassAwayEvent() {
      var f = classAwayForm.value;
      if (!String(f.name || '').trim()) { showToast('請填事件名稱', 'info'); return; }
      if (!f.startDate) { showToast('請填起日', 'info'); return; }
      var cleanClasses = sanitizeClassNames(f.classes || []);
      if (!cleanClasses.length) { showToast('請至少勾選一個有效班級（勿含 000）', 'info'); return; }
      loading.value = true;
      try {
        var id = f.id || ('cae_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8));
        var classListStr = cleanClasses.join(',');
        var sheetRow = {
          "事件ID": String(id),
          "學期代號": currentSemester.value,
          "事件名稱": String(f.name).trim(),
          "起日": String(f.startDate || '').slice(0, 10),
          "迄日": f.endDate ? String(f.endDate).slice(0, 10) : '',
          "班級清單": "'" + classListStr,
          "鐘點規則": f.billingRule === 'reduce' ? 'reduce' : 'keep',
          "可進互代": f.forMutual ? 'TRUE' : 'FALSE',
          "啟用": f.enabled !== false ? 'TRUE' : 'FALSE',
          "備註": f.note || ''
        };
        await callGasApi('saveClassAwayEvent', sheetRow);
        var mapped = window.FieldMap.mapClassAwayEvent(
          Object.assign({}, sheetRow, { "班級清單": classListStr })
        );
        mapped.classes = cleanClasses.slice();
        var list = classAwayEvents.value.slice();
        var idx = list.findIndex(function (x) { return x.id === id; });
        if (idx >= 0) list[idx] = mapped;
        else list.push(mapped);
        classAwayEvents.value = list;
        showClassAwayModal.value = false;
        showToast('空堂事件已儲存（' + mapped.classes.length + ' 班）', 'success');
        clearScheduleCache();
        softRefreshInBackground({ force: true, delay: 700 });
      } catch (e) {
        showToast('儲存失敗：' + (e && e.message ? e.message : String(e)), 'error');
      } finally {
        loading.value = false;
      }
    }

    async function deleteClassAwayEvent(ev) {
      if (!ev || !ev.id) return;
      if (!await showConfirm('確定刪除空堂事件「' + (ev.name || ev.id) + '」？')) return;
      loading.value = true;
      try {
        await callGasApi('deleteClassAwayEvent', { id: ev.id });
        classAwayEvents.value = classAwayEvents.value.filter(function (x) { return x.id !== ev.id; });
        showToast('已刪除', 'success');
        clearScheduleCache();
        softRefreshInBackground({ force: true, delay: 700 });
      } catch (e) {
        showToast('刪除失敗：' + (e && e.message ? e.message : String(e)), 'error');
      } finally {
        loading.value = false;
      }
    }

    return {
      showClassAwayModal: showClassAwayModal,
      classAwayModalMode: classAwayModalMode,
      classAwayForm: classAwayForm,
      openAddClassAwayModal: openAddClassAwayModal,
      openEditClassAwayModal: openEditClassAwayModal,
      toggleClassAwayFormClass: toggleClassAwayFormClass,
      isClassAwayFormClassSelected: isClassAwayFormClassSelected,
      selectClassAwayGrade: selectClassAwayGrade,
      saveClassAwayEvent: saveClassAwayEvent,
      deleteClassAwayEvent: deleteClassAwayEvent,
      sanitizeClassNames: sanitizeClassNames
    };
  }

  return { create: create };
})();


/**
 * 活動互代 ↔ 空堂事件橋接（帶入事件、進度統計）
 * 從 app.js 抽出；暫定送出等仍留在 app
 */
window.UiMutualBridge = (function () {
  function create(deps) {
    var ref = deps.ref;
    var computed = deps.computed;
    var showToast = deps.showToast;
    var classAwayEvents = deps.classAwayEvents;
    var classList = deps.classList;
    var semesterEndDate = deps.semesterEndDate;
    var mutualActivityStart = deps.mutualActivityStart;
    var mutualActivityEnd = deps.mutualActivityEnd;
    var mutualAwayClasses = deps.mutualAwayClasses;
    var mutualNote = deps.mutualNote;
    var mutualLeadEmails = deps.mutualLeadEmails;
    var mutualDrafts = deps.mutualDrafts;
    var isMutualCover = deps.isMutualCover;
    var batchSlots = deps.batchSlots;
    var allSchedules = deps.allSchedules;
    var requestsList = deps.requestsList;
    var teachersList = deps.teachersList;
    var currentWeekDates = deps.currentWeekDates;
    var getScheduleForDate = deps.getScheduleForDate;
    var persistMutualPanelDraft = deps.persistMutualPanelDraft || function () {};
    var clearScheduleCache = deps.clearScheduleCache || function () {};
    var ensureMutualActivityRange = deps.ensureMutualActivityRange || function () {};
    var DAC = deps.DAC || function () { return window.DomainActivityCover; };

    var mutualImportableEvents = computed(function () {
      return (classAwayEvents.value || []).filter(function (e) {
        return e.enabled !== false && e.forMutual;
      });
    });
    var mutualImportEventId = ref('');

    function applyClassAwayEventById(eventId) {
      var id = String(eventId || '').trim();
      mutualImportEventId.value = id;
      if (!id) return;
      var list = mutualImportableEvents.value || [];
      var ev = list.find(function (e) { return e.id === id; })
        || (classAwayEvents.value || []).find(function (e) { return e.id === id; });
      if (!ev) {
        showToast('找不到該空堂事件', 'warning');
        return;
      }
      var classes = [];
      if (window.DomainClassAway && window.DomainClassAway.parseClassList) {
        classes = window.DomainClassAway.parseClassList(ev.classes || ev.classList || '');
      } else if (Array.isArray(ev.classes)) {
        classes = ev.classes.map(function (c) { return String(c || '').trim(); }).filter(Boolean);
      } else {
        classes = String(ev.classes || '').split(/[,，、\s]+/).map(function (c) { return c.trim(); }).filter(Boolean);
      }
      var known = {};
      ((classList && classList.value) || []).forEach(function (c) {
        known[String(c).trim()] = 1;
      });
      var matched = classes.filter(function (c) { return known[c]; });
      if (matched.length) classes = matched;

      mutualActivityStart.value = ev.startDate || '';
      var end = ev.endDate || (semesterEndDate && semesterEndDate.value) || '';
      mutualActivityEnd.value = end;
      mutualAwayClasses.value = classes.slice().sort();
      if (ev.name) {
        var rangeTip = ev.startDate ? (ev.startDate + (end ? '～' + end : '')) : '';
        mutualNote.value = rangeTip ? (ev.name + ' ' + rangeTip) : String(ev.name);
      }
      persistMutualPanelDraft();
      clearScheduleCache();
      if (!classes.length) {
        showToast('已帶入「' + ev.name + '」的日期，但事件沒有班級清單，請手動勾外出班', 'warning');
      } else {
        showToast(
          '已帶入「' + ev.name + '」：' + classes.length + ' 班 · '
          + (mutualActivityStart.value || '？') + '～' + (mutualActivityEnd.value || '學期結束'),
          'success'
        );
      }
    }

    function applyClassAwayToMutualPanel() {
      if (!mutualImportEventId.value) {
        showToast('請先選擇一個空堂事件', 'info');
        return;
      }
      applyClassAwayEventById(mutualImportEventId.value);
    }

    var mutualCoverStats = computed(function () {
      var dac = DAC();
      if (!dac || !dac.buildStats) {
        return {
          awayClasses: 0, releasedSlots: 0, mutualDone: 0, publicDone: 0,
          arranged: 0, drafted: 0, demand: 0, remaining: 0, leaveTeachers: 0,
          pendingSelected: 0, byLeaders: [], rangeDays: 0, rangeLabel: ''
        };
      }
      if (isMutualCover.value) ensureMutualActivityRange();
      var leaders = (mutualLeadEmails.value || []).map(function (em) {
        var t = (teachersList.value || []).find(function (x) {
          return x.email && String(x.email).toLowerCase() === String(em).toLowerCase();
        });
        return { email: em, name: t ? t.name : em };
      });
      var isSingleWeekFn = deps.isSingleWeek;
      return dac.buildStats({
        active: !!isMutualCover.value,
        awayClasses: mutualAwayClasses.value,
        startDate: mutualActivityStart.value,
        endDate: mutualActivityEnd.value,
        allSchedules: allSchedules.value,
        requests: requestsList.value,
        weekDates: currentWeekDates.value,
        leaderEmails: leaders,
        leaveEmails: leaders.map(function (l) { return l.email; }),
        teachers: teachersList.value,
        pendingDrafts: isMutualCover.value ? (mutualDrafts.value || []) : [],
        pendingSlots: isMutualCover.value ? (batchSlots.value || []) : [],
        getScheduleForDate: getScheduleForDate,
        isSingleWeek: typeof isSingleWeekFn === 'function' ? isSingleWeekFn : null
      });
    });

    return {
      mutualImportableEvents: mutualImportableEvents,
      mutualImportEventId: mutualImportEventId,
      applyClassAwayEventById: applyClassAwayEventById,
      applyClassAwayToMutualPanel: applyClassAwayToMutualPanel,
      mutualCoverStats: mutualCoverStats
    };
  }

  return { create: create };
})();


/**
 * 活動互代面板：localStorage 暫存、外出班／帶隊、暫定草稿 CRUD、累加額度
 * （暫定一次送出仍在 app.js）
 */
window.UiMutualPanelState = (function () {
  var LS_KEY = 'jcjh_mutual_panel_draft_v1';

  function mutualDraftKey(leaveEmail, dateStr, period) {
    return String(leaveEmail || '').toLowerCase() + '|' + dateStr + '|' + period;
  }

  function create(deps) {
    var showToast = deps.showToast;
    var showConfirm = deps.showConfirm;
    var callGasApi = deps.callGasApi;
    var isAdmin = deps.isAdmin;
    var loading = deps.loading;
    var loadingMessage = deps.loadingMessage;
    var isMutualCover = deps.isMutualCover;
    var mutualAwayClasses = deps.mutualAwayClasses;
    var mutualLeadEmails = deps.mutualLeadEmails;
    var mutualSkipNotify = deps.mutualSkipNotify;
    var mutualNote = deps.mutualNote;
    var mutualDrafts = deps.mutualDrafts;
    var mutualActivityStart = deps.mutualActivityStart;
    var mutualActivityEnd = deps.mutualActivityEnd;
    var currentWeekDates = deps.currentWeekDates;
    var classList = deps.classList;
    var teachersList = deps.teachersList;
    var allSchedules = deps.allSchedules;
    var requestsList = deps.requestsList;
    var activeCell = deps.activeCell;
    var inputRequestDate = deps.inputRequestDate;
    var recommendedTeachers = deps.recommendedTeachers;
    var showMatchModal = deps.showMatchModal;
    var pendingRequestData = deps.pendingRequestData;
    var batchSubFee = deps.batchSubFee;
    var directApproveMode = deps.directApproveMode;
    var ACTIVITY_PUBLIC_FEE = deps.ACTIVITY_PUBLIC_FEE;
    var PERIOD8_FEE = deps.PERIOD8_FEE;
    var getTeacherNameByEmail = deps.getTeacherNameByEmail;
    var softRefreshInBackground = deps.softRefreshInBackground || function () {};
    var defaultSubFeeForReason = deps.defaultSubFeeForReason || function () { return '自費代課'; };
    var getScheduleForDate = deps.getScheduleForDate;
    var classAwayEvents = deps.classAwayEvents;
    var getMutualImportEventId = deps.getMutualImportEventId || function () { return ''; };
    var DAC = deps.DAC || function () { return window.DomainActivityCover; };

    function persistMutualPanelDraft() {
      try {
        localStorage.setItem(LS_KEY, JSON.stringify({
          awayClasses: mutualAwayClasses.value || [],
          leadEmails: mutualLeadEmails.value || [],
          skipNotify: !!mutualSkipNotify.value,
          note: mutualNote.value || '',
          drafts: mutualDrafts.value || [],
          start: mutualActivityStart.value || '',
          end: mutualActivityEnd.value || '',
          panelOpen: !!isMutualCover.value
        }));
      } catch (e) { /* ignore */ }
    }

    function restoreMutualPanelDraft() {
      try {
        var raw = localStorage.getItem(LS_KEY);
        if (!raw) return null;
        return JSON.parse(raw);
      } catch (e) {
        return null;
      }
    }

    function applyMutualPanelDraft(saved) {
      if (!saved || typeof saved !== 'object') return;
      if (Array.isArray(saved.awayClasses)) mutualAwayClasses.value = saved.awayClasses.slice();
      if (Array.isArray(saved.leadEmails)) mutualLeadEmails.value = saved.leadEmails.slice();
      if (typeof saved.skipNotify === 'boolean') mutualSkipNotify.value = saved.skipNotify;
      if (typeof saved.note === 'string') mutualNote.value = saved.note;
      if (Array.isArray(saved.drafts)) mutualDrafts.value = saved.drafts.slice();
      if (saved.start) mutualActivityStart.value = saved.start;
      if (saved.end) mutualActivityEnd.value = saved.end;
    }

    function setMutualActivityThisWeek() {
      var week = currentWeekDates.value || [];
      mutualActivityStart.value = week[0] || '';
      mutualActivityEnd.value = week[4] || week[0] || '';
      persistMutualPanelDraft();
    }

    function ensureMutualActivityRange() {
      var week = currentWeekDates.value || [];
      if (!mutualActivityStart.value && week[0]) mutualActivityStart.value = week[0];
      if (!mutualActivityEnd.value && week[4]) mutualActivityEnd.value = week[4];
    }

    async function clearMutualPanel() {
      var hasData = (mutualAwayClasses.value || []).length
        || (mutualLeadEmails.value || []).length
        || (mutualDrafts.value || []).length
        || String(mutualNote.value || '').trim();
      if (hasData) {
        var ok = await showConfirm(
          '將清空外出班、帶隊老師、暫定安排與統一備註（期間改回本週）。\n確定？',
          '一鍵清空活動互代'
        );
        if (!ok) return;
      }
      mutualAwayClasses.value = [];
      mutualLeadEmails.value = [];
      mutualDrafts.value = [];
      mutualNote.value = '';
      mutualSkipNotify.value = true;
      setMutualActivityThisWeek();
      persistMutualPanelDraft();
      showToast('已清空活動互代面板', 'info');
    }

    function toggleMutualLead(email) {
      var em = String(email || '').trim();
      if (!em) return;
      var arr = mutualLeadEmails.value.slice();
      var key = em.toLowerCase();
      var i = arr.findIndex(function (e) { return String(e).toLowerCase() === key; });
      if (i >= 0) arr.splice(i, 1);
      else arr.push(em);
      mutualLeadEmails.value = arr;
      persistMutualPanelDraft();
    }

    function isMutualLead(email) {
      var key = String(email || '').toLowerCase();
      return (mutualLeadEmails.value || []).some(function (e) {
        return String(e).toLowerCase() === key;
      });
    }

    function toggleMutualAwayClass(cls) {
      var dac = DAC();
      if (!dac) return;
      mutualAwayClasses.value = dac.toggleAwayClass(mutualAwayClasses.value, cls);
      persistMutualPanelDraft();
    }

    function selectAwayGrade(grade) {
      var dac = DAC();
      if (!dac) return;
      mutualAwayClasses.value = dac.toggleAwayGrade(
        (classList && classList.value) || [],
        mutualAwayClasses.value,
        grade
      );
      persistMutualPanelDraft();
    }

    function getMutualDraftAt(leaveEmail, dateStr, period) {
      var key = mutualDraftKey(leaveEmail, dateStr, period);
      return (mutualDrafts.value || []).find(function (d) { return d.key === key; }) || null;
    }

    function removeMutualDraft(key) {
      mutualDrafts.value = mutualDrafts.value.filter(function (d) { return d.key !== key; });
      persistMutualPanelDraft();
    }

    function clearMutualDrafts() {
      mutualDrafts.value = [];
      persistMutualPanelDraft();
      showToast('已清除全部暫定', 'info');
    }

    function activityBalanceCtx(extra) {
      var ex = extra || {};
      var excludeDraftKey = ex.excludeDraftKey || '';
      if (!excludeDraftKey && ex.includeSelfDraft !== true && activeCell.value && inputRequestDate.value) {
        try {
          var leave = activeCell.value.teacherEmail;
          var dateStr = inputRequestDate.value;
          var period = activeCell.value.period;
          if (leave && dateStr && getMutualDraftAt(leave, dateStr, period)) {
            excludeDraftKey = mutualDraftKey(leave, dateStr, period);
          }
        } catch (e) { /* ignore */ }
      }
      var drafts = (ex.pendingDrafts !== undefined) ? ex.pendingDrafts : (mutualDrafts.value || []);
      var targetPeriod = (ex.targetPeriod != null)
        ? ex.targetPeriod
        : (activeCell.value && activeCell.value.period != null ? activeCell.value.period : null);
      return {
        awayClasses: mutualAwayClasses.value,
        startDate: mutualActivityStart.value,
        endDate: mutualActivityEnd.value,
        weekDates: currentWeekDates.value,
        allSchedules: allSchedules.value,
        requests: requestsList.value,
        teachers: teachersList.value,
        pendingDrafts: drafts,
        excludeDraftKey: excludeDraftKey,
        targetPeriod: targetPeriod,
        period: targetPeriod,
        getScheduleForDate: getScheduleForDate
      };
    }

    function patchLocalMutualQuota(email, nextQuota) {
      var em = String(email || '').toLowerCase();
      var list = teachersList.value.slice();
      var i = list.findIndex(function (t) {
        return t.email && String(t.email).toLowerCase() === em;
      });
      if (i < 0) return;
      list[i] = Object.assign({}, list[i], {
        mutualQuota: Math.max(0, parseInt(nextQuota, 10) || 0)
      });
      teachersList.value = list;
    }

    /** 從空堂事件解析發放用的 eventId / eventName */
    function resolveEarnEventFromClassAway() {
      var events = (classAwayEvents && classAwayEvents.value) ? classAwayEvents.value : [];
      var selectedId = String(getMutualImportEventId() || '').trim();
      var hit = null;
      if (selectedId) {
        hit = events.find(function (e) { return String(e.id) === selectedId; }) || null;
      }
      // 未選下拉：用期間＋外出班對可進互代事件做最佳匹配
      if (!hit && events.length) {
        var start = String(mutualActivityStart.value || '').slice(0, 10);
        var end = String(mutualActivityEnd.value || '').slice(0, 10);
        var awaySet = {};
        (mutualAwayClasses.value || []).forEach(function (c) {
          var k = String(c || '').trim();
          if (k) awaySet[k] = true;
        });
        var best = null;
        var bestScore = -1;
        events.forEach(function (e) {
          if (!e || e.enabled === false) return;
          if (e.forMutual === false) return;
          var es = String(e.startDate || '').slice(0, 10);
          var ee = String(e.endDate || '').slice(0, 10);
          var score = 0;
          if (start && es && start === es) score += 3;
          if (end && ee && end === ee) score += 2;
          if (start && es && !end && start === es) score += 1;
          var cls = Array.isArray(e.classes) ? e.classes : [];
          var overlap = 0;
          cls.forEach(function (c) {
            if (awaySet[String(c || '').trim()]) overlap++;
          });
          if (overlap > 0) score += Math.min(5, overlap);
          if (score > bestScore) {
            bestScore = score;
            best = e;
          }
        });
        if (best && bestScore >= 3) hit = best;
      }
      if (hit) {
        return {
          eventId: String(hit.id || '').trim(),
          eventName: String(hit.name || '').trim()
        };
      }
      // 備註常在帶入事件時寫成「事件名 起日～迄日」
      var note = String(mutualNote.value || '').trim();
      if (note) {
        var nameFromNote = note.split(/\s+/)[0] || note;
        if (nameFromNote && nameFromNote !== '活動互代') {
          var awayKey = (mutualAwayClasses.value || []).slice().sort().join(',');
          return {
            eventId: 'act_' + mutualActivityStart.value + '_' + mutualActivityEnd.value + '_'
              + String(awayKey).replace(/[^0-9A-Za-z\u4e00-\u9fff,]/g, '').slice(0, 40),
            eventName: nameFromNote
          };
        }
      }
      return { eventId: '', eventName: '' };
    }

    async function recalculateMutualQuotasFromActivity() {
      if (!isAdmin.value) {
        showToast('僅管理員可發放互代額度', 'warning');
        return;
      }
      var dac = DAC();
      if (!dac || !dac.buildQuotaRecalcRows) {
        showToast('活動互代模組未載入', 'error');
        return;
      }
      if (!mutualAwayClasses.value.length) {
        showToast('請先選擇外出班級', 'info');
        return;
      }
      ensureMutualActivityRange();
      var leaders = Array.from(new Set(
        (mutualLeadEmails.value || []).map(function (e) { return String(e).toLowerCase(); }).filter(Boolean)
      ));
      var rows = dac.buildQuotaRecalcRows({
        mode: 'add',
        teachers: teachersList.value,
        awayClasses: mutualAwayClasses.value,
        startDate: mutualActivityStart.value,
        endDate: mutualActivityEnd.value,
        weekDates: currentWeekDates.value,
        allSchedules: allSchedules.value,
        excludeEmails: leaders
      });
      var skippedLeaders = rows.filter(function (r) { return r.skipped; });
      var changed = rows.filter(function (r) { return !r.skipped && r.released > 0; });
      if (!changed.length) {
        var tip = skippedLeaders.length ? '（已排除帶隊 ' + skippedLeaders.length + ' 人）' : '';
        showToast('此期間沒有可發放的釋出節數' + tip, 'info');
        return;
      }
      // 事件名稱／ID：必須對應空堂事件名稱（勿寫死「活動互代」）
      var eventMeta = resolveEarnEventFromClassAway();
      var eventId = eventMeta.eventId;
      var eventName = eventMeta.eventName;
      if (!eventName) {
        showToast('請先在上方選取空堂事件（事件名稱會寫入額度帳本）', 'warning');
        return;
      }
      var sample = changed.slice(0, 5).map(function (r) {
        return (r.name || r.email) + '：釋出 ' + r.released + '（目前餘額 ' + r.prevQuota + '）';
      }).join('\n');
      var skipTip = skippedLeaders.length
        ? '\n已排除帶隊 ' + skippedLeaders.length + ' 人：'
          + skippedLeaders.slice(0, 5).map(function (r) { return r.name || r.email; }).join('、')
          + (skippedLeaders.length > 5 ? '…' : '')
        : '';
      var ok = await showConfirm(
        '將寫入「額度帳本」並更新教師名單餘額（同活動不重複）\n'
        + '空堂事件：' + eventName + '\n'
        + '期間：' + mutualActivityStart.value + '～' + mutualActivityEnd.value + '\n'
        + '外出班：' + mutualAwayClasses.value.length + ' 班\n'
        + '發放 ' + changed.length + ' 位教師' + skipTip + '\n\n'
        + sample + (changed.length > 5 ? '\n…' : '') + '\n\n'
        + '確定發放？\n（若本活動已發放過，將略過已發者）',
        '發放互代額度'
      );
      if (!ok) return;
      loading.value = true;
      loadingMessage.value = '計算釋出節數並批次寫入額度帳本（約數秒）…';
      try {
        // 只送有釋出者，減輕 payload
        var payloadList = changed.map(function (r) {
          return { email: r.email, name: r.name || '', released: r.released };
        });
        loadingMessage.value = '正在批次寫入 ' + payloadList.length + ' 人…';
        var gasCall = (typeof callGasApi === 'function') ? callGasApi : null;
        var res = await gasCall('earnMutualQuotaFromActivity', {
          eventId: eventId,
          eventName: eventName,
          startDate: mutualActivityStart.value,
          endDate: mutualActivityEnd.value,
          mode: 'add',
          list: payloadList
        });
        var earnedN = res && res.earned != null ? res.earned : 0;
        var skippedN = res && res.skipped != null ? res.skipped : 0;
        var wroteN = res && res.wroteLedger != null ? res.wroteLedger : earnedN;
        if (res && res.results && res.results.length) {
          res.results.forEach(function (r) {
            if (r.skipped) return;
            if (typeof r.balance === 'number') {
              patchLocalMutualQuota(r.email, r.balance);
              return;
            }
            var src = changed.find(function (c) {
              return String(c.email).toLowerCase() === String(r.email).toLowerCase();
            });
            var t = (teachersList.value || []).find(function (x) {
              return x.email && String(x.email).toLowerCase() === String(r.email).toLowerCase();
            });
            var prev = t ? (parseInt(t.mutualQuota, 10) || 0) : 0;
            patchLocalMutualQuota(r.email, prev + (src ? (src.released || 0) : 0));
          });
        }
        var skipMsg = skippedLeaders.length ? '，帶隊排除 ' + skippedLeaders.length : '';
        var dupMsg = skippedN ? '，帳本已有略過 ' + skippedN : '';
        if (earnedN === 0 && skippedN > 0) {
          showToast('本事件帳本已有 earn 列（略過 ' + skippedN + '）。若表上沒看到，請確認分頁名是「額度帳本」', 'warning');
        } else {
          showToast('已寫入額度帳本 ' + wroteN + ' 列／發放 ' + earnedN + ' 人' + dupMsg + skipMsg, 'success');
        }
        // 額度已變：清前端歷程快取（若有）
        try {
          if (typeof window !== 'undefined' && window.__quotaLedgerCacheBust) window.__quotaLedgerCacheBust();
        } catch (eB) { /* ignore */ }
        softRefreshInBackground({ force: true, delay: 900 });
      } catch (e) {
        console.error(e);
        showToast('發放額度失敗：' + (e && e.message ? e.message : String(e)), 'error');
      } finally {
        loading.value = false;
      }
    }

    function setMutualCover(on) {
      if (!isAdmin.value) {
        showToast('僅管理員可使用活動互代', 'warning');
        return;
      }
      isMutualCover.value = !!on;
      if (isMutualCover.value) {
        var saved = restoreMutualPanelDraft();
        if (saved) applyMutualPanelDraft(saved);
        ensureMutualActivityRange();
        if (pendingRequestData && pendingRequestData.value) {
          if (!pendingRequestData.value.reason) pendingRequestData.value.reason = '公假';
          pendingRequestData.value.subFee = ACTIVITY_PUBLIC_FEE;
          if (pendingRequestData.value.mode === 'substitution' || !pendingRequestData.value.mode) {
            if (directApproveMode) directApproveMode.value = true;
          }
        }
        if (batchSubFee) batchSubFee.value = ACTIVITY_PUBLIC_FEE;
        persistMutualPanelDraft();
        var n = (mutualDrafts.value || []).length;
        showToast(
          n > 0
            ? '活動互代已開啟（已還原 ' + n + ' 節暫定，送出前會保留）'
            : '活動互代：選取內容會暫存；點帶隊課格暫定→一次送出',
          'info'
        );
      } else {
        persistMutualPanelDraft();
        if (pendingRequestData && pendingRequestData.value) {
          pendingRequestData.value.subFee = defaultSubFeeForReason(pendingRequestData.value.reason);
          if (batchSubFee) batchSubFee.value = pendingRequestData.value.subFee || '自費代課';
        }
        showToast('已關閉活動互代面板（選取與暫定已保留）', 'info');
      }
    }

    function toggleMutualCover() {
      setMutualCover(!isMutualCover.value);
    }

    function assignMutualDraftFromMatch(subEmail) {
      if (!isMutualCover.value || !subEmail) return;
      var leaveEmail = activeCell.value && activeCell.value.teacherEmail;
      if (!leaveEmail) {
        showToast('請先點選帶隊老師的課格', 'info');
        return;
      }
      if (!isMutualLead(leaveEmail)) {
        showToast('請先將該老師加入「帶隊老師」名單', 'warning');
        return;
      }
      var dateStr = inputRequestDate.value;
      var period = parseInt(activeCell.value.period, 10);
      var dayOfWeek = parseInt(activeCell.value.dayOfWeek, 10);
      var cls = activeCell.value.classData || {};
      var cand = (recommendedTeachers.value || []).find(function (t) {
        return t.email && String(t.email).toLowerCase() === String(subEmail).toLowerCase();
      });
      var dac = DAC();
      if (!cand && dac) {
        var bal = dac.getTeacherReleaseBalance(subEmail, activityBalanceCtx());
        cand = { email: subEmail, remainingReleased: bal.remaining };
      }
      var fee = dac
        ? dac.feeFromCandidate(cand, true, period)
        : (parseInt(period, 10) === 8 ? PERIOD8_FEE : ACTIVITY_PUBLIC_FEE);
      var key = mutualDraftKey(leaveEmail, dateStr, period);
      var draft = {
        key: key,
        leaveEmail: leaveEmail,
        leaveName: getTeacherNameByEmail(leaveEmail),
        dateStr: dateStr,
        dayOfWeek: dayOfWeek,
        period: period,
        className: cls.className || '',
        subject: cls.subject || '',
        restriction: cls.restriction || '',
        subEmail: subEmail,
        subName: getTeacherNameByEmail(subEmail),
        fee: fee
      };
      var list = mutualDrafts.value.filter(function (d) { return d.key !== key; });
      list.push(draft);
      list.sort(function (a, b) {
        if (a.dateStr !== b.dateStr) return String(a.dateStr).localeCompare(String(b.dateStr));
        if (a.leaveName !== b.leaveName) {
          return String(a.leaveName).localeCompare(String(b.leaveName), 'zh-Hant');
        }
        return a.period - b.period;
      });
      mutualDrafts.value = list;
      persistMutualPanelDraft();
      if (showMatchModal) showMatchModal.value = false;
      showToast('暫定：' + draft.leaveName + ' 第' + period + '節 → ' + draft.subName + '（' + fee + '）', 'success');
    }

    return {
      LS_KEY: LS_KEY,
      mutualDraftKey: mutualDraftKey,
      persistMutualPanelDraft: persistMutualPanelDraft,
      restoreMutualPanelDraft: restoreMutualPanelDraft,
      applyMutualPanelDraft: applyMutualPanelDraft,
      clearMutualPanel: clearMutualPanel,
      ensureMutualActivityRange: ensureMutualActivityRange,
      setMutualActivityThisWeek: setMutualActivityThisWeek,
      toggleMutualLead: toggleMutualLead,
      isMutualLead: isMutualLead,
      toggleMutualAwayClass: toggleMutualAwayClass,
      selectAwayGrade: selectAwayGrade,
      getMutualDraftAt: getMutualDraftAt,
      removeMutualDraft: removeMutualDraft,
      clearMutualDrafts: clearMutualDrafts,
      activityBalanceCtx: activityBalanceCtx,
      patchLocalMutualQuota: patchLocalMutualQuota,
      recalculateMutualQuotasFromActivity: recalculateMutualQuotasFromActivity,
      setMutualCover: setMutualCover,
      toggleMutualCover: toggleMutualCover,
      assignMutualDraftFromMatch: assignMutualDraftFromMatch
    };
  }

  return { create: create, mutualDraftKey: mutualDraftKey, LS_KEY: LS_KEY };
})();


/**
 * 活動互代：暫定草稿一次送出
 */
window.UiMutualSubmit = (function () {
  async function submitAllMutualDrafts(deps) {
    var isMutualCover = deps.isMutualCover;
    var mutualDrafts = deps.mutualDrafts;
    var mutualNote = deps.mutualNote;
    var mutualSkipNotify = deps.mutualSkipNotify;
    var showConfirm = deps.showConfirm;
    var showToast = deps.showToast;
    var loading = deps.loading;
    var loadingMessage = deps.loadingMessage;
    var currentSemester = deps.currentSemester;
    var isAdmin = deps.isAdmin;
    var directApproveMode = deps.directApproveMode;
    var callGasApi = deps.callGasApi;
    var optimisticUpsertRequest = deps.optimisticUpsertRequest;
    var sheetRequestToFront = deps.sheetRequestToFront;
    var deductMutualQuotaForRows = deps.deductMutualQuotaForRows;
    var softRefreshInBackground = deps.softRefreshInBackground;
    var persistMutualPanelDraft = deps.persistMutualPanelDraft;
    var activityBalanceCtx = deps.activityBalanceCtx;
    var PERIOD8_FEE = deps.PERIOD8_FEE;
    var ACTIVITY_PUBLIC_FEE = deps.ACTIVITY_PUBLIC_FEE;
    var successModalTitle = deps.successModalTitle;
    var successModalMessage = deps.successModalMessage;
    var hasLineTemplate = deps.hasLineTemplate;
    var lineBatchParts = deps.lineBatchParts;
    var lineCopyText = deps.lineCopyText;
    var showSuccessModal = deps.showSuccessModal;
    var buildLineBatchInviteText = deps.buildLineBatchInviteText;
    var DAC = deps.DAC || function () { return window.DomainActivityCover; };
    var isSubmitting = deps.isSubmitting;

    if (isSubmitting && isSubmitting.value) {
      showToast('申請送出中，請稍候…', 'info');
      return;
    }
    if (!isMutualCover.value) return;
    if (!mutualDrafts.value.length) {
      showToast('尚無暫定安排', 'info');
      return;
    }
    if (isSubmitting) isSubmitting.value = true;
    loading.value = true;
    loadingMessage.value = '正在準備送出…';
    var reason = '公假';
    var note = String(mutualNote.value || '').trim();
    var byLeave = {};
    mutualDrafts.value.forEach(function (d) {
      var k = String(d.leaveEmail).toLowerCase();
      if (!byLeave[k]) byLeave[k] = [];
      byLeave[k].push(d);
    });
    var leaveGroups = Object.values(byLeave);
    var total = mutualDrafts.value.length;
    var allRows = [];
    try {
      var ok = await showConfirm(
        '將一次送出 ' + total + ' 節暫定安排（' + leaveGroups.length + ' 位帶隊老師）\n'
        + (note ? '統一備註：' + note + '\n' : '')
        + (mutualSkipNotify.value ? '不會寄系統信，請稍後用 LINE 手動通知。\n' : '')
        + '確定送出？',
        '一次送出暫定'
      );
      if (!ok) return;
      loadingMessage.value = '正在送出 ' + total + ' 節暫定…';
      for (var g = 0; g < leaveGroups.length; g++) {
        var group = leaveGroups[g];
        for (var offset = 0; offset < group.length; offset += 20) {
          var chunk = group.slice(offset, offset + 20);
          var workSlots = chunk.map(function (d) {
            return {
              teacherEmail: d.leaveEmail,
              dateStr: d.dateStr,
              dayOfWeek: d.dayOfWeek,
              period: d.period,
              className: d.className,
              subject: d.subject,
              subTeacherEmail: d.subEmail,
              subTeacherName: d.subName,
              fee: d.fee
            };
          });
          var feeAssigns = null;
          var dac = DAC();
          if (dac && dac.assignFeesForBatchSlots) {
            feeAssigns = dac.assignFeesForBatchSlots(
              workSlots,
              activityBalanceCtx({ pendingDrafts: [] })
            );
          }
          var batchId = 'bat_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4);
          var leaveEmail = chunk[0].leaveEmail;
          var leaveName = chunk[0].leaveName;
          var stamp = Date.now();
          var serialRoot = 'SUB' + (1000 + Math.floor(Math.random() * 9000));
          var rows = workSlots.map(function (s, i) {
            var base = String(note || '').trim();
            var noteOut = base;
            if (isAdmin.value && directApproveMode.value) {
              noteOut = base ? ('[直接核准] ' + base) : '[直接核准]';
            }
            return {
              "學期代號": currentSemester.value,
              "申請單ID": 'req_' + stamp + '_' + i + '_' + Math.random().toString(36).substr(2, 5),
              "單號": serialRoot + '-' + (offset + i + 1),
              "批次ID": batchId,
              "異動類型": 'substitution',
              "申請人Email": leaveEmail,
              "申請人姓名": leaveName,
              "受邀人Email": s.subTeacherEmail,
              "受邀人姓名": s.subTeacherName,
              "異動日期": s.dateStr,
              "異動節次": s.period,
              "異動星期": s.dayOfWeek,
              "班級": s.className,
              "科目": s.subject,
              "請假事由": reason,
              "經費來源": (feeAssigns && feeAssigns[i])
                ? feeAssigns[i].fee
                : (s.fee || (parseInt(s.period, 10) === 8 ? PERIOD8_FEE : ACTIVITY_PUBLIC_FEE)),
              "備註": noteOut,
              "狀態": (isAdmin.value && directApproveMode.value) ? 'approved' : 'pending_teacher',
              "是否已印": false,
              "建立時間": '',
              directApprove: !!(isAdmin.value && directApproveMode.value)
            };
          });
          await callGasApi('submitRequestBatch', {
            batchId: batchId,
            directApprove: !!(isAdmin.value && directApproveMode.value),
            skipNotify: !!mutualSkipNotify.value,
            requests: rows
          });
          rows.forEach(function (r) {
            optimisticUpsertRequest(sheetRequestToFront(r));
          });
          await deductMutualQuotaForRows(rows);
          for (var ri = 0; ri < rows.length; ri++) allRows.push(rows[ri]);
        }
      }
      softRefreshInBackground({ delay: 2000 });
      mutualDrafts.value = [];
      persistMutualPanelDraft();

      var feeKinds = {};
      allRows.forEach(function (r) {
        var f = r['經費來源'] || '';
        feeKinds[f] = (feeKinds[f] || 0) + 1;
      });
      var feeTip = Object.keys(feeKinds).map(function (f) {
        return f + ' ' + feeKinds[f] + '節';
      }).join('、');
      successModalTitle.value = '🎉 暫定已全部送出';
      successModalMessage.value = '共 ' + allRows.length + ' 節已寫入（' + feeTip + '）。'
        + (mutualSkipNotify.value ? ' 尚未寄系統信，請用下方 LINE 手動通知。' : '');
      if (deps.successFlowMode) {
        deps.successFlowMode.value = (isAdmin.value && directApproveMode.value) ? 'direct' : 'normal';
      }
      hasLineTemplate.value = !!mutualSkipNotify.value;
      if (hasLineTemplate.value) {
        var currentUrl = window.location.origin + window.location.pathname;
        var bySub = {};
        allRows.forEach(function (r) {
          var em = String(r['受邀人Email'] || '').toLowerCase();
          if (!bySub[em]) bySub[em] = { name: r['受邀人姓名'], rows: [] };
          bySub[em].rows.push(r);
        });
        lineBatchParts.value = Object.keys(bySub).map(function (k) {
          var g = bySub[k];
          return {
            name: g.name,
            count: g.rows.length,
            text: buildLineBatchInviteText({
              targetName: g.name,
              requesterName: '教學組',
              reason: reason,
              subFee: g.rows[0]['經費來源'],
              systemUrl: currentUrl,
              batchId: g.rows[0]['批次ID'],
              slots: g.rows.map(function (r) {
                return {
                  id: r['申請單ID'],
                  date: r['異動日期'],
                  day: r['異動星期'],
                  period: r['異動節次'],
                  className: r['班級'],
                  subject: r['科目']
                };
              })
            })
          };
        });
        lineCopyText.value = lineBatchParts.value.map(function (p) { return p.text; }).join('\n\n==========\n\n');
      } else {
        lineCopyText.value = '';
        lineBatchParts.value = [];
      }
      showSuccessModal.value = true;
    } catch (err) {
      console.error(err);
      showToast('送出暫定失敗：' + (err && err.message ? err.message : String(err)), 'error');
    } finally {
      loading.value = false;
      if (isSubmitting) isSubmitting.value = false;
    }
  }

  return { submitAllMutualDrafts: submitAllMutualDrafts };
})();


/**
 * 一般／活動批次代課送出（executeBatchSubmit）
 */
window.UiBatchSubmit = (function () {
  async function executeBatchSubmit(deps) {
    var batchSlots = deps.batchSlots;
    var pendingRequestData = deps.pendingRequestData;
    var batchAssignMode = deps.batchAssignMode;
    var batchReason = deps.batchReason;
    var batchNote = deps.batchNote;
    var batchSubTeacher = deps.batchSubTeacher;
    var batchSubFee = deps.batchSubFee;
    var showToast = deps.showToast;
    var showConfirm = deps.showConfirm;
    var getScheduleForDate = deps.getScheduleForDate;
    var getTeacherNameByEmail = deps.getTeacherNameByEmail;
    var isMutualCover = deps.isMutualCover;
    var mutualAwayClasses = deps.mutualAwayClasses;
    var mutualSkipNotify = deps.mutualSkipNotify;
    var isAdmin = deps.isAdmin;
    var isQuotaDeductFee = deps.isQuotaDeductFee;
    var QUOTA_DEDUCT_FEE = deps.QUOTA_DEDUCT_FEE;
    var ACTIVITY_PUBLIC_FEE = deps.ACTIVITY_PUBLIC_FEE;
    var PERIOD8_FEE = deps.PERIOD8_FEE;
    var defaultSubFeeForReason = deps.defaultSubFeeForReason;
    var assertQuotaDeductAllowed = deps.assertQuotaDeductAllowed;
    var loading = deps.loading;
    var loadingMessage = deps.loadingMessage;
    var currentSemester = deps.currentSemester;
    var directApproveMode = deps.directApproveMode;
    var directApproveSkipNotify = deps.directApproveSkipNotify;
    var callGasApi = deps.callGasApi;
    var optimisticUpsertRequest = deps.optimisticUpsertRequest;
    var sheetRequestToFront = deps.sheetRequestToFront;
    var deductMutualQuotaForRows = deps.deductMutualQuotaForRows;
    var softRefreshInBackground = deps.softRefreshInBackground;
    var activityBalanceCtx = deps.activityBalanceCtx;
    var successModalTitle = deps.successModalTitle;
    var successModalMessage = deps.successModalMessage;
    var hasLineTemplate = deps.hasLineTemplate;
    var lineBatchParts = deps.lineBatchParts;
    var lineCopyText = deps.lineCopyText;
    var showSuccessModal = deps.showSuccessModal;
    var showCompareModal = deps.showCompareModal;
    var showMatchModal = deps.showMatchModal;
    var batchSelectMode = deps.batchSelectMode;
    var clearBatchSlots = deps.clearBatchSlots;
    var buildLineBatchInviteText = deps.buildLineBatchInviteText;
    var DAC = deps.DAC || function () { return window.DomainActivityCover; };
    var isSubmitting = deps.isSubmitting;

    if (isSubmitting && isSubmitting.value) {
      showToast('申請送出中，請稍候…', 'info');
      return;
    }
    if (batchSlots.value.length < 2) {
      showToast('批次至少 2 節', 'info');
      return;
    }
    var isPerSlot = !!(pendingRequestData.value.isPerSlot || batchAssignMode.value === 'perSlot');
    var reason = pendingRequestData.value.reason || batchReason.value;
    var note = pendingRequestData.value.note || batchNote.value || '';
    if (!reason) {
      showToast('請選擇請假事由', 'info');
      return;
    }
    if (isSubmitting) isSubmitting.value = true;
    loading.value = true;
    loadingMessage.value = '正在檢查批次內容…';
    function unlockSubmit() {
      loading.value = false;
      if (isSubmitting) isSubmitting.value = false;
    }

    var workSlots = batchSlots.value.map(function (s) {
      if (isPerSlot) return s;
      var subEmail = pendingRequestData.value.subTeacher || batchSubTeacher.value || s.subTeacherEmail;
      return Object.assign({}, s, {
        subTeacherEmail: subEmail,
        subTeacherName: getTeacherNameByEmail(subEmail)
      });
    });
    if (workSlots.some(function (s) { return !s.subTeacherEmail; })) {
      showToast(isPerSlot ? '尚有節次未指定代課老師' : '請先從媒合名單選擇代課教師', 'info');
      unlockSubmit();
      return;
    }

    var conflicts = [];
    workSlots.forEach(function (s) {
      var cell = getScheduleForDate(s.subTeacherEmail, s.dateStr, s.period, s.dayOfWeek);
      var isConflict = DAC()
        ? DAC().isConflictCell(cell, !!isMutualCover.value, mutualAwayClasses.value)
        : !!(cell && !cell.isSubstituted);
      if (isConflict) {
        conflicts.push(getTeacherNameByEmail(s.subTeacherEmail) + ' ' + s.dateStr + ' 第' + s.period + '節');
      }
    });
    if (conflicts.length) {
      var proxyForce = false;
      if (deps.isProxySubmitActive) {
        proxyForce = typeof deps.isProxySubmitActive === 'function'
          ? !!deps.isProxySubmitActive()
          : !!deps.isProxySubmitActive.value;
      }
      if (isAdmin.value || proxyForce) {
        var ok = await showConfirm('以下代課衝堂：\n' + conflicts.join('\n') + '\n\n可強制送出，確定？', '衝堂警告');
        if (!ok) { unlockSubmit(); return; }
      } else {
        showToast('代課教師衝堂：' + conflicts.join('、'), 'warning');
        unlockSubmit();
        return;
      }
    }

    var fee = isMutualCover.value
      ? (isQuotaDeductFee(pendingRequestData.value.subFee) ? QUOTA_DEDUCT_FEE : ACTIVITY_PUBLIC_FEE)
      : (pendingRequestData.value.subFee || batchSubFee.value
        || defaultSubFeeForReason(reason)
        || '自費代課');
    if ((workSlots || []).length && workSlots.every(function (s) { return parseInt(s.period, 10) === 8; })) {
      fee = PERIOD8_FEE;
    }
    if (fee === QUOTA_DEDUCT_FEE || pendingRequestData.value.subFee === QUOTA_DEDUCT_FEE) {
      if (!assertQuotaDeductAllowed()) { unlockSubmit(); return; }
      // 活動互代可能已自動改活動公費
      if (isMutualCover.value && pendingRequestData.value.subFee === ACTIVITY_PUBLIC_FEE) {
        fee = ACTIVITY_PUBLIC_FEE;
      }
    }

    loadingMessage.value = '正在批次送出 ' + workSlots.length + ' 筆申請...';
    try {
      var batchId = 'bat_' + Date.now();
      var leaveEmail = workSlots[0].teacherEmail;
      var leaveName = getTeacherNameByEmail(leaveEmail);
      var stamp = Date.now();
      var serialRoot = 'SUB' + (1000 + Math.floor(Math.random() * 9000));
      var feeAssigns = null;
      // 活動互代：逐節依剩餘額度決定扣額度／活動公費（不足自動公費）
      if (isMutualCover.value && DAC() && DAC().assignFeesForBatchSlots) {
        feeAssigns = DAC().assignFeesForBatchSlots(workSlots, activityBalanceCtx());
      }
      function feeForSlot(s, i) {
        if (parseInt(s.period, 10) === 8) return PERIOD8_FEE;
        if (feeAssigns && feeAssigns[i]) return feeAssigns[i].fee;
        if (!DAC()) return isMutualCover.value ? ACTIVITY_PUBLIC_FEE : fee;
        return DAC().feeForSubSlot({
          activityMode: !!isMutualCover.value,
          fallbackFee: fee,
          period: s.period,
          subTeacherCell: getScheduleForDate(s.subTeacherEmail, s.dateStr, s.period, s.dayOfWeek),
          awayClasses: mutualAwayClasses.value
        });
      }
      var leaveEmBatch = String(leaveEmail || '').toLowerCase();
      var proxyActive = false;
      if (deps.shouldProxySubmitForLeave) {
        proxyActive = !!deps.shouldProxySubmitForLeave(leaveEmBatch);
      } else if (deps.isProxySubmitActive) {
        proxyActive = typeof deps.isProxySubmitActive === 'function'
          ? !!deps.isProxySubmitActive()
          : !!deps.isProxySubmitActive.value;
      }
      var proxyByEmail = '';
      var proxyByName = '';
      if (proxyActive && deps.getProxyActor) {
        var actor = deps.getProxyActor() || {};
        proxyByEmail = String(actor.email || '').trim().toLowerCase();
        proxyByName = String(actor.name || '').trim();
      }
      if (proxyActive && !proxyByName && proxyByEmail) {
        proxyByName = getTeacherNameByEmail(proxyByEmail) || proxyByEmail;
      }
      // 批次對象若是自己 → 不當代申請
      if (proxyActive && proxyByEmail && leaveEmBatch === proxyByEmail) {
        proxyActive = false;
        proxyByEmail = '';
        proxyByName = '';
      }
      var doDirectApprove = !!(isAdmin.value && directApproveMode.value && !proxyActive);
      var batchStatus = doDirectApprove
        ? 'approved'
        : (proxyActive ? 'pending_admin' : 'pending_teacher');
      var rows = workSlots.map(function (s, i) {
        var base = String(note || '').trim();
        var noteOut = base;
        if (doDirectApprove) {
          noteOut = base ? ('[直接核准] ' + base) : '[直接核准]';
        } else if (proxyActive) {
          var tag = '[行政代申請：' + (proxyByName || proxyByEmail) + ' 代 ' + leaveName + ']';
          noteOut = base ? (tag + ' ' + base) : tag;
        }
        var row = {
          "學期代號": currentSemester.value,
          "申請單ID": 'req_' + stamp + '_' + i + '_' + Math.random().toString(36).substr(2, 5),
          "單號": serialRoot + '-' + (i + 1),
          "批次ID": batchId,
          "異動類型": 'substitution',
          "申請人Email": leaveEmail,
          "申請人姓名": leaveName,
          "受邀人Email": s.subTeacherEmail,
          "受邀人姓名": s.subTeacherName || getTeacherNameByEmail(s.subTeacherEmail),
          "異動日期": s.dateStr,
          "異動節次": s.period,
          "異動星期": s.dayOfWeek,
          "班級": s.className,
          "科目": s.subject,
          "請假事由": reason,
          "經費來源": feeForSlot(s, i),
          "備註": noteOut,
          "狀態": batchStatus,
          "是否已印": false,
          "建立時間": '',
          directApprove: doDirectApprove,
          isProxySubmit: !!proxyActive,
          proxyByEmail: proxyByEmail || '',
          proxyByName: proxyByName || ''
        };
        if (proxyActive && proxyByEmail) {
          row["代申請人Email"] = proxyByEmail;
          row["代申請人姓名"] = proxyByName || '';
        }
        return row;
      });

      // 行政代申請：不寄受邀邀請信；教學組核准時再通知
      var skipNotify = !!(
        (isMutualCover.value && mutualSkipNotify.value)
        || (doDirectApprove && directApproveSkipNotify.value)
        || proxyActive
      );
      await callGasApi('submitRequestBatch', {
        batchId: batchId,
        directApprove: doDirectApprove,
        proxySubmit: !!proxyActive,
        skipNotify: skipNotify,
        requests: rows
      });

      rows.forEach(function (r) {
        optimisticUpsertRequest(sheetRequestToFront(r));
      });
      if (rows.some(function (r) { return isQuotaDeductFee(r['經費來源'] || r.subFee); })) {
        await deductMutualQuotaForRows(rows);
      }
      softRefreshInBackground({ delay: 2000 });

      var n = rows.length;
      var groups = {};
      rows.forEach(function (r) {
        var em = String(r["受邀人Email"] || '').toLowerCase();
        if (!groups[em]) groups[em] = { name: r["受邀人姓名"], rows: [] };
        groups[em].rows.push(r);
      });
      var groupList = Object.keys(groups).map(function (k) { return groups[k]; });
      var subSummary = groupList.map(function (g) {
        return g.name + '（' + g.rows.length + '節）';
      }).join('、');

      var feeKinds = {};
      rows.forEach(function (r) {
        var f = r['經費來源'] || fee;
        feeKinds[f] = (feeKinds[f] || 0) + 1;
      });
      var feeTip = Object.keys(feeKinds).map(function (f) {
        return f + ' ' + feeKinds[f] + '節';
      }).join('、');
      var mutualTip = isMutualCover.value ? '（活動互代：' + feeTip + '）' : '';
      var notifyTip = skipNotify ? ' 尚未寄信，請用下方 LINE 範本手動通知。' : '';
      if (doDirectApprove) {
        successModalTitle.value = '🎉 批次已直接核准';
      } else if (proxyActive) {
        successModalTitle.value = '🎉 批次已送交教學組';
      } else {
        successModalTitle.value = '🎉 批次申請已送出';
      }
      var proxyTip = proxyActive ? '（行政代申請，已跳過受邀確認）' : '';
      successModalMessage.value = groupList.length === 1
        ? '共 ' + n + ' 節已送出' + proxyTip + mutualTip + '，代課：' + groupList[0].name + ' 老師。' + notifyTip
        : '共 ' + n + ' 節已送出' + proxyTip + mutualTip + '，由 ' + groupList.length + ' 位老師分代：' + subSummary + '。' + notifyTip;
      if (deps.successFlowMode) {
        deps.successFlowMode.value = doDirectApprove ? 'direct' : (proxyActive ? 'proxy' : 'normal');
      }
      hasLineTemplate.value = skipNotify || (!doDirectApprove && !proxyActive);
      if (hasLineTemplate.value) {
        var currentUrl = window.location.origin + window.location.pathname;
        lineBatchParts.value = groupList.map(function (g) {
          return {
            name: g.name,
            count: g.rows.length,
            text: buildLineBatchInviteText({
              targetName: g.name,
              requesterName: leaveName,
              reason: reason,
              subFee: fee,
              systemUrl: currentUrl,
              batchId: batchId,
              slots: g.rows.map(function (r) {
                return {
                  id: r["申請單ID"],
                  date: r["異動日期"],
                  day: r["異動星期"],
                  period: r["異動節次"],
                  className: r["班級"],
                  subject: r["科目"]
                };
              })
            })
          };
        });
        lineCopyText.value = lineBatchParts.value.length === 1
          ? lineBatchParts.value[0].text
          : lineBatchParts.value.map(function (p) { return p.text; }).join('\n\n==========\n\n');
      } else {
        lineCopyText.value = '';
        lineBatchParts.value = [];
      }
      showSuccessModal.value = true;
      showCompareModal.value = false;
      showMatchModal.value = false;
      batchSelectMode.value = false;
      clearBatchSlots();
    } catch (err) {
      console.error('批次送出失敗', err);
      showToast('批次送出失敗：' + (err && err.message ? err.message : String(err)), 'error');
    } finally {
      unlockSubmit();
    }
  }

  return { executeBatchSubmit: executeBatchSubmit };
})();

/**
 * 批次選節／指派／媒合 UI（殼瘦身 C）
 * 送出：UiBatchSubmit.executeBatchSubmit
 * 晚定義 deps 請用 function 包裝後傳入 create
 */
window.UiBatchPanel = (function () {
  function create(deps) {
    var computed = deps.computed;
    var showToast = deps.showToast;
    var showConfirm = deps.showConfirm;
    var getTeacherNameByEmail = deps.getTeacherNameByEmail;
    var getScheduleForDate = deps.getScheduleForDate;
    var formatDateMMDD = deps.formatDateMMDD;
    var isAdmin = deps.isAdmin;
    var isMutualCover = deps.isMutualCover;
    var DAC = deps.DAC || function () { return window.DomainActivityCover; };
    var mutualAwayClasses = deps.mutualAwayClasses;
    var batchSlots = deps.batchSlots;
    var batchSelectMode = deps.batchSelectMode;
    var batchAssignMode = deps.batchAssignMode;
    var batchActiveSlotKey = deps.batchActiveSlotKey;
    var batchSubTeacher = deps.batchSubTeacher;
    var batchReason = deps.batchReason;
    var batchSubFee = deps.batchSubFee;
    var batchNote = deps.batchNote;
    var batchCompareViewEmail = deps.batchCompareViewEmail;
    var showBatchConfirmModal = deps.showBatchConfirmModal;
    var showMatchModal = deps.showMatchModal;
    var showCompareModal = deps.showCompareModal;
    var activeCell = deps.activeCell;
    var inputRequestDate = deps.inputRequestDate;
    var matchMode = deps.matchMode;
    var matchPreview = deps.matchPreview;
    var pendingRequestData = deps.pendingRequestData;
    var recommendedTeachers = deps.recommendedTeachers;
    var recommendationLoading = deps.recommendationLoading;
    var matchSearchQuery = deps.matchSearchQuery;
    var matchDisplayCount = deps.matchDisplayCount;
    var matchShowNoTeacherWarning = deps.matchShowNoTeacherWarning;
    var matchEmptyReasons = deps.matchEmptyReasons;
    var consecAlertsA = deps.consecAlertsA;
    var consecAlertsB = deps.consecAlertsB;
    var directApproveMode = deps.directApproveMode;
    var teachersList = deps.teachersList;
    var getTeacherSubjectByEmail = deps.getTeacherSubjectByEmail;
    var activityBalanceCtx = deps.activityBalanceCtx;
    var QUOTA_DEDUCT_FEE = deps.QUOTA_DEDUCT_FEE;
    var ACTIVITY_PUBLIC_FEE = deps.ACTIVITY_PUBLIC_FEE;
    var PERIOD8_FEE = deps.PERIOD8_FEE;
    var getTimetableApi = deps.getTimetableApi;
    var isSlotConflict = deps.isSlotConflict;
    var mutualSkipNotify = deps.mutualSkipNotify;
    var isQuotaDeductFee = deps.isQuotaDeductFee;
    var defaultSubFeeForReason = deps.defaultSubFeeForReason;
    var assertQuotaDeductAllowed = deps.assertQuotaDeductAllowed;
    var loading = deps.loading;
    var loadingMessage = deps.loadingMessage;
    var currentSemester = deps.currentSemester;
    var directApproveSkipNotify = deps.directApproveSkipNotify;
    var callGasApi = deps.callGasApi;
    var optimisticUpsertRequest = deps.optimisticUpsertRequest;
    var sheetRequestToFront = deps.sheetRequestToFront;
    var deductMutualQuotaForRows = deps.deductMutualQuotaForRows;
    var softRefreshInBackground = deps.softRefreshInBackground;
    var successModalTitle = deps.successModalTitle;
    var successModalMessage = deps.successModalMessage;
    var hasLineTemplate = deps.hasLineTemplate;
    var lineBatchParts = deps.lineBatchParts;
    var lineCopyText = deps.lineCopyText;
    var showSuccessModal = deps.showSuccessModal;
    var buildLineBatchInviteText = deps.buildLineBatchInviteText;

    function batchSlotKey(email, dateStr, period) {
      return `${String(email || '').toLowerCase()}|${dateStr}|${period}`;
        }

    function isBatchSlotSelected(email, dateStr, period) {
      return batchSlots.value.some(s => s.key === batchSlotKey(email, dateStr, period));
        }

    /** 批次選節：DOM 高亮（不經 getClassCellClass 全表重算） */
    function paintBatchSlotCell(email, dateStr, period, on) {
      var em = String(email || '').toLowerCase();
      var d = String(dateStr || '').slice(0, 10);
      var p = parseInt(period, 10);
      if (!em || !d || isNaN(p)) return;
      try {
        var nodes = document.querySelectorAll(
          '.grid-cell-class[data-tt-email="' + em + '"][data-tt-date="' + d + '"][data-tt-period="' + p + '"]'
        );
        for (var i = 0; i < nodes.length; i++) {
          if (on) nodes[i].classList.add('is-batch-selected');
          else nodes[i].classList.remove('is-batch-selected');
        }
      } catch (e) { /* ignore */ }
    }
    function clearBatchSlotDom() {
      try {
        document.querySelectorAll('.grid-cell-class.is-batch-selected')
          .forEach(function (el) { el.classList.remove('is-batch-selected'); });
      } catch (e) { /* ignore */ }
    }
    function repaintAllBatchSlotDom() {
      clearBatchSlotDom();
      (batchSlots.value || []).forEach(function (s) {
        if (s) paintBatchSlotCell(s.teacherEmail, s.dateStr, s.period, true);
      });
    }

    function clearBatchSlots() {
      batchSlots.value = [];
      batchSubTeacher.value = '';
      batchReason.value = '';
      batchSubFee.value = '自費代課';
      batchNote.value = '';
      batchActiveSlotKey.value = '';
      showBatchConfirmModal.value = false;
      clearBatchSlotDom();
    };

    var isBatchMatchFlow = computed(() =>
      batchSelectMode.value && batchSlots.value.length >= 2
    );

    var isBatchPerSlotMode = computed(() =>
      isBatchMatchFlow.value && batchAssignMode.value === 'perSlot'
    );

    var batchAssignedCount = computed(() =>
      batchSlots.value.filter(s => s.subTeacherEmail).length
    );

    var batchAllSlotsAssigned = computed(() =>
      batchSlots.value.length >= 2 && batchSlots.value.every(s => s.subTeacherEmail)
    );

    var batchActiveSlot = computed(() =>
      batchSlots.value.find(s => s.key === batchActiveSlotKey.value) || null
    );

    /** 每節不同人：依受邀人分組（送出後 LINE／信匣用） */
    function groupBatchSlotsBySub(slots) {
      const map = {};
      (slots || []).forEach(s => {
        const email = String(s.subTeacherEmail || s.subEmail || '').toLowerCase();
        if (!email) return;
        if (!map[email]) {
          map[email] = {
            subEmail: s.subTeacherEmail || s.subEmail,
            subName: s.subTeacherName || getTeacherNameByEmail(s.subTeacherEmail || s.subEmail),
            slots: []
          };
        }
        map[email].slots.push(s);
      });
      return Object.values(map);
    };

    function setBatchAssignMode(mode) {
      batchAssignMode.value = mode === 'perSlot' ? 'perSlot' : 'same';
      batchActiveSlotKey.value = '';
      // 切換模式時清空已指定代課人，避免混用
      batchSlots.value = batchSlots.value.map(s => ({
        ...s,
        subTeacherEmail: '',
        subTeacherName: ''
      }));
      batchSubTeacher.value = '';
      if (showMatchModal.value && isBatchMatchFlow.value) {
        if (batchAssignMode.value === 'same') {
          fetchBatchRecommendations();
        } else {
          recommendedTeachers.value = [];
          matchShowNoTeacherWarning.value = false;
          if (matchEmptyReasons) matchEmptyReasons.value = null;
        }
      }
    };

    function toggleBatchSelectMode() {
      batchSelectMode.value = !batchSelectMode.value;
      if (!batchSelectMode.value) {
        clearBatchSlots();
        showMatchModal.value = false;
        showCompareModal.value = false;
      } else {
        showMatchModal.value = false;
        showCompareModal.value = false;
        showToast('批次模式：點選同教師多節課，再選「同一人全代」或「每節不同人」', 'info');
      }
    };

    function toggleBatchSlot(slot) {
      const key = slot.key || batchSlotKey(slot.teacherEmail, slot.dateStr, slot.period);
      const idx = batchSlots.value.findIndex(s => s.key === key);
      if (idx >= 0) {
        batchSlots.value = batchSlots.value.filter((_, i) => i !== idx);
        if (batchActiveSlotKey.value === key) batchActiveSlotKey.value = '';
        paintBatchSlotCell(slot.teacherEmail, slot.dateStr, slot.period, false);
        return;
      }
      if (batchSlots.value.length >= 20) {
        showToast('單次批次最多 20 節', 'warning');
        return;
      }
      if (batchSlots.value.length && String(batchSlots.value[0].teacherEmail).toLowerCase() !== String(slot.teacherEmail).toLowerCase()) {
        showToast('批次僅能選同一位請假教師的課堂', 'warning');
        return;
      }
      batchSlots.value = batchSlots.value.concat([{
        key,
        teacherEmail: slot.teacherEmail,
        teacherName: slot.teacherName || getTeacherNameByEmail(slot.teacherEmail),
        dateStr: slot.dateStr,
        dayOfWeek: parseInt(slot.dayOfWeek, 10),
        period: parseInt(slot.period, 10),
        className: slot.className || '',
        subject: slot.subject || '',
        restriction: slot.restriction || '',
        subTeacherEmail: '',
        subTeacherName: ''
      }]).sort((a, b) => {
        if (a.dateStr !== b.dateStr) return a.dateStr.localeCompare(b.dateStr);
        return a.period - b.period;
      });
      // DOM 高亮（點選當幀）；Vue 若之後重寫 class，再補一次
      paintBatchSlotCell(slot.teacherEmail, slot.dateStr, slot.period, true);
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(function () {
          paintBatchSlotCell(slot.teacherEmail, slot.dateStr, slot.period, true);
        });
      }
    };

    /** 單節媒合（每節不同人用）— ui-timetable */
    function fetchSingleSlotRecommendations(slot) {
      const a = getTimetableApi();
      if (!a) return;
      a.fetchSingleSlotRecommendations({
        teachersList, getTeacherSubjectByEmail, activityBalanceCtx, recommendationLoading, matchMode,
        matchSearchQuery, matchDisplayCount, matchShowNoTeacherWarning, matchEmptyReasons, recommendedTeachers,
        QUOTA_DEDUCT_FEE, ACTIVITY_PUBLIC_FEE
      }, slot);
    };

    /** 批次媒合：同一人全代 — ui-timetable */
    function fetchBatchRecommendations() {
      const a = getTimetableApi();
      if (!a) return;
      a.fetchBatchRecommendations({
        batchSlots, batchAssignMode, batchActiveSlot, batchActiveSlotKey, activeCell, inputRequestDate,
        teachersList, getTeacherSubjectByEmail, activityBalanceCtx, recommendationLoading, matchMode,
        matchSearchQuery, matchDisplayCount, matchShowNoTeacherWarning, matchEmptyReasons, recommendedTeachers,
        QUOTA_DEDUCT_FEE, ACTIVITY_PUBLIC_FEE
      });
    };

    /** 每節不同人：點某一節 → 載入該節空堂名單 */
    function selectBatchSlotForMatch(slotKey) {
      const slot = batchSlots.value.find(s => s.key === slotKey);
      if (!slot) return;
      batchActiveSlotKey.value = slotKey;
      activeCell.value = {
        teacherEmail: slot.teacherEmail,
        teacherName: slot.teacherName,
        dayOfWeek: slot.dayOfWeek,
        period: slot.period,
        classData: {
          className: slot.className,
          subject: slot.subject,
          restriction: slot.restriction || ''
        }
      };
      inputRequestDate.value = slot.dateStr;
      matchPreview.value = null;
      fetchSingleSlotRecommendations(slot);
    };

    /** 選完節次 → 開智慧媒合抽屜 */
    function openBatchMatch() {
      if (batchSlots.value.length < 2) {
        showToast('請至少選 2 節再媒合（單節請直接點格子）', 'info');
        return;
      }
      const first = batchSlots.value[0];
      activeCell.value = {
        teacherEmail: first.teacherEmail,
        teacherName: first.teacherName,
        dayOfWeek: first.dayOfWeek,
        period: first.period,
        classData: {
          className: first.className,
          subject: first.subject,
          restriction: first.restriction || ''
        }
      };
      inputRequestDate.value = first.dateStr;
      matchMode.value = 'substitution';
      matchPreview.value = null;
      showCompareModal.value = false;
      showBatchConfirmModal.value = false;
      if (batchAssignMode.value === 'perSlot') {
        batchActiveSlotKey.value = first.key;
      } else {
        batchActiveSlotKey.value = '';
      }
      showMatchModal.value = true;
      fetchBatchRecommendations();
    };

    /** 同一人全代：從媒合名單選人 → 申請表單 */
    async function prepBatchCompare(targetEmail) {
      if (batchSlots.value.length < 2 || !targetEmail) return;
      if (batchAssignMode.value === 'perSlot') {
        await assignBatchSlotSub(targetEmail);
        return;
      }
      const leaveEmail = batchSlots.value[0].teacherEmail;
      const first = batchSlots.value[0];
      const conflicts = batchSlots.value.filter(s => {
        const cell = getScheduleForDate(targetEmail, s.dateStr, s.period, s.dayOfWeek);
        return isSlotConflict(cell);
      });
      var proxyForce2 = false;
      if (deps.isProxySubmitActive) {
        proxyForce2 = typeof deps.isProxySubmitActive === 'function'
          ? !!deps.isProxySubmitActive()
          : !!deps.isProxySubmitActive.value;
      }
      if (conflicts.length && !isAdmin.value && !proxyForce2) {
        showToast(`該教師在 ${conflicts.map(c => c.dateStr + '第' + c.period + '節').join('、')} 有課`, 'warning');
        return;
      }
      if (conflicts.length && (isAdmin.value || proxyForce2)) {
        const ok = await showConfirm(
          `該教師於以下節次已有課：\n${conflicts.map(c => c.dateStr + ' 第' + c.period + '節').join('\n')}\n\n可強制安排，確定？`,
          '衝堂警告'
        );
        if (!ok) return;
      }
      // 巡堂節：可排但提醒
      const patrolSlots = batchSlots.value.filter(s => {
        const cell = getScheduleForDate(targetEmail, s.dateStr, s.period, s.dayOfWeek);
        return window.DomainSchedule && window.DomainSchedule.isPatrolCell
          && window.DomainSchedule.isPatrolCell(cell);
      });
      if (patrolSlots.length) {
        const tip = (window.DomainSchedule && window.DomainSchedule.PATROL_INCOMING_TIP)
          || '對方本節為【巡堂】。排入後請私下協調代巡堂或互換。';
        const okP = await showConfirm(
          tip + '\n\n涉及：' + patrolSlots.map(c => c.dateStr + '第' + c.period + '節').join('、') + '\n\n仍要繼續？',
          '巡堂提醒'
        );
        if (!okP) return;
      }

      batchSubTeacher.value = targetEmail;
      batchCompareViewEmail.value = targetEmail;
      batchSlots.value = batchSlots.value.map(s => ({
        ...s,
        subTeacherEmail: targetEmail,
        subTeacherName: getTeacherNameByEmail(targetEmail)
      }));
      consecAlertsA.value = [];
      consecAlertsB.value = [];
      const byDate = {};
      batchSlots.value.forEach(s => {
        if (!byDate[s.dateStr]) byDate[s.dateStr] = [];
        byDate[s.dateStr].push(s.period);
      });
      Object.keys(byDate).forEach(dateStr => {
        const periods = byDate[dateStr];
        let busy = 0;
        for (let p = 1; p <= 8; p++) {
          const cell = getScheduleForDate(targetEmail, dateStr, p, new Date(dateStr.replace(/-/g, '/')).getDay());
          const willAdd = periods.indexOf(p) >= 0;
          const isPatrol = window.DomainSchedule && window.DomainSchedule.isPatrolCell
            && window.DomainSchedule.isPatrolCell(cell);
          if ((cell && !cell.isSubstituted && !isPatrol) || willAdd) busy++;
        }
        if (busy >= 5) {
          consecAlertsB.value.push(`${formatDateMMDD(dateStr)} 當日將達 ${busy} 節（含代課）`);
        }
      });

      pendingRequestData.value = {
        mode: 'substitution',
        leaveTeacher: leaveEmail,
        subTeacher: targetEmail,
        date: first.dateStr,
        timeKey: (window.DateUtils && window.DateUtils.encodeTimeKey)
          ? window.DateUtils.encodeTimeKey(first.dayOfWeek, first.period)
          : (`${first.dayOfWeek}-${first.period}`),
        cls: first.className,
        subject: first.subject,
        dateB: '',
        timeB: '',
        subB: '',
        subBClass: '',
        reason: isMutualCover.value ? '公假' : '',
        subFee: (function () {
          const allP8 = (batchSlots.value || []).length && batchSlots.value.every(s => parseInt(s.period, 10) === 8);
          if (allP8) return PERIOD8_FEE;
          if (isMutualCover.value) {
            return (((recommendedTeachers.value || []).find(t => t.email && String(t.email).toLowerCase() === String(targetEmail).toLowerCase()) || {}).suggestedFee
              || ACTIVITY_PUBLIC_FEE);
          }
          return '自費代課';
        })(),
        note: '',
        isBatch: true,
        batchCount: batchSlots.value.length,
        isPerSlot: false
      };
      if (isMutualCover.value) directApproveMode.value = true;
      showMatchModal.value = false;
      showBatchConfirmModal.value = false;
      showCompareModal.value = true;
    };

    /** 每節不同人：為目前 active 節次指定代課老師 */
    async function assignBatchSlotSub(targetEmail) {
      if (!targetEmail || !batchActiveSlotKey.value) {
        showToast('請先點選要安排的節次', 'info');
        return;
      }
      const slot = batchSlots.value.find(s => s.key === batchActiveSlotKey.value);
      if (!slot) return;
      const cell = getScheduleForDate(targetEmail, slot.dateStr, slot.period, slot.dayOfWeek);
      if (window.DomainSchedule && window.DomainSchedule.isPatrolCell
          && window.DomainSchedule.isPatrolCell(cell)) {
        const tip = (window.DomainSchedule && window.DomainSchedule.PATROL_INCOMING_TIP)
          || '對方本節為【巡堂】。排入後請私下協調代巡堂或互換。';
        const okP = await showConfirm(tip + '\n\n仍要指定？', '巡堂提醒');
        if (!okP) return;
      }
      if (isSlotConflict(cell)) {
        if (isAdmin.value) {
          const ok = await showConfirm(
            `${getTeacherNameByEmail(targetEmail)} 老師在 ${slot.dateStr} 第${slot.period}節 已有課，管理員可強制安排，確定？`,
            '衝堂警告'
          );
          if (!ok) return;
        } else {
          showToast(`該教師在 ${slot.dateStr} 第${slot.period}節 有課`, 'warning');
          return;
        }
      }
      const subName = getTeacherNameByEmail(targetEmail);
      batchSlots.value = batchSlots.value.map(s =>
        s.key === slot.key
          ? { ...s, subTeacherEmail: targetEmail, subTeacherName: subName }
          : s
      );
      showToast(`已指定：${formatDateMMDD(slot.dateStr)} 第${slot.period}節 → ${subName}`, 'success');
      // 自動跳下一節未指定者
      const next = batchSlots.value.find(s => !s.subTeacherEmail);
      if (next) {
        selectBatchSlotForMatch(next.key);
      } else {
        recommendedTeachers.value = [];
        matchShowNoTeacherWarning.value = false;
        if (matchEmptyReasons) matchEmptyReasons.value = null;
        showToast('全部節次已指定代課老師，可按「確認申請」', 'info');
      }
    };

    function clearBatchSlotSub(slotKey) {
      batchSlots.value = batchSlots.value.map(s =>
        s.key === slotKey ? { ...s, subTeacherEmail: '', subTeacherName: '' } : s
      );
      if (batchActiveSlotKey.value === slotKey) {
        fetchSingleSlotRecommendations(batchSlots.value.find(s => s.key === slotKey));
      }
    };

    /** 每節不同人：全部指定完 → 進入申請表單 */
    function prepBatchPerSlotCompare() {
      if (!batchAllSlotsAssigned.value) {
        const miss = batchSlots.value.filter(s => !s.subTeacherEmail).length;
        showToast(`尚有 ${miss} 節未指定代課老師`, 'warning');
        return;
      }
      const leaveEmail = batchSlots.value[0].teacherEmail;
      const first = batchSlots.value[0];
      consecAlertsA.value = [];
      consecAlertsB.value = [];
      // 各代課老師連堂／過重檢測
      const bySubDate = {};
      batchSlots.value.forEach(s => {
        const k = `${String(s.subTeacherEmail).toLowerCase()}|${s.dateStr}`;
        if (!bySubDate[k]) bySubDate[k] = { email: s.subTeacherEmail, dateStr: s.dateStr, periods: [] };
        bySubDate[k].periods.push(s.period);
      });
      Object.values(bySubDate).forEach(g => {
        let busy = 0;
        const day = new Date(g.dateStr.replace(/-/g, '/')).getDay();
        for (let p = 1; p <= 8; p++) {
          const cell = getScheduleForDate(g.email, g.dateStr, p, day);
          const willAdd = g.periods.indexOf(p) >= 0;
          if ((cell && !cell.isSubstituted) || willAdd) busy++;
        }
        if (busy >= 5) {
          consecAlertsB.value.push(`${getTeacherNameByEmail(g.email)} ${formatDateMMDD(g.dateStr)} 將達 ${busy} 節`);
        }
      });

      const groups = groupBatchSlotsBySub(batchSlots.value);
      batchCompareViewEmail.value = groups.length ? groups[0].subEmail : '';
      pendingRequestData.value = {
        mode: 'substitution',
        leaveTeacher: leaveEmail,
        subTeacher: groups.length === 1 ? groups[0].subEmail : (groups[0] ? groups[0].subEmail : ''),
        date: first.dateStr,
        timeKey: (window.DateUtils && window.DateUtils.encodeTimeKey)
          ? window.DateUtils.encodeTimeKey(first.dayOfWeek, first.period)
          : (`${first.dayOfWeek}-${first.period}`),
        cls: first.className,
        subject: first.subject,
        dateB: '',
        timeB: '',
        subB: '',
        subBClass: '',
        reason: isMutualCover.value ? '公假' : '',
        subFee: isMutualCover.value ? ACTIVITY_PUBLIC_FEE : '自費代課',
        note: '',
        isBatch: true,
        batchCount: batchSlots.value.length,
        isPerSlot: true,
        subTeacherCount: groups.length
      };
      if (isMutualCover.value) directApproveMode.value = true;
      showMatchModal.value = false;
      showBatchConfirmModal.value = false;
      showCompareModal.value = true;
    };

    function setBatchCompareViewEmail(email) {
      batchCompareViewEmail.value = email || '';
    };

    async function executeBatchSubmit() {
      if (!window.UiBatchSubmit) {
        showToast('批次送出模組未載入', 'error');
        return;
      }
      await window.UiBatchSubmit.executeBatchSubmit({
        batchSlots, pendingRequestData, batchAssignMode, batchReason, batchNote, batchSubTeacher, batchSubFee,
        showToast, showConfirm, getScheduleForDate, getTeacherNameByEmail,
        isMutualCover, mutualAwayClasses, mutualSkipNotify, isAdmin, isQuotaDeductFee,
        QUOTA_DEDUCT_FEE, ACTIVITY_PUBLIC_FEE, PERIOD8_FEE, defaultSubFeeForReason, assertQuotaDeductAllowed,
        loading, loadingMessage, isSubmitting: deps.isSubmitting, currentSemester, directApproveMode, directApproveSkipNotify,
        callGasApi, optimisticUpsertRequest, sheetRequestToFront, deductMutualQuotaForRows, softRefreshInBackground,
        activityBalanceCtx, successModalTitle, successModalMessage, hasLineTemplate, lineBatchParts, lineCopyText,
        showSuccessModal, showCompareModal, showMatchModal, batchSelectMode, clearBatchSlots, buildLineBatchInviteText, DAC
      });
    };

    return {
      batchSlotKey: batchSlotKey,
      isBatchSlotSelected: isBatchSlotSelected,
      clearBatchSlots: clearBatchSlots,
      isBatchMatchFlow: isBatchMatchFlow,
      isBatchPerSlotMode: isBatchPerSlotMode,
      batchAssignedCount: batchAssignedCount,
      batchAllSlotsAssigned: batchAllSlotsAssigned,
      batchActiveSlot: batchActiveSlot,
      groupBatchSlotsBySub: groupBatchSlotsBySub,
      setBatchAssignMode: setBatchAssignMode,
      toggleBatchSelectMode: toggleBatchSelectMode,
      toggleBatchSlot: toggleBatchSlot,
      fetchSingleSlotRecommendations: fetchSingleSlotRecommendations,
      fetchBatchRecommendations: fetchBatchRecommendations,
      selectBatchSlotForMatch: selectBatchSlotForMatch,
      openBatchMatch: openBatchMatch,
      prepBatchCompare: prepBatchCompare,
      assignBatchSlotSub: assignBatchSlotSub,
      clearBatchSlotSub: clearBatchSlotSub,
      prepBatchPerSlotCompare: prepBatchPerSlotCompare,
      setBatchCompareViewEmail: setBatchCompareViewEmail,
      executeBatchSubmit: executeBatchSubmit
    };
  }

  return { create: create };
})();
