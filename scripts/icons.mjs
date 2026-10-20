// Renders build/*.png from build/icon.svg and build/tray.svg (npm run icons).
import { readFile } from 'node:fs/promises';
import sharp from 'sharp';

const icon = await readFile('build/icon.svg', 'utf8');
// Windows icons have no macOS padding around the squircle.
const iconWin = icon.replace('viewBox="0 0 1024 1024"', 'viewBox="100 100 824 824"');
const tray = await readFile('build/tray.svg');

// Density makes sharp rasterise the vector at the target size instead of upscaling.
const render = (svg, size, out) => {
  const width = Number(String(svg).match(/viewBox="[\d.]+ [\d.]+ ([\d.]+)/)[1]);
  return sharp(Buffer.from(svg), { density: (72 * size) / width }).resize(size, size).png().toFile(out);
};

await Promise.all([
  render(icon, 1024, 'build/icon.png'),
  render(iconWin, 512, 'build/icon-win.png'),
  render(iconWin, 32, 'build/tray-win.png'),
  render(tray, 16, 'build/trayTemplate.png'),
  render(tray, 32, 'build/trayTemplate@2x.png'),
]);
