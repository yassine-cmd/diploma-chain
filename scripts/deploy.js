const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const initialInstitution =
    process.env.INITIAL_INSTITUTION_NAME ||
    "ENSA Fes - Universite Sidi Mohamed Ben Abdellah";

  console.log("Deploiement de DiplomaRegistry avec le compte :", deployer.address);
  console.log("Reseau :", hre.network.name);

  const DiplomaRegistry = await hre.ethers.getContractFactory("DiplomaRegistry");
  const registry = await DiplomaRegistry.deploy(initialInstitution);
  await registry.waitForDeployment();

  const contractAddress = await registry.getAddress();
  const network = await hre.ethers.provider.getNetwork();
  console.log("DiplomaRegistry deploye a l'adresse :", contractAddress);

  const artifact = await hre.artifacts.readArtifact("DiplomaRegistry");
  const deploymentPayload = {
    address: contractAddress,
    chainId: Number(network.chainId),
    network: hre.network.name,
    deployer: deployer.address,
    deployedAt: new Date().toISOString(),
    abi: artifact.abi,
  };

  const targets = [
    path.join(__dirname, "..", "frontend", "src", "contracts", "deployment.json"),
    path.join(__dirname, "..", "backend", "src", "deployment.json"),
  ];

  for (const target of targets) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(deploymentPayload, null, 2));
    console.log("Artefact de deploiement ecrit :", target);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
