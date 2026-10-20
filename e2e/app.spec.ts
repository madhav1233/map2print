/**
 * End-to-end: load the built app with every external service mocked by the
 * synthetic city fixture, generate a model, check the report and validate
 * the downloaded STL and 3MF.
 */
import { expect, test, type Page } from '@playwright/test';
import { PNG } from 'pngjs';
import { readFileSync } from 'node:fs';
import { strFromU8, unzipSync } from 'fflate';
import { FIXTURE_BBOX, syntheticOsm, terrariumTileRgba } from '../tests/fixtures/synthetic';
import { parseBinaryStl } from '../src/core/export';

const SHOTS = process.env.SHOTS_DIR ?? 'test-results';

function png(w: number, h: number, rgba: Uint8Array): Buffer {
  const p = new PNG({ width: w, height: h });
  p.data = Buffer.from(rgba);
  return PNG.sync.write(p);
}

const basemapTile = (() => {
  const px = new Uint8Array(256 * 256 * 4);
  for (let i = 0; i < 256 * 256; i++) {
    const x = i % 256;
    const y = Math.floor(i / 256);
    const road = x % 64 < 3 || y % 64 < 3;
    px.set(road ? [255, 255, 255, 255] : [232, 229, 220, 255], i * 4);
  }
  return png(256, 256, px);
})();

async function mockNetwork(page: Page, calls: string[]) {
  await page.route('**/*', async (route) => {
    const url = route.request().url();
    if (url.startsWith('http://localhost')) return route.continue();
    calls.push(url);
    const m = url.match(/terrarium\/(\d+)\/(\d+)\/(\d+)\.png/);
    if (m) {
      const [z, x, y] = m.slice(1).map(Number);
      return route.fulfill({
        status: 200,
        contentType: 'image/png',
        headers: { 'access-control-allow-origin': '*' },
        body: png(256, 256, terrariumTileRgba(z, x, y)),
      });
    }
    if (url.includes('/api/interpreter')) {
      return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(syntheticOsm()) });
    }
    if (url.includes('nominatim')) {
      const c = { lat: (FIXTURE_BBOX.south + FIXTURE_BBOX.north) / 2, lon: (FIXTURE_BBOX.west + FIXTURE_BBOX.east) / 2 };
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify([{ display_name: 'Test City, Western Australia', lat: String(c.lat), lon: String(c.lon), boundingbox: [String(c.lat - 0.005), String(c.lat + 0.005), String(c.lon - 0.005), String(c.lon + 0.005)] }]),
      });
    }
    if (url.includes('basemaps.cartocdn.com')) return route.fulfill({ status: 200, contentType: 'image/png', body: basemapTile });
    return route.abort();
  });
}

test('select, generate, preview and download', async ({ page }) => {
  const calls: string[] = [];
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await mockNetwork(page, calls);
  await page.addInitScript((bbox) => {
    if (!localStorage.getItem('map2print:v1')) localStorage.setItem('map2print:v1', JSON.stringify({ bbox, place: 'Test City' }));
  }, FIXTURE_BBOX);

  await page.goto('/');
  await expect(page.locator('#area-readout')).toContainText('km');
  await page.screenshot({ path: `${SHOTS}/01-map.png` });

  // search re-centres on the result and draws a 2 km square
  await page.fill('#search-input', 'Test City');
  await page.press('#search-input', 'Enter');
  await page.click('#search-results button');
  // the mocked place is ~1.1 km across, so the default square is 1.2× that
  await expect(page.locator('#area-readout')).toHaveText(/^1\.3\d km × 1\.3\d km$/);

  // draw a new area by dragging on the map
  await page.click('#draw-btn');
  const box = (await page.locator('#map').boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5, { steps: 6 });
  await page.mouse.move(box.x + box.width * 0.8, box.y + box.height * 0.82, { steps: 6 });
  await page.mouse.up();
  const drawn = await page.locator('#area-readout').textContent();
  expect(drawn).toMatch(/km × .*km|m × /);
  expect(drawn).not.toMatch(/^1\.3\d km × 1\.3\d km$/);

  // go back to the full fixture area and turn on the heart marker
  await page.evaluate((b) => {
    localStorage.setItem('map2print:v1', JSON.stringify({ bbox: b, place: 'Test City' }));
  }, FIXTURE_BBOX);
  await page.reload();
  await page.check('input[data-layer="marker"]');
  await expect(page.locator('.heart-pin')).toBeVisible();

  await page.click('#generate');
  await expect(page.locator('#results')).toBeVisible({ timeout: 120000 });
  await expect(page.locator('#tab-3d')).toHaveAttribute('aria-selected', 'true');
  const checks = await page.locator('#checks').innerText();
  console.log(checks);
  expect(checks).toContain('Terrain shell is watertight and manifold');
  expect(checks).toMatch(/\d+ buildings extruded/);
  expect(checks).toMatch(/\d+ road segments raised/);
  expect(checks).toContain('water');
  expect(checks).toContain('Multi-colour 3MF available: 6 parts');
  expect(await page.locator('#checks li.bad').count()).toBe(0);
  console.log(await page.locator('#stats').innerText());
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${SHOTS}/02-preview.png` });
  await page.locator('#results').scrollIntoViewIfNeeded();
  await page.locator('#results').screenshot({ path: `${SHOTS}/03-results.png` });

  // exercise the preview's orbit controls
  const pv = (await page.locator('#preview').boundingBox())!;
  await page.mouse.move(pv.x + pv.width / 2, pv.y + pv.height / 2);
  await page.mouse.down();
  await page.mouse.move(pv.x + pv.width / 2 + 160, pv.y + pv.height / 2 - 40, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${SHOTS}/04-orbit.png` });

  // downloads
  const [stlDl] = await Promise.all([page.waitForEvent('download'), page.click('#dl-stl')]);
  expect(stlDl.suggestedFilename()).toMatch(/^map2print-test-city-180mm\.stl$/);
  const stl = parseBinaryStl(new Uint8Array(readFileSync((await stlDl.path())!)));
  expect(stl.triangles).toBeGreaterThan(100000);

  await page.selectOption('select[data-slot="parks"]', '4');
  const [mfDl] = await Promise.all([page.waitForEvent('download'), page.click('#dl-3mf')]);
  const files = unzipSync(new Uint8Array(readFileSync((await mfDl.path())!)));
  const cfg = strFromU8(files['Metadata/model_settings.config']);
  expect(cfg).toContain('<metadata key="name" value="Parks &amp; green"/>');
  expect(cfg.match(/key="extruder" value="4"/g)?.length).toBe(2); // water + parks now share slot 4
  expect(strFromU8(files['3D/3dmodel.model'])).toContain('p:path="/3D/Objects/object_1.model"');

  const [zipDl] = await Promise.all([page.waitForEvent('download'), page.click('#dl-zip')]);
  const zip = unzipSync(new Uint8Array(readFileSync((await zipDl.path())!)));
  expect(Object.keys(zip).filter((k) => k.endsWith('.stl')).length).toBe(6);

  expect(calls.some((u) => u.includes('terrarium'))).toBe(true);
  expect(calls.some((u) => u.includes('/api/interpreter'))).toBe(true);
  expect(errors.filter((e) => !/Failed to load resource|ERR_FAILED/.test(e))).toEqual([]);
});

test('mobile layout', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  await mockNetwork(page, []);
  await page.goto('/');
  await expect(page.locator('#area-readout')).toContainText('km');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await page.screenshot({ path: `${SHOTS}/05-mobile.png`, fullPage: true });
  await ctx.close();
});
