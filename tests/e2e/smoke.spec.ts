import { test, expect, chromium } from '@playwright/test';

const WORKER_URL = 'http://localhost:5173';
const API_BASE   = 'http://localhost:8080';

async function waitForLog(
    page: import('@playwright/test').Page,
    pattern: string,
    timeoutMs = 120_000,
): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const lines = await page
            .locator('.log-entry, .log-line, [class*="log"]')
            .allInnerTexts()
            .catch(() => [] as string[]);
        if (lines.join('\n').includes(pattern)) return true;
        await page.waitForTimeout(1000);
    }
    const lines = await page
        .locator('.log-entry, .log-line, [class*="log"]')
        .allInnerTexts()
        .catch(() => [] as string[]);
    console.error(`Timeout waiting for "${pattern}". Last logs:\n${lines.slice(-10).join('\n')}`);
    return false;
}

test('full VRP solve end-to-end', async ({ browser }) => {
    const context = await browser.newContext({ ignoreHTTPSErrors: true });

    // Open two worker tabs
    const page1 = await context.newPage();
    const page2 = await context.newPage();
    page1.on('console', m => { if (m.type() === 'error') console.error('[W1]', m.text()); });
    page2.on('console', m => { if (m.type() === 'error') console.error('[W2]', m.text()); });

    await page1.goto(WORKER_URL, { waitUntil: 'networkidle' });
    await page2.goto(WORKER_URL, { waitUntil: 'networkidle' });

    // Connect both workers
    for (const page of [page1, page2]) {
        const connectBtn = page.locator('button', { hasText: /join swarm/i });
        await connectBtn.waitFor({ timeout: 15_000 });
        await connectBtn.click();
    }

    // Wait for connection
    const [c1, c2] = await Promise.all([
        waitForLog(page1, 'CONNECTED', 30_000).then(ok => ok || waitForLog(page1, 'Grid Orchestrator', 30_000)),
        waitForLog(page2, 'CONNECTED', 30_000).then(ok => ok || waitForLog(page2, 'Grid Orchestrator', 30_000)),
    ]);
    expect(c1, 'Worker 1 failed to connect').toBe(true);
    expect(c2, 'Worker 2 failed to connect').toBe(true);

    // Generate a small (10-stop) problem and dispatch it
    const generateBtn = page1.locator('button', { hasText: /^small$/i });
    await generateBtn.waitFor({ timeout: 5_000 });
    await generateBtn.click();
    await page1.waitForTimeout(500);

    const dispatchBtn = page1.locator('button', { hasText: /dispatch/i });
    await dispatchBtn.waitFor({ timeout: 5_000 });
    await dispatchBtn.click();

    // Extract mission_id from UI logs (30s window)
    let missionId: string | null = null;
    const idDeadline = Date.now() + 30_000;
    while (!missionId && Date.now() < idDeadline) {
        const lines = await page1
            .locator('.log-entry, .log-line, [class*="log"]')
            .allInnerTexts()
            .catch(() => [] as string[]);
        const m = lines.join('\n').match(/Mission ID[:\s]+([a-f0-9\-]{36})/i);
        if (m) missionId = m[1];
        if (!missionId) await page1.waitForTimeout(1000);
    }

    // Fallback: submit directly via API
    if (!missionId) {
        const res = await page1.evaluate(async (apiBase) => {
            const r = await fetch(`${apiBase}/logistics/submit-problem`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    stops: Array.from({ length: 10 }, (_, i) => ({
                        id: `Stop_${i + 1}`,
                        location: { lat: Math.round((-34.6036 + (Math.random() - 0.5) * 0.015) * 1e6), lon: Math.round((-58.5408 + (Math.random() - 0.5) * 0.015) * 1e6) },
                        time_window: { start: 0, end: 86399 }, service_time: 300, demand: 10.0, priority: 1,
                    })),
                    fleet_size: 2, seed: 42,
                    vehicle: { id: 'v1', capacity: 150.0, start_location: { lat: -34603600, lon: -58540800 }, shift_window: { start: 0, end: 86399 }, speed_mps: 10.0 },
                }),
            });
            return r.json();
        }, API_BASE);
        missionId = res.mission_id ?? null;
    }

    expect(missionId, 'No mission_id available').toBeTruthy();
    console.log('Mission ID:', missionId);

    // Wait for matrix worker to pick up the task
    const matrixPicked = await Promise.race([
        waitForLog(page1, 'CALCULATE_MATRIX', 60_000),
        waitForLog(page2, 'CALCULATE_MATRIX', 60_000),
    ]);
    expect(matrixPicked, 'Matrix task not picked up').toBe(true);

    // Wait for VRP solve
    const vrpPicked = await Promise.race([
        waitForLog(page1, 'SOLVE_VRP', 180_000),
        waitForLog(page2, 'SOLVE_VRP', 180_000),
    ]);
    expect(vrpPicked, 'VRP task not picked up').toBe(true);

    await Promise.race([
        waitForLog(page1, 'TASK_COMPLETED', 120_000),
        waitForLog(page2, 'TASK_COMPLETED', 120_000),
    ]);

    // Poll for completed solution
    let solution: any = null;
    const pollDeadline = Date.now() + 120_000;
    while (Date.now() < pollDeadline) {
        solution = await page1.evaluate(async ([base, id]) => {
            try { return await (await fetch(`${base}/get-solution/${id}`)).json(); }
            catch { return null; }
        }, [API_BASE, missionId]);
        if (solution?.status === 'completed') break;
        await page1.waitForTimeout(3000);
    }

    expect(solution?.status, 'Solution not received within timeout').toBe('completed');
    console.log('Solution keys:', Object.keys(solution).join(', '));

    await context.close();
});
