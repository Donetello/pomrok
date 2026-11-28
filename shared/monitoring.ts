import { PrometheusExporter } from "@opentelemetry/exporter-prometheus";
import { AggregationType, MeterProvider } from "@opentelemetry/sdk-metrics";

export const uptimeUserAgent = "Pomrok-Uptime/1";

export function createMetricsServer(options: { host?: string; port?: number } = {}) {
  const exporter = new PrometheusExporter({
    ...options, preventServerStart: true, withoutTargetInfo: true, withoutScopeInfo: true,
  });
  const provider = new MeterProvider({
    readers: [exporter],
    views: [{
      instrumentName: "http.server.request.duration",
      aggregation: {
        type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM,
        options: { boundaries: [0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5, 10, 15, 30, 60, 120] },
      },
    }],
  });
  return {
    exporter,
    meter: provider.getMeter("pomrok"),
    start: () => exporter.startServer(),
    shutdown: () => provider.shutdown(),
  };
}

export function configuredMetricsServer() {
  const port = process.env.POMROK_METRICS_PORT;
  if (!port) return;
  return createMetricsServer({ host: process.env.POMROK_METRICS_HOST ?? "127.0.0.1", port: Number(port) });
}

const httpMethods = new Set(["CONNECT", "DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT", "QUERY", "TRACE"]);
const httpRoutes = {
  api: ["/catalog", "/practice"],
  web: ["/", "/api/practice"],
  telegram_webhook: ["/telegram/webhook"],
};
type Component = keyof typeof httpRoutes;

const trackedStatuses = new Set([200, 204, 304, 400, 401, 403, 404, 405, 413, 415, 429, 500, 502, 503, 504]);
const statusClasses = ["1xx", "2xx", "3xx", "4xx", "5xx", "other"];
const statusClass = (status: number) => statusClasses[Math.trunc(status / 100) - 1] ?? "other";

function requestAttributes(component: Component, route: string | undefined, status: number | string) {
  return {
    component,
    "http.response.status_code": typeof status === "number" ? status : "other",
    "http.response.status_class": typeof status === "number" ? statusClass(status) : status,
    ...(route ? { "http.route": route } : {}),
  };
}

export function createHttpMetrics(meter: ReturnType<typeof createMetricsServer>["meter"], components: Component[]) {
  const requests = meter.createCounter("pomrok.http.requests", { description: "Completed HTTP server requests." });
  const duration = meter.createHistogram("http.server.request.duration", {
    unit: "s", description: "Duration of completed HTTP server requests.",
  });
  // A scrape before the first request gives Prometheus a baseline for sparse traffic.
  for (const component of components) {
    for (const route of [...httpRoutes[component], undefined]) {
      for (const status of [...trackedStatuses, ...statusClasses]) requests.add(0, requestAttributes(component, route, status));
    }
  }
  return {
    record(component: Component, method: string | undefined, path: string | undefined,
      status: number, elapsedSeconds: number) {
      const route = path && httpRoutes[component].includes(path) ? path : undefined;
      requests.add(1, requestAttributes(component, route, trackedStatuses.has(status) ? status : statusClass(status)));
      duration.record(elapsedSeconds, {
        component,
        "http.request.method": method && httpMethods.has(method) ? method : "_OTHER",
        "http.response.status_code": status,
        ...(route ? { "http.route": route } : {}),
      });
    },
  };
}

export type HttpMetrics = ReturnType<typeof createHttpMetrics>;
