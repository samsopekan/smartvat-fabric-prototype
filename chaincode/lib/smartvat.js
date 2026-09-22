'use strict';
/*
 * Smart VAT chaincode. Implements the nine functions in Table 2 of the manuscript.
 * Money is held as integer kobo (1 naira = 100 kobo) so that arithmetic is exact and deterministic.
 * Simplifications, stated so that they can be reported:
 *  - the invoice document itself lives off-chain (IPFS/DSN in the design); only its SHA-256 hash is stored here;
 *  - buyCoin() records a VATCoin purchase; the fiat leg at the bank is outside the chaincode;
 *  - roles are enforced by MSP (TaxAuthorityMSP, BankMSP) and, for VEPs, by the client identity registered in addVEP().
 */
const { Contract } = require('fabric-contract-api');

const VAT_RATE_PER_MILLE = 75; // 7.5%
const TA_MSP = 'TaxAuthorityMSP';
const BANK_MSP = 'BankMSP';

class SmartVatContract extends Contract {
    constructor() { super('SmartVatContract'); }

    // ---------- helpers ----------
    _requireMsp(ctx, msp) {
        const got = ctx.clientIdentity.getMSPID();
        if (got !== msp) { throw new Error(`caller MSP ${got} is not authorised; ${msp} required`); }
    }
    async _get(ctx, key) {
        const b = await ctx.stub.getState(key);
        return b && b.length ? JSON.parse(b.toString()) : null;
    }
    async _put(ctx, key, obj) { await ctx.stub.putState(key, Buffer.from(JSON.stringify(obj))); }
    async _requireVep(ctx, tin) {
        const vep = await this._get(ctx, `VEP:${tin}`);
        if (!vep) { throw new Error(`VEP ${tin} is not registered`); }
        if (vep.clientId !== ctx.clientIdentity.getID()) { throw new Error(`caller is not the registered identity of VEP ${tin}`); }
        return vep;
    }
    _vat(amountKobo) { return Math.round(amountKobo * VAT_RATE_PER_MILLE / 1000); }
    _posInt(v, name) {
        const n = Number(v);
        if (!Number.isInteger(n) || n <= 0) { throw new Error(`${name} must be a positive integer (kobo)`); }
        return n;
    }

    // 1. addVEP() - Tax Authority
    async addVEP(ctx, tin, name, clientId) {
        this._requireMsp(ctx, TA_MSP);
        if (await this._get(ctx, `VEP:${tin}`)) { throw new Error(`VEP ${tin} already registered`); }
        await this._put(ctx, `VEP:${tin}`, { tin, name, clientId, registeredTx: ctx.stub.getTxID() });
        await this._put(ctx, `COIN:${tin}`, { tin, balance: 0 });
        return JSON.stringify({ tin });
    }

    // 2. buyCoin() - Selling VEP
    async buyCoin(ctx, tin, amountKobo) {
        await this._requireVep(ctx, tin);
        const amt = this._posInt(amountKobo, 'amount');
        const coin = await this._get(ctx, `COIN:${tin}`);
        coin.balance += amt;
        await this._put(ctx, `COIN:${tin}`, coin);
        return JSON.stringify(coin);
    }

    // 3. addInforInvoice() - Selling VEP
    async addInforInvoice(ctx, invoiceId, sellerTin, buyerTin, amountKobo, invoiceHash, period) {
        await this._requireVep(ctx, sellerTin);
        if (!(await this._get(ctx, `VEP:${buyerTin}`))) { throw new Error(`buyer ${buyerTin} is not registered`); }
        if (await this._get(ctx, `INV:${invoiceId}`)) { throw new Error(`invoice ${invoiceId} already exists`); }
        if (!/^[0-9a-f]{64}$/.test(invoiceHash)) { throw new Error('invoiceHash must be a SHA-256 hex digest'); }
        const amount = this._posInt(amountKobo, 'amount');
        const inv = { invoiceId, sellerTin, buyerTin, amount, vat: this._vat(amount), invoiceHash, period, status: 'PENDING' };
        await this._put(ctx, `INV:${invoiceId}`, inv);
        return JSON.stringify(inv);
    }

    // 4. agreeFromBVEP() - Buying VEP verifies the invoice
    async agreeFromBVEP(ctx, invoiceId, invoiceHash) {
        const inv = await this._get(ctx, `INV:${invoiceId}`);
        if (!inv) { throw new Error(`invoice ${invoiceId} not found`); }
        await this._requireVep(ctx, inv.buyerTin);
        if (inv.status !== 'PENDING') { throw new Error(`invoice ${invoiceId} is ${inv.status}`); }
        if (inv.invoiceHash !== invoiceHash) { throw new Error('hash of the retrieved invoice does not match the ledger'); }
        inv.status = 'BUYER_AGREED';
        await this._put(ctx, `INV:${invoiceId}`, inv);
        return JSON.stringify(inv);
    }

