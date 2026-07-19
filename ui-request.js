/**
 * ui-request.js — 一般調代課申請（方案甲）
 * 合併：submit-helpers（驗證／payload／連堂）
 * 對外 API 不變：UiSubmitHelpers
 */
/**
 * 單節申請：驗證＋組裝 payload
 */
window.UiSubmitHelpers = (function () {
  async function validateSubmitRequest(deps) {
    var pending = deps.pendingRequestData.value;
    var showToast = deps.showToast;
    var showConfirm = deps.showConfirm;
    var isAdmin = deps.isAdmin;
    var getTeacherNameByEmail = deps.getTeacherNameByEmail;
    var hasSubTeacherConflict = deps.hasSubTeacherConflict;
    var assertQuotaDeductAllowed = deps.assertQuotaDeductAllowed;

    if (!pending.reason) {
      showToast('請選擇請假原因/假別！', 'info');
      return false;
    }
    if (hasSubTeacherConflict.value) {
      var subName = pending.subTeacher
        ? getTeacherNameByEmail(pending.subTeacher) : '該教師';
      if (isAdmin.value) {
        var force = await showConfirm(
          '⚠️ 衝堂警告：' + subName + ' 在請假節次已有課！\n\n您是管理員，可以強制安排。確定要繼續嗎？'
        );
        if (!force) return false;
      } else {
        showToast('⚠️ 衝堂！' + subName + ' 在請假節次已有課，無法代課。請另選教師。', 'warning');
        return false;
      }
    }
    if (pending.mode === 'substitution' && !pending.subFee) {
      showToast('請選擇代課鐘點費結算方式！', 'info');
      return false;
    }
    if (!assertQuotaDeductAllowed()) return false;
    if (pending.mode === 'exchange') {
      var d1 = new Date(String(pending.date).replace(/-/g, '/'));
      var d2 = new Date(String(pending.dateB).replace(/-/g, '/'));
      var diffDays = Math.abs((d2 - d1) / (1000 * 60 * 60 * 24));
      if (diffDays > 14) {
        showToast('⚠️ 調課時間差距超過 14 天限制，請重新規劃！', 'warning');
        return false;
      }
      if (d1.getDay() === 0 || d1.getDay() === 6 || d2.getDay() === 0 || d2.getDay() === 6) {
        showToast('⚠️ 對調日期不能為非補班日的週末放假日！', 'warning');
        return false;
      }
    }
    return true;
  }

  function buildSubmitPayload(deps, requestId, serial) {
    var pending = deps.pendingRequestData.value;
    var currentSemester = deps.currentSemester;
    var getTeacherNameByEmail = deps.getTeacherNameByEmail;
    var isAdmin = deps.isAdmin;
    var directApproveMode = deps.directApproveMode;
    var isMutualCover = deps.isMutualCover;
    var PERIOD8_FEE = deps.PERIOD8_FEE;
    var ACTIVITY_PUBLIC_FEE = deps.ACTIVITY_PUBLIC_FEE;
    var defaultSubFeeForReason = deps.defaultSubFeeForReason;
    var activeCell = deps.activeCell;
    var DAC = deps.DAC || function () { return window.DomainActivityCover; };

    var isExchange = pending.mode === 'exchange';
    var finalFeeType = '無';
    if (!isExchange) {
      var periodNum = parseInt(String(pending.timeKey || '').slice(-1), 10)
        || (activeCell.value ? parseInt(activeCell.value.period, 10) : 0);
      if (periodNum === 8) {
        finalFeeType = PERIOD8_FEE;
      } else if (isMutualCover.value) {
        finalFeeType = DAC()
          ? DAC().normalizeActivityFee(pending.subFee)
          : ACTIVITY_PUBLIC_FEE;
      } else {
        finalFeeType = pending.subFee
          || defaultSubFeeForReason(pending.reason)
          || '自費代課';
      }
    }

    var baseNote = String(pending.note || '').trim();
    var noteOut = baseNote;
    if (isAdmin.value && directApproveMode.value) {
      noteOut = baseNote ? ('[直接核准] ' + baseNote) : '[直接核准]';
    }

    var newRequest = {
      "學期代號": currentSemester.value,
      "申請單ID": requestId,
      "單號": serial,
      "異動類型": pending.mode,
      "申請人Email": pending.leaveTeacher,
      "申請人姓名": getTeacherNameByEmail(pending.leaveTeacher),
      "受邀人Email": pending.subTeacher,
      "受邀人姓名": getTeacherNameByEmail(pending.subTeacher),
      "異動日期": pending.date,
      "異動節次": parseInt(String(pending.timeKey).slice(-1), 10),
      "異動星期": parseInt(String(pending.timeKey).charAt(0), 10),
      "班級": pending.cls,
      "科目": pending.subject,
      "請假事由": pending.reason,
      "經費來源": finalFeeType || '無',
      "備註": noteOut,
      "狀態": (isAdmin.value && directApproveMode.value) ? 'approved' : 'pending_teacher',
      directApprove: !!(isAdmin.value && directApproveMode.value)
    };

    if (isExchange) {
      newRequest["對調目標日期"] = pending.dateB;
      newRequest["對調目標節次"] = parseInt(String(pending.timeB).slice(-1), 10);
      newRequest["對調目標星期"] = parseInt(String(pending.timeB).charAt(0), 10);
    }

    var payload = {
      request: newRequest,
      directApprove: !!(isAdmin.value && directApproveMode.value)
    };
    return { payload: payload, newRequest: newRequest, isExchange: isExchange, finalFeeType: finalFeeType };
  }

  /**
   * 連堂檢測：回傳異動前／後最長連堂；僅「因本次異動才達 3 節以上」才警示
   */
  function getConsecutiveStatus(getScheduleForDate, teacherEmail, dateStr, addPeriod, removePeriod) {
    var day = new Date(String(dateStr).replace(/-/g, '/')).getDay();
    var dayOfWeek = day === 0 ? 7 : day;

    function buildMaxConsec(addP, removeP) {
      var activePeriods = [];
      for (var p = 1; p <= 8; p++) {
        var hasClass = false;
        if (removeP != null && p === removeP) {
          hasClass = false;
        } else if (addP != null && p === addP) {
          hasClass = true;
        } else {
          var cell = getScheduleForDate(teacherEmail, dateStr, p, dayOfWeek);
          if (cell) {
            var originalIsHim = cell.teacherEmail
              && cell.teacherEmail.toLowerCase() === String(teacherEmail).toLowerCase();
            var substitutedOut = cell.isSubstituted
              || (cell.isPending && (cell.pendingType === 'substitution_out' || cell.pendingType === 'exchange_out'));
            var substitutedIn = (cell.actualTeacherEmail
              && cell.actualTeacherEmail.toLowerCase() === String(teacherEmail).toLowerCase())
              || (cell.isPending
                && (cell.pendingType === 'substitution_in' || cell.pendingType === 'exchange_in')
                && cell.teacherEmail
                && cell.teacherEmail.toLowerCase() === String(teacherEmail).toLowerCase());
            if ((originalIsHim && !substitutedOut) || substitutedIn) {
              hasClass = true;
            }
          }
        }
        if (hasClass) activePeriods.push(p);
      }
      activePeriods.sort(function (a, b) { return a - b; });
      var maxConsec = 0;
      var currentConsec = 0;
      var maxConsecList = [];
      var currentConsecList = [];
      for (var i = 0; i < activePeriods.length; i++) {
        if (i === 0 || activePeriods[i] === activePeriods[i - 1] + 1) {
          currentConsec++;
          currentConsecList.push(activePeriods[i]);
        } else {
          if (currentConsec > maxConsec) {
            maxConsec = currentConsec;
            maxConsecList = currentConsecList.slice();
          }
          currentConsec = 1;
          currentConsecList = [activePeriods[i]];
        }
      }
      if (currentConsec > maxConsec) {
        maxConsec = currentConsec;
        maxConsecList = currentConsecList.slice();
      }
      return { maxConsec: maxConsec, consecList: maxConsecList };
    }

    var before = buildMaxConsec(null, null);
    var after = buildMaxConsec(addPeriod, removePeriod);
    var shouldWarn = after.maxConsec >= 3 && before.maxConsec < 3;
    return {
      maxConsec: after.maxConsec,
      consecList: after.consecList,
      beforeMaxConsec: before.maxConsec,
      shouldWarn: shouldWarn
    };
  }

  /**
   * 模擬格是否視為空（無課／調出被代／空堂事件）
   */
  function isCompareEmptySlot(cell, dateStr, isClassAwayOnDate) {
    if (!cell) return true;
    if (cell.isSubstituted) return true;
    if (cell.isClassAway) return true;
    if (window.DomainSchedule && window.DomainSchedule.isPatrolCell
        && window.DomainSchedule.isPatrolCell(cell)) {
      return true;
    }
    if (dateStr && cell.className && typeof isClassAwayOnDate === 'function'
        && isClassAwayOnDate(cell.className, dateStr)) {
      return true;
    }
    return false;
  }

  /**
   * 準備模擬對比（寫入 pendingRequestData／連堂警示）
   * @returns {Promise<'drafted'|'opened'|'cancelled'|void>}
   */
  async function prepCompare(deps, mode, targetEmail, periodIdVal, subjectVal, classVal) {
    periodIdVal = periodIdVal || '';
    subjectVal = subjectVal || '';
    classVal = classVal || '';
    var activeCell = deps.activeCell;
    var inputRequestDate = deps.inputRequestDate;
    var allSchedules = deps.allSchedules;
    var showConfirm = deps.showConfirm;
    var getScheduleForDate = deps.getScheduleForDate;
    var formatDateMMDD = deps.formatDateMMDD;
    var getWeekDayText = deps.getWeekDayText;
    var exchangePeriodId = deps.exchangePeriodId;
    var exchangeWeekOffset = deps.exchangeWeekOffset;
    var exchangeTargetDate = deps.exchangeTargetDate;
    var consecAlertsA = deps.consecAlertsA;
    var consecAlertsB = deps.consecAlertsB;
    var isMutualCover = deps.isMutualCover;
    var assignMutualDraftFromMatch = deps.assignMutualDraftFromMatch;
    var PERIOD8_FEE = deps.PERIOD8_FEE;
    var pendingRequestData = deps.pendingRequestData;
    var showMatchModal = deps.showMatchModal;
    var showCompareModal = deps.showCompareModal;

    var consecFn = function (teacherEmail, dateStr, addPeriod, removePeriod) {
      return getConsecutiveStatus(
        getScheduleForDate, teacherEmail, dateStr, addPeriod, removePeriod
      );
    };

    if (mode === 'exchange' && periodIdVal) {
      // 請假節（原課）為綁課：模擬前再提醒一次
      if (activeCell.value && activeCell.value.classData
          && activeCell.value.classData.restriction === 'restricted') {
        var okLeave = await showConfirm(
          '您要調出的課堂為綁課／特殊課程，原則上建議代課。\n\n特殊狀況仍可調課，請確認已與相關人員溝通。\n\n仍要繼續模擬？',
          '綁課提醒'
        );
        if (!okLeave) return 'cancelled';
      }
      var parts0 = periodIdVal.split('-');
      var dStr = parts0[0];
      var pStr = parts0[1];
      var targetSched = (allSchedules.value || []).find(function (s) {
        return s.teacherEmail && targetEmail
          && String(s.teacherEmail).toLowerCase() === String(targetEmail).toLowerCase()
          && parseInt(s.dayOfWeek, 10) === parseInt(dStr, 10)
          && parseInt(s.period, 10) === parseInt(pStr, 10);
      });
      if (targetSched && targetSched.restriction === 'restricted') {
        var ok = await showConfirm(
          '對調的目標課堂已標記為綁課／特殊課程，原則上不建議任意調動。請確認已與相關人員溝通後再進行模擬。',
          '綁課提醒'
        );
        if (!ok) return 'cancelled';
      }
      if (targetSched && window.DomainSchedule && window.DomainSchedule.isPatrolAttr
          && window.DomainSchedule.isPatrolAttr(targetSched.attr)) {
        var tipP = (window.DomainSchedule && window.DomainSchedule.PATROL_INCOMING_TIP)
          || '對方本節為【巡堂】。排入後請私下協調代巡堂或互換。';
        var okP = await showConfirm(tipP + '\n\n仍要繼續模擬？', '巡堂提醒');
        if (!okP) return 'cancelled';
      }
    }

    var leaveEmail = activeCell.value.teacherEmail;
    var curDate = inputRequestDate.value;
    var timeKey = String(activeCell.value.dayOfWeek) + String(activeCell.value.period);

    var dateBVal = '';
    var timeBVal = '';
    var subBVal = '';
    var classBVal = '';

    if (mode === 'exchange') {
      exchangePeriodId.value = periodIdVal;
      try {
        var targetDayStr = periodIdVal.split('-')[0];
        var targetDay = parseInt(targetDayStr, 10);
        var ymd = inputRequestDate.value.split('-').map(Number);
        var reqDate = new Date(ymd[0], ymd[1] - 1, ymd[2]);
        var reqDay = reqDate.getDay();
        var currentDayOfWeek = reqDay === 0 ? 7 : reqDay;
        var diffDays = (targetDay - currentDayOfWeek) + ((exchangeWeekOffset.value || 0) * 7);
        var targetDateObj = new Date(reqDate);
        targetDateObj.setDate(reqDate.getDate() + diffDays);
        var year = targetDateObj.getFullYear();
        var month = String(targetDateObj.getMonth() + 1).padStart(2, '0');
        var dateVal = String(targetDateObj.getDate()).padStart(2, '0');
        dateBVal = year + '-' + month + '-' + dateVal;
        exchangeTargetDate.value = dateBVal;
      } catch (e) {
        console.error('prepCompare 推算對調日期失敗：', e);
        dateBVal = exchangeTargetDate.value;
      }
      var dp = periodIdVal.split('-');
      timeBVal = dp[0] + dp[1];
      subBVal = subjectVal;
      classBVal = classVal || '';
    }

    consecAlertsA.value = [];
    consecAlertsB.value = [];

    if (mode === 'substitution') {
      var periodA = parseInt(activeCell.value.period, 10);
      var resB = consecFn(targetEmail, curDate, periodA, null);
      if (resB.shouldWarn) {
        var mmdd = formatDateMMDD(curDate);
        var dow = new Date(String(curDate).replace(/-/g, '/')).getDay();
        var dayText = getWeekDayText(dow);
        consecAlertsB.value.push(
          mmdd + '(' + dayText + ')因本次代課將形成連續 ' + resB.maxConsec
          + ' 節 (第 ' + resB.consecList.join(', ') + ' 節)'
        );
      }
    } else if (mode === 'exchange') {
      var periodA2 = parseInt(activeCell.value.period, 10);
      var pParts = periodIdVal.split('-');
      var periodB = parseInt(pParts[1], 10);
      var isSameDay = curDate === dateBVal;
      var removeB = isSameDay ? periodB : null;
      var resB2 = consecFn(targetEmail, curDate, periodA2, removeB);
      if (resB2.shouldWarn) {
        var mmdd2 = formatDateMMDD(curDate);
        var dow2 = new Date(String(curDate).replace(/-/g, '/')).getDay();
        var dayText2 = getWeekDayText(dow2);
        consecAlertsB.value.push(
          mmdd2 + '(' + dayText2 + ')因本次調課將形成連續 ' + resB2.maxConsec
          + ' 節 (第 ' + resB2.consecList.join(', ') + ' 節)'
        );
      }
      var removeA = isSameDay ? periodA2 : null;
      var resA = consecFn(leaveEmail, dateBVal, periodB, removeA);
      if (resA.shouldWarn) {
        var mmdd3 = formatDateMMDD(dateBVal);
        var dow3 = new Date(String(dateBVal).replace(/-/g, '/')).getDay();
        var dayText3 = getWeekDayText(dow3);
        consecAlertsA.value.push(
          mmdd3 + '(' + dayText3 + ')因本次調課將形成連續 ' + resA.maxConsec
          + ' 節 (第 ' + resA.consecList.join(', ') + ' 節)'
        );
      }
    }

    if (mode === 'substitution' && isMutualCover.value) {
      assignMutualDraftFromMatch(targetEmail);
      return 'drafted';
    }

    // 代課：落在對方巡堂節 → 提醒（不擋）
    if (mode === 'substitution') {
      var subCell = getScheduleForDate(
        targetEmail, curDate, parseInt(activeCell.value.period, 10), activeCell.value.dayOfWeek
      );
      if (window.DomainSchedule && window.DomainSchedule.isPatrolCell
          && window.DomainSchedule.isPatrolCell(subCell)) {
        var tipSub = (window.DomainSchedule && window.DomainSchedule.PATROL_INCOMING_TIP)
          || '對方本節為【巡堂】。排入後請私下協調代巡堂或互換。';
        var okSub = await showConfirm(tipSub + '\n\n仍要繼續？', '巡堂提醒');
        if (!okSub) return 'cancelled';
      }
    }

    var periodNum = parseInt(activeCell.value.period, 10);
    var subFeeVal = mode === 'exchange' ? '無' : (periodNum === 8 ? PERIOD8_FEE : '自費代課');

    pendingRequestData.value = {
      mode: mode,
      leaveTeacher: leaveEmail,
      subTeacher: targetEmail,
      cls: activeCell.value.classData.className,
      subject: activeCell.value.classData.subject,
      date: curDate,
      timeKey: timeKey,
      reason: '',
      subFee: subFeeVal,
      dateB: dateBVal,
      timeB: timeBVal,
      subB: subBVal,
      subBClass: classBVal,
      note: ''
    };

    showMatchModal.value = false;
    showCompareModal.value = true;
    return 'opened';
  }

  function getCompareCellText(deps, who, day, period) {
    var pending = deps.pendingRequestData.value;
    var currentWeekDates = deps.currentWeekDates;
    var getScheduleForDate = deps.getScheduleForDate;
    var isClassAwayOnDate = deps.isClassAwayOnDate;
    var resolveCompareBEmail = deps.resolveCompareBEmail;
    var isBatchSlotAt = deps.isBatchSlotAt;
    var getBatchSlotForCompareB = deps.getBatchSlotForCompareB;

    var bEmail = resolveCompareBEmail();
    var email = who === 'A' ? pending.leaveTeacher : bEmail;
    var targetTimeKey = who === 'A' ? pending.timeKey : pending.timeB;
    var swapTimeKey = who === 'A' ? pending.timeB : pending.timeKey;
    var timeKey = String(day) + String(period);
    var dateStr = currentWeekDates.value[day - 1];

    if (pending.isBatch && pending.mode === 'substitution' && dateStr) {
      if (who === 'A' && isBatchSlotAt(dateStr, day, period)) return '移出';
      if (who === 'B') {
        var slot = getBatchSlotForCompareB(dateStr, day, period);
        if (slot) {
          if (!email) return slot.className || '代入';
          var currentCell = getScheduleForDate(email, dateStr, period, day);
          if (currentCell && !isCompareEmptySlot(currentCell, dateStr, isClassAwayOnDate)) {
            return String(currentCell.className) + ' ⚠';
          }
          return slot.className || '代入';
        }
      }
      if (!email) return '';
      var batchCell = getScheduleForDate(email, dateStr, period, day);
      if (isCompareEmptySlot(batchCell, dateStr, isClassAwayOnDate)) return '';
      if (batchCell.isSubstitutionDuty) {
        var tag = batchCell.subType === 'exchange' ? '(調)' : '(代)';
        return String(batchCell.className) + ' ' + tag;
      }
      return batchCell.className || '';
    }

    if (!email) return '';
    if (timeKey === targetTimeKey) return '移出';
    if (timeKey === swapTimeKey) return pending.cls || '';

    var cell = getScheduleForDate(email, dateStr, period, day);
    if (isCompareEmptySlot(cell, dateStr, isClassAwayOnDate)) return '';
    if (cell.isSubstitutionDuty) {
      var tag2 = cell.subType === 'exchange' ? '(調)' : '(代)';
      return String(cell.className) + ' ' + tag2;
    }
    if (who === 'B' && pending.mode === 'substitution' && !pending.isBatch) {
      if (timeKey === pending.timeKey) return String(cell.className) + ' ⚠';
    }
    return cell.className || '';
  }

  function getCompareCellClass(deps, who, day, period) {
    var pending = deps.pendingRequestData.value;
    var currentWeekDates = deps.currentWeekDates;
    var getScheduleForDate = deps.getScheduleForDate;
    var isClassAwayOnDate = deps.isClassAwayOnDate;
    var resolveCompareBEmail = deps.resolveCompareBEmail;
    var isBatchSlotAt = deps.isBatchSlotAt;
    var getBatchSlotForCompareB = deps.getBatchSlotForCompareB;
    var isSlotConflict = deps.isSlotConflict;

    var bEmail = resolveCompareBEmail();
    var email = who === 'A' ? pending.leaveTeacher : bEmail;
    var targetTimeKey = who === 'A' ? pending.timeKey : pending.timeB;
    var swapTimeKey = who === 'A' ? pending.timeB : pending.timeKey;
    var timeKey = String(day) + String(period);
    var dateStr = currentWeekDates.value[day - 1];

    if (pending.isBatch && pending.mode === 'substitution' && dateStr) {
      if (who === 'A' && isBatchSlotAt(dateStr, day, period)) return 'mini-cell-out';
      if (who === 'B') {
        var slot = getBatchSlotForCompareB(dateStr, day, period);
        if (slot) {
          if (!email) return 'mini-cell-new';
          var currentCell = getScheduleForDate(email, dateStr, period, day);
          if (currentCell && !isCompareEmptySlot(currentCell, dateStr, isClassAwayOnDate)
              && isSlotConflict(currentCell)) {
            return 'mini-cell-conflict';
          }
          return 'mini-cell-new';
        }
      }
      if (!email) return '';
      var batchCell = getScheduleForDate(email, dateStr, period, day);
      if (isCompareEmptySlot(batchCell, dateStr, isClassAwayOnDate)) return '';
      return 'mini-cell-in';
    }

    if (!email) return '';
    if (timeKey === targetTimeKey) return 'mini-cell-out';
    if (timeKey === swapTimeKey) return 'mini-cell-new';

    var cell = getScheduleForDate(email, dateStr, period, day);
    if (isCompareEmptySlot(cell, dateStr, isClassAwayOnDate)) return '';
    if (who === 'B' && pending.mode === 'substitution' && !pending.isBatch) {
      if (timeKey === pending.timeKey) return 'mini-cell-conflict';
    }
    if (cell.isSubstituted) return '';
    return 'mini-cell-in';
  }

  /**
   * 單節送出主流程
   */
  async function executeSubmitRequest(deps) {
    var validate = deps.validateSubmitRequest;
    var buildPayload = deps.buildSubmitPayload;
    var loading = deps.loading;
    var loadingMessage = deps.loadingMessage;
    var isSubmitting = deps.isSubmitting;
    var pendingRequestData = deps.pendingRequestData;
    var isMutualCover = deps.isMutualCover;
    var mutualSkipNotify = deps.mutualSkipNotify;
    var isAdmin = deps.isAdmin;
    var directApproveMode = deps.directApproveMode;
    var directApproveSkipNotify = deps.directApproveSkipNotify;
    var callGasApi = deps.callGasApi;
    var showCompareModal = deps.showCompareModal;
    var showMatchModal = deps.showMatchModal;
    var optimisticUpsertRequest = deps.optimisticUpsertRequest;
    var sheetRequestToFront = deps.sheetRequestToFront;
    var deductMutualQuotaForRows = deps.deductMutualQuotaForRows;
    var softRefreshInBackground = deps.softRefreshInBackground;
    var isQuotaDeductFee = deps.isQuotaDeductFee;
    var buildLineInviteText = deps.buildLineInviteText;
    var successModalTitle = deps.successModalTitle;
    var successModalMessage = deps.successModalMessage;
    var lineCopyText = deps.lineCopyText;
    var hasLineTemplate = deps.hasLineTemplate;
    var showSuccessModal = deps.showSuccessModal;
    var showToast = deps.showToast;

    // 防連點：一進來就鎖，避免 validate／confirm 期間重複點
    if (isSubmitting && isSubmitting.value) {
      showToast('申請送出中，請稍候…', 'info');
      return;
    }
    if (isSubmitting) isSubmitting.value = true;
    loading.value = true;
    loadingMessage.value = '正在檢查申請內容…';

    try {
      if (!(await validate())) return;

      loadingMessage.value = '正在上傳申請單至雲端試算表...';
      var requestId = 'req_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
      var prefix = pendingRequestData.value.mode === 'exchange' ? 'SWP' : 'SUB';
      var serial = prefix + (1000 + Math.floor(Math.random() * 9000));
      var built = buildPayload(requestId, serial);
      var payload = built.payload;
      var newRequest = built.newRequest;
      var isExchange = built.isExchange;
      var skipNotify = !!(
        (isMutualCover.value && mutualSkipNotify.value)
        || (isAdmin.value && directApproveMode.value && directApproveSkipNotify.value)
      );
      payload.skipNotify = skipNotify;
      await callGasApi('submitRequest', payload);

      showCompareModal.value = false;
      showMatchModal.value = false;
      optimisticUpsertRequest(sheetRequestToFront(newRequest));
      await deductMutualQuotaForRows([newRequest]);
      softRefreshInBackground({ delay: 2500 });

      var currentUrl = window.location.origin + window.location.pathname;
      var agreeLink = currentUrl + '?action=respond&id=' + requestId + '&status=agree';
      var declineLink = currentUrl + '?action=respond&id=' + requestId + '&status=decline';
      var mutualTip = isMutualCover.value
        ? (isQuotaDeductFee(newRequest['經費來源']) ? '（活動互代／扣額度）' : '（活動互代／活動公費）')
        : '';
      var notifyTip = skipNotify ? ' 尚未寄系統信，請用下方 LINE 手動通知。' : '';
      var linePayload = {
        targetName: newRequest['受邀人姓名'],
        dateA: newRequest['異動日期'],
        dayA: newRequest['異動星期'],
        periodA: newRequest['異動節次'],
        classA: newRequest['班級'],
        subjectA: newRequest['科目'],
        isExchange: isExchange,
        dateB: newRequest['對調目標日期'],
        dayB: newRequest['對調目標星期'],
        periodB: newRequest['對調目標節次'],
        classB: pendingRequestData.value.subBClass || '',
        subjectB: pendingRequestData.value.subB || '',
        agreeLink: agreeLink,
        declineLink: declineLink,
        systemUrl: currentUrl
      };

      if (newRequest['狀態'] === 'pending_teacher') {
        successModalTitle.value = '🎉 申請已送出';
        successModalMessage.value = skipNotify
          ? ('申請單（' + serial + '）已送出' + mutualTip + '。' + notifyTip)
          : ('申請單（' + serial + '）已送出' + mutualTip + '，系統已同步寄發電子郵件給 '
            + newRequest['受邀人姓名'] + ' 老師！');
        lineCopyText.value = buildLineInviteText(linePayload);
        hasLineTemplate.value = true;
        if (deps.successFlowMode) deps.successFlowMode.value = 'normal';
      } else {
        successModalTitle.value = '🎉 申請已直接核准';
        successModalMessage.value = '申請單（' + serial + '）已直接審核完成' + mutualTip
          + '，異動已寫入課表！' + notifyTip;
        if (skipNotify) {
          lineCopyText.value = buildLineInviteText(linePayload);
          hasLineTemplate.value = true;
        } else {
          lineCopyText.value = '';
          hasLineTemplate.value = false;
        }
        if (deps.successFlowMode) deps.successFlowMode.value = 'direct';
      }
      showSuccessModal.value = true;
    } catch (err) {
      console.error('申請提交失敗：', err);
      showToast('提交失敗：\n\n' + (err && err.message ? err.message : String(err)), 'error');
    } finally {
      loading.value = false;
      if (isSubmitting) isSubmitting.value = false;
    }
  }

  return {
    validateSubmitRequest: validateSubmitRequest,
    buildSubmitPayload: buildSubmitPayload,
    getConsecutiveStatus: getConsecutiveStatus,
    isCompareEmptySlot: isCompareEmptySlot,
    prepCompare: prepCompare,
    getCompareCellText: getCompareCellText,
    getCompareCellClass: getCompareCellClass,
    executeSubmitRequest: executeSubmitRequest
  };
})();

