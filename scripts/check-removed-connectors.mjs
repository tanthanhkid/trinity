#!/usr/bin/env node
// G14: fail if a reference to a removed connector / provider / env var is re-added.
// Run: node scripts/check-removed-connectors.mjs   (from anywhere inside the repo)
// Scans files tracked by git. Legit historical mentions go in ALLOW below (path regex + optional pattern ids).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// id -> case-insensitive regex of the removed thing.
const PATTERNS = {
  // env vars of removed providers / serverless runtime
  'env-google': /\bGOOGLE_OAUTH_\w*/,
  'env-commerce': /\b(SHOPEE|LAZADA|KIOTVIET|SAPO|WOOCOMMERCE|MISA)_[A-Z0-9_]+/,
  'env-payments': /\b(SEPAY|VNPAY|MOMO)_[A-Z0-9_]+/,
  'env-social': /\b(YOUTUBE|TIKTOK|INSTAGRAM|GOOGLE_BUSINESS)_(CLIENT|API|APP|SECRET|REDIRECT|ACCESS|KEY)\w*/,
  'env-serverless': /\b(TRINITY_RUNTIME|BLOB_READ_WRITE_TOKEN|BLOB_ACCESS|VERCEL(_[A-Z_]+)?)\b/,
  'env-deno': /\bDENO_[A-Z_]+|\bEXTENSIONS?_(DIR|ENABLED|RUNTIME)\b/,
  // code identifiers, module paths, packages
  deno: /\bext-deno\b|\bdeno-bin\b|\bdeno\.(json|lock)\b|\bextensions\.(read|write|manage|run|install|delete)\b|\bextension_(run|install|list)\w*|\/extensions\b/i,
  'google-sheets': /\bgoogle\.sheet-sync\b|google_?sheets?_?(sync|id|url|token)|GoogleSheet\w*|\bgoogle_sheets\b|googleapis|@googleapis\//i,
  'social-providers': /\b(youtube|tiktok|instagram|google_?business)[._-]?(provider|service|client|api)\b|\b(Youtube|TikTok|Tiktok|Instagram|GoogleBusiness)(Provider|Service|Client)\b/,
  commerce: /\b(shopee|lazada|kiotviet|sapo|woocommerce|misa)[._-]?(service|provider|client|connector|sync|shop|seller|webhook)\b|\b(Shopee|Lazada|KiotViet|Sapo|WooCommerce|Misa)(Service|Provider|Client|Connector)\b|\bcommerce[-_]sync\b|\bcommerce_connectors\b|\blist_sales_orders\b|\/connectors\/(shopee|lazada|kiotviet|sapo|woocommerce|misa)\b/i,
  payments: /\b(sepay|vnpay|momo)[._-]?(service|provider|client|ipn|return|webhook|gateway)\b|\b(SePay|VnPay|MoMo|Momo)(Service|Provider|Client|Gateway)\b|\bpayments\.service\b|\bpayment\.received\b|\bpayments_?(enabled|gateway)\b/i,
  vercel: /@vercel\/|\bvercel\.json\b|\bbuild:vercel\b|\bnest-(bridge|loader)\b|\bserverless-runtime\b|\bvercel-blob\b|\bWebhookKickInterceptor\b|\/internal\/cron\/tick\b/i,
  docx: /["'`]docx["']\s*:|\bfrom ['"]docx['"]|\brequire\(['"]docx['"]\)/,
};

// path regex (repo-relative posix path) -> true (all patterns) or array of pattern ids. Only historical / archival /
// "retired, handled on purpose" mentions belong here.
const ALLOW = [
  [/^scripts\/check-removed-connectors\.mjs$/, true],
  [/^server\/crates\/mod-system\/src\/tests\.rs$/, ['commerce']], // test: route shopee đã gỡ phải trả 410
  [/^server\/crates\/mod-mcp\/src\/tools\/settings\.rs$/, ['google-sheets']], // test: khoá google_sheets đã gỡ phải bị loại
  [/^CHANGELOG\.md$/, true], // history
  [/^docs\/rust\//, true], // plan docs describe what was removed
  [/^docs\/ci\.md$/, true], // describes this check
  [/^docs\/deployment\.md$/, ['env-serverless', 'vercel']], // migration note "Moving files off Blob storage"
  [/^packages\/prisma\/prisma\/migrations\//, true], // migrations are immutable history
  [/^packages\/prisma\/prisma\/schema\.prisma$/, true], // archived models ("LƯU TRỮ" section)
  [/^server\/contracts\/(schema\.sql|openapi\.json|routes\.json|rbac\.json|cases\/|mcp\/)/, true], // frozen contracts (generated)
  [/^server\/xtask\/src\/gen_models\.rs$/, true], // names the archived models
  [/^server\/crates\/trinity-kernel\/src\/config\/vars\.rs$/, true], // list of retired env vars (warn when set)
  [/^scripts\/ops\/kiem-ke-ket-noi\.sh$/, true], // inventory of archived tables
  [/^pnpm-lock\.yaml$/, true],
  [/^\.github\/workflows\/release\.yml$/, ['google-sheets']], // googleapis/release-please-action
  [/^release-please-config\.json$/, ['google-sheets']], // googleapis/release-please schema URL
  [/^integrations\/n8n\//, ['google-sheets']], // n8n templates: the customer's own Google Sheet via n8n, not Trinity
  // 410 Gone handlers for retired webhook/callback URLs (G03, G06, G07b)
  [/^services\/crm\/src\/retired\//, true],
  // retired org feature keys accepted and ignored (google_sheets, commerce_connectors, payments)
  [/^services\/crm\/src\/settings\/(dto\/org-features\.dto|org-features\.spec)\.ts$/, true],
  [/^services\/crm\/src\/common\/helpers\/plan-cases\.spec\.ts$/, true],
  [/^services\/crm\/src\/integrations\/mcp\/(tools\/feature-tools\.ts|__tests__\/feature-option-tools\.spec\.ts|actions\/__tests__\/workspace-spec-retired\.spec\.ts)$/, true],
  [/^packages\/rbac\/src\/org-features(\.spec)?\.ts$/, true],
  [/^apps\/monolith\/src\/__tests__\/settings-dto-golden\.spec\.ts$/, true],
  [/^server\/crates\/(trinity-rbac\/src\/plan\.rs|mod-settings\/(src\/validate\.rs|tests\/))/, true],
  [/^apps\/web\/e2e\/premium\/fixtures\.mjs$/, ['commerce']],
  // refuses to start with the removed Vercel Blob driver (tell the operator how to migrate) + its tests
  [/^packages\/storage\/src\/(env|uploads-store\.spec)\.ts$/, true],
  [/^services\/crm\/src\/storage\/blob-removed\.spec\.ts$/, true],
  // old notification links to /extensions are redirected to AI activity instead of a 404 page
  [/^apps\/web\/src\/(lib\/notification-href\.ts|__tests__\/ai-actions\/ai-actions-misc\.test\.tsx)$/, ['deno']],
  // old platform.company_routes rows (shopee_shop / lazada_seller) are ignored; tests assert it
  [/^server\/crates\/trinity-db\/(src\/platform\.rs|tests\/platform\.rs)$/, ['commerce']],
  [/^server\/crates\/trinity-db\/src\/outbox\.rs$/, ['payments']], // asserts payment.received left the event catalog
  [/^services\/crm\/src\/__pg__\/sales-connectors-retired\.pg\.spec\.ts$/, ['payments']],

  // ---- KNOWN LEFTOVERS (real code references still present after G02-G13; follow-up needed, then delete these) ----
  // TRINITY_RUNTIME=serverless still disables the Postgres NOTIFY sync (G11 removed the serverless path itself).
  [/^(packages\/prisma\/src\/sync\/sync-bus\.ts|server\/crates\/(trinity-db\/src\/sync\.rs|trinity-auth\/src\/(sync\.rs|security\/tests\.rs))|docs\/sync-notify\.md)$/, ['env-serverless']],
  // VERCEL_GIT_COMMIT_SHA still used as release-name fallback.
  [/^server\/crates\/trinity-obs\/src\/monitoring\.rs$/, ['env-serverless']],
  // webhook payload scrubbing still handles the removed payment.received event + fixtures.
  [/^server\/crates\/trinity-integrations\/(src\/webhooks\/payload\.rs|tests\/fixtures\/)/, ['payments']],
];

const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, maxBuffer: 1 << 28 })
  .toString().split('\0').filter(Boolean);
const BIN = /\.(png|jpe?g|gif|webp|ico|svg|pdf|woff2?|ttf|zip|gz|wasm|lock)$/i;

const allowed = (path, id) =>
  ALLOW.some(([re, ids]) => re.test(path) && (ids === true || ids.includes(id)));

const hits = [];
for (const f of files) {
  if (BIN.test(f)) continue;
  let text;
  try { text = readFileSync(resolve(root, f), 'utf8'); } catch { continue; }
  if (text.includes('\0')) continue;
  const lines = text.split('\n');
  for (const [id, re] of Object.entries(PATTERNS)) {
    if (allowed(f, id)) continue;
    lines.forEach((l, i) => { if (re.test(l)) hits.push(`${f}:${i + 1} [${id}] ${l.trim().slice(0, 140)}`); });
  }
}

if (hits.length) {
  console.error(hits.join('\n'));
  console.error(`\n${hits.length} reference(s) to removed connectors. Remove them, or (only if historical/archival) add to ALLOW in scripts/check-removed-connectors.mjs.`);
  process.exit(1);
}
console.log('check-removed-connectors: OK');
