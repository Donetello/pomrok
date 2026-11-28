export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.POMROK_METRICS_PORT) {
    const { startWebMonitoring } = await import("./shared/web-monitoring");
    await startWebMonitoring();
  }
}
