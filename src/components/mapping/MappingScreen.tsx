'use client';

import Image from 'next/image';
import { useMemo, useState } from 'react';
import type { PipelineOutput } from '@/lib/pipeline';
import { PageViewer } from './PageViewer';
import { QuestionCard } from './QuestionCard';
import styles from './MappingScreen.module.css';

/**
 * Question ↔ answer mapping (Figma `1:8861`).
 *
 * Two panes: the extracted questions with what each scored, and the answer
 * sheet with the mapped regions drawn over it. Everything shown comes from the
 * pipeline run; nothing is recomputed here.
 *
 * Expanding a question also focuses its answer in the viewer, which is what
 * makes the two panes one screen rather than two lists side by side.
 */
export function MappingScreen({ result }: { result: PipelineOutput }) {
  const { questions, mappings, grades, orphans, summary, answerPages } = result;

  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pane, setPane] = useState<'questions' | 'answers'>('questions');

  const mappingByQuestionId = useMemo(
    () => new Map(mappings.map((m) => [m.questionId, m])),
    [mappings],
  );

  const gradeByQuestionId = useMemo(
    () => new Map(grades.map((g) => [g.questionId, g])),
    [grades],
  );

  /*
   * The paper as a whole. Every figure is counted from the run rather than
   * asserted, and the score is shown only when the paper actually printed
   * marks — a percentage invented for a paper with no marks would be the one
   * number on screen that means nothing.
   */
  const overview = useMemo(() => {
    const graded = grades.filter((g) => g.verdict !== 'unanswered');

    return {
      questions: questions.length,
      answered: summary.answeredCount,
      unanswered: summary.unansweredCount,
      unmatched: summary.orphanCount,
      correct: graded.filter((g) => g.verdict === 'correct').length,
      partial: graded.filter((g) => g.verdict === 'partial').length,
      incorrect: graded.filter((g) => g.verdict === 'incorrect').length,
    };
  }, [questions, grades, summary]);

  // A card opens if there is something to show: a mapped answer to highlight,
  // or feedback to read. "Expand All" reflects the same rule.
  const expandableIds = useMemo(
    () =>
      questions
        .filter(
          (q) =>
            mappingByQuestionId.get(q.id)?.answered ||
            Boolean(gradeByQuestionId.get(q.id)?.feedback),
        )
        .map((q) => q.id),
    [questions, mappingByQuestionId, gradeByQuestionId],
  );

  const allExpanded =
    expandableIds.length > 0 && expandableIds.every((id) => expanded.has(id));

  function toggle(questionId: string) {
    const opening = !expanded.has(questionId);

    setExpanded((current) => {
      const next = new Set(current);
      if (opening) next.add(questionId);
      else next.delete(questionId);
      return next;
    });

    /*
     * The highlight follows the question clicked last, not whichever open card
     * comes first in the list. With several cards open those are different
     * questions, and the viewer jumping to an older selection reads as the
     * highlight landing on the wrong answer.
     */
    setSelectedId(opening ? questionId : null);
  }

  return (
    <div className={styles.screen}>
      <span className={`${styles.glow} ${styles.glowTop}`} aria-hidden="true">
        <Image src="/figma/bg-ellipse-17.svg" alt="" width={1113} height={428} />
      </span>

      <div className={`${styles.left} ${pane === 'answers' ? styles.paneHidden : ''}`}>
        <div className={styles.leftInner}>
          <div className={styles.listHeader}>
            <span className={styles.listTitle}>
              Extracted Questions (from question paper)
            </span>

            <div className={styles.toggle}>
              <button
                type="button"
                className={`${styles.toggleOption} ${styles.toggleOptionActive}`}
                onClick={() => setPane('questions')}
              >
                Questions
              </button>
              <button
                type="button"
                className={styles.toggleOption}
                onClick={() => setPane('answers')}
              >
                Answers
              </button>
            </div>

            <button
              type="button"
              className={styles.expandAll}
              onClick={() => {
                setExpanded(allExpanded ? new Set() : new Set(expandableIds));
                if (allExpanded) setSelectedId(null);
              }}
              disabled={expandableIds.length === 0}
            >
              {allExpanded ? 'Collapse All' : 'Expand All'}
            </button>
          </div>

          <div className={styles.summary}>
            <Stat label="Questions" value={overview.questions} />
            <Stat label="Answered" value={overview.answered} />
            <Stat label="Unanswered" value={overview.unanswered} />
            <Stat label="Unmatched answers" value={overview.unmatched} />
            <Stat label="Correct" value={overview.correct} />
            <Stat label="Partial" value={overview.partial} />
            <Stat label="Incorrect" value={overview.incorrect} />

            {summary.totalMax > 0 ? (
              <span className={`${styles.summaryStat} ${styles.summaryScore}`}>
                <span className={styles.summaryValue}>
                  {summary.totalScore} / {summary.totalMax}
                </span>
                <span>marks</span>
              </span>
            ) : (
              <span className={styles.summaryNote}>
                No score: this paper prints no marks to grade against.
              </span>
            )}

            {summary.overallFeedback ? (
              <span className={styles.summaryNote}>{summary.overallFeedback}</span>
            ) : null}
          </div>

          {questions.map((question) => (
            <QuestionCard
              key={question.id}
              question={question}
              grade={gradeByQuestionId.get(question.id) ?? null}
              mapping={mappingByQuestionId.get(question.id) ?? null}
              expanded={expanded.has(question.id)}
              onToggle={() => toggle(question.id)}
            />
          ))}

          {orphans.length > 0 ? (
            <div className={styles.summary}>
              <span className={styles.summaryNote}>
                {orphans.length} answer{orphans.length > 1 ? 's' : ''} matched no
                question. Select one to see where it sits on the sheet.
              </span>
              {orphans.map((orphan) => (
                <button
                  key={orphan.blockId}
                  type="button"
                  className={`${styles.summaryStat} ${
                    selectedId === orphan.blockId ? styles.summaryScore : ''
                  }`}
                  onClick={() =>
                    setSelectedId(selectedId === orphan.blockId ? null : orphan.blockId)
                  }
                >
                  <span className={styles.summaryValue}>
                    {orphan.writtenLabel ?? `Page ${orphan.pageIndex + 1}`}
                  </span>
                  <span>{orphan.text.slice(0, 60) || 'diagram'}</span>
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </div>

      <div className={`${styles.right} ${pane === 'questions' ? styles.paneHidden : ''}`}>
        <div className={styles.toggle}>
          <button
            type="button"
            className={styles.toggleOption}
            onClick={() => setPane('questions')}
          >
            Questions
          </button>
          <button
            type="button"
            className={`${styles.toggleOption} ${styles.toggleOptionActive}`}
            onClick={() => setPane('answers')}
          >
            Answers
          </button>
        </div>

        <PageViewer
          pages={answerPages}
          questions={questions}
          mappings={mappings}
          orphans={orphans}
          focusedId={selectedId}
        />
      </div>
    </div>
  );
}

/** One count in the overall strip. */
function Stat({ label, value }: { label: string; value: number }) {
  return (
    <span className={styles.summaryStat}>
      <span className={styles.summaryValue}>{value}</span>
      <span>{label}</span>
    </span>
  );
}
