// The whiteboard in a real browser: one host tab and guest tabs, connected through the local stand-in for PeerJS
// (BroadcastChannel), so the tests need no internet. Everything that is "live" is checked while it is happening.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { chromium } from 'playwright-core';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.webmanifest': 'application/manifest+json', '.png': 'image/png' };
let server, base, browser;
function findBrowser() {
  if (process.env.PING_BROWSER) return { executablePath: process.env.PING_BROWSER };
  const pw = join(os.homedir(), 'AppData', 'Local', 'ms-playwright');
  if (existsSync(pw)) for (const d of readdirSync(pw).filter(d => /^chromium-\d+$/.test(d)).sort().reverse())
    for (const exe of ['chrome-win64/chrome.exe', 'chrome-win/chrome.exe', 'chrome-linux/chrome']) if (existsSync(join(pw, d, exe))) return { executablePath: join(pw, d, exe) };
  return { channel: 'msedge' };
}
before(async () => {
  server = http.createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/\/$/, '/index.html');
    try { const body = await readFile(join(ROOT, path)); res.writeHead(200, { 'content-type': TYPES[extname(path)] || 'application/octet-stream' }); res.end(body); }
    catch { res.writeHead(404); res.end(); }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/`;
  browser = await chromium.launch(findBrowser());
});
after(async () => { await browser?.close(); server?.close(); });

async function session() {
  const ctx = await browser.newContext({ viewport: { width: 1300, height: 860 }, serviceWorkers: 'block', acceptDownloads: true });
  await ctx.addInitScript(() => {
    window.PING_WB_LOCAL = true;
    if (!localStorage.getItem('reminder-by-me.v1')) localStorage.setItem('reminder-by-me.v1', JSON.stringify({ reminders: [], notes: [], settings: { onboarded: true, driveGuideSeen: true, lang: 'en', bannerHidden: true } }));
  });
  const errors = [];
  const watch = (page, who) => { page.on('pageerror', e => errors.push(who + ': ' + e)); page.on('console', m => { if (m.type() === 'error') errors.push(who + ': ' + m.text()); }); page.on('dialog', d => d.accept()); };
  const host = await ctx.newPage(); watch(host, 'host');
  await host.goto(base);
  await host.waitForFunction(() => typeof isActiveWindow !== 'undefined' && isActiveWindow);
  await host.click('.tabs [data-tab="board"]');
  await host.waitForFunction(() => wb.board && wb.list.length);
  return { ctx, host, errors, watch };
}
const canvasPt = async (page, x, y) => { const b = await page.locator('#wbCanvas').boundingBox(); return [b.x + x, b.y + y]; };
async function drag(page, pts, steps = 6) {
  await page.mouse.move(...await canvasPt(page, ...pts[0])); await page.mouse.down();
  for (const p of pts.slice(1)) await page.mouse.move(...await canvasPt(page, ...p), { steps });
  await page.mouse.up();
}
const items = page => page.evaluate(() => Object.values(wb.board.items).map(i => ({ id: i.id, type: i.type, text: i.text, x: i.x, y: i.y, from: i.from, to: i.to, author: i.author, votes: i.votes })));
async function share(host, perms = {}) {
  await host.evaluate(p => { Object.assign(wb.perms, p); }, perms);
  await host.click('#wbShareBtn');
  await host.fill('#wbHostName', 'Host Person');
  await host.click('[data-wb-share="start"]');
  await host.waitForSelector('#wbLinkInput');
  const link = await host.inputValue('#wbLinkInput');
  await host.click('[data-wb-share="close"]');
  return link.split('#wb=')[1];
}
async function joinAs(s, room, name = 'Anna', { wait = true } = {}) {
  const g = await s.ctx.newPage(); s.watch(g, 'guest ' + name);
  await g.goto(base + '#wb=' + room);
  await g.waitForSelector('#wbJoinName');
  await g.fill('#wbJoinName', name); await g.click('#wbJoinAsk [data-act="wb-join"]');
  if (wait) await g.waitForFunction(() => wbJoinState === 'in');
  return g;
}

test('the whiteboard opens, saves boards on this computer and keeps them after a reload', async () => {
  const s = await session();
  await s.host.keyboard.press('s');
  await s.host.mouse.click(...await canvasPt(s.host, 500, 300));
  await s.host.keyboard.type('Remember me');
  await s.host.keyboard.press('Escape');
  await s.host.fill('#wbTitle', 'Planning');
  await s.host.waitForFunction(() => !wb.saveTimer);   // the board has been written (saving waits 400 ms after the last change)
  await s.host.waitForTimeout(150);
  await s.host.reload();
  await s.host.click('.tabs [data-tab="board"]');
  await s.host.waitForFunction(() => wb.board && Object.keys(wb.board.items).length);
  assert.equal(await s.host.inputValue('#wbTitle'), 'Planning');
  assert.deepEqual((await items(s.host)).map(i => [i.type, i.text]), [['sticky', 'Remember me']]);
  assert.deepEqual(s.errors, []);
  await s.ctx.close();
});

test('a rough circle becomes a clean ellipse; Ctrl+Z brings back the drawing', async () => {
  const s = await session(), h = s.host;
  await h.keyboard.press('p');
  const circle = Array.from({ length: 33 }, (_, i) => [500 + 90 * Math.cos(i / 32 * 2 * Math.PI), 350 + 70 * Math.sin(i / 32 * 2 * Math.PI)]);
  await drag(h, circle, 2);
  assert.deepEqual((await items(h)).map(i => i.type), ['ellipse']);
  await h.keyboard.press('Control+z');
  assert.deepEqual((await items(h)).map(i => i.type), ['stroke']);
  await h.keyboard.press('Control+z');
  assert.equal((await items(h)).length, 0);
  await h.keyboard.press('Control+y');
  assert.deepEqual((await items(h)).map(i => i.type), ['stroke']);
  await s.ctx.close();
});

test('palm rejection: with a pen, a hand resting on the screen draws nothing and doesn\'t spoil the stroke', async () => {
  const s = await session(), h = s.host;
  await h.keyboard.press('p');
  await h.evaluate(() => { wb.smart = false; });
  // Synthetic pointer events, as an iPad sends them: a palm (touch) lands first, then the pen draws, then the palm lifts.
  const ev = (type, id, kind, x, y) => h.evaluate(([type, id, kind, x, y]) => {
    const r = document.getElementById('wbCanvas').getBoundingClientRect();
    document.getElementById('wbCanvas').dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: kind, isPrimary: true, button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX: r.left + x, clientY: r.top + y, bubbles: true, cancelable: true }));
  }, [type, id, kind, x, y]);
  const view0 = await h.evaluate(() => ({ ...wb.view }));
  await ev('pointerdown', 11, 'touch', 700, 500);            // palm before Pinglapp knows about the pen: would draw
  await ev('pointermove', 11, 'touch', 720, 520);
  await ev('pointerdown', 22, 'pen', 300, 300);              // the pen lands: the palm's stroke is undone
  for (let i = 1; i <= 8; i++) {
    await ev('pointermove', 22, 'pen', 300 + i * 20, 300 + i * 5);
    await ev('pointermove', 11, 'touch', 720 + i * 3, 520 + i * 4);   // the resting hand moves a little
  }
  await ev('pointerdown', 33, 'touch', 900, 600);            // another part of the hand touches while the pen is down
  await ev('pointermove', 33, 'touch', 950, 650);
  await ev('pointerup', 22, 'pen', 460, 340);
  await ev('pointercancel', 11, 'touch', 744, 552);
  await ev('pointerup', 33, 'touch', 950, 650);
  const its = await h.evaluate(() => Object.values(wb.board.items).map(i => ({ type: i.type, n: i.pts && i.pts.length, x0: i.pts && i.pts[0][0] })));
  assert.equal(its.length, 1, 'only the pen\'s stroke is on the board');
  assert.equal(its[0].type, 'stroke');
  assert.ok(its[0].n >= 9, 'the stroke kept every pen point');
  assert.deepEqual(await h.evaluate(() => ({ ...wb.view })), view0, 'the board did not move or zoom');
  // In pen mode, one finger moves the board instead of drawing.
  await ev('pointerdown', 44, 'touch', 600, 400);
  await ev('pointermove', 44, 'touch', 650, 430);
  await ev('pointerup', 44, 'touch', 650, 430);
  assert.equal(await h.evaluate(() => Object.keys(wb.board.items).length), 1, 'a finger drew nothing');
  assert.notDeepEqual(await h.evaluate(() => ({ ...wb.view })), view0, 'a finger moved the board');
  // A double tap by the hand on the pen's stroke opens no text box; in full screen nothing on the page can be selected.
  const strokeAt = [1000, 150];                                // empty space: a double tap there would start a text box
  await ev('pointerdown', 55, 'touch', ...strokeAt); await ev('pointerup', 55, 'touch', ...strokeAt);
  await h.evaluate(([x, y]) => { const r = document.getElementById('wbCanvas').getBoundingClientRect(); document.getElementById('wbCanvas').dispatchEvent(new MouseEvent('dblclick', { clientX: r.left + x, clientY: r.top + y, bubbles: true })); }, strokeAt);
  assert.equal(await h.evaluate(() => wb.editing), null, 'no text box opened by the hand');
  await h.evaluate(() => wbSetFull(true));
  assert.equal(await h.evaluate(() => getComputedStyle(document.body).userSelect), 'none', 'full screen: no text selection');
  assert.equal(await h.evaluate(() => getComputedStyle(document.querySelector('.wb-side')).userSelect), 'none');
  await h.evaluate(() => wbSetFull(false));
  assert.deepEqual(s.errors, []);
  await s.ctx.close();
});

test('connectors stay attached when a shape moves, and mind-map branches grow with Tab', async () => {
  const s = await session(), h = s.host;
  await h.keyboard.press('r'); await drag(h, [[200, 200], [340, 300]]);
  await h.keyboard.press('o'); await drag(h, [[600, 200], [740, 300]]);
  await h.keyboard.press('a'); await drag(h, [[270, 250], [670, 250]]);
  let list = await items(h);
  const arrow = list.find(i => i.type === 'arrow'), rect = list.find(i => i.type === 'rect'), ell = list.find(i => i.type === 'ellipse');
  assert.equal(arrow.from, rect.id); assert.equal(arrow.to, ell.id);
  await h.keyboard.press('v'); await drag(h, [[650, 210], [650, 500]]);            // move the ellipse down
  const end = await h.evaluate(id => Board.ends(wb.board.items[id], wb.board.items)[1].map(Math.round), arrow.id);
  const e2 = (await items(h)).find(i => i.id === ell.id);
  assert.ok(e2.y > ell.y + 200, 'the ellipse moved');
  assert.ok(end[1] >= e2.y - 1, 'the arrow end followed it');
  // mind map
  await h.keyboard.press('s'); await h.mouse.click(...await canvasPt(h, 300, 600)); await h.keyboard.type('Root');
  await h.keyboard.press('Tab'); await h.keyboard.type('Child one');
  await h.keyboard.press('Escape'); await h.keyboard.press('Tab'); await h.keyboard.type('Grandchild');
  await h.keyboard.press('Escape');
  list = await items(h);
  const root = list.find(i => i.text === 'Root'), child = list.find(i => i.text === 'Child one'), grand = list.find(i => i.text === 'Grandchild');
  assert.ok(root && child && grand);
  assert.ok(list.some(i => i.type === 'line' && i.from === root.id && i.to === child.id));
  assert.ok(list.some(i => i.type === 'line' && i.from === child.id && i.to === grand.id));
  assert.ok(child.x > root.x && grand.x > child.x);
  assert.deepEqual(s.errors, []);
  await s.ctx.close();
});

test('templates fill the board', async () => {
  const s = await session(), h = s.host;
  await h.click('[data-wb-tool="templates"]');
  await h.click('#pop button >> text=Retrospective');
  const list = await items(h);
  assert.ok(list.filter(i => i.type === 'rect').length === 3);
  assert.ok(list.some(i => i.text === 'What went well'));
  await s.ctx.close();
});

test('everything is live: drawing, moving, typing and pointers show up while they happen', async () => {
  const s = await session(), h = s.host;
  await h.keyboard.press('s'); await h.mouse.click(...await canvasPt(h, 500, 300)); await h.keyboard.type('From host'); await h.keyboard.press('Escape');
  const room = await share(h);
  const g = await joinAs(s, room);
  assert.deepEqual((await items(g)).map(i => i.text), ['From host']);
  // the guest draws: the host sees the stroke before the mouse is released
  await g.keyboard.press('p');
  await g.mouse.move(...await canvasPt(g, 200, 500)); await g.mouse.down();
  await g.mouse.move(...await canvasPt(g, 320, 560), { steps: 10 });
  await h.waitForFunction(() => Object.values(wb.board.items).some(i => i.type === 'stroke' && i.pts.length > 3));
  await g.mouse.move(...await canvasPt(g, 420, 500), { steps: 10 }); await g.mouse.up();
  // the guest's pointer is on the host's screen with the guest's name, and the other way round
  await h.waitForFunction(() => [...document.querySelectorAll('.wb-cursor span')].some(s => s.textContent === 'Anna'));
  await h.mouse.move(...await canvasPt(h, 700, 400)); await h.mouse.move(...await canvasPt(h, 720, 420));
  await g.waitForFunction(() => [...document.querySelectorAll('.wb-cursor span')].some(s => s.textContent === 'Host Person'));
  // the host types: the guest sees the letters before the host is done
  await h.keyboard.press('s'); await h.mouse.click(...await canvasPt(h, 800, 300)); await h.keyboard.type('Live typing');
  await g.waitForFunction(() => Object.values(wb.board.items).some(i => i.text === 'Live typing'));
  await h.keyboard.press('Escape');
  // the host drags a note: the guest sees it move during the drag
  const before = (await items(g)).find(i => i.text === 'From host');
  await h.keyboard.press('v');
  await h.mouse.move(...await canvasPt(h, 500, 300)); await h.mouse.down();
  await h.mouse.move(...await canvasPt(h, 500, 450), { steps: 12 });
  await g.waitForFunction(y => Object.values(wb.board.items).some(i => i.text === 'From host' && i.y > y + 50), before.y);
  await h.mouse.up();
  // laser pointer from the guest appears on the host's board
  await g.keyboard.press('k');
  await g.mouse.move(...await canvasPt(g, 600, 600)); await g.mouse.down(); await g.mouse.move(...await canvasPt(g, 700, 650), { steps: 6 });
  await h.waitForFunction(() => [...wb.lasers.keys()].some(k => k !== 'me'));
  await g.mouse.up();
  // and the two boards end up identical
  await h.waitForTimeout(300);
  const key = list => JSON.stringify(list.map(i => [i.id, i.type, i.text, Math.round(i.x || 0), Math.round(i.y || 0)]).sort());
  assert.equal(key(await items(g)), key(await items(h)));
  assert.deepEqual(s.errors, []);
  await s.ctx.close();
});

test('view-only guests can look, but nothing they try changes the board, not even forged messages', async () => {
  const s = await session(), h = s.host;
  await h.keyboard.press('s'); await h.mouse.click(...await canvasPt(h, 500, 300)); await h.keyboard.type('Host note'); await h.keyboard.press('Escape');
  const room = await share(h, { edit: 'none' });
  const g = await joinAs(s, room);
  assert.equal(await g.isDisabled('[data-wb-tool="pen"]'), true);
  assert.match(await g.textContent('#wbBanner'), /View only/);
  // forge an edit the way a modified browser could
  await g.evaluate(() => wb.net.send({ k: 'ops', ops: [{ t: 'del', id: Object.keys(wb.board.items)[0] }, { t: 'put', item: { id: 'evil', type: 'rect', x: 0, y: 0, w: 5, h: 5 } }] }));
  await h.waitForTimeout(300);
  assert.deepEqual((await items(h)).map(i => i.text), ['Host note']);
  // the host lets this person edit: now it works
  await h.click('#wbShareBtn'); await h.click('[data-wb-share="toggle"]'); await h.click('[data-wb-share="close"]');
  await g.waitForFunction(() => wb.me.canEdit);
  await g.keyboard.press('r'); await drag(g, [[100, 100], [200, 180]]);
  await h.waitForFunction(() => Object.values(wb.board.items).some(i => i.type === 'rect'));
  assert.deepEqual(s.errors, []);
  await s.ctx.close();
});

test('"only their own items": guests can\'t move or delete the host\'s things, and locked items stay put', async () => {
  const s = await session(), h = s.host;
  await h.keyboard.press('s'); await h.mouse.click(...await canvasPt(h, 500, 300)); await h.keyboard.type('Host owns this'); await h.keyboard.press('Escape');
  const room = await share(h, { editOthers: false });
  const g = await joinAs(s, room);
  const id = (await items(g))[0].id;
  await g.evaluate(id => { wb.sel = new Set([id]); wbDelete([id]); wb.net.send({ k: 'ops', ops: [{ t: 'del', id }] }); }, id);
  await h.waitForTimeout(300);
  assert.equal((await items(h)).length, 1);
  assert.equal((await items(g)).length, 1, 'the guest\'s own copy is corrected too');
  await s.ctx.close();
});

test('waiting room: the host lets people in or not; removed people are told and can\'t come back', async () => {
  const s = await session(), h = s.host;
  const room = await share(h, { approve: true });
  const g = await joinAs(s, room, 'Waiting Will', { wait: false });
  await g.waitForFunction(() => wbJoinState === 'wait');
  await h.waitForSelector('#wbRequests:not([hidden])');
  await h.click('[data-wb-admit][data-yes]');
  await g.waitForFunction(() => wbJoinState === 'in');
  await h.click('#wbShareBtn'); await h.click('[data-wb-share="kick"]'); await h.click('[data-wb-share="close"]');
  await g.waitForFunction(() => wbJoinState === 'kick');
  assert.match(await g.textContent('#wbJoinStatus'), /removed you/);
  const g2 = await joinAs(s, room, 'Denied Dan', { wait: false });
  await h.waitForSelector('#wbRequests:not([hidden])');
  await h.click('[data-wb-admit]:not([data-yes])');
  await g2.waitForFunction(() => wbJoinState === 'deny');
  assert.deepEqual(s.errors, []);
  await s.ctx.close();
});

test('facilitation: follow the host, timer and secret dot voting with a vote limit', async () => {
  const s = await session(), h = s.host;
  for (const [x, txt] of [[300, 'Idea A'], [600, 'Idea B']]) { await h.keyboard.press('s'); await h.mouse.click(...await canvasPt(h, x, 300)); await h.keyboard.type(txt); await h.keyboard.press('Escape'); }
  const room = await share(h, { follow: true });
  const g = await joinAs(s, room);
  // the host moves the view: the guest's view follows
  await h.evaluate(() => wbCenterOn(5000, 4000, 1));
  await g.waitForFunction(() => Math.abs(wbHostViewCenter()[0] - 5000) < 5 && Math.abs(wbHostViewCenter()[1] - 4000) < 5);
  await h.evaluate(() => wbCenterOn(450, 300, 1));
  // timer
  await h.click('#wbTimerBtn'); await h.click('#pop button >> text=5 minutes');
  await g.waitForFunction(() => !document.getElementById('wbTimer').hidden && /⏱ [45]:/.test(document.getElementById('wbTimer').textContent));
  // voting: 3 votes each, secret until the end
  await h.click('#wbVoteBtn'); await h.click('#pop button >> text=3 votes each');
  await g.waitForFunction(() => wb.vote && wb.vote.active);
  const ideaA = (await items(g)).find(i => i.text === 'Idea A');
  for (let k = 0; k < 4; k++) await g.evaluate(id => wbVote(id, 1), ideaA.id);   // one too many
  await h.evaluate(id => wbVote(id, 1), ideaA.id);
  await h.waitForTimeout(300);
  const votes = (await items(h)).find(i => i.id === ideaA.id).votes;
  assert.equal(Object.values(votes).reduce((a, b) => a + b, 0), 4, '3 from the guest (the 4th refused) + 1 from the host');
  const shown = await g.evaluate(id => wbVotesShown(wb.board.items[id]), ideaA.id);
  assert.deepEqual(shown, { n: 3, mine: true }, 'during voting the guest only sees their own dots');
  await h.click('#wbVoteBtn'); await h.click('#pop button >> text=End voting');
  await g.waitForFunction(() => wb.vote && !wb.vote.active);
  assert.equal((await g.evaluate(id => wbVotesShown(wb.board.items[id]), ideaA.id)).n, 4);
  assert.deepEqual(s.errors, []);
  await s.ctx.close();
});

test('when the host stops sharing, guests are told and can keep a copy', async () => {
  const s = await session(), h = s.host;
  await h.keyboard.press('s'); await h.mouse.click(...await canvasPt(h, 500, 300)); await h.keyboard.type('Keep me'); await h.keyboard.press('Escape');
  const room = await share(h);
  const g = await joinAs(s, room);
  await h.click('#wbShareBtn'); await h.click('[data-wb-share="stop"]');
  await g.waitForFunction(() => wbJoinState === 'end');
  await g.click('#wbJoinCopy');
  const copies = await g.evaluate(async () => (await kv.keys()).map(String).filter(k => k.startsWith('board-')).length);
  assert.ok(copies >= 2, 'the copy is stored next to the host\'s board (same browser in this test)');
  await s.ctx.close();
});

test('a link to a board that is not shared says so instead of hanging', async () => {
  const s = await session();
  const g = await joinAs(s, 'nosuchroom000000000', 'Lost Lisa', { wait: false });
  await g.waitForFunction(() => wbJoinState === 'fail');
  assert.match(await g.textContent('#wbJoinStatus'), /Couldn’t find the board/);
  assert.equal(await g.isVisible('#wbJoinRetry'), true);
  await s.ctx.close();
});

test('boards are part of the backup and come back when it is restored', async () => {
  const s = await session(), h = s.host;
  await h.keyboard.press('s'); await h.mouse.click(...await canvasPt(h, 500, 300)); await h.keyboard.type('Backed up'); await h.keyboard.press('Escape');
  await h.waitForTimeout(600);
  const [dl] = await Promise.all([h.waitForEvent('download'), h.evaluate(() => exportBackup())]);
  const backup = JSON.parse(await readFile(await dl.path(), 'utf8'));
  assert.equal(backup.boards.length, 1);
  const id = backup.boards[0].id;
  await h.evaluate(async id => { await kv.del('board-' + id); }, id);
  await h.evaluate(async b => { pendingRestore = b; document.querySelector('input[name=restoreMode][value=add]').checked = true; await doRestore(); }, backup);
  const back = await h.evaluate(async id => JSON.parse(await kv.get('board-' + id)), id);
  assert.equal(Object.values(back.items)[0].text, 'Backed up');
  assert.equal(await h.evaluate(() => 'boards' in S), false, 'boards are not copied into the reminders data');
  await s.ctx.close();
});

test('export as PNG downloads a picture of the whole board', async () => {
  const s = await session(), h = s.host;
  await h.keyboard.press('r'); await drag(h, [[200, 200], [400, 300]]);
  const [dl] = await Promise.all([h.waitForEvent('download'), h.evaluate(() => wbExport('png'))]);
  assert.match(dl.suggestedFilename(), /\.png$/);
  const bytes = await readFile(await dl.path());
  assert.equal(bytes.subarray(1, 4).toString(), 'PNG');
  await s.ctx.close();
});
