const { expect } = require("chai");
const { ethers } = require("hardhat");
const crypto = require("crypto");

function sha256Bytes32(input) {
  return "0x" + crypto.createHash("sha256").update(input).digest("hex");
}

describe("DiplomaRegistry", function () {
  let registry;
  let admin, issuer2, newIssuerKey, student1, student2, verifier, attacker;
  const INST_NAME = "ENSA Fes - Universite Sidi Mohamed Ben Abdellah";
  const INST2_NAME = "FST Fes - USMBA";

  beforeEach(async function () {
    [admin, issuer2, newIssuerKey, student1, student2, verifier, attacker] =
      await ethers.getSigners();
    const DiplomaRegistry = await ethers.getContractFactory("DiplomaRegistry");
    registry = await DiplomaRegistry.deploy(INST_NAME);
    await registry.waitForDeployment();
  });

  describe("Deploiement et initialisation", function () {
    it("attribue DEFAULT_ADMIN_ROLE et ISSUER_ROLE au deployeur si un nom est fourni", async function () {
      const adminRole = await registry.DEFAULT_ADMIN_ROLE();
      const issuerRole = await registry.ISSUER_ROLE();
      expect(await registry.hasRole(adminRole, admin.address)).to.equal(true);
      expect(await registry.hasRole(issuerRole, admin.address)).to.equal(true);

      const inst = await registry.getInstitution(admin.address);
      expect(inst.name).to.equal(INST_NAME);
      expect(inst.active).to.equal(true);
      expect(inst.issuedCount).to.equal(0n);

      const registered = await registry.getRegisteredIssuers();
      expect(registered).to.deep.equal([admin.address]);
      expect(await registry.totalDiplomas()).to.equal(0n);
    });

    it("permet un deploiement sans institution initiale si le nom est vide", async function () {
      const DiplomaRegistry = await ethers.getContractFactory("DiplomaRegistry");
      const emptyReg = await DiplomaRegistry.deploy("");
      await emptyReg.waitForDeployment();
      const issuerRole = await emptyReg.ISSUER_ROLE();
      expect(await emptyReg.hasRole(issuerRole, admin.address)).to.equal(false);
      expect(await emptyReg.getRegisteredIssuers()).to.deep.equal([]);
    });
  });

  describe("F4 : Controle d'acces et gestion des emetteurs", function () {
    it("permet a l'admin d'ajouter, retirer puis reactiver un emetteur", async function () {
      const issuerRole = await registry.ISSUER_ROLE();

      await expect(registry.addIssuer(issuer2.address, INST2_NAME))
        .to.emit(registry, "IssuerAdded")
        .withArgs(issuer2.address, INST2_NAME, (v) => v > 0n);

      expect(await registry.hasRole(issuerRole, issuer2.address)).to.equal(true);

      await expect(registry.removeIssuer(issuer2.address))
        .to.emit(registry, "IssuerRemoved")
        .withArgs(issuer2.address, (v) => v > 0n);

      expect(await registry.hasRole(issuerRole, issuer2.address)).to.equal(false);
      expect((await registry.getInstitution(issuer2.address)).active).to.equal(false);

      // Reactivation sans dupliquer l'entree dans _registeredIssuers
      await registry.addIssuer(issuer2.address, INST2_NAME);
      expect(await registry.hasRole(issuerRole, issuer2.address)).to.equal(true);
      const issuers = await registry.getRegisteredIssuers();
      expect(issuers.length).to.equal(2);
    });

    it("refuse les operations d'administration par un compte non-admin", async function () {
      await expect(
        registry.connect(attacker).addIssuer(issuer2.address, INST2_NAME)
      ).to.be.revertedWithCustomError(registry, "AccessControlUnauthorizedAccount");

      await expect(
        registry.connect(attacker).removeIssuer(admin.address)
      ).to.be.revertedWithCustomError(registry, "AccessControlUnauthorizedAccount");

      await expect(
        registry.connect(attacker).pause()
      ).to.be.revertedWithCustomError(registry, "AccessControlUnauthorizedAccount");
    });

    it("valide les entrees lors de l'ajout et du retrait d'emetteurs", async function () {
      await expect(
        registry.addIssuer(ethers.ZeroAddress, INST2_NAME)
      ).to.be.revertedWithCustomError(registry, "ZeroAddress");

      await expect(
        registry.addIssuer(issuer2.address, "")
      ).to.be.revertedWithCustomError(registry, "EmptyInstitutionName");

      await expect(
        registry.addIssuer(admin.address, INST_NAME)
      ).to.be.revertedWithCustomError(registry, "IssuerAlreadyActive");

      await expect(
        registry.removeIssuer(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(registry, "ZeroAddress");

      await expect(
        registry.removeIssuer(issuer2.address)
      ).to.be.revertedWithCustomError(registry, "IssuerNotActive");
    });

    it("gere la rotation de cle d'une institution compromise", async function () {
      await registry.addIssuer(issuer2.address, INST2_NAME);
      const hash = sha256Bytes32("diploma-pdf-content-1");
      await registry
        .connect(issuer2)
        .issueDiploma(student1.address, hash, "http://localhost:4000/api/metadata/1");

      await expect(registry.rotateIssuerKey(issuer2.address, newIssuerKey.address))
        .to.emit(registry, "IssuerKeyRotated")
        .withArgs(issuer2.address, newIssuerKey.address, INST2_NAME, (v) => v > 0n);

      // L'ancienne cle ne peut plus emettre
      await expect(
        registry
          .connect(issuer2)
          .issueDiploma(student2.address, sha256Bytes32("pdf-2"), "http://localhost:4000/api/metadata/2")
      ).to.be.revertedWithCustomError(registry, "AccessControlUnauthorizedAccount");

      // La nouvelle cle peut emettre ET revoquer un diplome emis par l'ancienne cle
      await expect(
        registry
          .connect(newIssuerKey)
          .revokeDiploma(1, 2, "Compromission detectee sur lot precedent")
      ).to.emit(registry, "Revoked");

      // Rotation multi-sauts : newIssuerKey -> verifier, verifier peut revoquer un diplome de issuer2
      const hash3 = sha256Bytes32("diploma-pdf-content-3");
      await registry
        .connect(newIssuerKey)
        .issueDiploma(student1.address, hash3, "http://localhost:4000/api/metadata/3");
      await registry.rotateIssuerKey(newIssuerKey.address, verifier.address);
      expect(await registry.resolveCurrentIssuer(issuer2.address)).to.equal(verifier.address);

      await expect(
        registry
          .connect(newIssuerKey)
          .revokeDiploma(2, 2, "Ancienne cle revoquee")
      ).to.be.revertedWithCustomError(registry, "UnauthorizedRevoker");

      await expect(
        registry
          .connect(verifier)
          .revokeDiploma(2, 2, "Rotation multi-sauts")
      ).to.emit(registry, "Revoked");

      // Re-rotation vers une ancienne cle retiree (verifier -> issuer2) ne doit pas creer de cycle
      const hash4 = sha256Bytes32("diploma-pdf-content-4");
      await registry
        .connect(verifier)
        .issueDiploma(student1.address, hash4, "http://localhost:4000/api/metadata/4");
      await registry.rotateIssuerKey(verifier.address, issuer2.address);
      expect(await registry.resolveCurrentIssuer(issuer2.address)).to.equal(issuer2.address);
      expect(await registry.resolveCurrentIssuer(verifier.address)).to.equal(issuer2.address);
      await expect(
        registry
          .connect(issuer2)
          .revokeDiploma(3, 2, "Re-rotation sans cycle")
      ).to.emit(registry, "Revoked");

      // Validations d'erreur sur rotateIssuerKey
      await expect(
        registry.rotateIssuerKey(ethers.ZeroAddress, attacker.address)
      ).to.be.revertedWithCustomError(registry, "ZeroAddress");
      await expect(
        registry.rotateIssuerKey(newIssuerKey.address, newIssuerKey.address)
      ).to.be.revertedWithCustomError(registry, "SameAddress");
      await expect(
        registry.rotateIssuerKey(verifier.address, attacker.address)
      ).to.be.revertedWithCustomError(registry, "IssuerNotActive");
      await expect(
        registry.rotateIssuerKey(issuer2.address, admin.address)
      ).to.be.revertedWithCustomError(registry, "IssuerAlreadyActive");
    });

    it("bloque les ecritures pendant une pause mais maintient la verification publique", async function () {
      const hash = sha256Bytes32("diploma-pause-test");
      await registry.issueDiploma(student1.address, hash, "ipfs://QmTestPause");

      await registry.pause();
      await expect(
        registry.issueDiploma(student2.address, sha256Bytes32("other"), "ipfs://QmOther")
      ).to.be.revertedWithCustomError(registry, "EnforcedPause");

      await expect(
        registry.revokeDiploma(1, 1, "Erreur")
      ).to.be.revertedWithCustomError(registry, "EnforcedPause");

      // Lecture publique toujours disponible
      const [isValid] = await registry.connect(verifier).verify(1, hash);
      expect(isValid).to.equal(true);

      await registry.unpause();
      await expect(
        registry.issueDiploma(student2.address, sha256Bytes32("other"), "ipfs://QmOther")
      ).to.emit(registry, "Issued");
    });
  });

  describe("F1 & F5 : Emission de diplomes, preuves ECDSA et batch", function () {
    it("emet un diplome standard et emet l'evenement Issued", async function () {
      const hash = sha256Bytes32("PDF-ENSA-FES-2026-001");
      const uri = "http://localhost:4000/api/metadata/1";

      await expect(registry.issueDiploma(student1.address, hash, uri))
        .to.emit(registry, "Issued")
        .withArgs(1n, student1.address, admin.address, hash, uri, (ts) => ts > 0n);

      expect(await registry.totalDiplomas()).to.equal(1n);
      expect(await registry.hashToDiplomaId(hash)).to.equal(1n);
      expect(await registry.getStudentDiplomas(student1.address)).to.deep.equal([1n]);
      expect(await registry.getIssuerDiplomas(admin.address)).to.deep.equal([1n]);

      const d = await registry.getDiploma(1);
      expect(d.student).to.equal(student1.address);
      expect(d.issuer).to.equal(admin.address);
      expect(d.diplomaHash).to.equal(hash);
      expect(d.status).to.equal(1n); // Status.Valid

      const sigInfo = await registry.verifySignature(1);
      expect(sigInfo.hasSignature).to.equal(false);
    });

    it("emet un diplome avec hash de metadonnees et signature ECDSA verifiable", async function () {
      const pdfHash = sha256Bytes32("PDF-SIGNED-2026");
      const metaHash = sha256Bytes32(
        JSON.stringify({ nom: "Yassine Elboukili", intitule: "Ingenieur d'Etat 3IACN", annee: 2026, mention: "Tres Bien" })
      );
      const uri = "http://localhost:4000/api/metadata/1";

      const digest = await registry.getSignatureDigest(pdfHash, metaHash, student1.address);
      const signature = await admin.signMessage(ethers.getBytes(digest));

      await expect(
        registry.issueDiplomaWithProof(student1.address, pdfHash, metaHash, uri, signature)
      ).to.emit(registry, "Issued");

      const [hasSig, isValidSig, signer] = await registry.verifySignature(1);
      expect(hasSig).to.equal(true);
      expect(isValidSig).to.equal(true);
      expect(signer).to.equal(admin.address);
    });

    it("rejette une signature ECDSA invalide ou signee par un tiers", async function () {
      const pdfHash = sha256Bytes32("PDF-BAD-SIG");
      const metaHash = sha256Bytes32("META-BAD-SIG");
      const digest = await registry.getSignatureDigest(pdfHash, metaHash, student1.address);
      const badSignature = await attacker.signMessage(ethers.getBytes(digest));

      await expect(
        registry.issueDiplomaWithProof(
          student1.address,
          pdfHash,
          metaHash,
          "http://localhost:4000/api/metadata/1",
          badSignature
        )
      ).to.be.revertedWithCustomError(registry, "InvalidIssuerSignature");
    });

    it("rejette les entrees invalides et les doublons de hash", async function () {
      const hash = sha256Bytes32("UNIQUE-PDF");
      const uri = "http://localhost:4000/api/metadata/1";

      await expect(
        registry.issueDiploma(ethers.ZeroAddress, hash, uri)
      ).to.be.revertedWithCustomError(registry, "ZeroAddress");

      await expect(
        registry.issueDiploma(student1.address, ethers.ZeroHash, uri)
      ).to.be.revertedWithCustomError(registry, "EmptyHash");

      await expect(
        registry.issueDiploma(student1.address, hash, "")
      ).to.be.revertedWithCustomError(registry, "EmptyURI");

      await expect(
        registry.connect(attacker).issueDiploma(student1.address, hash, uri)
      ).to.be.revertedWithCustomError(registry, "AccessControlUnauthorizedAccount");

      await registry.issueDiploma(student1.address, hash, uri);
      await expect(
        registry.issueDiploma(student2.address, hash, "http://localhost:4000/api/metadata/2")
      )
        .to.be.revertedWithCustomError(registry, "DiplomaAlreadyExists")
        .withArgs(hash, 1n);
    });

    it("emet un lot de diplomes et applique la limite MAX_BATCH_SIZE", async function () {
      const students = [student1.address, student2.address];
      const hashes = [sha256Bytes32("BATCH-1"), sha256Bytes32("BATCH-2")];
      const metaHashes = [sha256Bytes32("MB-1"), sha256Bytes32("MB-2")];
      const uris = ["ipfs://QmBatch1", "ipfs://QmBatch2"];

      await registry.issueDiplomaBatch(students, hashes, metaHashes, uris);
      expect(await registry.totalDiplomas()).to.equal(2n);

      const batchVerify = await registry.verifyByHash(hashes[0]);
      expect(batchVerify.exists).to.equal(true);
      expect(batchVerify.isValid).to.equal(true);
      expect(batchVerify.diplomaId).to.equal(1n);

      // Batch vide
      await expect(
        registry.issueDiplomaBatch([], [], [], [])
      ).to.be.revertedWithCustomError(registry, "InvalidBatchSize");

      // Tailles incoherentes (students, metadataHashes, metadataURIs)
      await expect(
        registry.issueDiplomaBatch([student1.address], hashes, metaHashes, uris)
      ).to.be.revertedWithCustomError(registry, "ArrayLengthMismatch");
      await expect(
        registry.issueDiplomaBatch(students, hashes, [metaHashes[0]], uris)
      ).to.be.revertedWithCustomError(registry, "ArrayLengthMismatch");
      await expect(
        registry.issueDiplomaBatch(students, hashes, metaHashes, [uris[0]])
      ).to.be.revertedWithCustomError(registry, "ArrayLengthMismatch");

      // Depassement MAX_BATCH_SIZE (51)
      const tooManyStudents = Array(51).fill(student1.address);
      const tooManyHashes = Array.from({ length: 51 }, (_, i) => sha256Bytes32(`OVER-${i}`));
      const tooManyUris = Array(51).fill("ipfs://QmOver");
      await expect(
        registry.issueDiplomaBatch(tooManyStudents, tooManyHashes, tooManyHashes, tooManyUris)
      ).to.be.revertedWithCustomError(registry, "InvalidBatchSize");
    });
  });

  describe("F2 : Revocation avec motif", function () {
    let hash;
    beforeEach(async function () {
      hash = sha256Bytes32("PDF-TO-REVOKE");
      await registry.addIssuer(issuer2.address, INST2_NAME);
      await registry
        .connect(issuer2)
        .issueDiploma(student1.address, hash, "http://localhost:4000/api/metadata/1");
    });

    it("permet a l'emetteur de revoquer avec motif et emet Revoked", async function () {
      await expect(
        registry.connect(issuer2).revokeDiploma(1, 3, "Plagiat confirme par commission")
      )
        .to.emit(registry, "Revoked")
        .withArgs(1n, issuer2.address, 3n, "Plagiat confirme par commission", (ts) => ts > 0n);

      const d = await registry.getDiploma(1);
      expect(d.status).to.equal(2n); // Status.Revoked
      expect(d.revocationReason).to.equal(3n); // Plagiarism
      expect(d.revocationDetail).to.equal("Plagiat confirme par commission");
      expect(d.revokedAt).to.be.gt(0n);
    });

    it("permet a l'administrateur de revoquer un diplome d'une autre institution", async function () {
      await expect(
        registry.connect(admin).revokeDiploma(1, 2, "Fraude documentaire avaree")
      ).to.emit(registry, "Revoked");
    });

    it("rejette les revocations non autorisees ou invalides", async function () {
      await expect(
        registry.connect(attacker).revokeDiploma(1, 1, "Tentative pirate")
      ).to.be.revertedWithCustomError(registry, "UnauthorizedRevoker");

      await expect(
        registry.connect(issuer2).revokeDiploma(999, 1, "Inexistant")
      ).to.be.revertedWithCustomError(registry, "DiplomaNotFound");

      await expect(
        registry.connect(issuer2).revokeDiploma(1, 0, "Motif vide")
      ).to.be.revertedWithCustomError(registry, "InvalidRevocationReason");

      await registry.connect(issuer2).revokeDiploma(1, 1, "Erreur de saisie");
      await expect(
        registry.connect(issuer2).revokeDiploma(1, 2, "Double revocation")
      ).to.be.revertedWithCustomError(registry, "DiplomaAlreadyRevoked");
    });

    it("refuse la revocation par une institution dont le role a ete retire", async function () {
      const hash2 = sha256Bytes32("PDF-REMOVED-ISSUER");
      await registry
        .connect(issuer2)
        .issueDiploma(student1.address, hash2, "http://localhost:4000/api/metadata/2");

      await registry.removeIssuer(issuer2.address);
      await expect(
        registry.connect(issuer2).revokeDiploma(2, 1, "Tentative apres retrait")
      ).to.be.revertedWithCustomError(registry, "UnauthorizedRevoker");
    });
  });

  describe("F3 : Verification publique sans compte ni privilegies", function () {
    it("retourne valide, invalide ou revoque selon l'etat reel", async function () {
      const hash = sha256Bytes32("PDF-VERIFY-PUBLIC");
      const fakeHash = sha256Bytes32("PDF-FALSIFIE");
      const uri = "http://localhost:4000/api/metadata/1";
      await registry.issueDiploma(student1.address, hash, uri);

      // 1. Valide via verify(id, hash)
      const resValid = await registry.connect(verifier).verify(1, hash);
      expect(resValid.isValid).to.equal(true);
      expect(resValid.issuer).to.equal(admin.address);
      expect(resValid.status).to.equal(1n);
      expect(resValid.metadataURI).to.equal(uri);

      // 2. Hash falsifie -> invalide
      const resTampered = await registry.connect(verifier).verify(1, fakeHash);
      expect(resTampered.isValid).to.equal(false);
      expect(resTampered.status).to.equal(1n);

      // 3. ID inexistant -> invalide + Status.None
      const resMissing = await registry.connect(verifier).verify(42, hash);
      expect(resMissing.isValid).to.equal(false);
      expect(resMissing.status).to.equal(0n);

      // 4. verifyByHash pour un PDF valide et un PDF inconnu
      const byHashOk = await registry.connect(verifier).verifyByHash(hash);
      expect(byHashOk.exists).to.equal(true);
      expect(byHashOk.diplomaId).to.equal(1n);
      expect(byHashOk.isValid).to.equal(true);

      const byHashUnknown = await registry.connect(verifier).verifyByHash(fakeHash);
      expect(byHashUnknown.exists).to.equal(false);
      expect(byHashUnknown.isValid).to.equal(false);

      // 5. Apres revocation -> isValid = false, status = Revoked
      await registry.revokeDiploma(1, 1, "Erreur sur la mention");
      const resRevoked = await registry.connect(verifier).verify(1, hash);
      expect(resRevoked.isValid).to.equal(false);
      expect(resRevoked.status).to.equal(2n);
      expect(resRevoked.revocationReason).to.equal(1n);

      // Erreurs sur getters pour ID inexistant
      await expect(registry.getDiploma(999)).to.be.revertedWithCustomError(
        registry,
        "DiplomaNotFound"
      );
      await expect(registry.verifySignature(999)).to.be.revertedWithCustomError(
        registry,
        "DiplomaNotFound"
      );
    });
  });
});
