/**
 * Turn a migration run into a self-contained HTML report.
 *
 *   npx tsx scripts/report.ts runs/faithful-1786567595761 [--out report.html]
 *   npx tsx scripts/report.ts --all --out docs/report.html
 *
 * Reads the journal and summary a run already writes. No server, no build step,
 * no external assets — one file a reviewer can open. The point is that the
 * evidence should be checkable without watching a video or installing anything.
 */

import 'dotenv/config';
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { dirname, basename } from 'node:path';
import type { JournalEntry } from '../src/cutover/index.js';
import type { ReadinessVerdict } from '../src/agent/types.js';

interface Summary {
  variant: string;
  contract: string;
  agreementRate: number;
  verdict: ReadinessVerdict;
  result: {
    phase: string;
    unprotectedSamples: number;
    degradedSamples: number;
    totalSamples: number;
    grantTx?: string;
    revokeTx?: string;
    abortReason?: string;
  };
}

interface Run {
  name: string;
  journal: JournalEntry[];
  summary: Summary | null;
}

const EXPLORER = 'https://sepolia.etherscan.io/tx/';

const esc = (s: unknown): string =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

function loadRun(stem: string): Run {
  const journal = existsSync(`${stem}.jsonl`)
    ? readFileSync(`${stem}.jsonl`, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : [];
  const summary = existsSync(`${stem}.summary.json`)
    ? (JSON.parse(readFileSync(`${stem}.summary.json`, 'utf8')) as Summary)
    : null;
  return { name: basename(stem), journal, summary };
}

function txCell(hash?: string): string {
  if (!hash) return '';
  return `<a href="${EXPLORER}${esc(hash)}" target="_blank" rel="noopener"><code>${esc(
    hash.slice(0, 18),
  )}…</code></a>`;
}

function renderRun(run: Run): string {
  const s = run.summary;
  const blocked = s?.result.phase === 'ABORTED';
  const rate = s ? Math.round(s.agreementRate * 100) : null;

  const phases = run.journal
    .map((e) => {
      const cls = e.phase === 'ABORTED' ? 'abort' : e.phase === 'ATTEST' ? 'ok' : '';
      const gas = e.gasUsed ? `<td class="num">${esc(Number(e.gasUsed).toLocaleString())}</td>` : '<td></td>';
      return `<tr class="${cls}">
        <td><span class="phase">${esc(e.phase)}</span></td>
        <td>${esc(e.detail)}</td>
        ${gas}
        <td>${txCell(e.txHash)}</td>
      </tr>`;
    })
    .join('\n');

  const disagreements = (s?.verdict.disagreements ?? [])
    .map(
      (d) => `<li>
        <span class="tag ${d.classification === 'regression' ? 'bad' : 'meh'}">${esc(d.classification)}</span>
        <span class="mono dim">block ${esc(d.block)}</span>
        <p>${esc(d.reasoning)}</p>
      </li>`,
    )
    .join('\n');

  const blocking = (s?.verdict.blockingIssues ?? [])
    .map((b) => `<li>${esc(b)}</li>`)
    .join('\n');

  return `
<section class="run ${blocked ? 'is-blocked' : 'is-done'}">
  <header>
    <h2>${esc(s?.variant ?? run.name)}</h2>
    <div class="badges">
      ${rate !== null ? `<span class="badge">agreement ${rate}%</span>` : ''}
      <span class="badge ${blocked ? 'bad' : 'good'}">${esc(s?.verdict.verdict ?? '—')}</span>
      <span class="badge">${esc(s?.result.phase ?? '—')}</span>
    </div>
  </header>

  ${
    s
      ? `<p class="verdict">${esc(s.verdict.reasoning)}</p>`
      : ''
  }

  ${blocking ? `<div class="callout"><h4>Blocking</h4><ul>${blocking}</ul></div>` : ''}
  ${disagreements ? `<h4>Disagreements the adjudicator classified</h4><ul class="dis">${disagreements}</ul>` : ''}

  <h4>Journal</h4>
  <div class="tablewrap">
    <table>
      <thead><tr><th>phase</th><th>detail</th><th class="num">gas</th><th>tx</th></tr></thead>
      <tbody>${phases}</tbody>
    </table>
  </div>

  ${
    s
      ? `<div class="metrics">
          <div><b>${s.result.unprotectedSamples}</b><span>uncovered samples<em>no keeper at all — ours to own</em></span></div>
          <div><b>${s.result.degradedSamples}</b><span>degraded samples<em>past the window — pre-existing</em></span></div>
          <div><b>${s.result.totalSamples}</b><span>samples taken</span></div>
        </div>`
      : ''
  }
</section>`;
}

// ── entry ──────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const outIdx = argv.indexOf('--out');
const out = outIdx !== -1 ? argv[outIdx + 1]! : 'docs/report.html';
const wantAll = argv.includes('--all');
const explicit = argv.filter((a) => !a.startsWith('--') && a !== out);

const stems = wantAll
  ? [...new Set(readdirSync('runs').filter((f) => f.endsWith('.jsonl')).map((f) => `runs/${f.replace(/\.jsonl$/, '')}`))]
  : explicit;

if (!stems.length) {
  console.error('usage: tsx scripts/report.ts <runs/name> [more…] | --all  [--out docs/report.html]');
  process.exit(1);
}

const runs = stems.map(loadRun).sort((a, b) => {
  // Refusals first: the interlock is the thing worth seeing before the success.
  const ab = a.summary?.result.phase === 'ABORTED' ? 0 : 1;
  const bb = b.summary?.result.phase === 'ABORTED' ? 0 : 1;
  return ab - bb;
});

const totalTx = runs.reduce(
  (n, r) => n + r.journal.filter((e) => e.txHash).length,
  0,
);

const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Understudy — migration report</title>
<style>
  :root{
    --bg:#fbfaf8; --fg:#1a1917; --dim:#6b6862; --line:#e2ded7;
    --card:#fff; --good:#1f6f43; --goodbg:#e8f4ed; --bad:#9a2c2c; --badbg:#fbecec;
    --meh:#7a5a12; --mehbg:#fdf3df; --mono:ui-monospace,SFMono-Regular,Menlo,monospace;
  }
  @media (prefers-color-scheme:dark){:root:not([data-theme=light]){
    --bg:#14130f; --fg:#eceae5; --dim:#9a958c; --line:#2e2b25; --card:#1c1a16;
    --good:#7fd0a1; --goodbg:#16281e; --bad:#f0a0a0; --badbg:#2b1717;
    --meh:#e0c078; --mehbg:#2a2314;
  }}
  :root[data-theme=dark]{
    --bg:#14130f; --fg:#eceae5; --dim:#9a958c; --line:#2e2b25; --card:#1c1a16;
    --good:#7fd0a1; --goodbg:#16281e; --bad:#f0a0a0; --badbg:#2b1717;
    --meh:#e0c078; --mehbg:#2a2314;
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--fg);
    font:16px/1.6 ui-serif,Georgia,serif;-webkit-font-smoothing:antialiased}
  .wrap{max-width:920px;margin:0 auto;padding:48px 24px 96px}
  h1{font-size:clamp(28px,4vw,42px);line-height:1.15;margin:0 0 8px;letter-spacing:-.02em}
  .sub{color:var(--dim);margin:0 0 32px;font-size:18px}
  h2{font-size:24px;margin:0;letter-spacing:-.01em;text-transform:capitalize}
  h4{font-size:13px;text-transform:uppercase;letter-spacing:.08em;color:var(--dim);
     margin:28px 0 10px;font-family:var(--mono);font-weight:600}
  code,.mono,table{font-family:var(--mono)}
  a{color:inherit}
  .top{display:flex;flex-wrap:wrap;gap:10px;margin-bottom:40px}
  .stat{border:1px solid var(--line);background:var(--card);border-radius:10px;
        padding:12px 16px;min-width:130px}
  .stat b{display:block;font-family:var(--mono);font-size:22px;letter-spacing:-.02em}
  .stat span{font-size:12px;color:var(--dim);text-transform:uppercase;letter-spacing:.06em}
  .run{border:1px solid var(--line);background:var(--card);border-radius:14px;
       padding:24px;margin-bottom:28px}
  .run.is-blocked{border-left:4px solid var(--bad)}
  .run.is-done{border-left:4px solid var(--good)}
  .run header{display:flex;flex-wrap:wrap;gap:12px;align-items:center;
              justify-content:space-between;margin-bottom:14px}
  .badges{display:flex;gap:6px;flex-wrap:wrap}
  .badge{font-family:var(--mono);font-size:12px;padding:3px 9px;border-radius:999px;
         border:1px solid var(--line);color:var(--dim);text-transform:uppercase;letter-spacing:.05em}
  .badge.good{background:var(--goodbg);color:var(--good);border-color:transparent}
  .badge.bad{background:var(--badbg);color:var(--bad);border-color:transparent}
  .verdict{margin:0;padding:14px 16px;border-radius:8px;background:var(--bg);
           border:1px solid var(--line);font-size:15px}
  .callout{margin-top:20px;padding:14px 16px;border-radius:8px;
           background:var(--badbg);border:1px solid transparent}
  .callout h4{margin:0 0 8px;color:var(--bad)}
  .callout ul{margin:0;padding-left:18px;font-size:14px}
  .callout li+li{margin-top:8px}
  ul.dis{list-style:none;padding:0;margin:0}
  ul.dis li{border-top:1px solid var(--line);padding:12px 0}
  ul.dis p{margin:6px 0 0;font-size:14px;color:var(--dim)}
  .tag{font-family:var(--mono);font-size:11px;padding:2px 7px;border-radius:4px;
       text-transform:uppercase;letter-spacing:.05em}
  .tag.bad{background:var(--badbg);color:var(--bad)}
  .tag.meh{background:var(--mehbg);color:var(--meh)}
  .dim{color:var(--dim)}
  .tablewrap{overflow-x:auto}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th{text-align:left;color:var(--dim);font-weight:600;font-size:11px;
     text-transform:uppercase;letter-spacing:.06em;padding:6px 10px 6px 0;
     border-bottom:1px solid var(--line)}
  td{padding:8px 10px 8px 0;border-bottom:1px solid var(--line);vertical-align:top}
  td.num,th.num{text-align:right;padding-right:0}
  tr.abort td{color:var(--bad)}
  tr.ok td{color:var(--good)}
  .phase{font-size:11px;letter-spacing:.05em}
  .metrics{display:flex;flex-wrap:wrap;gap:24px;margin-top:24px;padding-top:20px;
           border-top:1px solid var(--line)}
  .metrics div{display:flex;gap:10px;align-items:baseline}
  .metrics b{font-family:var(--mono);font-size:26px;letter-spacing:-.02em}
  .metrics span{font-size:12px;color:var(--dim);text-transform:uppercase;letter-spacing:.05em}
  .metrics em{display:block;font-style:normal;text-transform:none;letter-spacing:0;opacity:.75}
  footer{margin-top:48px;padding-top:20px;border-top:1px solid var(--line);
         color:var(--dim);font-size:14px}
</style></head><body><div class="wrap">

<h1>Understudy</h1>
<p class="sub">Migration report — every phase, every transaction, and the judgment that gated the revoke.</p>

<div class="top">
  <div class="stat"><b>${totalTx}</b><span>transactions</span></div>
  <div class="stat"><b>${runs.length}</b><span>runs</span></div>
  <div class="stat"><b>${runs.filter((r) => r.summary?.result.phase === 'ABORTED').length}</b><span>refused</span></div>
  <div class="stat"><b>${runs.reduce((n, r) => n + (r.summary?.result.unprotectedSamples ?? 0), 0)}</b><span>uncovered samples</span></div>
</div>

${runs.map(renderRun).join('\n')}

<footer>
  Generated from the run journals in <code>runs/</code>. Every transaction links to
  Sepolia Etherscan. Sponsored internal transactions relayed by KeeperHub do not
  appear as top-level entries on the wallet — the journal is their record.
</footer>

</div></body></html>`;

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, html);
console.error(`wrote ${out}  ·  ${runs.length} run(s), ${totalTx} transaction(s)`);
