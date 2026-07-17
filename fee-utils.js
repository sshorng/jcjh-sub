/**
 * 經費顯示／判定小工具（讀取相容舊別名，寫入請用正式名稱）
 * 正式：扣額度、活動公費、第8節代課、自費代課、公費代課、無
 * 舊讀取：互代不結→扣額度；學校移撥→公費代課（僅標籤／統計）
 */
window.FeeUtils = (function () {
  var QUOTA = '扣額度';
  var ACTIVITY_PUBLIC = '活動公費';
  var PERIOD8 = '第8節代課';

  function isQuotaDeductFee(fee) {
    if (window.DomainActivityCover && window.DomainActivityCover.isQuotaDeductFee) {
      return window.DomainActivityCover.isQuotaDeductFee(fee);
    }
    var f = String(fee || '');
    return f === QUOTA || f === '互代不結';
  }

  /** 畫面顯示用：舊「互代不結」顯示成「扣額度」 */
  function displayFeeLabel(fee) {
    var f = String(fee || '');
    if (f === '互代不結') return QUOTA;
    if (f === '學校移撥') return '公費代課';
    return f;
  }

  function isQuotaFeeColor(fee) {
    return isQuotaDeductFee(fee);
  }

  function isPublicLeaveFee(fee) {
    var f = String(fee || '');
    return f === '公費代課' || f === '學校移撥';
  }

  return {
    QUOTA: QUOTA,
    ACTIVITY_PUBLIC: ACTIVITY_PUBLIC,
    PERIOD8: PERIOD8,
    isQuotaDeductFee: isQuotaDeductFee,
    displayFeeLabel: displayFeeLabel,
    isQuotaFeeColor: isQuotaFeeColor,
    isPublicLeaveFee: isPublicLeaveFee
  };
})();
