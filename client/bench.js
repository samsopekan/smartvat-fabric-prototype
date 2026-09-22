'use strict';
// Latency benchmark for the nine chaincode functions.
// Phase A: sequential, one transaction in flight at a time.
// Phase B: concurrent load, W invoice lifecycles in flight, plus PNVR assembly time as the filing period grows.
const fs = require('fs');
const { open, ACTORS, timed, timedEval, sha } = require('./common');
const ITER = Number(process.env.ITER || 30), W = Number(process.env.W || 20), ROUNDS = Number(process.env.ROUNDS || 10);
const run = Date.now().toString(36), AMT = 100000000; // NGN 1,000,000 in kobo
const stats = (xs) => {
    const s = [...xs].sort((p, q) => p - q), n = s.length, q = (f) => s[Math.min(n - 1, Math.ceil(f * n) - 1)];
    return { n, mean: s.reduce((p, c) => p + c, 0) / n, median: q(0.5), p95: q(0.95), min: s[0], max: s[n - 1] };
};
(async () => {
    const ta = open(ACTORS.ta), a = open(ACTORS.vepA), b = open(ACTORS.vepB), bank = open(ACTORS.bank);
    const idA = (await timedEval(a.contract, 'whoAmI', [])).result, idB = (await timedEval(b.contract, 'whoAmI', [])).result;
    const out = { run, started: new Date().toISOString(), iter: ITER, sequential: {}, concurrent: {}, pnvrScaling: [] };
    const rec = {}; const add = (fn, r) => { (rec[fn] = rec[fn] || []).push(r); };
    const save = () => fs.writeFileSync(`results-${run}.json`, JSON.stringify(out, null, 2));

    // ---------- Phase A ----------
    const A = `A-${run}`, B = `B-${run}`;
    await timed(ta.contract, 'addVEP', [A, 'Seller', idA]); await timed(ta.contract, 'addVEP', [B, 'Buyer', idB]);
    for (let i = 0; i < 3; i++) await timed(a.contract, 'buyCoin', [A, AMT]); // warm-up, not recorded
    for (let i = 0; i < ITER; i++) {
        const inv = `seq-${run}-${i}`, period = `P-${run}-${i}`, h = sha({ inv });
        add('addVEP', await timed(ta.contract, 'addVEP', [`X-${run}-${i}`, 'Registrant', idA]));
        add('buyCoin', await timed(a.contract, 'buyCoin', [A, AMT]));
        add('addInforInvoice', await timed(a.contract, 'addInforInvoice', [inv, A, B, AMT, h, period]));
        add('agreeFromBVEP', await timed(b.contract, 'agreeFromBVEP', [inv, h]));
        add('agreeFromSVEP', await timed(a.contract, 'agreeFromSVEP', [inv]));
        const p = await timed(ta.contract, 'requestForPNVR', [A, period]); add('requestForPNVR', p);
        const pn = JSON.parse(p.result).pnvr;
        add('disagreePNVR', await timed(ta.contract, 'disagreePNVR', [A, period, 0]));
        add('agreePNVR', await timed(ta.contract, 'agreePNVR', [A, period, pn]));
        add('getInforPNVR', await timedEval(bank.contract, 'getInforPNVR', [A, period]));
        if ((i + 1) % 5 === 0) console.log(`phase A ${i + 1}/${ITER}`);
    }
    for (const fn of Object.keys(rec)) {
        out.sequential[fn] = { endorse: stats(rec[fn].map((r) => r.endorseMs)), commit: stats(rec[fn].map((r) => r.commitMs)), total: stats(rec[fn].map((r) => r.totalMs)) };
    }
    save();

    // ---------- Phase B ----------
    const tins = Array.from({ length: W }, (_, k) => `S${k}-${run}`), period = `LOAD-${run}`, crec = {};
    const wave = async (fn, jobs) => {
        const t0 = Date.now(); const rs = await Promise.all(jobs.map((j) => j())); const wall = (Date.now() - t0) / 1000;
        crec[fn] = crec[fn] || { lat: [], tps: [], sizes: new Set() };
        crec[fn].lat.push(...rs.map((r) => r.totalMs)); crec[fn].tps.push(jobs.length / wall); crec[fn].sizes.add(jobs.length);
    };
    await wave('addVEP', tins.map((t) => () => timed(ta.contract, 'addVEP', [t, 'Load seller', idA])));
    await wave('buyCoin', tins.map((t) => () => timed(a.contract, 'buyCoin', [t, AMT * ROUNDS])));
    const marks = new Set([10, 50, 100, 200, 400].filter((m) => m <= W * ROUNDS)); let done = 0;
    for (let r = 0; r < ROUNDS; r++) {
        const ids = tins.map((t, k) => ({ t, inv: `load-${run}-${r}-${k}`, h: sha({ r, k, run }) }));
        await wave('addInforInvoice', ids.map((x) => () => timed(a.contract, 'addInforInvoice', [x.inv, x.t, B, AMT, x.h, period])));
        await wave('agreeFromBVEP', ids.map((x) => () => timed(b.contract, 'agreeFromBVEP', [x.inv, x.h])));
        // confirm in two halves so that the 10-invoice mark can be sampled in round one
        for (const part of [ids.slice(0, 10), ids.slice(10)]) {
            if (!part.length) continue;
            await wave('agreeFromSVEP', part.map((x) => () => timed(a.contract, 'agreeFromSVEP', [x.inv])));
            done += part.length;
            if (marks.has(done)) {
                const xs = []; for (let i = 0; i < 5; i++) xs.push(await timed(ta.contract, 'requestForPNVR', [B, period]));
                out.pnvrScaling.push({ invoicesInPeriod: done, endorse: stats(xs.map((r) => r.endorseMs)), total: stats(xs.map((r) => r.totalMs)), check: JSON.parse(xs[0].result) });
            }
        }
        console.log(`phase B round ${r + 1}/${ROUNDS}`); 
    }
    for (const fn of Object.keys(crec)) out.concurrent[fn] = { inFlight: [...crec[fn].sizes], latency: stats(crec[fn].lat), throughputTps: stats(crec[fn].tps) };
    out.finished = new Date().toISOString(); save();
    console.log('DONE', `results-${run}.json`);
    [ta, a, b, bank].forEach((x) => x.close());
})().catch((e) => { console.error('ERROR', e.message, JSON.stringify(e.details || '')); process.exit(1); });
