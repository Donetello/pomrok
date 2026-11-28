import { channel } from "node:diagnostics_channel";
import type { IncomingMessage, ServerResponse } from "node:http";
import { configuredMetricsServer, createHttpMetrics, uptimeUserAgent, type HttpMetrics } from "./monitoring.ts";

export function observeWebRequests(http: HttpMetrics) {
  const start = channel("http.server.request.start");
  const finish = channel("http.server.response.finish");
  const started = new WeakMap<IncomingMessage, number>();

  const onStart = (event: unknown) => {
    const { request } = event as { request: IncomingMessage };
    const path = request.url?.split("?", 1)[0];
    if (path === "/metrics" || request.headers["user-agent"] === uptimeUserAgent) return;
    started.set(request, performance.now());
  };
  const onFinish = (event: unknown) => {
    const { request, response } = event as { request: IncomingMessage; response: ServerResponse };
    const began = started.get(request);
    if (began === undefined) return;
    const path = request.url?.split("?", 1)[0];
    http.record("web", request.method, path, response.statusCode, (performance.now() - began) / 1000);
  };

  start.subscribe(onStart);
  finish.subscribe(onFinish);
  return () => {
    start.unsubscribe(onStart);
    finish.unsubscribe(onFinish);
  };
}

export async function startWebMonitoring() {
  const metrics = configuredMetricsServer();
  if (!metrics) return;
  try {
    await metrics.start();
    observeWebRequests(createHttpMetrics(metrics.meter, ["web"]));
  } catch (error) {
    console.error("Pomrok metrics exporter could not start", error);
    await metrics.shutdown();
  }
}
