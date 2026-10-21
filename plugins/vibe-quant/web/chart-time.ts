// Storage, paging and drawing anchors keep bar starts. Intraday chart times use
// period ends; daily/monthly bars retain their trading-date/calendar labels.
function labelOffset(duration: number) {
  return duration > 0 && duration < 86400 ? duration : 0;
}

export function barLabelTime(time: number, duration: number) {
  return time + labelOffset(duration);
}

export function barStartTime(labelTime: number, duration: number) {
  return labelTime - labelOffset(duration);
}
