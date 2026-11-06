import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../i18n/I18nProvider";
import { tokenHeatmapLevel } from "../utils/heatmapScale";
import type {
  CodexCostAnalyticsProgress,
  CodexCostAnalyticsSnapshot,
  CodexHourlyCostBucket,
  CodexProjectCostBreakdown,
  CodexPromptCostBreakdown,
  CodexSessionCostBreakdown,
} from "../types/app";

type AnalyticsPanelProps = {
  analytics: CodexCostAnalyticsSnapshot | null;
  error: string | null;
  loading: boolean;
  exporting: "csv" | "json" | null;
  progress: CodexCostAnalyticsProgress | null;
  onRefresh: () => void;
  onExport: (format: "csv" | "json") => void;
  onDeleteSession: (session: CodexSessionCostBreakdown) => Promise<void> | void;
};

type AnalyticsCopy = ReturnType<typeof useI18n>["copy"]["analytics"];

function formatUsd(value: number, locale: string) {
  const digits = Math.abs(value) < 1 ? 4 : 2;
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
}

function formatNumber(value: number, locale: string) {
  return new Intl.NumberFormat(locale, {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}

function formatWholeNumber(value: number, locale: string) {
  return new Intl.NumberFormat(locale, {
    maximumFractionDigits: 0,
  }).format(value);
}

function formatTokenCount(value: number, locale: string) {
  const absoluteValue = Math.abs(value);
  const scale =
    absoluteValue >= 999_950
      ? { divisor: 1_000_000, suffix: "M" }
      : absoluteValue >= 1_000
        ? { divisor: 1_000, suffix: "K" }
        : null;

  if (!scale) {
    return formatWholeNumber(value, locale);
  }

  const formatted = new Intl.NumberFormat(locale, {
    maximumFractionDigits: 1,
  }).format(value / scale.divisor);
  return `${formatted}${scale.suffix}`;
}

function formatDateTime(value: number | null, locale: string) {
  if (!value) {
    return "--";
  }
  return new Intl.DateTimeFormat(locale, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value * 1000));
}

function formatDuration(seconds: number | null, locale: string) {
  if (seconds === null) {
    return "--";
  }
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours <= 0) {
    return `${new Intl.NumberFormat(locale).format(minutes)} 分钟`;
  }
  return `${new Intl.NumberFormat(locale).format(hours)} 小时 ${minutes} 分`;
}

// 中文界面文案：列名/单位不属于多语言字典（避免新增英文键），
// 统一在这里维护，保证中文界面不再出现英文残留。
const ANALYTICS_TEXT = {
  sessionColumn: "会话",
  tokenColumn: "Token",
  tokenUnit: "Token",
  searchSessionPlaceholder: "搜索会话",
  parentSessionPrefix: "父会话",
  sessionCountUnit: "个会话",
  promptCountUnit: "个提示词",
  eventCountUnit: "个事件",
  promptCharsUnit: "字符",
  pricingSourcePrefix: "费率来源",
  shownSessionsPrefix: "显示前",
  totalSessionsPrefix: "共",
  unknownPricingHint: "含未定价模型，成本为估算",
};

function statCard(
  label: string,
  value: string,
  detail?: string,
  detailTitle?: string,
) {
  return (
    <article className="analyticsStatCard">
      <span>{label}</span>
      <strong>{value}</strong>
      {detail ? <small title={detailTitle}>{detail}</small> : null}
    </article>
  );
}

function progressStageLabel(
  progress: CodexCostAnalyticsProgress | null,
  copy: ReturnType<typeof useI18n>["copy"]["analytics"],
) {
  if (progress?.stage === "caching") {
    return copy.progressCaching;
  }
  if (progress?.stage === "complete") {
    return copy.progressComplete;
  }
  return copy.progressScanning;
}

function costSourceDetail(
  analytics: CodexCostAnalyticsSnapshot | null,
  copy: AnalyticsCopy,
  locale: string,
) {
  if (!analytics) {
    return { label: copy.pricingEstimate, title: undefined };
  }

  const updatedAt = formatDateTime(analytics.costSourceUpdatedAt, locale);
  return {
    label: `${copy.costSourceLocal} · ${updatedAt}`,
    title: undefined,
  };
}