    // 5. agreeFromSVEP() - Selling VEP confirms; VAT is computed and remitted in VATCoin (equations 2 and 3)
    async agreeFromSVEP(ctx, invoiceId) {
        const inv = await this._get(ctx, `INV:${invoiceId}`);
        if (!inv) { throw new Error(`invoice ${invoiceId} not found`); }
        await this._requireVep(ctx, inv.sellerTin);
        if (inv.status !== 'BUYER_AGREED') { throw new Error(`invoice ${invoiceId} is ${inv.status}; buyer must agree first`); }
        const coin = await this._get(ctx, `COIN:${inv.sellerTin}`);
        if (coin.balance < inv.vat) { throw new Error(`insufficient VATCoin: need ${inv.vat}, have ${coin.balance}`); }
        coin.balance -= inv.vat;
        await this._put(ctx, `COIN:${inv.sellerTin}`, coin);
        inv.status = 'CONFIRMED';
        await this._put(ctx, `INV:${invoiceId}`, inv);
        // index entries so that PNVR can be assembled without a hot accumulator key
        const v = Buffer.from(String(inv.vat));
        await ctx.stub.putState(ctx.stub.createCompositeKey('REM', [inv.period, inv.sellerTin, 'S', invoiceId]), v);
        await ctx.stub.putState(ctx.stub.createCompositeKey('REM', [inv.period, inv.buyerTin, 'P', invoiceId]), v);
        return JSON.stringify(inv);
    }

    async _sum(ctx, period, tin, side) {
        let total = 0, count = 0;
        const it = await ctx.stub.getStateByPartialCompositeKey('REM', [period, tin, side]);
        for (let r = await it.next(); !r.done; r = await it.next()) { total += Number(r.value.value.toString()); count++; }
        await it.close();
        return { total, count };
    }

    // 6. requestForPNVR() - Tax Authority assembles the Periodic Net VAT Remittance (equation 4)
    async requestForPNVR(ctx, tin, period) {
        this._requireMsp(ctx, TA_MSP);
        const s = await this._sum(ctx, period, tin, 'S');
        const p = await this._sum(ctx, period, tin, 'P');
        const rec = { tin, period, outputVat: s.total, inputVat: p.total, pnvr: s.total - p.total, salesInvoices: s.count, purchaseInvoices: p.count, status: 'REQUESTED' };
        await this._put(ctx, `PNVR:${period}:${tin}`, rec);
        return JSON.stringify(rec);
    }

    // 7. agreePNVR() - Tax Authority; declaredMvpKobo is the VEP's own month-end figure (equation 1); equation 5 must hold
    async agreePNVR(ctx, tin, period, declaredMvpKobo) {
        this._requireMsp(ctx, TA_MSP);
        const rec = await this._get(ctx, `PNVR:${period}:${tin}`);
        if (!rec) { throw new Error('PNVR has not been requested'); }
        const declared = Number(declaredMvpKobo);
        if (declared !== rec.pnvr) { throw new Error(`equation (5) fails: declared ${declared} != PNVR ${rec.pnvr}; use disagreePNVR`); }
        rec.status = 'AGREED'; rec.declaredMvp = declared; delete rec.divergence;
        await this._put(ctx, `PNVR:${period}:${tin}`, rec);
        return JSON.stringify(rec);
    }

    // 8. disagreePNVR() - Tax Authority flags an anomaly
    async disagreePNVR(ctx, tin, period, declaredMvpKobo) {
        this._requireMsp(ctx, TA_MSP);
        const rec = await this._get(ctx, `PNVR:${period}:${tin}`);
        if (!rec) { throw new Error('PNVR has not been requested'); }
        const declared = Number(declaredMvpKobo);
        rec.status = 'DISPUTED'; rec.declaredMvp = declared; rec.divergence = rec.pnvr - declared;
        await this._put(ctx, `PNVR:${period}:${tin}`, rec);
        return JSON.stringify(rec);
    }

    // 9. getInforPNVR() - Bank reads PNVR status to trigger disbursement (read-only)
    async getInforPNVR(ctx, tin, period) {
        this._requireMsp(ctx, BANK_MSP);
        const rec = await this._get(ctx, `PNVR:${period}:${tin}`);
        if (!rec) { throw new Error('PNVR not found'); }
        return JSON.stringify(rec);
    }

    // returns the caller's identity string, which the tax authority records in addVEP()
    async whoAmI(ctx) { return ctx.clientIdentity.getID(); }

    // convenience read used by the tax authority to trace an anomaly
    async getInvoice(ctx, invoiceId) {
        const inv = await this._get(ctx, `INV:${invoiceId}`);
        if (!inv) { throw new Error(`invoice ${invoiceId} not found`); }
        return JSON.stringify(inv);
    }
}
module.exports = { SmartVatContract };
