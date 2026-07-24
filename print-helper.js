/**
 * 學校調代課線上系統 - 列印輔助模組 (print-helper.js)
 * 還原：建成國中調代課通知單（週課表雙聯 A5 橫向 A4）
 */

/** 對調路線圖（畫面與列印共用結構） */
function buildExchangeRouteHtml(opts) {
  const nameA = opts.nameA || '';
  const nameB = opts.nameB || '';
  const dateA = opts.dateA || '';
  const dateB = opts.dateB || '';
  const dayA = opts.dayA || '';
  const dayB = opts.dayB || '';
  const periodA = opts.periodA || '';
  const periodB = opts.periodB || '';
  const classA = opts.classA || '';
  const classB = opts.classB || '';
  const subjectA = opts.subjectA || '';
  const subjectB = opts.subjectB || '';
  const compact = !!opts.compact;

  const slotA = [dayA ? `週${dayA}` : '', periodA ? `第${periodA}節` : ''].filter(Boolean).join(' ');
  const slotB = [dayB ? `週${dayB}` : '', periodB ? `第${periodB}節` : ''].filter(Boolean).join(' ');
  const metaA = [classA, subjectA].filter(Boolean).join(' ');
  const metaB = [classB, subjectB].filter(Boolean).join(' ');

  const pad = compact ? '6px 8px' : '8px 10px';
  const fontTitle = compact ? '0.8rem' : '0.85rem';
  const fontMeta = compact ? '0.68rem' : '0.72rem';

  return `
    <div class="exchange-route" style="border:1px solid #cbd5e1;border-radius:8px;padding:${pad};background:#f8fafc;margin:6px 0 8px;">
      <div style="font-size:${fontMeta};font-weight:700;color:#64748b;margin-bottom:6px;">對調路線</div>
      <div style="display:flex;align-items:stretch;gap:8px;">
        <div style="flex:1;min-width:0;border:1px solid #e2e8f0;border-radius:6px;padding:6px 8px;background:#fff;">
          <div style="font-size:${fontTitle};font-weight:700;color:#0f172a;">${nameA}</div>
          <div style="font-size:${fontMeta};color:#334155;margin-top:2px;">${slotA}${dateA ? '　' + dateA : ''}</div>
          <div style="font-size:${fontMeta};color:#64748b;margin-top:1px;">${metaA}</div>
        </div>
        <div style="flex-shrink:0;display:flex;align-items:center;font-weight:700;color:#475569;font-size:1rem;">⇄</div>
        <div style="flex:1;min-width:0;border:1px solid #e2e8f0;border-radius:6px;padding:6px 8px;background:#fff;">
          <div style="font-size:${fontTitle};font-weight:700;color:#0f172a;">${nameB}</div>
          <div style="font-size:${fontMeta};color:#334155;margin-top:2px;">${slotB}${dateB ? '　' + dateB : ''}</div>
          <div style="font-size:${fontMeta};color:#64748b;margin-top:1px;">${metaB}</div>
        </div>
      </div>
    </div>
  `;
}

