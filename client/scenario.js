'use strict';
// Reproduces the illustrative scenario of Section 4.2 / Table 3 on the live network. Amounts are in kobo.
const { open, ACTORS, timed, timedEval, sha } = require('./common');
const N = (naira) => naira * 100, fmt = (k) => 'NGN ' + (k / 100).toLocaleString('en-US');
(async () => {
    const ta = open(ACTORS.ta), a = open(ACTORS.vepA), b = open(ACTORS.vepB), bank = open(ACTORS.bank);
    const run = process.env.RUN || Date.now().toString(36), A = `TIN-A-${run}`, B = `TIN-B-${run}`, period = `2026-09-${run}`;
    const idA = (await timedEval(a.contract, 'whoAmI', [])).result, idB = (await timedEval(b.contract, 'whoAmI', [])).result;
    await timed(ta.contract, 'addVEP', [A, 'Selling VEP A', idA]);
    await timed(ta.contract, 'addVEP', [B, 'Trading partner B', idB]);
    await timed(a.contract, 'buyCoin', [A, N(500000)]); await timed(b.contract, 'buyCoin', [B, N(500000)]);
    const invoices = [['S1', a, b, A, B, 2000000], ['S2', a, b, A, B, 1200000], ['S3', a, b, A, B, 800000], ['P1', b, a, B, A, 1000000], ['P2', b, a, B, A, 600000]];
    for (const [id, seller, buyer, sTin, bTin, naira] of invoices) {
        const h = sha({ id, sTin, bTin, naira, run }), inv = `${id}-${run}`;
        await timed(seller.contract, 'addInforInvoice', [inv, sTin, bTin, N(naira), h, period]);
        await timed(buyer.contract, 'agreeFromBVEP', [inv, h]);
        const r = JSON.parse((await timed(seller.contract, 'agreeFromSVEP', [inv])).result);
        console.log(`${id}: value ${fmt(r.amount)}  VAT ${fmt(r.vat)}  status ${r.status}`);
    }
    const p = JSON.parse((await timed(ta.contract, 'requestForPNVR', [A, period])).result);
    console.log(`requestForPNVR: output ${fmt(p.outputVat)}  input ${fmt(p.inputVat)}  PNVR ${fmt(p.pnvr)}`);
    const mvpHonest = Math.round((N(4000000) - N(1600000)) * 75 / 1000), mvpOmitS3 = Math.round((N(3200000) - N(1600000)) * 75 / 1000);
    console.log(`equation (1): honest MVP ${fmt(mvpHonest)}; MVP with S3 omitted ${fmt(mvpOmitS3)}`);
    try { await timed(ta.contract, 'agreePNVR', [A, period, mvpOmitS3]); console.log('UNEXPECTED: accepted'); } catch (e) { console.log('agreePNVR with under-declared MVP -> rejected by chaincode'); }
    const d = JSON.parse((await timed(ta.contract, 'disagreePNVR', [A, period, mvpOmitS3])).result);
    console.log(`disagreePNVR: status ${d.status}  divergence ${fmt(d.divergence)}`);
    const s3 = JSON.parse((await timedEval(ta.contract, 'getInvoice', [`S3-${run}`])).result);
    console.log(`trace: invoice ${s3.invoiceId} VAT ${fmt(s3.vat)} seller ${s3.sellerTin} buyer ${s3.buyerTin} hash ${s3.invoiceHash.slice(0, 16)}...`);
    const g = JSON.parse((await timed(ta.contract, 'agreePNVR', [A, period, mvpHonest])).result);
    console.log(`agreePNVR with honest MVP: status ${g.status}`);
    console.log('bank getInforPNVR:', (await timedEval(bank.contract, 'getInforPNVR', [A, period])).result);
    try { await timedEval(a.contract, 'getInforPNVR', [A, period]); console.log('UNEXPECTED: allowed'); } catch (e) { console.log('VEP calling getInforPNVR -> rejected (BankMSP required)'); }
    [ta, a, b, bank].forEach((x) => x.close());
})().catch((e) => { console.error('ERROR', e.message, JSON.stringify(e.details || '')); process.exit(1); });
