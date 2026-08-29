'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Chevron, Minus, Plus } from '@/components/ui/Icon';
import type { AnswerPage, OrphanAnswer, Question, QuestionMapping } from '@/lib/types';
import styles from './PageViewer.module.css';

/**
 * The answer sheet viewer (Figma `1:9017`).
 *
 * Regions arrive as normalized rectangles — origin top-left, both axes in
 * [0,1] — measured from the line bands this app detected itself. They are
 * turned into CSS percentages of the page stage, never into stored pixels.
 * That is the whole reason the coordinates are normalized upstream: the same
 * rect is correct at 50% zoom, at 200%, in a resized window and on a phone,
 * because the browser resolves the percentage against whatever the bitmap is
 * currently rendered at.
 *
 * An answer that runs onto the next page has one region per page, so a
 * continuation is drawn on the page it actually appears on rather than being
 * clipped to the first.
 */

const ZOOM_STEPS = [50, 75, 100, 125, 150, 200] as const;
const DEFAULT_ZOOM_INDEX = 2;

interface DrawnRegion {
  key: string;
  ownerId: string;
  label: string | null;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PageViewerProps {
  pages: AnswerPage[];
  questions: Question[];
  mappings: QuestionMapping[];
  orphans: OrphanAnswer[];
  /** Question or orphan currently selected; highlights it and dims the rest. */
  focusedId: string | null;
}

export function PageViewer({
  pages,
  questions,
  mappings,
  orphans,
  focusedId,
}: PageViewerProps) {
  const [zoomIndex, setZoomIndex] = useState<number>(DEFAULT_ZOOM_INDEX);
  const [page, setPage] = useState(1);
  const pagesRef = useRef<HTMLDivElement>(null);

  const zoom = ZOOM_STEPS[zoomIndex]!;
  const pageCount = pages.length;

  /** Every region to draw, grouped by the page it lies on. */
  const regionsByPage = useMemo(() => {
    const grouped = new Map<number, DrawnRegion[]>();
    const push = (pageIndex: number, region: DrawnRegion) => {
      const list = grouped.get(pageIndex) ?? [];
      list.push(region);
      grouped.set(pageIndex, list);
    };

    const labelOf = new Map(questions.map((q) => [q.id, q.label]));

    for (const mapping of mappings) {
      if (!mapping.answered) continue;
      mapping.regions.forEach((r, i) =>
        push(r.pageIndex, {
          key: `${mapping.questionId}-${i}`,
          ownerId: mapping.questionId,
          label: labelOf.get(mapping.questionId) ?? null,
          x: r.x,
          y: r.y,
          width: r.width,
          height: r.height,
        }),
      );
    }

    // An answer matching no question is still on the page, and a teacher needs
    // to see where it is rather than be told it exists.
    for (const orphan of orphans) {
      orphan.regions.forEach((r, i) =>
        push(r.pageIndex, {
          key: `${orphan.blockId}-${i}`,
          ownerId: orphan.blockId,
          label: null,
          x: r.x,
          y: r.y,
          width: r.width,
          height: r.height,
        }),
      );
    }

    return grouped;
  }, [questions, mappings, orphans]);

  const scrollToPage = useCallback((next: number) => {
    setPage(next);
    const stage = pagesRef.current?.querySelector<HTMLElement>(`[data-page="${next}"]`);
    stage?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  /** First page the focused answer actually appears on, 1-based. */
  const focusedPage = useMemo(() => {
    if (!focusedId) return null;

    const regions =
      mappings.find((m) => m.questionId === focusedId && m.answered)?.regions ??
      orphans.find((o) => o.blockId === focusedId)?.regions ??
      [];

    if (regions.length === 0) return null;
    return Math.min(...regions.map((r) => r.pageIndex)) + 1;
  }, [focusedId, mappings, orphans]);

  /*
   * Clicking a question has to bring its answer into view, not merely dim the
   * others. An answer four pages down would otherwise be highlighted correctly
   * and still invisible. One running across a page break opens at the page it
   * starts on.
   */
  useEffect(() => {
    if (focusedPage === null) return;
    scrollToPage(focusedPage);
  }, [focusedPage, scrollToPage]);

  if (pageCount === 0) {
    return (
      <div className={styles.viewer}>
        <ViewerHeader
          zoom={zoom}
          page={page}
          pageCount={0}
          onZoomIn={() => undefined}
          onZoomOut={() => undefined}
          onPrev={() => undefined}
          onNext={() => undefined}
        />
        <div className={styles.pages}>
          <p className={styles.empty}>
            The answer sheet has not been prepared yet, so there are no pages to show.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.viewer}>
      <ViewerHeader
        zoom={zoom}
        page={page}
        pageCount={pageCount}
        onZoomIn={() => setZoomIndex((i) => Math.min(i + 1, ZOOM_STEPS.length - 1))}
        onZoomOut={() => setZoomIndex((i) => Math.max(i - 1, 0))}
        onPrev={() => scrollToPage(Math.max(1, page - 1))}
        onNext={() => scrollToPage(Math.min(pageCount, page + 1))}
      />

      <div className={styles.pages} ref={pagesRef}>
        {pages.map((meta) => (
          <div
            key={meta.index}
            className={styles.page}
            data-page={meta.index + 1}
            style={{
              // Zoom scales the stage; the overlays follow because they are
              // sized as a percentage of it.
              width: `${zoom}%`,
              aspectRatio: `${meta.width} / ${meta.height}`,
            }}
          >
            {/* Plain <img>: the page is an in-memory data URL, so next/image
                has nothing to optimise and would only add a proxy hop. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              className={styles.pageImage}
              src={meta.dataUrl}
              alt={`Answer sheet page ${meta.index + 1}`}
              width={meta.width}
              height={meta.height}
              loading={meta.index === 0 ? 'eager' : 'lazy'}
            />

            {(regionsByPage.get(meta.index) ?? []).map((region) => {
              const dimmed = focusedId !== null && focusedId !== region.ownerId;

              return (
                <div
                  key={region.key}
                  className={[
                    styles.overlay,
                    dimmed ? styles.overlayDim : '',
                    focusedId === region.ownerId ? styles.overlayFocused : '',
                    region.label === null ? styles.overlayDiagram : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  style={{
                    left: `${region.x * 100}%`,
                    top: `${region.y * 100}%`,
                    width: `${region.width * 100}%`,
                    height: `${region.height * 100}%`,
                  }}
                >
                  <span className={`${styles.tag} ${region.label ? '' : styles.tagUnmapped}`}>
                    {region.label ? `Q${region.label.replace(/\s+/g, '')}` : 'Unmapped'}
                  </span>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

function ViewerHeader({
  zoom,
  page,
  pageCount,
  onZoomIn,
  onZoomOut,
  onPrev,
  onNext,
}: {
  zoom: number;
  page: number;
  pageCount: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onPrev: () => void;
  onNext: () => void;
}) {
  return (
    <div className={styles.header}>
      <span className={styles.title}>Answer Sheet</span>

      <div className={styles.controls}>
        <div className={styles.control}>
          <button
            type="button"
            className={styles.controlButton}
            onClick={onZoomOut}
            disabled={zoom <= ZOOM_STEPS[0]!}
            aria-label="Zoom out"
          >
            <Minus size={24} />
          </button>
          <span className={styles.controlValue}>{zoom}%</span>
          <button
            type="button"
            className={styles.controlButton}
            onClick={onZoomIn}
            disabled={zoom >= ZOOM_STEPS[ZOOM_STEPS.length - 1]!}
            aria-label="Zoom in"
          >
            <Plus size={24} />
          </button>
        </div>

        <div className={styles.control}>
          <button
            type="button"
            className={styles.controlButton}
            onClick={onPrev}
            disabled={page <= 1}
            aria-label="Previous page"
          >
            <Chevron direction="left" size={24} />
          </button>
          <span className={`${styles.controlValue} ${styles.controlValueWide}`}>
            Page {page} of {pageCount}
          </span>
          <button
            type="button"
            className={styles.controlButton}
            onClick={onNext}
            disabled={page >= pageCount}
            aria-label="Next page"
          >
            <Chevron direction="right" size={24} />
          </button>
        </div>
      </div>
    </div>
  );
}
