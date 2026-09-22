'use strict';
// prints the benchmark tables from a results file: node report.js results-xxxx.json
const d = JSON.parse(require('fs').readFileSync(process.argv[2] || '../results/reference-run.json'));
const f = (x, n = 1) => x.toFixed(n);
console.log(`run ${d.run}  ${d.started} -> ${d.finished}\n\nSequential, one transaction in flight (ms), n=${d.iter}`);
console.log('function'.padEnd(18) + 'endorse mean'.padStart(14) + 'total mean'.padStart(12) + 'median'.padStart(9) + 'p95'.padStart(8) + 'max'.padStart(8));
for (const [fn, v] of Object.entries(d.sequential)) console.log(fn.padEnd(18) + f(v.endorse.mean).padStart(14) + f(v.total.mean, 0).padStart(12) + f(v.total.median, 0).padStart(9) + f(v.total.p95, 0).padStart(8) + f(v.total.max, 0).padStart(8));
console.log('\nConcurrent bursts (ms, tx/s)');
for (const [fn, v] of Object.entries(d.concurrent)) console.log(fn.padEnd(18) + `in flight ${v.inFlight}`.padEnd(16) + `mean ${f(v.latency.mean, 0)}  p95 ${f(v.latency.p95, 0)}  burst throughput ${f(v.throughputTps.mean)} tx/s`);
console.log('\nrequestForPNVR endorsement time by invoices in the filing period (ms)');
for (const s of d.pnvrScaling) console.log(String(s.invoicesInPeriod).padStart(5) + ' invoices: mean ' + f(s.endorse.mean) + '  max ' + f(s.endorse.max));
