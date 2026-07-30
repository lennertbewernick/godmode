/**
 * The one door out of this app.
 *
 * CSV and JSON export used to be four buttons for two actions — a pair in History's Sessions
 * card and another pair in Settings' Backups card — so "how do I get my data out" had two
 * different answers depending on where you happened to be looking. Both pairs now point here.
 *
 * What is deliberately NOT in here: restore. Restore is import, and it is the one control in
 * the app that destroys data — `restoreBackup` clears every store before it writes. Filing it
 * under a sheet labelled "Share & export" would mislabel it and sit a destructive action one
 * press away from two harmless ones. It stays in Settings beside the copy that explains it.
 */

import { useState, type ReactNode } from 'react';
import { ShareCardPreview } from './ShareCard.js';
import type { ShareCardData } from './shareCardData.js';
import { Modal } from './kit.js';

function Option({
  label,
  description,
  onSelect,
  disabled = false,
}: {
  label: string;
  description: ReactNode;
  onSelect: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={disabled}
      className="min-h-14 w-full rounded-xl border border-[#33405c] px-4 py-3 text-left transition-colors hover:bg-[#1c2740] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
    >
      <span className="block font-semibold text-slate-100">{label}</span>
      <span className="mt-0.5 block text-sm leading-relaxed text-slate-400">{description}</span>
    </button>
  );
}

export function ExportSheet({
  onClose,
  onExportCsv,
  onExportJson,
  canExportCsv,
  card,
}: {
  onClose: () => void;
  onExportCsv: () => void;
  onExportJson: () => void;
  /** False when no workout is selected — there is nothing to write a CSV about. */
  canExportCsv: boolean;
  /** Absent when there is nothing to draw; the card option is then not offered at all. */
  card?: ShareCardData;
}) {
  const [mode, setMode] = useState<'menu' | 'card'>('menu');

  const run = (action: () => void) => () => {
    action();
    onClose();
  };

  if (mode === 'card' && card) {
    return (
      <Modal title="Share card" onClose={onClose} wide>
        <ShareCardPreview
          data={card}
          exerciseLabel={card.exerciseLabel}
          onBack={() => setMode('menu')}
        />
      </Modal>
    );
  }

  return (
    <Modal title="Share & export" onClose={onClose}>
      <div className="flex flex-col gap-2">
        {card ? (
          <Option
            label="Share card (image)"
            description="A picture of your progress for the group chat."
            onSelect={() => setMode('card')}
          />
        ) : null}
        <Option
          label="Export CSV"
          description={
            canExportCsv
              ? "This workout's sessions, in the format the old app used."
              : 'Pick a workout first — there are no sessions to write.'
          }
          disabled={!canExportCsv}
          onSelect={run(onExportCsv)}
        />
        <Option
          label="Export backup (JSON)"
          description="Everything on this device. This is the one that restores."
          onSelect={run(onExportJson)}
        />
      </div>
    </Modal>
  );
}
