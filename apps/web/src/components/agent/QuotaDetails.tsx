import { Icon } from "../ui/primitives";
import { ProviderIcon } from "./ModelProviders";
import { GaugeIcon } from "./ModelControls";
import {
  LOW_QUOTA_THRESHOLD, formatPercent, formatRelativeAge, formatResetCountdown, minRemainingPercent, providerShortName, type QuotaAgent,
} from "./subscriptionQuota";

/**
 * The model selector's drawer listing each subscription's remaining quota, with its own refresh and Done. AgentChip
 * calls it as a function (it holds no hooks) so the drawer reconciles in place with the dock.
 */
export function QuotaDetails({ quotaProviders, refreshingQuota, onRefresh, onDone }: {
  quotaProviders: QuotaAgent[];
  refreshingQuota: boolean;
  onRefresh: () => void;
  onDone: () => void;
}) {
  const latestQuotaFetchedAt = quotaProviders
    .map((a) => a.quota.fetchedAt)
    .sort((a, b) => Date.parse(b) - Date.parse(a))[0];
  return (
    <div aria-label="Subscription quota details">
      <div className="flex items-center justify-between gap-2 px-3 py-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="inline-flex items-center gap-1.5 eyebrow text-muted">
            <GaugeIcon size={12} />
            Subscription quota
          </span>
          {latestQuotaFetchedAt && (
            <span className="truncate text-[10.5px] text-dim">
              {formatRelativeAge(latestQuotaFetchedAt)}
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            aria-label="Refresh subscription quota"
            title="Refresh subscription quota"
            disabled={refreshingQuota}
            onClick={onRefresh}
            className="flex size-5 items-center justify-center rounded text-muted transition-colors hover:bg-raised hover:text-fg disabled:opacity-50"
          >
            <span className={refreshingQuota ? "inline-flex animate-spin" : "inline-flex"}>
              <Icon name="refresh" size={11} />
            </span>
          </button>
          <button
            type="button"
            aria-expanded={true}
            onClick={onDone}
            className="inline-flex items-center gap-1 rounded px-1 py-0.5 text-[11px] font-medium text-fg transition-colors hover:bg-raised/60"
          >
            Done
            <span className="inline-flex rotate-180">
              <Icon name="down" size={10} />
            </span>
          </button>
        </div>
      </div>
      <div className="space-y-2 px-3 pb-2.5">
        {quotaProviders.map((agent) => {
          const minPct = minRemainingPercent(agent.quota);
          const isLow = minPct !== undefined && minPct < LOW_QUOTA_THRESHOLD;
          const planBadge = agent.quota.plan ?? agent.plan;
          return (
            <div
              key={agent.id}
              data-quota-card={agent.id}
              data-low={isLow ? "true" : "false"}
              className={`rounded-md border px-2.5 py-2 ${
                isLow ? "border-warn/35 bg-warn/[0.05]" : "border-line/70 bg-panel/60"
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-1.5">
                  <ProviderIcon id={agent.id} size={13} />
                  <span className="truncate text-[12px] font-medium text-fg">
                    {providerShortName(agent.id)}
                  </span>
                  {planBadge && (
                    <span className="shrink-0 rounded bg-raised px-1.5 py-[1px] text-[10px] font-medium text-muted">
                      {planBadge}
                    </span>
                  )}
                </div>
                {isLow && (
                  <span className="shrink-0 text-[10.5px] font-medium text-warn">Low</span>
                )}
              </div>
              {agent.quota.buckets.length > 0 ? (
                <div className="mt-1.5 space-y-1.5">
                  {agent.quota.buckets.map((bucket) => {
                    const bucketLow = bucket.remainingPercent < LOW_QUOTA_THRESHOLD;
                    const countdown = formatResetCountdown(bucket.resetsAt);
                    return (
                      <div key={bucket.id}>
                        <div className="flex items-center justify-between gap-2 text-[11px]">
                          <span className="truncate text-muted">{bucket.label}</span>
                          <span className="flex shrink-0 items-center gap-1.5 tabular-nums">
                            <span className={`font-medium ${bucketLow ? "text-warn" : "text-fg"}`}>
                              {formatPercent(bucket.remainingPercent)}
                            </span>
                            {countdown && (
                              <span className="text-[10.5px] text-dim" title={`Resets in ${countdown}`}>
                                {countdown}
                              </span>
                            )}
                          </span>
                        </div>
                        <div className="mt-1 h-[3px] w-full overflow-hidden rounded-full bg-line/70" aria-hidden="true">
                          <div
                            className={`h-full rounded-full transition-[width] duration-150 ${bucketLow ? "bg-warn" : "bg-fg/65"}`}
                            style={{ width: `${Math.max(2, Math.min(100, bucket.remainingPercent))}%` }}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : agent.quota.unlimited ? (
                <p className="mt-1 text-[11px] text-muted">Unlimited credits</p>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