function Heatmap({
  buckets,
  locale,
  copy,
}: {
  buckets: CodexHourlyCostBucket[];
  locale: string;
  copy: Pick<AnalyticsCopy, "heatmapAriaLabel" | "heatmapTooltip">;
}) {
  const byKey = new Map(
    buckets.map((bucket) => [`${bucket.weekday}:${bucket.hour}`, bucket]),
  );
  const maxTokens = Math.max(...buckets.map((bucket) => bucket.tokens), 1);
  const weekdayFormatter = new Intl.DateTimeFormat(locale, {
    weekday: "short",
    timeZone: "UTC",
  });
  const weekdayLabels = Array.from({ length: 7 }, (_, weekday) =>
    weekdayFormatter.format(new Date(Date.UTC(2024, 0, 7 + weekday, 12))),
  );
  const hourLabels = Array.from({ length: 24 }, (_, hour) => hour);

  return (
    <div
      className="analyticsHeatmap"
      role="img"
      aria-label={copy.heatmapAriaLabel}
    >
      <div className="analyticsHeatmapHeader" aria-hidden="true">
        <span />
        {hourLabels.map((hour) => (
          <b key={hour}>{hour % 6 === 0 ? `${hour}:00` : ""}</b>
        ))}
      </div>
      {weekdayLabels.map((label, weekday) => (
        <div key={label} className="analyticsHeatmapRow">
          <span>{label}</span>
          {hourLabels.map((hour) => {
            const bucket = byKey.get(`${weekday}:${hour}`);
            const tokens = bucket?.tokens ?? 0;
            const level = tokenHeatmapLevel(tokens, maxTokens);
            const tooltip = copy.heatmapTooltip(
              label,
              `${hour}:00`,
              formatTokenCount(tokens, locale),
            );
            return (
              <i
                key={hour}
                className={`analyticsHeatmapCell level${level}`}
                data-tooltip={tooltip}
              />
            );
          })}
        </div>
      ))}
    </div>
  );
}

function ProjectRows({
  projects,
  locale,
}: {
  projects: CodexProjectCostBreakdown[];
  locale: string;
}) {
  const maxCost = Math.max(
    ...projects.map((project) => project.costUsd),
    0.000001,
  );

  return (
    <div className="analyticsProjectList">
      {projects.slice(0, 10).map((project) => (
        <article key={project.projectPath} className="analyticsProjectRow">
          <div>
            <strong title={project.projectPath}>{project.projectName}</strong>
            <span title={project.projectPath}>{project.projectPath}</span>
          </div>
          <div className="analyticsProjectMetrics">
            <b>{formatUsd(project.costUsd, locale)}</b>
            <small>
              {formatNumber(project.total.totalTokens, locale)}{" "}
              {ANALYTICS_TEXT.tokenUnit}
            </small>
          </div>
          <div className="analyticsProjectBar" aria-hidden="true">
            <i
              style={{
                width: `${Math.max(4, (project.costUsd / maxCost) * 100)}%`,
              }}
            />
          </div>
          <small>
            {project.sessionCount} {ANALYTICS_TEXT.sessionCountUnit} ·{" "}
            {project.promptCount} {ANALYTICS_TEXT.promptCountUnit} ·{" "}
            {project.eventCount} {ANALYTICS_TEXT.eventCountUnit}
          </small>
        </article>
      ))}
    </div>
  );
}

