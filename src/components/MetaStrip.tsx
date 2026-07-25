import { useI18n } from "../i18n/I18nProvider";
import type { AccountSummary } from "../types/app";
import {
  averageAvailableWeeklyUsage,
  getAccountStatus,
} from "../utils/accountStatus";

type MetaStripProps = {
  accounts: AccountSummary[];
  refreshError: string | null;
  exportingAccounts: boolean;
  onExportAccounts: () => void;
};

type MetricTone = "blue" | "green" | "amber" | "red" | "violet";

type MetricIconProps = {
  tone: MetricTone;
};

function MetricIcon({ tone }: MetricIconProps) {
  if (tone === "violet") {
    return (
      <svg className="metricIconGlyph" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M4 18V6" />
        <path d="M4 18h16" />
        <path d="m7 14 4-4 3 2 5-6" />
      </svg>
    );
  }

  if (tone === "green") {
    return (
      <svg className="metricIconGlyph" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="m5 12 4 4L19 6" />
      </svg>
    );
  }

  if (tone === "amber") {
    return (
      <svg className="metricIconGlyph" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <circle cx="12" cy="12" r="8" />
        <path d="M12 7v5l3 2" />
      </svg>
    );
  }

  if (tone === "red") {
    return (
      <svg className="metricIconGlyph" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <circle cx="12" cy="12" r="8" />
        <path d="M12 8v5" />
        <path d="M12 16h.01" />
      </svg>
    );
  }

  return (
    <svg className="metricIconGlyph" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M16 21v-2a4 4 0 0 0-8 0v2" />
      <circle cx="12" cy="7" r="4" />
    </svg>
  );
}

export function MetaStrip({
  accounts,
  refreshError,
  exportingAccounts,
  onExportAccounts,
}: MetaStripProps) {
  const { copy, locale } = useI18n();
  const isChinese = locale === "zh-CN";
  const groupedStatuses = Array.from(
    accounts.reduce((groups, account) => {
      const statuses = groups.get(account.accountKey) ?? [];
      statuses.push(getAccountStatus(account, undefined, refreshError));
      groups.set(account.accountKey, statuses);
      return groups;
    }, new Map<string, ReturnType<typeof getAccountStatus>[]>()),
  ).map(([, statuses]) => {
    if (statuses.some((status) => status === "using" || status === "available" || status === "low")) {
      return "active";
    }
    if (statuses.some((status) => status === "exhausted")) {
      return "exhausted";
    }
    if (statuses.some((status) => status === "checkFailed")) {
      return "checkFailed";
    }
    return "issue";
  });
  const issueCount = groupedStatuses.filter(
    (status) => status === "issue" || status === "checkFailed",
  ).length;
  const exhaustedCount = groupedStatuses.filter((status) => status === "exhausted").length;
  const activeCount = groupedStatuses.filter((status) => status === "active").length;
  const averageWeeklyUsage = averageAvailableWeeklyUsage(
    accounts,
    undefined,
    refreshError,
  );
  const metrics: Array<{
    label: string;
    value: string | number;
    tone: MetricTone;
  }> = [
    {
      label: copy.metaStrip.accountCount,
      value: groupedStatuses.length,
      tone: "blue",
    },
    {
      label: isChinese ? "活跃账号" : "Active",
      value: activeCount,
      tone: "green",
    },
    {
      label: isChinese ? "已耗尽" : "Exhausted",
      value: exhaustedCount,
      tone: "amber",
    },
    {
      label: isChinese ? "异常账号" : "Needs attention",
      value: issueCount,
      tone: "red",
    },
    {
      label: isChinese ? "平均周使用率" : "Avg. weekly usage",
      value:
        averageWeeklyUsage === null
          ? "--"
          : `${averageWeeklyUsage.toLocaleString(locale, {
              maximumFractionDigits: 1,
            })}%`,
      tone: "violet",
    },
  ];

  return (
    <section className="metaStrip" aria-label={copy.metaStrip.ariaLabel}>
      {metrics.map((metric) => (
        <article key={metric.label} className={`metaPill metric-${metric.tone}`}>
          <span className="metricIcon">
            <MetricIcon tone={metric.tone} />
          </span>
          <span className="metricCopy">
            <span>{metric.label}</span>
            <strong>{metric.value}</strong>
          </span>
        </article>
      ))}
      <button
        className="ghost metaExportButton"
        onClick={onExportAccounts}
        disabled={exportingAccounts || groupedStatuses.length === 0}
        aria-label={copy.metaStrip.exportAll}
      >
        {copy.metaStrip.exportAll}
      </button>
    </section>
  );
}
