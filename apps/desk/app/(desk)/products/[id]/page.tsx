import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { ComplianceCheck } from '@etsy-agents/core/domain/types.ts';
import { ApproveForm, RejectForm } from '../../../../components/DecisionForms.tsx';
import { StateBadge } from '../../../../components/StateBadge.tsx';
import { UploadForm } from '../../../../components/UploadForm.tsx';
import { dateTime, eur, PRODUCT_TYPE_LABELS } from '../../../../lib/format.ts';
import { getDeskService } from '../../../../lib/service.ts';
import { requireSession } from '../../../../lib/session.ts';
import { doneNotice, isUuid } from '../../../../lib/validate.ts';

export const metadata: Metadata = { title: 'Product' };

function ComplianceTable({ checks }: { checks: ComplianceCheck[] }) {
  if (checks.length === 0) return <p className="muted">No compliance checks yet.</p>;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th scope="col">Stage</th>
            <th scope="col">Verdict</th>
            <th scope="col">Reasons</th>
            <th scope="col">Flagged / trademarks</th>
            <th scope="col">When</th>
          </tr>
        </thead>
        <tbody>
          {checks.map((c) => (
            <tr key={c.id}>
              <td>{c.stage}</td>
              <td>
                <span className={c.verdict === 'pass' ? 'badge badge-ok' : 'badge badge-bad'}>{c.verdict}</span>
              </td>
              <td>
                {c.reasons.length ? (
                  <ul className="plain">
                    {c.reasons.map((r, i) => (
                      <li key={i}>{r}</li>
                    ))}
                  </ul>
                ) : (
                  '–'
                )}
              </td>
              <td>
                {c.flaggedTerms.length ? <div>Terms: {c.flaggedTerms.join(', ')}</div> : null}
                {c.trademarkHits.map((t) => (
                  <div key={`${t.serial}-${t.mark}`}>
                    {t.mark} ({t.status}, class {t.classes.join('/')}, #{t.serial})
                  </div>
                ))}
                {!c.flaggedTerms.length && !c.trademarkHits.length ? '–' : null}
              </td>
              <td className="small">{dateTime(c.createdAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default async function ProductPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireSession();
  const { id } = await params;
  const notice = doneNotice((await searchParams).done);
  if (!isUuid(id)) notFound();
  const svc = await getDeskService();
  const detail = await svc.getProduct(id);
  if (!detail) notFound();

  const { product, niche, design, listing, complianceChecks, estimatedMarginEur } = detail;
  const price = listing?.priceEur ?? product.targetPriceEur;
  const marginShare = estimatedMarginEur !== null && price > 0 ? estimatedMarginEur / price : null;
  const assetUrl = (kind: 'art' | 'edited' | 'print') => `/products/${product.id}/asset/${kind}`;
  const images: { kind: 'art' | 'edited' | 'print'; label: string; show: boolean }[] = [
    { kind: 'art', label: 'Raw AI art', show: Boolean(design?.artKey) },
    { kind: 'edited', label: 'Your edited file', show: Boolean(design?.editedKey) },
    { kind: 'print', label: 'Print file (QA)', show: Boolean(design?.printKey) },
  ];

  return (
    <>
      <p className="small">
        <Link href="/queue">← Queue</Link>
      </p>
      <div className="page-head">
        <h1>{product.conceptTitle}</h1>
        <StateBadge state={product.state} />
      </div>

      {notice ? (
        <div className="banner banner-ok" role="status">
          {notice}
        </div>
      ) : null}

      {product.blockReason ? (
        <div className="banner banner-bad" role="status">
          Blocked: {product.blockReason}
        </div>
      ) : null}

      {product.state === 'designed' ? (
        <section className="card" aria-labelledby="upload">
          <h2 id="upload">Your edit is needed</h2>
          <p className="small muted">
            Download the raw art, edit it, and upload the finished PNG. QA upscales it to the print size.
            {product.attempt > 0 ? ` QA sent this back (redesign ${product.attempt} of 2).` : ''}
          </p>
          {design?.qaNotes.length ? (
            <ul className="plain small">
              {design.qaNotes.map((n, i) => (
                <li key={i}>{n}</li>
              ))}
            </ul>
          ) : null}
          <UploadForm productId={product.id} />
        </section>
      ) : null}

      {product.state === 'drafted' ? (
        <section className="card" aria-labelledby="decide">
          <h2 id="decide">Approve or reject the Etsy draft</h2>
          <div className="grid grid-2">
            <ApproveForm productId={product.id} title={listing?.title ?? product.conceptTitle} />
            <RejectForm productId={product.id} />
          </div>
        </section>
      ) : null}

      <div className="grid grid-2">
        <section className="card" aria-labelledby="overview">
          <h2 id="overview">Overview</h2>
          <dl className="kv">
            <dt>Product</dt>
            <dd>{PRODUCT_TYPE_LABELS[product.productType]}</dd>
            <dt>Niche</dt>
            <dd>{niche.theme}</dd>
            <dt>Keywords</dt>
            <dd>{niche.keywords.join(', ') || '–'}</dd>
            <dt>Phrase</dt>
            <dd>{product.designPhrase ?? '–'}</dd>
            <dt>Style</dt>
            <dd>{product.styleNotes || '–'}</dd>
            <dt>Target price</dt>
            <dd>{eur(product.targetPriceEur)}</dd>
            <dt>Est. margin</dt>
            <dd>
              {eur(estimatedMarginEur)}
              {marginShare !== null ? ` (${Math.round(marginShare * 100)}% of ${eur(price)})` : ''}
            </dd>
            <dt>Updated</dt>
            <dd>{dateTime(product.updatedAt)}</dd>
          </dl>
        </section>

        <section className="card" aria-labelledby="niche">
          <h2 id="niche">Niche brief</h2>
          <p className="prewrap">{niche.brief}</p>
          {niche.reasoning ? (
            <>
              <h3>Validator reasoning</h3>
              <p className="prewrap small">{niche.reasoning}</p>
            </>
          ) : null}
        </section>
      </div>

      <section className="card" aria-labelledby="images">
        <h2 id="images">Design files</h2>
        {design ? (
          <>
            <div className="images">
              {images
                .filter((im) => im.show)
                .map((im) => (
                  <figure key={im.kind}>
                    <a href={assetUrl(im.kind)} target="_blank" rel="noopener">
                      <img src={assetUrl(im.kind)} alt={`${im.label} for ${product.conceptTitle}`} loading="lazy" />
                    </a>
                    <figcaption>
                      {im.label} · <a href={`${assetUrl(im.kind)}?download=1`}>download</a>
                    </figcaption>
                  </figure>
                ))}
            </div>
            <dl className="kv small">
              <dt>Model</dt>
              <dd>{design.model}</dd>
              <dt>Seed</dt>
              <dd>{design.seed ?? '–'}</dd>
              <dt>Prompt</dt>
              <dd className="prewrap">{design.prompt}</dd>
            </dl>
          </>
        ) : (
          <p className="muted">No design yet.</p>
        )}
      </section>

      <section className="card" aria-labelledby="listing">
        <h2 id="listing">Listing copy</h2>
        {listing ? (
          <div className="stack">
            <dl className="kv">
              <dt>Title</dt>
              <dd>
                {listing.title} <span className="muted small">({listing.title.length}/140)</span>
              </dd>
              <dt>Price</dt>
              <dd>{eur(listing.priceEur)}</dd>
              <dt>Printify</dt>
              <dd>{listing.printifyProductId ?? '–'}</dd>
              <dt>Etsy listing</dt>
              <dd>{listing.etsyListingId ?? '–'}</dd>
            </dl>
            <div>
              <h3>Tags ({listing.tags.length}/13)</h3>
              <ul className="tags">
                {listing.tags.map((t) => (
                  <li key={t}>{t}</li>
                ))}
              </ul>
            </div>
            <div>
              <h3>Description</h3>
              <p className="prewrap">{listing.description}</p>
            </div>
          </div>
        ) : (
          <p className="muted">No listing copy yet.</p>
        )}
      </section>

      <section className="card" aria-labelledby="compliance">
        <h2 id="compliance">Compliance</h2>
        <ComplianceTable checks={complianceChecks} />
      </section>
    </>
  );
}
