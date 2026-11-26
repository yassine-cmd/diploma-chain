// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/**
 * @title DiplomaRegistry
 * @notice Registre blockchain d'emission, de verification et de revocation de diplomes academiques.
 * @dev Conforme RGPD : aucune donnee personnelle en clair n'est stockee on-chain.
 *      Seuls les empreintes cryptographiques (SHA-256 du PDF et hash des metadonnees),
 *      les adresses publiques, les horodatages, le statut et l'URI off-chain sont ancres.
 */
contract DiplomaRegistry is AccessControl, Pausable, ReentrancyGuard {
    using ECDSA for bytes32;
    using MessageHashUtils for bytes32;

    /// @notice Role attribue aux institutions academiques autorisees a emettre des diplomes.
    bytes32 public constant ISSUER_ROLE = keccak256("ISSUER_ROLE");

    /// @notice Taille maximale autorisee pour une emission par lot (protection gas / DoS).
    uint256 public constant MAX_BATCH_SIZE = 50;

    /// @notice Statut du cycle de vie d'un diplome.
    enum Status {
        None,
        Valid,
        Revoked
    }

    /// @notice Motif structure de revocation d'un diplome.
    enum RevocationReason {
        None,
        Error,
        Fraud,
        Plagiarism,
        Other
    }

    /// @notice Structure on-chain compacte (packing de slots pour reduire le cout en gas).
    struct Diploma {
        address student;
        uint64 issuedAt;
        Status status;
        RevocationReason revocationReason;
        address issuer;
        uint64 revokedAt;
        bytes32 diplomaHash;
        bytes32 metadataHash;
        string metadataURI;
        string revocationDetail;
        bytes issuerSignature;
    }

    /// @notice Metadonnees publiques d'une institution enregistree.
    struct InstitutionInfo {
        string name;
        bool active;
        uint64 registeredAt;
        uint64 revokedAt;
        uint256 issuedCount;
    }

    // --- Etat du contrat ---
    uint256 private _nextDiplomaId = 1;

    mapping(uint256 => Diploma) private _diplomas;
    mapping(bytes32 => uint256) public hashToDiplomaId;
    mapping(address => uint256[]) private _studentDiplomas;
    mapping(address => uint256[]) private _issuerDiplomas;
    mapping(address => InstitutionInfo) private _institutions;
    mapping(address => address) public rotatedIssuerTo;
    address[] private _registeredIssuers;

    // --- Erreurs personnalisees (economie de gas) ---
    error ZeroAddress();
    error EmptyHash();
    error EmptyURI();
    error EmptyInstitutionName();
    error DiplomaAlreadyExists(bytes32 diplomaHash, uint256 existingId);
    error DiplomaNotFound(uint256 diplomaId);
    error DiplomaAlreadyRevoked(uint256 diplomaId);
    error UnauthorizedRevoker(address caller, uint256 diplomaId);
    error IssuerAlreadyActive(address issuer);
    error IssuerNotActive(address issuer);
    error InvalidBatchSize(uint256 size);
    error ArrayLengthMismatch();
    error InvalidRevocationReason();
    error InvalidIssuerSignature();
    error SameAddress();

    // --- Evenements (F5 : indexation et tracabilite) ---
    event Issued(
        uint256 indexed diplomaId,
        address indexed student,
        address indexed issuer,
        bytes32 diplomaHash,
        string metadataURI,
        uint64 issuedAt
    );

    event Revoked(
        uint256 indexed diplomaId,
        address indexed revokedBy,
        RevocationReason reason,
        string reasonDetail,
        uint64 revokedAt
    );

    event IssuerAdded(
        address indexed issuer,
        string name,
        uint64 timestamp
    );

    event IssuerRemoved(
        address indexed issuer,
        uint64 timestamp
    );

    event IssuerKeyRotated(
        address indexed oldIssuer,
        address indexed newIssuer,
        string name,
        uint64 timestamp
    );

    /**
     * @notice Initialise le registre avec l'administrateur et optionnellement une premiere institution.
     * @param initialInstitutionName Nom de l'institution initiale (ex: "ENSA Fes - USMBA").
     */
    constructor(string memory initialInstitutionName) {
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);

        if (bytes(initialInstitutionName).length > 0) {
            _addIssuerInternal(msg.sender, initialInstitutionName);
        }
    }

    // =========================================================================
    //  GESTION DES EMETTEURS & SECURITE (F4 + Rotation de cles)
    // =========================================================================

    /**
     * @notice Ajoute une institution autorisee a emettre des diplomes.
     */
    function addIssuer(
        address issuer,
        string calldata name
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _addIssuerInternal(issuer, name);
    }

    /**
     * @notice Retire le droit d'emission a une institution. Les diplomes deja emis restent consultables.
     */
    function removeIssuer(address issuer) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (issuer == address(0)) revert ZeroAddress();
        if (!_institutions[issuer].active) revert IssuerNotActive(issuer);

        _institutions[issuer].active = false;
        _institutions[issuer].revokedAt = uint64(block.timestamp);
        _revokeRole(ISSUER_ROLE, issuer);

        emit IssuerRemoved(issuer, uint64(block.timestamp));
    }

    /**
     * @notice Procedure de rotation d'urgence en cas de compromission de la cle d'une institution.
     * @dev Revoque l'ancienne cle, active la nouvelle sous le meme nom institutionnel et transfere
     *      la capacite de revocation sur les diplomes precedents.
     */
    function rotateIssuerKey(
        address oldIssuer,
        address newIssuer
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (oldIssuer == address(0) || newIssuer == address(0)) revert ZeroAddress();
        if (oldIssuer == newIssuer) revert SameAddress();
        if (!_institutions[oldIssuer].active) revert IssuerNotActive(oldIssuer);
        if (_institutions[newIssuer].active) revert IssuerAlreadyActive(newIssuer);

        string memory instName = _institutions[oldIssuer].name;

        // Effects avant toute autre operation
        _institutions[oldIssuer].active = false;
        _institutions[oldIssuer].revokedAt = uint64(block.timestamp);
        _revokeRole(ISSUER_ROLE, oldIssuer);
        rotatedIssuerTo[oldIssuer] = newIssuer;
        delete rotatedIssuerTo[newIssuer];

        _addIssuerInternal(newIssuer, instName);

        emit IssuerKeyRotated(oldIssuer, newIssuer, instName, uint64(block.timestamp));
    }

    /**
     * @notice Suspend temporairement les emissions et revocations en cas d'incident critique.
     */
    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _pause();
    }

    /**
     * @notice Reactive les operations apres resolution de l'incident.
     */
    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    // =========================================================================
    //  EMISSION DE DIPLOMES (F1 + Batch F4 + Signature numerique Bonus)
    // =========================================================================

    /**
     * @notice F1 : Emet un diplome et ancre son empreinte SHA-256 on-chain.
     * @param student Adresse Ethereum du diplome.
     * @param diplomaHash Hash SHA-256 (32 octets) du fichier PDF du diplome.
     * @param metadataURI URI off-chain pointant vers les metadonnees (serveur / IPFS).
     * @return diplomaId Identifiant unique attribue au diplome.
     */
    function issueDiploma(
        address student,
        bytes32 diplomaHash,
        string calldata metadataURI
    ) external onlyRole(ISSUER_ROLE) whenNotPaused nonReentrant returns (uint256 diplomaId) {
        diplomaId = _issueDiploma(student, diplomaHash, bytes32(0), metadataURI, "");
    }

    /**
     * @notice F1 etendu (Bonus) : Emet un diplome avec hash des metadonnees et signature ECDSA.
     * @param student Adresse Ethereum du diplome.
     * @param diplomaHash Hash SHA-256 du PDF.
     * @param metadataHash Hash SHA-256/keccak256 des metadonnees off-chain (nom, intitule, annee, mention).
     * @param metadataURI URI off-chain des metadonnees.
     * @param issuerSignature Signature ECDSA de l'emetteur (optionnelle si vide).
     */
    function issueDiplomaWithProof(
        address student,
        bytes32 diplomaHash,
        bytes32 metadataHash,
        string calldata metadataURI,
        bytes calldata issuerSignature
    ) external onlyRole(ISSUER_ROLE) whenNotPaused nonReentrant returns (uint256 diplomaId) {
        if (issuerSignature.length > 0) {
            bytes32 digest = getSignatureDigest(diplomaHash, metadataHash, student);
            address recovered = digest.toEthSignedMessageHash().recover(issuerSignature);
            if (recovered != msg.sender) revert InvalidIssuerSignature();
        }
        diplomaId = _issueDiploma(student, diplomaHash, metadataHash, metadataURI, issuerSignature);
    }

    /**
     * @notice F4 (Batch) : Emet un lot de diplomes en une seule transaction (limite a MAX_BATCH_SIZE).
     */
    function issueDiplomaBatch(
        address[] calldata students,
        bytes32[] calldata diplomaHashes,
        bytes32[] calldata metadataHashes,
        string[] calldata metadataURIs
    ) external onlyRole(ISSUER_ROLE) whenNotPaused nonReentrant returns (uint256[] memory diplomaIds) {
        uint256 len = students.length;
        if (len == 0 || len > MAX_BATCH_SIZE) revert InvalidBatchSize(len);
        if (
            diplomaHashes.length != len ||
            metadataHashes.length != len ||
            metadataURIs.length != len
        ) {
            revert ArrayLengthMismatch();
        }

        diplomaIds = new uint256[](len);
        for (uint256 i = 0; i < len; ) {
            diplomaIds[i] = _issueDiploma(
                students[i],
                diplomaHashes[i],
                metadataHashes[i],
                metadataURIs[i],
                ""
            );
            unchecked {
                ++i;
            }
        }
    }

    // =========================================================================
    //  REVOCATION DE DIPLOMES (F2)
    // =========================================================================

    /**
     * @notice F2 : Revoque un diplome avec motif structure et detail explicatif.
     * @dev Seul l'emetteur initial, sa cle de rotation active ou l'administrateur peut revoquer.
     */
    function revokeDiploma(
        uint256 diplomaId,
        RevocationReason reason,
        string calldata reasonDetail
    ) external whenNotPaused nonReentrant {
        Diploma storage d = _diplomas[diplomaId];

        // 1. Checks
        if (d.status == Status.None) revert DiplomaNotFound(diplomaId);
        if (d.status == Status.Revoked) revert DiplomaAlreadyRevoked(diplomaId);
        if (reason == RevocationReason.None) revert InvalidRevocationReason();

        bool isOriginalIssuer = (msg.sender == d.issuer && hasRole(ISSUER_ROLE, msg.sender));
        bool isRotatedIssuer = (
            !isOriginalIssuer &&
            resolveCurrentIssuer(d.issuer) == msg.sender &&
            hasRole(ISSUER_ROLE, msg.sender)
        );
        bool isAdmin = hasRole(DEFAULT_ADMIN_ROLE, msg.sender);

        if (!isOriginalIssuer && !isRotatedIssuer && !isAdmin) {
            revert UnauthorizedRevoker(msg.sender, diplomaId);
        }

        // 2. Effects (Checks-Effects-Interactions)
        uint64 revokedTimestamp = uint64(block.timestamp);
        d.status = Status.Revoked;
        d.revocationReason = reason;
        d.revocationDetail = reasonDetail;
        d.revokedAt = revokedTimestamp;

        // 3. Interactions / Events
        emit Revoked(diplomaId, msg.sender, reason, reasonDetail, revokedTimestamp);
    }

    // =========================================================================
    //  VERIFICATION PUBLIQUE & LECTURE (F3 + Bonus signature)
    // =========================================================================

    /**
     * @notice F3 : Verifie l'authenticite d'un diplome a partir de son ID et du hash SHA-256 du PDF.
     * @return isValid Vrai uniquement si le diplome existe, est actif (non revoque) et le hash correspond.
     * @return issuer Adresse de l'institution emettrice.
     * @return issuedAt Horodatage Unix de l'emission.
     * @return status Statut actuel (None, Valid, Revoked).
     * @return revocationReason Motif de revocation si revoque.
     * @return metadataURI URI des metadonnees off-chain.
     */
    function verify(
        uint256 diplomaId,
        bytes32 diplomaHash
    )
        external
        view
        returns (
            bool isValid,
            address issuer,
            uint64 issuedAt,
            Status status,
            RevocationReason revocationReason,
            string memory metadataURI
        )
    {
        Diploma storage d = _diplomas[diplomaId];
        if (d.status == Status.None) {
            return (false, address(0), 0, Status.None, RevocationReason.None, "");
        }

        bool hashMatches = (d.diplomaHash == diplomaHash);
        isValid = (d.status == Status.Valid && hashMatches);
        return (isValid, d.issuer, d.issuedAt, d.status, d.revocationReason, d.metadataURI);
    }

    /**
     * @notice Verifie un diplome uniquement par le hash SHA-256 de son PDF (sans connaitre l'ID).
     */
    function verifyByHash(
        bytes32 diplomaHash
    )
        external
        view
        returns (
            bool exists,
            uint256 diplomaId,
            bool isValid,
            address issuer,
            uint64 issuedAt,
            Status status,
            RevocationReason revocationReason,
            string memory metadataURI
        )
    {
        diplomaId = hashToDiplomaId[diplomaHash];
        if (diplomaId == 0) {
            return (false, 0, false, address(0), 0, Status.None, RevocationReason.None, "");
        }

        Diploma storage d = _diplomas[diplomaId];
        return (
            true,
            diplomaId,
            d.status == Status.Valid,
            d.issuer,
            d.issuedAt,
            d.status,
            d.revocationReason,
            d.metadataURI
        );
    }

    /**
     * @notice Calcule le digest canonique signe par l'institution (anti-rejeu inter-chaines).
     */
    function getSignatureDigest(
        bytes32 diplomaHash,
        bytes32 metadataHash,
        address student
    ) public view returns (bytes32) {
        return keccak256(abi.encodePacked(diplomaHash, metadataHash, student, block.chainid, address(this)));
    }

    /**
     * @notice Verifie cryptographiquement la signature ECDSA associee a un diplome.
     */
    function verifySignature(
        uint256 diplomaId
    ) external view returns (bool hasSignature, bool isValidSignature, address recoveredSigner) {
        Diploma storage d = _diplomas[diplomaId];
        if (d.status == Status.None) revert DiplomaNotFound(diplomaId);

        if (d.issuerSignature.length == 0) {
            return (false, false, address(0));
        }

        bytes32 digest = getSignatureDigest(d.diplomaHash, d.metadataHash, d.student);
        recoveredSigner = digest.toEthSignedMessageHash().recover(d.issuerSignature);
        return (true, recoveredSigner == d.issuer, recoveredSigner);
    }

    /**
     * @notice Retourne les details on-chain complets d'un diplome.
     */
    function getDiploma(uint256 diplomaId) external view returns (Diploma memory) {
        if (_diplomas[diplomaId].status == Status.None) revert DiplomaNotFound(diplomaId);
        return _diplomas[diplomaId];
    }

    /**
     * @notice Retourne les identifiants des diplomes d'un etudiant.
     */
    function getStudentDiplomas(address student) external view returns (uint256[] memory) {
        return _studentDiplomas[student];
    }

    /**
     * @notice Retourne les identifiants des diplomes emis par une institution.
     */
    function getIssuerDiplomas(address issuer) external view returns (uint256[] memory) {
        return _issuerDiplomas[issuer];
    }

    /**
     * @notice Retourne les informations publiques d'une institution.
     */
    function getInstitution(address issuer) external view returns (InstitutionInfo memory) {
        return _institutions[issuer];
    }

    /**
     * @notice Retourne la liste historique de toutes les adresses d'institutions enregistrees.
     */
    function getRegisteredIssuers() external view returns (address[] memory) {
        return _registeredIssuers;
    }

    /**
     * @notice Suit la chaine de rotation de cle jusqu'a l'adresse courante d'une institution.
     */
    function resolveCurrentIssuer(address issuer) public view returns (address current) {
        current = issuer;
        for (uint256 i = 0; i < 32; ) {
            address next = rotatedIssuerTo[current];
            if (next == address(0) || next == current) {
                break;
            }
            current = next;
            unchecked {
                ++i;
            }
        }
    }

    /**
     * @notice Nombre total de diplomes emis dans le registre.
     */
    function totalDiplomas() external view returns (uint256) {
        return _nextDiplomaId - 1;
    }

    // =========================================================================
    //  FONCTIONS INTERNES
    // =========================================================================

    function _addIssuerInternal(address issuer, string memory name) internal {
        if (issuer == address(0)) revert ZeroAddress();
        if (bytes(name).length == 0) revert EmptyInstitutionName();
        if (_institutions[issuer].active) revert IssuerAlreadyActive(issuer);

        uint64 nowTs = uint64(block.timestamp);
        uint64 firstRegisteredAt = _institutions[issuer].registeredAt;
        if (firstRegisteredAt == 0) {
            _registeredIssuers.push(issuer);
            firstRegisteredAt = nowTs;
        }

        _institutions[issuer] = InstitutionInfo({
            name: name,
            active: true,
            registeredAt: firstRegisteredAt,
            revokedAt: 0,
            issuedCount: _institutions[issuer].issuedCount
        });

        _grantRole(ISSUER_ROLE, issuer);
        emit IssuerAdded(issuer, name, nowTs);
    }

    function _issueDiploma(
        address student,
        bytes32 diplomaHash,
        bytes32 metadataHash,
        string memory metadataURI,
        bytes memory issuerSignature
    ) internal returns (uint256 diplomaId) {
        // 1. Checks
        if (student == address(0)) revert ZeroAddress();
        if (diplomaHash == bytes32(0)) revert EmptyHash();
        if (bytes(metadataURI).length == 0) revert EmptyURI();
        uint256 existingId = hashToDiplomaId[diplomaHash];
        if (existingId != 0) revert DiplomaAlreadyExists(diplomaHash, existingId);

        // 2. Effects
        diplomaId = _nextDiplomaId;
        unchecked {
            _nextDiplomaId = diplomaId + 1;
        }

        uint64 nowTs = uint64(block.timestamp);
        _diplomas[diplomaId] = Diploma({
            student: student,
            issuedAt: nowTs,
            status: Status.Valid,
            revocationReason: RevocationReason.None,
            issuer: msg.sender,
            revokedAt: 0,
            diplomaHash: diplomaHash,
            metadataHash: metadataHash,
            metadataURI: metadataURI,
            revocationDetail: "",
            issuerSignature: issuerSignature
        });

        hashToDiplomaId[diplomaHash] = diplomaId;
        _studentDiplomas[student].push(diplomaId);
        _issuerDiplomas[msg.sender].push(diplomaId);
        unchecked {
            _institutions[msg.sender].issuedCount += 1;
        }

        // 3. Events
        emit Issued(diplomaId, student, msg.sender, diplomaHash, metadataURI, nowTs);
    }
}
