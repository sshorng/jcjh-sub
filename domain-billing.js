/**
 * 大鐘點／代課費領域邏輯（純函式）
 * 1～7：超鐘／代課費一軌
 * 第8節：獨立「誰上誰拿」（空堂事件日該班不發）
 */
window.DomainBilling = (function () {
  var FEE_REGULAR = 455;
  /** 1～7 超鐘點費（元／節）；與公代費同額，若校內不同請改此常數 */
  var FEE_OVERTIME = 455;
  var FEE_8TH = 500;

  function getWeekKey(dateStr) {
    var d = new Date(String(dateStr).replace(/-/g, '/'));
    var dow = d.getDay();
    var monday = new Date(d);
    monday.setDate(d.getDate() - (dow === 0 ? 6 : dow - 1));
    return monday.toISOString().slice(0, 10);
  }

  function toLocalDateStr(d) {
    var y = d.getFullYear();
    var m = String(d.getMonth() + 1).padStart(2, '0');
    var day = String(d.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + day;
  }

  /** 結算月內週一～五日期（含跨月補班日若在該月） */
  function listWeekdaysInMonth(reportMonth) {
    if (!reportMonth || !/^\d{4}-\d{2}$/.test(reportMonth)) return [];
    var parts = reportMonth.split('-');
    var y = parseInt(parts[0], 10);
    var mo = parseInt(parts[1], 10) - 1;
    var out = [];
    var d = new Date(y, mo, 1);
    while (d.getMonth() === mo) {
      var dow = d.getDay();
      if (dow >= 1 && dow <= 5) out.push(toLocalDateStr(d));
      d.setDate(d.getDate() + 1);
    }
    return out;
  }

  function emailKey(em) {
    return String(em || '').toLowerCase().trim();
  }

  /**
   * 是否計入「每週排課鐘點」
   * - 節次：1–7 或 午休 45
   * - 屬性：基本／一般／兼課／抽離（空屬性視同一般）
   * - 不含：巡堂、第8、輔導（第8）、單雙週輔導
   */
  function isWeeklyHoursSlot(s) {
    if (!s) return false;
    var p = parseInt(s.period, 10);
    var isLunch = p === 45 || (window.DateUtils && window.DateUtils.isLunchPeriod
      && window.DateUtils.isLunchPeriod(s.period));
    if (!(isLunch || (p >= 1 && p <= 7))) return false;
    var a = String(s.attr || '').trim();
    if (!a || a === '一般' || a === '基本' || a === '兼課' || a === '抽離') return true;
    // 舊匯入可能寫「實支」仍計（與有課同）
    if (a === '實支') return true;
    return false;
  }

  /** 請假／代課是否落在「週鐘點節次」（1–7 或午休） */
  function isWeeklyHoursPeriod(period) {
    var p = parseInt(period, 10);
    if (p === 45) return true;
    if (window.DateUtils && window.DateUtils.isLunchPeriod && window.DateUtils.isLunchPeriod(period)) return true;
    return p >= 1 && p <= 7;
  }

  /** 日期 → 課表星期（1=一…7=日） */
  function dayOfWeekFromDate(dateStr) {
    var d = new Date(String(dateStr || '').replace(/-/g, '/'));
    if (Number.isNaN(d.getTime())) return 0;
    var wd = d.getDay(); // 0日…6六
    return wd === 0 ? 7 : wd;
  }

  /**
   * 請假那堂是否為「兼課」屬性（對照基礎課表：原任＋星期＋節次＋班級）
   * 公費代課僅在原堂為兼課時才沖自己超鐘
   */
  function isConcurrentLeaveSlot(rec, allSchedules) {
    if (!rec) return false;
    var em = emailKey(rec.originalTeacherEmail);
    if (!em) return false;
    var p = parseInt(rec.period, 10);
    if (!p) return false;
    var dow = dayOfWeekFromDate(rec.date);
    if (!dow) return false;
    var cn = String(rec.className || '').trim();
    var list = allSchedules || [];
    var i;
    var hitAny = false;
    for (i = 0; i < list.length; i++) {
      var s = list[i];
      if (!s) continue;
      if (emailKey(s.teacherEmail) !== em) continue;
      if (parseInt(s.dayOfWeek, 10) !== dow) continue;
      if (parseInt(s.period, 10) !== p) continue;
      var scn = String(s.className || '').trim();
      if (cn && scn && scn !== cn && scn.indexOf(cn) < 0 && cn.indexOf(scn) < 0) continue;
      hitAny = true;
      if (String(s.attr || '').trim() === '兼課') return true;
    }
    // 找不到課表列：不當兼課（不沖超鐘）
    return false;
  }

  /**
   * 第8節：有上有拿、沒上沒拿、誰上誰拿
   * - 空堂事件（keep／reduce 皆）當日該班第8 → 不發
   * - 有異動：以 substitution 紀錄的 actualTeacher 為準（代課入）
   * - 無異動且非空堂：原課表任課教師（單／雙週依 isSingleWeek）
   * - 抽離不計
   */
  function buildPeriod8Payout(opts) {
    opts = opts || {};
    var reportMonth = opts.reportMonth;
    var allSchedules = opts.allSchedules || [];
    var substitutionRecords = opts.substitutionRecords || [];
    var classAwayEvents = opts.classAwayEvents || [];
    var semesterEndDate = opts.semesterEndDate || '';
    var getTeacherNameByEmail = opts.getTeacherNameByEmail || function (e) { return e; };
    var isSingleWeek = opts.isSingleWeek || function () { return true; };

    var details = [];
    if (!reportMonth) {
      return { details: [], byEmail: {}, FEE_8TH: FEE_8TH };
    }

    var startDay = reportMonth + '-01';
    var endDay = reportMonth + '-31';
    var weekdays = listWeekdaysInMonth(reportMonth);

    var DCA = window.DomainClassAway;
    function isAway(className, dateStr) {
      if (!DCA || !DCA.isClassAwayOnDate) return false;
      return !!DCA.isClassAwayOnDate(className, dateStr, classAwayEvents, semesterEndDate);
    }

    function pickBaseSched(email, dayOfWeek, dateStr) {
      var em = emailKey(email);
      var cands = allSchedules.filter(function (s) {
        return emailKey(s.teacherEmail) === em &&
          parseInt(s.dayOfWeek, 10) === parseInt(dayOfWeek, 10) &&
          parseInt(s.period, 10) === 8;
      });
      if (!cands.length) return null;
      var base = cands.find(function (s) {
        var a = s.attr || '';
        if (!a || a === '一般' || a === '輔導' || a === '基本') return true;
        if (a === '單週' && isSingleWeek(dateStr)) return true;
        if (a === '雙週' && !isSingleWeek(dateStr)) return true;
        return false;
      }) || cands[0];
      if (!base) return null;
      if (base.attr === '單週' && !isSingleWeek(dateStr)) return null;
      if (base.attr === '雙週' && isSingleWeek(dateStr)) return null;
      if (base.attr === '抽離') return null;
      return base;
    }

    // 當日第8 異動：key = date|class → record（優先代課／調入）
    var subByDateClass = {};
    (substitutionRecords || []).forEach(function (r) {
      if (!r || !r.date) return;
      if (r.date < startDay || r.date > endDay) return;
      if (parseInt(r.period, 10) !== 8) return;
      if (r.type && r.type !== 'substitution' && r.type !== '代課' && r.type !== 'exchange' && r.type !== '對調') {
        return;
      }
      var cls = String(r.className || '').trim();
      if (!cls) return;
      var key = r.date + '|' + cls;
      // 後寫覆蓋前寫；通常一班一節一筆
      subByDateClass[key] = r;
    });

    // 掃每位有第8課表的教師 × 當月平日
    var teachersWithP8 = {};
    allSchedules.forEach(function (s) {
      if (parseInt(s.period, 10) !== 8) return;
      if (!s.teacherEmail) return;
      teachersWithP8[emailKey(s.teacherEmail)] = s.teacherEmail;
    });

    weekdays.forEach(function (dateStr) {
      var d = new Date(String(dateStr).replace(/-/g, '/'));
      var dayOfWeek = d.getDay(); // 1–5
      if (dayOfWeek < 1 || dayOfWeek > 5) return;

      Object.keys(teachersWithP8).forEach(function (em) {
        var email = teachersWithP8[em];
        var base = pickBaseSched(email, dayOfWeek, dateStr);
        if (!base) return;
        var className = String(base.className || '').trim();
        if (!className) return;

        // 空堂事件（颱風／畢旅 keep 等）：該班第8 不發
        if (isAway(className, dateStr)) {
          details.push({
            date: dateStr,
            period: 8,
            className: className,
            subject: base.subject || '輔導',
            originalEmail: email,
            originalName: getTeacherNameByEmail(email),
            actualEmail: '',
            actualName: '',
            source: 'away',
            fee: 0,
            note: '空堂事件／未上課'
          });
          return;
        }

        var subKey = dateStr + '|' + className;
        var sub = subByDateClass[subKey];
        var actualEmail = email;
        var source = 'own';
        if (sub && sub.actualTeacherEmail) {
          // 調出／代出：原任不拿；實際任課人拿
          if (emailKey(sub.originalTeacherEmail) === em && emailKey(sub.actualTeacherEmail) !== em) {
            // 這格是「原任被代走」→ 原任這條不發，改由 actual 在掃到他課表或下面補
            // 若 original 的課被代走，original 不應因 own 拿錢
            actualEmail = sub.actualTeacherEmail;
            source = (sub.type === 'exchange' || sub.type === '對調') ? 'exchange' : 'sub';
          } else if (emailKey(sub.actualTeacherEmail) === em) {
            actualEmail = email;
            source = (sub.type === 'exchange' || sub.type === '對調') ? 'exchange_in' : 'sub_in';
          }
        }

        // 原任被代走：不發（由代課人列一筆）
        if (sub && emailKey(sub.originalTeacherEmail) === em &&
            emailKey(sub.actualTeacherEmail) && emailKey(sub.actualTeacherEmail) !== em) {
          // 代課人可能沒有第8基礎課表，在此直接記給代課人
          details.push({
            date: dateStr,
            period: 8,
            className: className,
            subject: sub.subject || base.subject || '輔導',
            originalEmail: email,
            originalName: getTeacherNameByEmail(email),
            actualEmail: sub.actualTeacherEmail,
            actualName: getTeacherNameByEmail(sub.actualTeacherEmail),
            source: (sub.type === 'exchange' || sub.type === '對調') ? 'exchange' : 'sub',
            fee: FEE_8TH,
            note: '代課／調入'
          });
          return;
        }

        details.push({
          date: dateStr,
          period: 8,
          className: className,
          subject: base.subject || '輔導',
          originalEmail: email,
          originalName: getTeacherNameByEmail(email),
          actualEmail: actualEmail,
          actualName: getTeacherNameByEmail(actualEmail),
          source: source,
          fee: FEE_8TH,
          note: source === 'own' ? '原課上課' : '代課／調入'
        });
      });
    });

    // 防重：同 date|class|actual 只留一筆
    var seen = {};
    var uniq = [];
    details.forEach(function (row) {
      if (!row.actualEmail || !row.fee) {
        // 保留 away 明細供對帳，但不計入 byEmail
        if (row.source === 'away') uniq.push(row);
        return;
      }
      var k = row.date + '|' + row.className + '|' + emailKey(row.actualEmail);
      if (seen[k]) return;
      seen[k] = 1;
      uniq.push(row);
    });

    var byEmail = {};
    uniq.forEach(function (row) {
      if (!row.actualEmail || !row.fee) return;
      var em = emailKey(row.actualEmail);
      if (!byEmail[em]) {
        byEmail[em] = { email: row.actualEmail, count: 0, fee: 0, details: [] };
      }
      byEmail[em].count += 1;
      byEmail[em].fee += row.fee;
      byEmail[em].details.push(row);
    });

    return { details: uniq, byEmail: byEmail, FEE_8TH: FEE_8TH };
  }

  /**
   * @param {object} opts
   */
  function buildMonthlyReportRows(opts) {
    var teachers = opts.teachers || [];
    var allSchedules = opts.allSchedules || [];
    var reportMonth = opts.reportMonth;
    var reportWeeksCount = opts.reportWeeksCount || 4;
    var getTeacherNameByEmail = opts.getTeacherNameByEmail || function (e) { return e; };
    var classAwayEvents = opts.classAwayEvents || [];
    var semesterEndDate = opts.semesterEndDate || '';
    var isSingleWeek = opts.isSingleWeek || function () { return true; };

    if (!reportMonth || teachers.length === 0) return [];

    var startDay = reportMonth + '-01';
    var endDay = reportMonth + '-31';
    var monthlyRecords = (opts.substitutionRecords || []).filter(function (r) {
      return r.date >= startDay && r.date <= endDay;
    });

    // 第8節獨立結算
    var p8 = buildPeriod8Payout({
      reportMonth: reportMonth,
      allSchedules: allSchedules,
      substitutionRecords: monthlyRecords,
      classAwayEvents: classAwayEvents,
      semesterEndDate: semesterEndDate,
      getTeacherNameByEmail: getTeacherNameByEmail,
      isSingleWeek: isSingleWeek
    });

    return teachers.map(function (t) {
      var email = t.email;
      var em = emailKey(email);
      var baseHours = (t.baseHours === 0 || t.baseHours === '0')
        ? 0
        : (parseInt(t.baseHours, 10) || 16);

      // 週鐘點：1–7＋午休(45)；基本／一般／兼課／抽離皆計；巡堂／第8／輔導單雙週不算
      var weeklyPeriods = allSchedules.filter(function (s) {
        return emailKey(s.teacherEmail) === em && isWeeklyHoursSlot(s);
      }).length;
      var reduceDeduction = 0;
      if (window.DomainClassAway && classAwayEvents.length) {
        reduceDeduction = window.DomainClassAway.computeReduceDeduction({
          teacherEmail: email,
          allSchedules: allSchedules,
          events: classAwayEvents,
          semesterEndDate: semesterEndDate,
          reportMonth: reportMonth,
          reportWeeksCount: reportWeeksCount
        }) || 0;
      }
      var weeklyOvertime = Math.max(0, weeklyPeriods - baseHours);

      // 1～7＋午休 請假／代課（不含第8）
      var leaveRecords = monthlyRecords.filter(function (r) {
        return r.originalTeacherEmail === email && r.type === 'substitution' && isWeeklyHoursPeriod(r.period);
      });
      var selfPaidDeduction = leaveRecords.filter(function (r) {
        return r.subFee === '自費代課';
      }).length;
      // 全部公費請假（學校仍付代課費）
      var pubLeaveRecords = leaveRecords.filter(function (r) {
        return r.subFee === '公費代課' || r.subFee === '學校移撥';
      });
      var pubLeaveCount = pubLeaveRecords.length;
      // 公費扣超鐘：僅原堂屬性為「兼課」才沖自己超時
      var pubConcurrentLeaveRecords = pubLeaveRecords.filter(function (r) {
        return isConcurrentLeaveSlot(r, allSchedules);
      });

      var selfPaidByWeek = {};
      leaveRecords.filter(function (r) { return r.subFee === '自費代課'; }).forEach(function (r) {
        var wk = getWeekKey(r.date);
        selfPaidByWeek[wk] = (selfPaidByWeek[wk] || 0) + 1;
      });
      var pubByWeek = {};
      pubConcurrentLeaveRecords.forEach(function (r) {
        var wk = getWeekKey(r.date);
        pubByWeek[wk] = (pubByWeek[wk] || 0) + 1;
      });

      var allWeeks = {};
      Object.keys(selfPaidByWeek).forEach(function (k) { allWeeks[k] = 1; });
      Object.keys(pubByWeek).forEach(function (k) { allWeeks[k] = 1; });
      var publicOvertimeUsed = 0;
      Object.keys(allWeeks).forEach(function (wk) {
        var selfInWeek = selfPaidByWeek[wk] || 0;
        var pubInWeek = pubByWeek[wk] || 0;
        var remaining = Math.max(0, weeklyOvertime - selfInWeek);
        publicOvertimeUsed += Math.min(remaining, pubInWeek);
      });
      // 學校公付節數：全部公費請假 − 已沖超鐘（兼課公費）的部分
      var schoolPublicPayout = Math.max(0, pubLeaveCount - publicOvertimeUsed);

      var pubSubRecords = monthlyRecords.filter(function (r) {
        if (r.actualTeacherEmail !== email || r.type !== 'substitution' || !isWeeklyHoursPeriod(r.period)) return false;
        if (window.DomainActivityCover && window.DomainActivityCover.isPublicSubPayout) {
          return window.DomainActivityCover.isPublicSubPayout(r.subFee);
        }
        return r.subFee === '公費代課' || r.subFee === '學校移撥' || r.subFee === '活動公費';
      });
      var pubSubCount = pubSubRecords.length;
      var selfPaidSubRecords = monthlyRecords.filter(function (r) {
        return r.actualTeacherEmail === email && r.type === 'substitution' && isWeeklyHoursPeriod(r.period) && r.subFee === '自費代課';
      });
      var selfSubCount = selfPaidSubRecords.length;
      var selfSubFee = selfSubCount * FEE_REGULAR;
      var selfSubDetail = selfSubCount > 0
        ? selfPaidSubRecords.map(function (r) {
          return getTeacherNameByEmail(r.originalTeacherEmail) + '(' + r.date.slice(-5) + ')';
        }).join(', ')
        : '無';

      // 允許負數：無超鐘卻自費請假 → 實得超時／超鐘點費為負，提醒自付代課費
      var actualOvertime = (weeklyOvertime * reportWeeksCount) - reduceDeduction - selfPaidDeduction - publicOvertimeUsed;
      var overtimeFee = actualOvertime * FEE_OVERTIME;
      var pubSubFee = pubSubCount * FEE_REGULAR;

      var p8row = p8.byEmail[em] || { count: 0, fee: 0, details: [] };

      return {
        email: email,
        name: t.name,
        subject: t.subject,
        weeklyPeriods: weeklyPeriods,
        baseHours: baseHours,
        weeklyOvertime: weeklyOvertime,
        reduceDeduction: reduceDeduction,
        selfPaidDeduction: selfPaidDeduction,
        publicOvertimeUsed: publicOvertimeUsed,
        schoolPublicPayout: schoolPublicPayout,
        pubSubCount: pubSubCount,
        pubSubFee: pubSubFee,
        selfSubCount: selfSubCount,
        selfSubFee: selfSubFee,
        selfSubDetail: selfSubDetail,
        actualOvertime: actualOvertime,
        overtimeFee: overtimeFee,
        // 第8節：誰上誰拿（獨立）
        period8SubCount: p8row.count,
        period8Fee: p8row.fee,
        period8Details: p8row.details || []
      };
    });
  }

  function toExcelRows(reportRows) {
    return (reportRows || []).map(function (row) {
      return {
        "教師姓名": row.name,
        "學科": row.subject,
        "每週排課(1-7+午休)": row.weeklyPeriods,
        "基本授課鐘點": row.baseHours,
        "預設超時/週": row.weeklyOvertime,
        "空堂調降(1-7)": row.reduceDeduction || 0,
        "代課扣減(自費1-7)": row.selfPaidDeduction,
        "代課扣減(公費1-7)": row.publicOvertimeUsed,
        "本月實得超時節數(1-7)": row.actualOvertime,
        "超鐘點費(1-7)": row.overtimeFee,
        "我去代課(公費節數1-7)": row.pubSubCount,
        "我去代課(公費費1-7)": row.pubSubFee,
        "我去代課(自費節數1-7)": row.selfSubCount,
        "我去代課(自費費1-7)": row.selfSubFee,
        "我去代課(自費明細1-7)": row.selfSubDetail,
        "第8節實際上課節數": row.period8SubCount,
        "第8節費(500元/節)": row.period8Fee
      };
    });
  }

  /** 第8節明細（匯出用） */
  function toPeriod8ExcelRows(opts) {
    var p8 = buildPeriod8Payout(opts);
    return (p8.details || []).filter(function (r) {
      return r.fee > 0 || r.source === 'away';
    }).map(function (r) {
      return {
        "日期": r.date,
        "節次": 8,
        "班級": r.className,
        "科目": r.subject,
        "原任課": r.originalName || r.originalEmail,
        "實際上課": r.actualName || (r.source === 'away' ? '（空堂未上）' : ''),
        "來源": r.note || r.source,
        "金額": r.fee
      };
    });
  }

  /**
   * 產出幹事備查專用之「月度代課代導費逐筆清冊」工作表資料
   * 含「YYY.MM 公付」與「YYY.MM 自付」兩張工作表
   */
  function buildSubFeeExcelWorkbook(opts) {
    var reportMonth = opts.reportMonth || '';
    var substitutionRecords = opts.substitutionRecords || [];
    var getTeacherNameByEmail = opts.getTeacherNameByEmail || function (e) { return e || ''; };

    var year = parseInt(reportMonth.slice(0, 4), 10);
    var month = parseInt(reportMonth.slice(5, 7), 10);
    if (isNaN(year) || isNaN(month)) {
      var now = new Date();
      year = now.getFullYear();
      month = now.getMonth() + 1;
    }

    var rocYear = year - 1911;
    var monthStr = String(month).padStart(2, '0');
    var rocAcademicYear = month >= 8 ? rocYear : (rocYear - 1);
    var semesterText = month >= 8 ? '一' : '二';
    var title = rocAcademicYear + '學年度第' + semesterText + '學期' + month + '月份課務一覽表';

    var sheetNamePub = rocYear + '.' + monthStr + ' 公付';
    var sheetNameSelf = rocYear + '.' + monthStr + ' 自付';

    var monthPrefix = year + '-' + monthStr;
    var monthRecords = (substitutionRecords || []).filter(function (r) {
      if (!r || !r.date) return false;
      var fee = String(r.subFee || '').trim();
      if (fee === '扣額度' || fee === '互代不結' || fee === '第8節代課') return false;
      var p = r.period != null ? Number(r.period) : NaN;
      if (p === 8 || String(r.period).trim() === '8') return false;
      var rDate = String(r.date).replace(/\//g, '-');
      return rDate.indexOf(monthPrefix) === 0;
    });

    function getOrigTeacherName(r) {
      var origName = r.originalTeacherName || getTeacherNameByEmail(r.originalTeacherEmail) || '';
      var isHomeroom = r.className === '代導' || r.subject === '代導' || r.type === 'homeroom';
      if (isHomeroom) {
        if (!origName || origName === '導師') {
          var cls = (r.className !== '代導' ? r.className : '').replace('導師', '');
          origName = cls ? (cls + '導師') : '導師';
        }
      }
      return origName || '其他';
    }

    monthRecords.sort(function (a, b) {
      var na = getOrigTeacherName(a);
      var nb = getOrigTeacherName(b);
      if (na !== nb) return na.localeCompare(nb, 'zh-Hant');
      var da = String(a.date || '');
      var db = String(b.date || '');
      if (da !== db) return da.localeCompare(db);
      var pa = a.period == null ? 0 : Number(a.period);
      var pb = b.period == null ? 0 : Number(b.period);
      return pa - pb;
    });

    function isPublic(r) {
      var fee = String(r.subFee || '').trim();
      var reason = String(r.reason || '').trim();
      if (fee === '公費代課' || fee === '學校移撥' || fee === '活動公費' || fee === '公費' || fee === '代課費') {
        return true;
      }
      if (fee === '自費代課' || fee === '自費') {
        return false;
      }
      if (reason.indexOf('公假自理') >= 0 || reason.indexOf('事假') >= 0 || reason.indexOf('病假') >= 0 || reason.indexOf('補休') >= 0) {
        return false;
      }
      if (reason.indexOf('公假') >= 0 || reason.indexOf('婚假') >= 0 || reason.indexOf('喪假') >= 0 || reason.indexOf('產前假') >= 0 || reason.indexOf('分娩假') >= 0 || reason.indexOf('身心調適假') >= 0) {
        return true;
      }
      return true;
    }

    var dayMap = ['(日)', '(一)', '(二)', '(三)', '(四)', '(五)', '(六)'];
    function formatRocDate(dateStr) {
      if (!dateStr) return '';
      var clean = String(dateStr).split('T')[0].replace(/\//g, '-');
      var parts = clean.split('-');
      if (parts.length < 3) return dateStr;
      var y = parseInt(parts[0], 10) - 1911;
      var m = parts[1];
      var d = parts[2];
      var dt = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
      var dw = !isNaN(dt.getTime()) ? dayMap[dt.getDay()] : '';
      return y + '.' + m + '.' + d + dw;
    }

    function formatPeriodChinese(p) {
      if (p === null || p === undefined || p === '' || p === '代導') return '';
      var pStr = String(p).trim();
      var map = { '1': '一', '2': '二', '3': '三', '4': '四', '5': '五', '6': '六', '7': '七', '8': '八', '0': '午休' };
      if (map[pStr]) return map[pStr];
      return pStr;
    }

    var pubRecords = [];
    var selfRecords = [];
    monthRecords.forEach(function (r) {
      if (isPublic(r)) pubRecords.push(r);
      else selfRecords.push(r);
    });

    function buildAoa(records) {
      var aoa = [];
      aoa.push([title, null, null, null, null, null, null, null]);
      aoa.push(['請假\n教師', '假別', '請假\n日期', '請假\n時間', '課務\n(班級-課程)', '節次', '代課\n教師', '合計\n節數']);

      var groups = [];
      var groupMap = {};
      records.forEach(function (r) {
        var origName = r.originalTeacherName || getTeacherNameByEmail(r.originalTeacherEmail) || '';
        var isHomeroom = r.className === '代導' || r.subject === '代導' || r.type === 'homeroom';
        if (isHomeroom) {
          if (!origName || origName === '導師') {
            var cls = (r.className !== '代導' ? r.className : '').replace('導師', '');
            origName = cls ? (cls + '導師') : '導師';
          }
        }
        var reason = r.reason || r.subFee || '';
        var dateRoc = formatRocDate(r.date);
        var timeStr = r.leaveTime || r.timeRange || (isHomeroom ? '08:00-16:00' : '08:00-16:00');
        var gKey = (r.requestId || '') + '_' + origName + '_' + reason + '_' + dateRoc + '_' + timeStr;
        if (!groupMap[gKey]) {
          groupMap[gKey] = [];
          groups.push(groupMap[gKey]);
        }
        groupMap[gKey].push({
          origName: origName,
          reason: reason,
          dateRoc: dateRoc,
          timeStr: timeStr,
          raw: r,
          isHomeroom: isHomeroom
        });
      });

      groups.forEach(function (grp) {
        grp.forEach(function (item, idx) {
          var r = item.raw;
          var courseStr = '';
          var periodStr = '';
          if (item.isHomeroom) {
            courseStr = '代導';
            periodStr = '';
          } else {
            var cls = r.className || '';
            var subj = r.subject || '';
            var note = r.note ? '(' + r.note + ')' : '';
            courseStr = cls + subj + note;
            periodStr = formatPeriodChinese(r.period);
          }
          var actualName = r.actualTeacherName || getTeacherNameByEmail(r.actualTeacherEmail) || r.actualTeacherEmail || '';
          var count = typeof r.periodCount === 'number' ? r.periodCount : (item.isHomeroom ? 0.8 : 1);

          if (idx === 0) {
            aoa.push([item.origName, item.reason, item.dateRoc, item.timeStr, courseStr, periodStr, actualName, count]);
          } else {
            aoa.push(['', '', '', '', courseStr, periodStr, actualName, count]);
          }
        });
      });

      return aoa;
    }

    return {
      title: title,
      sheetNamePub: sheetNamePub,
      sheetNameSelf: sheetNameSelf,
      pubAoa: buildAoa(pubRecords),
      selfAoa: buildAoa(selfRecords)
    };
  }

  return {
    FEE_REGULAR: FEE_REGULAR,
    FEE_OVERTIME: FEE_OVERTIME,
    FEE_8TH: FEE_8TH,
    getWeekKey: getWeekKey,
    listWeekdaysInMonth: listWeekdaysInMonth,
    isWeeklyHoursSlot: isWeeklyHoursSlot,
    isWeeklyHoursPeriod: isWeeklyHoursPeriod,
    buildPeriod8Payout: buildPeriod8Payout,
    buildMonthlyReportRows: buildMonthlyReportRows,
    toExcelRows: toExcelRows,
    toPeriod8ExcelRows: toPeriod8ExcelRows,
    buildSubFeeExcelWorkbook: buildSubFeeExcelWorkbook
  };
})();
