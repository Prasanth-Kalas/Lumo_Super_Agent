import { detectMetricAnomalies } from "./anomaly-detection.js";
import { forecastMetricForUser } from "./forecasting.js";
import {
  answerMetricInsightCore,
  formatMetricInsightAnswer,
  shouldRunMetricInsight,
  type MetricInsightResult,
} from "./metric-insights-core.js";

export { formatMetricInsightAnswer, shouldRunMetricInsight };
export type { MetricInsightResult };

export async function answerMetricInsight(args: {
  user_id: string;
  query: string;
  fetchImpl?: typeof fetch;
}): Promise<MetricInsightResult> {
  return answerMetricInsightCore({
    user_id: args.user_id,
    query: args.query,
    fetchImpl: args.fetchImpl,
    deps: {
      detectMetricAnomalies,
      forecastMetricForUser,
    },
  });
}
