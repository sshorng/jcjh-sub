/**
 * ui-timetable.js — 課表存取層（方案甲第三大塊）
 * 含：解析／grid／格樣式／點格／媒合名單／預覽高亮／班級課表點格／批次媒合
 */
window.UiTimetable = (function () {
  /**
   * @param {object} deps Vue ref/computed 與回呼
   */
  function create(deps) {
    var computed = deps.computed;
    var allSchedules = deps.allSchedules;
    var substitutionRecords = deps.substitutionRecords;
    var substitutionsLookup = deps.substitutionsLookup; // computed Map-like
    var allPendingRequests = deps.allPendingRequests;
    var displayTimetableTeachers = deps.displayTimetableTeachers;
    var currentWeekDates = deps.currentWeekDates;
    var getTeacherNameByEmail = deps.getTeacherNameByEmail;
    var getTeacherSubjectByEmail = deps.getTeacherSubjectByEmail;
    var formatDateMMDD = deps.formatDateMMDD;
    var isSingleWeek = deps.isSingleWeek;
    var isClassAwayOnDate = deps.isClassAwayOnDate;
    var getWeekDayText = deps.getWeekDayText;
    var batchSelectMode = deps.batchSelectMode;
    var isBatchSlotSelected = deps.isBatchSlotSelected;
    var isMutualCover = deps.isMutualCover;
    var getMutualDraftAt = deps.getMutualDraftAt;
    var mutualAwayClasses = deps.mutualAwayClasses;
    var mutualActivityStart = deps.mutualActivityStart;
    var mutualActivityEnd = deps.mutualActivityEnd;
    var DAC = deps.DAC || function () { return window.DomainActivityCover; };

    var scheduleIndex = computed(function () {
      return window.DomainSchedule.buildScheduleIndex(allSchedules.value);
    });

    var pendingIndex = computed(function () {
      if (window.DomainSchedule && window.DomainSchedule.buildPendingIndex) {
        return window.DomainSchedule.buildPendingIndex(allPendingRequests.value);
      }
      return null;
    });

    var _scheduleCache = new Map();

    function clearScheduleCache() {
      _scheduleCache.clear();
    }

    function getApprovedScheduleForDate(teacherEmail, dateStr, period, dayOfWeek) {
      var key = dateStr + '_' + period;
      var lookup = substitutionsLookup.value || {};
      return window.DomainSchedule.resolveApprovedSchedule({
        teacherEmail: teacherEmail,
        dateStr: dateStr,
        period: period,
        dayOfWeek: dayOfWeek,
        allSchedules: allSchedules.value,
        scheduleIndex: scheduleIndex.value,
        periodSubs: lookup[key] || [],
        allSubs: substitutionRecords.value,
        helpers: {
          getTeacherNameByEmail: getTeacherNameByEmail,
          getTeacherSubjectByEmail: getTeacherSubjectByEmail,
          formatDateMMDD: formatDateMMDD,
          isSingleWeek: isSingleWeek,
          isClassAway: isClassAwayOnDate
        }
      });
    }

    function getScheduleForDate(teacherEmail, dateStr, period, dayOfWeek) {
      var memoKey = teacherEmail + '|' + dateStr + '|' + period;
      if (_scheduleCache.has(memoKey)) return _scheduleCache.get(memoKey);
      var cell = getApprovedScheduleForDate(teacherEmail, dateStr, period, dayOfWeek);
      var merged = window.DomainSchedule.applyPendingOverlay({
        cell: cell,
        teacherEmail: teacherEmail,
        dateStr: dateStr,
        period: period,
        pendingRequests: allPendingRequests.value,
        pendingIndex: pendingIndex.value,
        getWeekDayText: getWeekDayText,
        allSchedules: allSchedules.value,
        scheduleIndex: scheduleIndex.value
      });
      if (merged && merged.className && !merged.isClassAway && isClassAwayOnDate(merged.className, dateStr)) {
        merged = Object.assign({}, merged, { isClassAway: true });
      }
      _scheduleCache.set(memoKey, merged);
      return merged;
    }

    var weekScheduleGrid = computed(function () {
      // 明確依賴索引／lookup，避免 memo 命中時漏追蹤、異動後不重畫
      void pendingIndex.value;
      void scheduleIndex.value;
      void substitutionsLookup.value;
      var grid = {};
      var teachers = displayTimetableTeachers.value || [];
      var dates = currentWeekDates.value || [];
      teachers.forEach(function (t) {
        if (!t || !t.email) return;
        var row = {};
        for (var day = 1; day <= 5; day++) {
          var dateStr = dates[day - 1];
          if (!dateStr) continue;
          for (var period = 1; period <= 8; period++) {
            row[day + '-' + period] = getScheduleForDate(t.email, dateStr, period, day);
          }
        }
        grid[t.email] = row;
        var low = String(t.email).toLowerCase();
        if (low !== t.email) grid[low] = row;
      });
      return grid;
    });

    function cellFromGrid(email, day, period) {
      var g = weekScheduleGrid.value;
      if (!g || !email) return null;
      var row = g[email] || g[String(email).toLowerCase()];
      return row ? (row[day + '-' + period] || null) : null;
    }

    function isAwayClassCell(className, dateStr) {
      if (!className) return false;
      var cls = String(className).trim();
      if (!cls) return false;
      if (isClassAwayOnDate(cls, dateStr)) return true;
      if (!isMutualCover.value) return false;
      if (!(mutualAwayClasses.value || []).includes(cls)) return false;
      var start = mutualActivityStart.value;
      var end = mutualActivityEnd.value;
      if (!start && !end) return true;
      if (DAC() && DAC().isDateInRange) {
        return DAC().isDateInRange(dateStr, start, end);
      }
      var d = String(dateStr || '').slice(0, 10);
      if (start && d < start) return false;
      if (end && d > end) return false;
      return true;
    }

    function getClassCellClassForDate(teacherEmail, dateStr, period, dayOfWeek) {
      var cell = getScheduleForDate(teacherEmail, dateStr, period, dayOfWeek);
      if (!cell) return 'is-empty';
      var draftOn = isMutualCover.value && !!getMutualDraftAt(teacherEmail, dateStr, period);
      // 批次選取：疊在狀態 class 上（保留 is-substituted-in 等），避免 Vue 重繪洗掉 DOM 高亮
      var batchOn = batchSelectMode.value && isBatchSlotSelected(teacherEmail, dateStr, period);
      var batchCls = batchOn ? ' is-batch-selected' : '';
      if (cell.isPending) {
        if (cell.pendingType === 'substitution_out') return 'is-pending-sub-out' + batchCls;
        if (cell.pendingType === 'substitution_in') return 'is-pending-sub-in' + batchCls;
        if (cell.pendingType === 'exchange_out') return 'is-pending-exc-out' + batchCls;
        if (cell.pendingType === 'exchange_in') return 'is-pending-exc-in' + batchCls;
      }
      if (cell.isSubstituted) {
        return (cell.subType === 'exchange' ? 'is-exchange-out' : 'is-substituted-out') + batchCls;
      }
      if (cell.isSubstitutionDuty) {
        return (cell.subType === 'exchange' ? 'is-exchange-in' : 'is-substituted-in') + batchCls;
      }
      if (draftOn) return 'is-mutual-draft' + batchCls;
      if (isAwayClassCell(cell.className, dateStr) || cell.isClassAway) return 'is-away-class' + batchCls;
      if (cell.isPatrol || cell.attr === '巡堂') return 'is-patrol' + batchCls;
      // 第8節／輔導：與一般課同色（僅 badge 標「輔導」）
      if (cell.attr === '兼課') return 'is-overtime' + batchCls;
      if (cell.attr === '實支') return 'is-elastic' + batchCls;
      return 'has-class' + batchCls;
    }

    /**
     * 智慧代課媒合名單（單節）
     * 優先後端 getMatchCandidates（教師瘦課表時必備）；失敗再本地 DomainMatch
     * deps 需含媒合用 ref：matchMode, inputRequestDate, activeCell, teachersList, …
     * 可選：fetchMatchCandidates（async API）
     */
    function fetchRecommendations(matchDeps) {
      var matchMode = matchDeps.matchMode;
      var inputRequestDate = matchDeps.inputRequestDate;
      var activeCell = matchDeps.activeCell;
      var teachersList = matchDeps.teachersList;
      var getTeacherSubjectByEmail = matchDeps.getTeacherSubjectByEmail;
      var activityBalanceCtx = matchDeps.activityBalanceCtx;
      var recommendationLoading = matchDeps.recommendationLoading;
      var matchSearchQuery = matchDeps.matchSearchQuery;
      var matchDisplayCount = matchDeps.matchDisplayCount;
      var matchShowNoTeacherWarning = matchDeps.matchShowNoTeacherWarning;
      var recommendedTeachers = matchDeps.recommendedTeachers;
      var fetchMatchCandidates = matchDeps.fetchMatchCandidates;

      if (matchMode.value !== 'substitution' || !inputRequestDate.value) return;
      recommendationLoading.value = true;

      function applyList(list) {
        list = list || [];
        if (isMutualCover.value && DAC() && DAC().enrichCandidatesWithBalance) {
          list = DAC().enrichCandidatesWithBalance(list, activityBalanceCtx());
        }
        matchSearchQuery.value = '';
        matchDisplayCount.value = 10;
        matchShowNoTeacherWarning.value = list.length === 0;
        recommendedTeachers.value = list;
        recommendationLoading.value = false;
      }

      function runLocal() {
        var leaveEmail = activeCell.value.teacherEmail;
        var leaveTeacher = (teachersList.value || []).find(function (t) {
          return t.email && leaveEmail
            && String(t.email).toLowerCase() === String(leaveEmail).toLowerCase();
        });
        var list = window.DomainMatch.rankSubstitutionCandidates({
          teachers: teachersList.value,
          allSchedules: allSchedules.value,
          leaveEmail: leaveEmail,
          dateStr: inputRequestDate.value,
          targetDay: activeCell.value.dayOfWeek,
          targetPeriod: activeCell.value.period,
          myCourse: activeCell.value.classData ? activeCell.value.classData.subject : '',
          myDomain: leaveTeacher
            ? (leaveTeacher.subject || '')
            : getTeacherSubjectByEmail(leaveEmail),
          myClass: activeCell.value.classData ? activeCell.value.classData.className : '',
          getScheduleForDate: getScheduleForDate,
          awayClasses: isMutualCover.value ? mutualAwayClasses.value : [],
          activityMode: !!isMutualCover.value,
          preferReleasedByAway: !!isMutualCover.value
        });
        applyList(list);
      }

      function runRemoteThenLocal() {
        var leaveEmail = activeCell.value.teacherEmail;
        var leaveTeacher = (teachersList.value || []).find(function (t) {
          return t.email && leaveEmail
            && String(t.email).toLowerCase() === String(leaveEmail).toLowerCase();
        });
        var myCourse = activeCell.value.classData ? activeCell.value.classData.subject : '';
        var myClass = activeCell.value.classData ? activeCell.value.classData.className : '';
        var myDomain = leaveTeacher
          ? (leaveTeacher.subject || '')
          : getTeacherSubjectByEmail(leaveEmail);
        // 僅「課表明顯不全」（教師端瘦身）才打後端；有全校課表一律本地（比 GAS 往返快）
        var schedLen = (allSchedules.value || []).length;
        var teacherN = (teachersList.value || []).length;
        var scope = matchDeps.scheduleScope
          ? (matchDeps.scheduleScope.value != null ? matchDeps.scheduleScope.value : matchDeps.scheduleScope)
          : '';
        var slimScope = String(scope || '') === 'teacher_self_and_class';
        // 啟發式：人均課表列偏少 → 多半是瘦包（全校通常 ≳ 人均 8～15）
        var seemsSlim = teacherN > 0 && schedLen > 0 && schedLen < teacherN * 4;
        var preferRemote = typeof fetchMatchCandidates === 'function'
          && (slimScope || seemsSlim);

        if (!preferRemote) {
          runLocal();
          return;
        }

        // 短快取：同節 45 秒內不重複打 GAS
        var cacheKey = [
          leaveEmail, inputRequestDate.value,
          activeCell.value.dayOfWeek, activeCell.value.period,
          myClass, myCourse, isMutualCover.value ? '1' : '0'
        ].join('|');
        var now = Date.now();
        if (!fetchRecommendations._cache) fetchRecommendations._cache = {};
        var hit = fetchRecommendations._cache[cacheKey];
        if (hit && (now - hit.ts) < 45000 && hit.list) {
          applyList(hit.list.slice());
          return;
        }

        fetchMatchCandidates({
          leaveEmail: leaveEmail,
          dateStr: inputRequestDate.value,
          dayOfWeek: activeCell.value.dayOfWeek,
          period: activeCell.value.period,
          myCourse: myCourse,
          myDomain: myDomain,
          myClass: myClass,
          awayClasses: isMutualCover.value ? mutualAwayClasses.value : [],
          activityMode: !!isMutualCover.value,
          limit: 40
        }).then(function (res) {
          var raw = (res && res.candidates) || [];
          var list = raw.map(function (c) {
            return {
              email: c.email,
              name: c.name,
              subject: c.subject,
              role: c.role || 'teacher',
              baseHours: c.baseHours,
              mutualQuota: c.mutualQuota,
              todayPeriodCount: c.todayPeriodCount || 0,
              isSameCourse: !!c.isSameCourse,
              isSameSubject: !!c.isSameSubject,
              isSameClass: !!c.isSameClass,
              isReleasedByAway: !!c.isReleasedByAway,
              suggestedFee: c.suggestedFee || '',
              demandDomain: c.demandDomain || '',
              score: c.score || 0
            };
          });
          try {
            fetchRecommendations._cache[cacheKey] = { ts: Date.now(), list: list };
            // 最多留 20 組
            var keys = Object.keys(fetchRecommendations._cache);
            if (keys.length > 20) {
              keys.sort(function (a, b) {
                return (fetchRecommendations._cache[a].ts || 0) - (fetchRecommendations._cache[b].ts || 0);
              });
              keys.slice(0, keys.length - 20).forEach(function (k) {
                delete fetchRecommendations._cache[k];
              });
            }
          } catch (eC) { /* ignore */ }
          applyList(list);
        }).catch(function (err) {
          console.warn('getMatchCandidates 失敗，改本地媒合：', err);
          runLocal();
        });
      }

      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(function () { setTimeout(runRemoteThenLocal, 0); });
      } else {
        setTimeout(runRemoteThenLocal, 0);
      }
    }

    /**
     * 點課表格（一般／互代／批次／詳情）
     */
    async function handleCellClick(clickDeps, teacherEmail, dayOfWeek, period, dateStr) {
      var isScheduleEditMode = clickDeps.isScheduleEditMode;
      var openScheduleEditModal = clickDeps.openScheduleEditModal;
      var showToast = clickDeps.showToast;
      var showConfirm = clickDeps.showConfirm;
      var isMutualLead = clickDeps.isMutualLead;
      var getMutualDraftAt = clickDeps.getMutualDraftAt;
      var removeMutualDraft = clickDeps.removeMutualDraft;
      var activeCell = clickDeps.activeCell;
      var inputRequestDate = clickDeps.inputRequestDate;
      var matchMode = clickDeps.matchMode;
      var matchPreview = clickDeps.matchPreview;
      var showCompareModal = clickDeps.showCompareModal;
      var showMatchModal = clickDeps.showMatchModal;
      var fetchRecommendationsFn = clickDeps.fetchRecommendations;
      var batchSelectMode = clickDeps.batchSelectMode;
      var isAdmin = clickDeps.isAdmin;
      var user = clickDeps.user;
      var toggleBatchSlot = clickDeps.toggleBatchSlot;
      var detailRequest = clickDeps.detailRequest;
      var detailSubRecord = clickDeps.detailSubRecord;
      var showDetailModal = clickDeps.showDetailModal;
      var resolveDetailRequest = clickDeps.resolveDetailRequest;
      var getTeacherNameByEmail = clickDeps.getTeacherNameByEmail;
      var exchangeTargetDate = clickDeps.exchangeTargetDate;
      var exchangeWeekOffset = clickDeps.exchangeWeekOffset;
      var exchangePeriodId = clickDeps.exchangePeriodId;
      var exchangeTeacherEmail = clickDeps.exchangeTeacherEmail;

      if (isScheduleEditMode.value) {
        openScheduleEditModal(teacherEmail, dayOfWeek, period);
        return;
      }

      var cell = getScheduleForDate(teacherEmail, dateStr, period, dayOfWeek);
      if (!cell) return;

      if (isMutualCover.value && !batchSelectMode.value) {
        if (!isMutualLead(teacherEmail)) {
          showToast('請先將該老師加入「帶隊老師」，或點帶隊名單定位課表', 'info');
          return;
        }
        if (cell.isPatrol || cell.attr === '巡堂') {
          showToast('巡堂節不列入活動互代（不計鐘點）；請私下安排代巡', 'info');
          return;
        }
        if (cell.isSubstituted) {
          showToast('此格已調出／請假，無法暫定', 'warning');
          return;
        }
        if (cell.isPending) {
          showToast('此格尚有進行中申請', 'warning');
          return;
        }
        var existing = getMutualDraftAt(teacherEmail, dateStr, period);
        if (existing) {
          var clear = await showConfirm(
            '此節已暫定由 ' + existing.subName + ' 代課（' + existing.fee + '）。\n清除暫定？\n（取消則重新選人）',
            '暫定安排'
          );
          if (clear) {
            removeMutualDraft(existing.key);
            showToast('已清除暫定', 'info');
            return;
          }
        }
        activeCell.value = {
          teacherEmail: teacherEmail,
          teacherName: getTeacherNameByEmail(teacherEmail),
          dayOfWeek: dayOfWeek,
          period: period,
          classData: cell
        };
        inputRequestDate.value = dateStr;
        matchMode.value = 'substitution';
        matchPreview.value = null;
        showCompareModal.value = false;
        showMatchModal.value = true;
        fetchRecommendationsFn();
        return;
      }

      if (batchSelectMode.value) {
        if (cell.isPatrol || cell.attr === '巡堂') {
          showToast('巡堂節不需批次代課；若要請人代巡，請私下安排', 'info');
          return;
        }
        if (cell.isSubstituted) {
          showToast('此格已調出／請假，非實際上課，無法加入批次', 'warning');
          return;
        }
        if (cell.isPending) {
          showToast('此格尚有進行中申請，無法加入批次', 'warning');
          return;
        }
        if (!isAdmin.value && user.value
            && String(teacherEmail).toLowerCase() !== String(user.value.email).toLowerCase()) {
          showToast('一般教師只能批次自己的課', 'warning');
          return;
        }
        toggleBatchSlot({
          teacherEmail: teacherEmail,
          teacherName: getTeacherNameByEmail(teacherEmail),
          dateStr: dateStr,
          dayOfWeek: dayOfWeek,
          period: period,
          className: cell.className,
          subject: cell.subject,
          restriction: cell.restriction || '',
          isDuty: !!cell.isSubstitutionDuty,
          dutyType: cell.subType || ''
        });
        return;
      }

      if (cell.isPending && cell.pendingRecord) {
        detailRequest.value = cell.pendingRecord;
        detailSubRecord.value = null;
        showDetailModal.value = true;
        return;
      }

      if (cell.subRecord) {
        var reqId = cell.subRecord.requestId;
        detailSubRecord.value = cell.subRecord;
        var resolved = resolveDetailRequest(reqId, cell.subRecord);
        if (resolved) {
          detailRequest.value = resolved;
        } else {
          detailRequest.value = {
            id: 'N/A', serial: '---', type: 'substitution',
            requestDate: cell.subRecord.date
          };
        }
        showDetailModal.value = true;
        return;
      }

      // 巡堂：不算鐘點、不開代課／調課流程（請私下代巡）
      if (cell.isPatrol || cell.attr === '巡堂') {
        showToast('本節為【巡堂】：不計鐘點、不需系統代課；若要請人代巡，請私下安排或互換', 'info');
        return;
      }

      activeCell.value = {
        teacherEmail: teacherEmail,
        teacherName: getTeacherNameByEmail(teacherEmail),
        dayOfWeek: dayOfWeek,
        period: period,
        classData: cell
      };
      inputRequestDate.value = dateStr;
      if (cell.restriction === 'restricted') {
        matchMode.value = 'substitution';
      }
      exchangeTargetDate.value = '';
      exchangeWeekOffset.value = 0;
      exchangePeriodId.value = '';
      exchangeTeacherEmail.value = '';
      if (matchMode.value === 'substitution') {
        fetchRecommendationsFn();
      }
      matchPreview.value = null;
      showMatchModal.value = true;
    }

    /**
     * 單節媒合（批次「每節不同人」）
     */
    function fetchSingleSlotRecommendations(matchDeps, slot) {
      if (!slot) return;
      var teachersList = matchDeps.teachersList;
      var getTeacherSubjectByEmail = matchDeps.getTeacherSubjectByEmail;
      var activityBalanceCtx = matchDeps.activityBalanceCtx;
      var recommendationLoading = matchDeps.recommendationLoading;
      var matchMode = matchDeps.matchMode;
      var matchSearchQuery = matchDeps.matchSearchQuery;
      var matchDisplayCount = matchDeps.matchDisplayCount;
      var matchShowNoTeacherWarning = matchDeps.matchShowNoTeacherWarning;
      var recommendedTeachers = matchDeps.recommendedTeachers;
      var QUOTA_DEDUCT_FEE = matchDeps.QUOTA_DEDUCT_FEE;
      var ACTIVITY_PUBLIC_FEE = matchDeps.ACTIVITY_PUBLIC_FEE;

      recommendationLoading.value = true;
      matchMode.value = 'substitution';
      var runSlot = function () {
        var leaveEmail = slot.teacherEmail;
        var leaveTeacher = (teachersList.value || []).find(function (t) {
          return t.email && leaveEmail
            && String(t.email).toLowerCase() === String(leaveEmail).toLowerCase();
        });
        var myDomain = leaveTeacher
          ? (leaveTeacher.subject || '')
          : getTeacherSubjectByEmail(leaveEmail);
        var awaySet = {};
        (isMutualCover.value ? (mutualAwayClasses.value || []) : []).forEach(function (c) {
          var k = String(c || '').trim();
          if (k) awaySet[k] = true;
        });
        var freeTeachers = (teachersList.value || []).filter(function (t) {
          if (!t.email || String(t.email).toLowerCase() === String(leaveEmail).toLowerCase()) return false;
          var cell = getScheduleForDate(t.email, slot.dateStr, slot.period, slot.dayOfWeek);
          if (window.DomainMatch && window.DomainMatch.isSlotFreeForMatch) {
            return window.DomainMatch.isSlotFreeForMatch(cell, awaySet);
          }
          if (cell === null || cell.isSubstituted || cell.isClassAway) return true;
          if (cell.className && awaySet[String(cell.className).trim()]) return true;
          return false;
        });
        var ranked = window.DomainMatch.rankSubstitutionCandidates({
          teachers: freeTeachers,
          allSchedules: allSchedules.value,
          leaveEmail: leaveEmail,
          dateStr: slot.dateStr,
          targetDay: slot.dayOfWeek,
          targetPeriod: slot.period,
          myCourse: slot.subject || '',
          myDomain: myDomain,
          myClass: slot.className || '',
          getScheduleForDate: getScheduleForDate,
          awayClasses: isMutualCover.value ? mutualAwayClasses.value : [],
          activityMode: !!isMutualCover.value,
          preferReleasedByAway: !!isMutualCover.value
        });
        if (isMutualCover.value && DAC() && DAC().enrichCandidatesWithBalance) {
          ranked = DAC().enrichCandidatesWithBalance(ranked, activityBalanceCtx());
        }
        matchSearchQuery.value = '';
        matchDisplayCount.value = 10;
        matchShowNoTeacherWarning.value = ranked.length === 0;
        recommendedTeachers.value = ranked;
        recommendationLoading.value = false;
      };
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(function () { setTimeout(runSlot, 0); });
      } else {
        setTimeout(runSlot, 0);
      }
    }

    /**
     * 批次媒合：同一人全代（所有節次皆空）
     */
    function fetchBatchRecommendations(matchDeps) {
      var batchSlots = matchDeps.batchSlots;
      var batchAssignMode = matchDeps.batchAssignMode;
      var batchActiveSlot = matchDeps.batchActiveSlot;
      var batchActiveSlotKey = matchDeps.batchActiveSlotKey;
      var activeCell = matchDeps.activeCell;
      var inputRequestDate = matchDeps.inputRequestDate;
      var teachersList = matchDeps.teachersList;
      var getTeacherSubjectByEmail = matchDeps.getTeacherSubjectByEmail;
      var activityBalanceCtx = matchDeps.activityBalanceCtx;
      var recommendationLoading = matchDeps.recommendationLoading;
      var matchMode = matchDeps.matchMode;
      var matchSearchQuery = matchDeps.matchSearchQuery;
      var matchDisplayCount = matchDeps.matchDisplayCount;
      var matchShowNoTeacherWarning = matchDeps.matchShowNoTeacherWarning;
      var recommendedTeachers = matchDeps.recommendedTeachers;
      var QUOTA_DEDUCT_FEE = matchDeps.QUOTA_DEDUCT_FEE;
      var ACTIVITY_PUBLIC_FEE = matchDeps.ACTIVITY_PUBLIC_FEE;

      if (!batchSlots.value || batchSlots.value.length < 2) return;
      if (batchAssignMode.value === 'perSlot') {
        var slot = (batchActiveSlot && batchActiveSlot.value) || batchSlots.value[0];
        if (slot) {
          batchActiveSlotKey.value = slot.key;
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
          fetchSingleSlotRecommendations(matchDeps, slot);
        }
        return;
      }

      recommendationLoading.value = true;
      matchMode.value = 'substitution';
      var runBatch = function () {
        var leaveEmail = batchSlots.value[0].teacherEmail;
        var leaveTeacher = (teachersList.value || []).find(function (t) {
          return t.email && leaveEmail
            && String(t.email).toLowerCase() === String(leaveEmail).toLowerCase();
        });
        var myDomain = leaveTeacher
          ? (leaveTeacher.subject || '')
          : getTeacherSubjectByEmail(leaveEmail);
        var awaySet = {};
        (isMutualCover.value ? (mutualAwayClasses.value || []) : []).forEach(function (c) {
          var k = String(c || '').trim();
          if (k) awaySet[k] = true;
        });
        var freeTeachers = (teachersList.value || []).filter(function (t) {
          if (!t.email || String(t.email).toLowerCase() === String(leaveEmail).toLowerCase()) return false;
          return batchSlots.value.every(function (s) {
            var cell = getScheduleForDate(t.email, s.dateStr, s.period, s.dayOfWeek);
            if (window.DomainMatch && window.DomainMatch.isSlotFreeForMatch) {
              return window.DomainMatch.isSlotFreeForMatch(cell, awaySet);
            }
            if (cell === null || cell.isSubstituted || cell.isClassAway) return true;
            if (cell.className && awaySet[String(cell.className).trim()]) return true;
            return false;
          });
        });
        var scoreMap = {};
        freeTeachers.forEach(function (t) {
          scoreMap[t.email] = Object.assign({}, t, {
            todayPeriodCount: 0,
            isSameCourse: false,
            isSameSubject: false,
            isSameClass: false,
            isReleasedByAway: false,
            suggestedFee: isMutualCover.value ? ACTIVITY_PUBLIC_FEE : '',
            score: 0,
            freeAllSlots: true,
            slotCount: batchSlots.value.length
          });
        });
        batchSlots.value.forEach(function (s) {
          var ranked = window.DomainMatch.rankSubstitutionCandidates({
            teachers: freeTeachers,
            allSchedules: allSchedules.value,
            leaveEmail: leaveEmail,
            dateStr: s.dateStr,
            targetDay: s.dayOfWeek,
            targetPeriod: s.period,
            myCourse: s.subject || '',
            myDomain: myDomain,
            myClass: s.className || '',
            getScheduleForDate: getScheduleForDate,
            awayClasses: isMutualCover.value ? mutualAwayClasses.value : [],
            activityMode: !!isMutualCover.value,
            preferReleasedByAway: !!isMutualCover.value
          });
          ranked.forEach(function (r) {
            if (!scoreMap[r.email]) return;
            scoreMap[r.email].score += (r.score || 0);
            scoreMap[r.email].todayPeriodCount = Math.max(
              scoreMap[r.email].todayPeriodCount,
              r.todayPeriodCount || 0
            );
            if (r.isSameCourse) scoreMap[r.email].isSameCourse = true;
            if (r.isSameSubject) scoreMap[r.email].isSameSubject = true;
            if (r.isSameClass) scoreMap[r.email].isSameClass = true;
            if (r.isReleasedByAway) {
              scoreMap[r.email].isReleasedByAway = true;
              scoreMap[r.email].releasedSlotCount = (scoreMap[r.email].releasedSlotCount || 0) + 1;
              if (isMutualCover.value) scoreMap[r.email].suggestedFee = QUOTA_DEDUCT_FEE;
            }
          });
        });
        var list = Object.keys(scoreMap).map(function (k) { return scoreMap[k]; });
        if (isMutualCover.value && DAC() && DAC().enrichCandidatesWithBalance) {
          list = DAC().enrichCandidatesWithBalance(list, activityBalanceCtx());
        }
        list.sort(function (a, b) {
          if (isMutualCover.value) {
            var qa = typeof a.remainingReleased === 'number' ? a.remainingReleased : 0;
            var qb = typeof b.remainingReleased === 'number' ? b.remainingReleased : 0;
            if (qb !== qa) return qb - qa;
            var ra = a.isReleasedByAway ? 1 : 0;
            var rb = b.isReleasedByAway ? 1 : 0;
            if (rb !== ra) return rb - ra;
            var rca = a.releasedSlotCount || 0;
            var rcb = b.releasedSlotCount || 0;
            if (rcb !== rca) return rcb - rca;
          }
          return b.score - a.score || a.todayPeriodCount - b.todayPeriodCount;
        });
        matchSearchQuery.value = '';
        matchDisplayCount.value = 10;
        matchShowNoTeacherWarning.value = list.length === 0;
        recommendedTeachers.value = list;
        recommendationLoading.value = false;
      };
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(function () { setTimeout(runBatch, 0); });
      } else {
        setTimeout(runBatch, 0);
      }
    }

    return {
      scheduleIndex: scheduleIndex,
      getApprovedScheduleForDate: getApprovedScheduleForDate,
      getScheduleForDate: getScheduleForDate,
      clearScheduleCache: clearScheduleCache,
      weekScheduleGrid: weekScheduleGrid,
      cellFromGrid: cellFromGrid,
      isAwayClassCell: isAwayClassCell,
      getClassCellClassForDate: getClassCellClassForDate,
      fetchRecommendations: fetchRecommendations,
      handleCellClick: handleCellClick,
      fetchSingleSlotRecommendations: fetchSingleSlotRecommendations,
      fetchBatchRecommendations: fetchBatchRecommendations,

      // ── 媒合預覽（課表高亮）──
      selectMatchPreviewSub: function (deps, email) {
        var matchPreview = deps.matchPreview;
        var activeCell = deps.activeCell;
        var getTeacherNameByEmail = deps.getTeacherNameByEmail;
        if (!email || !activeCell.value) {
          matchPreview.value = null;
          return;
        }
        var key = String(email).toLowerCase();
        if (matchPreview.value && matchPreview.value.mode === 'substitution' && matchPreview.value.email === key) {
          matchPreview.value = null;
          return;
        }
        matchPreview.value = {
          mode: 'substitution',
          email: key,
          name: getTeacherNameByEmail(email),
          dayOfWeek: parseInt(activeCell.value.dayOfWeek, 10),
          period: parseInt(activeCell.value.period, 10),
          className: activeCell.value.classData ? activeCell.value.classData.className : '',
          subject: activeCell.value.classData ? activeCell.value.classData.subject : ''
        };
      },
      selectMatchPreviewExchange: function (deps, row) {
        var matchPreview = deps.matchPreview;
        var getTeacherNameByEmail = deps.getTeacherNameByEmail;
        if (!row) {
          matchPreview.value = null;
          return;
        }
        var email = String(row.teacherEmail || '').toLowerCase();
        var day = parseInt(row.dayOfWeek, 10);
        var period = parseInt(row.period, 10);
        if (matchPreview.value && matchPreview.value.mode === 'exchange'
            && matchPreview.value.email === email
            && parseInt(matchPreview.value.dayOfWeek, 10) === day
            && parseInt(matchPreview.value.period, 10) === period) {
          matchPreview.value = null;
          return;
        }
        matchPreview.value = {
          mode: 'exchange',
          email: email,
          name: row.teacherName || getTeacherNameByEmail(row.teacherEmail),
          dayOfWeek: day,
          period: period,
          className: row.className || '',
          subject: row.subject || ''
        };
      },
      clearMatchPreview: function (deps) {
        deps.matchPreview.value = null;
      },
      isMatchPreviewSelected: function (deps, email, day, period) {
        var matchPreview = deps.matchPreview;
        if (!matchPreview.value || !email) return false;
        var p = matchPreview.value;
        if (p.email !== String(email).toLowerCase()) return false;
        if (day === undefined || period === undefined) return true;
        return parseInt(p.dayOfWeek, 10) === parseInt(day, 10)
          && parseInt(p.period, 10) === parseInt(period, 10);
      },
      isMatchSourceCell: function (deps, teacherEmail, day, period) {
        var showMatchModal = deps.showMatchModal;
        var activeCell = deps.activeCell;
        if (!showMatchModal.value || !activeCell.value || !teacherEmail) return false;
        var a = String(activeCell.value.teacherEmail || '').toLowerCase();
        var b = String(teacherEmail || '').toLowerCase();
        return !!(a && a === b
          && parseInt(activeCell.value.dayOfWeek, 10) === parseInt(day, 10)
          && parseInt(activeCell.value.period, 10) === parseInt(period, 10));
      },
      isMatchSourceEntry: function (deps, entry, day, period) {
        var showMatchModal = deps.showMatchModal;
        var activeCell = deps.activeCell;
        if (!showMatchModal.value || !activeCell.value || !entry) return false;
        var tName = activeCell.value.teacherName || '';
        var emailOk = entry.teacherEmail && activeCell.value.teacherEmail
          && String(entry.teacherEmail).toLowerCase() === String(activeCell.value.teacherEmail).toLowerCase();
        var nameOk = entry.teacherName && tName && entry.teacherName === tName;
        return !!(emailOk || nameOk)
          && parseInt(activeCell.value.dayOfWeek, 10) === parseInt(day, 10)
          && parseInt(activeCell.value.period, 10) === parseInt(period, 10)
          && (!activeCell.value.classData || !activeCell.value.classData.subject
            || entry.subject === activeCell.value.classData.subject);
      },
      isMatchHoverCell: function (deps, teacherEmail, day, period) {
        var showMatchModal = deps.showMatchModal;
        var matchPreview = deps.matchPreview;
        var activeCell = deps.activeCell;
        if (!showMatchModal.value || !matchPreview.value || !teacherEmail || !activeCell.value) return false;
        if (matchPreview.value.mode !== 'exchange') return false;
        var self = String(activeCell.value.teacherEmail || '').toLowerCase();
        if (self !== String(teacherEmail).toLowerCase()) return false;
        var h = matchPreview.value;
        return parseInt(h.dayOfWeek, 10) === parseInt(day, 10)
          && parseInt(h.period, 10) === parseInt(period, 10);
      },
      isMatchHoverEntry: function () { return false; },

      getClassCellClassForClass: function (deps, className, day, period) {
        var classSchedules = deps.classSchedules;
        var selectedClassWeekDates = deps.selectedClassWeekDates;
        var classSubstitutionMap = deps.classSubstitutionMap;
        var entries = classSchedules.value[className] && classSchedules.value[className][day + '-' + period];
        if (!entries || !entries.length) return 'is-empty';
        var dateForDay = selectedClassWeekDates.value[day - 1];
        if (dateForDay && classSubstitutionMap.value[className + '|' + dateForDay + '|' + period]) {
          return 'has-substitution';
        }
        if (entries.some(function (e) { return e.attr === '巡堂' || e.isPatrol; })) return 'is-patrol';
        // 第8節／輔導：與一般課同色
        if (entries.some(function (e) { return e.attr === '兼課'; })) return 'is-overtime';
        if (entries.some(function (e) { return e.attr === '實支'; })) return 'is-elastic';
        return 'has-class';
      },

      handleClassCellClick: function (deps, cls, day, period, entryOrIndex) {
        var classSchedules = deps.classSchedules;
        var selectedClassWeekDates = deps.selectedClassWeekDates;
        var classSubstitutionMap = deps.classSubstitutionMap;
        var detailSubRecord = deps.detailSubRecord;
        var detailRequest = deps.detailRequest;
        var showDetailModal = deps.showDetailModal;
        var resolveDetailRequest = deps.resolveDetailRequest;
        var classReadonlyMode = deps.classReadonlyMode;
        var isAdmin = deps.isAdmin;
        var getTeacherNameByEmail = deps.getTeacherNameByEmail;
        var activeCell = deps.activeCell;
        var inputRequestDate = deps.inputRequestDate;
        var matchMode = deps.matchMode;
        var exchangeTargetDate = deps.exchangeTargetDate;
        var exchangeWeekOffset = deps.exchangeWeekOffset;
        var exchangePeriodId = deps.exchangePeriodId;
        var exchangeTeacherEmail = deps.exchangeTeacherEmail;
        var matchPreview = deps.matchPreview;
        var recommendedTeachers = deps.recommendedTeachers;
        var matchSearchQuery = deps.matchSearchQuery;
        var matchDisplayCount = deps.matchDisplayCount;
        var showMatchModal = deps.showMatchModal;
        var fetchRecommendations = deps.fetchRecommendations;

        var entries = classSchedules.value[cls] && classSchedules.value[cls][day + '-' + period];
        if (!entries || !entries.length) return;
        var cellData = entries[0];
        if (entryOrIndex !== undefined && entryOrIndex !== null) {
          if (typeof entryOrIndex === 'object') cellData = entryOrIndex;
          else if (entries[entryOrIndex]) cellData = entries[entryOrIndex];
        }
        var dateForDay = selectedClassWeekDates.value[day - 1];
        if (!dateForDay) return;
        // 唯讀班級課表：所有格子皆不可點（含異動格）
        if (classReadonlyMode && classReadonlyMode.value) return;
        var subKey = cls + '|' + dateForDay + '|' + period;
        var subRecord = classSubstitutionMap.value[subKey];
        if (subRecord) {
          detailSubRecord.value = subRecord;
          var resolved = resolveDetailRequest(subRecord.requestId, subRecord);
          detailRequest.value = resolved || {
            id: 'N/A', serial: '---', type: 'substitution', requestDate: subRecord.date
          };
          showDetailModal.value = true;
          return;
        }
        if (!isAdmin.value) return;
        var tName = cellData.teacherName || getTeacherNameByEmail(cellData.teacherEmail);
        activeCell.value = {
          teacherEmail: cellData.teacherEmail,
          teacherName: tName,
          dayOfWeek: day,
          period: period,
          classData: {
            className: cls,
            subject: cellData.subject,
            teacherName: tName,
            attr: cellData.attr || '基本',
            restriction: cellData.restriction || ''
          }
        };
        inputRequestDate.value = dateForDay;
        if (cellData.restriction === 'restricted') matchMode.value = 'substitution';
        exchangeTargetDate.value = '';
        exchangeWeekOffset.value = 0;
        exchangePeriodId.value = '';
        exchangeTeacherEmail.value = '';
        matchPreview.value = null;
        recommendedTeachers.value = [];
        matchSearchQuery.value = '';
        matchDisplayCount.value = 10;
        if (matchMode.value === 'substitution') fetchRecommendations();
        showMatchModal.value = true;
      },

      startSecondSub: function (deps) {
        var detailSubRecord = deps.detailSubRecord;
        var getTeacherNameByEmail = deps.getTeacherNameByEmail;
        var activeCell = deps.activeCell;
        var inputRequestDate = deps.inputRequestDate;
        var showDetailModal = deps.showDetailModal;
        var exchangeTargetDate = deps.exchangeTargetDate;
        var exchangeWeekOffset = deps.exchangeWeekOffset;
        var exchangePeriodId = deps.exchangePeriodId;
        var exchangeTeacherEmail = deps.exchangeTeacherEmail;
        var matchMode = deps.matchMode;
        var fetchRecommendations = deps.fetchRecommendations;
        var matchPreview = deps.matchPreview;
        var showMatchModal = deps.showMatchModal;
        if (!detailSubRecord.value) return;
        var record = detailSubRecord.value;
        activeCell.value = {
          teacherEmail: record.actualTeacherEmail,
          teacherName: getTeacherNameByEmail(record.actualTeacherEmail),
          dayOfWeek: new Date(String(record.date).replace(/-/g, '/')).getDay(),
          period: record.period,
          classData: {
            className: record.className,
            subject: record.subject,
            teacherEmail: record.actualTeacherEmail
          }
        };
        inputRequestDate.value = record.date;
        showDetailModal.value = false;
        exchangeTargetDate.value = '';
        exchangeWeekOffset.value = 0;
        exchangePeriodId.value = '';
        exchangeTeacherEmail.value = '';
        if (matchMode.value === 'substitution') fetchRecommendations();
        matchPreview.value = null;
        showMatchModal.value = true;
      }
    };
  }

  return { create: create };
})();