function SessionTable({
  sessions,
  locale,
  text,
  pendingDeleteSessionId,
  deletingSessionId,
  onDeleteSession,
}: {
  sessions: CodexSessionCostBreakdown[];
  locale: string;
  text: ReturnType<typeof useI18n>["copy"]["analytics"];
  pendingDeleteSessionId: string | null;
  deletingSessionId: string | null;
  onDeleteSession: (session: CodexSessionCostBreakdown) => void;
}) {
  return (
    <div className="analyticsTableWrap">
      <table className="analyticsTable">
        <thead>
          <tr>
            <th>{ANALYTICS_TEXT.sessionColumn}</th>
            <th>{text.project}</th>
            <th>{text.model}</th>
            <th>{ANALYTICS_TEXT.tokenColumn}</th>
            <th>{text.cost}</th>
            <th>{text.updated}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {sessions.slice(0, 80).map((session) => (
            <tr key={session.sessionId}>
              <td>
                <strong title={session.sessionId}>
                  {session.sessionId.slice(0, 8)}
                </strong>
                {session.parentSessionId ? (
                  <small>
                    {ANALYTICS_TEXT.parentSessionPrefix}{" "}
                    {session.parentSessionId.slice(0, 8)}
                  </small>
                ) : null}
              </td>
              <td title={session.projectPath}>{session.projectName}</td>
              <td>{session.model}</td>
              <td>{formatNumber(session.total.totalTokens, locale)}</td>
              <td>{formatUsd(session.costUsd, locale)}</td>
              <td>
                {formatDateTime(session.updatedAt, locale)}
                <small>{formatDuration(session.durationSeconds, locale)}</small>
              </td>
              <td>
                <button
                  type="button"
                  className="analyticsDeleteButton"
                  disabled={deletingSessionId !== null}
                  onClick={() => onDeleteSession(session)}
                >
                  {deletingSessionId === session.sessionId
                    ? text.sessionDeleting
                    : pendingDeleteSessionId === session.sessionId
                      ? text.sessionDeleteConfirm
                      : text.sessionDelete}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TopPrompts({
  prompts,
  locale,
}: {
  prompts: CodexPromptCostBreakdown[];
  locale: string;
}) {
  return (
    <div className="analyticsPromptList">
      {prompts.map((prompt, index) => (
        <article
          key={`${prompt.sessionId}-${prompt.timestamp}-${index}`}
          className="analyticsPromptRow"
        >
          <div className="analyticsPromptRank">{index + 1}</div>
          <div className="analyticsPromptBody">
            <strong>{formatUsd(prompt.costUsd, locale)}</strong>
            <p title={prompt.promptPreview}>{prompt.promptPreview}</p>
            <span>
              {prompt.projectName} · {prompt.model} ·{" "}
              {formatNumber(prompt.total.totalTokens, locale)}{" "}
              {ANALYTICS_TEXT.tokenUnit} · {prompt.promptChars}{" "}
              {ANALYTICS_TEXT.promptCharsUnit}
            </span>
          </div>
        </article>
      ))}
    </div>
  );
}

export function AnalyticsPanel({
  analytics,
  error,
  loading,
  exporting,
  progress,
  onRefresh,
  onExport,
  onDeleteSession,
}: AnalyticsPanelProps) {
  const { copy, locale } = useI18n();
  const text = copy.analytics;
  const deleteConfirmTimerRef = useRef<number | null>(null);
  const [sessionQuery, setSessionQuery] = useState("");
  const [pendingDeleteSessionId, setPendingDeleteSessionId] = useState<
    string | null
  >(null);
  const [deletingSessionId, setDeletingSessionId] = useState<string | null>(
    null,
  );
  const normalizedQuery = sessionQuery.trim().toLocaleLowerCase();
  const filteredSessions = useMemo(() => {
    const sessions = analytics?.sessions ?? [];
    if (!normalizedQuery) {
      return sessions;
    }
    return sessions.filter((session) =>
      [
        session.sessionId,
        session.parentSessionId ?? "",
        session.projectName,
        session.projectPath,
        session.model,
      ]
        .join(" ")
        .toLocaleLowerCase()
        .includes(normalizedQuery),
    );
  }, [analytics?.sessions, normalizedQuery]);

  const clearDeleteConfirmTimer = () => {
    if (deleteConfirmTimerRef.current !== null) {
      window.clearTimeout(deleteConfirmTimerRef.current);
      deleteConfirmTimerRef.current = null;
    }
  };

  const handleDeleteSession = (session: CodexSessionCostBreakdown) => {
    if (deletingSessionId !== null) {
      return;
    }

    if (pendingDeleteSessionId !== session.sessionId) {
      clearDeleteConfirmTimer();
      setPendingDeleteSessionId(session.sessionId);
      deleteConfirmTimerRef.current = window.setTimeout(() => {
        setPendingDeleteSessionId((current) =>
          current === session.sessionId ? null : current,
        );
        deleteConfirmTimerRef.current = null;
      }, 3_000);
      return;
    }

    clearDeleteConfirmTimer();
    setDeletingSessionId(session.sessionId);
    void Promise.resolve(onDeleteSession(session))
      .catch(() => {})
      .finally(() => {
        setPendingDeleteSessionId(null);
        setDeletingSessionId(null);
      });
  };

  useEffect(
    () => () => {
      if (deleteConfirmTimerRef.current !== null) {
        window.clearTimeout(deleteConfirmTimerRef.current);
      }
    },
    [],
  );

  const costSource = costSourceDetail(analytics, text, locale);
  const hasData = analytics !== null && analytics.eventCount > 0;
  const unknownPricingModels = analytics?.pricingUnknownModels ?? [];
  const costSourceLabel =
    unknownPricingModels.length > 0
      ? `${costSource.label} · ${ANALYTICS_TEXT.unknownPricingHint}`
      : costSource.label;
  const showedSessionCount = analytics?.sessions.length ?? 0;
  const sessionTotal = analytics?.sessionTotal ?? null;
  // 后端 M5 起返回截断前的会话总数；旧缓存/旧后端缺省时退回旧展示。
  const sessionsTruncated = sessionTotal !== null && sessionTotal > showedSessionCount;
  const sessionCountLabel = sessionsTruncated
    ? `${ANALYTICS_TEXT.shownSessionsPrefix} ${formatNumber(showedSessionCount, locale)} / ${ANALYTICS_TEXT.totalSessionsPrefix} ${formatNumber(sessionTotal ?? 0, locale)}`
    : null;
  const showProgress = loading || progress !== null;
  const progressPercent = Math.max(
    0,
    Math.min(100, Math.round(progress?.percent ?? (loading ? 6 : 0))),
  );
  const progressFiles =
    progress && progress.totalFiles > 0
      ? `${formatNumber(progress.processedFiles, locale)} / ${formatNumber(progress.totalFiles, locale)} ${text.sourceFiles}`
      : text.loadingDescription;

  return (
    <section className="analyticsPage">
      <div className="analyticsShell">
        <header className="analyticsHeader">
          <div>
            <span className="analyticsKicker">{text.kicker}</span>
            <h2>{text.title}</h2>
            <p>{text.description}</p>
          </div>
          <div className="analyticsActions">
            <button
              type="button"
              className="ghost"
              onClick={onRefresh}
              disabled={loading}
            >
              {text.refresh}
            </button>
            <button
              type="button"
              className="ghost"
              onClick={() => onExport("csv")}
              disabled={exporting !== null}
            >
              {exporting === "csv" ? text.exporting : text.exportCsv}
            </button>
            <button
              type="button"
              className="primary"
              onClick={() => onExport("json")}
              disabled={exporting !== null}
            >
              {exporting === "json" ? text.exporting : text.exportJson}
            </button>
          </div>
        </header>

        {error ? (
          <section className="analyticsNotice tone-danger">
            <strong>{text.errorTitle}</strong>
            <span>{error}</span>
          </section>
        ) : null}

        {showProgress ? (
          <section className="analyticsProgress" aria-live="polite">
            <div>
              <strong>{progressStageLabel(progress, text)}</strong>
              <span>{progressFiles}</span>
            </div>
            <div
              className="analyticsProgressMeter"
              aria-label={`${progressPercent}%`}
            >
              <i style={{ width: `${progressPercent}%` }} />
            </div>
            <b>{progressPercent}%</b>
            {progress?.currentPath ? (
              <code title={progress.currentPath}>{progress.currentPath}</code>
            ) : null}
          </section>
        ) : null}

        <section className="analyticsStats">
          {statCard(
            text.totalCost,
            analytics ? formatUsd(analytics.totalCostUsd, locale) : "--",
            costSourceLabel,
            unknownPricingModels.length > 0
              ? unknownPricingModels.join("、")
              : undefined,
          )}
          {statCard(
            text.last7dCost,
            analytics ? formatUsd(analytics.last7dCostUsd, locale) : "--",
            costSourceLabel,
            unknownPricingModels.length > 0
              ? unknownPricingModels.join("、")
              : costSource.title,
          )}
          {statCard(
            text.totalTokens,
            analytics
              ? formatNumber(analytics.total.totalTokens, locale)
              : "--",
            text.tokenEvents,
          )}
          {statCard(
            text.sessions,
            analytics
              ? formatNumber(sessionTotal ?? showedSessionCount, locale)
              : "--",
            sessionsTruncated
              ? `${ANALYTICS_TEXT.shownSessionsPrefix} ${formatNumber(showedSessionCount, locale)}`
              : text.sourceFiles,
          )}
        </section>

        {loading && !analytics ? (
          <section className="analyticsEmpty">
            <strong>{text.loadingTitle}</strong>
            <span>{text.loadingDescription}</span>
          </section>
        ) : !hasData ? (
          <section className="analyticsEmpty">
            <strong>{text.emptyTitle}</strong>
            <span>{text.emptyDescription}</span>
          </section>
        ) : analytics ? (
          <div className="analyticsGrid">
            <section className="analyticsBlock analyticsBlockProjects">
              <div className="analyticsBlockHead">
                <div>
                  <h3>{text.projectsTitle}</h3>
                  <p>{text.projectsDescription}</p>
                </div>
              </div>
              <ProjectRows projects={analytics.projects} locale={locale} />
            </section>

            <section className="analyticsBlock analyticsBlockHeatmap">
              <div className="analyticsBlockHead">
                <div>
                  <h3>{text.heatmapTitle}</h3>
                  <p>{text.heatmapDescription}</p>
                </div>
              </div>
              <Heatmap
                buckets={analytics.heatmap}
                locale={locale}
                copy={text}
              />
            </section>

            <section className="analyticsBlock analyticsBlockSessions">
              <div className="analyticsBlockHead">
                <div>
                  <h3>{text.sessionsTitle}</h3>
                  <p>{text.sessionsDescription}</p>
                  {sessionCountLabel ? (
                    <p className="analyticsSessionCount">{sessionCountLabel}</p>
                  ) : null}
                </div>
                <input
                  className="analyticsSearch"
                  value={sessionQuery}
                  placeholder={ANALYTICS_TEXT.searchSessionPlaceholder}
                  onChange={(event) => setSessionQuery(event.target.value)}
                />
              </div>
              <SessionTable
                sessions={filteredSessions}
                locale={locale}
                text={text}
                pendingDeleteSessionId={pendingDeleteSessionId}
                deletingSessionId={deletingSessionId}
                onDeleteSession={handleDeleteSession}
              />
            </section>

            <section className="analyticsBlock analyticsBlockPrompts">
              <div className="analyticsBlockHead">
                <div>
                  <h3>{text.topPromptsTitle}</h3>
                  <p>{text.topPromptsDescription}</p>
                </div>
              </div>
              <TopPrompts prompts={analytics.topPrompts} locale={locale} />
            </section>
          </div>
        ) : null}

        {analytics ? (
          <footer className="analyticsFoot">
            <span>
              {text.updated}: {formatDateTime(analytics.updatedAt, locale)}
            </span>
            <span>
              {text.sourceFiles}: {analytics.sourcePathCount}
            </span>
            <span>
              {text.failedSources}: {analytics.failedPathCount}
            </span>
            {analytics.unresolvedForkCount > 0 ? (
              <span>
                {text.unresolvedForks}: {analytics.unresolvedForkCount}
              </span>
            ) : null}
            {analytics.unresolvedUsageEventCount > 0 ? (
              <span>
                {text.usageAnomalies}: {analytics.unresolvedUsageEventCount}
              </span>
            ) : null}
            <span>
              {ANALYTICS_TEXT.pricingSourcePrefix}：{analytics.pricingSource}
            </span>
          </footer>
        ) : null}
      </div>
    </section>
  );
}
