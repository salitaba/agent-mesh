import { test } from "node:test";
import assert from "node:assert/strict";
import { PROMETHEUS_CONTENT_TYPE, escapeLabelValue, renderPrometheus } from "../../packages/observability/src/prometheus";

test("a metric renders as HELP, TYPE and its samples, in the text format a scraper expects", () => {
  const text = renderPrometheus([
    { name: "curule_up", help: "1 while the server is serving.", type: "gauge", samples: [{ value: 1 }] },
    {
      name: "curule_projects",
      help: "Projects by status.",
      type: "gauge",
      samples: [
        { labels: { status: "open" }, value: 2 },
        { labels: { status: "closed" }, value: 3 },
      ],
    },
  ]);
  assert.equal(
    text,
    [
      "# HELP curule_up 1 while the server is serving.",
      "# TYPE curule_up gauge",
      "curule_up 1",
      "# HELP curule_projects Projects by status.",
      "# TYPE curule_projects gauge",
      'curule_projects{status="open"} 2',
      'curule_projects{status="closed"} 3',
      "",
    ].join("\n"),
  );
  assert.match(PROMETHEUS_CONTENT_TYPE, /^text\/plain; version=0\.0\.4/);
});

test("label values escape backslash, quote and newline, and nothing else", () => {
  assert.equal(escapeLabelValue('a\\b"c\nd'), 'a\\\\b\\"c\\nd');
  assert.equal(escapeLabelValue("plain é ✓ {}"), "plain é ✓ {}");
  const text = renderPrometheus([{ name: "m", help: "h", type: "gauge", samples: [{ labels: { project: 'we"ird\nname\\' }, value: 1 }] }]);
  assert.equal(text.split("\n").filter((l) => l.startsWith("m{")).length, 1, "the newline did not start a second line");
  assert.match(text, /^m\{project="we\\"ird\\nname\\\\"\} 1$/m);
});

test("HELP text escapes backslash and newline so a description cannot end its own line early", () => {
  const text = renderPrometheus([{ name: "m", help: "line one\nline two \\ done", type: "counter", samples: [{ value: 0 }] }]);
  assert.match(text, /^# HELP m line one\\nline two \\\\ done$/m);
});

test("a metric with no samples is left out, and no metrics is an empty body", () => {
  assert.equal(renderPrometheus([{ name: "m", help: "h", type: "gauge", samples: [] }]), "");
  assert.equal(renderPrometheus([]), "");
});

test("numbers: integers, fractions, zero, negatives and the special values", () => {
  const body = renderPrometheus([{ name: "m", help: "h", type: "gauge", samples: [{ value: 3 }, { value: 0.675597 }, { value: 0 }, { value: -2.5 }, { value: NaN }, { value: Infinity }, { value: -Infinity }, { value: 1e21 }] }]);
  assert.deepEqual(body.split("\n").slice(2, -1), ["m 3", "m 0.675597", "m 0", "m -2.5", "m NaN", "m +Inf", "m -Inf", "m 1e+21"]);
});

test("a name or label the format does not allow is a bug in the caller and throws", () => {
  const sample = [{ value: 1 }];
  assert.throws(() => renderPrometheus([{ name: "bad-name", help: "h", type: "gauge", samples: sample }]), /invalid Prometheus metric name/);
  assert.throws(() => renderPrometheus([{ name: "1abc", help: "h", type: "gauge", samples: sample }]), /invalid Prometheus metric name/);
  assert.throws(() => renderPrometheus([{ name: "m", help: "h", type: "gauge", samples: [{ labels: { "bad-label": "x" }, value: 1 }] }]), /invalid Prometheus label name/);
  assert.throws(() => renderPrometheus([{ name: "m", help: "h", type: "gauge", samples: [{ labels: { __reserved: "x" }, value: 1 }] }]), /invalid Prometheus label name/);
  assert.doesNotThrow(() => renderPrometheus([{ name: "ns:sub_total", help: "h", type: "counter", samples: [{ labels: { _ok: "x" }, value: 1 }] }]));
});
