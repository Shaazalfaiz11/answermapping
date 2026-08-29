'use client';

import Image from 'next/image';
import { useCallback, useState } from 'react';
import { PrimaryButton } from '@/components/ui/PrimaryButton';
import { countPages, isPdf } from '@/lib/pdf';
import { HeroAvatar } from './HeroAvatar';
import { UploadDropzone, type SelectedFile } from './UploadDropzone';
import styles from './UploadScreen.module.css';

/**
 * Upload → start processing (Figma `1:8744` empty, `1:8797` filled).
 *
 * Nothing is uploaded to a server: the whole pipeline runs from the browser,
 * so the files stay in memory here and the page count is read locally with
 * pdf.js. The design's filled state wants that count, and reading it at pick
 * time also surfaces an unreadable PDF at the moment it is chosen rather than
 * a stage into the run.
 */

type Slot = 'questionPaper' | 'answerSheet';

const MAX_BYTES = 10 * 1024 * 1024;

export function UploadScreen({
  onStart,
  error,
}: {
  onStart: (questionFiles: File[], answerFiles: File[]) => void;
  /** A failure from a previous run, shown in place of the hint. */
  error?: string | null;
}) {
  const [files, setFiles] = useState<Record<Slot, SelectedFile | null>>({
    questionPaper: null,
    answerSheet: null,
  });
  const [errors, setErrors] = useState<Record<Slot, string | null>>({
    questionPaper: null,
    answerSheet: null,
  });
  /** Slots still being read, so "Start Mapping" cannot fire against a half-read pick. */
  const [reading, setReading] = useState<ReadonlySet<Slot>>(new Set());

  const handleSelect = useCallback(async (slot: Slot, chosen: File[]) => {
    setErrors((current) => ({ ...current, [slot]: null }));

    const bytes = chosen.reduce((total, f) => total + f.size, 0);
    if (bytes > MAX_BYTES) {
      setErrors((current) => ({
        ...current,
        [slot]: 'That is over 10MB. Please choose a smaller file.',
      }));
      return;
    }

    if (chosen.some(isPdf) && chosen.length > 1) {
      setErrors((current) => ({
        ...current,
        [slot]: 'Choose either one PDF or a set of images, not both.',
      }));
      return;
    }

    // Show the card straight away; the page count follows once pdf.js has read it.
    setFiles((current) => ({ ...current, [slot]: { files: chosen, pageCount: null } }));
    setReading((current) => new Set(current).add(slot));

    try {
      const counts = await Promise.all(chosen.map(countPages));
      setFiles((current) => ({
        ...current,
        [slot]: { files: chosen, pageCount: counts.reduce((a, b) => a + b, 0) },
      }));
    } catch {
      setFiles((current) => ({ ...current, [slot]: null }));
      setErrors((current) => ({
        ...current,
        [slot]: 'That file could not be read. Is the PDF valid?',
      }));
    } finally {
      setReading((current) => {
        const next = new Set(current);
        next.delete(slot);
        return next;
      });
    }
  }, []);

  const handleRemove = useCallback((slot: Slot) => {
    setFiles((current) => ({ ...current, [slot]: null }));
    setErrors((current) => ({ ...current, [slot]: null }));
  }, []);

  const bothReady =
    files.questionPaper !== null && files.answerSheet !== null && reading.size === 0;

  return (
    <div className={styles.screen}>
      <span className={`${styles.glow} ${styles.glowBack}`} aria-hidden="true">
        <Image src="/figma/bg-ellipse-16.svg" alt="" width={1113} height={428} />
      </span>
      <span className={`${styles.glow} ${styles.glowFront}`} aria-hidden="true">
        <Image src="/figma/bg-ellipse-17.svg" alt="" width={1318} height={428} />
      </span>

      <div className={styles.stack}>
        <div className={styles.heading}>
          <h1 className={styles.titleRow}>
            <span className={styles.title}>Upload</span>
            <span className={styles.titleChip}>
              <span>Question Paper &amp; Answer Sheets</span>
            </span>
          </h1>
          <p className={styles.subtitle}>Upload both files to get started</p>
        </div>

        <HeroAvatar />

        <UploadDropzone
          questionPaper={files.questionPaper}
          answerSheet={files.answerSheet}
          errors={errors}
          disabled={false}
          onSelect={handleSelect}
          onRemove={handleRemove}
        />
      </div>

      <div className={styles.footer}>
        <PrimaryButton
          onClick={() => {
            if (bothReady) {
              onStart(files.questionPaper!.files, files.answerSheet!.files);
            }
          }}
          disabled={!bothReady}
        >
          Start Mapping
        </PrimaryButton>
        <p className={`${styles.hint} ${error ? styles.hintError : ''}`}>
          {error ??
            'Once both files are uploaded, you’ll able to map answers with questions'}
        </p>
      </div>
    </div>
  );
}