function generateFormHtml(g, currentType, ctx) {
  const getTeacherNameByEmail = ctx.getTeacherNameByEmail;
  const getTeacherSubjectByEmail = ctx.getTeacherSubjectByEmail;
  const getWeekDayText = ctx.getWeekDayText;
  const getPeriodChinese = (p) => {
    const n = parseInt(p, 10);
    if (n === 45) return '午休';
    return ['', '第一節', '第二節', '第三節', '第四節', '第五節', '第六節', '第七節', '第八節'][n] || String(p);
  };
  const printPeriodList = (window.DateUtils && window.DateUtils.getTimetablePeriods)
    ? window.DateUtils.getTimetablePeriods()
    : [1, 2, 3, 4, 5, 6, 7, 8];
  const reprintClass = g.isReprint ? 'is-reprint' : '';

  const getOriginalSubject = (rec) => {
    if (!rec) return '';
    // 紀錄本身的 subject 即該節有效課（含調入後寫入）；缺才回退基礎課表
    if (rec.subject) return rec.subject;
    if (!rec.date || !ctx.allSchedules || !ctx.allSchedules.value) return '';
    const day = new Date(String(rec.date).replace(/-/g, '/')).getDay();
    const dayNum = day === 0 ? 7 : day;
    const em = String(rec.originalTeacherEmail || '').toLowerCase();
    const p = parseInt(rec.period, 10);
    const sched = ctx.allSchedules.value.find(s =>
      s.teacherEmail && String(s.teacherEmail).toLowerCase() === em &&
      parseInt(s.dayOfWeek, 10) === dayNum &&
      parseInt(s.period, 10) === p
    );
    return sched ? (sched.subject || '') : '';
  };

  if (g.isExchange) {
    const rec1 = g.records[0];
    const rec2 = g.records[1] || rec1;
    const teacherAName = getTeacherNameByEmail(rec1.originalTeacherEmail);
    const teacherBName = getTeacherNameByEmail(rec2.originalTeacherEmail);
    const serialText = [...new Set(g.serials)].join(', ');

    let titleLabel = '';
    let descHtml = '';
    let remarkHtml = '';

    if (currentType === 'Teacher') {
      // 教師聯：只標受邀／對方教師（對調顯示 B 師）
    titleLabel = `教師聯 (給 ${teacherBName} 老師)`;
      descHtml = `
        <div style="line-height: 1.3; font-size: 0.75rem; color: #1e293b;">
          <strong>${teacherAName}</strong> 老師與 <strong>${teacherBName}</strong> 老師，因 <strong>${g.reason || '其他'}</strong> 進行課堂對調：
          <ul style="margin: 2px 0; padding-left: 14px;">
            <li>${rec1.date} 第 ${rec1.period} 節【${rec1.className}】 改由 <strong>${teacherBName}</strong> 老師上課（${rec1.subject}）。</li>
            <li>${rec2.date} 第 ${rec2.period} 節【${rec2.className}】 改由 <strong>${teacherAName}</strong> 老師上課（${rec2.subject}）。</li>
          </ul>
        </div>
      `;
      remarkHtml = `
        <li>請兩位教師確實向對方交代班級上課進度與常規要求。</li>
        <li>實際上課教師請確實於該班教室日誌上簽章。</li>
      `;
    } else if (currentType === 'Class') {
      titleLabel = '班級聯 (貼於教室日誌)';
      descHtml = `
        <div style="line-height: 1.3; font-size: 0.75rem; color: #1e293b;">
          <strong>${teacherAName}</strong> 老師與 <strong>${teacherBName}</strong> 老師，因 <strong>${g.reason || '其他'}</strong> 進行課堂對調：
          <ul style="margin: 2px 0; padding-left: 14px;">
            <li>${rec1.date} 第 ${rec1.period} 節【${rec1.className}】 改由 <strong>${teacherBName}</strong> 老師上課（${rec1.subject}）。</li>
            <li>${rec2.date} 第 ${rec2.period} 節【${rec2.className}】 改由 <strong>${teacherAName}</strong> 老師上課（${rec2.subject}）。</li>
          </ul>
        </div>
      `;
      remarkHtml = `
        <li>請學藝股長將此通知單貼於教室日誌旁備查。</li>
        <li>實際上課老師請確實於教室日誌上簽章。</li>
      `;
    } else {
      titleLabel = '教學組留存聯';
      descHtml = `
        <div style="line-height: 1.3; font-size: 0.75rem; color: #1e293b;">
          <strong>${teacherAName}</strong> 老師與 <strong>${teacherBName}</strong> 老師，因 <strong>${g.reason || '其他'}</strong> 進行課堂對調：
          <ul style="margin: 2px 0; padding-left: 14px;">
            <li>${rec1.date} 第 ${rec1.period} 節【${rec1.className}】 改由 <strong>${teacherBName}</strong> 老師上課（${rec1.subject}）。</li>
            <li>${rec2.date} 第 ${rec2.period} 節【${rec2.className}】 改由 <strong>${teacherAName}</strong> 老師上課（${rec2.subject}）。</li>
          </ul>
          <span style="font-size: 0.7rem; color: #64748b;">* 行政備註：${g.note || '無'}</span>
        </div>
      `;
      remarkHtml = `
        <li>本聯由教學組留存歸檔核備。</li>
      `;
    }

    const days = ['一', '二', '三', '四', '五'];
    const targetDayText1 = getWeekDayText(new Date(rec1.date.replace(/-/g, '/')).getDay());
    const targetDayText2 = getWeekDayText(new Date(rec2.date.replace(/-/g, '/')).getDay());

    // 欄寬固定：節次 12% ＋ 五天各 13.6% ＋ 簽名 20% ＝ 100%
    let tableHeader = '<tr><th style="width:12%;">星期<br>節次</th>';
    days.forEach(d => {
      const isTarget1 = d === targetDayText1;
      const isTarget2 = d === targetDayText2 && targetDayText1 !== targetDayText2;
      let headerDate = '';
      if (isTarget1) headerDate = rec1.date.slice(5);
      if (isTarget2) headerDate = rec2.date.slice(5);
      tableHeader += `<th style="width:13.6%;${isTarget1 || isTarget2 ? 'background:#cbd5e1 !important;' : ''}">${headerDate}<br>${d}</th>`;
    });
    tableHeader += '<th style="width:20%; border-left: 1.5pt solid black !important;">調（代）課教師<br>簽名</th></tr>';

    let tableBody = '';
    for (let pi = 0; pi < printPeriodList.length; pi++) {
      const p = printPeriodList[pi];
      const rowStyle = p === 4 ? 'border-bottom: 2.5pt solid black !important;' : (p === 45 ? 'background:#f0fdfa !important;' : '');
      let matchTeacherName = '';
      days.forEach(d => {
        const isTarget1 = (d === targetDayText1 && p === parseInt(rec1.period, 10));
        const isTarget2 = (d === targetDayText2 && p === parseInt(rec2.period, 10));
        if (isTarget1) matchTeacherName = getTeacherNameByEmail(rec1.actualTeacherEmail);
        else if (isTarget2) matchTeacherName = getTeacherNameByEmail(rec2.actualTeacherEmail);
      });

      tableBody += '<tr' + (rowStyle ? ` style="${rowStyle}"` : '') + '>';
      tableBody += `<td style="background:#e2e8f0; font-weight:bold; text-align:center;">${getPeriodChinese(p)}</td>`;
      days.forEach(d => {
        const isTarget1 = (d === targetDayText1 && p === parseInt(rec1.period, 10));
        const isTarget2 = (d === targetDayText2 && p === parseInt(rec2.period, 10));
        let cellContent = '';
        let cellStyle = '';
        if (isTarget1) {
          cellContent = rec1.subject;
          cellStyle = 'background:#a1a1aa !important; font-weight:bold; text-align:center; font-size:0.75rem; color:#fff;';
        } else if (isTarget2) {
          cellContent = rec2.subject;
          cellStyle = 'background:#a1a1aa !important; font-weight:bold; text-align:center; font-size:0.75rem; color:#fff;';
        }
        tableBody += `<td style="${cellStyle}">${cellContent}</td>`;
      });
      const sigStyle = matchTeacherName ? 'font-weight:600; font-size:0.75rem; text-align:center; vertical-align:middle; background:#f1f5f9;' : '';
      tableBody += `<td rowspan="2" style="border-left:1.5pt solid black !important; text-align:center; vertical-align:middle; ${sigStyle} ${rowStyle}">${matchTeacherName || ''}</td>`;
      tableBody += '</tr>';

      tableBody += '<tr>';
      tableBody += `<td style="background:#e2e8f0; font-weight:bold; text-align:center; border-bottom: 1.5pt solid black !important;">班級</td>`;
      days.forEach(d => {
        const isTarget1 = (d === targetDayText1 && p === parseInt(rec1.period));
        const isTarget2 = (d === targetDayText2 && p === parseInt(rec2.period));
        let cellContent = '';
        let cellStyle = '';
        if (isTarget1) {
          cellContent = rec1.className;
          cellStyle = 'background:#a1a1aa !important; font-weight:bold; text-align:center; font-size:0.75rem; color:#fff;';
        } else if (isTarget2) {
          cellContent = rec2.className;
          cellStyle = 'background:#a1a1aa !important; font-weight:bold; text-align:center; font-size:0.75rem; color:#fff;';
        }
        tableBody += `<td style="${cellStyle} border-bottom: 1.5pt solid black !important;">${cellContent}</td>`;
      });
      tableBody += '</tr>';
    }

    return `
      <div class="substitute-form ${reprintClass}">
        <div class="form-top-row">
          <span class="form-tag">${titleLabel}</span>
          <span class="lesson-code">單號：${serialText}</span>
        </div>
        <div class="header-block">
          <h1 class="title">建成國中調代課通知單</h1>
        </div>
        <div class="info-row">
          <span>班級：${[...new Set([rec1.className, rec2.className])].join(', ')}</span>
          <span>教師：${teacherAName} ⇄ ${teacherBName}</span>
        </div>
        <table class="schedule-table"><thead>${tableHeader}</thead><tbody>${tableBody}</tbody></table>
        <div class="footer-block">
          <div class="desc" style="margin-bottom:4px;">${descHtml}</div>
          <div class="remark-area">
            <span style="font-weight:bold;">※ 備註說明：</span>
            <ol class="remark-list">${remarkHtml.split('\n').filter(x => x.trim()).map(x => `<li>${x.replace(/<\/?li>/g, '')}</li>`).join('')}</ol>
          </div>
        </div>
      </div>
    `;
  }

  // --- 普通代課通知單 ---
  const serialText = (g.serials || []).join(', ');
  const leaveNames = (g.leaveEmails || [g.leaveEmail]).map(e => getTeacherNameByEmail(e)).join('、');
  const subName = getTeacherNameByEmail(g.subEmail);
  const reasonsStr = (g.reasons || [g.reason]).join('、');

  let remarkHtml = '';
  let descHtml = '';
  let titleLabel = '';

  // 班級聯可能跨多位代課老師：逐節顯示代課人
  // 教師聯／班級聯：不顯示假別、費用（僅教學組留存聯保留）
  const periodListHtml = (g.periods || []).map(p => {
    const subT = p.subEmail ? getTeacherNameByEmail(p.subEmail) : subName;
    const leaveT = getTeacherNameByEmail(p.leaveEmail);
    const showFeeReason = currentType === 'Admin';
    if (currentType === 'Class' && p.subEmail) {
      return showFeeReason
        ? `<li>${(p.date || '').toString().slice(5)} 第 ${p.num} 節【${p.cls}】(${p.sub}) – ${leaveT}→<strong>${subT}</strong>（${p.reason}，${p.subFee}）</li>`
        : `<li>${(p.date || '').toString().slice(5)} 第 ${p.num} 節【${p.cls}】(${p.sub}) – ${leaveT}→<strong>${subT}</strong></li>`;
    }
    return showFeeReason
      ? `<li>第 ${p.num} 節【${p.cls}】(${p.sub}) – ${leaveT}（${p.reason}，${p.subFee}）</li>`
      : `<li>第 ${p.num} 節【${p.cls}】(${p.sub}) – ${leaveT}</li>`;
  }).join('');

  const isQuotaDeductFee = (f) => {
    const s = String(f || '');
    return s === '扣額度' || s === '互代不結';
  };
  const isMutualCover = isQuotaDeductFee(g.subFee)
    || (g.periods || []).some(p => isQuotaDeductFee(p.subFee));
  const multiSubNames = [...new Set((g.periods || []).map(p => p.subEmail).filter(Boolean).map(e => getTeacherNameByEmail(e)))];
  const subNamesStr = multiSubNames.length > 1 ? multiSubNames.join('、') : subName;

  if (currentType === 'Teacher') {
    // 教師聯：只給「對方／代課教師」；不顯示假別、費用
    titleLabel = `教師聯 (給 ${subName} 老師)`;
    // 事由不一定是請假（公假／活動／課務異動等）
    const reasonBrief = (reasonsStr && reasonsStr !== '—' && reasonsStr !== '請假')
      ? `因 <strong>${reasonsStr}</strong>，`
      : '';
    descHtml = `<div style="line-height: 1.3; font-size: 0.75rem; color: #1e293b;"><strong>${leaveNames}</strong> 老師${reasonBrief}由 <strong>${subName}</strong> 老師代課。共計 <strong>${g.periods.length}</strong> 節：<ul style="margin:2px 0 0 14px;padding:0;">${periodListHtml}</ul></div>`;
    remarkHtml = `
      <li>若屬請假，請原任課教師上校務系統完成請假程序。</li>
      <li>實際上課老師請確實於教室日誌上簽名。</li>
      <li>請原任課教師向代課教師轉達各班上課進度。</li>
    `;
  } else if (currentType === 'Class') {
    // 班級聯：不顯示假別、費用、摘要句（僅節次清單）
    titleLabel = '班級聯 (貼於教室日誌)';
    descHtml = `<div style="line-height: 1.3; font-size: 0.75rem; color: #1e293b;"><ul style="margin:2px 0 0 14px;padding:0;">${periodListHtml}</ul></div>`;
    remarkHtml = `
      <li>請學藝股長確實將此通知單貼於教室日誌旁備查。</li>
      <li>實際上課老師請確實於教室日誌上簽章。</li>
    `;
  } else {
    titleLabel = '教學組留存聯';
    if (isMutualCover) {
      descHtml = `<div style="line-height: 1.3; font-size: 0.75rem; color: #1e293b;"><strong>${leaveNames}</strong> 老師因 <strong>${reasonsStr}</strong>（活動互代），由 <strong>${subName}</strong> 老師代課。<strong style="color:#6b21a8;">經費：扣額度</strong>。共 <strong>${g.periods.length}</strong> 節：<ul style="margin:2px 0 0 14px;padding:0;">${periodListHtml}</ul><br><span style="font-size:0.7rem; color:#64748b;">* 行政備註：${g.note || '無'}</span></div>`;
    } else {
      descHtml = `<div style="line-height: 1.3; font-size: 0.75rem; color: #1e293b;"><strong>${leaveNames}</strong> 老師因 <strong>${reasonsStr}</strong>，由 <strong>${subName}</strong> 老師代課。經費來源：<strong>${g.subFee}</strong>。共 <strong>${g.periods.length}</strong> 節：<ul style="margin:2px 0 0 14px;padding:0;">${periodListHtml}</ul><br><span style="font-size:0.7rem; color:#64748b;">* 行政備註：${g.note || '無'}</span></div>`;
    }
    remarkHtml = `
      <li>本聯由教學組存查核帳。</li>
      ${isMutualCover ? '<li>扣額度：不計入代課費與請假扣減鐘點，並扣代課老師折抵額度。</li>' : ''}
    `;
  }

  const days = ['一', '二', '三', '四', '五'];
  const dayIdx = ['日', '一', '二', '三', '四', '五', '六'];
  // 欄寬固定：節次 12% ＋ 五天各 13.6% ＋ 簽名 20% ＝ 100%
  let tableHeader = '<tr><th style="width:12%;">星期<br>節次</th>';
  days.forEach(d => {
    const periodOnDay = g.periods.find(x => dayIdx[new Date(x.date + 'T00:00:00').getDay()] === d);
    const headerDate = periodOnDay ? periodOnDay.date.slice(5) : '';
    const hasPeriod = !!periodOnDay;
    tableHeader += `<th style="width:13.6%;${hasPeriod ? 'background:#bfdbfe !important;' : ''}">${headerDate}<br>${d}</th>`;
  });
  tableHeader += '<th style="width:20%; border-left: 1.5pt solid black !important;">調（代）課教師<br>簽名</th></tr>';

  let tableBody = '';
  for (let pi = 0; pi < printPeriodList.length; pi++) {
    const p = printPeriodList[pi];
    const rowStyle = p === 4 ? 'border-bottom: 2.5pt solid black !important;' : '';
    tableBody += '<tr>';
    tableBody += `<td style="background:#f8fafc; font-weight:bold; text-align:center;">${getPeriodChinese(p)}</td>`;
    days.forEach(d => {
      const matchPeriod = g.periods.find(x => parseInt(x.num, 10) === parseInt(p, 10) && dayIdx[new Date(x.date + 'T00:00:00').getDay()] === d);
      let cellContent = '';
      let cellStyle = '';
      if (matchPeriod) {
        cellContent = matchPeriod.sub;
        cellStyle = 'background:#fef08a !important; font-weight:bold; text-align:center; font-size:0.75rem;';
      }
      tableBody += `<td style="${cellStyle}">${cellContent}</td>`;
    });
    const hasAnyPeriod = g.periods.some(x => x.num === p);
    const sigStyle = hasAnyPeriod ? 'font-weight:600; font-size:0.75rem; text-align:center; vertical-align:middle; background:#fcffef;' : '';
    tableBody += `<td rowspan="2" style="border-left:1.5pt solid black !important; text-align:center; vertical-align:middle; ${sigStyle} ${rowStyle}">${hasAnyPeriod ? subName : ''}</td>`;
    tableBody += '</tr>';

    tableBody += '<tr>';
    tableBody += `<td style="background:#f8fafc; font-weight:bold; text-align:center; border-bottom: 1.5pt solid black !important;">班級</td>`;
    days.forEach(d => {
      const matchPeriod = g.periods.find(x => x.num === p && dayIdx[new Date(x.date + 'T00:00:00').getDay()] === d);
      let cellContent = '';
      let cellStyle = '';
      if (matchPeriod) {
        cellContent = matchPeriod.cls;
        cellStyle = 'background:#fef08a !important; font-weight:bold; text-align:center; font-size:0.75rem;';
      }
      tableBody += `<td style="${cellStyle} border-bottom: 1.5pt solid black !important;">${cellContent}</td>`;
    });
    tableBody += '</tr>';
  }

  return `
    <div class="substitute-form ${reprintClass}">
      <div class="form-top-row">
        <span class="form-tag">${titleLabel}</span>
        <span class="lesson-code">單號：${serialText}</span>
      </div>
      <div class="header-block">
        <h1 class="title">建成國中調代課通知單</h1>
      </div>
      <div class="info-row">
        <span>班級：${[...new Set(g.periods.map(x => x.cls))].join('、')}</span>
        <span>${currentType === 'Teacher' ? `共 ${g.periods.length} 節 | ${leaveNames} ➔ ${subNamesStr}` : `共 ${g.periods.length} 節`}</span>
      </div>
      <table class="schedule-table"><thead>${tableHeader}</thead><tbody>${tableBody}</tbody></table>
      <div class="footer-block">
        <div class="desc" style="margin-bottom:4px;">${descHtml}</div>
        <div class="remark-area">
          <span style="font-weight:bold;">※ 備註說明：</span>
          <ol class="remark-list">${remarkHtml.split('\n').filter(x => x.trim()).map(x => `<li>${x.replace(/<\/?li>/g, '')}</li>`).join('')}</ol>
        </div>
      </div>
    </div>
  `;
}

