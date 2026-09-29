#!/usr/bin/env node
/**
 * Check thin mirrors in plugins/keeta/references/ against public docs.
 *
 * Usage: node scripts/sync-keeta-docs.mjs
 *
 * Fetches each canonical markdown page and requires every needle to appear
 * both on that page and in the local note. Does not write page bodies.
 */

const pages = [
  {
    file: "plugins/keeta/references/fiat-deposit-from-bank.md",
    url: "https://docs.keeta.com/guides/fiat-deposit-from-bank.md",
    needles: [
      "createPersistentForwardingAddress",
      "getProvidersForTransfer",
      "bank-account",
      "userClient.balance",
    ],
  },
  {
    file: "plugins/keeta/references/fiat-withdraw-to-bank.md",
    url: "https://docs.keeta.com/guides/fiat-withdraw-to-bank.md",
    needles: [
      "initiateTransfer",
      "UsBankAccountResolved",
      "getTransferStatus",
      "bank-account",
    ],
  },
  {
    file: "plugins/keeta/references/add-kyc-certificate.md",
    url: "https://docs.keeta.com/guides/add-kyc-certificate.md",
    needles: ["createVerification", "Footprint", "getCertificates", "modifyCertificate"],
  },
  {
    file: "plugins/keeta/references/share-kyc-attributes.md",
    url: "https://docs.keeta.com/guides/share-kyc-attributes.md",
    needles: [
      "shareKYCAttributes",
      "SharableCertificateAttributes",
      "grantAccess",
      "addOperationsToBuilder",
    ],
  },
  {
    file: "plugins/keeta/references/asset-movement.md",
    url: "https://docs.keeta.com/anchors/anchor-types/asset-movement.md",
    needles: ["Persistent Addresses", "Managed Transfers"],
  },
  {
    file: "plugins/keeta/references/anchor-resolver.md",
    url: "https://docs.keeta.com/anchors/overview/anchor-resolver.md",
    needles: ["resolver.lookup", "fullyResolveValuizable"],
  },
];

import { readFile } from "node:fs/promises";

const failures = [];

for (const page of pages) {
  const local = await readFile(new URL(`../${page.file}`, import.meta.url), "utf8");
  let remote;
  try {
    const response = await fetch(page.url);
    if (!response.ok) {
      failures.push(`${page.url} returned HTTP ${response.status}`);
      continue;
    }
    remote = await response.text();
  } catch (error) {
    failures.push(`${page.url} fetch failed: ${error instanceof Error ? error.message : error}`);
    continue;
  }

  if (!local.includes(page.url.replace(/\.md$/, ""))) {
    failures.push(`${page.file} is missing its canonical URL`);
  }

  for (const needle of page.needles) {
    if (!remote.includes(needle)) {
      failures.push(`${page.url} no longer contains ${JSON.stringify(needle)}`);
    }
    if (!local.includes(needle)) {
      failures.push(`${page.file} is missing ${JSON.stringify(needle)}`);
    }
  }
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log(`Checked ${pages.length} Keeta doc mirrors.`);
