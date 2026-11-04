/**
 * Downloads the Riftbound card dataset to data/raw/cards.json.
 *
 * Usage: npx tsx scripts/fetch-cards.ts [--force]
 *
 * Skips the download if the file already exists unless --force is passed.
 */
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE_URL =
  "https://huggingface.co/datasets/Wysme/riftbound-cards/resolve/main/cards.json?download=true";

// Resolved from this file's location, not the current working directory.
const OUTPUT_PATH = fileURLToPath(new URL("../data/raw/cards.json", import.meta.url));

const LICENSE_NOTICE =
  "Card data (c) Riot Games, non-commercial community use only. Do not commit data/ or redistribute.";

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const force = process.argv.slice(2).includes("--force");

  if (existsSync(OUTPUT_PATH) && !force) {
    console.log(`Already exists, skipping download: ${OUTPUT_PATH}`);
    console.log("Pass --force to re-download.");
    console.log(LICENSE_NOTICE);
    return;
  }

  console.log(`Downloading ${SOURCE_URL}`);

  let response: Response;
  try {
    response = await fetch(SOURCE_URL, { redirect: "follow" });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    fail(`network request failed: ${reason}`);
  }

  if (!response.ok) {
    fail(`HTTP ${response.status} ${response.statusText} while fetching ${SOURCE_URL}`);
  }

  let bytes: Buffer;
  try {
    bytes = Buffer.from(await response.arrayBuffer());
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    fail(`failed reading response body: ${reason}`);
  }

  let data: unknown;
  try {
    data = JSON.parse(bytes.toString("utf8"));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    fail(`downloaded content is not valid JSON: ${reason}`);
  }

  if (!Array.isArray(data)) {
    fail(
      `expected a JSON array of card objects, got ${data === null ? "null" : typeof data}`,
    );
  }

  const nonObject = data.findIndex((item) => typeof item !== "object" || item === null || Array.isArray(item));
  if (nonObject !== -1) {
    fail(`record at index ${nonObject} is not a card object`);
  }

  await mkdir(dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, bytes);

  console.log(`Saved ${OUTPUT_PATH}`);
  console.log(`Size: ${bytes.byteLength} bytes`);
  console.log(`Records: ${data.length}`);
  console.log(LICENSE_NOTICE);
}

main().catch((err) => {
  const reason = err instanceof Error ? err.message : String(err);
  fail(`unexpected error: ${reason}`);
});