/** 申請單 ID：requestId 優先，否則剝掉 _1/_2 */
function resolvePrintRequestId(r) {
  if (!r) return '';
  if (r.requestId != null && String(r.requestId).trim() !== '') return String(r.requestId).trim();
  return String(r.id || '').replace(/_[12]$/, '');
}

function isPrintExchangeRec(r) {
  if (!r) return false;
  const t = String(r.type || '');
  if (t === 'exchange' || t === '對調') return true;
  // 後備：id 為 xxx_1 / xxx_2 且有對調特徵
  return /_[12]$/.test(String(r.id || '')) && !!(r.targetDate || r.targetPeriod);
}

/**
 * 代課紀錄合併：
 * - 教師聯：同一「被代課教師」合併
 * - 班級聯：同一「班級」合併（產版面時再切）
 * 調課仍依 requestId 一組（勿因 requestId 空而併成 exc_undefined）
 */
function buildPrintGroups(recordsToPrint, allSubs) {
  const groups = {};
  recordsToPrint.forEach(r => {
    const rReason = r.reason || '請假';
    if (isPrintExchangeRec(r)) {
      const rid = resolvePrintRequestId(r);
      // 每筆調課必須獨立 key；rid 空時用 id 避免多筆互併
      const key = rid ? ('exc_' + rid) : ('exc_id_' + String(r.id || Math.random()));
      if (!groups[key]) {
        groups[key] = {
          isExchange: true,
          requestId: rid || r.id,
          serials: [r.serial],
          isReprint: r.printed,
          note: r.note || '',
          reason: rReason,
          records: [r]
        };
      } else {
        if (!groups[key].records.some(x => x.id === r.id)) {
          groups[key].records.push(r);
          groups[key].serials.push(r.serial);
        }
        if (r.printed) groups[key].isReprint = true;
      }
    } else {
      // 教師聯合併鍵：代課老師（actual）
      const subKey = String(r.actualTeacherEmail || '').toLowerCase();
      const rid = resolvePrintRequestId(r);
      const key = 'sub_' + (subKey || rid || r.id);
      if (!groups[key]) {
        groups[key] = {
          isExchange: false,
          serials: [r.serial],
          leaveEmails: [r.originalTeacherEmail],
          subEmail: r.actualTeacherEmail,
          date: r.date,
          dates: [r.date],
          reasons: [rReason],
          subFee: r.subFee || '自費代課',
          note: r.note || '',
          periods: [],
          isReprint: r.printed
        };
      } else {
        if (r.serial && !groups[key].serials.includes(r.serial)) groups[key].serials.push(r.serial);
        if (!groups[key].leaveEmails.includes(r.originalTeacherEmail)) groups[key].leaveEmails.push(r.originalTeacherEmail);
        if (!groups[key].dates.includes(r.date)) groups[key].dates.push(r.date);
        if (!groups[key].reasons.includes(rReason)) groups[key].reasons.push(rReason);
        if (r.printed) groups[key].isReprint = true;
      }
      groups[key].periods.push({
        date: r.date,
        num: parseInt(r.period, 10),
        cls: r.className,
        sub: r.subject,
        leaveEmail: r.originalTeacherEmail,
        reason: rReason,
        subFee: r.subFee || '自費代課'
      });
    }
  });

  const groupList = Object.values(groups);
  groupList.forEach(g => {
    if (g.isExchange) {
      if (g.records.length === 1) {
        const rid = String(g.requestId || resolvePrintRequestId(g.records[0]) || '');
        const curId = g.records[0].id;
        const match = (allSubs || []).find(function (x) {
          if (!x || x.id === curId) return false;
          const xRid = resolvePrintRequestId(x);
          if (rid && xRid && xRid === rid) return true;
          // 後備：同主 id 的 _1/_2 成對
          const base = String(curId || '').replace(/_[12]$/, '');
          const xBase = String(x.id || '').replace(/_[12]$/, '');
          return !!(base && xBase && base === xBase && /_[12]$/.test(String(x.id || '')));
        });
        if (match) {
          g.records.push(match);
          g.serials.push(match.serial);
        }
      }
      g.records.sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')) || (parseInt(a.period, 10) || 0) - (parseInt(b.period, 10) || 0));
    } else if (g.periods && g.periods.length) {
      g.periods.sort((a, b) => String(a.date).localeCompare(String(b.date)) || a.num - b.num);
      g.serials = compactSerials(g.serials);
    }
  });
  return groupList;
}

