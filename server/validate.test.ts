// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { MAXIMAL_BACKUP, MINIMAL_BACKUP, clone } from './fixtures.js';
import { BackupValidationError, validateBackupStrict } from './validate.js';

/** Run the validator and return the issue paths+messages, or fail if it accepted the input. */
function reject(mutate: (backup: Record<string, any>) => void, from = MAXIMAL_BACKUP): string[] {
  const backup = clone(from) as unknown as Record<string, any>;
  mutate(backup);
  try {
    validateBackupStrict(backup);
  } catch (error) {
    if (error instanceof BackupValidationError) {
      return error.issues.map((i) => `${i.path}: ${i.message}`);
    }
    throw error;
  }
  throw new Error('expected the validator to reject this backup, but it accepted it');
}

describe('validateBackupStrict — acceptance', () => {
  it('accepts a dataset with every optional present', () => {
    expect(validateBackupStrict(clone(MAXIMAL_BACKUP))).toEqual(MAXIMAL_BACKUP);
  });

  it('accepts a dataset with every optional absent', () => {
    expect(validateBackupStrict(clone(MINIMAL_BACKUP))).toEqual(MINIMAL_BACKUP);
  });

  it('accepts the zone-less local timestamp the CSV import actually produces', () => {
    // src/import/pipeline.ts:177 writes `2026-05-29T08:34:00` — 19 characters, no offset.
    // A validator that demanded a trailing Z would have rejected all 29 real sessions.
    expect(() =>
      validateBackupStrict(
        clone(MAXIMAL_BACKUP) as unknown as Record<string, unknown>,
      ),
    ).not.toThrow();
    expect(MAXIMAL_BACKUP.workouts[1]?.performedAt).toBe('2026-05-29T08:34:00');
  });

  it('returns a new object rather than the input', () => {
    const input = clone(MAXIMAL_BACKUP);
    const output = validateBackupStrict(input);
    expect(output).not.toBe(input);
    expect(output.workouts[0]).not.toBe(input.workouts[0]);
  });

  it('normalises an explicit undefined to an absent key', () => {
    const input = clone(MINIMAL_BACKUP) as unknown as Record<string, any>;
    input['settings'].bodyweightKg = undefined;
    const output = validateBackupStrict(input);
    expect('bodyweightKg' in output.settings).toBe(false);
  });
});

describe('validateBackupStrict — envelope', () => {
  it('rejects a non-object', () => {
    expect(() => validateBackupStrict('nope')).toThrow(BackupValidationError);
    expect(() => validateBackupStrict(null)).toThrow(BackupValidationError);
  });

  it('rejects a foreign file', () => {
    expect(reject((b) => (b['format'] = 'something-else'))).toContain(
      '$.format: that file is not a GodMode backup',
    );
  });

  it('rejects a backup from a newer build rather than dropping what it does not know', () => {
    expect(reject((b) => (b['formatVersion'] = 2)).join('\n')).toMatch(
      /newer version of GodMode/,
    );
  });

  it('rejects an unknown top-level property', () => {
    expect(reject((b) => (b['drafts'] = []))).toContain(
      '$.drafts: unknown property: this build does not know what it means',
    );
  });

  it('rejects a missing collection instead of treating it as empty', () => {
    expect(reject((b) => delete b['workouts']).join('\n')).toMatch(
      /\$\.workouts: expected a list/,
    );
  });
});

