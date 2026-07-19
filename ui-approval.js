/**
 * ui-approval.js — 簽核／行政核准／撤回撤銷（方案甲殼瘦身 A）
 * 對外：window.UiApproval.create(deps)
 */
window.UiApproval = (function () {
  function create(deps) {
    var ref = deps.ref;
    var callGasApi = deps.callGasApi;
    var callGasApiWithProgress = deps.callGasApiWithProgress || deps.callGasApi;
    var showToast = deps.showToast;
    var showConfirm = deps.showConfirm;
    var loading = deps.loading;
    var loadingMessage = deps.loadingMessage;
    var getStatusText = deps.getStatusText;
    var restoreMutualQuotaForRows = deps.restoreMutualQuotaForRows || function () {};
    var optimisticPatchRequestStatus = deps.optimisticPatchRequestStatus;
    var softRefreshInBackground = deps.softRefreshInBackground || function () {};
    var formatRequestSummary = deps.formatRequestSummary || function () { return ''; };
    var formatApproveBatchRiskSummary = deps.formatApproveBatchRiskSummary || function () { return ''; };
    var getApproveRiskFlags = deps.getApproveRiskFlags || function () { return []; };
    var printSelectedForms = deps.printSelectedForms;
    var applyClassViewFromUrl = deps.applyClassViewFromUrl || function () { return false; };
    var resolvePendingClassView = deps.resolvePendingClassView || function () {};

    var mySentRequests = deps.mySentRequests;
    var myPendingRequests = deps.myPendingRequests;
    var adminPendingRequests = deps.adminPendingRequests;
    var allPendingRequests = deps.allPendingRequests;
    var requestsList = deps.requestsList;
    var paginatedAdminPending = deps.paginatedAdminPending;
    var selectedRecordIds = deps.selectedRecordIds;
    var activeTab = deps.activeTab;
    var showDetailModal = deps.showDetailModal;
    var detailRequest = deps.detailRequest;
    var detailSubRecord = deps.detailSubRecord;

    var selectedAdminPendingIds = ref([]);
    var lastBatchPrintIds = ref([]);
    var showBatchPrintPrompt = ref(false);

    function findRequestById(id) {
      return mySentRequests.value.find(function (r) { return r.id === id; }) ||
        myPendingRequests.value.find(function (r) { return r.id === id; }) ||
        adminPendingRequests.value.find(function (r) { return r.id === id; }) ||
        allPendingRequests.value.find(function (r) { return r.id === id; }) ||
        requestsList.value.find(function (r) { return r.id === id; });
    }

    function isAdminPendingSelected(id) {
      // DOM 優先（避免每列讀 ref 觸發依賴追蹤抖動）
      try {
        var el = document.querySelector('.admin-select-cb[data-req-id="' + String(id) + '"]');
        if (el) return !!el.checked;
      } catch (e) { /* ignore */ }
      return selectedAdminPendingIds.value.indexOf(id) >= 0;
    }

    function readAdminCheckedIds() {
      var ids = [];
      try {
        document.querySelectorAll('.admin-select-cb:checked').forEach(function (el) {
          var id = el.getAttribute('data-req-id') || el.value;
          if (id) ids.push(id);
        });
      } catch (e) { /* ignore */ }
      return ids;
    }

    function syncAdminSelectionFromDom() {
      selectedAdminPendingIds.value = readAdminCheckedIds();
    }

    function toggleAdminPendingSelect(id) {
      // 相容舊呼叫：改 DOM 再同步
      try {
        var el = document.querySelector('.admin-select-cb[data-req-id="' + String(id) + '"]');
        if (el) el.checked = !el.checked;
      } catch (e) { /* ignore */ }
      syncAdminSelectionFromDom();
    }

    function toggleSelectAllAdminPending(evt) {
      var on = true;
      if (evt && evt.target) on = !!evt.target.checked;
      else {
        // 無 event：依目前是否全勾反轉
        var boxes = document.querySelectorAll('.admin-select-cb');
        var allOn = boxes.length > 0;
        boxes.forEach(function (el) { if (!el.checked) allOn = false; });
        on = !allOn;
      }
      try {
        document.querySelectorAll('.admin-select-cb').forEach(function (el) {
          el.checked = on;
        });
        var allBox = document.querySelector('.admin-select-all');
        if (allBox) allBox.checked = on;
      } catch (e) { /* ignore */ }
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(syncAdminSelectionFromDom);
      } else {
        syncAdminSelectionFromDom();
      }
    }

    function clearAdminPendingSelection() {
      try {
        document.querySelectorAll('.admin-select-cb, .admin-select-all').forEach(function (el) {
          el.checked = false;
        });
      } catch (e) { /* ignore */ }
      selectedAdminPendingIds.value = [];
    }

    // 單勾：原生已亮；延後同步 ref（按鈕 disabled 用）
    if (typeof document !== 'undefined') {
      document.addEventListener('change', function (evt) {
        var t = evt && evt.target;
        if (!t || !t.classList) return;
        if (t.classList.contains('admin-select-cb')) {
          if (typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(syncAdminSelectionFromDom);
          } else {
            syncAdminSelectionFromDom();
          }
        }
      }, true);
    }

    async function checkUrlCallback(currentUser) {
      var urlParams = new URLSearchParams(window.location.search);
      var action = urlParams.get('action');
      var id = urlParams.get('id');
      var respStatus = urlParams.get('status');
      var batchId = urlParams.get('batchId');

      if (applyClassViewFromUrl()) {
        resolvePendingClassView();
      }

      if (action === 'respondBatch' && batchId && respStatus) {
        loading.value = true;
        loadingMessage.value = '正在批次簽核回應中...';
        try {
          await respondToBatch(batchId, respStatus === 'agree' ? 'agree' : 'decline');
        } catch (e) {
          console.error('批次簽核連結出錯：', e);
          showToast('批次簽核失敗，請登入系統手動處理！', 'error');
        } finally {
          if (window.location.search) {
            // 清 query 但保留 hash（分頁位置 #records 等）
            window.history.replaceState({}, document.title, window.location.pathname + (window.location.hash || ''));
          }
          loading.value = false;
        }
        return;
      }

      if (action === 'respond' && id && respStatus) {
        loading.value = true;
        loadingMessage.value = '正在通過信件進行線上簽核回應中...';
        try {
          var email = currentUser.email.toLowerCase();
          var req = findRequestById(id);
          if (!req) {
            showToast('⚠️ 找不到該申請單，或資料庫尚未同步完成！', 'warning');
          } else if (String(req.targetTeacherEmail || '').toLowerCase() !== email) {
            showToast(
              '⚠️ 簽核失敗！此簽核連結限由 ' + req.targetTeacherName +
              ' 老師點選。您目前登入的帳號是：' + email,
              'error'
            );
          } else if (req.status !== 'pending_teacher') {
            showToast(
              '⚠️ 此申請單目前狀態為【' + getStatusText(req.status) + '】，無法重複回應。',
              'warning'
            );
          } else {
            var status = respStatus === 'agree' ? 'agree' : 'decline';
            await callGasApi('respondToRequest', { requestId: id, response: status });
            showToast(
              respStatus === 'agree'
                ? '🎉 您已成功【同意】此調代課邀請，目前已送交教學組核准出單。'
                : '已拒絕此項調代課邀請。',
              'success'
            );
            optimisticPatchRequestStatus(id, respStatus === 'agree' ? 'pending_admin' : 'rejected');
            if (respStatus !== 'agree') restoreMutualQuotaForRows(req);
            softRefreshInBackground({ delay: 2800 });
          }
        } catch (e) {
          console.error('線上信件簽核出錯：', e);
          showToast('簽核失敗，請登入系統手動處理！', 'error');
        } finally {
          if (window.location.search) {
            window.history.replaceState({}, document.title, window.location.pathname + (window.location.hash || ''));
          }
          loading.value = false;
        }
      }
    }

    async function respondToRequest(id, respStatus) {
      loading.value = true;
      loadingMessage.value = '正在處理簽核回應...';
      try {
        var req = findRequestById(id);
        if (!req) {
          showToast('⚠️ 找不到該申請單，請重新整理後再試！', 'warning');
          return;
        }
        if (req.status !== 'pending_teacher') {
          showToast(
            '⚠️ 此申請單目前狀態為【' + getStatusText(req.status) + '】，無法重複回應。',
            'warning'
          );
          return;
        }
        var status = respStatus === 'agree' ? 'agree' : 'decline';
        await callGasApi('respondToRequest', { requestId: id, response: status });
        showToast(
          respStatus === 'agree'
            ? '🎉 您已成功【同意】此調代課邀請，目前已送交教學組核准出單。'
            : '已拒絕此項調代課邀請。',
          'success'
        );
        optimisticPatchRequestStatus(id, respStatus === 'agree' ? 'pending_admin' : 'rejected');
        if (respStatus !== 'agree') restoreMutualQuotaForRows(req);
        // 畫面已更新；延後輕量對齊即可
        softRefreshInBackground({ delay: 2800 });
      } catch (e) {
        console.error('簽核出錯：', e);
        showToast('簽核失敗：' + (e && e.message ? e.message : String(e)), 'error');
      } finally {
        loading.value = false;
      }
    }

    async function respondToBatch(batchId, respStatus) {
      if (!batchId) {
        showToast('缺少批次ID', 'warning');
        return;
      }
      var status = respStatus === 'agree' ? 'agree' : 'decline';
      loading.value = true;
      loadingMessage.value = status === 'agree' ? '正在全部同意…' : '正在全部拒絕…';
      try {
        var res = await callGasApi('respondToBatch', { batchId: batchId, response: status });
        var n = (res && res.count) || 0;
        var newStatus = status === 'agree' ? 'pending_admin' : 'rejected';
        var batchPeers = (requestsList.value || []).filter(function (r) {
          return r.batchId === batchId && r.status === 'pending_teacher';
        });
        batchPeers.forEach(function (r) {
          optimisticPatchRequestStatus(r.id, newStatus);
        });
        if (status !== 'agree') restoreMutualQuotaForRows(batchPeers);
        showToast(
          status === 'agree'
            ? '🎉 已全部同意共 ' + (n || '多') + ' 節，已送交教學組核准。'
            : '已全部拒絕共 ' + (n || '多') + ' 節。',
          'success'
        );
        softRefreshInBackground({ delay: 2500 });
      } catch (e) {
        console.error('批次簽核失敗：', e);
        showToast('批次簽核失敗：' + (e && e.message ? e.message : String(e)), 'error');
        throw e;
      } finally {
        loading.value = false;
      }
    }

    async function adminApprove(id, opts) {
      opts = opts || {};
      var silent = !!opts.skipConfirm;
      var req = findRequestById(id);
      if (!req) {
        showToast('找不到此申請單', 'error');
        return;
      }
      var approveNote = '';
      if (!opts.skipConfirm) {
        var riskLine = '';
        try {
          var flags = getApproveRiskFlags(req) || [];
          if (flags.length) {
            riskLine = '\n\n⚠ 風險黃燈：' + flags.map(function (f) { return f.label; }).join('、');
          }
        } catch (eF) { /* ignore */ }
        var result = await showConfirm(
          formatRequestSummary(req) + riskLine + '\n\n請再次核對後按「確認」出單。',
          '核准前核對',
          { withNote: true, notePlaceholder: '行政備註（選填）' }
        );
        if (!result || !result.ok) return;
        approveNote = result.note || '';
      }
      if (!silent) {
        loading.value = true;
        loadingMessage.value = '核准生效並寫入臨時異動中...';
      }
      try {
        var isExchange = req.type === 'exchange';
        var finalNote = approveNote || req.note || '';
        await callGasApi('adminApprove', { requestId: id, note: finalNote });
        if (!silent) showToast('核准成功，異動已寫入課表！', 'success');
        optimisticPatchRequestStatus(id, 'approved');
        if (opts.collectPrintIds) {
          if (isExchange) {
            opts.collectPrintIds.push(id + '_1');
            opts.collectPrintIds.push(id + '_2');
          } else {
            opts.collectPrintIds.push(id);
          }
        }
        // 批次核准：只在 batch 結束打一次；單筆延後對齊
        // 核准後課表異動：用 requestsOnly（含已核准列），勿只拉 pending
        if (!opts.skipSoftRefresh) softRefreshInBackground({ delay: 2800, requestsOnly: true });
      } catch (e) {
        console.error('核准出單失敗：', e);
        if (!silent) showToast('核准失敗：' + e.message, 'error');
        throw e;
      } finally {
        if (!silent) loading.value = false;
      }
    }

    async function adminReject(id, opts) {
      opts = opts || {};
      var silent = !!opts.skipConfirm;
      var req = findRequestById(id);
      if (!req) {
        showToast('找不到此申請單', 'error');
        return;
      }
      if (!opts.skipConfirm) {
        var ok = await showConfirm(
          formatRequestSummary(req) + '\n\n確定要駁回此申請嗎？',
          '駁回前核對'
        );
        if (!ok) return;
      }
      if (!silent) loading.value = true;
      try {
        await callGasApi('adminReject', { requestId: id });
        showToast('已駁回此申請單。', 'info');
        restoreMutualQuotaForRows(req);
        optimisticPatchRequestStatus(id, 'admin_rejected');
        if (!opts.skipSoftRefresh) softRefreshInBackground({ delay: 2800 });
      } catch (e) {
        console.error(e);
        if (!silent) showToast('駁回失敗：' + e.message, 'error');
        throw e;
      } finally {
        if (!silent) loading.value = false;
      }
    }

    async function batchAdminApprove() {
      // 勾選可能只在 DOM
      try { syncAdminSelectionFromDom(); } catch (eS) { /* ignore */ }
      var ids = selectedAdminPendingIds.value.slice();
      if (!ids.length) {
        showToast('請先勾選要核准的申請單', 'warning');
        return;
      }
      var preview = ids.slice(0, 8).map(function (id) {
        var r = findRequestById(id);
        if (!r) return '• ' + id;
        var flags = [];
        try { flags = (getApproveRiskFlags(r) || []).map(function (f) { return f.label; }); } catch (eG) { /* ignore */ }
        return '• ' + (r.serial || id) + ' ' + r.requesterName + '→' + r.targetTeacherName +
          ' ' + r.requestDate + '第' + r.requestPeriod + '節' +
          (flags.length ? ' ⚠' + flags.join('/') : '');
      }).join('\n');
      var more = ids.length > 8 ? '\n…另有 ' + (ids.length - 8) + ' 筆' : '';
      var riskBlock = '';
      try { riskBlock = formatApproveBatchRiskSummary(ids) || ''; } catch (eR) { /* ignore */ }
      if (!await showConfirm(
        '即將批次核准 ' + ids.length + ' 筆：\n' + preview + more + riskBlock + '\n\n確定全部出單？',
        '批次核准'
      )) return;
      loading.value = true;
      loadingMessage.value = '批次核准中（' + ids.length + ' 筆，請稍候）…';
      var ok = 0;
      var fail = 0;
      var printIds = [];
      try {
        // 後端一次讀表 + 一次 saveRows；失敗則回退逐筆
        var res = await callGasApiWithProgress(
          'adminApproveBatch',
          { requestIds: ids },
          '批次核准 ' + ids.length + ' 筆'
        );
        var doneIds = (res && res.ids) || ids;
        ok = (res && res.count) || doneIds.length;
        doneIds.forEach(function (id) {
          optimisticPatchRequestStatus(id, 'approved');
          var r = findRequestById(id);
          if (r && (r.type === 'exchange' || r.type === '對調')) {
            printIds.push(id + '_1');
            printIds.push(id + '_2');
          } else {
            printIds.push(id);
          }
        });
        if (res && res.missing) fail = res.missing;
      } catch (batchE) {
        console.warn('adminApproveBatch 失敗，回退逐筆：', batchE);
        for (var i = 0; i < ids.length; i++) {
          loadingMessage.value = '批次核准中 ' + (i + 1) + '/' + ids.length + '...';
          try {
            await adminApprove(ids[i], {
              skipConfirm: true,
              collectPrintIds: printIds,
              skipSoftRefresh: true
            });
            ok++;
          } catch (e) {
            fail++;
            console.error(e);
          }
        }
      }
      clearAdminPendingSelection();
      loading.value = false;
      showToast(
        '批次核准完成：成功 ' + ok + ' 筆' + (fail ? '，失敗／缺 ' + fail + ' 筆' : ''),
        fail ? 'warning' : 'success'
      );
      // 整批只對齊一次（核准＝課表異動）
      if (ok > 0) softRefreshInBackground({ delay: 1200, requestsOnly: true });
      if (ok > 0 && printIds.length > 0) {
        lastBatchPrintIds.value = printIds;
        showBatchPrintPrompt.value = true;
      }
    }

    async function printLastBatchNotices() {
      if (!lastBatchPrintIds.value.length) {
        showToast('沒有可列印的批次紀錄', 'warning');
        return;
      }
      selectedRecordIds.value = lastBatchPrintIds.value.slice();
      showBatchPrintPrompt.value = false;
      activeTab.value = 'records';
      await printSelectedForms('Notice');
    }

    function dismissBatchPrintPrompt() {
      showBatchPrintPrompt.value = false;
    }

    async function batchAdminReject() {
      try { syncAdminSelectionFromDom(); } catch (eS) { /* ignore */ }
      var ids = selectedAdminPendingIds.value.slice();
      if (!ids.length) {
        showToast('請先勾選要駁回的申請單', 'warning');
        return;
      }
      if (!await showConfirm('即將批次駁回 ' + ids.length + ' 筆申請，確定？', '批次駁回')) return;
      loading.value = true;
      var ok = 0;
      var fail = 0;
      try {
        var res = await callGasApi('adminRejectBatch', { requestIds: ids });
        var doneIds = (res && res.ids) || ids;
        ok = (res && res.count) || doneIds.length;
        doneIds.forEach(function (id) {
          var r = findRequestById(id);
          if (r) restoreMutualQuotaForRows(r);
          optimisticPatchRequestStatus(id, 'admin_rejected');
        });
        if (res && res.missing) fail = res.missing;
      } catch (batchE) {
        console.warn('adminRejectBatch 失敗，回退逐筆：', batchE);
        for (var i = 0; i < ids.length; i++) {
          loadingMessage.value = '批次駁回中 ' + (i + 1) + '/' + ids.length + '...';
          try {
            await adminReject(ids[i], { skipConfirm: true, skipSoftRefresh: true });
            ok++;
          } catch (e) {
            fail++;
          }
        }
      }
      clearAdminPendingSelection();
      loading.value = false;
      showToast(
        '批次駁回完成：成功 ' + ok + ' 筆' + (fail ? '，失敗 ' + fail + ' 筆' : ''),
        fail ? 'warning' : 'info'
      );
      if (ok > 0) softRefreshInBackground({ delay: 1200 });
    }

    async function cancelRequest(id) {
      if (!await showConfirm('確定要撤回此申請單嗎？')) return;
      loading.value = true;
      try {
        var reqBefore = findRequestById(id);
        await callGasApi('cancelRequest', { requestId: id });
        showToast('已成功撤回！', 'success');
        if (reqBefore) restoreMutualQuotaForRows(reqBefore);
        optimisticPatchRequestStatus(id, 'cancelled');
        showDetailModal.value = false;
        if (detailRequest.value && detailRequest.value.id === id) {
          detailRequest.value = null;
          detailSubRecord.value = null;
        }
        softRefreshInBackground({ delay: 2500 });
      } catch (e) {
        console.error(e);
        showToast('撤回失敗：' + e.message, 'error');
      } finally {
        loading.value = false;
      }
    }

    async function deleteSubstitutionRecord(subId, requestId) {
      if (!await showConfirm('確定要撤銷此筆異動並還原課表嗎？')) return;
      loading.value = true;
      loadingMessage.value = '還原課表中...';
      try {
        var reqId = (requestId && requestId !== 'N/A') ? requestId : String(subId).replace(/_[12]$/, '');
        var reqBefore = findRequestById(reqId);
        await callGasApi('deleteSubstitutionRecord', { id: subId, requestId: requestId });
        showToast('已成功撤銷，課表已恢復原狀！', 'success');
        if (reqBefore) restoreMutualQuotaForRows(reqBefore);
        optimisticPatchRequestStatus(reqId, 'cancelled');
        softRefreshInBackground({ delay: 2000, requestsOnly: true });
      } catch (e) {
        console.error('撤銷失敗：', e);
        showToast('撤銷失敗：' + e.message, 'error');
      } finally {
        loading.value = false;
      }
    }

    return {
      selectedAdminPendingIds: selectedAdminPendingIds,
      lastBatchPrintIds: lastBatchPrintIds,
      showBatchPrintPrompt: showBatchPrintPrompt,
      findRequestById: findRequestById,
      isAdminPendingSelected: isAdminPendingSelected,
      toggleAdminPendingSelect: toggleAdminPendingSelect,
      toggleSelectAllAdminPending: toggleSelectAllAdminPending,
      clearAdminPendingSelection: clearAdminPendingSelection,
      checkUrlCallback: checkUrlCallback,
      respondToRequest: respondToRequest,
      respondToBatch: respondToBatch,
      adminApprove: adminApprove,
      adminReject: adminReject,
      batchAdminApprove: batchAdminApprove,
      batchAdminReject: batchAdminReject,
      printLastBatchNotices: printLastBatchNotices,
      dismissBatchPrintPrompt: dismissBatchPrintPrompt,
      cancelRequest: cancelRequest,
      deleteSubstitutionRecord: deleteSubstitutionRecord
    };
  }

  return { create: create };
})();