function compactSerials(serials) {
  const list = (serials || []).filter(Boolean);
  if (list.length <= 1) return list;
  const roots = {};
  list.forEach(s => {
    const m = String(s).match(/^(.*?)(?:-(\d+))?$/);
    if (!m) {
      if (!roots._raw) roots._raw = [];
      roots._raw.push(s);
      return;
    }
    const root = m[1];
    const n = m[2] ? parseInt(m[2], 10) : null;
    if (!roots[root]) roots[root] = [];
    if (n != null) roots[root].push(n);
    else roots[root].push(null);
  });
  const out = [];
  Object.keys(roots).forEach(root => {
    if (root === '_raw') {
      out.push(...roots[root]);
      return;
    }
    const nums = roots[root].filter(n => n != null).sort((a, b) => a - b);
    if (!nums.length) {
      out.push(root);
    } else if (nums.length === 1) {
      out.push(root + '-' + nums[0]);
    } else {
      out.push(root + '-' + nums[0] + '～' + nums[nums.length - 1] + '（' + nums.length + '節）');
    }
  });
  return out;
}

async function printSelectedForms(formType, ctx) {
  // 勾選可能只在 DOM：列印前從 checkbox 同步
  try {
    if (typeof document !== 'undefined') {
      const ids = [];
      document.querySelectorAll('.hist-select-cb:checked').forEach((el) => {
        const id = el.getAttribute('data-rec-id') || el.value;
        if (id) ids.push(id);
      });
      if (ids.length && ctx.selectedRecordIds) ctx.selectedRecordIds.value = ids;
    }
  } catch (eSync) { /* ignore */ }
  if (!ctx.selectedRecordIds.value.length) {
    ctx.showToast('請先勾選歷史紀錄中要列印的單據！', 'warning');
    return;
  }

  if (ctx.loading) ctx.loading.value = true;
  if (ctx.loadingMessage) ctx.loadingMessage.value = '正在整理列印資料與產生預覽頁面...';

  try {
    const recordsToPrint = ctx.substitutionRecords.value.filter(r => ctx.selectedRecordIds.value.includes(r.id));
    const groupList = buildPrintGroups(recordsToPrint, ctx.substitutionRecords.value);

    let htmlContent = '';
    const packPages = (forms) => {
      let html = '';
      for (let i = 0; i < forms.length; i += 2) {
        const left = forms[i];
        const right = forms[i + 1]
          || '<div class="substitute-form" style="border:none !important; background:none !important;"></div>';
        html += `
          <div class="print-page">
            ${left}
            <div class="cut-line"></div>
            ${right}
          </div>
        `;
      }
      return html;
    };

    // NoticeTeacher = 只印教師聯；NoticeClass = 只印班級聯；Notice = 兩者都印
    if (formType === 'Notice' || formType === 'NoticeTeacher' || formType === 'NoticeClass') {
      const wantTeacher = formType === 'Notice' || formType === 'NoticeTeacher';
      const wantClass = formType === 'Notice' || formType === 'NoticeClass';
      const teacherForms = [];
      const classForms = [];

      // 教師聯：依代課老師合併（groupList 已是 sub 分組）
      if (wantTeacher) {
        groupList.forEach(g => {
          teacherForms.push(generateFormHtml(g, 'Teacher', ctx));
        });
      }

      // 班級聯：跨代課老師，依「班級」重新合併（同班不同代課老師併一張）
      if (wantClass) {
        const classMap = {};
        // 代課：從 periods 拆
        groupList.forEach(g => {
          if (g.isExchange) {
            // 調課：每組仍各印一張班級聯（兩班可能不同）
            classForms.push(generateFormHtml(g, 'Class', ctx));
            return;
          }
          (g.periods || []).forEach(p => {
            const cls = String(p.cls || '').trim() || '—';
            if (!classMap[cls]) {
              classMap[cls] = {
                isExchange: false,
                serials: [],
                leaveEmails: [],
                subEmail: p.leaveEmail, // 班級聯可能多人代，簽名欄用多姓名
                subEmails: [],
                date: p.date,
                dates: [],
                reasons: [],
                subFee: p.subFee || g.subFee || '自費代課',
                note: g.note || '',
                periods: [],
                isReprint: !!g.isReprint
              };
            }
            const cg = classMap[cls];
            (g.serials || []).forEach(s => {
              if (s && !cg.serials.includes(s)) cg.serials.push(s);
            });
            if (p.leaveEmail && !cg.leaveEmails.includes(p.leaveEmail)) cg.leaveEmails.push(p.leaveEmail);
            if (g.subEmail && !cg.subEmails.includes(g.subEmail)) cg.subEmails.push(g.subEmail);
            if (p.date && !cg.dates.includes(p.date)) cg.dates.push(p.date);
            if (p.reason && !cg.reasons.includes(p.reason)) cg.reasons.push(p.reason);
            if (g.isReprint) cg.isReprint = true;
            cg.periods.push({
              date: p.date,
              num: p.num,
              cls: p.cls,
              sub: p.sub,
              leaveEmail: p.leaveEmail,
              reason: p.reason,
              subFee: p.subFee,
              subEmail: g.subEmail // 該節實際代課老師
            });
          });
        });
        Object.keys(classMap).sort((a, b) => a.localeCompare(b, 'zh-Hant')).forEach(cls => {
          const cg = classMap[cls];
          cg.periods.sort((a, b) => String(a.date).localeCompare(String(b.date)) || a.num - b.num);
          cg.serials = compactSerials(cg.serials);
          // 簽名／說明用：若多位代課老師，合併姓名
          if (cg.subEmails && cg.subEmails.length) {
            cg.subEmail = cg.subEmails[0];
            cg.subEmailAll = cg.subEmails;
          }
          classForms.push(generateFormHtml(cg, 'Class', ctx));
        });
      }

      // Notice（含詳情「印通知」）：教師聯＋班級聯左右成對同一張頁
      // NoticeTeacher／NoticeClass：各自批次排版
      if (wantTeacher && wantClass) {
        const paired = [];
        const maxLen = Math.max(teacherForms.length, classForms.length);
        for (let i = 0; i < maxLen; i++) {
          if (teacherForms[i]) paired.push(teacherForms[i]);
          if (classForms[i]) paired.push(classForms[i]);
        }
        htmlContent += packPages(paired);
      } else {
        if (wantTeacher) htmlContent += packPages(teacherForms);
        if (wantClass) htmlContent += packPages(classForms);
      }
      if (!htmlContent) {
        ctx.showToast('沒有可列印的內容', 'warning');
        if (ctx.loading) ctx.loading.value = false;
        return;
      }
    } else {
      for (let i = 0; i < groupList.length; i += 2) {
        const gLeft = groupList[i];
        const gRight = groupList[i + 1];
        const rightHtml = gRight
          ? generateFormHtml(gRight, 'Admin', ctx)
          : '<div class="substitute-form" style="border:none !important; background:none !important;"></div>';
        htmlContent += `
          <div class="print-page">
            ${generateFormHtml(gLeft, 'Admin', ctx)}
            <div class="cut-line"></div>
            ${rightHtml}
          </div>
        `;
      }
    }

    const printWin = window.open('', '_blank');
    if (!printWin) {
      ctx.showToast('瀏覽器封鎖了列印視窗，請允許彈出視窗後再試。', 'warning');
      if (ctx.loading) ctx.loading.value = false;
      return;
    }
    // 預覽視窗已順利開啟，主視窗即可解除轉圈圈狀態
    if (ctx.loading) ctx.loading.value = false;
    printWin.document.write(`
      <html>
      <head>
        <title>建成國中調代課通知單</title>
        <style>
          @media print {
            @page { size: A4 landscape; margin: 0; }
            html, body { margin: 0; padding: 0; background: white !important; }
          }
          body {
            background: white !important;
            color: #000 !important;
            margin: 0;
            padding: 0;
            font-family: system-ui, -apple-system, "Noto Sans TC", sans-serif;
          }
          .print-page {
            width: 297mm;
            height: 208mm;
            page-break-after: always;
            break-after: page;
            box-sizing: border-box;
            padding: 6mm 10mm;
            display: flex;
            flex-direction: row;
            justify-content: space-between;
            align-items: stretch;
            position: relative;
            background: white !important;
            -webkit-print-color-adjust: exact;
            print-color-adjust: exact;
          }
          .print-page:last-child {
            page-break-after: avoid !important;
            break-after: avoid !important;
          }
          .cut-line {
            position: absolute;
            left: 50%;
            top: 6mm;
            bottom: 6mm;
            border-left: 1.5px dotted #94a3b8;
            transform: translateX(-50%);
            z-index: 10;
          }
          .substitute-form {
            width: 133mm;
            height: 196mm;
            padding: 6mm 8mm !important;
            margin: 0 !important;
            position: relative;
            box-sizing: border-box;
            background: white !important;
            border: none !important;
            display: flex;
            flex-direction: column;
            justify-content: space-between;
            page-break-after: avoid;
          }
          .substitute-form.is-reprint::after {
            content: "補發";
            position: absolute;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%) rotate(-30deg);
            font-size: 50pt;
            color: rgba(0, 0, 0, 0.04);
            font-weight: 900;
            border: 6px solid rgba(0, 0, 0, 0.04);
            padding: 5px 20px;
            border-radius: 12px;
            z-index: 1000;
            pointer-events: none;
          }
          .form-top-row {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 2px;
          }
          .form-tag {
            font-size: 8pt;
            border: 1px solid #000;
            padding: 1px 4px;
            white-space: nowrap;
          }
          .lesson-code { font-size: 8pt; }
          .header-block { margin-top: 1px; margin-bottom: 2px; text-align: center; }
          .title {
            font-size: 14pt;
            font-weight: bold;
            border-bottom: 2px solid #000;
            padding-bottom: 4px;
            margin: 2px 0;
          }
          .info-row {
            display: flex;
            justify-content: space-between;
            margin: 6px 0;
            font-size: 11pt;
            font-weight: bold;
          }
          .schedule-table {
            width: 100%;
            table-layout: fixed;
            border-collapse: collapse;
            border: 1.5pt solid black;
            margin: 8px 0;
          }
          .schedule-table col.col-period { width: 12%; }
          .schedule-table col.col-day { width: 13.6%; }
          .schedule-table col.col-sign { width: 20%; }
          .schedule-table th, .schedule-table td {
            border: 1px solid #000;
            text-align: center;
            font-size: 9.5pt;
            height: 25px;
            padding: 3px 4px !important;
            vertical-align: middle;
            overflow: hidden;
            word-break: break-all;
          }
          .schedule-table th {
            background: #eee !important;
            height: 28px;
            font-size: 10pt;
          }
          .footer-block { font-size: 9pt; line-height: 1.35; }
          .remark-list { margin: 2px 0 0 0; padding-left: 15px; }
          .remark-list li { font-size: 8.5pt; }
        </style>
      </head>
      <body style="background: white !important;">
        ${htmlContent}
        <script>
          window.onload = function() {
            setTimeout(function() {
              window.print();
              window.close();
            }, 500);
          }
        <\/script>
      </body>
      </html>
    `);
    printWin.document.close();

    const idsToMark = new Set(ctx.selectedRecordIds.value);
    ctx.selectedRecordIds.value.forEach(id => {
      const rec = ctx.substitutionRecords.value.find(r => r.id === id);
      if (rec && rec.type === 'exchange' && rec.requestId) {
        const peer = ctx.substitutionRecords.value.find(r => r.requestId === rec.requestId && r.id !== id);
        if (peer) idsToMark.add(peer.id);
      }
    });
    const markIds = Array.from(idsToMark);
    // G：本地已印（陣列替換觸發 Vue 更新），不再整包 loadWeeklyData
    if (typeof ctx.markLocalPrinted === 'function') {
      ctx.markLocalPrinted(markIds);
    } else {
      markIds.forEach(id => {
        const rec = ctx.substitutionRecords.value.find(r => r.id === id);
        if (rec) rec.printed = true;
        const reqId = String(id).replace(/_[12]$/, '');
        if (ctx.requestsList && ctx.requestsList.value) {
          const req = ctx.requestsList.value.find(r => r.id === reqId);
          if (req) req.printed = true;
        }
      });
    }
    ctx.selectedRecordIds.value = [];

    // 背景寫入 GAS，失敗不擋畫面
    ctx.callGasApi('batchMarkPrinted', { ids: markIds })
      .catch(err => console.error('背景標記列印出錯：', err));
  } catch (err) {
    ctx.showToast('列印失敗：' + (err.message || err), 'error');
    console.error('列印出錯：', err);
  } finally {
    if (ctx.loading) ctx.loading.value = false;
  }
}

window.generateFormHtml = generateFormHtml;
window.printSelectedForms = printSelectedForms;
window.buildExchangeRouteHtml = buildExchangeRouteHtml;