describe('validateBackupStrict — field types', () => {
  it('rejects a wrong scalar type', () => {
    expect(reject((b) => (b['workouts'][0].actualTotal = '77'))).toContain(
      '$.workouts[0].actualTotal: expected a whole number, received a string',
    );
  });

  it('rejects a fractional value in a whole-number field rather than rounding it', () => {
    expect(reject((b) => (b['workouts'][0].attemptNo = 1.5))).toContain(
      '$.workouts[0].attemptNo: expected a whole number, received 1.5',
    );
  });

  it('rejects non-finite numbers wherever they appear', () => {
    expect(reject((b) => (b['workouts'][0].sets[0].actual = Number.NaN))).toContain(
      '$.workouts[0].sets[0].actual: expected a whole number, received NaN',
    );
    expect(reject((b) => (b['settings'].kcalCoefficient = Number.POSITIVE_INFINITY))).toContain(
      '$.settings.kcalCoefficient: expected a finite number, received Infinity',
    );
    expect(
      reject((b) => (b['planSlots'][1].patternMetrics.generationMax = Number.NaN)),
    ).toContain('$.planSlots[1].patternMetrics.generationMax: expected a finite number, received NaN');
  });

  it('rejects a value below the schema minimum', () => {
    expect(reject((b) => (b['workouts'][0].attemptNo = 0))).toContain(
      '$.workouts[0].attemptNo: expected at least 1, received 0',
    );
    expect(reject((b) => (b['settings'].bodyweightKg = 0))).toContain(
      '$.settings.bodyweightKg: expected more than 0, received 0',
    );
  });

  it('rejects an empty id', () => {
    expect(reject((b) => (b['exercises'][0].id = '')).join('\n')).toMatch(
      /\$\.exercises\[0\]\.id: expected at least 1 character/,
    );
  });

  it('rejects a missing required property', () => {
    expect(reject((b) => delete b['workouts'][0].outcome)).toContain(
      '$.workouts[0].outcome: required property is missing',
    );
    expect(reject((b) => delete b['challenges'][1].baseline.recordedAt)).toContain(
      '$.challenges[1].baseline.recordedAt: required property is missing',
    );
  });

  it('rejects a nested object that is not an object', () => {
    expect(reject((b) => (b['workouts'][0].kcal = 18.5))).toContain(
      '$.workouts[0].kcal: expected an object, received a number',
    );
  });

  it('rejects a nested array that is not an array', () => {
    expect(reject((b) => (b['planSlots'][1].targets = {}))).toContain(
      '$.planSlots[1].targets: expected an array, received an object',
    );
  });
});

describe('validateBackupStrict — enums', () => {
  it('rejects an unknown workout outcome', () => {
    expect(reject((b) => (b['workouts'][0].outcome = 'nailed_it')).join('\n')).toMatch(
      /\$\.workouts\[0\]\.outcome: expected one of .*received "nailed_it"/,
    );
  });

  it('rejects an unknown kcal provenance, which would erase the external/estimated split', () => {
    expect(reject((b) => (b['workouts'][0].kcal.source = 'guessed')).join('\n')).toMatch(
      /\$\.workouts\[0\]\.kcal\.source: expected one of "external", "estimated"/,
    );
  });

  it('rejects an unknown baseline provenance', () => {
    expect(reject((b) => (b['challenges'][1].baseline.source = 'vibes')).join('\n')).toMatch(
      /baseline\.source: expected one of/,
    );
  });

  it('rejects an unknown slot status and challenge end reason', () => {
    expect(reject((b) => (b['planSlots'][0].status = 'skipped')).join('\n')).toMatch(
      /planSlots\[0\]\.status: expected one of/,
    );
    expect(reject((b) => (b['challenges'][1].endReason = 'gave_up')).join('\n')).toMatch(
      /challenges\[1\]\.endReason: expected one of/,
    );
  });

  it('rejects a settings row that is not the settings row', () => {
    expect(reject((b) => (b['settings'].id = 'other')).join('\n')).toMatch(
      /\$\.settings\.id: expected one of "settings"/,
    );
  });
});

describe('validateBackupStrict — unknown properties', () => {
  it('rejects a property with no column, because importing would drop it', () => {
    expect(reject((b) => (b['workouts'][0].perceivedExertion = 8))).toContain(
      '$.workouts[0].perceivedExertion: unknown property: it has no column and would be lost on import',
    );
  });

  it('rejects an unknown property inside a nested object', () => {
    expect(reject((b) => (b['planSlots'][1].targets[0].tempo = '3-1-1'))).toContain(
      '$.planSlots[1].targets[0].tempo: unknown property: it has no column and would be lost on import',
    );
  });

  it('still allows arbitrary keys inside the opaque pattern blobs', () => {
    const backup = clone(MAXIMAL_BACKUP) as unknown as Record<string, any>;
    backup['challenges'][1].patternParams.somethingNewNextYear = { a: [1, 2] };
    expect(() => validateBackupStrict(backup)).not.toThrow();
  });

  it('rejects a Date hiding inside an opaque blob', () => {
    const backup = clone(MAXIMAL_BACKUP) as unknown as Record<string, any>;
    backup['challenges'][1].patternParams.when = new Date();
    expect(() => validateBackupStrict(backup)).toThrow(/has no JSON representation/);
  });
});

