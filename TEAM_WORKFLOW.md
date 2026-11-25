# Stratégie de répartition Git et collaboration (Équipe de 3 membres)

## 1. Intention et objectif

Conformément au cahier des charges ([ProjetModuleBKC.pdf](../ProjetModuleBKC.pdf), sections **§5 Versionnage**, **§7.d Soutenance** et **§9 Grille d'évaluation**) :
- Le dépôt Git doit refléter **des commits réguliers et significatifs par tous les membres** sur la branche principale (`main`).
- Lors de la soutenance (15 min de présentation + 10 min de questions), **chaque membre doit maîtriser et pouvoir défendre l'ensemble du projet**, tout en ayant la responsabilité claire d'un sous-système.

**Pourquoi ne pas falsifier l'historique Git ?**
Réécrire artificiellement des commits sous le nom d'autres personnes sans qu'elles manipulent leur module expose à un risque élevé lors des questions de soutenance et des revues d'historique (horodatages incohérents, méconnaissance du code).  
La stratégie ci-dessous permet au contraire d'organiser le projet existant en **3 périmètres techniques autonomes**, portés par **3 branches et Pull Requests authentiques**, avec revue croisée et co-signature (`Co-authored-by`) sur les étapes d'intégration.

---

## 2. Répartition des périmètres (3 membres)

| Membre | Périmètre principal | Fichiers & livrables associés | Branche dédiée |
| :--- | :--- | :--- | :--- |
| **Membre 1** | **Smart Contract, Sécurité & Couverture** | `contracts/DiplomaRegistry.sol`, `test/DiplomaRegistry.test.js`, `hardhat.config.js`, `scripts/deploy.js`, rapport gas & couverture (`npm run coverage`) | `feat/smart-contract-security` |
| **Membre 2** | **Serveur Off-Chain, RGPD, W3C VC & Lot (Batch)** | `backend/src/server.js`, `scripts/seed.js`, `scripts/create-demo-batch.js`, `scripts/e2e_test.js`, `demo-batch/` | `feat/backend-rgpd-batch` |
| **Membre 3** | **dApp React, UX/UI, Scripts Démo & Rapport** | `frontend/src/*`, `scripts/start-demo.cmd`, `scripts/start-demo.sh`, `README.md`, `docs/rapport_diplomachain.tex` | `feat/frontend-ux-docs` |

---

## 3. Stratégie d'exécution GitHub (étape par étape)

### Règle préalable pour que GitHub comptabilise chaque membre
GitHub n'affiche un contributeur dans l'onglet **Insights -> Contributors** que si :
1. L'adresse e-mail configurée dans Git (`git config user.email`) correspond à une **adresse e-mail vérifiée** sur son compte GitHub.
2. Les commits sont fusionnés dans la **branche par défaut (`main`)**.

Chaque membre exécute sur son poste :
```bash
git config user.name "Prenom Nom"
git config user.email "email-verifie-github@exemple.com"
```

### Étape 1 — Initialisation par le créateur du dépôt (`main`)
1. Le porteur du dépôt initialise le repo GitHub et pousse le socle initial sur `main` (`README.md`, `.gitignore`, `package.json`, `hardhat.config.js`, `.env.example` — ou le socle de base + son module Smart Contract).
2. Il ajoute les 2 coéquipiers sur GitHub via **Settings -> Collaborators -> Add people**.
3. Il partage le dossier/archive de travail ([diploma-chain.zip](../diploma-chain.zip)) afin que chaque membre dispose en local des fichiers de son périmètre.

### Étape 2 — Création des branches par les membres et Pull Requests
Chaque membre clone le dépôt GitHub, crée sa branche depuis `main`, intègre et vérifie son périmètre, puis pousse vers `origin` :

- **Membre 1 (`feat/smart-contract-security`)** :
  ```bash
  git checkout -b feat/smart-contract-security
  # Vérifier et exécuter : npm test && npm run coverage
  # Ajouter/compléter les tests unitaires ou commentaires NatSpec si besoin
  git add contracts/ test/ scripts/deploy.js hardhat.config.js
  git commit -m "feat(contract): implement DiplomaRegistry with RBAC, ECDSA proofs and key rotation"
  git push -u origin feat/smart-contract-security
  ```
- **Membre 2 (`feat/backend-rgpd-batch`)** :
  ```bash
  git checkout -b feat/backend-rgpd-batch
  # Vérifier : node backend/src/server.js, seed.js, create-demo-batch.js et e2e_test.js
  git add backend/ scripts/seed.js scripts/create-demo-batch.js scripts/e2e_test.js demo-batch/
  git commit -m "feat(backend): add off-chain PDF/metadata API with GDPR erasure, W3C VC and batch E2E"
  git push -u origin feat/backend-rgpd-batch
  ```
- **Membre 3 (`feat/frontend-ux-docs`)** :
  ```bash
  git checkout -b feat/frontend-ux-docs
  # Vérifier : cd frontend && npm run build, et tester start-demo.cmd
  git add frontend/ scripts/start-demo.cmd scripts/start-demo.sh README.md docs/
  git commit -m "feat(frontend): build React dApp with public verifier, student QR wallet, batch UI and report"
  git push -u origin feat/frontend-ux-docs
  ```

### Étape 3 — Revue croisée et co-auteurs (`Co-authored-by`)
1. Chaque membre ouvre une **Pull Request** vers `main` sur GitHub.
2. Un autre membre teste la branche localement, laisse un commentaire de revue (*Approve*) et fusionne la PR (**Merge pull request** ou **Squash and merge**).
3. Pour les commits d'intégration finale (ex. correction de bugs E2E, mise à jour du rapport LaTeX `docs/rapport_diplomachain.tex`, répétition de la démo), utilisez les trailers officiels GitHub :

```text
docs: finalize technical report and team contribution matrix

Co-authored-by: Membre 1 <membre1@exemple.com>
Co-authored-by: Membre 2 <membre2@exemple.com>
Co-authored-by: Membre 3 <membre3@exemple.com>
```

---

## 4. Préparation à la soutenance (Maîtrise transversale)

Avant la soutenance, chaque membre doit savoir expliquer et démontrer en direct :
- **Architecture RGPD** : pourquoi seul le hash SHA-256 et l'URI sont on-chain, et comment `DELETE /api/metadata/:recordId/gdpr-erase` concilie Art. 17 et immuabilité.
- **Sécurité Solidity** : `AccessControl` (`ISSUER_ROLE`, `DEFAULT_ADMIN_ROLE`), `Pausable`, Checks-Effects-Interactions, protection anti-rejeu ECDSA (`block.chainid` + `address(this)`), et rotation multi-sauts (`rotateIssuerKey` + `resolveCurrentIssuer`).
- **Parcours dApp complet** : émission (unitaire ou batch depuis `demo-batch/`), partage étudiant (QR + W3C VC), vérification publique sans wallet, et révocation motivée.
