/**
 * 三角調領域邏輯（純函式）
 * 三位教師各提供一堂原課，依 A → B → C → A 循環交換。
 */
window.DomainTriangle = (function () {
  var TRIANGLE_TYPE = 'triangle';

  function text(value) {
    return String(value == null ? '' : value).trim();
  }

  function teacherKey(value) {
    return text(value).toLowerCase();
  }

  function dateDay(dateStr) {
    var raw = text(dateStr);
    if (!raw) return 0;
    var date = new Date(raw.replace(/-/g, '/'));
    if (isNaN(date.getTime())) return 0;
    var day = date.getDay();
    return day === 0 ? 7 : day;
  }

  function periodValue(value) {
    if (value === 0 || value === '0') return 0;
    if (value === 45 || value === '45') return 45;
    var period = parseInt(value, 10);
    return isNaN(period) ? null : period;
  }

  function pick(source, names) {
    var row = source || {};
    for (var i = 0; i < names.length; i++) {
      if (row[names[i]] !== undefined && row[names[i]] !== null && text(row[names[i]]) !== '') {
        return row[names[i]];
      }
    }
    return '';
  }

  function normalizeSlot(source, prefix) {
    var row = source || {};
    var isTarget = prefix === 'target';
    var date = pick(row, isTarget
      ? ['targetDate', '對調目標日期', 'dateB', 'date']
      : ['sourceDate', 'requestDate', '異動日期', 'dateA', 'date']);
    var day = pick(row, isTarget
      ? ['targetDayOfWeek', '對調目標星期', 'dayB', 'targetDay']
      : ['sourceDayOfWeek', 'requestPeriodDay', '異動星期', 'dayA', 'sourceDay']);
    var period = pick(row, isTarget
      ? ['targetPeriod', '對調目標節次', 'periodB', 'period']
      : ['sourcePeriod', 'requestPeriod', '異動節次', 'periodA', 'period']);
    date = text(date).slice(0, 10);
    period = periodValue(period);
    day = parseInt(day, 10);
    if (!(day >= 1 && day <= 7)) day = dateDay(date);
    return { date: date, day: day || 0, period: period };
  }

  function normalizeCourse(source, prefix) {
    var row = source || {};
    var isTarget = prefix === 'target';
    var course = row[isTarget ? 'targetCourse' : 'sourceCourse'] || {};
    return {
      className: text(course.className || pick(row, isTarget
        ? ['targetClassName', '對調目標班級', 'classB']
        : ['className', '班級', 'classA'])),
      subject: text(course.subject || pick(row, isTarget
        ? ['targetSubject', '對調目標科目', 'subjectB']
        : ['subject', '科目', 'subjectA'])),
      attr: text(course.attr || pick(row, isTarget ? ['targetAttr'] : ['attr'])),
      specialTags: text(course.specialTags || course['特殊標記'] || pick(row,
        isTarget ? ['targetSpecialTags'] : ['specialTags', '特殊標記'])),
      isPullOut: !!(course.isPullOut || row[isTarget ? 'targetIsPullOut' : 'sourceIsPullOut']),
      isPatrol: !!(course.isPatrol || row[isTarget ? 'targetIsPatrol' : 'sourceIsPatrol']),
      isEmpty: !!(course.isEmpty || row[isTarget ? 'targetIsEmpty' : 'sourceIsEmpty']),
      isPending: !!(course.isPending || row[isTarget ? 'targetIsPending' : 'sourceIsPending']),
      isSubstituted: !!(course.isSubstituted || row[isTarget ? 'targetIsSubstituted' : 'sourceIsSubstituted'])
    };
  }

  function normalizeLeg(raw, index) {
    var row = raw || {};
    var sourceTeacher = pick(row, ['sourceTeacher', 'fromTeacher', 'requesterName', 'requesterEmail', '申請人姓名', '申請人Email']);
    var targetTeacher = pick(row, ['targetTeacher', 'toTeacher', 'targetTeacherName', 'targetTeacherEmail', '受邀人姓名', '受邀人Email']);
    return {
      index: index == null ? parseInt(pick(row, ['index', 'legIndex', 'triangleLegIndex', '三角腳次']), 10) || 0 : index,
      sourceTeacher: text(sourceTeacher),
      targetTeacher: text(targetTeacher),
      sourceSlot: normalizeSlot(row.sourceSlot || row, 'source'),
      targetSlot: normalizeSlot(row.targetSlot || row, 'target'),
      sourceCourse: normalizeCourse(row.sourceCourse ? row : Object.assign({}, row, { sourceCourse: row }), 'source'),
      targetCourse: normalizeCourse(row.targetCourse ? row : Object.assign({}, row, { targetCourse: row }), 'target')
    };
  }

  function slotKey(slot) {
    var value = slot || {};
    return text(value.date).slice(0, 10) + '|' + periodValue(value.period);
  }

  function sameSlot(a, b) {
    return slotKey(a) === slotKey(b) && !!text(a && a.date) && periodValue(a && a.period) !== null;
  }

  function isPatrolCourse(course) {
    var value = course || {};
    return !!(value.isPatrol || /巡堂/.test(text(value.attr))
      || text(value.className) === '巡堂' || text(value.subject) === '巡堂');
  }

  function isPullOutCourse(course) {
    var value = course || {};
    if (value.isPullOut) return true;
    if (text(value.attr).indexOf('抽離') >= 0) return true;
    return text(value.specialTags || value['特殊標記']).split(/[、,，;；/／|｜\s]+/).some(function (tag) {
      return tag === '抽離';
    });
  }

  function classList(value) {
    return text(value).split(/[、,，\/／;；\s]+/).map(function (item) {
      return text(item);
    }).filter(Boolean);
  }

  function sameClass(left, right) {
    var a = classList(left);
    var b = classList(right);
    if (!a.length || !b.length) return false;
    return a.some(function (item) { return b.indexOf(item) !== -1; });
  }

  function isUsableCourse(course) {
    var value = course || {};
    return !!(text(value.className) && text(value.subject)
      && !value.isEmpty && !value.isPending && !value.isSubstituted
      && !isPatrolCourse(value));
  }

  function buildCycleLegs(participants) {
    var list = Array.isArray(participants) ? participants : [];
    return list.map(function (participant, index) {
      var current = participant || {};
      var next = list[(index + 1) % list.length] || {};
      return {
        index: index + 1,
        sourceTeacher: text(current.teacher || current.teacherName || current.email),
        targetTeacher: text(next.teacher || next.teacherName || next.email),
        sourceSlot: Object.assign({}, current.slot || {}),
        targetSlot: Object.assign({}, next.slot || {}),
        sourceCourse: Object.assign({}, current.course || {}),
        targetCourse: Object.assign({}, next.course || {})
      };
    });
  }

  function buildFinalAssignments(legs) {
    return (legs || []).map(function (leg) {
      return {
        teacher: leg.sourceTeacher,
        teacherKey: teacherKey(leg.sourceTeacher),
        removeSlot: Object.assign({}, leg.sourceSlot),
        addSlot: Object.assign({}, leg.targetSlot),
        course: Object.assign({}, leg.sourceCourse)
      };
    });
  }

  function occupiedFor(options, teacher) {
    var key = teacherKey(teacher);
    if (options && typeof options.getOccupiedSlots === 'function') {
      return options.getOccupiedSlots(teacher) || [];
    }
    var source = options && options.occupiedByTeacher;
    if (!source) return [];
    if (Array.isArray(source)) {
      return source.filter(function (row) {
        return teacherKey(row && (row.teacher || row.teacherName || row.email)) === key;
      });
    }
    return source[teacher] || source[key] || [];
  }

  function normalizeOccupied(row) {
    var value = row || {};
    return {
      teacher: text(value.teacher || value.teacherName || value.email),
      date: text(value.date || value.requestDate || value['異動日期']).slice(0, 10),
      period: periodValue(value.period != null ? value.period : value.requestPeriod != null
        ? value.requestPeriod : value['異動節次']),
      className: text(value.className || value['班級']),
      subject: text(value.subject || value['科目'])
    };
  }

  function validateTriangle(triangle, options) {
    options = options || {};
    var rawLegs = triangle && triangle.legs;
    var legs = (Array.isArray(rawLegs) ? rawLegs : []).map(function (row, index) {
      return normalizeLeg(row, index + 1);
    });
    var errors = [];
    var sources = {};
    var targets = {};
    var outgoing = {};
    var sourcePullOut = 0;
    var classNames = [];

    if (legs.length !== 3) errors.push('三角調必須正好包含三條交換關係');

    legs.forEach(function (leg) {
      var source = teacherKey(leg.sourceTeacher);
      var target = teacherKey(leg.targetTeacher);
      if (!source) errors.push('第' + leg.index + '條缺少來源教師');
      if (!target) errors.push('第' + leg.index + '條缺少目標教師');
      if (source && target && source === target) errors.push('來源教師與目標教師不可相同');
      if (source && sources[source]) errors.push('同一位教師不可提供兩堂原課');
      if (target && targets[target]) errors.push('同一位教師不可接收兩個目標時段');
      if (source) {
        sources[source] = leg;
        outgoing[source] = leg;
      }
      if (target) targets[target] = leg;
      if (!leg.sourceSlot.date || !leg.sourceSlot.date.match(/^\d{4}-\d{2}-\d{2}$/)
          || leg.sourceSlot.period === null) {
        errors.push('第' + leg.index + '條來源課堂日期／節次無效');
      }
      if (!leg.targetSlot.date || !leg.targetSlot.date.match(/^\d{4}-\d{2}-\d{2}$/)
          || leg.targetSlot.period === null) {
        errors.push('第' + leg.index + '條目標課堂日期／節次無效');
      }
      if (!isUsableCourse(leg.sourceCourse)) errors.push('第' + leg.index + '條來源課堂不是有效一般課程');
      if (!isUsableCourse(leg.targetCourse)) errors.push('第' + leg.index + '條目標課堂不是有效一般課程');
      if (isPullOutCourse(leg.sourceCourse)) sourcePullOut++;
      classNames.push(leg.sourceCourse.className, leg.targetCourse.className);
    });

    if (Object.keys(sources).length === 3 && Object.keys(targets).length === 3) {
      var classReference = classNames.find(function (name) { return text(name) !== ''; }) || '';
      if (!classReference || classNames.some(function (name) {
        return text(name) !== '' && !sameClass(classReference, name);
      })) {
        errors.push('三角調三條原課必須屬於同一班');
      }
      Object.keys(sources).forEach(function (key) {
        if (!targets[key]) errors.push('三角調三位教師必須形成閉環');
      });
      Object.keys(targets).forEach(function (key) {
        if (!sources[key]) errors.push('目標教師必須同時提供一堂原課');
      });
      legs.forEach(function (leg) {
        var next = outgoing[teacherKey(leg.targetTeacher)];
        if (!next || !sameSlot(leg.targetSlot, next.sourceSlot)) {
          errors.push('第' + leg.index + '條的目標課堂必須是目標教師提供的原課');
        }
        if (next && leg.targetCourse.className && next.sourceCourse.className
            && (leg.targetCourse.className !== next.sourceCourse.className
              || leg.targetCourse.subject !== next.sourceCourse.subject)) {
          errors.push('三角調的目標課堂班級／科目與教師原課不一致');
        }
      });
    }

    if (sourcePullOut > 0 && sourcePullOut < legs.length) {
      errors.push('抽離課只能三堂全部為抽離課，不能與一般課混調');
    }

    var assignments = buildFinalAssignments(legs);
    var conflicts = [];
    assignments.forEach(function (assignment) {
      var sourceKey = slotKey(assignment.removeSlot);
      var targetKey = slotKey(assignment.addSlot);
      var finalBySlot = {};
      occupiedFor(options, assignment.teacher).map(normalizeOccupied).forEach(function (occupied) {
        if (!occupied.date || occupied.period === null) return;
        var key = slotKey(occupied);
        if (key !== sourceKey) finalBySlot[key] = occupied;
      });
      if (targetKey && targetKey !== sourceKey && finalBySlot[targetKey]) {
        conflicts.push({
          teacher: assignment.teacher,
          slot: Object.assign({}, assignment.addSlot),
          existing: finalBySlot[targetKey]
        });
      }
    });
    if (conflicts.length) errors.push('完整三角交換後仍有教師最終時段衝堂');

    var uniqueErrors = [];
    errors.forEach(function (error) {
      if (uniqueErrors.indexOf(error) === -1) uniqueErrors.push(error);
    });
    return {
      ok: uniqueErrors.length === 0,
      errors: uniqueErrors,
      legs: legs,
      assignments: assignments,
      conflicts: conflicts
    };
  }

  return {
    TRIANGLE_TYPE: TRIANGLE_TYPE,
    normalizeSlot: normalizeSlot,
    normalizeCourse: normalizeCourse,
    normalizeLeg: normalizeLeg,
    slotKey: slotKey,
    sameSlot: sameSlot,
    isPatrolCourse: isPatrolCourse,
    isPullOutCourse: isPullOutCourse,
    sameClass: sameClass,
    isUsableCourse: isUsableCourse,
    buildCycleLegs: buildCycleLegs,
    buildFinalAssignments: buildFinalAssignments,
    validateTriangle: validateTriangle
  };
})();
