# KEYKARD

**Credit your family can back.** An uncollateralised stablecoin credit line on [Tempo](https://tempo.xyz). Every rule is enforced by the protocol itself.

- **One account, three ways back in.** Everyone signs up the same way: username, then a password (the password encrypts a wallet key on the device; KEYKARD never sees it), then an optional passkey (fingerprint or face). The passkey is a Tempo **admin key** on the same wallet (TIP-1049), so each can repair the other:
  - forgot password: the passkey sets a new one;
  - lost passkey: the password replaces it;
  - lost both: re-verify the same passport with Self, wait out a safety period (cancellable by the owner from any signed-in device), and KEYKARD's recovery key, an admin key the user approved at sign-up, restores access to the **same wallet**. Users can turn recovery off for full self-custody.
- **Your card is a key.** Each sign-in key (password key, passkeys) and a physical NFC chip card is authorised as an *access key* on a KEYKARD-funded credit account. Tempo's AccountKeychain enforces three things on it:
  - a per-period spend limit;
  - an allow-list containing only the KEYKARD network address;
  - an expiry.
  Paying anyone else is refused on-chain (`CallNotAllowed`).
- **Repayment is an auto-debit you control.** You grant KEYKARD one key on your own wallet. It can take at most the agreed amount per period, and only to KEYKARD. You sign it once. Revoke it and your card freezes within seconds.
- **Family can back you.** A relative signs one capped key on *their* wallet. It is pulled only if you miss a payment after the grace period, and never more than they agreed. Affordability is checked: at most 20% of disposable income.
- **KYC without documents.** Identity comes from [Self](https://self.xyz). The user taps their passport's NFC chip and Self proves, in zero knowledge, that the passport is genuine and government-issued, the holder is over 18, not on a sanctions (OFAC) list, and one unique person (a nullifier binds one passport to one wallet). KEYKARD stores no documents. This check is what lets KEYKARD lend to people with no bank account or credit score; where a regulated partner needs more (e.g. name or date of birth), Self can disclose just those fields.
- **Free if you pay on time; missed bills are priced on-chain.** The `CreditTerms` contract publishes the pricing: a $1 late fee per missed bill, then 2% of the overdue amount per billing period, all charges capped at 25% of it. The contract computes every charge and only for lines the public credit file shows as overdue or defaulted. Repayments clear the borrowed amount first, then fees. Family backups never pay fees.
- **Repay from anywhere.** Every line has its own repayment address. Stablecoins sent there from an exchange, another wallet or a family member are applied automatically, even with auto-pay off; anything above what's owed is returned to the borrower's wallet.
- **Bigger limits, secured 1:1.** A borrower can lock stablecoins in the `CollateralVault` and the limit grows by the same amount (lock $100, spend $100 more), on top of the unsecured tiers. KEYKARD can take collateral only after the line is Defaulted on LineBook (the vault checks) and never more than is locked; the rest is released back.
- **A merchant network.** Anyone verified can become a merchant, get a code, a QR and a pay link, and accept tap-to-pay. The network settles merchants in USDC today. With a card-network partner, the same authorisation settles merchants in **fiat at any POS**; only the settlement leg changes.

## After the hackathon: crypto in, fiat out
KEYKARD keeps going after Crypto World's Fair. Plans, in order; none of this is shipped yet:
1. **Mainnet with real dollars:** USDC on Tempo mainnet with small, capped limits; repay from exchanges that support Tempo or from any wallet.
2. **Fiat on- and off-ramps:** licensed partners so borrowers can top up and repay from a bank account or cash, and merchants are paid out in local currency.
3. **Any card terminal:** a virtual and physical KEYKARD on a global card network through an issuing partner. Only the settlement leg changes; the on-chain limits, auto-pay cap and public credit file stay the same.
4. **Fuller KYC where partners require it:** the same Self proof, disclosing only the extra fields a regulated partner asks for.

## Repository

```
contracts/        Foundry: KeycardRegistry (identity + merchant mirror), LineBook (public credit file),
                  CreditTerms (published pricing for missed bills + every charge), CollateralVault (1:1 secured limits).
packages/sdk/     Shared TS: networks, key policies (spend / mandate / guarantee), memos, ABIs.
apps/servicer/    Node API + fee relay (tempo.ts Handler.feePayer) + RPC proxy + scheduler + revocation watcher + settlement.
apps/web/         Next.js app: onboarding, passkey/password wallet, card, pay, deposit, guarantor, merchant, physical NFC card.
deployments/      Deployed contract addresses per network.
```

## Deployed (Tempo testnet, Moderato 42431). Verified on the explorer
- KeycardRegistry `0x6c5ccc3f51641004bb6d21a0b49f2f4c9132837a`
- LineBook `0x346f5f3755e7ddbad1f4efd408468159a57207d0`
- CreditTerms `0x666a756768cdb183523d9fb1151b038e9d136506` ($1 late fee, 2% per period, 25% cap)
- CollateralVault `0x2b273f09a4305ed94d3b21d1d69a55cf7bb60463`

## Run locally

```bash
pnpm install
docker run -d --name keycard-db -e POSTGRES_PASSWORD=keycard -e POSTGRES_USER=keycard -e POSTGRES_DB=keycard \
  -p 127.0.0.1:5544:5432 postgres:16-alpine
cp .env.example .env.testnet   # then generate keys:
pnpm --filter @keycard/sdk exec tsx scripts/keygen.ts testnet   # writes .env.testnet if absent
TEMPO_NETWORK=testnet pnpm --filter @keycard/servicer start      # :8787 (runs migrations)
pnpm --filter @keycard/web build && pnpm --filter @keycard/web start   # :3000; proxies /api /rpc /relay to :8787
```

Passkeys need HTTPS on phones. For a phone test, run `cloudflared tunnel --url http://localhost:3000` and add the tunnel URL to `WEB_ORIGINS`.

## Deploy (Railway)
Set these in each Railway service's Settings (Railway config-as-code is deprecated for new services).
1. New project → **Deploy from GitHub repo** → `Keykard/keykard`. Add **Postgres** (+ New → Database → PostgreSQL).
2. **Service `keycard-servicer`:** start command `cd apps/servicer && ./node_modules/.bin/tsx src/main.ts`, health check `/api/health`, Serverless OFF. Variables:
   - the operator keys, `KEY_ENC_SECRET` and `ADMIN_TOKEN` (see `.env.example`);
   - `TEMPO_NETWORK=testnet`;
   - `DATABASE_URL=${{Postgres.DATABASE_URL}}`;
   - `WEB_ORIGINS` and `PUBLIC_WEB_ORIGIN` (the web URL).
   Generate a public domain. It must stay running, because the scheduler and watcher live in this process.
3. **Service `keycard-web`** (same repo, second service): build command `pnpm --filter @keycard/web build`, start command `cd apps/web && ./node_modules/.bin/next start -p $PORT`. Variable `SERVICER_URL=https://<keycard-servicer domain>`. Generate a public domain.
4. The Self webhook is `https://<keycard-servicer domain>/api/self/webhook`.

`render.yaml` is kept as an alternative Render Blueprint.

## Tests
```bash
cd contracts && forge test                                               # 42 contract tests
cd apps/servicer
TEMPO_NETWORK=testnet npx tsx test/e2e.ts            # 23 checks: signup → mandate → card → merchant → auto-debit → upgrade → guarantor → freeze
TEMPO_NETWORK=testnet npx tsx test/e2e-default.ts    # missed payment → grace → guarantor pays exactly the shortfall → frozen
TEMPO_NETWORK=testnet npx tsx test/e2e-card.ts       # physical NFC card: link, tap-pay, tap limit, freeze
TEMPO_NETWORK=testnet npx tsx test/e2e-edge.ts       # grace blocks phone+card, pay now, revoke/re-enable auto-debit, default → settle → new line
TEMPO_NETWORK=testnet npx tsx test/e2e-auth.ts       # sign-up, password + passkey on one wallet, forgot password, lost passkey,
                                                     # lost both → passport recovery (RECOVERY_DELAY_SECONDS=20), recovery off
npx tsx test/browser-auth.ts                         # the same sign-in screens in real Chromium with a virtual passkey
TEMPO_NETWORK=testnet npx tsx test/e2e-v2.ts         # late fee + penalty, repay from another wallet, 1:1 collateral, default → vault covers it
                                                     # (run the servicer with PERIOD_SECONDS=90 GRACE_SECONDS=200)
USE_DEV_VERIFY=1 TEMPO_NETWORK=testnet npx tsx test/browser.ts   # real Chromium + virtual WebAuthn authenticator
```
The e2e tests run against a live servicer on Tempo testnet: real transactions, fees sponsored.

## Safety notes
- **Fees are always sponsored.** Fees paid by a limited key's own account count against its limit, so KEYKARD sponsors every fee and pulls stay exact.
- **Every money movement has a unique memo** and is reconciled on-chain before any retry. Writes are never transport-retried.
- **Server-held keys are AES-256-GCM encrypted at rest:** credit-account roots, mandate keys and guarantee keys.
- **Password wallets are encrypted client-side** (PBKDF2 600k + AES-GCM). The server stores only the ciphertext and a scrypt hash of a separately derived login proof.
- **Physical cards use HaLo key slot 1 only.** The Burner wallet's own key (slots 8/9) and PIN are never touched.

## Credits

- Merchant helix on the landing page: geometry, spiral layout and depth-fade shader ported from
  [YildizDikme/3D-threejs-spiral-gallery](https://github.com/YildizDikme/3D-threejs-spiral-gallery), used with the author's permission.
- Landing page built with [React Three Fiber](https://github.com/pmndrs/react-three-fiber), [drei](https://github.com/pmndrs/drei),
  [GSAP](https://gsap.com) (ScrollTrigger, SplitText), [Lenis](https://github.com/darkroomengineering/lenis) and [NumberFlow](https://number-flow.barvian.me).
