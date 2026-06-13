import type Database from "better-sqlite3";
import { createHash, randomBytes } from "node:crypto";
import { nanoid } from "nanoid";
import { getAddress, recoverMessageAddress, type Hex } from "viem";
import type { Advertiser, Session } from "./db.js";

function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

const NONCE_TTL_MS = 5 * 60_000;
/** Pending challenges are memory-only; cap them so an unauthenticated client
 *  can't grow the map without bound. Oldest entries are evicted first. */
const MAX_PENDING = 5_000;
export const SESSION_TTL_MS = 30 * 24 * 60 * 60_000;
export const SESSION_COOKIE = "cv_session";

interface Challenge {
  message: string;
  address: string; // EIP-55 checksummed, as embedded in the message
  termsVersion: string; // the Terms version the message bound the signer to
  expiresAt: number;
}

/**
 * Sign-In with Ethereum (EIP-4361) for advertisers. The server authors the
 * exact message at nonce time and keeps it; verification only has to recover
 * the signer of that stored text — no SIWE parsing, nothing client-supplied
 * except the signature. Sessions are opaque bearer tokens stored hashed,
 * delivered as an HttpOnly cookie so campaigns follow the wallet to any
 * browser.
 */
export class AdvertiserAuth {
  private pending = new Map<string, Challenge>();

  constructor(
    private db: Database.Database,
    private chainId: number,
  ) {}

  /** Build and remember the SIWE message this address must sign. The message
   *  embeds an explicit agreement to a specific version of the Terms and links
   *  the Terms and Privacy Policy as EIP-4361 Resources, so the resulting
   *  signature is durable, non-repudiable proof the signer accepted them. */
  issueChallenge(input: {
    address: string;
    domain: string;
    uri: string;
    termsVersion: string;
    termsUrl: string;
    privacyUrl: string;
  }): {
    nonce: string;
    message: string;
    expiresAt: number;
  } {
    const address = getAddress(input.address); // throws on a malformed address
    const now = Date.now();
    for (const [nonce, ch] of this.pending) {
      if (ch.expiresAt < now) this.pending.delete(nonce);
    }
    while (this.pending.size >= MAX_PENDING) {
      const oldest = this.pending.keys().next().value!;
      this.pending.delete(oldest);
    }

    const nonce = randomBytes(16).toString("hex"); // EIP-4361 wants ≥8 alphanumerics
    const expiresAt = now + NONCE_TTL_MS;
    const message = [
      `${input.domain} wants you to sign in with your Ethereum account:`,
      address,
      "",
      "Sign in to Codevertise to manage your ad campaigns. This signature is free and sends no transaction. " +
        `By signing, you agree to the Codevertise Terms of Service (version ${input.termsVersion}) and Privacy Policy, linked below.`,
      "",
      `URI: ${input.uri}`,
      "Version: 1",
      `Chain ID: ${this.chainId}`,
      `Nonce: ${nonce}`,
      `Issued At: ${new Date(now).toISOString()}`,
      `Expiration Time: ${new Date(expiresAt).toISOString()}`,
      "Resources:",
      `- ${input.termsUrl}`,
      `- ${input.privacyUrl}`,
    ].join("\n");
    this.pending.set(nonce, { message, address, termsVersion: input.termsVersion, expiresAt });
    return { nonce, message, expiresAt };
  }

  /**
   * Redeem a challenge: the nonce is consumed whatever the outcome, and the
   * signature must recover to the exact address the message was issued for.
   * Returns the canonical (lowercase) wallet and the Terms version the signed
   * message bound them to, or null.
   */
  async verifyChallenge(
    nonce: string,
    signature: string,
  ): Promise<{ wallet: string; termsVersion: string } | null> {
    const ch = this.pending.get(nonce);
    this.pending.delete(nonce);
    if (!ch || ch.expiresAt < Date.now()) return null;
    try {
      const signer = await recoverMessageAddress({
        message: ch.message,
        signature: signature as Hex,
      });
      if (signer.toLowerCase() !== ch.address.toLowerCase()) return null;
      return { wallet: ch.address.toLowerCase(), termsVersion: ch.termsVersion };
    } catch {
      return null;
    }
  }

  // ---- sessions ----

  createSession(wallet: string): { token: string; expiresAt: number } {
    const token = `cvs_${nanoid(32)}`;
    const now = Date.now();
    const expiresAt = now + SESSION_TTL_MS;
    this.db
      .prepare(
        `INSERT INTO sessions (token_hash, wallet, created_at, expires_at) VALUES (?, ?, ?, ?)`,
      )
      .run(sha256Hex(token), wallet, now, expiresAt);
    // Opportunistic cleanup so dead sessions don't pile up forever.
    this.db.prepare(`DELETE FROM sessions WHERE expires_at < ?`).run(now);
    return { token, expiresAt };
  }

  /** The wallet a session token belongs to, or undefined when absent/expired. */
  sessionWallet(token: string | undefined): string | undefined {
    if (!token) return undefined;
    const row = this.db
      .prepare(`SELECT * FROM sessions WHERE token_hash = ?`)
      .get(sha256Hex(token)) as Session | undefined;
    if (!row) return undefined;
    if (row.expires_at < Date.now()) {
      this.db.prepare(`DELETE FROM sessions WHERE token_hash = ?`).run(row.token_hash);
      return undefined;
    }
    return row.wallet;
  }

  deleteSession(token: string): void {
    this.db.prepare(`DELETE FROM sessions WHERE token_hash = ?`).run(sha256Hex(token));
  }

  // ---- advertiser accounts ----

  /** Fetch-or-create the account row for a signed-in wallet. */
  ensureAdvertiser(wallet: string): Advertiser {
    this.db
      .prepare(
        `INSERT INTO advertisers (wallet, label, created_at, settings_at)
         VALUES (?, NULL, ?, NULL)
         ON CONFLICT(wallet) DO NOTHING`,
      )
      .run(wallet, Date.now());
    return this.getAdvertiser(wallet)!;
  }

  getAdvertiser(wallet: string): Advertiser | undefined {
    return this.db.prepare(`SELECT * FROM advertisers WHERE wallet = ?`).get(wallet) as
      | Advertiser
      | undefined;
  }

  /** Record that `wallet` accepted Terms `version` (by signing the SIWE message
   *  that referenced it). Always advances to the latest accepted version. */
  recordTermsAcceptance(wallet: string, version: string): Advertiser {
    this.ensureAdvertiser(wallet);
    this.db
      .prepare(`UPDATE advertisers SET terms_version = ?, terms_accepted_at = ? WHERE wallet = ?`)
      .run(version, Date.now(), wallet);
    return this.getAdvertiser(wallet)!;
  }

  saveSettings(wallet: string, label: string): Advertiser {
    this.ensureAdvertiser(wallet);
    this.db
      .prepare(`UPDATE advertisers SET label = ?, settings_at = ? WHERE wallet = ?`)
      .run(label, Date.now(), wallet);
    return this.getAdvertiser(wallet)!;
  }
}
