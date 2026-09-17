/**
 * Spectrum axis helpers.
 *
 * WHY THIS EXISTS AT ALL
 * The device's `/freq_domain` payload is 1024 Float32 magnitudes and **contains
 * no frequency axis** (measured: PROTOCOL-FINDINGS 4.3). The only thing that
 * turns a bin index into a frequency is `binHz`, which the main process derives
 * from the device sample rate.
 *
 * At 96 kHz with 1024 bins `binHz` is ~94 Hz, so a chart that plotted array
 * indices would be wrong by a factor of ~94 — it would label a 1.5 kHz peak as
 * "bin 16". Every spectrum plot in the app must therefore go through these
 * helpers rather than touching indices directly.
 */

/** `[frequencyHz, magnitude]` pairs, ready for an ECharts value axis. */
export function spectrumPoints(
  magnitudes: readonly number[],
  binHz: number
): Array<[number, number]> {
  const width = Number.isFinite(binHz) && binHz > 0 ? binHz : 0
  return magnitudes.map((magnitude, index) => [
    index * width,
    Number.isFinite(magnitude) ? magnitude : 0
  ])
}

/** Upper bound of the plot: frequency of the last bin. */
export function spectrumMaxHz(magnitudes: readonly number[], binHz: number): number {
  if (magnitudes.length === 0) return 0
  const width = Number.isFinite(binHz) && binHz > 0 ? binHz : 0
  return (magnitudes.length - 1) * width
}

/**
 * Axis tick label: Hz below 1 kHz, kHz above it.
 * Kept coarse on purpose — spectrum axes are read for peak location, not for
 * single-hertz precision.
 */
export function formatHzTick(value: number): string {
  if (!Number.isFinite(value)) return ''
  if (Math.abs(value) >= 1000) {
    const khz = value / 1000
    return `${Number.isInteger(khz) ? khz.toFixed(0) : khz.toFixed(1)}k`
  }
  return `${Math.round(value)}`
}

/** Human label for the plotted span, e.g. "0 – 96 kHz". */
export function spectrumRangeLabel(maxHz: number): string {
  if (!Number.isFinite(maxHz) || maxHz <= 0) return '0 Hz'
  if (maxHz >= 1000) {
    const khz = maxHz / 1000
    return `0 – ${Number.isInteger(khz) ? khz.toFixed(0) : khz.toFixed(1)} kHz`
  }
  return `0 – ${Math.round(maxHz)} Hz`
}
