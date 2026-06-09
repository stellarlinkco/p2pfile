export function formatBytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = value;
  let index = 0;

  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }

  return `${size >= 100 || index === 0 ? size.toFixed(0) : size.toFixed(1)} ${units[index]}`;
}

export function formatRelativeTime(value: string | number | null) {
  if (value == null) {
    return "--";
  }

  const timestamp =
    typeof value === "number"
      ? value
      : Number.isFinite(Date.parse(value))
        ? Date.parse(value)
        : Number.NaN;
  if (!Number.isFinite(timestamp)) {
    return typeof value === "string" ? value : "--";
  }

  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    month: "2-digit",
    day: "2-digit",
  }).format(timestamp);
}

export function formatPercent(completed: number, total: number) {
  if (total <= 0) {
    return "0%";
  }

  return `${Math.min(100, Math.round((completed / total) * 100))}%`;
}

export function formatMode(mode: "direct" | "relay" | null) {
  if (mode === "direct") {
    return "Direct Transfer";
  }

  if (mode === "relay") {
    return "Relayed Transfer";
  }

  return "Negotiating";
}

export function formatSpeed(bytesPerSecond: number | null) {
  if (!bytesPerSecond || bytesPerSecond <= 0) {
    return "--";
  }

  return `${formatBytes(bytesPerSecond)}/s`;
}
