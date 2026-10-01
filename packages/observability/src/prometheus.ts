/**
 * The Prometheus text exposition format, version 0.0.4.
 *
 * A scrape is a plain-text list of samples: `# HELP`, `# TYPE`, then `name{label="value"} number`. It is
 * simple enough to write by hand and exacting enough to get wrong in ways a scraper reports as one
 * unhelpful "invalid metric" error for the whole target, so the escaping and the name rules live in one
 * place with tests, and the servers only describe what they measure.
 */

export type PromType = "gauge" | "counter";

export interface PromSample {
  labels?: Readonly<Record<string, string>>;
  value: number;
}

export interface PromMetric {
  name: string;
  help: string;
  type: PromType;
  samples: readonly PromSample[];
}

export const PROMETHEUS_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";

const METRIC_NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const LABEL_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/** A label value: backslash, double quote and newline are escaped, everything else is literal. */
export function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

/** A HELP line's text: backslash and newline are escaped. */
function escapeHelp(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\n/g, "\\n");
}

function formatValue(value: number): string {
  if (Number.isNaN(value)) return "NaN";
  if (value === Infinity) return "+Inf";
  if (value === -Infinity) return "-Inf";
  return String(value);
}

/**
 * Render metrics to the text format. A metric with no samples is left out entirely (a `# TYPE` line with
 * nothing under it is noise); a name or label that the format does not allow is a bug in the caller and
 * throws, rather than producing a scrape the server cannot parse.
 */
export function renderPrometheus(metrics: readonly PromMetric[]): string {
  const lines: string[] = [];
  for (const metric of metrics) {
    if (!METRIC_NAME.test(metric.name)) throw new Error(`invalid Prometheus metric name '${metric.name}'`);
    if (metric.samples.length === 0) continue;
    lines.push(`# HELP ${metric.name} ${escapeHelp(metric.help)}`);
    lines.push(`# TYPE ${metric.name} ${metric.type}`);
    for (const sample of metric.samples) {
      const entries = Object.entries(sample.labels ?? {});
      for (const [label] of entries) {
        if (!LABEL_NAME.test(label) || label.startsWith("__")) throw new Error(`invalid Prometheus label name '${label}' on ${metric.name}`);
      }
      const labels = entries.length ? `{${entries.map(([k, v]) => `${k}="${escapeLabelValue(String(v))}"`).join(",")}}` : "";
      lines.push(`${metric.name}${labels} ${formatValue(sample.value)}`);
    }
  }
  return lines.length ? `${lines.join("\n")}\n` : "";
}
