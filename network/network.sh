#!/bin/bash
# Smart VAT test network: 1 orderer (Raft), 2 peers (Tax Authority, VEP), 3 organisations (+ Bank, client only).
# Runs the native Hyperledger Fabric binaries, so Docker is not needed. Linux or WSL2 (x86-64); Node.js 18+ required.
# usage: ./network.sh up | down
set -e
cd "$(dirname "$0")"; N=$PWD; KIT=$(dirname "$N"); VER=2.5.9
export FABRIC_CFG_PATH=$N/fabric/config
O=$N/organizations; OD=$O/ordererOrganizations/vat.example.com/orderers/orderer.vat.example.com
pd(){ echo $O/peerOrganizations/$1/peers/peer0.$1; }

down(){ for f in run/*.pid; do [ -f "$f" ] && kill $(cat $f) 2>/dev/null || true; done; sleep 2; rm -rf run data logs organizations vat.block smartvat.tgz pkg; echo "network stopped and wiped"; }

up(){
 if [ ! -x fabric/bin/peer ]; then mkdir -p fabric
   curl -sL -o fabric/f.tgz https://github.com/hyperledger/fabric/releases/download/v$VER/hyperledger-fabric-linux-amd64-$VER.tar.gz
   tar xzf fabric/f.tgz -C fabric && rm fabric/f.tgz
   sed -i "s#/opt/hyperledger/ccaas_builder#$N/fabric/builders/ccaas#" fabric/config/core.yaml; fi
 B=$N/fabric/bin; mkdir -p run data logs
 $B/cryptogen generate --config=crypto-config.yaml --output=organizations >/dev/null
 sed "s#__ORG__#$O#g" configtx.template.yaml > configtx.yaml
 FABRIC_CFG_PATH=$N $B/configtxgen -profile VatChannel -outputBlock vat.block -channelID vatchannel >/dev/null 2>&1

 env ORDERER_GENERAL_LISTENADDRESS=0.0.0.0 ORDERER_GENERAL_LISTENPORT=7050 ORDERER_GENERAL_LOCALMSPID=OrdererMSP ORDERER_GENERAL_LOCALMSPDIR=$OD/msp \
  ORDERER_GENERAL_TLS_ENABLED=true ORDERER_GENERAL_TLS_PRIVATEKEY=$OD/tls/server.key ORDERER_GENERAL_TLS_CERTIFICATE=$OD/tls/server.crt ORDERER_GENERAL_TLS_ROOTCAS=[$OD/tls/ca.crt] \
  ORDERER_GENERAL_CLUSTER_CLIENTCERTIFICATE=$OD/tls/server.crt ORDERER_GENERAL_CLUSTER_CLIENTPRIVATEKEY=$OD/tls/server.key ORDERER_GENERAL_CLUSTER_ROOTCAS=[$OD/tls/ca.crt] \
  ORDERER_GENERAL_BOOTSTRAPMETHOD=none ORDERER_CHANNELPARTICIPATION_ENABLED=true ORDERER_ADMIN_TLS_ENABLED=true ORDERER_ADMIN_TLS_CERTIFICATE=$OD/tls/server.crt \
  ORDERER_ADMIN_TLS_PRIVATEKEY=$OD/tls/server.key ORDERER_ADMIN_TLS_ROOTCAS=[$OD/tls/ca.crt] ORDERER_ADMIN_TLS_CLIENTROOTCAS=[$OD/tls/ca.crt] ORDERER_ADMIN_LISTENADDRESS=0.0.0.0:7053 \
  ORDERER_FILELEDGER_LOCATION=$N/data/orderer ORDERER_CONSENSUS_WALDIR=$N/data/orderer/wal ORDERER_CONSENSUS_SNAPDIR=$N/data/orderer/snap ORDERER_OPERATIONS_LISTENADDRESS=127.0.0.1:9443 \
  setsid nohup $B/orderer > logs/orderer.log 2>&1 &
 echo $! > run/orderer.pid
 startpeer(){ P=$(pd $2)
  env CORE_PEER_ID=peer0.$2 CORE_PEER_ADDRESS=localhost:$4 CORE_PEER_LISTENADDRESS=0.0.0.0:$4 CORE_PEER_CHAINCODEADDRESS=localhost:$5 CORE_PEER_CHAINCODELISTENADDRESS=0.0.0.0:$5 \
   CORE_PEER_GOSSIP_EXTERNALENDPOINT=localhost:$4 CORE_PEER_GOSSIP_BOOTSTRAP=localhost:$4 CORE_PEER_LOCALMSPID=$3 CORE_PEER_MSPCONFIGPATH=$P/msp CORE_PEER_TLS_ENABLED=true \
   CORE_PEER_TLS_CERT_FILE=$P/tls/server.crt CORE_PEER_TLS_KEY_FILE=$P/tls/server.key CORE_PEER_TLS_ROOTCERT_FILE=$P/tls/ca.crt CORE_PEER_FILESYSTEMPATH=$N/data/$1 \
   CORE_LEDGER_SNAPSHOTS_ROOTDIR=$N/data/$1/snapshots CORE_OPERATIONS_LISTENADDRESS=127.0.0.1:$6 CORE_VM_ENDPOINT= setsid nohup $B/peer node start > logs/$1.log 2>&1 &
  echo $! > run/$1.pid; }
 startpeer ta ta.vat.example.com TaxAuthorityMSP 7051 7052 9444
 startpeer vep vep.vat.example.com VEPMSP 8051 8052 9445
 sleep 8
 $B/osnadmin channel join --channelID vatchannel --config-block vat.block -o localhost:7053 --ca-file $OD/tls/ca.crt --client-cert $OD/tls/server.crt --client-key $OD/tls/server.key >/dev/null
 export CORE_PEER_TLS_ENABLED=true; CA=$OD/tls/ca.crt
 setorg(){ export CORE_PEER_LOCALMSPID=$2 CORE_PEER_ADDRESS=localhost:$3 CORE_PEER_TLS_ROOTCERT_FILE=$(pd $1)/tls/ca.crt CORE_PEER_MSPCONFIGPATH=$O/peerOrganizations/$1/users/Admin@$1/msp; }
 mkdir -p pkg; echo '{"address":"localhost:9999","dial_timeout":"10s","tls_required":false}' > pkg/connection.json; echo '{"type":"ccaas","label":"smartvat_1.0"}' > pkg/metadata.json
 (cd pkg && tar czf code.tar.gz connection.json && tar czf ../smartvat.tgz metadata.json code.tar.gz)
 for o in "ta.vat.example.com TaxAuthorityMSP 7051" "vep.vat.example.com VEPMSP 8051"; do setorg $o; $B/peer channel join -b vat.block >/dev/null 2>&1; $B/peer lifecycle chaincode install smartvat.tgz >/dev/null 2>&1; done
 CCID=$($B/peer lifecycle chaincode calculatepackageid smartvat.tgz)
 (cd $KIT/chaincode && [ -d node_modules ] || npm install --no-audit --no-fund >/dev/null 2>&1
  cd $KIT/chaincode && setsid nohup node node_modules/.bin/fabric-chaincode-node server --chaincode-address=0.0.0.0:9999 --chaincode-id=$CCID > $N/logs/chaincode.log 2>&1 & echo $! > $N/run/chaincode.pid)
 sleep 4
 for o in "ta.vat.example.com TaxAuthorityMSP 7051" "vep.vat.example.com VEPMSP 8051"; do setorg $o
   $B/peer lifecycle chaincode approveformyorg -o localhost:7050 --tls --cafile $CA -C vatchannel -n smartvat -v 1.0 --package-id $CCID --sequence 1 >/dev/null 2>&1; done
 $B/peer lifecycle chaincode commit -o localhost:7050 --tls --cafile $CA -C vatchannel -n smartvat -v 1.0 --sequence 1 \
   --peerAddresses localhost:7051 --tlsRootCertFiles $(pd ta.vat.example.com)/tls/ca.crt --peerAddresses localhost:8051 --tlsRootCertFiles $(pd vep.vat.example.com)/tls/ca.crt >/dev/null 2>&1
 $B/peer lifecycle chaincode querycommitted -C vatchannel -n smartvat
 echo "network is up. Next: cd ../client && npm install && ORGS_DIR=$O node scenario.js"
}
case "$1" in up) up;; down) down;; *) echo "usage: $0 up|down";; esac
