/**
 * The menu-bar/tray icon, drawn procedurally so the app ships no extra image asset:
 * a 16pt ring with a centre dot (a "relay"), rendered at 2x as raw BGRA. On macOS it
 * is a template image, so the system tints it for light/dark menu bars.
 */
export function trayIconBitmap(size = 32): Buffer {
  const buf = Buffer.alloc(size * size * 4);
  const c = (size - 1) / 2;
  const outer = size * 0.44;
  const inner = size * 0.3;
  const dot = size * 0.14;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const d = Math.hypot(x - c, y - c);
      // 1px anti-aliased edges.
      const ring = Math.min(Math.max(outer - d + 0.5, 0), 1) * Math.min(Math.max(d - inner + 0.5, 0), 1);
      const centre = Math.min(Math.max(dot - d + 0.5, 0), 1);
      const alpha = Math.round(255 * Math.max(ring, centre));
      const i = (y * size + x) * 4;
      buf[i] = 0; // B
      buf[i + 1] = 0; // G
      buf[i + 2] = 0; // R
      buf[i + 3] = alpha;
    }
  }
  return buf;
}
