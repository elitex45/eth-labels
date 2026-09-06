import * as cheerio from "cheerio";
import "dotenv/config";
import fs from "fs";
import path from "path";
import { z } from "zod";
import type { ApiParser } from "./ApiParser/ApiParser";
import { getEtherscanCookies } from "./browser-auth";
import { BrowserFetcher } from "./browser-fetch";
import type { Chain } from "./Chain/Chain";
import type { AccountRows } from "./ChainPuller";
import { CheerioParser } from "./CheerioParser";
import { getChainConfig } from "./cli";
import { AccountsRepository } from "./db/repositories/AccountsRepository";
import { fetchHtml } from "./fetch-html";
import type { HtmlParser } from "./HtmlParser/HtmlParser";
import { parseError } from "./utils/error-parse";
import { sleep } from "./utils/sleep";

/**
 * Pull only the risk labels, every page of them, straight from the explorer.
 *
 * `bun run scripts/fetch-all.ts` pulls every label on the label cloud and
 * takes one page per label. That misses the bulk of the addresses that matter
 * here: Etherscan's `phish-hack` label holds tens of thousands of
 * Fake_Phishing accounts, and the label page only shows the first page.
 *
 * This script:
 *  - reads the label cloud, keeps the labels in RISK_LABELS
 *  - walks every sub-category and every page (size=100, start=N) until a page
 *    comes back short
 *  - writes rows to data/db.sqlite3 like fetch-all does
 *  - additionally writes data/risk/accounts-<chainId>.json, the shape
 *    eth-labels-risk/build_risk_db.py reads
 *
 * Explorer label pages answer "There are no matching entries" to a signed-out
 * browser. Sign in first: put ETHERSCAN_USERNAME and ETHERSCAN_PASSWORD in
 * .env, run with the Chrome/Brave CDP browser open, and solve the captcha in
 * the tab when asked. The session cookie then lives in that browser profile
 * and later runs skip the prompt.
 *
 * Run:
 *   ETH_LABELS_CHAINS=etherscan bun run pull:risk
 */

/** Etherscan label slugs that mean "risky". Keep in sync with TAXONOMY in build_risk_db.py. */
export const RISK_LABELS = new Set([
  "phish-hack",
  "scam",
  "something-fishy",
  "flagged-by-sec",
  "quadrigacx",
  "brand-infringement",
  "spam-token",
  "heist",
  "exploit",
  "compromised",
  "high-risk",
  "cpimp-attack",
  "bancor-contract-vulnerability",
  "alphapo",
  "bingx-exploit",
  "bybit-exploit",
  "filament-exploit",
  "onyxdao-exploit",
  "radiant-capital-exploit",
  "truebit-exploit",
  "unibtc-exploit",
  "wazirx-exploit",
  "zkswap-exploit",
  "ofac-sanctioned",
  "ofac-sanctions-lists",
  "blocked",
  "tornado-cash",
  "mixer",
  "ethereum-mixer",
  "typhoon-cash",
  "typhoon-network",
  "take-action",
  "gambling",
  "adult",
  "airdrop-hunter",
  "sybil-delegate",
  "parity-bug",
  "ftx",
  "alameda-research",
  "celsius-network",
  "deprecated",
]);

const PAGE_SIZE = 100;
const PAGE_TIMEOUT_MS = 90_000;
const PAGE_RETRIES = 2;
const NO_ENTRIES = "There are no matching entries";

type Target = { label: string; url: string; expected: number };

function urlToLabel(url: string): string {
  return z.string().parse(url.split("/").pop()?.split("?")[0]);
}

async function ensureSignedIn(browserFetcher: BrowserFetcher, website: string) {
  const html = await browserFetcher.navigateAndGetHtml(
    `${website}/accounts/label/phish-hack?size=10`,
  );
  if (!html.includes(NO_ENTRIES)) return;

  if (website !== "https://etherscan.io") {
    throw new Error(
      `${website} label pages need a signed-in session. Sign in by hand in the CDP browser tab and rerun.`,
    );
  }
  if (!process.env.ETHERSCAN_USERNAME || !process.env.ETHERSCAN_PASSWORD) {
    throw new Error(
      "etherscan.io label pages need a signed-in session and no ETHERSCAN_USERNAME / ETHERSCAN_PASSWORD is set. " +
        "Add them to eth-labels/.env, or sign in by hand in the CDP browser tab and rerun.",
    );
  }
  // browser-auth opens a login tab in the same browser, fills the form and waits
  // for the captcha to be solved by hand. The session cookie it produces is
  // shared with the tab BrowserFetcher drives, so nothing else needs the string.
  console.log(
    "\n🔐 etherscan.io wants a sign-in. Solve the captcha in the browser tab when it opens.",
  );
  await getEtherscanCookies();
  const again = await browserFetcher.navigateAndGetHtml(
    `${website}/accounts/label/phish-hack?size=10`,
  );
  if (again.includes(NO_ENTRIES))
    throw new Error("still signed out after login; rerun");
}

