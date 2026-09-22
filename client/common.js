'use strict';
const grpc = require('@grpc/grpc-js');
const { connect, signers } = require('@hyperledger/fabric-gateway');
const crypto = require('crypto'); const fs = require('fs'); const path = require('path');
const ORGS = process.env.ORGS_DIR || path.join(__dirname, '..', 'network', 'organizations');
const PEERS = { ta: { d: 'ta.vat.example.com', ep: 'localhost:7051' }, vep: { d: 'vep.vat.example.com', ep: 'localhost:8051' } };
const first = (dir) => path.join(dir, fs.readdirSync(dir)[0]);

// who: {org domain key for identity, msp, user, via: which peer to connect through}
function open({ domain, msp, user, via }) {
    const p = PEERS[via];
    const tls = fs.readFileSync(path.join(ORGS, 'peerOrganizations', p.d, 'peers', `peer0.${p.d}`, 'tls', 'ca.crt'));
    const client = new grpc.Client(p.ep, grpc.credentials.createSsl(tls));
    const udir = path.join(ORGS, 'peerOrganizations', domain, 'users', `${user}@${domain}`, 'msp');
    const cert = fs.readFileSync(first(path.join(udir, 'signcerts')));
    const key = crypto.createPrivateKey(fs.readFileSync(first(path.join(udir, 'keystore'))));
    const gw = connect({ client, identity: { mspId: msp, credentials: cert }, signer: signers.newPrivateKeySigner(key),
        evaluateOptions: () => ({ deadline: Date.now() + 15000 }), endorseOptions: () => ({ deadline: Date.now() + 30000 }),
        submitOptions: () => ({ deadline: Date.now() + 30000 }), commitStatusOptions: () => ({ deadline: Date.now() + 120000 }) });
    const contract = gw.getNetwork('vatchannel').getContract('smartvat');
    return { gw, client, contract, close() { gw.close(); client.close(); } };
}
const ACTORS = {
    ta:   { domain: 'ta.vat.example.com', msp: 'TaxAuthorityMSP', user: 'User1', via: 'ta' },
    vepA: { domain: 'vep.vat.example.com', msp: 'VEPMSP', user: 'User1', via: 'vep' },
    vepB: { domain: 'vep.vat.example.com', msp: 'VEPMSP', user: 'User2', via: 'vep' },
    bank: { domain: 'bank.vat.example.com', msp: 'BankMSP', user: 'User1', via: 'ta' }, // the bank has no peer; it connects through the tax authority's
};
// timed submit with the endorse / order+commit split
async function timed(contract, fn, args) {
    const t0 = process.hrtime.bigint();
    const tx = await contract.newProposal(fn, { arguments: args.map(String) }).endorse();
    const t1 = process.hrtime.bigint();
    const commit = await tx.submit();
    const status = await commit.getStatus();
    const t2 = process.hrtime.bigint();
    if (!status.successful) throw new Error(`${fn} failed validation: code ${status.code}`);
    return { endorseMs: Number(t1 - t0) / 1e6, commitMs: Number(t2 - t1) / 1e6, totalMs: Number(t2 - t0) / 1e6, result: Buffer.from(tx.getResult()).toString() };
}
async function timedEval(contract, fn, args) {
    const t0 = process.hrtime.bigint();
    const r = await contract.evaluateTransaction(fn, ...args.map(String));
    return { endorseMs: Number(process.hrtime.bigint() - t0) / 1e6, commitMs: 0, totalMs: Number(process.hrtime.bigint() - t0) / 1e6, result: Buffer.from(r).toString() };
}
const sha = (o) => crypto.createHash('sha256').update(JSON.stringify(o)).digest('hex');
module.exports = { open, ACTORS, timed, timedEval, sha };
