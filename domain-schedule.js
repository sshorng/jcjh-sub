/**
 * 課表領域邏輯（純函式）
 * 索引、圖論遞推調代鏈、lookup、pending 疊加
 */
window.DomainSchedule = (function () {
  /** 課堂屬性＝巡堂（顯示、不算鐘點、不可調出、可當空堂） */
  function isPatrolAttr(attr) {
    return String(attr || '').trim() === '巡堂';
  }

  function isPatrolCell(cell) {
    if (!cell || cell.isSubstituted || cell.isPending) return false;
    if (cell.isPatrol) return true;
    return isPatrolAttr(cell.attr);
  }

  var PATROL_INCOMING_TIP =
    '對方本節為【巡堂】。排入代課／調課後，請私下協調代巡堂或互換，系統不另開巡堂代課單。';

  function formatShortDateAndPeriod(dateStr, period, getWeekDayText) {
    if (!dateStr) return '';
    var mmdd = dateStr.slice(5).replace('-', '/');
    var dayText = '';
    if (typeof getWeekDayText === 'function') {
      try {
        var d = new Date(dateStr.replace(/-/g, '/'));
        if (!isNaN(d.getTime())) {
          var w = d.getDay();
          var dayNum = w === 0 ? 7 : w;
          dayText = getWeekDayText(dayNum);
        }
      } catch (e) {}
    }
    var weekPart = dayText ? '(' + dayText + ')' : '';
    return mmdd + weekPart + ' ' + period;
  }

  function buildSubstitutionsLookup(records) {
    const map = {};
    (records || []).forEach(function (r) {
      const key = r.date + '_' + r.period;
      if (!map[key]) map[key] = [];
      map[key].push(r);
    });
    return map;
  }

  /**
   * 課表索引：email|dow|period → rows[]
   * 與 dow|period → emails[]
   */
  function buildScheduleIndex(allSchedules) {
    const byTeacherSlot = {};
    const bySlotOwners = {};
    (allSchedules || []).forEach(function (s) {
      if (!s || !s.teacherEmail) return;
      const email = String(s.teacherEmail).toLowerCase();
      const dow = parseInt(s.dayOfWeek, 10);
      const period = parseInt(s.period, 10);
      const tKey = email + '|' + dow + '|' + period;
      if (!byTeacherSlot[tKey]) byTeacherSlot[tKey] = [];
      byTeacherSlot[tKey].push(s);
      const oKey = dow + '|' + period;
      if (!bySlotOwners[oKey]) bySlotOwners[oKey] = [];
      if (bySlotOwners[oKey].indexOf(email) === -1) bySlotOwners[oKey].push(email);
    });
    return { byTeacherSlot: byTeacherSlot, bySlotOwners: bySlotOwners };
  }

  function getCandidates(index, teacherEmail, dayOfWeek, period, allSchedules) {
    const emailLower = String(teacherEmail || '').toLowerCase();
    if (index && index.byTeacherSlot) {
      const key = emailLower + '|' + parseInt(dayOfWeek, 10) + '|' + parseInt(period, 10);
      return index.byTeacherSlot[key] || [];
    }
    return (allSchedules || []).filter(function (s) {
      return String(s.teacherEmail || '').toLowerCase() === emailLower &&
        parseInt(s.dayOfWeek) === parseInt(dayOfWeek) &&
        parseInt(s.period) === parseInt(period);
    });
  }

  function getSlotOwnerEmails(index, dayOfWeek, period, allSchedules) {
    if (index && index.bySlotOwners) {
      return index.bySlotOwners[parseInt(dayOfWeek, 10) + '|' + parseInt(period, 10)] || [];
    }
    return (allSchedules || []).filter(function (s) {
      return parseInt(s.dayOfWeek) === parseInt(dayOfWeek) &&
        parseInt(s.period) === parseInt(period);
    }).map(function (s) { return String(s.teacherEmail || '').toLowerCase(); });
  }

  /**
   * @param {object} ctx
   * @param {object} [ctx.scheduleIndex] buildScheduleIndex 結果
   */
  function resolveApprovedSchedule(ctx) {
    const teacherEmail = ctx.teacherEmail;
    const dateStr = ctx.dateStr;
    const period = ctx.period;
    const dayOfWeek = ctx.dayOfWeek;
    const allSchedules = ctx.allSchedules || [];
    const periodSubs = ctx.periodSubs || [];
    const allSubs = ctx.allSubs || [];
    const index = ctx.scheduleIndex || null;
    const h = ctx.helpers || {};



    if (periodSubs.length > 0) {
      const forwardMap = {};
      periodSubs.forEach(function (r) {
        if (r.originalTeacherEmail && r.actualTeacherEmail) {
          forwardMap[r.originalTeacherEmail.toLowerCase()] = {
            target: r.actualTeacherEmail.toLowerCase(),
            record: r
          };
        }
      });

      const emailLower = teacherEmail.toLowerCase();

      if (forwardMap[emailLower]) {
        var path = [];
        var current = emailLower;
        var visited = new Set();
        while (forwardMap[current] && !visited.has(current)) {
          visited.add(current);
          path.push(forwardMap[current]);
          current = forwardMap[current].target;
        }

        var firstEdge = path[0].record;
        var outCands = getCandidates(index, teacherEmail, dayOfWeek, period, allSchedules);
        var baseOut = outCands.find(function (s) {
          return String(s.teacherEmail || '').toLowerCase() === emailLower;
        }) || outCands[0] || null;

        // 調出主標科目：
        // - 先前義務若是「代課」→ 用義務課（空堂代生物再調出）
        // - 對調鏈／一般對調 → 一律自己的基礎／專長（絕不用他人科目）
        var priorDuty = null;
        if (periodSubs && periodSubs.length) {
          for (var oi = periodSubs.length - 1; oi >= 0; oi--) {
            var pr = periodSubs[oi];
            if (pr && pr.actualTeacherEmail
                && String(pr.actualTeacherEmail).toLowerCase() === emailLower
                && pr !== firstEdge
                && (pr.className || pr.subject)) {
              priorDuty = pr;
              break;
            }
          }
        }
        if (!priorDuty && allSubs && allSubs.length) {
          for (var aj = allSubs.length - 1; aj >= 0; aj--) {
            var ar = allSubs[aj];
            if (ar && ar.actualTeacherEmail
                && String(ar.actualTeacherEmail).toLowerCase() === emailLower
                && String(ar.date) === String(dateStr)
                && parseInt(ar.period, 10) === parseInt(period, 10)
                && ar !== firstEdge
                && (ar.className || ar.subject)) {
              priorDuty = ar;
              break;
            }
          }
        }
        var priorIsSub = priorDuty && (priorDuty.type === 'substitution' || priorDuty.type === '代課');
        var ownOutClass = '';
        var ownOutSubj = '';
        if (priorIsSub) {
          ownOutClass = String(priorDuty.className || (firstEdge && firstEdge.className) || (baseOut && baseOut.className) || '').trim();
          ownOutSubj = String(priorDuty.subject || (firstEdge && firstEdge.subject) || '').trim();
        } else {
          // 對調調出：科目永遠自己的；班級優先基礎，缺才用 edge（地點）
          ownOutSubj = String(
            (baseOut && baseOut.subject)
            || (h.getTeacherSubjectByEmail && h.getTeacherSubjectByEmail(teacherEmail))
            || ''
          ).trim();
          ownOutClass = String(
            (baseOut && baseOut.className)
            || (firstEdge && firstEdge.className)
            || (priorDuty && priorDuty.className)
            || ''
          ).trim();
        }
        var subText = '';
        if (firstEdge.type === 'exchange') {
          var otherSub = allSubs.find(function (x) {
            return x.requestId === firstEdge.requestId
              && (x.date !== firstEdge.date || String(x.period) !== String(firstEdge.period) || x.id !== firstEdge.id);
          });
          var dest = otherSub ? formatShortDateAndPeriod(otherSub.date, otherSub.period, h.getWeekDayText) : '他處';
          subText = '⇄ 調至 ' + dest + ' ' + h.getTeacherNameByEmail(firstEdge.actualTeacherEmail);
        } else if (firstEdge.subFee === '扣額度' || firstEdge.subFee === '互代不結') {
          subText = '🔁 互代: ' + h.getTeacherNameByEmail(firstEdge.actualTeacherEmail);
        } else {
          subText = '👤 代課: ' + h.getTeacherNameByEmail(firstEdge.actualTeacherEmail);
        }
        if (baseOut || ownOutClass || ownOutSubj || firstEdge) {
          var outBase = baseOut || {
            className: ownOutClass,
            subject: ownOutSubj,
            teacherEmail: teacherEmail,
            dayOfWeek: dayOfWeek,
            period: period
          };
          return Object.assign({}, outBase, {
            className: ownOutClass || outBase.className || '',
            subject: ownOutSubj || outBase.subject || '',
            isSubstituted: true,
            subType: firstEdge.type,
            isMutualCover: firstEdge.subFee === '扣額度' || firstEdge.subFee === '互代不結',
            subText: subText,
            subRecord: firstEdge,
            isClassAway: !!(h.isClassAway && h.isClassAway(ownOutClass || outBase.className, dateStr))
          });
        }
      }

      var incomingEdge = null;
      var originalOwner = null;
      var possibleOwners = getSlotOwnerEmails(index, dayOfWeek, period, allSchedules);

      for (var oi = 0; oi < possibleOwners.length; oi++) {
        var owner = possibleOwners[oi];
        var cur = owner;
        var vis = new Set();
        var pth = [];
        while (forwardMap[cur] && !vis.has(cur)) {
          vis.add(cur);
          pth.push(forwardMap[cur]);
          cur = forwardMap[cur].target;
        }
        if (cur === emailLower && pth.length > 0) {
          incomingEdge = pth[pth.length - 1].record;
          originalOwner = owner;
          break;
        }
      }

      // 直接以 actual 命中（含多段調代鏈末端；不依賴基礎課表 owners）
      if (!incomingEdge) {
        for (var pi = 0; pi < periodSubs.length; pi++) {
          var pr = periodSubs[pi];
          if (pr && pr.actualTeacherEmail
              && String(pr.actualTeacherEmail).toLowerCase() === emailLower) {
            incomingEdge = pr;
            originalOwner = pr.originalTeacherEmail
              ? String(pr.originalTeacherEmail).toLowerCase()
              : null;
            break;
          }
        }
      }

      if (incomingEdge) {
        var inCands = originalOwner
          ? getCandidates(index, originalOwner, dayOfWeek, period, allSchedules)
          : [];
        var baseIn = inCands.find(function (s) {
          return String(s.teacherEmail || '').toLowerCase() === originalOwner;
        }) || inCands[0] || null;
        // 調入主標＝此格實際要上的班科（edge 已由 convert 寫入「帶來的課」）
        // 對調：各自帶自己原班到新時段 → edge 存帶來的班科，不可用教師專長覆寫
        // 代課：edge 存被代的那堂
        var isExIn = incomingEdge.type === 'exchange';
        var finalClassIn = String(incomingEdge.className || (baseIn && baseIn.className) || '').trim();
        var finalSubjIn = String(incomingEdge.subject || (baseIn && baseIn.subject) || '').trim();
        // 對調 edge 缺班科：用「帶來者」在 peer 原時段的基礎課（peer 列班科是反向，不可直接抄）
        if (isExIn && (!finalClassIn || !finalSubjIn)) {
          var peerIn = allSubs.find(function (x) {
            return x && x.requestId === incomingEdge.requestId
              && x.id !== incomingEdge.id;
          });
          var bringEmail = String(incomingEdge.actualTeacherEmail || teacherEmail || '').toLowerCase();
          // 帶來者原課在 peer 的 date/period（對調互換前時段）
          if (peerIn && peerIn.date != null && peerIn.period != null) {
            var peerDay = null;
            try {
              var pd = new Date(String(peerIn.date).replace(/-/g, '/'));
              if (!isNaN(pd.getTime())) peerDay = pd.getDay() === 0 ? 7 : pd.getDay();
            } catch (ePd) {}
            if (peerDay != null) {
              var atPeer = getCandidates(index, bringEmail, peerDay, peerIn.period, allSchedules)[0];
              if (atPeer) {
                if (!finalClassIn) finalClassIn = String(atPeer.className || '').trim();
                if (!finalSubjIn) finalSubjIn = String(atPeer.subject || '').trim();
              }
            }
          }
          if (!finalClassIn || !finalSubjIn) {
            var bringBase = getCandidates(index, bringEmail, dayOfWeek, period, allSchedules)[0];
            if (bringBase) {
              if (!finalClassIn) finalClassIn = String(bringBase.className || '').trim();
              if (!finalSubjIn) finalSubjIn = String(bringBase.subject || '').trim();
            }
          }
        }
        finalClassIn = String(finalClassIn || '').trim();
        finalSubjIn = String(finalSubjIn || '').trim();
        if (finalClassIn || finalSubjIn || baseIn || incomingEdge) {
          var subTextIn = '';
          if (isExIn) {
            var otherIn = allSubs.find(function (x) {
              return x.requestId === incomingEdge.requestId
                && (x.date !== incomingEdge.date || String(x.period) !== String(incomingEdge.period) || x.id !== incomingEdge.id);
            });
            var src = otherIn ? formatShortDateAndPeriod(otherIn.date, otherIn.period, h.getWeekDayText) : '他處';
            subTextIn = '⇄ 調自 ' + src + ' ' + h.getTeacherNameByEmail(incomingEdge.originalTeacherEmail);
          } else if (incomingEdge.subFee === '扣額度' || incomingEdge.subFee === '互代不結') {
            subTextIn = '🔁 互代: ' + h.getTeacherNameByEmail(incomingEdge.originalTeacherEmail);
          } else {
            subTextIn = '👤 代課: ' + h.getTeacherNameByEmail(incomingEdge.originalTeacherEmail);
          }
          return {
            className: finalClassIn,
            subject: finalSubjIn,
            teacherEmail: teacherEmail,
            isSubstitutionDuty: true,
            subType: incomingEdge.type,
            isElastic: false,
            isMutualCover: incomingEdge.subFee === '扣額度' || incomingEdge.subFee === '互代不結',
            subText: subTextIn,
            subRecord: incomingEdge,
            isClassAway: !!(h.isClassAway && h.isClassAway(finalClassIn, dateStr))
          };
        }
      }
    }

    var candidates = getCandidates(index, teacherEmail, dayOfWeek, period, allSchedules);
    var base = candidates.find(function (s) {
      if (!s.attr || s.attr === '一般' || s.attr === '輔導' || s.attr === '基本' || s.attr === '抽離' || s.attr === '巡堂') return true;
      if (s.attr === '單週' && h.isSingleWeek(dateStr)) return true;
      if (s.attr === '雙週' && !h.isSingleWeek(dateStr)) return true;
      return false;
    }) || candidates[0] || null;
    if (!base) return null;
    if (base.attr === '單週' && !h.isSingleWeek(dateStr)) return null;
    if (base.attr === '雙週' && h.isSingleWeek(dateStr)) return null;
    // 空堂事件：不刪格（畫面淡化）；標 isClassAway 供媒合／匯出／模擬當空堂
    var patrol = isPatrolAttr(base.attr);
    return Object.assign({}, base, {
      isElastic: base.attr === '實支',
      isPatrol: patrol,
      // 顯示用：巡堂格固定文案
      className: patrol ? (base.className || '巡堂') : base.className,
      subject: patrol ? '巡堂' : base.subject,
      isClassAway: !!(h.isClassAway && h.isClassAway(base.className, dateStr))
    });
  }

  /**
   * 完整 pending 疊加（含空堂調入）
   * @param {object} opts
   * @param {object|null} opts.cell  已核准解析結果
   * @param {string} opts.teacherEmail
   * @param {string} opts.dateStr
   * @param {number|string} opts.period
   * @param {Array} opts.pendingRequests
   * @param {function} opts.getWeekDayText
   * @param {Array} [opts.allSchedules]
   * @param {object} [opts.scheduleIndex]
   */
  /**
   * 進行中申請索引：email|date|period → { outReq, exchangeOutB, subIn, exchangeInA, exchangeInB }
   * 建 weekScheduleGrid 時避免每格線性掃 pending 列表
   */
  function buildPendingIndex(pendingRequests) {
    var map = {};
    function bucket(email, dateStr, period) {
      var em = String(email || '').toLowerCase();
      if (!em || !dateStr) return null;
      var key = em + '|' + dateStr + '|' + parseInt(period, 10);
      if (!map[key]) {
        map[key] = { outReq: null, exchangeOutB: null, subIn: null, exchangeInA: null, exchangeInB: null };
      }
      return map[key];
    }
    (pendingRequests || []).forEach(function (r) {
      if (!r) return;
      var type = r.type;
      var bOut = bucket(r.requesterEmail, r.requestDate, r.requestPeriod);
      if (bOut && !bOut.outReq) bOut.outReq = r;
      if (type === 'exchange') {
        var bOutB = bucket(r.targetTeacherEmail, r.targetDate, r.targetPeriod);
        if (bOutB && !bOutB.exchangeOutB) bOutB.exchangeOutB = r;
        var bInA = bucket(r.requesterEmail, r.targetDate, r.targetPeriod);
        if (bInA && !bInA.exchangeInA) bInA.exchangeInA = r;
        var bInB = bucket(r.targetTeacherEmail, r.requestDate, r.requestPeriod);
        if (bInB && !bInB.exchangeInB) bInB.exchangeInB = r;
      } else if (type === 'substitution') {
        var bSub = bucket(r.targetTeacherEmail, r.requestDate, r.requestPeriod);
        if (bSub && !bSub.subIn) bSub.subIn = r;
      }
    });
    return map;
  }

  function applyPendingOverlay(opts) {
    opts = opts || {};
    var cell = opts.cell;
    var teacherEmail = opts.teacherEmail;
    var dateStr = opts.dateStr;
    var period = opts.period;
    var list = opts.pendingRequests || [];
    var pendingIndex = opts.pendingIndex || null;
    var getWeekDayText = opts.getWeekDayText || function (d) { return d; };
    var allSchedules = opts.allSchedules || [];
    var index = opts.scheduleIndex || null;
    var emailLower = String(teacherEmail || '').toLowerCase();
    var slotKey = emailLower + '|' + dateStr + '|' + parseInt(period, 10);
    var bucket = pendingIndex ? pendingIndex[slotKey] : null;

    function findOutReq() {
      if (bucket) return bucket.outReq;
      return list.find(function (r) {
        return r.requesterEmail && r.requesterEmail.toLowerCase() === emailLower &&
          r.requestDate === dateStr &&
          parseInt(r.requestPeriod) === parseInt(period);
      });
    }
    function findExchangeOutB() {
      if (bucket) return bucket.exchangeOutB;
      return list.find(function (r) {
        return r.type === 'exchange' &&
          r.targetTeacherEmail && r.targetTeacherEmail.toLowerCase() === emailLower &&
          r.targetDate === dateStr &&
          parseInt(r.targetPeriod) === parseInt(period);
      });
    }
    function findSubIn() {
      if (bucket) return bucket.subIn;
      return list.find(function (r) {
        return r.type === 'substitution' &&
          r.targetTeacherEmail && r.targetTeacherEmail.toLowerCase() === emailLower &&
          r.requestDate === dateStr &&
          parseInt(r.requestPeriod) === parseInt(period);
      });
    }
    function findExchangeInA() {
      if (bucket) return bucket.exchangeInA;
      return list.find(function (r) {
        return r.type === 'exchange' &&
          r.requesterEmail && r.requesterEmail.toLowerCase() === emailLower &&
          r.targetDate === dateStr &&
          parseInt(r.targetPeriod) === parseInt(period);
      });
    }
    function findExchangeInB() {
      if (bucket) return bucket.exchangeInB;
      return list.find(function (r) {
        return r.type === 'exchange' &&
          r.targetTeacherEmail && r.targetTeacherEmail.toLowerCase() === emailLower &&
          r.requestDate === dateStr &&
          parseInt(r.requestPeriod) === parseInt(period);
      });
    }

    // 1. 請假人／調出
    if (cell && !cell.isSubstituted) {
      var pReq = findOutReq();
      if (pReq) {
        if (pReq.type === 'exchange') {
          return Object.assign({}, cell, {
            isPending: true,
            pendingType: 'exchange_out',
            pendingText: '⇄ 調至 ' + formatShortDateAndPeriod(pReq.targetDate, pReq.targetPeriod, getWeekDayText) + ' ' + pReq.targetTeacherName,
            pendingRecord: pReq
          });
        }
        return Object.assign({}, cell, {
          isPending: true,
          pendingType: 'substitution_out',
          pendingText: '⇄ 代課 ➔ ' + pReq.targetTeacherName,
          pendingRecord: pReq
        });
      }

      var pReqB = findExchangeOutB();
      if (pReqB) {
        return Object.assign({}, cell, {
          isPending: true,
          pendingType: 'exchange_out',
          pendingText: '⇄ 調至 ' + formatShortDateAndPeriod(pReqB.requestDate, pReqB.requestPeriod, getWeekDayText) + ' ' + pReqB.requesterName,
          pendingRecord: pReqB
        });
      }
    }

    // 2. 代課／調入（空堂或已調出）
    if (!cell || cell.isSubstituted) {
      var pSub = findSubIn();
      if (pSub) {
        return {
          className: pSub.className,
          subject: pSub.subject,
          teacherEmail: teacherEmail,
          isPending: true,
          pendingType: 'substitution_in',
          pendingText: '⇄ 待代 🠔 ' + pSub.requesterName,
          pendingRecord: pSub
        };
      }

      var pExcA = findExchangeInA();
      if (pExcA) {
        var targetDay = parseInt(pExcA.targetDayOfWeek, 10);
        var schedCands = getCandidates(index, pExcA.targetTeacherEmail, targetDay, pExcA.targetPeriod, allSchedules);
        var sched = schedCands[0] || null;
        var finalSubject = sched ? sched.subject : (pExcA.targetSubject || pExcA.subject || '自習');
        return {
          className: pExcA.className,
          subject: finalSubject,
          teacherEmail: teacherEmail,
          isPending: true,
          pendingType: 'exchange_in',
          pendingText: '⇄ 調自 ' + formatShortDateAndPeriod(pExcA.requestDate, pExcA.requestPeriod, getWeekDayText) + ' ' + pExcA.targetTeacherName,
          pendingRecord: pExcA
        };
      }

      var pExcB = findExchangeInB();
      if (pExcB) {
        return {
          className: pExcB.className,
          subject: pExcB.subject,
          teacherEmail: teacherEmail,
          isPending: true,
          pendingType: 'exchange_in',
          pendingText: '⇄ 調自 ' + formatShortDateAndPeriod(pExcB.targetDate, pExcB.targetPeriod, getWeekDayText) + ' ' + pExcB.requesterName,
          pendingRecord: pExcB
        };
      }
    }

    return cell;
  }

  return {
    buildSubstitutionsLookup: buildSubstitutionsLookup,
    buildScheduleIndex: buildScheduleIndex,
    buildPendingIndex: buildPendingIndex,
    getCandidates: getCandidates,
    getSlotOwnerEmails: getSlotOwnerEmails,
    resolveApprovedSchedule: resolveApprovedSchedule,
    applyPendingOverlay: applyPendingOverlay,
    isPatrolAttr: isPatrolAttr,
    isPatrolCell: isPatrolCell,
    PATROL_INCOMING_TIP: PATROL_INCOMING_TIP
  };
})();