async function riskTargets(
  chain: Chain<ApiParser, HtmlParser>,
  bf: BrowserFetcher,
): Promise<Array<Target>> {
  const html = await fetchHtml(`${chain.website}/labelcloud`, bf);
  const $ = cheerio.load(html);
  const targets = new Map<string, Target>();
  $("a[href^='/accounts/label/']").each((_i, el) => {
    const href = $(el).attr("href");
    if (!href) return;
    const label = urlToLabel(href);
    if (!RISK_LABELS.has(label)) return;
    const count = $(el)
      .text()
      .match(/\(([\d,]+)\)/)?.[1];
    targets.set(label, {
      label,
      url: `${chain.website}${href.split("?")[0]}`,
      expected: count ? Number(count.replace(/,/g, "")) : 0,
    });
  });
  return [...targets.values()];
}

function subcatIds(html: string): Array<string> {
  const p = new CheerioParser();
  p.loadHtml(html);
  const pills = p.querySelector(".nav-pills");
  if (pills.length === 0) return ["0"];
  const ids = pills
    .find("li > a")
    .toArray()
    .map(
      (a) => p.getAttr(a, "val") ?? p.getAttr(a, "data-sub-category-id") ?? "",
    )
    .filter((id) => id.length > 0);
  return ids.length ? [...new Set(ids)] : ["0"];
}

async function fetchWithRetry(
  url: string,
  bf: BrowserFetcher,
): Promise<string> {
  for (let attempt = 1; attempt <= PAGE_RETRIES + 1; attempt++) {
    try {
      return await Promise.race([
        fetchHtml(url, bf),
        new Promise<never>((_r, reject) =>
          setTimeout(
            () => reject(new Error(`timeout after ${PAGE_TIMEOUT_MS}ms`)),
            PAGE_TIMEOUT_MS,
          ),
        ),
      ]);
    } catch (e) {
      console.warn(
        `  fetch failed (${attempt}): ${e instanceof Error ? e.message : String(e)}`,
      );
      if (attempt <= PAGE_RETRIES) await sleep(1_000 * attempt);
    }
  }
  throw new Error(`gave up on ${url}`);
}

async function pullLabel(
  chain: Chain<ApiParser, HtmlParser>,
  bf: BrowserFetcher,
  target: Target,
): Promise<AccountRows> {
  const first = await fetchWithRetry(`${target.url}?size=${PAGE_SIZE}`, bf);
  if (first.includes(NO_ENTRIES)) {
    throw new Error(
      `${target.url} shows "${NO_ENTRIES}": the session is signed out`,
    );
  }
  const rows: AccountRows = [];
  const seen = new Set<string>();
  for (const subcat of subcatIds(first)) {
    for (let start = 0; start < 5_000_000; start += PAGE_SIZE) {
      const url = `${target.url}?subcatid=${subcat}&size=${PAGE_SIZE}&start=${start}`;
      const html =
        start === 0 && subcat === "0" ? first : await fetchWithRetry(url, bf);
      const page = chain.htmlPuller.selectAllAccountAddresses(html, subcat);
      for (const row of page) {
        const key = `${row.address.toLowerCase()}::${row.nameTag ?? ""}`;
        if (seen.has(key)) continue;
        seen.add(key);
        rows.push(row);
      }
      process.stdout.write(
        `\r  ${target.label} subcat ${subcat}: ${rows.length}${target.expected ? "/" + target.expected : ""}`,
      );
      if (page.length < PAGE_SIZE) break;
      await sleep(Math.floor(Math.random() * 700) + 300);
    }
  }
  process.stdout.write("\n");
  return rows;
}

void (async () => {
  const bf = new BrowserFetcher();
  try {
    console.log("\n🔗 Connecting to the CDP browser...");
    await bf.init();
    const { chains } = await getChainConfig();
    const outDir = path.resolve(import.meta.dir, "..", "data", "risk");
    fs.mkdirSync(outDir, { recursive: true });

    for (const chain of chains) {
      console.log(`\n=== ${chain.chainName} (${chain.website}) ===`);
      await bf.setActiveOrigin(chain.website);
      await ensureSignedIn(bf, chain.website);
      const targets = await riskTargets(chain, bf);
      console.log(`${targets.length} risk labels on the label cloud`);

      const exported: Array<{
        address: string;
        chainId: number;
        label: string;
        nameTag: string | null;
      }> = [];
      for (const target of targets) {
        const rows = await pullLabel(chain, bf, target);
        const newAccounts = rows.map((r) => ({
          chainId: chain.chainId,
          address: r.address.toLowerCase() as typeof r.address,
          label: target.label,
          nameTag: r.nameTag,
        }));
        await AccountsRepository.insertAccounts(newAccounts);
        exported.push(...newAccounts);
      }
      const out = path.join(outDir, `accounts-${chain.chainId}.json`);
      fs.writeFileSync(out, JSON.stringify(exported));
      console.log(`wrote ${exported.length} rows to ${out}`);
    }
    console.log("\n🎉 done");
    process.exit(0);
  } catch (e) {
    parseError(e);
    process.exit(1);
  } finally {
    await bf.close();
  }
})();
