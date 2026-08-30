/**
 * 課表領域邏輯（純函式）
 * 索引、圖論遞推調代鏈、lookup、pending 疊加
 */
window.DomainSchedule = (function () {
  /** 課堂屬性＝巡堂（顯示、不算鐘點、不可調出、可當空堂） */
  function isPatrolAttr(attr) {
    var a = String(attr || '').trim();
    return a === '巡堂' || a.indexOf('巡堂') >= 0;
  }

  /**
   * 巡堂格：屬性／旗標，或班／科欄寫「巡堂」（基礎課表常見只填科目、屬性空白）
   */
  function isPatrolCell(cell) {
    if (!cell || cell.isSubstituted || cell.isPending) return false;
    if (cell.isPatrol) return true;
    if (isPatrolAttr(cell.attr)) return true;
    var cn = String(cell.className || '').trim();
    var subj = String(cell.subject || '').trim();
    if (cn === '巡堂' || subj === '巡堂') return true;
    return false;
  }

  /** 課堂屬性＝抽離（不進班級課表；調課僅可與另一節抽離互調，不可與一般課） */
  function isPullOutAttr(attr) {
    return String(attr || '').trim() === '抽離';
  }

  function isPullOutCell(cell) {
    if (!cell) return false;
    if (cell.isPullOut) return true;
    return isPullOutAttr(cell.attr);
  }

  function isCombinedReturnRequest(request) {
    var raw = request && request.specialFlow;
    if (String(raw == null ? '' : raw).trim() === '') raw = request && request['特殊流程'];
    var value = String(raw == null ? '' : raw).trim().toLowerCase();
    return value === 'combined_return' || value === '合班回原班';
  }

  var PATROL_INCOMING_TIP =
    '對方本節為【巡堂】。排入代課／調課後，請私下協調代巡堂或互換，系統不另開巡堂代課單。';

  var PULL_OUT_EXCHANGE_TIP =
    '抽離課僅可與另一節「抽離」互調，不可與一般課調課。';

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
    var periodLabel = (window.DateUtils && window.DateUtils.formatPeriodText)
      ? window.DateUtils.formatPeriodText(period)
      : (parseInt(period, 10) === 0 ? '早自習' : (parseInt(period, 10) === 45 ? '午休' : '第' + period + '節'));
    return mmdd + weekPart + ' ' + periodLabel;
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

  function normalizeScheduleDate(value) {
    if (value === undefined || value === null || value === '') return '';
    if (Object.prototype.toString.call(value) === '[object Date]' && !isNaN(value.getTime())) {
      return value.getFullYear() + '-' + String(value.getMonth() + 1).padStart(2, '0')
        + '-' + String(value.getDate()).padStart(2, '0');
    }
    var raw = String(value).trim().split(/[T ]/)[0].replace(/\//g, '-');
    var match = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (!match) return '';
    var year = parseInt(match[1], 10);
    var month = parseInt(match[2], 10);
    var day = parseInt(match[3], 10);
    var date = new Date(year, month - 1, day);
    if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return '';
    return match[1] + '-' + String(month).padStart(2, '0') + '-' + String(day).padStart(2, '0');
  }

  function scheduleDateField(row, names) {
    var source = row || {};
    for (var i = 0; i < names.length; i++) {
      if (source[names[i]] !== undefined && source[names[i]] !== null && source[names[i]] !== '') {
        return source[names[i]];
      }
    }
    return '';
  }

  function scheduleActiveFrom(row) {
    return normalizeScheduleDate(scheduleDateField(row, [
      '啟用起日', '啟用開始日', 'activeFrom', 'activationStartDate', 'effectiveStartDate'
    ]));
  }

  function scheduleActiveTo(row) {
    return normalizeScheduleDate(scheduleDateField(row, [
      '啟用迄日', '啟用結束日', 'activeTo', 'activationEndDate', 'effectiveEndDate'
    ]));
  }

  /** 空白起訖日代表整個目前學期有效。 */
  function isActiveOnDate(row, dateStr) {
    if (!dateStr) return true;
    var date = normalizeScheduleDate(dateStr);
    if (!date) return false;
    var rawFrom = scheduleDateField(row, [
      '啟用起日', '啟用開始日', 'activeFrom', 'activationStartDate', 'effectiveStartDate'
    ]);
    var rawTo = scheduleDateField(row, [
      '啟用迄日', '啟用結束日', 'activeTo', 'activationEndDate', 'effectiveEndDate'
    ]);
    var from = scheduleActiveFrom(row);
    var to = scheduleActiveTo(row);
    if (rawFrom && !from) return false;
    if (rawTo && !to) return false;
    if (from && date < from) return false;
    if (to && date > to) return false;
    return !from || !to || from <= to;
  }

  function filterActiveRows(rows, dateStr) {
    var list = rows || [];
    if (!dateStr) return list.slice();
    return list.filter(function (row) { return isActiveOnDate(row, dateStr); });
  }

  function scheduleRangesOverlap(a, b) {
    var aFrom = scheduleActiveFrom(a) || '0000-01-01';
    var aTo = scheduleActiveTo(a) || '9999-12-31';
    var bFrom = scheduleActiveFrom(b) || '0000-01-01';
    var bTo = scheduleActiveTo(b) || '9999-12-31';
    return aFrom <= bTo && bFrom <= aTo;
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

  function getCandidates(index, teacherEmail, dayOfWeek, period, allSchedules, dateStr) {
    const emailLower = String(teacherEmail || '').toLowerCase();
    var rows;
    if (index && index.byTeacherSlot) {
      const key = emailLower + '|' + parseInt(dayOfWeek, 10) + '|' + parseInt(period, 10);
      rows = index.byTeacherSlot[key] || [];
      return filterActiveRows(rows, dateStr);
    }
    rows = (allSchedules || []).filter(function (s) {
      return String(s.teacherEmail || '').toLowerCase() === emailLower &&
        parseInt(s.dayOfWeek) === parseInt(dayOfWeek) &&
        parseInt(s.period) === parseInt(period);
    });
    return filterActiveRows(rows, dateStr);
  }

  function getSlotOwnerEmails(index, dayOfWeek, period, allSchedules, dateStr) {
    var rows;
    if (index && index.bySlotOwners) {
      var emails = index.bySlotOwners[parseInt(dayOfWeek, 10) + '|' + parseInt(period, 10)] || [];
      if (!dateStr) return emails;
      rows = filterActiveRows((allSchedules || []).filter(function (s) {
        return emails.indexOf(String(s.teacherEmail || '').toLowerCase()) >= 0
          && parseInt(s.dayOfWeek, 10) === parseInt(dayOfWeek, 10)
          && parseInt(s.period, 10) === parseInt(period, 10);
      }), dateStr);
      return rows.map(function (s) { return String(s.teacherEmail || '').toLowerCase(); })
        .filter(function (email, i, list) { return list.indexOf(email) === i; });
    }
    rows = (allSchedules || []).filter(function (s) {
      return parseInt(s.dayOfWeek) === parseInt(dayOfWeek) &&
        parseInt(s.period) === parseInt(period);
    });
    return filterActiveRows(rows, dateStr).map(function (s) { return String(s.teacherEmail || '').toLowerCase(); });
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
    const scheduleDayOfWeek = ctx.scheduleDayOfWeek != null ? ctx.scheduleDayOfWeek : dayOfWeek;
    const schedulePeriod = ctx.schedulePeriod != null ? ctx.schedulePeriod : period;



    if (periodSubs.length > 0) {
      var combinedOwn = periodSubs.find(function (r) {
        return isCombinedReturnRequest(r)
          && String(r.date || '') === String(dateStr || '')
          && parseInt(r.period, 10) === parseInt(period, 10)
          && String(r.originalTeacherEmail || '').toLowerCase() === String(teacherEmail || '').toLowerCase()
          && String(r.actualTeacherEmail || '').toLowerCase() === String(teacherEmail || '').toLowerCase();
      });
      if (combinedOwn) {
        var combinedCandidates = getCandidates(index, teacherEmail, scheduleDayOfWeek, schedulePeriod, allSchedules, dateStr);
        var combinedBase = combinedCandidates[0] || null;
        var combinedClass = String(combinedOwn.className || (combinedBase && combinedBase.className) || '').trim();
        var combinedSubject = String(combinedOwn.subject || (combinedBase && combinedBase.subject) || '').trim();
        return Object.assign({}, combinedBase || {}, {
          className: combinedClass,
          subject: combinedSubject,
          teacherEmail: teacherEmail,
          dayOfWeek: dayOfWeek,
          period: period,
          isCombinedReturn: true,
          specialFlow: 'combined_return',
          subType: 'substitution',
           subText: '↩ 併班上課',
          subRecord: combinedOwn,
          isSubstituted: false,
          isSubstitutionDuty: false,
          isClassAway: !!(h.isClassAway && h.isClassAway(combinedClass, dateStr))
        });
      }
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

      // 空堂排班：原＝實＝本人（扣額度任務，非請假調出）
      for (var se = 0; se < periodSubs.length; se++) {
        var selfRec = periodSubs[se];
        if (!selfRec) continue;
        var oEm = String(selfRec.originalTeacherEmail || '').toLowerCase();
        var aEm = String(selfRec.actualTeacherEmail || '').toLowerCase();
        if (oEm !== emailLower || aEm !== emailLower) continue;
        var tSelf = selfRec.type;
        if (tSelf && tSelf !== 'substitution' && tSelf !== '代課') continue;
        var reasonSelf = String(selfRec.reason || '').trim();
        var noteSelf = String(selfRec.note || '');
        var isEmptyAssign = reasonSelf === '空堂排班'
          || noteSelf.indexOf('[空堂排班]') >= 0
          || !!(selfRec.isEmptySlotAssign);
        if (!isEmptyAssign) continue;
        var feeSelf = String(selfRec.subFee || '');
        var mutualSelf = feeSelf === '扣額度' || feeSelf === '互代不結';
        return {
          className: String(selfRec.className || '').trim(),
          subject: String(selfRec.subject || '').trim() || '空堂任務',
          teacherEmail: teacherEmail,
          dayOfWeek: dayOfWeek,
          period: period,
          isSubstitutionDuty: true,
          isEmptySlotAssign: true,
          subType: 'substitution',
          isElastic: false,
          isMutualCover: mutualSelf,
          subText: '📌 ' + (String(selfRec.subject || '').trim() || '空堂任務'),
          subRecord: selfRec,
          isClassAway: false
        };
      }

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
        var outCands = getCandidates(index, teacherEmail, scheduleDayOfWeek, schedulePeriod, allSchedules, dateStr);
        var baseOut = outCands.find(function (s) {
          return String(s.teacherEmail || '').toLowerCase() === emailLower;
        }) || outCands[0] || null;

        // 調出格仍顯示這位教師自己的原課；交換後的課程只在對方時段顯示。
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
        var ownOutClass;
        var ownOutSubj;
        if (firstEdge.type === 'exchange' || firstEdge.type === 'triangle') {
          ownOutClass = String(
            (baseOut && baseOut.className)
            || (priorDuty && priorDuty.className)
            || (firstEdge && firstEdge.className)
            || ''
          ).trim();
          ownOutSubj = String(
            (baseOut && baseOut.subject)
            || (priorDuty && priorDuty.subject)
            || (h.getTeacherSubjectByEmail && h.getTeacherSubjectByEmail(teacherEmail))
            || (firstEdge && firstEdge.subject)
            || ''
          ).trim();
        } else {
          ownOutClass = String(
            (firstEdge && firstEdge.className)
            || (baseOut && baseOut.className)
            || (priorDuty && priorDuty.className)
            || ''
          ).trim();
          ownOutSubj = String(
            (firstEdge && firstEdge.subject)
            || (baseOut && baseOut.subject)
            || (priorDuty && priorDuty.subject)
            || ''
          ).trim();
        }
        var subText = '';
        if (firstEdge.type === 'exchange' || firstEdge.type === 'triangle') {
          if (firstEdge.type === 'triangle') {
            var triangleMove = allSubs.find(function (x) {
              return x && x.type === 'triangle'
                && x.triangleId && x.triangleId === firstEdge.triangleId
                && x.actualTeacherEmail
                && String(x.actualTeacherEmail).toLowerCase() === emailLower
                && String(x.triangleSourceDate || '') === String(dateStr || '')
                && parseInt(x.triangleSourcePeriod, 10) === parseInt(period, 10);
            });
            var triangleDestination = triangleMove
              ? formatShortDateAndPeriod(triangleMove.date, triangleMove.period, h.getWeekDayText)
              : '下一個目標時段';
            subText = '△ 三角調至 ' + triangleDestination
              + (triangleMove && triangleMove.triangleTargetTeacherName
                ? ' ' + h.getTeacherNameByEmail(triangleMove.triangleTargetTeacherName)
                : '');
          } else {
            var otherSub = allSubs.find(function (x) {
              return x.requestId === firstEdge.requestId
                && (x.date !== firstEdge.date || String(x.period) !== String(firstEdge.period) || x.id !== firstEdge.id);
            });
            var dest = otherSub ? formatShortDateAndPeriod(otherSub.date, otherSub.period, h.getWeekDayText) : '他處';
            subText = '⇄ 調至 ' + dest + ' ' + h.getTeacherNameByEmail(firstEdge.actualTeacherEmail);
          }
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
       var possibleOwners = getSlotOwnerEmails(index, scheduleDayOfWeek, schedulePeriod, allSchedules, dateStr);

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
           ? getCandidates(index, originalOwner, scheduleDayOfWeek, schedulePeriod, allSchedules, dateStr)
          : [];
        var baseIn = inCands.find(function (s) {
          return String(s.teacherEmail || '').toLowerCase() === originalOwner;
        }) || inCands[0] || null;
        // 調入主標＝實際授課教師帶到新時段的原課班科（edge 由交換轉換器寫入）。
        // 對調後網頁課表以教師／班級／科目整組換時段為準。
        // 代課：edge 存被代的那堂
        var isExIn = incomingEdge.type === 'exchange' || incomingEdge.type === 'triangle';
        var finalClassIn = String(incomingEdge.className || (baseIn && baseIn.className) || '').trim();
        var finalSubjIn = String(incomingEdge.subject || (baseIn && baseIn.subject) || '').trim();
        // 對調 edge 缺班科：回到原位置所有者在目前日期／節次的基礎課。
        if (isExIn && (!finalClassIn || !finalSubjIn)) {
          if (baseIn) {
            if (!finalClassIn) finalClassIn = String(baseIn.className || '').trim();
            if (!finalSubjIn) finalSubjIn = String(baseIn.subject || '').trim();
          }
        }
        finalClassIn = String(finalClassIn || '').trim();
        finalSubjIn = String(finalSubjIn || '').trim();
        if (finalClassIn || finalSubjIn || baseIn || incomingEdge) {
          var subTextIn = '';
          if (isExIn) {
            if (incomingEdge.type === 'triangle') {
              var triangleSource = formatShortDateAndPeriod(
                incomingEdge.triangleSourceDate,
                incomingEdge.triangleSourcePeriod,
                h.getWeekDayText
              );
              subTextIn = '△ 三角調自 ' + triangleSource + ' '
                + h.getTeacherNameByEmail(incomingEdge.actualTeacherEmail);
            } else {
              var otherIn = allSubs.find(function (x) {
                return x.requestId === incomingEdge.requestId
                  && (x.date !== incomingEdge.date || String(x.period) !== String(incomingEdge.period) || x.id !== incomingEdge.id);
              });
              var src = otherIn ? formatShortDateAndPeriod(otherIn.date, otherIn.period, h.getWeekDayText) : '他處';
              subTextIn = '⇄ 調自 ' + src + ' ' + h.getTeacherNameByEmail(incomingEdge.originalTeacherEmail);
            }
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

     var candidates = getCandidates(index, teacherEmail, scheduleDayOfWeek, schedulePeriod, allSchedules, dateStr);
    var base = candidates.find(function (s) {
      if (!s.attr || s.attr === '一般' || s.attr === '課輔' || s.attr === '基本' || s.attr === '抽離' || s.attr === '巡堂') return true;
      if (s.attr === '單週' && h.isSingleWeek(dateStr)) return true;
      if (s.attr === '雙週' && !h.isSingleWeek(dateStr)) return true;
      return false;
    }) || candidates[0] || null;
    if (!base) return null;
    if (base.attr === '單週' && !h.isSingleWeek(dateStr)) return null;
    if (base.attr === '雙週' && h.isSingleWeek(dateStr)) return null;
    // 空堂事件：不刪格（畫面淡化）；標 isClassAway 供媒合／匯出／模擬當空堂
    var baseCn = String(base.className || '').trim();
    var baseSubj = String(base.subject || '').trim();
    var patrol = isPatrolAttr(base.attr)
      || baseCn === '巡堂'
      || baseSubj === '巡堂';
    var pullOut = isPullOutAttr(base.attr);
    return Object.assign({}, base, {
      dayOfWeek: dayOfWeek,
      period: period,
      isElastic: base.attr === '實支',
      isPatrol: patrol,
      isPullOut: pullOut,
      // 顯示用：巡堂格固定文案
      className: patrol ? (baseCn && baseCn !== '巡堂' ? baseCn : '巡堂') : base.className,
      subject: patrol ? '巡堂' : base.subject,
      attr: patrol ? (base.attr || '巡堂') : base.attr,
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
          map[key] = {
            outReq: null,
            exchangeOutB: null,
            subIn: null,
            exchangeInA: null,
            exchangeInB: null,
            triangleOut: null,
            triangleIn: null
          };
      }
      return map[key];
    }
    (pendingRequests || []).forEach(function (r) {
      if (!r) return;
       var type = r.type;
       if (type === 'triangle' || type === '三角調') {
         var triangleOut = bucket(r.requesterEmail, r.requestDate, r.requestPeriod);
         if (triangleOut && !triangleOut.triangleOut) triangleOut.triangleOut = r;
         // 來源教師會帶著自己的課到目標原課時段；目標教師的調出由其下一條 leg 表示。
         var triangleIn = bucket(r.requesterEmail, r.targetDate, r.targetPeriod);
         if (triangleIn && !triangleIn.triangleIn) triangleIn.triangleIn = r;
         return;
       }
       var bOut = bucket(r.requesterEmail, r.requestDate, r.requestPeriod);
      if (bOut && !bOut.outReq) bOut.outReq = r;
      if (type === 'exchange') {
        var bOutB = bucket(r.targetTeacherEmail, r.targetDate, r.targetPeriod);
        if (bOutB && !bOutB.exchangeOutB) bOutB.exchangeOutB = r;
        var bInA = bucket(r.requesterEmail, r.targetDate, r.targetPeriod);
        if (bInA && !bInA.exchangeInA) bInA.exchangeInA = r;
        var bInB = bucket(r.targetTeacherEmail, r.requestDate, r.requestPeriod);
        if (bInB && !bInB.exchangeInB) bInB.exchangeInB = r;
      } else if (type === 'substitution' || type === 'triangle') {
        var bSub = bucket(r.targetTeacherEmail, r.requestDate, r.requestPeriod);
        if (bSub && !bSub.subIn) bSub.subIn = r;
      }
    });
    return map;
  }

  function pendingExchangeOwnCourse(request, teacherEmail, index, allSchedules, resolveBaseSlot) {
    var email = String(teacherEmail || '').toLowerCase();
    var requester = String(request && request.requesterEmail || '').toLowerCase();
    var target = String(request && request.targetTeacherEmail || '').toLowerCase();
    if (email === requester) {
      return {
        className: String(request && request.className || '').trim(),
        subject: String(request && request.subject || '').trim()
      };
    }
    if (email !== target) return { className: '', subject: '' };

    var className = String(request && request.targetClassName || '').trim();
    var subject = String(request && request.targetSubject || '').trim();
    if ((!className || !subject) && request && request.targetDate && request.targetPeriod != null) {
      var day = parseInt(request.targetDayOfWeek, 10);
      if (!(day >= 1 && day <= 7)) {
        var date = new Date(String(request.targetDate).replace(/-/g, '/'));
        if (!isNaN(date.getTime())) day = date.getDay() === 0 ? 7 : date.getDay();
      }
      var baseSlot = typeof resolveBaseSlot === 'function'
        ? resolveBaseSlot(request.targetDate, day, request.targetPeriod, request.targetTeacherEmail)
        : { dayOfWeek: day, period: request.targetPeriod };
      var candidates = getCandidates(
        index,
        request.targetTeacherEmail,
        baseSlot.dayOfWeek,
        baseSlot.period,
         allSchedules,
         request.targetDate
      );
      var base = candidates[0] || null;
      if (base) {
        if (!className) className = String(base.className || '').trim();
        if (!subject) subject = String(base.subject || '').trim();
      }
    }
    return { className: className, subject: subject };
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
    var resolveBaseSlot = opts.resolveBaseSlot || function (dateStr0, day0, period0) {
      return { dayOfWeek: day0, period: period0 };
    };
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
        return (r.type === 'substitution' || r.type === 'triangle') &&
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

    function findTriangleOut() {
      return bucket ? bucket.triangleOut : list.find(function (r) {
        return (r.type === 'triangle' || r.type === '三角調')
          && r.requesterEmail && r.requesterEmail.toLowerCase() === emailLower
          && r.requestDate === dateStr
          && parseInt(r.requestPeriod) === parseInt(period);
      });
    }

    function findTriangleIn() {
      return bucket ? bucket.triangleIn : list.find(function (r) {
        return (r.type === 'triangle' || r.type === '三角調')
          && r.requesterEmail && r.requesterEmail.toLowerCase() === emailLower
          && r.targetDate === dateStr
          && parseInt(r.targetPeriod) === parseInt(period);
      });
    }

    // 三角調同時包含調出與調入兩個角色，優先顯示整組待簽核狀態。
    var triangleOut = findTriangleOut();
    var triangleIn = findTriangleIn();
    if (triangleOut || triangleIn) {
      var triangleRecord = triangleOut || triangleIn;
      var triangleText = '△ 三角調整中（需三位教師全部同意）';
      if (triangleOut && triangleIn) {
        return Object.assign({}, cell || {}, {
          isPending: true,
          pendingType: 'triangle',
          pendingText: triangleText,
          pendingRecord: triangleRecord,
          triangleIncomingRecord: triangleIn
        });
      }
      if (triangleOut) {
        return Object.assign({}, cell || {}, {
          isPending: true,
          pendingType: 'triangle_out',
          pendingText: triangleText,
          pendingRecord: triangleOut
        });
      }
      return Object.assign({}, cell || {}, {
        className: triangleIn.className || (cell && cell.className) || '',
        subject: triangleIn.subject || (cell && cell.subject) || '',
        teacherEmail: teacherEmail,
        isPending: true,
        isSubstituted: true,
        pendingType: 'triangle_in',
        pendingText: triangleText,
        pendingRecord: triangleIn
      });
    }

    // 1. 請假人／調出
    if (cell && !cell.isSubstituted) {
      var pReq = findOutReq();
      if (pReq) {
        if (isCombinedReturnRequest(pReq)) {
          return Object.assign({}, cell, {
            isPending: true,
            pendingType: 'combined_return_out',
           pendingText: '↩ 待核 併班上課',
            pendingRecord: pReq
          });
        }
        if (pReq.type === 'exchange' || pReq.type === 'triangle') {
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

    // 2. 代課／調入（空堂或已調出）；合班代課即使代課教師原本有課也要覆蓋顯示
    var pSub = findSubIn();
    if (pSub && isCombinedReturnRequest(pSub)) {
      return Object.assign({}, cell || {}, {
        className: pSub.className || (cell && cell.className) || '',
        subject: pSub.subject || (cell && cell.subject) || '',
        teacherEmail: teacherEmail,
        isPending: true,
        isSubstituted: true,
        isSubstitutionDuty: true,
        isCombinedReturn: true,
        pendingType: 'combined_return_in',
        pendingText: '↩ 待代 ' + (pSub.requesterName || '請假教師'),
        pendingRecord: pSub,
        subRecord: pSub
      });
    }
    if (!cell || cell.isSubstituted) {
      if (pSub) {
        var sameSelf = pSub.requesterEmail && pSub.targetTeacherEmail
          && String(pSub.requesterEmail).toLowerCase() === String(pSub.targetTeacherEmail).toLowerCase()
          && String(pSub.requesterEmail).toLowerCase() === emailLower;
        var emptyPend = sameSelf && (
          String(pSub.reason || '').trim() === '空堂排班'
          || String(pSub.note || '').indexOf('[空堂排班]') >= 0
          || pSub.isEmptySlotAssign
        );
        if (emptyPend) {
          return {
            className: pSub.className || '',
            subject: pSub.subject || '空堂任務',
            teacherEmail: teacherEmail,
            isPending: true,
            isEmptySlotAssign: true,
            pendingType: 'empty_slot_assign',
            pendingText: '📌 待核 ' + (pSub.subject || '空堂任務'),
            pendingRecord: pSub
          };
        }
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
        var ownCourseA = pendingExchangeOwnCourse(pExcA, teacherEmail, index, allSchedules, resolveBaseSlot);
        return {
          className: ownCourseA.className,
          subject: ownCourseA.subject,
          teacherEmail: teacherEmail,
          isPending: true,
          pendingType: 'exchange_in',
          pendingText: '⇄ 調自 ' + formatShortDateAndPeriod(pExcA.requestDate, pExcA.requestPeriod, getWeekDayText) + ' ' + pExcA.targetTeacherName,
          pendingRecord: pExcA
        };
      }

      var pExcB = findExchangeInB();
      if (pExcB) {
        var ownCourseB = pendingExchangeOwnCourse(pExcB, teacherEmail, index, allSchedules, resolveBaseSlot);
        return {
          className: ownCourseB.className,
          subject: ownCourseB.subject,
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
    isPullOutAttr: isPullOutAttr,
    isPullOutCell: isPullOutCell,
    normalizeScheduleDate: normalizeScheduleDate,
    scheduleActiveFrom: scheduleActiveFrom,
    scheduleActiveTo: scheduleActiveTo,
    isActiveOnDate: isActiveOnDate,
    filterActiveRows: filterActiveRows,
    scheduleRangesOverlap: scheduleRangesOverlap,
    isCombinedReturnRequest: isCombinedReturnRequest,
    PATROL_INCOMING_TIP: PATROL_INCOMING_TIP,
    PULL_OUT_EXCHANGE_TIP: PULL_OUT_EXCHANGE_TIP
  };
})();
