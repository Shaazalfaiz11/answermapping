'use client';

import { Chevron } from '@/components/ui/Icon';
import type { Grade, Question, QuestionMapping } from '@/lib/types';
import { ScoreBadge } from './ScoreBadge';
import styles from './QuestionCard.module.css';

/**
 * One question in the left pane (Figma `1:8901` collapsed, `1:8879`
 * expanded).
 *
 * The card shows the question, what it scored and — when open — the answer
 * that was mapped to it and the feedback grading wrote. Nothing here
 * recomputes a mark or decides an outcome.
 */

export interface QuestionCardProps {
  question: Question;
  grade: Grade | null;
  /** The mapping in force for this question, or null if nothing reached it. */
  mapping: QuestionMapping | null;
  expanded: boolean;
  onToggle: () => void;
}

export function QuestionCard({
  question,
  grade,
  mapping,
  expanded,
  onToggle,
}: QuestionCardProps) {
  // The design numbers a sub-question by its parent and shows the part letter
  // beneath, so 11 a and 11 b sit under one number.
  const part = question.subPart || null;
  const hasAnswer = Boolean(mapping?.answered);
  const hasFeedback = Boolean(grade?.feedback);

  /*
   * Selecting a question is what drives the highlight in the viewer, so it has
   * to be available whenever the question has an answer to point at — not only
   * when grading produced feedback for it.
   */
  const selectable = hasAnswer || hasFeedback;
  const verdict = verdictOf(grade, hasAnswer);

  /*
   * A content match is a judgement, not a fact, so a weak one is flagged for
   * the teacher rather than presented with the same certainty as a label the
   * student actually wrote.
   */
  const lowConfidence =
    hasAnswer && mapping!.method === 'content' && mapping!.confidence < 0.5;

  return (
    <div className={`${styles.card} ${expanded ? styles.cardExpanded : ''}`}>
      {/* The chevron below is the keyboard control; this only adds the larger
          click target a teacher expects from the whole row. */}
      <div
        className={`${styles.row} ${selectable ? styles.rowSelectable : ''}`}
        onClick={selectable ? onToggle : undefined}
      >
        <span className={`${styles.badge} ${expanded ? styles.badgeActive : ''}`}>
          <span>{question.number}</span>
          {part ? <span className={styles.badgePart}>{part}</span> : null}
        </span>

        <span className={styles.text}>
          {question.text}
          {hasAnswer ? null : (
            <span className={styles.meta}>
              <span className={styles.tag}>No answer mapped</span>
            </span>
          )}
          {verdict ? (
            <span className={styles.meta}>
              <span className={`${styles.tag} ${verdict.tone ? styles[verdict.tone] : ''}`}>
                {verdict.label}
              </span>
            </span>
          ) : null}
          {lowConfidence ? (
            <span className={styles.meta}>
              <span className={`${styles.tag} ${styles.tagPartial}`}>
                Low-confidence match — please check
              </span>
            </span>
          ) : null}
          {mapping?.regions && mapping.regions.length > 1 ? (
            <span className={styles.meta}>
              <span className={styles.tag}>
                Spans {mapping.regions.length} regions
              </span>
            </span>
          ) : null}
        </span>

        <span className={styles.trailing}>
          <ScoreBadge
            awarded={grade && grade.verdict !== 'unanswered' ? grade.score : null}
            maximum={grade?.maxScore ?? question.marks}
          />
          <button
            type="button"
            className={styles.toggle}
            onClick={(event) => {
              // The row is clickable too; without this the click lands twice
              // and the card closes as soon as it opens.
              event.stopPropagation();
              onToggle();
            }}
            aria-expanded={expanded}
            aria-label={expanded ? 'Collapse question' : 'Expand question'}
            disabled={!selectable}
          >
            <Chevron direction={expanded ? 'up' : 'down'} />
          </button>
        </span>
      </div>

      {expanded && (hasAnswer || hasFeedback) ? (
        <div className={styles.feedback}>
          {hasAnswer ? (
            <>
              <span className={styles.feedbackTitle}>Student answer</span>
              <p className={styles.feedbackBody}>{mapping!.answerText}</p>
            </>
          ) : null}

          {hasFeedback ? (
            <>
              <span className={styles.feedbackTitle}>AI Feedback</span>
              <p className={styles.feedbackBody}>{grade!.feedback}</p>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

type Verdict = {
  label: string;
  tone: 'tagCorrect' | 'tagPartial' | 'tagIncorrect' | null;
};

/**
 * What the marks say about this answer.
 *
 * Derived from the score rather than asked of the model separately, so the
 * label and the number beside it can never disagree.
 */
function verdictOf(grade: Grade | null, hasAnswer: boolean): Verdict | null {
  if (!grade || !hasAnswer) return null;
  if (grade.verdict === 'unanswered') return null;

  if (grade.score >= grade.maxScore) return { label: 'Correct', tone: 'tagCorrect' };
  if (grade.score <= 0) return { label: 'Incorrect', tone: 'tagIncorrect' };
  return { label: 'Partially correct', tone: 'tagPartial' };
}
