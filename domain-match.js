/**
 * 媒合領域邏輯（純函式）
 * 代課推薦排序、調課候選過濾
 */
window.DomainMatch = (function () {
  /**
   * 代課空堂教師推薦
   * @param {object} opts
   * @param {Array} opts.teachers
   * @param {Array} opts.allSchedules
   * @param {string} opts.leaveEmail
   * @param {string} opts.dateStr
   * @param {number} opts.targetDay
   * @param {number} opts.targetPeriod
   * @param {string} opts.myCourse   課表格子課程名稱（如「走讀」「輔導」）→ 同課
   * @param {string} opts.myDomain   請假教師名單科目（可多科：國文、輔導）→ 推導需求科
   * @param {string} opts.mySubject  相容舊參數：若未傳 myCourse 則當課程名稱
   * @param {string} opts.myClass
   * @param {function} opts.getScheduleForDate(email, dateStr, period, day)
   */
  function extractGrade(className) {
    var s = String(className || '');
    // 701 / 7年1班 / 七01 → 取 7、8、9
    var m = s.match(/[789]/);
    if (m) return m[0];
    if (/七/.test(s)) return '7';
    if (/八/.test(s)) return '8';
    if (/九/.test(s)) return '9';
    return '';
  }

  /** 解析多科：國文、輔導 / 國文,輔導 / 國文/輔導 */
  function parseSubjects(raw) {
    return String(raw || '')
      .split(/[、,，/／|｜\s]+/)
      .map(function (s) { return s.trim(); })
      .filter(Boolean);
  }

  function subjectListHas(list, token) {
    if (!token) return false;
    var t = String(token).trim();
    return (list || []).some(function (s) { return s === t; });
  }

  function rankSubstitutionCandidates(opts) {
    const teachers = opts.teachers || [];
    const allSchedules = opts.allSchedules || [];
    const leaveEmail = opts.leaveEmail;
    const dateStr = opts.dateStr;
    const targetDay = opts.targetDay;
    const targetPeriod = opts.targetPeriod;
    // 同課：課表課程名稱；同科：本堂「需求科」（非請假老師全部專長）
    const myCourse = String(opts.myCourse != null ? opts.myCourse : (opts.mySubject || '')).trim();
    const leaveDomains = parseSubjects(opts.myDomain || '');
    const myClass = String(opts.myClass || '').trim();
    const myGrade = extractGrade(myClass);
    const getScheduleForDate = opts.getScheduleForDate;

    // 全校名單出現過的領域名（用來判斷格子科目是否為標準科）
    const knownDomains = new Set();
    teachers.forEach(function (t) {
      parseSubjects(t.subject).forEach(function (s) { knownDomains.add(s); });
    });
    leaveDomains.forEach(function (s) { knownDomains.add(s); });

    // 本堂需求科：格子是標準領域名就用格子；否則回退請假老師名單第一科
    var demandDomain = '';
    if (myCourse && knownDomains.has(myCourse)) {
      demandDomain = myCourse;
    } else if (leaveDomains.length) {
      demandDomain = leaveDomains[0];
    }

    // 同班／同課：單次掃課表
    const sameClassTeachers = new Set();
    const sameCourseTeachers = new Set();
    allSchedules.forEach(function (s) {
      if (!s || !s.teacherEmail) return;
      if (myClass && String(s.className || '') === myClass) {
        sameClassTeachers.add(s.teacherEmail);
      }
      if (myCourse && String(s.subject || '').trim() === myCourse) {
        if (myGrade) {
          if (extractGrade(s.className) === myGrade) sameCourseTeachers.add(s.teacherEmail);
        } else if (String(s.className || '') === myClass) {
          sameCourseTeachers.add(s.teacherEmail);
        }
      }
    });

    // 外出班級：該節原課班級在外出名單中 → 視為可互代空堂（釋出）
    var awaySet = {};
    (opts.awayClasses || []).forEach(function (c) {
      var k = String(c || '').trim();
      if (k) awaySet[k] = true;
    });
    var hasAway = Object.keys(awaySet).length > 0;

    function isCellAwayReleased(cell) {
      if (!cell || cell.isSubstituted) return false;
      // 空堂事件班：邏輯視同空堂（畫面淡化）
      if (cell.isClassAway) return true;
      var cn = String(cell.className || '').trim();
      return !!(hasAway && cn && awaySet[cn]);
    }

    function isPatrolSlot(cell) {
      return !!(window.DomainSchedule && window.DomainSchedule.isPatrolCell && window.DomainSchedule.isPatrolCell(cell));
    }

    function isFreeAtPeriod(email, period) {
      var cell = getScheduleForDate(email, dateStr, period, targetDay);
      if (cell === null || cell.isSubstituted) return { free: true, released: false, cell: cell };
      // 巡堂：可當空堂排入，但不算真衝堂
      if (isPatrolSlot(cell)) return { free: true, released: false, cell: cell, isPatrol: true };
      if (isCellAwayReleased(cell)) return { free: true, released: true, cell: cell };
      return { free: false, released: false, cell: cell };
    }

    // P2：先只查目標節（1 次／人），空堂候選再掃 1～8 算當日負荷
    const freeAtTarget = [];
    const todayCountMap = {};
    const releasedMap = {};
    var leaveKey = String(leaveEmail || '').toLowerCase().trim();
    var targetP = parseInt(targetPeriod, 10);
    teachers.forEach(function (t) {
      if (!t.email || String(t.email).toLowerCase().trim() === leaveKey) return;
      var freeInfo = isFreeAtPeriod(t.email, targetP);
      if (!(freeInfo && freeInfo.free)) return;
      freeAtTarget.push(t);
      releasedMap[t.email] = !!freeInfo.released;
    });
    freeAtTarget.forEach(function (t) {
      var periodsBusy = 0;
      for (var p = 1; p <= 8; p++) {
        var cell = getScheduleForDate(t.email, dateStr, p, targetDay);
        var awayRel = isCellAwayReleased(cell);
        var patrol = isPatrolSlot(cell);
        if (cell && !cell.isSubstituted && !awayRel && !patrol) periodsBusy++;
      }
      todayCountMap[t.email] = periodsBusy;
    });

    const list = freeAtTarget.map(function (t) {
      var candDomains = parseSubjects(t.subject);
      var isSameCourse = sameCourseTeachers.has(t.email);
      var isSameSubject = !!demandDomain && subjectListHas(candDomains, demandDomain);
      var isSameClass = sameClassTeachers.has(t.email);
      var isReleasedByAway = !!releasedMap[t.email];
      // 僅活動互代：外出班釋出往上排（+100）；一般調代課當空堂即可，不特別優先
      var preferReleased = !!(opts.preferReleasedByAway || opts.activityMode);
      var score = (preferReleased && isReleasedByAway ? 100 : 0)
        + (isSameCourse ? 4 : 0) + (isSameSubject ? 2 : 0) + (isSameClass ? 1 : 0);
      // 活動模式經費建議委派 DomainActivityCover（若尚未載入則內建後備）
      var suggestedFee = '';
      if (opts.activityMode) {
        if (window.DomainActivityCover && window.DomainActivityCover.suggestedFee) {
          suggestedFee = window.DomainActivityCover.suggestedFee(isReleasedByAway, true);
        } else {
          suggestedFee = isReleasedByAway ? '扣額度' : '活動公費';
        }
      }
      return Object.assign({}, t, {
        todayPeriodCount: todayCountMap[t.email] || 0,
        isSameCourse: isSameCourse,
        isSameSubject: isSameSubject,
        isSameClass: isSameClass,
        isReleasedByAway: isReleasedByAway,
        suggestedFee: suggestedFee,
        demandDomain: demandDomain,
        score: score
      });
    });

    // 排序：活動互代才把「外出班釋出」置頂；一般只看分數／當日課少
    var preferReleased = !!(opts.preferReleasedByAway || opts.activityMode);
    list.sort(function (a, b) {
      if (preferReleased) {
        var ra = a.isReleasedByAway ? 1 : 0;
        var rb = b.isReleasedByAway ? 1 : 0;
        if (rb !== ra) return rb - ra;
      }
      return b.score - a.score || a.todayPeriodCount - b.todayPeriodCount;
    });
    return list;
  }

  /** 該格是否可視為空堂（無課／調出被代／空堂事件／外出班釋出） */
  function isSlotFreeForMatch(cell, awaySet) {
    if (!cell || cell.isSubstituted) return true;
    if (cell.isClassAway) return true;
    var cn = String(cell.className || '').trim();
    if (cn && awaySet && awaySet[cn]) return true;
    return false;
  }

  /**
   * 調課候選（同班、雙方空堂）
   * 外出班／空堂事件釋出視同空堂，可對調
   */
  function listExchangeCandidates(opts) {
    const allSchedules = opts.allSchedules || [];
    const cls = opts.className || '';
    const leaveTeacher = opts.leaveEmail;
    const leaveDate = opts.leaveDate;
    const leavePeriod = opts.leavePeriod;
    const leaveDay = opts.leaveDay;
    const weekDates = opts.weekDates || []; // index 0 = Mon
    const getScheduleForDate = opts.getScheduleForDate;
    const getTeacherNameByEmail = opts.getTeacherNameByEmail;
    var awaySet = {};
    (opts.awayClasses || []).forEach(function (c) {
      var k = String(c || '').trim();
      if (k) awaySet[k] = true;
    });

    const classSchedules = allSchedules.filter(function (s) {
      return s.className === cls && s.teacherEmail !== leaveTeacher;
    });
    const res = [];

    classSchedules.forEach(function (sched) {
      const schedTimeKey = sched.dayOfWeek + '-' + sched.period;
      const schedDate = weekDates[sched.dayOfWeek - 1];
      if (!schedDate) return;

      const ownerCell = getScheduleForDate(sched.teacherEmail, schedDate, sched.period, sched.dayOfWeek);
      var actualEmail = sched.teacherEmail;
      var actualName = sched.teacherName;
      if (ownerCell && ownerCell.isSubstituted && ownerCell.subRecord) {
        actualEmail = ownerCell.subRecord.actualTeacherEmail;
        actualName = getTeacherNameByEmail(actualEmail);
      }
      // 若原師這節是空堂事件／外出班，課仍屬該班時段，實際授課人仍可能被代；仍用 actualEmail
      if (actualEmail === leaveTeacher) return;

      const cellAtTarget = getScheduleForDate(leaveTeacher, schedDate, sched.period, sched.dayOfWeek);
      const isRequesterFreeAtTarget = isSlotFreeForMatch(cellAtTarget, awaySet);
      const cellAtLeave = getScheduleForDate(actualEmail, leaveDate, leavePeriod, leaveDay);
      const isTargetFreeAtLeave = isSlotFreeForMatch(cellAtLeave, awaySet);

      if (parseInt(leavePeriod) === 8 && parseInt(sched.period) !== 8) return;
      if (parseInt(leavePeriod) !== 8 && parseInt(sched.period) === 8) return;

      if (isRequesterFreeAtTarget && isTargetFreeAtLeave) {
        res.push({
          teacherEmail: actualEmail,
          teacherName: actualName,
          dayOfWeek: sched.dayOfWeek,
          period: sched.period,
          periodKey: schedTimeKey,
          subject: sched.subject,
          className: sched.className,
          restriction: sched.restriction || '',
          freeByAway: !!(
            (cellAtTarget && (cellAtTarget.isClassAway || (awaySet[String(cellAtTarget.className || '').trim()])))
            || (cellAtLeave && (cellAtLeave.isClassAway || (awaySet[String(cellAtLeave.className || '').trim()])))
          )
        });
      }
    });
    // 綁課／特殊課程往後排（仍可選，但優先推一般課）
    res.sort(function (a, b) {
      var ra = (a.restriction === 'restricted' || a.restriction === '限制') ? 1 : 0;
      var rb = (b.restriction === 'restricted' || b.restriction === '限制') ? 1 : 0;
      if (ra !== rb) return ra - rb;
      var da = parseInt(a.dayOfWeek, 10) || 0;
      var db = parseInt(b.dayOfWeek, 10) || 0;
      if (da !== db) return da - db;
      return (parseInt(a.period, 10) || 0) - (parseInt(b.period, 10) || 0);
    });
    return res;
  }

  return {
    rankSubstitutionCandidates: rankSubstitutionCandidates,
    listExchangeCandidates: listExchangeCandidates,
    parseSubjects: parseSubjects,
    isSlotFreeForMatch: isSlotFreeForMatch
  };
})();

