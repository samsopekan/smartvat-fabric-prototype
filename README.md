# Smart VAT prototype: chaincode, test network and latency benchmark
[![DOI](https://zenodo.org/badge/1382394700.svg)](https://doi.org/10.5281/zenodo.22905978)
This kit implements the nine smart-contract functions in Table 2 of the manuscript as Hyperledger Fabric chaincode,
starts a small Fabric 2.5 test network, replays the illustrative scenario of Table 3 and measures latency.

## What is in it

|Folder|Contents|
|-|-|
|`chaincode/`|`lib/smartvat.js`: addVEP, buyCoin, addInforInvoice, agreeFromBVEP, agreeFromSVEP, requestForPNVR, agreePNVR, disagreePNVR, getInforPNVR (plus two helpers, whoAmI and getInvoice)|
|`network/`|`network.sh up / down`: one Raft orderer, two peers (Tax Authority, VEP), three organisations (the Bank is a client-only member), TLS on, channel `vatchannel`, chaincode run as a service|
|`client/`|`scenario.js` (Table 3 on the live ledger), `bench.js` (latency and burst throughput), `report.js` (prints the tables)|
|`results/`|`reference-run.json` and `reference-scenario.txt`: output of the reference run described below|

## Requirements

Linux or Windows WSL2 on x86-64, Node.js 18 or later, curl, and about 500 MB of disk. Docker is not needed:
the script downloads the official Fabric 2.5.9 binaries from GitHub and runs them natively.

## Run it

```bash
cd network \&\& ./network.sh up          # about one minute; ends with "network is up"
cd ../client \&\& npm install
node scenario.js                       # about 50 s; should print PNVR NGN 180,000 and divergence NGN 60,000
node bench.js                          # about 10 min; writes results-<id>.json
node report.js results-<id>.json
cd ../network \&\& ./network.sh down     # stops everything and wipes the ledger
```

`ITER`, `W` and `ROUNDS` environment variables change the sample size (default 30), the number of concurrent
sellers (20) and the number of load rounds (10).

## How latency is measured

Each state-changing call is timed in two parts with the Fabric Gateway client API: **endorsement** (proposal sent,
executed by the chaincode on both peers, endorsements returned) and **order + commit** (submission to the orderer
until the commit status comes back from the peer). `getInforPNVR` is a read-only query and has no second part.

## Reference run (19 September 2026)

One laptop: Intel Core i5-8365U at 1.60 GHz, 8 logical processors, 7.7 GB RAM available to Linux,

Ubuntu 26.04 under Windows Subsystem for Linux 2, Node.js 22.22.1.

All nodes and the client on the same host, BatchTimeout 2 s, MaxMessageCount 10, endorsement by both peers.

Raw output: results/my-run.json; printed tables: results/my-report.txt; scenario output: results/my-scenario.txt.

* Sequential, one transaction in flight: about 2,060 ms for every state-changing function, of which endorsement is 13 to 21 ms. The rest is the orderer waiting for BatchTimeout before cutting a block that holds a single transaction.
* Bursts of 10 to 20 transactions: mean latency 95 to 163 ms, about 100 to 130 tx/s.
* getInforPNVR (read-only): about 7 ms.
* requestForPNVR endorsement: 14.4 ms with 10 invoices in the period, 18.7 ms with 100, 28.9 ms with 200.
* Ledger growth: about 5 KB per transaction per peer (4.7 MB block file after 947 transactions).

## Read this 

* A single-host network has no network delay between organisations. The figures are a baseline, not a capacity estimate.
* Simplifications: invoice documents are off-chain and only their SHA-256 hash is stored (no IPFS node is run);
`buyCoin` records a VATCoin purchase without the bank's fiat leg; VEP identities come from `cryptogen`, not from a Fabric CA.
* The chaincode enforces roles: tax-authority and bank functions check the caller's MSP; VEP functions check the caller against the identity registered by `addVEP`.