describe('validateBackupStrict — prototype-shaped keys', () => {
  it('preserves an own __proto__ key inside an opaque blob', () => {
    const backup = clone(MAXIMAL_BACKUP) as unknown as Record<string, any>;
    backup['challenges'][1].patternParams = JSON.parse('{"__proto__": {"x": 1}, "a": 2}');
    const out = validateBackupStrict(backup);
    const params = out.challenges[1]?.patternParams as Record<string, unknown>;
    expect(Object.keys(params).sort()).toEqual(['__proto__', 'a']);
    expect(Object.hasOwn(params, '__proto__')).toBe(true);
  });

  it('preserves an own __proto__ key inside a number map', () => {
    const backup = clone(MAXIMAL_BACKUP) as unknown as Record<string, any>;
    backup['planSlots'][1].patternMetrics = JSON.parse('{"__proto__": 1, "generationMax": 42}');
    const out = validateBackupStrict(backup);
    const metrics = out.planSlots[1]?.patternMetrics as Record<string, number>;
    expect(Object.keys(metrics).sort()).toEqual(['__proto__', 'generationMax']);
    expect(Object.getPrototypeOf(metrics)).toBe(Object.prototype);
  });

  it('still rejects a non-number under a __proto__ key in a number map', () => {
    const backup = clone(MAXIMAL_BACKUP) as unknown as Record<string, any>;
    backup['planSlots'][1].patternMetrics = JSON.parse('{"__proto__": "nope"}');
    expect(() => validateBackupStrict(backup)).toThrow(/expected a finite number/);
  });
});

describe('validateBackupStrict — timestamps', () => {
  it('accepts the spellings the app and the import both produce', () => {
    for (const stamp of [
      '2026-05-29T08:34:00',
      '2026-07-30T18:12:04.221Z',
      '2026-07-30T18:12:04+02:00',
      '2024-02-29T00:00:00',
    ]) {
      const backup = clone(MINIMAL_BACKUP) as unknown as Record<string, any>;
      backup['workouts'][0].performedAt = stamp;
      expect(() => validateBackupStrict(backup), stamp).not.toThrow();
    }
  });

  it('rejects a date that matches the shape but is not a date', () => {
    // A shape regex alone accepts all of these, and Date.parse is implementation-defined for
    // non-conforming input, so acceptance would otherwise depend on the runtime.
    for (const stamp of [
      '2026-02-30T08:34:00',
      '2026-13-01T08:34:00',
      '2026-00-10T08:34:00',
      '2025-02-29T08:34:00',
      '2026-05-29T25:00:00',
      '2026-05-29T08:61:00',
      '2026-05-29T08:34:99',
      '2026-05-29T08:34:00+99:00',
      '29.05.2026 08:34',
      '2026-05-29 08:34:00',
    ]) {
      const backup = clone(MINIMAL_BACKUP) as unknown as Record<string, any>;
      backup['workouts'][0].performedAt = stamp;
      expect(() => validateBackupStrict(backup), stamp).toThrow(/is not an ISO timestamp/);
    }
  });

  it('accepts a leap day in a leap year', () => {
    const backup = clone(MINIMAL_BACKUP) as unknown as Record<string, any>;
    backup['workouts'][0].performedAt = '2024-02-29T08:34:00';
    expect(() => validateBackupStrict(backup)).not.toThrow();
  });
});

