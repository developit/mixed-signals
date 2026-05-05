import {build} from 'hdr-histogram-js';

export class LatencyHistogram {
  private histogram = build({
    lowestDiscernibleValue: 1,
    highestTrackableValue: 60_000_000,
    numberOfSignificantValueDigits: 3,
  });

  record(ms: number) {
    const micros = Math.max(1, Math.floor(ms * 1000));
    this.histogram.recordValue(micros);
  }

  summary() {
    return {
      p50: this.histogram.getValueAtPercentile(50) / 1000,
      p95: this.histogram.getValueAtPercentile(95) / 1000,
      p99: this.histogram.getValueAtPercentile(99) / 1000,
      max: this.histogram.maxValue / 1000,
      count: this.histogram.totalCount,
    };
  }
}
