'use client';

import Image from 'next/image';
import { PrimaryButton } from '@/components/ui/PrimaryButton';
import type { StageId, StageState } from '@/lib/types';
import { AnalysingLoader } from './AnalysingLoader';
import styles from './ProcessingScreen.module.css';

/**
 * Processing (Figma `1:9959`).
 *
 * The frame shows one thing: a centred loader reading "Extracting…" over
 * "This may take a while". That is reproduced exactly, with the headline
 * driven by the stage actually running rather than being fixed.
 *
 * Two blocks below are additions, because the frame has no equivalent and
 * the screen needs them: a six-segment stage indicator, and a failure state.
 * Both are built from the existing tokens and positioned so they cannot move
 * the loader off its measured centre.
 */

/** The headline for each stage. "Extracting…" is the design's own wording. */
const STAGE_HEADLINE: Record<StageId, string> = {
  render: 'Preparing...',
  questions: 'Extracting...',
  segment: 'Locating...',
  answers: 'Reading answers...',
  mapping: 'Mapping...',
  grading: 'Grading...',
};

const STAGE_CAPTION: Record<StageId, string> = {
  render: 'Rendering the uploaded pages',
  questions: 'Reading the question paper',
  segment: 'Finding the lines of handwriting',
  answers: 'Transcribing the answer sheet',
  mapping: 'Matching answers to questions',
  grading: 'Marking and writing feedback',
};

export function ProcessingScreen({
  stages,
  error,
  onRetry,
}: {
  stages: StageState[];
  error: string | null;
  onRetry: () => void;
}) {
  const active = stages.find((s) => s.status === 'active') ?? null;
  const failed = stages.find((s) => s.status === 'error') ?? null;
  const done = stages.filter((s) => s.status === 'done').length;

  const percent = Math.round(((done + (active?.progress ?? 0)) / stages.length) * 100);

  if (error) {
    return (
      <div className={styles.screen}>
        <Glows />
        <div className={styles.failure}>
          <FailureMark />
          <div className={styles.failureText}>
            <p className={styles.failureTitle}>Processing could not finish</p>
            <p className={styles.failureMessage}>{error}</p>
            {failed ? (
              <p className={styles.failureStage}>
                Stopped at {STAGE_CAPTION[failed.id].toLowerCase()}
              </p>
            ) : null}
          </div>
          <div className={styles.actions}>
            <PrimaryButton onClick={onRetry}>Upload again</PrimaryButton>
          </div>
        </div>

        <StageProgress stages={stages} current={failed} percent={percent} failed />
      </div>
    );
  }

  return (
    <div className={styles.screen}>
      <Glows />
      <AnalysingLoader
        headline={active ? STAGE_HEADLINE[active.id] : 'Extracting...'}
        subtext={active?.detail ?? 'This may take a while'}
      />
      <StageProgress
        stages={stages}
        current={active}
        percent={percent}
        caption={active ? STAGE_CAPTION[active.id] : 'Getting ready'}
      />
    </div>
  );
}

/** NOT IN FIGMA — one segment per pipeline stage. */
function StageProgress({
  stages,
  current,
  percent,
  caption,
  failed = false,
}: {
  stages: StageState[];
  current: StageState | null;
  percent: number;
  caption?: string;
  failed?: boolean;
}) {
  // Derived from the stage rather than the percentage: the first stage
  // reports 0% progress but is genuinely under way.
  const currentIndex = current ? stages.findIndex((s) => s.id === current.id) : -1;

  return (
    <div className={styles.progress}>
      <div
        className={styles.track}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-label="Processing progress"
      >
        {stages.map((entry, index) => {
          let tone = '';
          if (index < currentIndex || entry.status === 'done') tone = styles.segmentDone!;
          else if (index === currentIndex) {
            tone = failed ? styles.segmentFailed! : styles.segmentActive!;
          }

          return <span key={entry.id} className={`${styles.segment} ${tone}`} />;
        })}
      </div>

      {caption ? (
        <p className={styles.caption}>
          {currentIndex >= 0
            ? `Step ${currentIndex + 1} of ${stages.length} · ${caption}`
            : caption}
          {currentIndex >= 0 ? ` · ${percent}%` : ''}
        </p>
      ) : null}

      {/*
        The free tier allows about 8,000 tokens a minute, and the run waits on
        that budget far more than on the model. Saying so keeps a three-minute
        wait from reading as the app having hung.
      */}
      {!failed ? (
        <p className={styles.notice}>
          Paced to stay inside the Groq free tier, so this takes a few minutes.
        </p>
      ) : null}
    </div>
  );
}

function Glows() {
  return (
    <>
      <span className={`${styles.glow} ${styles.glowTop}`} aria-hidden="true">
        <Image src="/figma/bg-ellipse-17.svg" alt="" width={1113} height={428} />
      </span>
      <span className={`${styles.glow} ${styles.glowBottom}`} aria-hidden="true">
        <Image src="/figma/bg-ellipse-16.svg" alt="" width={1318} height={428} />
      </span>
    </>
  );
}

function FailureMark() {
  return (
    <span className={styles.failureMark} aria-hidden="true">
      <svg width={28} height={28} viewBox="0 0 24 24" fill="none">
        <path
          d="M12 8v5m0 3.5h.01M10.3 3.9 2.6 17.1A2 2 0 0 0 4.3 20h15.4a2 2 0 0 0 1.7-2.9L13.7 3.9a2 2 0 0 0-3.4 0Z"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  );
}
