# DiplomaChain - Plateforme Blockchain d'Emission et de Verification de Diplomes

Projet de fin de module **Technologie Blockchain** (ENSA Fes, Universite Sidi Mohamed Ben Abdellah, encadrant : Pr. Said Hraoui).

DiplomaChain implemente une architecture hybride **on-chain / off-chain** conforme au RGPD permettant aux institutions academiques d'emettre des diplomes infalsifiables, aux etudiants de partager un QR code ou un justificatif W3C Verifiable Credential, et a tout tiers (employeur, universite, administration) de verifier un diplome publiquement **sans compte ni wallet**.

## Architecture du depot

```text
diploma-chain/
├── contracts/
│   └── DiplomaRegistry.sol       # Smart contract Solidity 0.8.24 (OpenZeppelin AccessControl, Pausable, ReentrancyGuard, ECDSA)
├── test/
│   └── DiplomaRegistry.test.js   # 16 tests unitaires (100 % fonctions & lignes, 84,38 % branches)
├── scripts/
│   ├── deploy.js                 # Deploiement local ou Sepolia + synchro ABI/adresse
│   ├── seed.js                   # Generation de 4 vrais PDF + emission/signature + 1 revocation
│   ├── e2e_test.js               # 6 tests d'integration full-stack (blockchain + API + RGPD + W3C VC)
│   └── start-demo.sh             # Lancement reproductible de la stack complete en 1 commande
├── backend/
│   └── src/server.js             # Serveur Express off-chain (PDF, JSON, SHA-256, W3C VC, RGPD Art. 17)
├── frontend/
│   └── src/                      # dApp React 18 + Vite + TailwindCSS + ethers.js v6 (F6, F7, F8, F9)
├── docs/
│   └── rapport_diplomachain.tex  # Source LaTeX du rapport technique
├── hardhat.config.js             # Configuration Solidity 0.8.24, localhost et Sepolia
└── .env.example                  # Variables d'environnement Sepolia / Backend / IPFS
```

## Prerequis

- Node.js >= 18.x et npm >= 9.x
- MetaMask (optionnel : un mode demonstration local connecte aux comptes Hardhat est integre sans cle privee dans le frontend)

## Installation

```bash
npm install
(cd backend && npm install)
(cd frontend && npm install)
```

## Compilation, tests et couverture

```bash
# Compiler le smart contract
npm run compile

# Executer les 16 tests unitaires avec rapport de gas
npm run test:gas

# Mesurer la couverture de code (objectif >= 80 %)
npm run coverage
```

Resultats verifies :
- **Tests unitaires** : 16/16 passes (825 ms)
- **Couverture** : 100 % Statements, 84,38 % Branches, 100 % Functions, 100 % Lines
- **Tests E2E full-stack** : 6/6 passes

## Lancement de la demonstration locale (1 commande)

```bash
./scripts/start-demo.sh
```

Le script demarre automatiquement le nœud Hardhat (`http://127.0.0.1:8545`), deploie `DiplomaRegistry`, peuple 4 diplomes d'exemple (3 valides signes ECDSA + 1 revoque pour plagiat), lance le serveur off-chain (`http://localhost:4000`) et demarre l'interface React (`http://127.0.0.1:5173`).

## Deploiement sur Testnet Sepolia

1. Copier `.env.example` vers `.env` et renseigner `SEPOLIA_RPC_URL` et `DEPLOYER_PRIVATE_KEY` (compte finance via un faucet Sepolia).
2. Executer :
```bash
npm run deploy:sepolia
```
3. Lancer le backend et le frontend en pointant `VITE_RPC_URL` vers votre endpoint Sepolia.

## Fonctionnalites implementees

- **F1 - F5 (Smart contract)** : emission unitaire (`issueDiploma`), emission signee ECDSA (`issueDiplomaWithProof`), emission par lot bornee (`issueDiplomaBatch`, max 50), revocation motivee (`Error`, `Fraud`, `Plagiarism`, `Other`), verification publique (`verify`, `verifyByHash`), controle d'acces RBAC, pause d'urgence, rotation de cle compromise (`rotateIssuerKey`), evenements indexes (`Issued`, `Revoked`, `IssuerAdded`, `IssuerRemoved`, `IssuerKeyRotated`).
- **F6 - F9 (dApp React)** : espace institution/administration, portefeuille etudiant avec QR code et lien partageable, page publique de verification sans wallet avec hachage SHA-256 cote client (Web Crypto API), historique temps reel des evenements on-chain.
- **Bonus** : signature numerique ECDSA anti-rejeu (`block.chainid` + `address(this)`), export W3C Verifiable Credentials JSON-LD (`/api/vc/:recordId`), droit a l'effacement RGPD Art. 17 (`/api/metadata/:recordId/gdpr-erase`).