describe('validateBackupStrict — identity and references', () => {
  it('rejects duplicate primary keys', () => {
    expect(reject((b) => (b['workouts'][1].id = 'wo_1'))).toContain(
      '$.workouts[1].id: duplicate id "wo_1" in workouts',
    );
  });

  it('rejects a dangling challenge on a workout', () => {
    expect(reject((b) => (b['workouts'][0].challengeId = 'ch_missing')).join('\n')).toMatch(
      /\$\.workouts\[0\]\.challengeId: points at "ch_missing", which is not in challenges/,
    );
  });

  it('rejects a dangling slot, exercise, previous challenge and baseline evidence', () => {
    expect(reject((b) => (b['workouts'][0].planSlotId = 'slot_missing')).join('\n')).toMatch(
      /planSlotId: points at "slot_missing", which is not in planSlots/,
    );
    expect(reject((b) => (b['challenges'][1].exerciseId = 'ex_missing')).join('\n')).toMatch(
      /exerciseId: points at "ex_missing", which is not in exercises/,
    );
    expect(reject((b) => (b['challenges'][1].previousChallengeId = 'ch_gone')).join('\n')).toMatch(
      /previousChallengeId: points at "ch_gone"/,
    );
    expect(reject((b) => (b['challenges'][1].baseline.evidenceId = 't_gone')).join('\n')).toMatch(
      /baseline\.evidenceId: points at "t_gone", which is not in performanceTests/,
    );
    expect(reject((b) => (b['planSlots'][1].supersedesId = 'slot_gone')).join('\n')).toMatch(
      /supersedesId: points at "slot_gone", which is not in planSlots/,
    );
  });

  it('rejects a record that references itself, as the DDL CHECK does', () => {
    expect(reject((b) => (b['challenges'][1].previousChallengeId = 'ch_1')).join('\n')).toMatch(
      /\$\.challenges\[1\]\.previousChallengeId: points at its own record/,
    );
    expect(reject((b) => (b['planSlots'][1].supersedesId = 'slot_1')).join('\n')).toMatch(
      /\$\.planSlots\[1\]\.supersedesId: points at its own record/,
    );
  });

  it('rejects two attempts sharing a slot and an attempt number', () => {
    expect(
      reject((b) => {
        b['workouts'][1].planSlotId = 'slot_1';
        b['workouts'][1].attemptNo = 1;
      }).join('\n'),
    ).toMatch(/slot "slot_1" already has an attempt 1/);
  });

  it('allows many unlinked imported workouts to share attempt number 1', () => {
    // src/import/reconcile.ts:100-107 numbers attempts per (week, day); a session that matched
    // no slot keeps attemptNo 1 and no slot link. There are many of those in the real export.
    const backup = clone(MINIMAL_BACKUP) as unknown as Record<string, any>;
    backup['workouts'] = [0, 1, 2].map((n) => ({
      ...backup['workouts'][0],
      id: `wo_${String(n)}`,
      attemptNo: 1,
    }));
    expect(() => validateBackupStrict(backup)).not.toThrow();
  });

  it('rejects a workout linked to a slot from another challenge', () => {
    const backup = clone(MAXIMAL_BACKUP) as unknown as Record<string, any>;
    backup['planSlots'][1].challengeId = 'ch_0';
    expect(() => validateBackupStrict(backup)).toThrow(/belongs to a different challenge/);
  });

  it('tolerates a selected challenge that is gone, which is documented as a preference', () => {
    const backup = clone(MAXIMAL_BACKUP) as unknown as Record<string, any>;
    backup['settings'].selectedChallengeId = 'ch_deleted_on_another_device';
    expect(() => validateBackupStrict(backup)).not.toThrow();
  });

  it('tolerates a chain head that was not restored', () => {
    const backup = clone(MAXIMAL_BACKUP) as unknown as Record<string, any>;
    backup['challenges'][0].chainId = 'ch_from_a_previous_year';
    expect(() => validateBackupStrict(backup)).not.toThrow();
  });
});

describe('validateBackupStrict — numbers a human can type', () => {
  it('accepts a fractional baseline, goal and max test rather than blocking the migration', () => {
    // Nothing in the codebase forces these to be whole: `recordMaxTest` stores its argument
    // verbatim (repo.ts:103-105) and `startNextBlock` checks only finiteness and positivity
    // (repo.ts:348-356). Refusing 18.5 at the gate would strand a device for no benefit.
    const backup = clone(MAXIMAL_BACKUP) as unknown as Record<string, any>;
    backup['challenges'][1].baseline.value = 18.5;
    backup['challenges'][1].goalValue = 100.5;
    backup['performanceTests'][0].value = 42.5;
    backup['planSlots'][1].restSeconds = 62.5;
    backup['settings'].restOverrideSeconds = 45.5;
    expect(() => validateBackupStrict(backup)).not.toThrow();
  });

  it('still rejects a fractional count that is structurally whole', () => {
    expect(reject((b) => (b['planSlots'][1].targets[0].reps = 21.5)).join('\n')).toMatch(
      /targets\[0\]\.reps: expected a whole number, received 21.5/,
    );
    expect(reject((b) => (b['workouts'][0].sets[0].actual = 21.5)).join('\n')).toMatch(
      /sets\[0\]\.actual: expected a whole number/,
    );
    expect(reject((b) => (b['planSlots'][1].ordinal = 1.5)).join('\n')).toMatch(
      /ordinal: expected a whole number/,
    );
  });
});

describe('validateBackupStrict — reporting', () => {
  it('reports every problem at once rather than one per run', () => {
    const issues = reject((b) => {
      b['workouts'][0].actualTotal = '77';
      b['workouts'][0].outcome = 'nailed_it';
      b['exercises'][0].unit = 'seconds';
      delete b['challenges'][1].startedAt;
    });
    expect(issues.length).toBeGreaterThanOrEqual(4);
  });

  it('puts the count and the first problems in the message', () => {
    try {
      validateBackupStrict({ format: 'godmode-backup' });
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).toMatch(/cannot be imported: \d+ problems? found/);
      expect((error as Error).message).toMatch(/Nothing has been written/);
    }
  });
});
