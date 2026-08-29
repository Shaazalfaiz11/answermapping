'use client';

import { useCallback, useState } from 'react';
import { AppShell } from '@/components/layout/AppShell';
import { MappingScreen } from '@/components/mapping/MappingScreen';
import { ProcessingScreen } from '@/components/processing/ProcessingScreen';
import { UploadScreen } from '@/components/upload/UploadScreen';
import { runPipeline, type PipelineOutput } from '@/lib/pipeline';
import type { StageId, StageState } from '@/lib/types';

/**
 * The whole flow lives on one route.
 *
 * There is no server-side assessment to navigate to: the pipeline runs from
 * the browser and its result is held in memory here, so upload → processing →
 * mapping is a state machine rather than three pages. A reload starts over,
 * which is the honest behaviour when nothing is persisted.
 */

const INITIAL_STAGES: StageState[] = [
  { id: 'render', label: 'Reading files', status: 'pending', progress: 0 },
  { id: 'questions', label: 'Extracting questions', status: 'pending', progress: 0 },
  { id: 'segment', label: 'Locating handwriting', status: 'pending', progress: 0 },
  { id: 'answers', label: 'Extracting answers', status: 'pending', progress: 0 },
  { id: 'mapping', label: 'Mapping answers', status: 'pending', progress: 0 },
  { id: 'grading', label: 'Grading', status: 'pending', progress: 0 },
];

type Phase = 'upload' | 'processing' | 'review';

export default function Page() {
  const [phase, setPhase] = useState<Phase>('upload');
  const [stages, setStages] = useState<StageState[]>(INITIAL_STAGES);
  const [result, setResult] = useState<PipelineOutput | null>(null);
  const [error, setError] = useState<string | null>(null);

  /*
   * Each stage owns its own row. Stages used to be marked done by virtue of a
   * later one starting, which was fine when they ran in strict sequence — but
   * question extraction and answer extraction now overlap, and that rule would
   * tick "questions" off the moment segmentation began, while it was still
   * running. A stage is done when it says it is.
   */
  const report = useCallback((stage: StageId, progress: number, detail?: string) => {
    setStages((prev) =>
      prev.map((s) =>
        s.id === stage
          ? {
              ...s,
              status: progress >= 1 ? 'done' : 'active',
              progress,
              detail: detail ?? s.detail,
            }
          : s,
      ),
    );
  }, []);

  const start = useCallback(
    async (questionFiles: File[], answerFiles: File[]) => {
      setPhase('processing');
      setStages(INITIAL_STAGES);
      setError(null);

      try {
        setResult(await runPipeline(questionFiles, answerFiles, report));
        setPhase('review');
      } catch (err) {
        setError(
          err instanceof Error ? err.message : 'The run failed. Please try again.',
        );
        setStages((prev) => {
          const activeIndex = prev.findIndex((s) => s.status === 'active');
          if (activeIndex === -1) return prev;
          return prev.map((s, i) => (i === activeIndex ? { ...s, status: 'error' } : s));
        });
      }
    },
    [report],
  );

  const reset = useCallback(() => {
    setPhase('upload');
    setStages(INITIAL_STAGES);
    setResult(null);
    setError(null);
  }, []);

  if (phase === 'processing') {
    return (
      <AppShell sidebar="collapsed" crumb="Processing">
        <ProcessingScreen stages={stages} error={error} onRetry={reset} />
      </AppShell>
    );
  }

  if (phase === 'review' && result) {
    return (
      <AppShell sidebar="collapsed" crumb="Answer mapping" fill>
        <MappingScreen result={result} />
      </AppShell>
    );
  }

  return (
    <AppShell crumb="Upload">
      <UploadScreen onStart={start} error={error} />
    </AppShell>
  );
}
