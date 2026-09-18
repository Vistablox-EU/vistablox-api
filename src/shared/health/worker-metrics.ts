/**
 * Minimal Prometheus text-format registry for the private worker probe.
 * Metrics are intentionally process-local and label-free: this endpoint is
 * for operational scraping, not a high-cardinality event log.
 */
export class WorkerMetrics {
  private readonly values = new Map<string, number>();

  public increment(name: string, amount = 1): void {
    this.values.set(name, (this.values.get(name) ?? 0) + amount);
  }

  public set(name: string, value: number): void {
    this.values.set(name, value);
  }

  public render(): string {
    return [...this.values.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, value]) => `${name} ${Number.isFinite(value) ? value : 0}`)
      .join("\n") + (this.values.size > 0 ? "\n" : "");
  }
}
