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
import { hikeGpx } from '../tests/fixtures/gpx';

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
      // follow-up request for whole small relations: return nothing, so the partial path is used
      if (decodeURIComponent(route.request().postData() ?? '').includes('rel(id:'))
        return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '{"elements":[]}' });
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
    if (/tile\.openstreetmap\.org|tile\.opentopomap\.org/.test(url)) return route.fulfill({ status: 200, contentType: 'image/png', body: basemapTile });
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
  expect(checks).toContain('Multi-colour 3MF available: 7 parts');
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
  expect(Object.keys(zip).filter((k) => k.endsWith('.stl')).length).toBe(7);

  expect(calls.some((u) => u.includes('tile.openstreetmap.org'))).toBe(true);
  expect(calls.some((u) => /cartocdn|api[_-]?key|access_token/i.test(u))).toBe(false);
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

test('GPX route keepsake: upload two days, generate, switch to insert, download', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await mockNetwork(page, []);
  await page.goto('/');
  await expect(page.locator('#area-readout')).toContainText('km');

  // add day 2 first: stages must be re-ordered by date
  await page.setInputFiles('#gpx-input', [
    { name: 'day-2.gpx', mimeType: 'application/gpx+xml', buffer: Buffer.from(hikeGpx(2)) },
    { name: 'day-1.gpx', mimeType: 'application/gpx+xml', buffer: Buffer.from(hikeGpx(1)) },
  ]);
  await expect(page.locator('#stages li')).toHaveCount(2);
  await expect(page.locator('#stages li').first()).toContainText('Day 1: Test Trail Day 1');
  await expect(page.locator('#route-total')).toContainText('over 2 days');
  await expect(page.locator('#shape')).toHaveValue('octagon');
  await expect(page.locator('#base-on')).toBeChecked();
  await expect(page.locator('#label-title')).toHaveValue('Test Trail');
  await expect(page.locator('#label-right')).toHaveValue('26–27 Jul 2026');
  await expect(page.locator('li[data-part="route"]')).toBeVisible();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${SHOTS}/06-route-map.png` });

  // optional snow caps and rock
  await expect(page.locator('#snow-option')).toBeHidden();
  await page.check('input[data-layer="snow"]');
  await page.check('input[data-layer="rock"]');
  await expect(page.locator('#snow-option')).toBeVisible();
  await expect(page.locator('#rock-option')).toBeVisible();
  await expect(page.locator('input[data-layer="forest"]')).toBeChecked();

  await page.click('#generate');
  await expect(page.locator('#results')).toBeVisible({ timeout: 120000 });
  let checks = await page.locator('#checks').innerText();
  expect(checks).toMatch(/Snow above [\d,]+ m \(automatic/);
  expect(checks).toContain('A filament change to white at');
  expect(checks).toContain('Rock on slopes over 35°');
  console.log(checks);
  expect(checks).toContain('Route traced as a 1.2 mm ridge across 2 stages');
  expect(checks).toContain('clipped to an octagon');
  expect(checks).toContain('3 labels lying flat on the rim');
  expect(await page.locator('#checks li.bad').count()).toBe(0);
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${SHOTS}/07-route-raised.png` });

  // slot-in insert
  await page.selectOption('#route-style', 'insert');
  await expect(page.locator('#clearance-field')).toBeVisible();
  await page.click('#generate');
  await expect(page.locator('#checks')).toContainText('Route insert 1.2 mm wide', { timeout: 120000 });
  checks = await page.locator('#checks').innerText();
  console.log(checks);
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${SHOTS}/08-route-insert.png` });
  await page.locator('#results').scrollIntoViewIfNeeded();
  await page.locator('#results').screenshot({ path: `${SHOTS}/09-route-results.png` });

  const [insDl] = await Promise.all([page.waitForEvent('download'), page.click('#dl-route')]);
  expect(insDl.suggestedFilename()).toBe('map2print-test-trail-180mm-route-insert.stl');
  const ins = parseBinaryStl(new Uint8Array(readFileSync((await insDl.path())!)));
  expect(ins.triangles).toBeGreaterThan(1000);

  const [mfDl] = await Promise.all([page.waitForEvent('download'), page.click('#dl-3mf')]);
  const files = unzipSync(new Uint8Array(readFileSync((await mfDl.path())!)));
  const cfg = strFromU8(files['Metadata/model_settings.config']);
  for (const name of ['Terrain', 'Water', 'Route insert', 'Base', 'Labels', 'Snow', 'Rock']) expect(cfg).toContain(`value="${name}"`);
  expect(errors).toEqual([]);
});
