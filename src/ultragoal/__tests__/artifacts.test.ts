import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  addUltragoalGoal,
  buildCodexGoalInstruction,
  checkpointUltragoal,
  createUltragoalPlan,
  isFinalRunCompletionCandidate,
  isUltragoalDone,
  readUltragoalPlan,
  recordFinalReviewBlockers,
  steerUltragoal,
  startNextUltragoal,
  summarizeUltragoalPlan,
  ULTRAGOAL_AGGREGATE_CODEX_OBJECTIVE,
  validateUltragoalSteeringProposal,
  type UltragoalPlan,
  type UltragoalSteeringProposal,
} from '../artifacts.js';
import {
  LEADER_CONDUCTOR_BLOCK,
  buildRoleRoutingUnavailableGuidance,
  buildUnsupportedNativeSubagentGuidance,
} from '../../leader/contract.js';
import { steeringFixtures, type SteeringFixtureProposal } from './steering-fixtures.js';

async function withTempRepo<T>(run: (cwd: string) => Promise<T>): Promise<T> {
  const cwd = await mkdtemp(join(tmpdir(), 'omx-ultragoal-'));
  try {
    return await run(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

function cleanQualityGate(): object {
  return {
    aiSlopCleaner: { status: 'passed', evidence: 'ai-slop-cleaner ran on changed files' },
    verification: { status: 'passed', commands: ['npm test'], evidence: 'tests passed after cleaner' },
    codeReview: {
      recommendation: 'APPROVE',
      architectStatus: 'CLEAR',
      evidence: '$code-review approved with CLEAR architecture',
      independentReview: {
        codeReviewer: { agentRole: 'code-reviewer', evidence: 'code-reviewer subagent returned APPROVE' },
        architect: { agentRole: 'architect', evidence: 'architect subagent returned CLEAR' },
      },
    },
    architectureInvariantGate: {
      status: 'passed',
      sourceArtifacts: ['.omx/ultragoal/brief.md', '.omx/ultragoal/goals.json'],
      invariants: [],
      evidence: 'architect verified no additional architecture invariants were declared in the brief',
    },

  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function writeFixturePlan(cwd: string, plan: UltragoalPlan): Promise<void> {
  await mkdir(join(cwd, '.omx/ultragoal'), { recursive: true });
  await writeFile(join(cwd, '.omx/ultragoal/brief.md'), 'G001-core-steering-model fixture for .omx/ultragoal steering behavior.\n');
  await writeFile(join(cwd, '.omx/ultragoal/goals.json'), `${JSON.stringify(plan, null, 2)}\n`);
  await writeFile(join(cwd, '.omx/ultragoal/ledger.jsonl'), '');
}

function asChildGoals(after: unknown): Array<{ title: string; objective: string }> | undefined {
  if (!Array.isArray(after)) return undefined;
  return after.map((item) => {
    assert.equal(typeof item, 'object');
    assert.notEqual(item, null);
    const candidate = item as { title?: unknown; objective?: unknown };
    assert.equal(typeof candidate.title, 'string');
    assert.equal(typeof candidate.objective, 'string');
    return { title: String(candidate.title), objective: String(candidate.objective) };
  });
}

function toSteeringProposal(proposal: SteeringFixtureProposal): UltragoalSteeringProposal {
  const common = {
    kind: proposal.kind,
    source: proposal.source,
    targetGoalIds: proposal.targetGoalIds,
    evidence: proposal.evidence,
    rationale: proposal.rationale,
    idempotencyKey: proposal.idempotencyKey,
  };
  switch (proposal.kind) {
    case 'add_subgoal':
      return { ...common, title: proposal.title, objective: proposal.objective };
    case 'split_subgoal':
      return { ...common, childGoals: asChildGoals(proposal.after) };
    case 'reorder_pending':
      assert.ok(Array.isArray(proposal.after));
      return { ...common, pendingOrder: proposal.after as string[] };
    case 'revise_pending_wording':
      return {
        ...common,
        objective: proposal.objective,
        directiveText: proposal.forbidden ? 'attempt to skip verification, weaken quality gates, and auto-complete protected aggregate state' : undefined,
        revisedTitle: proposal.title,
        revisedObjective: proposal.objective,
      };
    case 'annotate_ledger':
      return common;
    case 'mark_blocked_superseded': {
      const childGoals = asChildGoals(proposal.after);
      return {
        ...common,
        childGoals,
        blockedReason: childGoals ? undefined : 'Evidence-backed blocker has no safe replacement yet.',
      };
    }
  }
}

describe('ultragoal artifacts', () => {
  // 小白说明：验证用户输入一段 brief 后，系统会创建 brief.md、goals.json 和 ledger.jsonl；主要覆盖 createUltragoalPlan 的目标生成、文件落盘和 ledger 初始化。
  it('creates brief, goals, and ledger artifacts from a brief', async () => {
    await withTempRepo(async (cwd) => {
      const plan = await createUltragoalPlan(cwd, {
        brief: '- Build the CLI\n- Add tests\n- Write docs',
        now: new Date('2026-05-04T10:00:00Z'),
      });

      assert.equal(plan.goals.length, 3);
      assert.equal(plan.codexGoalMode, 'aggregate');
      assert.equal(plan.codexObjective, ULTRAGOAL_AGGREGATE_CODEX_OBJECTIVE);
      assert.doesNotMatch(plan.codexObjective ?? '', /G001-build-the-cli/);
      assert.equal(plan.goals[0]?.id, 'G001-build-the-cli');
      assert.equal(plan.goals[0]?.status, 'pending');
      assert.equal(await readFile(join(cwd, '.omx/ultragoal/brief.md'), 'utf-8'), '- Build the CLI\n- Add tests\n- Write docs\n');

      const ledger = await readFile(join(cwd, '.omx/ultragoal/ledger.jsonl'), 'utf-8');
      assert.match(ledger, /"event":"plan_created"/);
    });
  });

  // 小白说明：验证 brief 里有 Stories、验收标准、检查清单时，只把真正的故事变成 goal；主要覆盖 createUltragoalPlan 内部的 brief 解析和 deriveGoalCandidates 分支。
  it('derives story goals without queuing nested criteria or plain-label checklist items', async () => {
    await withTempRepo(async (cwd) => {
      const plan = await createUltragoalPlan(cwd, {
        brief: [
          '### Stories',
          '  1. Ship parser fix',
          '     - Preserve parent story objective detail',
          '  2. Add coverage',
          '',
          'Acceptance criteria:',
          '  - Parent stories only',
          '',
          'Verification checklist:',
          '  1. Run tests',
          '  2. Run lint',
        ].join('\n'),
      });

      assert.deepEqual(plan.goals.map((goal) => goal.title), ['Ship parser fix', 'Add coverage']);
      assert.match(plan.goals[0]?.objective ?? '', /Preserve parent story objective detail/);
      assert.doesNotMatch(plan.goals[1]?.objective ?? '', /Run tests|Run lint|Parent stories only/);
    });
  });

  // 小白说明：验证只有检查清单/验收标准时，不会把每条检查项误当成任务；主要覆盖 createUltragoalPlan 的非故事内容兜底逻辑。
  it('does not fall back to checklist bullets when a brief has only non-story sections', async () => {
    await withTempRepo(async (cwd) => {
      const plan = await createUltragoalPlan(cwd, {
        brief: '### Verification checklist:\n- Run tests\n- Run lint\n\nAcceptance criteria:\n- Parent stories only',
      });

      assert.equal(plan.goals.length, 1);
      assert.equal(plan.goals[0]?.title, '### Verification checklist:');
      assert.doesNotMatch(plan.goals[0]?.id ?? '', /run-tests|run-lint|parent-stories/);
    });
  });

  // 小白说明：验证 RALPLAN 评审记录和共识记录不会被拆成一堆假 goal；主要覆盖 createUltragoalPlan 对 review/consensus 文档段落的过滤。
  it('does not atomize RALPLAN review and consensus sections into pseudo-goals', async () => {
    await withTempRepo(async (cwd) => {
      const brief = [
        '# Approved RALPLAN handoff',
        '',
        'Review artifact:',
        '- G104 verdict: APPROVE after evidence review',
        '- Review artifact: .gjc/plans/ralplan/run/review.md',
        '- Critic review: verification is concrete',
        '',
        'Consensus status:',
        '- Planner consensus: approved',
        '- Architect review: CLEAR',
        '- Implementation notes remain advisory until converted to compact goals',
        '',
        'Verification checklist:',
        '- Run targeted tests',
        '- Run build checks',
      ].join('\n');

      const plan = await createUltragoalPlan(cwd, { brief });

      assert.equal(plan.goals.length, 1);
      assert.equal(plan.goals[0]?.title, '# Approved RALPLAN handoff');
      assert.doesNotMatch(plan.goals[0]?.id ?? '', /g104|verdict|review-artifact|consensus-status/);
    });
  });

  // 小白说明：验证宽泛的大段 markdown 不会被系统猜测成 20 多个 goal，而是要求用户明确写 story；主要覆盖 createUltragoalPlan 的 fail-closed 防误拆保护。
  it('fails closed for broad implicit plan-like markdown without compact stories', async () => {
    await withTempRepo(async (cwd) => {
      const broadBrief = [
        '# RALPLAN approved handoff',
        'Consensus status: approved for execution.',
        ...Array.from({ length: 21 }, (_, index) => `- Review or handoff detail ${index + 1}`),
      ].join('\n');

      await assert.rejects(
        () => createUltragoalPlan(cwd, { brief: broadBrief }),
        /Refusing to derive 21 implicit ultragoal goals.*--goal "Title::Objective".*### Stories\/### Goals/s,
      );
    });
  });

  // 小白说明：验证缩进的说明文字不会打断后续同级故事识别；主要覆盖 createUltragoalPlan 的缩进段落解析。
  it('keeps later sibling stories after an indented plain-label note', async () => {
    await withTempRepo(async (cwd) => {
      const plan = await createUltragoalPlan(cwd, {
        brief: '1. Story A\n   Notes:\n   - Keep as detail\n2. Story B',
      });

      assert.deepEqual(plan.goals.map((goal) => goal.title), ['Story A', 'Story B']);
      assert.match(plan.goals[0]?.objective ?? '', /Keep as detail/);
    });
  });

  // 小白说明：验证文档前言里的 bullet 不会抢过 Stories 区域里的正式任务；主要覆盖 createUltragoalPlan 的故事区优先级规则。
  it('prefers story-section goals over preface bullets', async () => {
    await withTempRepo(async (cwd) => {
      const plan = await createUltragoalPlan(cwd, {
        brief: '- Context\n\n### Stories\n  1. Ship parser fix\n  2. Add coverage',
      });

      assert.deepEqual(plan.goals.map((goal) => goal.title), ['Ship parser fix', 'Add coverage']);
    });
  });

  // 小白说明：验证缩进的 story 标题也能被识别，并优先于前言 bullet；主要覆盖 createUltragoalPlan 的 markdown 标题识别。
  it('prefers indented markdown story headings over preface bullets', async () => {
    await withTempRepo(async (cwd) => {
      const plan = await createUltragoalPlan(cwd, {
        brief: '- Context\n\n  ### Stories\n    1. Ship parser fix\n    2. Add coverage',
      });

      assert.deepEqual(plan.goals.map((goal) => goal.title), ['Ship parser fix', 'Add coverage']);
    });
  });

  // 小白说明：验证缩进的 ATX 标题说明不会吞掉后面的同级 story；主要覆盖 createUltragoalPlan 的标题/缩进边界处理。
  it('keeps sibling stories after an indented ATX note heading', async () => {
    await withTempRepo(async (cwd) => {
      const plan = await createUltragoalPlan(cwd, {
        brief: '1. Story A\n   ### Notes\n   - Keep as detail\n2. Story B',
      });

      assert.deepEqual(plan.goals.map((goal) => goal.title), ['Story A', 'Story B']);
      assert.match(plan.goals[0]?.objective ?? '', /Keep as detail/);
    });
  });

  // 小白说明：验证空行加缩进标题的组合也不会破坏故事列表；主要覆盖 createUltragoalPlan 对空行和缩进标题的连续解析。
  it('keeps sibling stories after a blank before an indented ATX note heading', async () => {
    await withTempRepo(async (cwd) => {
      const plan = await createUltragoalPlan(cwd, {
        brief: '1. Story A\n\n   ### Notes\n   - Keep as detail\n2. Story B',
      });

      assert.deepEqual(plan.goals.map((goal) => goal.title), ['Story A', 'Story B']);
      assert.match(plan.goals[0]?.objective ?? '', /Keep as detail/);
    });
  });

  // 小白说明：验证中间出现非故事段落后，后续顶层 bullet 仍能恢复为 story；主要覆盖 createUltragoalPlan 的段落状态恢复。
  it('resumes unlabeled top-level story bullets after a non-story section break', async () => {
    await withTempRepo(async (cwd) => {
      const plan = await createUltragoalPlan(cwd, {
        brief: 'Acceptance criteria:\n- keep API stable\n\n- Ship parser fix\n- Add coverage',
      });

      assert.deepEqual(plan.goals.map((goal) => goal.title), ['Ship parser fix', 'Add coverage']);
    });
  });

  // 小白说明：验证重复写出的任务不会生成重复 goal；主要覆盖 createUltragoalPlan 的去重逻辑。
  it('deduplicates derived list goals', async () => {
    await withTempRepo(async (cwd) => {
      const plan = await createUltragoalPlan(cwd, {
        brief: '- Ship parser fix\n- Ship parser fix\n- Add coverage',
      });

      assert.deepEqual(plan.goals.map((goal) => goal.title), ['Ship parser fix', 'Add coverage']);
    });
  });

  // 小白说明：验证单数 Story 标题也被当成正式故事区；主要覆盖 createUltragoalPlan 对 Story/Stories 标题变体的识别。
  it('recognizes singular story headings when choosing goals over preface bullets', async () => {
    await withTempRepo(async (cwd) => {
      const plan = await createUltragoalPlan(cwd, {
        brief: '- Context\n\n### Story\n  1. Ship parser fix\n  2. Add coverage',
      });

      assert.deepEqual(plan.goals.map((goal) => goal.title), ['Ship parser fix', 'Add coverage']);
    });
  });

  // 小白说明：验证 ultragoal 默认一次只启动一个 story，并生成 aggregate Codex goal handoff；主要覆盖 startNextUltragoal 和 buildCodexGoalInstruction。
  it('starts one story at a time and emits an aggregate Codex goal handoff by default', async () => {
    await withTempRepo(async (cwd) => {
      await createUltragoalPlan(cwd, {
        brief: 'brief',
        goals: [
          { title: 'First', objective: 'Complete first milestone.' },
          { title: 'Second', objective: 'Complete second milestone.' },
        ],
      });

      const started = await startNextUltragoal(cwd, { now: new Date('2026-05-04T10:01:00Z') });
      assert.equal(started.goal?.id, 'G001-first');
      assert.equal(started.goal?.status, 'in_progress');
      assert.equal(started.plan.activeGoalId, 'G001-first');

      const resumed = await startNextUltragoal(cwd, { now: new Date('2026-05-04T10:02:00Z') });
      assert.equal(resumed.goal?.id, 'G001-first');
      assert.equal(resumed.resumed, true);

      const instruction = buildCodexGoalInstruction(started.goal!, started.plan);
      assert.match(instruction, /call get_goal/i);
      assert.match(instruction, /call create_goal/i);
      assert.match(instruction, /Codex goal = the whole ultragoal run/i);
      assert.match(instruction, /same aggregate objective as active/i);
      assert.match(instruction, /do not call update_goal yet/i);
      assert.match(instruction, /--codex-goal-json/);
      assert.match(instruction, /Complete the durable ultragoal plan/);
      assert.match(instruction, /including later accepted\/appended stories/);
      assert.match(instruction, /\.omx\/ultragoal\/ledger\.jsonl/);
      assert.match(instruction, new RegExp(escapeRegExp(LEADER_CONDUCTOR_BLOCK)));
      assert.match(instruction, /Complete first milestone/);
      assert.match(instruction, /does not call \/goal clear/);
      assert.match(instruction, /manually run \/goal clear/);
      assert.doesNotMatch(instruction, /fresh (?:Codex )?(?:thread|session)s?/i);
      assert.doesNotMatch(instruction, /\.\.\/\.\.\/codex/);
      assert.doesNotMatch(instruction, /`codex\s+goal\b/i);
    });
  });

  // 小白说明：验证最终 story 必须有独立 code-reviewer 和 architect 证据，native subagent 不可用时会降级为 blocker 指引；主要覆盖 buildCodexGoalInstruction 的最终门禁文案。
  it('emits final-story handoffs that block missing independent review before update_goal', async () => {
    await withTempRepo(async (cwd) => {
      await createUltragoalPlan(cwd, {
        brief: 'brief',
        goals: [{ title: 'Final', objective: 'Complete final milestone.' }],
      });
      const started = await startNextUltragoal(cwd);
      const aggregateInstruction = buildCodexGoalInstruction(started.goal!, started.plan);

      assert.match(aggregateInstruction, /independentReview evidence from both code-reviewer and architect subagents/);
      assert.match(aggregateInstruction, /independent delegation is unavailable\/skipped\/failed, do not call update_goal/);
      assert.match(aggregateInstruction, /APPROVE \+ CLEAR \+ independent code-reviewer and architect subagent evidence/);
      assert.match(aggregateInstruction, new RegExp(escapeRegExp(LEADER_CONDUCTOR_BLOCK)));

      await createUltragoalPlan(cwd, {
        brief: 'brief',
        codexGoalMode: 'per_story',
        goals: [{ title: 'Final', objective: 'Complete final milestone.' }],
        force: true,
      });
      const perStory = await startNextUltragoal(cwd);
      const perStoryInstruction = buildCodexGoalInstruction(perStory.goal!, perStory.plan);

      assert.match(perStoryInstruction, /independentReview evidence from both code-reviewer and architect subagents/);
      assert.match(perStoryInstruction, /independent delegation is unavailable\/skipped\/failed, do not call update_goal/);
      assert.match(perStoryInstruction, /APPROVE \+ CLEAR \+ independent code-reviewer and architect subagent evidence/);
      assert.match(perStoryInstruction, new RegExp(escapeRegExp(LEADER_CONDUCTOR_BLOCK)));

      const nativeSubagentSupport = {
        status: 'unsupported' as const,
        reason: 'native_subagents_unsupported' as const,
        source: 'persisted_support_blocker' as const,
        evidenceSummary: 'native subagents are disabled in this runtime',
      };
      const unsupportedInstruction = buildCodexGoalInstruction(perStory.goal!, perStory.plan, { nativeSubagentSupport });
      assert.doesNotMatch(unsupportedInstruction, /Conductor mode contract:/);
      assert.match(unsupportedInstruction, new RegExp(escapeRegExp(buildUnsupportedNativeSubagentGuidance(nativeSubagentSupport))));
      assert.match(unsupportedInstruction, /record-review-blockers/);
      assert.match(unsupportedInstruction, /non-clean blocker/);
      assert.match(unsupportedInstruction, /Native independent review unavailable/);

      const roleRoutingUnavailableSupport = {
        status: 'role_routing_unavailable' as const,
        source: 'persisted_role_routing_marker' as const,
        evidenceSummary: 'spawn_agent exists but the surface does not expose agent_type',
      };
      const roleRoutingUnavailableInstruction = buildCodexGoalInstruction(perStory.goal!, perStory.plan, {
        nativeSubagentSupport: roleRoutingUnavailableSupport,
      });
      assert.doesNotMatch(roleRoutingUnavailableInstruction, /Conductor mode contract:/);
      assert.match(
        roleRoutingUnavailableInstruction,
        new RegExp(escapeRegExp(buildRoleRoutingUnavailableGuidance(roleRoutingUnavailableSupport))),
      );
      assert.match(roleRoutingUnavailableInstruction, /adapted role-specific consensus/i);
      assert.match(roleRoutingUnavailableInstruction, /role-intent ledger/i);
    });
  });

  // 小白说明：验证一个 goal 完成后会推进到下一个，失败后可以 retry；主要覆盖 checkpointUltragoal 和 startNextUltragoal 的成功、失败、重试主流程。
  it('checkpoints success, advances, and supports failed-goal retry', async () => {
    await withTempRepo(async (cwd) => {
      await createUltragoalPlan(cwd, {
        brief: 'brief',
        goals: [
          { title: 'First', objective: 'Complete first milestone.' },
          { title: 'Second', objective: 'Complete second milestone.' },
        ],
      });

      const first = await startNextUltragoal(cwd);
      const aggregateObjective = first.plan.codexObjective!;
      await assert.rejects(
        () => checkpointUltragoal(cwd, {
          goalId: first.goal!.id,
          status: 'complete',
          evidence: 'premature aggregate completion',
          codexGoal: { goal: { objective: aggregateObjective, status: 'complete' } },
        }),
        /expected active/,
      );
      await checkpointUltragoal(cwd, {
        goalId: first.goal!.id,
        status: 'complete',
        evidence: 'unit tests passed',
        codexGoal: { goal: { objective: aggregateObjective, status: 'active' } },
      });
      const second = await startNextUltragoal(cwd);
      assert.equal(second.goal?.id, 'G002-second');

      await assert.rejects(
        () => checkpointUltragoal(cwd, {
          goalId: second.goal!.id,
          status: 'complete',
          evidence: 'not final yet',
          codexGoal: { goal: { objective: aggregateObjective, status: 'active' } },
        }),
        /not complete/,
      );

      await checkpointUltragoal(cwd, { goalId: second.goal!.id, status: 'failed', evidence: 'blocked' });
      const noPending = await startNextUltragoal(cwd);
      assert.equal(noPending.goal, null);
      assert.equal(noPending.done, false);

      const retry = await startNextUltragoal(cwd, { retryFailed: true });
      assert.equal(retry.goal?.id, 'G002-second');
      assert.equal(retry.goal?.status, 'in_progress');
      assert.equal(retry.goal?.attempt, 2);

      const plan = await readUltragoalPlan(cwd);
      assert.equal(plan.goals[0]?.evidence, 'unit tests passed');
      const ledger = await readFile(join(cwd, '.omx/ultragoal/ledger.jsonl'), 'utf-8');
      assert.match(ledger, /"event":"goal_completed"/);
      assert.match(ledger, /"event":"goal_failed"/);
      assert.match(ledger, /"event":"goal_retried"/);
    });
  });


  // 小白说明：验证 Codex 已完成的是整个任务时，OMX 能把当前 microgoal 和 aggregate 状态一起收口；主要覆盖 checkpointUltragoal 的 task-scoped aggregate reconciliation。
  it('reconciles completed task-scoped Codex proof to finish exploded aggregate ultragoal bookkeeping', async () => {
    await withTempRepo(async (cwd) => {
      const taskObjective = 'Fix the mismatch between Codex immutable completed goal snapshots and OMX ultragoal checkpoint reconciliation.';
      await createUltragoalPlan(cwd, {
        brief: taskObjective,
        goals: Array.from({ length: 136 }, (_, index) => ({
          title: `Micro goal ${index + 1}`,
          objective: `Synthetic bookkeeping slice ${index + 1}.`,
        })),
      });

      const first = await startNextUltragoal(cwd);
      assert.equal(first.goal?.id, 'G001-micro-goal-1');

      const reconciled = await checkpointUltragoal(cwd, {
        goalId: first.goal!.id,
        status: 'complete',
        evidence: 'Actual planned work done for .omx/ultragoal/goals.json G001-micro-goal-1; validation complete; reviews clean.',
        codexGoal: { goal: { objective: taskObjective, status: 'complete' } },
        qualityGate: cleanQualityGate(),
        now: new Date('2026-05-04T10:04:00Z'),
      });

      assert.equal(reconciled.goals.length, 136);
      assert.equal(reconciled.goals.filter((candidate) => candidate.status === 'complete').length, 1);
      assert.equal(reconciled.goals[0]?.status, 'complete');
      assert.equal(reconciled.goals[0]?.completedAt, '2026-05-04T10:04:00.000Z');
      assert.match(reconciled.goals[0]?.evidence ?? '', /planned work done/);
      assert.equal(reconciled.goals[0]?.failureReason, undefined);
      assert.equal(reconciled.activeGoalId, undefined);
      assert.equal(reconciled.aggregateCompletion?.status, 'complete');
      assert.match(reconciled.aggregateCompletion?.evidence ?? '', /planned work done/);
      assert.equal(isUltragoalDone(reconciled), true);

      const next = await startNextUltragoal(cwd);
      assert.equal(next.goal, null);
      assert.equal(next.done, true);

      const ledger = await readFile(join(cwd, '.omx/ultragoal/ledger.jsonl'), 'utf-8');
      assert.match(ledger, /checkpointed active microgoal row was reconciled to complete/);
      assert.equal((ledger.match(/"event":"aggregate_completed"/g) ?? []).length, 1);
      assert.equal((ledger.match(/"event":"goal_completed"/g) ?? []).length, 1);
    });
  });

  // 小白说明：验证没有足够证据把 Codex 完成状态映射到 ultragoal 时，系统拒绝完成；主要覆盖 checkpointUltragoal 的 objective mismatch 和质量门禁失败分支。
  it('fails closed for task-scoped aggregate completion without plan mapping or evidence', async () => {
    await withTempRepo(async (cwd) => {
      const taskObjective = 'Implement the reconciler fix described in the approved ultragoal brief.';
      await createUltragoalPlan(cwd, {
        brief: taskObjective,
        goals: [
          { title: 'First', objective: 'Synthetic slice 1.' },
          { title: 'Second', objective: 'Synthetic slice 2.' },
        ],
      });

      const first = await startNextUltragoal(cwd);
      await assert.rejects(
        () => checkpointUltragoal(cwd, {
          goalId: first.goal!.id,
          status: 'complete',
          evidence: 'Actual planned work done for .omx/ultragoal/goals.json G001-first; validation complete; reviews clean.',
          codexGoal: { goal: { objective: 'Unrelated completed task', status: 'complete' } },
          qualityGate: cleanQualityGate(),
        }),
        /objective mismatch/,
      );

      await assert.rejects(
        () => checkpointUltragoal(cwd, {
          goalId: first.goal!.id,
          status: 'complete',
          evidence: 'Actual planned work done for .omx/ultragoal/goals.json G001-first; validation complete; reviews clean.',
          codexGoal: { goal: { objective: 'Audit .omx/ultragoal/goals.json for a different unrelated task', status: 'complete' } },
          qualityGate: cleanQualityGate(),
        }),
        /objective mismatch/,
      );

      await assert.rejects(
        () => checkpointUltragoal(cwd, {
          goalId: first.goal!.id,
          status: 'complete',
          evidence: 'done',
          codexGoal: { goal: { objective: taskObjective, status: 'complete' } },
          qualityGate: cleanQualityGate(),
        }),
        /Completed task-scoped aggregate reconciliation requires .*active in-progress/,
      );

      await assert.rejects(
        () => checkpointUltragoal(cwd, {
          goalId: first.goal!.id,
          status: 'complete',
          evidence: 'Actual planned work done for .omx/ultragoal/goals.json G001-first; validation complete; reviews clean.',
          codexGoal: { goal: { objective: taskObjective, status: 'complete' } },
        }),
        /quality-gate-json|quality gate/i,
      );
    });
  });

  // 小白说明：验证不能拿非当前 active microgoal 去消费已完成的 aggregate Codex 证明；主要覆盖 checkpointUltragoal 的 active goal 校验。
  it('fails closed for task-scoped aggregate completion on a non-active microgoal id', async () => {
    await withTempRepo(async (cwd) => {
      const taskObjective = 'Fix the mismatch between Codex immutable completed goal snapshots and OMX ultragoal checkpoint reconciliation.';
      await createUltragoalPlan(cwd, {
        brief: taskObjective,
        goals: [
          { title: 'First', objective: 'Synthetic slice 1.' },
          { title: 'Second', objective: 'Synthetic slice 2.' },
        ],
      });

      const first = await startNextUltragoal(cwd);
      assert.equal(first.goal?.id, 'G001-first');
      assert.equal(first.plan.activeGoalId, 'G001-first');

      await assert.rejects(
        () => checkpointUltragoal(cwd, {
          goalId: 'G002-second',
          status: 'complete',
          evidence: 'Actual planned work done for .omx/ultragoal/goals.json G002-second; validation complete; reviews clean.',
          codexGoal: { goal: { objective: taskObjective, status: 'complete' } },
          qualityGate: cleanQualityGate(),
        }),
        /Completed task-scoped aggregate reconciliation requires .*active in-progress/,
      );

      const plan = await readUltragoalPlan(cwd);
      assert.equal(plan.activeGoalId, 'G001-first');
      assert.equal(plan.aggregateCompletion, undefined);
      assert.equal(plan.goals.find((goal) => goal.id === 'G001-first')?.status, 'in_progress');
      assert.equal(plan.goals.find((goal) => goal.id === 'G002-second')?.status, 'pending');

      const ledger = await readFile(join(cwd, '.omx/ultragoal/ledger.jsonl'), 'utf-8');
      assert.equal((ledger.match(/"event":"aggregate_completed"/g) ?? []).length, 0);
    });
  });

  // 小白说明：验证中间 story 完成时 Codex goal 仍可 active，最终 story 才要求 Codex goal complete；主要覆盖 checkpointUltragoal 的 final-run 判断。
  it('requires aggregate Codex goal completion only for the final story', async () => {
    await withTempRepo(async (cwd) => {
      await createUltragoalPlan(cwd, {
        brief: 'brief',
        goals: [
          { title: 'First', objective: 'Complete first milestone.' },
          { title: 'Second', objective: 'Complete second milestone.' },
        ],
      });

      const first = await startNextUltragoal(cwd);
      const aggregateObjective = first.plan.codexObjective!;
      await checkpointUltragoal(cwd, {
        goalId: first.goal!.id,
        status: 'complete',
        evidence: 'first audit passed',
        codexGoal: { goal: { objective: aggregateObjective, status: 'active' } },
      });

      const second = await startNextUltragoal(cwd);
      await checkpointUltragoal(cwd, {
        goalId: second.goal!.id,
        status: 'complete',
        evidence: 'final audit passed',
        codexGoal: { goal: { objective: aggregateObjective, status: 'complete' } },
        qualityGate: cleanQualityGate(),
      });

      const plan = await readUltragoalPlan(cwd);
      assert.equal(plan.goals.every((goal) => goal.status === 'complete'), true);
      assert.equal(plan.activeGoalId, undefined);
    });
  });

  // 小白说明：验证 blocked checkpoint 输入不完整或 Codex 状态不对时不会改坏当前 active goal；主要覆盖 checkpointUltragoal 的 blocked fail-closed 分支。
  it('fails closed for malformed blocked checkpoint contexts without changing the active goal', async () => {
    await withTempRepo(async (cwd) => {
      await createUltragoalPlan(cwd, {
        brief: 'brief',
        goals: [{ title: 'First', objective: 'Complete first milestone.' }],
      });

      await assert.rejects(
        () => checkpointUltragoal(cwd, {
          goalId: 'G001-first',
          status: 'blocked',
          evidence: 'blocked before start',
        }),
        /while it is pending; start or resume the ultragoal/,
      );

      const first = await startNextUltragoal(cwd);
      await assert.rejects(
        () => checkpointUltragoal(cwd, {
          goalId: first.goal!.id,
          status: 'blocked',
          evidence: 'blocked without get_goal JSON',
        }),
        /pass --codex-goal-json/,
      );
      await assert.rejects(
        () => checkpointUltragoal(cwd, {
          goalId: first.goal!.id,
          status: 'blocked',
          evidence: 'blocked by an active legacy goal',
          codexGoal: { goal: { objective: 'Different active legacy goal', status: 'active' } },
        }),
        /existing Codex goal is active/,
      );
      await assert.rejects(
        () => checkpointUltragoal(cwd, {
          goalId: first.goal!.id,
          status: 'blocked',
          evidence: 'blocked by a completed legacy goal without objective',
          codexGoal: { goal: { status: 'complete' } },
        }),
        /missing objective text/,
      );

      const plan = await readUltragoalPlan(cwd);
      assert.equal(plan.activeGoalId, first.goal!.id);
      assert.equal(plan.goals[0]?.status, 'in_progress');
      assert.equal(plan.goals[0]?.failureReason, undefined);
    });
  });

  // 小白说明：验证同一个外部授权问题重复失败 3 次后，会停在 needs_user_decision 等人决策；主要覆盖 checkpointUltragoal 的 external authorization blocker 计数和熔断。
  it('circuit-breaks repeated external authorization failures into a user-decision state', async () => {
    await withTempRepo(async (cwd) => {
      const ghcrBlocker = [
        'GHCR_USERNAME/GHCR_READ_TOKEN/GHCR_BEARER_TOKEN unset;',
        'gh auth scopes omit read:packages;',
        'package API returns HTTP 403 requiring read:packages;',
        'anonymous image verifier returns HTTP 401 authentication required.',
      ].join(' ');

      await createUltragoalPlan(cwd, {
        brief: 'brief',
        goals: [{ title: 'Prove GHCR smoke service', objective: 'Verify GHCR pull access.' }],
      });

      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const started = await startNextUltragoal(cwd, { retryFailed: attempt > 1 });
        assert.equal(started.goal?.id, 'G001-prove-ghcr-smoke-service');
        const plan = await checkpointUltragoal(cwd, {
          goalId: started.goal!.id,
          status: 'failed',
          evidence: ghcrBlocker,
        });
        const goal = plan.goals[0];
        assert.equal(goal?.blockerOccurrenceCount, attempt);
        assert.match(goal?.blockerSignature ?? '', /GHCR_PULL_ACCESS/);
        if (attempt < 3) {
          assert.equal(goal?.status, 'failed');
          assert.equal(goal?.nonRetriable, undefined);
        } else {
          assert.equal(goal?.status, 'needs_user_decision');
          assert.equal(goal?.nonRetriable, true);
          assert.match(goal?.requiredExternalDecision ?? '', /make the GHCR package public/);
          assert.match(goal?.blockedReason ?? '', /GHCR_USERNAME/);
        }
      }

      const retry = await startNextUltragoal(cwd, { retryFailed: true });
      assert.equal(retry.goal, null);
      assert.equal(retry.done, false);

      const ledger = await readFile(join(cwd, '.omx/ultragoal/ledger.jsonl'), 'utf-8');
      assert.match(ledger, /"event":"goal_needs_user_decision"/);
      assert.match(ledger, /GHCR_PULL_ACCESS/);
    });
  });

  // 小白说明：验证老版本 goals.json 没有 codexGoalMode 时仍按 per-story 兼容运行；主要覆盖 readUltragoalPlanForMutation 和 startNextUltragoal 的 legacy 兼容。
  it('treats existing v1 plans without mode metadata as legacy per-story plans', async () => {
    await withTempRepo(async (cwd) => {
      const created = await createUltragoalPlan(cwd, {
        brief: 'brief',
        codexGoalMode: 'per_story',
        goals: [
          { title: 'First', objective: 'Complete first milestone.' },
        ],
      });
      delete created.codexGoalMode;
      delete created.codexObjective;
      await writeFile(join(cwd, '.omx/ultragoal/goals.json'), `${JSON.stringify(created, null, 2)}\n`);

      const first = await startNextUltragoal(cwd);
      const instruction = buildCodexGoalInstruction(first.goal!, first.plan);
      assert.match(instruction, /Ultragoal active-goal handoff/);
      assert.match(instruction, /Codex goal context/);
      assert.doesNotMatch(instruction, /fresh (?:Codex )?(?:thread|session)s?/i);

      await checkpointUltragoal(cwd, {
        goalId: first.goal!.id,
        status: 'complete',
        evidence: 'legacy per-story audit passed',
        codexGoal: { goal: { objective: first.goal!.objective, status: 'complete' } },
        qualityGate: cleanQualityGate(),
      });

      const plan = await readUltragoalPlan(cwd);
      assert.equal(plan.goals[0]?.status, 'complete');
    });
  });

  // 小白说明：验证追加新 goal 不会把 aggregate Codex objective 改成某个单独 story；主要覆盖 addUltragoalGoal 和 aggregate objective 稳定性。
  it('appends goals without changing the stored aggregate objective', async () => {
    await withTempRepo(async (cwd) => {
      const plan = await createUltragoalPlan(cwd, {
        brief: 'brief',
        goals: [{ title: 'First', objective: 'Complete first milestone.' }],
      });
      const objective = plan.codexObjective;
      assert.equal(objective, ULTRAGOAL_AGGREGATE_CODEX_OBJECTIVE);
      const added = await addUltragoalGoal(cwd, {
        title: 'Resolve final code-review blockers',
        objective: 'Fix review blockers and rerun final gates.',
        evidence: 'review findings',
      });

      assert.equal(added.goal.id, 'G002-resolve-final-code-review-blockers');
      assert.equal(added.goal.status, 'pending');
      assert.equal(added.plan.codexObjective, objective);
      assert.doesNotMatch(added.plan.codexObjective ?? '', /G002-resolve-final-code-review-blockers/);

      const ledger = await readFile(join(cwd, '.omx/ultragoal/ledger.jsonl'), 'utf-8');
      assert.match(ledger, /"event":"goal_added"/);
    });
  });

  // 小白说明：验证 readUltragoalPlan 只是读文件，不会偷偷迁移或写 ledger；主要覆盖 readUltragoalPlan 的纯读契约。
  it('keeps readUltragoalPlan pure when legacy enumerated aggregate objectives need migration', async () => {
    await withTempRepo(async (cwd) => {
      await mkdir(join(cwd, '.omx/ultragoal'), { recursive: true });
      const legacyObjective = 'Complete all ultragoal stories in .omx/ultragoal/goals.json: G001-first First; G002-second Second';
      await writeFile(join(cwd, '.omx/ultragoal/goals.json'), `${JSON.stringify({
        version: 1,
        createdAt: '2026-05-04T10:00:00.000Z',
        updatedAt: '2026-05-04T10:00:00.000Z',
        briefPath: '.omx/ultragoal/brief.md',
        goalsPath: '.omx/ultragoal/goals.json',
        ledgerPath: '.omx/ultragoal/ledger.jsonl',
        codexGoalMode: 'aggregate',
        codexObjective: legacyObjective,
        goals: [
          { id: 'G001-first', title: 'First', objective: 'Complete first.', status: 'pending', attempt: 0, createdAt: '2026-05-04T10:00:00.000Z', updatedAt: '2026-05-04T10:00:00.000Z' },
          { id: 'G002-second', title: 'Second', objective: 'Complete second.', status: 'pending', attempt: 0, createdAt: '2026-05-04T10:00:00.000Z', updatedAt: '2026-05-04T10:00:00.000Z' },
        ],
      }, null, 2)}\n`);
      await writeFile(join(cwd, '.omx/ultragoal/ledger.jsonl'), '');
      const planPath = join(cwd, '.omx/ultragoal/goals.json');
      const ledgerPath = join(cwd, '.omx/ultragoal/ledger.jsonl');
      const beforePlanMtime = (await stat(planPath)).mtimeMs;
      const beforeLedgerMtime = (await stat(ledgerPath)).mtimeMs;

      const plan = await readUltragoalPlan(cwd);

      assert.equal(plan.codexObjective, legacyObjective);
      assert.equal((await stat(planPath)).mtimeMs, beforePlanMtime);
      assert.equal((await stat(ledgerPath)).mtimeMs, beforeLedgerMtime);
      const persisted = JSON.parse(await readFile(planPath, 'utf-8')) as UltragoalPlan;
      assert.equal(persisted.codexObjective, legacyObjective);
      const ledger = await readFile(ledgerPath, 'utf-8');
      assert.equal(ledger, '');
    });
  });

  // 小白说明：验证旧的、死进程留下的 mutation lock 不会永久卡住写入；主要覆盖 withUltragoalMutationLock 和 recoverStaleUltragoalMutationLock。
  it('recovers stale ultragoal mutation locks before mutating the plan', async () => {
    await withTempRepo(async (cwd) => {
      await createUltragoalPlan(cwd, {
        brief: 'brief',
        goals: [{ title: 'First', objective: 'Complete first milestone.' }],
      });
      await writeFile(
        join(cwd, '.omx/ultragoal/.mutation.lock'),
        JSON.stringify({ pid: 99999999, createdAt: '2000-01-01T00:00:00.000Z' }),
      );

      const result = await addUltragoalGoal(cwd, {
        title: 'After stale lock',
        objective: 'Mutation proceeds after stale lock recovery.',
        evidence: 'stale lock recovery verified',
      });

      assert.equal(result.goal.id, 'G002-after-stale-lock');
      const ledger = await readFile(join(cwd, '.omx/ultragoal/ledger.jsonl'), 'utf-8');
      assert.match(ledger, /"event":"goal_added"/);
    });
  });

  // 小白说明：验证刚出现的坏 lock 可能是别人正在创建锁，不能马上抢走；主要覆盖 recoverStaleUltragoalMutationLock 的新鲜 malformed lock 保护。
  it('does not recover fresh malformed ultragoal mutation locks', async () => {
    await withTempRepo(async (cwd) => {
      await createUltragoalPlan(cwd, {
        brief: 'brief',
        goals: [{ title: 'First', objective: 'Complete first milestone.' }],
      });
      await writeFile(join(cwd, '.omx/ultragoal/.mutation.lock'), '');
      const previousAttempts = process.env.OMX_ULTRAGOAL_MUTATION_LOCK_MAX_ATTEMPTS;
      process.env.OMX_ULTRAGOAL_MUTATION_LOCK_MAX_ATTEMPTS = '2';
      try {
        await assert.rejects(
          () => addUltragoalGoal(cwd, {
            title: 'Fresh malformed lock must not be stolen',
            objective: 'This mutation must not proceed while the fresh lock may be in-flight.',
            evidence: 'fresh malformed lock protection',
          }),
          /Timed out waiting for ultragoal mutation lock/,
        );
      } finally {
        if (typeof previousAttempts === 'string') process.env.OMX_ULTRAGOAL_MUTATION_LOCK_MAX_ATTEMPTS = previousAttempts;
        else delete process.env.OMX_ULTRAGOAL_MUTATION_LOCK_MAX_ATTEMPTS;
      }
      const plan = await readUltragoalPlan(cwd);
      assert.equal(plan.goals.length, 1);
    });
  });

  // 小白说明：验证 lock 看起来很老但持有进程还活着时不能抢锁；主要覆盖 recoverStaleUltragoalMutationLock 的 live PID 防抢占逻辑。
  it('does not recover stale ultragoal mutation locks while the owner pid is alive', async () => {
    await withTempRepo(async (cwd) => {
      await createUltragoalPlan(cwd, {
        brief: 'brief',
        goals: [{ title: 'First', objective: 'Complete first milestone.' }],
      });
      const lockPath = join(cwd, '.omx/ultragoal/.mutation.lock');
      await writeFile(lockPath, JSON.stringify({ pid: process.pid, createdAt: '2000-01-01T00:00:00.000Z' }));
      const oldTime = new Date('2000-01-01T00:00:00.000Z');
      await utimes(lockPath, oldTime, oldTime);
      const previousAttempts = process.env.OMX_ULTRAGOAL_MUTATION_LOCK_MAX_ATTEMPTS;
      process.env.OMX_ULTRAGOAL_MUTATION_LOCK_MAX_ATTEMPTS = '2';
      try {
        await assert.rejects(
          () => addUltragoalGoal(cwd, {
            title: 'Live stale lock must not be stolen',
            objective: 'This mutation must not proceed while the owner pid is alive.',
            evidence: 'live stale lock protection',
          }),
          /Timed out waiting for ultragoal mutation lock/,
        );
      } finally {
        if (typeof previousAttempts === 'string') process.env.OMX_ULTRAGOAL_MUTATION_LOCK_MAX_ATTEMPTS = previousAttempts;
        else delete process.env.OMX_ULTRAGOAL_MUTATION_LOCK_MAX_ATTEMPTS;
      }
      const plan = await readUltragoalPlan(cwd);
      assert.equal(plan.goals.length, 1);
    });
  });

  // 小白说明：验证老 aggregate objective 迁移后，旧 objective 仍作为 alias 被接受；主要覆盖 readUltragoalPlanForMutation、compatibleCodexObjectives 和 checkpointUltragoal。
  it('accepts migrated legacy aggregate objective aliases for active Codex snapshots', async () => {
    await withTempRepo(async (cwd) => {
      const legacyObjective = 'Complete all ultragoal stories in .omx/ultragoal/goals.json: G001-first First; G002-second Second';
      await createUltragoalPlan(cwd, {
        brief: 'brief',
        goals: [
          { title: 'First', objective: 'Complete first.' },
          { title: 'Second', objective: 'Complete second.' },
        ],
      });
      const planPath = join(cwd, '.omx/ultragoal/goals.json');
      const legacyPlan = JSON.parse(await readFile(planPath, 'utf-8')) as UltragoalPlan;
      legacyPlan.codexObjective = legacyObjective;
      await writeFile(planPath, `${JSON.stringify(legacyPlan, null, 2)}\n`);

      const first = await startNextUltragoal(cwd);
      const checkpointed = await checkpointUltragoal(cwd, {
        goalId: first.goal!.id,
        status: 'complete',
        evidence: 'legacy active Codex objective alias still represents the migrated aggregate run.',
        codexGoal: { goal: { objective: legacyObjective, status: 'active' } },
      });

      assert.equal(checkpointed.goals[0]?.status, 'complete');
      assert.equal(checkpointed.codexObjective, ULTRAGOAL_AGGREGATE_CODEX_OBJECTIVE);
      assert.deepEqual(checkpointed.codexObjectiveAliases, [legacyObjective]);
    });
  });

  // 小白说明：验证 steering 拆分 goal 时可重复执行同一个幂等 key 而不重复添加；主要覆盖 steerUltragoal 的 split_subgoal、superseded 和 idempotency 分支。
  it('applies steering idempotently and keeps split replacements schedulable', async () => {
    await withTempRepo(async (cwd) => {
      await createUltragoalPlan(cwd, {
        brief: 'brief',
        goals: [
          { title: 'Core steering model', objective: 'Implement bounded dynamic steering.' },
          { title: 'CLI bridge', objective: 'Expose structured steering through the CLI.' },
          { title: 'Hook bridge', objective: 'Bridge explicit steering directives.' },
        ],
      });

      const firstSteer = await steerUltragoal(cwd, {
        kind: 'split_subgoal',
        source: 'finding',
        targetGoalIds: ['G001-core-steering-model'],
        childGoals: [
          { title: 'Core steering schema', objective: 'Add steering proposal and audit schema.' },
          { title: 'Core steering scheduler semantics', objective: 'Make superseded and blocked metadata affect scheduling and completion.' },
        ],
        evidence: 'Implementation findings show schema and scheduler invariants should be isolated.',
        rationale: 'Splitting reduces coupling without deleting or weakening the original goal.',
        idempotencyKey: 'steering-idempotency-check',
      });

      assert.equal(firstSteer.accepted, true);
      assert.equal(firstSteer.deduped, false);
      assert.equal(firstSteer.plan.goals.find((goal) => goal.id === 'G001-core-steering-model')?.steeringStatus, 'superseded');
      assert.equal(firstSteer.plan.goals.find((goal) => goal.id === 'G004-core-steering-schema')?.supersedes?.[0], 'G001-core-steering-model');
      assert.equal(firstSteer.plan.goals.find((goal) => goal.id === 'G005-core-steering-scheduler-semantics')?.supersedes?.[0], 'G001-core-steering-model');
      assert.equal(firstSteer.plan.goals.filter((goal) => goal.steeringStatus === 'superseded').length, 1);
      assert.equal(isUltragoalDone(firstSteer.plan), false);

      const started = await startNextUltragoal(cwd);
      assert.equal(started.goal?.id, 'G004-core-steering-schema');
      assert.equal(started.goal?.status, 'in_progress');
      assert.equal(started.resumed, false);

      const secondSteer = await steerUltragoal(cwd, {
        kind: 'split_subgoal',
        source: 'finding',
        targetGoalIds: ['G001-core-steering-model'],
        childGoals: [
          { title: 'Core steering schema', objective: 'Add steering proposal and audit schema.' },
          { title: 'Core steering scheduler semantics', objective: 'Make superseded and blocked metadata affect scheduling and completion.' },
        ],
        evidence: 'Implementation findings show schema and scheduler invariants should be isolated.',
        rationale: 'Splitting reduces coupling without deleting or weakening the original goal.',
        idempotencyKey: 'steering-idempotency-check',
      });

      assert.equal(secondSteer.accepted, true);
      assert.equal(secondSteer.deduped, true);
      assert.equal(secondSteer.plan.goals.filter((goal) => goal.id === 'G004-core-steering-schema').length, 1);
      assert.equal(secondSteer.plan.goals.filter((goal) => goal.id === 'G005-core-steering-scheduler-semantics').length, 1);

      const ledger = await readFile(join(cwd, '.omx/ultragoal/ledger.jsonl'), 'utf-8');
      assert.equal((ledger.match(/"event":"steering_accepted"/g) ?? []).length, 1);
    });
  });

  // 小白说明：验证最终 review 不通过时，原 final goal 会变成 review_blocked，并追加一个 resolver goal；主要覆盖 recordFinalReviewBlockers 和 startNextUltragoal。
  it('records final aggregate review blockers atomically and starts the blocker next', async () => {
    await withTempRepo(async (cwd) => {
      await createUltragoalPlan(cwd, {
        brief: 'brief',
        goals: [{ title: 'Final', objective: 'Complete final milestone.' }],
      });
      const started = await startNextUltragoal(cwd);
      const objective = started.plan.codexObjective!;

      const result = await recordFinalReviewBlockers(cwd, {
        goalId: started.goal!.id,
        title: 'Resolve final code-review blockers',
        objective: 'Fix final code-review blockers and rerun final gates.',
        evidence: 'code-review REQUEST CHANGES',
        codexGoal: { goal: { objective, status: 'active' } },
      });

      assert.equal(result.blockedGoal.status, 'review_blocked');
      assert.equal(result.addedGoal.status, 'pending');
      assert.equal(result.addedGoal.resolvesReviewBlockedGoalId, result.blockedGoal.id);
      assert.deepEqual(result.blockedGoal.reviewBlockerResolution, {
        resolverGoalId: result.addedGoal.id,
        status: 'pending',
        evidence: 'code-review REQUEST CHANGES',
      });
      assert.equal(result.plan.activeGoalId, undefined);
      assert.equal(result.plan.codexObjective, objective);

      const next = await startNextUltragoal(cwd);
      assert.equal(next.goal?.id, result.addedGoal.id);

      const ledger = await readFile(join(cwd, '.omx/ultragoal/ledger.jsonl'), 'utf-8');
      assert.match(ledger, /"event":"final_review_failed"/);
      assert.match(ledger, /"event":"goal_review_blocked"/);
    });
  });

  // 小白说明：验证 recordFinalReviewBlockers 只能用于“当前已启动且最后一个未解决 story”；主要覆盖 recordFinalReviewBlockers 的未知 goal、pending、非 final 和 Codex mismatch 错误。
  it('rejects final review blocker recording outside the active final story path', async () => {
    await withTempRepo(async (cwd) => {
      await createUltragoalPlan(cwd, {
        brief: 'brief',
        goals: [
          { title: 'First', objective: 'Complete first milestone.' },
          { title: 'Second', objective: 'Complete second milestone.' },
        ],
      });

      await assert.rejects(
        () => recordFinalReviewBlockers(cwd, {
          goalId: 'G999-missing',
          title: 'Resolve missing blockers',
          objective: 'This must not append a blocker for an unknown goal.',
          evidence: 'code-review REQUEST CHANGES',
          codexGoal: { goal: { objective: ULTRAGOAL_AGGREGATE_CODEX_OBJECTIVE, status: 'active' } },
        }),
        /Unknown ultragoal id: G999-missing/,
      );

      await assert.rejects(
        () => recordFinalReviewBlockers(cwd, {
          goalId: 'G001-first',
          title: 'Resolve pending blockers',
          objective: 'This must not append a blocker before the goal is started.',
          evidence: 'code-review REQUEST CHANGES',
          codexGoal: { goal: { objective: ULTRAGOAL_AGGREGATE_CODEX_OBJECTIVE, status: 'active' } },
        }),
        /while it is pending; start or resume the ultragoal first/,
      );

      const first = await startNextUltragoal(cwd);
      await assert.rejects(
        () => recordFinalReviewBlockers(cwd, {
          goalId: first.goal!.id,
          title: 'Resolve non-final blockers',
          objective: 'This must not append a final-review blocker while later stories remain unresolved.',
          evidence: 'code-review REQUEST CHANGES',
          codexGoal: { goal: { objective: first.plan.codexObjective!, status: 'active' } },
        }),
        /not the only unresolved ultragoal story/,
      );

      await checkpointUltragoal(cwd, {
        goalId: first.goal!.id,
        status: 'complete',
        evidence: 'first milestone complete',
        codexGoal: { goal: { objective: first.plan.codexObjective!, status: 'active' } },
      });
      const second = await startNextUltragoal(cwd);
      await assert.rejects(
        () => recordFinalReviewBlockers(cwd, {
          goalId: second.goal!.id,
          title: 'Resolve mismatched Codex blocker',
          objective: 'This must not append a blocker without an active matching Codex goal.',
          evidence: 'code-review REQUEST CHANGES',
          codexGoal: { goal: { objective: 'unrelated completed task', status: 'complete' } },
        }),
        /expected active|get_goal status/i,
      );

      const plan = await readUltragoalPlan(cwd);
      assert.equal(plan.goals.length, 2);
      assert.equal(plan.goals.some((goal) => goal.status === 'review_blocked'), false);
    });
  });

  // 小白说明：验证 resolver goal 干净完成后，会把原 review_blocked final story 一起标成 complete；主要覆盖 checkpointUltragoal 的 designated resolver 完成路径。
  it('reconciles a review-blocked final story when the appended resolver completes with a clean quality gate', async () => {
    await withTempRepo(async (cwd) => {
      await createUltragoalPlan(cwd, {
        brief: 'brief',
        goals: [{ title: 'Final', objective: 'Complete final milestone.' }],
      });
      const started = await startNextUltragoal(cwd);
      const objective = started.plan.codexObjective!;

      const blocked = await recordFinalReviewBlockers(cwd, {
        goalId: started.goal!.id,
        title: 'Resolve final code-review blockers',
        objective: 'Fix final code-review blockers and rerun final gates.',
        evidence: 'code-reviewer REQUEST CHANGES before resolver',
        codexGoal: { goal: { objective, status: 'active' } },
      });
      assert.equal(blocked.blockedGoal.status, 'review_blocked');
      assert.equal(summarizeUltragoalPlan(blocked.plan).reviewBlocked, 1);

      const resolver = await startNextUltragoal(cwd);
      assert.equal(resolver.goal?.id, blocked.addedGoal.id);
      assert.equal(isFinalRunCompletionCandidate(resolver.plan, resolver.goal!), true);

      const completed = await checkpointUltragoal(cwd, {
        goalId: blocked.addedGoal.id,
        status: 'complete',
        evidence: `${blocked.addedGoal.id} fixed blockers; final gate passed for .omx/ultragoal/goals.json`,
        codexGoal: { goal: { objective, status: 'complete' } },
        qualityGate: cleanQualityGate(),
      });
      const parent = completed.goals.find((goal) => goal.id === blocked.blockedGoal.id);
      const summary = summarizeUltragoalPlan(completed);

      assert.equal(parent?.status, 'complete');
      assert.equal(parent?.reviewBlockerResolution?.status, 'complete');
      assert.equal(parent?.reviewBlockerResolution?.resolverGoalId, blocked.addedGoal.id);
      assert.equal(summary.complete, 2);
      assert.equal(summary.reviewBlocked, 0);
      assert.equal(summary.steeringBlocked, 0);
      assert.equal(summary.aggregateComplete, true);
      assert.equal(summary.artifactComplete, true);
      assert.equal(isUltragoalDone(completed), true);

      const ledger = await readFile(join(cwd, '.omx/ultragoal/ledger.jsonl'), 'utf-8');
      assert.match(ledger, /"event":"final_review_failed"/);
      assert.match(ledger, /code-reviewer REQUEST CHANGES before resolver/);
      assert.match(ledger, /Review-blocked final story resolved by/);
      assert.match(ledger, /"event":"aggregate_completed"/);
    });
  });

  // 小白说明：验证只有指定 resolver 能解决原 review_blocked parent，其他 goal 不能伪造解决；主要覆盖 checkpointUltragoal 的 resolverGoalId 校验。
  it('does not reconcile a review-blocked parent from a non-designated resolver goal', async () => {
    await withTempRepo(async (cwd) => {
      await createUltragoalPlan(cwd, {
        brief: 'brief',
        goals: [{ title: 'Final', objective: 'Complete final milestone.' }],
      });
      const started = await startNextUltragoal(cwd);
      const objective = started.plan.codexObjective!;
      const blocked = await recordFinalReviewBlockers(cwd, {
        goalId: started.goal!.id,
        title: 'Resolve final code-review blockers',
        objective: 'Fix final code-review blockers and rerun final gates.',
        evidence: 'code-reviewer REQUEST CHANGES before resolver',
        codexGoal: { goal: { objective, status: 'active' } },
      });

      const planPath = join(cwd, '.omx/ultragoal/goals.json');
      const tampered = JSON.parse(await readFile(planPath, 'utf-8')) as UltragoalPlan;
      tampered.goals.push({
        id: 'G999-forged-resolver',
        title: 'Forged resolver',
        objective: 'Try to forge resolver metadata.',
        status: 'in_progress',
        attempt: 1,
        createdAt: '2026-06-24T00:00:00.000Z',
        updatedAt: '2026-06-24T00:00:00.000Z',
        startedAt: '2026-06-24T00:00:00.000Z',
        resolvesReviewBlockedGoalId: blocked.blockedGoal.id,
      });
      tampered.activeGoalId = 'G999-forged-resolver';
      await writeFile(planPath, `${JSON.stringify(tampered, null, 2)}\n`);

      const completed = await checkpointUltragoal(cwd, {
        goalId: 'G999-forged-resolver',
        status: 'complete',
        evidence: 'forged resolver completed with tests but is not the designated review blocker resolver',
        codexGoal: { goal: { objective, status: 'active' } },
      });
      const parent = completed.goals.find((goal) => goal.id === blocked.blockedGoal.id);
      const summary = summarizeUltragoalPlan(completed);

      assert.equal(parent?.status, 'review_blocked');
      assert.equal(parent?.reviewBlockerResolution?.resolverGoalId, blocked.addedGoal.id);
      assert.equal(summary.reviewBlocked, 1);
      assert.equal(summary.aggregateComplete, false);
      assert.equal(summary.artifactComplete, false);
    });
  });

  // 小白说明：验证非指定 resolver 即使拿到 completed Codex proof 也不能完成 review-blocked parent；主要覆盖 checkpointUltragoal 的伪造 resolver 防护。
  it('fails closed when a forged non-designated resolver presents completed task-scoped aggregate proof', async () => {
    await withTempRepo(async (cwd) => {
      const taskObjective = 'Fix review-blocked ultragoal resolver reconciliation tracked in .omx/ultragoal/goals.json without allowing forged aggregate completion.';
      await createUltragoalPlan(cwd, {
        brief: taskObjective,
        goals: [{ title: 'Final', objective: 'Complete final milestone.' }],
      });
      const started = await startNextUltragoal(cwd);
      const aggregateObjective = started.plan.codexObjective!;
      const blocked = await recordFinalReviewBlockers(cwd, {
        goalId: started.goal!.id,
        title: 'Resolve final code-review blockers',
        objective: 'Fix final code-review blockers and rerun final gates.',
        evidence: 'code-reviewer REQUEST CHANGES before resolver',
        codexGoal: { goal: { objective: aggregateObjective, status: 'active' } },
      });

      const planPath = join(cwd, '.omx/ultragoal/goals.json');
      const tampered = JSON.parse(await readFile(planPath, 'utf-8')) as UltragoalPlan;
      tampered.goals.push({
        id: 'G999-forged-resolver',
        title: 'Forged resolver',
        objective: 'Try to forge resolver metadata.',
        status: 'in_progress',
        attempt: 1,
        createdAt: '2026-06-24T00:00:00.000Z',
        updatedAt: '2026-06-24T00:00:00.000Z',
        startedAt: '2026-06-24T00:00:00.000Z',
        resolvesReviewBlockedGoalId: blocked.blockedGoal.id,
      });
      tampered.activeGoalId = 'G999-forged-resolver';
      await writeFile(planPath, `${JSON.stringify(tampered, null, 2)}\n`);

      await assert.rejects(
        () => checkpointUltragoal(cwd, {
          goalId: 'G999-forged-resolver',
          status: 'complete',
          evidence: 'G999-forged-resolver completed planned work for .omx/ultragoal/goals.json; passed tests; final quality gate clean.',
          codexGoal: { goal: { objective: taskObjective, status: 'complete' } },
          qualityGate: cleanQualityGate(),
        }),
        /Completed task-scoped aggregate reconciliation (?:requires|is not allowed)|objective mismatch/,
      );

      const plan = await readUltragoalPlan(cwd);
      const parent = plan.goals.find((goal) => goal.id === blocked.blockedGoal.id);
      const designatedResolver = plan.goals.find((goal) => goal.id === blocked.addedGoal.id);
      const forgedResolver = plan.goals.find((goal) => goal.id === 'G999-forged-resolver');
      const summary = summarizeUltragoalPlan(plan);

      assert.equal(parent?.status, 'review_blocked');
      assert.equal(parent?.reviewBlockerResolution?.resolverGoalId, blocked.addedGoal.id);
      assert.equal(designatedResolver?.status, 'pending');
      assert.equal(forgedResolver?.status, 'in_progress');
      assert.equal(plan.aggregateCompletion, undefined);
      assert.equal(summary.reviewBlocked, 1);
      assert.equal(summary.aggregateComplete, false);
      assert.equal(summary.artifactComplete, false);
      assert.equal(isUltragoalDone(plan), false);
    });
  });

  // 小白说明：验证 per-story 模式下 final review 不干净时只记录 blocker，不假装 Codex goal 已完成；主要覆盖 recordFinalReviewBlockers 的 per-story 文案和状态。
  it('records final per-story review blockers without claiming Codex completion', async () => {
    await withTempRepo(async (cwd) => {
      await createUltragoalPlan(cwd, {
        brief: 'brief',
        codexGoalMode: 'per_story',
        goals: [{ title: 'Final', objective: 'Complete final milestone.' }],
      });
      const started = await startNextUltragoal(cwd);
      const result = await recordFinalReviewBlockers(cwd, {
        goalId: started.goal!.id,
        title: 'Resolve final code-review blockers',
        objective: 'Fix final code-review blockers in a fresh goal context.',
        evidence: 'architect BLOCK',
        codexGoal: { goal: { objective: started.goal!.objective, status: 'active' } },
      });

      assert.equal(result.blockedGoal.status, 'review_blocked');
      assert.equal(result.addedGoal.status, 'pending');
      assert.equal(isUltragoalDone(result.plan), false);
    });
  });

  // 小白说明：验证最终 clean completion 必须带 ai-slop-cleaner、verification、code-review、架构门禁证据；主要覆盖 checkpointUltragoal 和 validateQualityGate。
  it('requires structured final quality gate evidence for clean completion', async () => {
    await withTempRepo(async (cwd) => {
      await createUltragoalPlan(cwd, {
        brief: 'brief',
        goals: [{ title: 'Final', objective: 'Complete final milestone.' }],
      });
      const started = await startNextUltragoal(cwd);
      const objective = started.plan.codexObjective!;

      await assert.rejects(
        () => checkpointUltragoal(cwd, {
          goalId: started.goal!.id,
          status: 'complete',
          evidence: 'tests passed',
          codexGoal: { goal: { objective, status: 'complete' } },
        }),
        /quality-gate-json|quality gate/i,
      );

      await assert.rejects(
        () => checkpointUltragoal(cwd, {
          goalId: started.goal!.id,
          status: 'complete',
          evidence: 'tests passed',
          codexGoal: { goal: { objective, status: 'complete' } },
          qualityGate: {
            ...cleanQualityGate(),
            codeReview: { recommendation: 'COMMENT', architectStatus: 'CLEAR', evidence: 'not clean' },
          },
        }),
        /APPROVE/,
      );

      await assert.rejects(
        () => checkpointUltragoal(cwd, {
          goalId: started.goal!.id,
          status: 'complete',
          evidence: 'tests passed',
          codexGoal: { goal: { objective, status: 'complete' } },
          qualityGate: {
            ...cleanQualityGate(),
            aiSlopCleaner: { status: 'not_applicable', evidence: 'skipped cleaner' },
          },
        }),
        /aiSlopCleaner\.status="passed"/,
      );

      await assert.rejects(
        () => checkpointUltragoal(cwd, {
          goalId: started.goal!.id,
          status: 'complete',
          evidence: 'tests passed',
          codexGoal: { goal: { objective, status: 'complete' } },
          qualityGate: {
            ...cleanQualityGate(),
            codeReview: {
              recommendation: 'APPROVE',
              architectStatus: 'CLEAR',
              evidence: 'same execution lane self-reviewed and approved without spawning review subagents',
            },
          },
        }),
        /independent review unavailable|self-approving/i,
      );

      await assert.rejects(
        () => checkpointUltragoal(cwd, {
          goalId: started.goal!.id,
          status: 'complete',
          evidence: 'tests passed',
          codexGoal: { goal: { objective, status: 'complete' } },
          qualityGate: {
            ...cleanQualityGate(),
            codeReview: {
              recommendation: 'APPROVE',
              architectStatus: 'CLEAR',
              evidence: 'native independent review unavailable',
            },
            nativeSubagentSupport: {
              status: 'unsupported',
              reason: 'native_subagents_unsupported',
              source: 'persisted_support_blocker',
              evidenceSummary: 'native subagents are disabled in this runtime',
            },
          },
        }),
        /independent review unavailable|self-approving/i,
      );

      await assert.rejects(
        () => checkpointUltragoal(cwd, {
          goalId: started.goal!.id,
          status: 'complete',
          evidence: 'tests passed',
          codexGoal: { goal: { objective, status: 'complete' } },
          qualityGate: {
            ...cleanQualityGate(),
            codeReview: {
              recommendation: 'APPROVE',
              architectStatus: 'CLEAR',
              evidence: 'authoring lane claimed it was merge-ready',
              independentReview: {
                codeReviewer: { agentRole: 'executor', evidence: 'authoring lane approved its own change' },
                architect: { agentRole: 'architect', evidence: 'architect subagent returned CLEAR' },
              },
            },
          },
        }),
        /independent code-reviewer subagent|self-review/i,
      );

      await assert.rejects(
        () => checkpointUltragoal(cwd, {
          goalId: started.goal!.id,
          status: 'complete',
          evidence: 'tests passed',
          codexGoal: { goal: { objective, status: 'complete' } },
          qualityGate: {
            ...cleanQualityGate(),
            codeReview: {
              recommendation: 'APPROVE',
              architectStatus: 'CLEAR',
              evidence: 'code-review path skipped architect delegation',
              independentReview: {
                codeReviewer: { agentRole: 'code-reviewer', evidence: 'code-reviewer subagent returned APPROVE' },
              },
            },
          },
        }),
        /missing codeReview\.independentReview\.architect/i,
      );

      await checkpointUltragoal(cwd, {
        goalId: started.goal!.id,
        status: 'complete',
        evidence: 'final gates passed',
        codexGoal: { goal: { objective, status: 'complete' } },
        qualityGate: cleanQualityGate(),
      });
      const plan = await readUltragoalPlan(cwd);
      assert.equal(isUltragoalDone(plan), true);
      const ledger = await readFile(join(cwd, '.omx/ultragoal/ledger.jsonl'), 'utf-8');
      assert.match(ledger, /"qualityGate"/);
      assert.match(ledger, /"aiSlopCleaner"/);
      assert.match(ledger, /"codeReview"/);
    });
  });

  // 小白说明：验证 brief 里声明的架构不变量必须在最终质量门禁中逐条证明；主要覆盖 collectRequiredArchitectureInvariants 和 validateArchitectureInvariantGate。
  it('requires final architecture invariant proof from the brief before clean completion', async () => {
    await withTempRepo(async (cwd) => {
      await createUltragoalPlan(cwd, {
        brief: [
          'Ship the integration safely.',
          '',
          '## Architecture Invariants',
          '- Preserve the existing parser boundary.',
          '- Do not introduce a second scheduler.',
        ].join('\n'),
        goals: [{ title: 'Final', objective: 'Complete final milestone.' }],
      });
      const started = await startNextUltragoal(cwd);
      const objective = started.plan.codexObjective!;

      await assert.rejects(
        () => checkpointUltragoal(cwd, {
          goalId: started.goal!.id,
          status: 'complete',
          evidence: 'tests passed',
          codexGoal: { goal: { objective, status: 'complete' } },
          qualityGate: cleanQualityGate(),
        }),
        /missing proof for required invariant from \.omx\/ultragoal\/brief\.md: Preserve the existing parser boundary/i,
      );

      await checkpointUltragoal(cwd, {
        goalId: started.goal!.id,
        status: 'complete',
        evidence: 'final gates passed',
        codexGoal: { goal: { objective, status: 'complete' } },
        qualityGate: {
          ...cleanQualityGate(),
          architectureInvariantGate: {
            status: 'passed',
            sourceArtifacts: ['.omx/ultragoal/brief.md', '.omx/ultragoal/goals.json'],
            evidence: 'all declared invariants have implementation, test, and review proof',
            invariants: [
              {
                invariant: 'Preserve the existing parser boundary.',
                source: '.omx/ultragoal/brief.md#architecture-invariants',
                status: 'proved',
                implementationEvidence: 'parser changes stayed inside src/parser without scheduler coupling',
                testEvidence: 'parser boundary regression test passed',
                reviewEvidence: 'architect review confirmed parser boundary remained intact',
              },
              {
                invariant: 'Do not introduce a second scheduler.',
                source: '.omx/ultragoal/brief.md#architecture-invariants',
                status: 'proved',
                implementationEvidence: 'implementation reused the existing scheduler entrypoint',
                testEvidence: 'scheduler singleton regression passed',
                reviewEvidence: 'architect review confirmed no duplicate scheduler path',
              },
            ],
          },
        },
      });

      const plan = await readUltragoalPlan(cwd);
      assert.equal(isUltragoalDone(plan), true);
    });
  });

  // 小白说明：验证已接受的 steering 里新增的架构不变量也必须最终证明；主要覆盖 steerUltragoal ledger 记录和 validateArchitectureInvariantGate。
  it('requires final architecture invariant proof from accepted steering annotations', async () => {
    await withTempRepo(async (cwd) => {
      await createUltragoalPlan(cwd, {
        brief: 'Ship the integration safely without a brief invariant section.',
        goals: [
          { title: 'Audit steering invariant', objective: 'Accept steering invariant annotation.' },
          { title: 'Final', objective: 'Complete final milestone.' },
        ],
      });
      const first = await startNextUltragoal(cwd);
      await steerUltragoal(cwd, {
        kind: 'annotate_ledger',
        source: 'finding',
        evidence: 'Reviewer finding. Architecture invariant: Ledger entries remain append-only',
        rationale: 'Non-negotiable architecture invariant: Ledger entries remain append-only',
      });
      await checkpointUltragoal(cwd, {
        goalId: first.goal!.id,
        status: 'complete',
        evidence: 'steering invariant accepted for final gate coverage',
        codexGoal: { goal: { objective: first.plan.codexObjective!, status: 'active' } },
        allowActiveFinalCodexGoal: true,
      });
      const final = await startNextUltragoal(cwd);
      const objective = final.plan.codexObjective!;

      await assert.rejects(
        () => checkpointUltragoal(cwd, {
          goalId: final.goal!.id,
          status: 'complete',
          evidence: 'tests passed',
          codexGoal: { goal: { objective, status: 'complete' } },
          qualityGate: {
            ...cleanQualityGate(),
            architectureInvariantGate: {
              status: 'passed',
              sourceArtifacts: ['.omx/ultragoal/ledger.jsonl'],
              invariants: [],
              evidence: 'architect verified no additional architecture invariants were declared in the brief',
            },
          },
        }),
        /missing proof for required invariant from \.omx\/ultragoal\/ledger\.jsonl: Ledger entries remain append-only/i,
      );

      await checkpointUltragoal(cwd, {
        goalId: final.goal!.id,
        status: 'complete',
        evidence: 'final gates passed',
        codexGoal: { goal: { objective, status: 'complete' } },
        qualityGate: {
          ...cleanQualityGate(),
          architectureInvariantGate: {
            status: 'passed',
            sourceArtifacts: ['.omx/ultragoal/ledger.jsonl'],
            evidence: 'accepted steering invariant has implementation, test, and review proof',
            invariants: [
              {
                invariant: 'Ledger entries remain append-only',
                source: '.omx/ultragoal/ledger.jsonl#steering-3-inline-architecture-invariant',
                status: 'proved',
                implementationEvidence: 'appendLedger only appends JSONL records',
                testEvidence: 'ledger append-only regression passed',
                reviewEvidence: 'architect review confirmed ledger mutation remains append-only',
              },
            ],
          },
        },
      });

      const plan = await readUltragoalPlan(cwd);
      assert.equal(isUltragoalDone(plan), true);
    });
  });

  // 小白说明：验证“看起来像来源”的装饰性文字不算真实架构证据来源；主要覆盖 validateArchitectureInvariantGate 的 sourceArtifacts/source 引用校验。
  it('rejects decorative architecture invariant provenance labels that omit source artifacts', async () => {
    await withTempRepo(async (cwd) => {
      await createUltragoalPlan(cwd, {
        brief: [
          'Ship the integration safely.',
          '',
          '## Architecture Invariants',
          '- Preserve the existing parser boundary.',
        ].join('\n'),
        goals: [{ title: 'Final', objective: 'Complete final milestone.' }],
      });
      const started = await startNextUltragoal(cwd);
      const objective = started.plan.codexObjective!;

      await assert.rejects(
        () => checkpointUltragoal(cwd, {
          goalId: started.goal!.id,
          status: 'complete',
          evidence: 'tests passed',
          codexGoal: { goal: { objective, status: 'complete' } },
          qualityGate: {
            ...cleanQualityGate(),
            architectureInvariantGate: {
              status: 'passed',
              sourceArtifacts: ['review-note: claims brief coverage'],
              evidence: 'decorative label claims the invariant came from the brief',
              invariants: [
                {
                  invariant: 'Preserve the existing parser boundary.',
                  source: 'review-note: brief architecture invariant',
                  status: 'proved',
                  implementationEvidence: 'parser boundary preserved',
                  testEvidence: 'parser boundary test passed',
                  reviewEvidence: 'architect review confirmed parser boundary',
                },
              ],
            },
          },
        }),
        /sourceArtifacts must include required invariant source artifact: \.omx\/ultragoal\/brief\.md/i,
      );

      await assert.rejects(
        () => checkpointUltragoal(cwd, {
          goalId: started.goal!.id,
          status: 'complete',
          evidence: 'tests passed',
          codexGoal: { goal: { objective, status: 'complete' } },
          qualityGate: {
            ...cleanQualityGate(),
            architectureInvariantGate: {
              status: 'passed',
              sourceArtifacts: ['.omx/ultragoal/brief.md'],
              evidence: 'source artifact is listed but record source is decorative',
              invariants: [
                {
                  invariant: 'Preserve the existing parser boundary.',
                  source: 'review-note: brief architecture invariant',
                  status: 'proved',
                  implementationEvidence: 'parser boundary preserved',
                  testEvidence: 'parser boundary test passed',
                  reviewEvidence: 'architect review confirmed parser boundary',
                },
              ],
            },
          },
        }),
        /source must reference one of architectureInvariantGate\.sourceArtifacts|decorative provenance labels/i,
      );
    });
  });

  // 小白说明：验证架构不变量如果没有证明或还有 blocker，最终 goal 不能完成，只能记录 blocker；主要覆盖 checkpointUltragoal 和 recordFinalReviewBlockers。
  it('blocks final completion when architecture invariants are unproved or carry blockers', async () => {
    await withTempRepo(async (cwd) => {
      await createUltragoalPlan(cwd, {
        brief: '## Domain Invariants\n- Ledger entries remain append-only.',
        goals: [{ title: 'Final', objective: 'Complete final milestone.' }],
      });
      const started = await startNextUltragoal(cwd);
      const objective = started.plan.codexObjective!;

      await assert.rejects(
        () => checkpointUltragoal(cwd, {
          goalId: started.goal!.id,
          status: 'complete',
          evidence: 'tests passed',
          codexGoal: { goal: { objective, status: 'complete' } },
          qualityGate: {
            ...cleanQualityGate(),
            architectureInvariantGate: {
              status: 'passed',
              sourceArtifacts: ['.omx/ultragoal/brief.md'],
              evidence: 'invariant audit found unresolved blocker',
              invariants: [
                {
                  invariant: 'Ledger entries remain append-only.',
                  source: '.omx/ultragoal/brief.md#domain-invariants',
                  status: 'blocked',
                  implementationEvidence: 'mutation path still rewrites prior entries',
                  testEvidence: 'append-only regression not written',
                  reviewEvidence: 'architect BLOCK',
                  blockers: ['existing migration rewrites ledger history'],
                },
              ],
            },
          },
        }),
        /not proved|blocker-resolution work/i,
      );

      const result = await recordFinalReviewBlockers(cwd, {
        goalId: started.goal!.id,
        title: 'Resolve final architecture invariant blockers',
        objective: 'Prove ledger append-only behavior and rerun final quality gates.',
        evidence: 'architectureInvariantGate found unproved invariant: Ledger entries remain append-only.',
        codexGoal: { goal: { objective, status: 'active' } },
      });
      assert.equal(result.blockedGoal.status, 'review_blocked');
      assert.match(result.addedGoal.objective, /ledger append-only/i);
    });
  });

  // 小白说明：验证遇到旧的 completed Codex goal 阻塞 create_goal 时，只记录非终止 blocker，不把当前 ultragoal 标失败；主要覆盖 checkpointUltragoal 的 blocked 安全恢复路径。
  it('records a completed legacy Codex-goal blocker without failing the active ultragoal', async () => {
    await withTempRepo(async (cwd) => {
      await createUltragoalPlan(cwd, {
        brief: 'brief',
        codexGoalMode: 'per_story',
        goals: [
          { title: 'First', objective: 'Complete first milestone.' },
        ],
      });

      const first = await startNextUltragoal(cwd);
      const blocked = await checkpointUltragoal(cwd, {
        goalId: first.goal!.id,
        status: 'blocked',
        evidence: 'completed aggregate Codex goal blocks create_goal',
        codexGoal: { goal: { objective: 'achieve all goals on this repo ultragoal status', status: 'complete' } },
        now: new Date('2026-05-04T10:03:00Z'),
      });

      assert.equal(blocked.activeGoalId, first.goal!.id);
      assert.equal(blocked.goals[0]?.status, 'in_progress');
      assert.equal(blocked.goals[0]?.failureReason, undefined);
      assert.equal(blocked.goals[0]?.failedAt, undefined);

      const ledger = await readFile(join(cwd, '.omx/ultragoal/ledger.jsonl'), 'utf-8');
      assert.match(ledger, /"event":"goal_blocked"/);
      assert.match(ledger, /completed aggregate Codex goal blocks create_goal/);
    });
  });

  // 小白说明：验证受支持的 steering 类型会改 plan 并写结构化审计日志；主要覆盖 steerUltragoal 的 add、revise、reorder、annotate、split、blocked 分支。
  it('accepts core steering mutations and writes structured audit entries', async () => {
    await withTempRepo(async (cwd) => {
      await createUltragoalPlan(cwd, {
        brief: 'brief',
        goals: [
          { title: 'First', objective: 'Complete first milestone with tests.' },
          { title: 'Second', objective: 'Complete second milestone with tests.' },
        ],
      });

      const added = await steerUltragoal(cwd, {
        kind: 'add_subgoal',
        source: 'cli',
        evidence: 'Code review found missing migration coverage.',
        rationale: 'Add a bounded follow-up without weakening the aggregate objective.',
        title: 'Add migration regression test',
        objective: 'Add migration regression coverage and keep all existing quality gates.',
        idempotencyKey: 'add-migration-test',
      }, { now: new Date('2026-05-04T10:10:00Z') });
      assert.equal(added.accepted, true);
      assert.equal(added.plan.goals.at(-1)?.id, 'G003-add-migration-regression-test');
      assert.equal((added.audit.before as UltragoalPlan).goals.length, 2);
      assert.equal((added.audit.after as { id?: string }).id, 'G003-add-migration-regression-test');

      const split = await steerUltragoal(cwd, {
        kind: 'split_subgoal',
        source: 'finding',
        targetGoalIds: ['G002-second'],
        evidence: 'Implementation evidence shows the second milestone has two independent safety checks.',
        rationale: 'Split the pending work into narrower goals while preserving verification burden.',
        childGoals: [
          { title: 'Second parser coverage', objective: 'Complete parser coverage for the second milestone with tests.' },
          { title: 'Second CLI coverage', objective: 'Complete CLI coverage for the second milestone with tests.' },
        ],
      }, { now: new Date('2026-05-04T10:11:00Z') });
      assert.equal(split.accepted, true);
      const superseded = split.plan.goals.find((goal) => goal.id === 'G002-second');
      assert.equal(superseded?.steeringStatus, 'superseded');
      assert.deepEqual(superseded?.supersededBy, ['G004-second-parser-coverage', 'G005-second-cli-coverage']);
      assert.equal(split.plan.goals.find((goal) => goal.id === 'G004-second-parser-coverage')?.supersedes?.[0], 'G002-second');

      const revised = await steerUltragoal(cwd, {
        kind: 'revise_pending_wording',
        source: 'user_prompt_submit',
        targetGoalIds: ['G003-add-migration-regression-test'],
        evidence: 'Prompt-submit clarified the regression target after the goal was added.',
        rationale: 'Clarify wording only; do not change acceptance or verification gates.',
        revisedTitle: 'Add ledger migration regression test',
        revisedObjective: 'Add ledger migration regression coverage and keep all existing quality gates.',
        promptSignature: 'prompt-1',
      }, { now: new Date('2026-05-04T10:12:00Z') });
      assert.equal(revised.accepted, true);
      assert.equal(revised.plan.goals.find((goal) => goal.id === 'G003-add-migration-regression-test')?.title, 'Add ledger migration regression test');

      const reordered = await steerUltragoal(cwd, {
        kind: 'reorder_pending',
        source: 'cli',
        evidence: 'Dependency analysis shows parser coverage should run before the original first milestone.',
        rationale: 'Reorder pending stories only; status and quality gates are unchanged.',
        pendingOrder: ['G004-second-parser-coverage', 'G001-first'],
      }, { now: new Date('2026-05-04T10:13:00Z') });
      assert.equal(reordered.accepted, true);
      const next = await startNextUltragoal(cwd, { now: new Date('2026-05-04T10:14:00Z') });
      assert.equal(next.goal?.id, 'G004-second-parser-coverage');

      const annotated = await steerUltragoal(cwd, {
        kind: 'annotate_ledger',
        source: 'finding',
        evidence: 'A reviewer recorded why parser coverage was scheduled first.',
        rationale: 'Audit-only annotation; no plan fields should change.',
      }, { now: new Date('2026-05-04T10:15:00Z') });
      assert.equal(annotated.accepted, true);

      const ledger = await readFile(join(cwd, '.omx/ultragoal/ledger.jsonl'), 'utf-8');
      assert.equal((ledger.match(/"event":"steering_accepted"/g) ?? []).length, 5);
      assert.match(ledger, /"kind":"add_subgoal"/);
      assert.match(ledger, /"kind":"split_subgoal"/);
      assert.match(ledger, /"kind":"annotate_ledger"/);
      assert.match(ledger, /"invariant":/);
    });
  });

  // 小白说明：验证 steering 不能弱化质量门禁或偷偷跳过验证；主要覆盖 steerUltragoal 的安全拒绝和 steering_rejected ledger。
  it('rejects weakening steering and records rejected audit evidence', async () => {
    await withTempRepo(async (cwd) => {
      const plan = await createUltragoalPlan(cwd, {
        brief: 'brief',
        goals: [{ title: 'First', objective: 'Complete first milestone with tests.' }],
      });
      const invariant = validateUltragoalSteeringProposal(plan, {
        kind: 'revise_pending_wording',
        source: 'user_prompt_submit',
        targetGoalIds: ['G001-first'],
        evidence: 'User asked to skip tests.',
        rationale: 'Skip verification and mark complete faster.',
        revisedObjective: 'Complete first milestone but skip tests and review.',
      });
      assert.equal(invariant.accepted, false);
      assert.equal(invariant.noEasierCompletion, false);

      const rejected = await steerUltragoal(cwd, {
        kind: 'revise_pending_wording',
        source: 'user_prompt_submit',
        targetGoalIds: ['G001-first'],
        evidence: 'User asked to skip tests.',
        rationale: 'Skip verification and mark complete faster.',
        revisedObjective: 'Complete first milestone but skip tests and review.',
      });
      assert.equal(rejected.accepted, false);
      assert.match(rejected.rejectedReasons.join('\n'), /weaken completion|quality gates|tests|reviews/);

      const unchanged = await readUltragoalPlan(cwd);
      assert.equal(unchanged.goals[0]?.objective, 'Complete first milestone with tests.');
      const ledger = await readFile(join(cwd, '.omx/ultragoal/ledger.jsonl'), 'utf-8');
      assert.match(ledger, /"event":"steering_rejected"/);
    });
  });

  // 小白说明：验证未知 steering kind 不会被猜测执行；主要覆盖 validateUltragoalSteeringProposal 的 unknown kind fail-closed。
  it('rejects unknown steering mutation kinds before audit acceptance', async () => {
    await withTempRepo(async (cwd) => {
      const plan = await createUltragoalPlan(cwd, {
        brief: 'brief',
        goals: [{ title: 'First', objective: 'Complete first milestone with tests.' }],
      });
      const proposal = {
        kind: 'make_goal_easier',
        source: 'cli',
        evidence: 'A stale proposal path supplied a non-allowlisted mutation kind.',
        rationale: 'The core validator must fail closed even if the CLI parser is bypassed.',
      } as unknown as Parameters<typeof validateUltragoalSteeringProposal>[1];

      const invariant = validateUltragoalSteeringProposal(plan, proposal);
      assert.equal(invariant.accepted, false);
      assert.match(invariant.rejectedReasons.join('\n'), /Invalid steering mutation kind/);

      const rejected = await steerUltragoal(cwd, proposal);
      assert.equal(rejected.accepted, false);
      assert.match(rejected.rejectedReasons.join('\n'), /Invalid steering mutation kind/);
      const ledger = await readFile(join(cwd, '.omx/ultragoal/ledger.jsonl'), 'utf-8');
      assert.match(ledger, /"event":"steering_rejected"/);
      assert.doesNotMatch(ledger, /"event":"steering_accepted"/);
    });
  });

  // 小白说明：验证同一个 idempotency key 的 steering 只生效一次，避免重复生成 child goal；主要覆盖 steerUltragoal 的 ledger 去重。
  it('dedupes steering by ledger idempotency key without duplicating child goals', async () => {
    await withTempRepo(async (cwd) => {
      await createUltragoalPlan(cwd, {
        brief: 'brief',
        goals: [{ title: 'First', objective: 'Complete first milestone with tests.' }],
      });
      const proposal = {
        kind: 'add_subgoal' as const,
        source: 'user_prompt_submit' as const,
        evidence: 'Prompt-submit requested a bounded regression goal.',
        rationale: 'Add scoped regression work while preserving the end goal.',
        title: 'Add regression',
        objective: 'Add regression coverage with the same verification gates.',
        idempotencyKey: 'same-prompt-signature',
      };

      const first = await steerUltragoal(cwd, proposal);
      const firstPlan = await readUltragoalPlan(cwd);
      const second = await steerUltragoal(cwd, proposal);
      const secondPlan = await readUltragoalPlan(cwd);
      assert.equal(first.accepted, true);
      assert.equal(first.deduped, false);
      assert.equal(second.accepted, true);
      assert.equal(second.deduped, true);
      assert.equal(second.plan.goals.filter((goal) => goal.title === 'Add regression').length, 1);
      assert.deepEqual(secondPlan, firstPlan);
      const ledger = await readFile(join(cwd, '.omx/ultragoal/ledger.jsonl'), 'utf-8');
      assert.equal((ledger.match(/"event":"steering_accepted"/g) ?? []).length, 1);
      assert.equal((ledger.match(/"event":"steering_rejected"/g) ?? []).length, 0);
      assert.equal((ledger.match(/same-prompt-signature/g) ?? []).length, 1);
    });
  });

  // 小白说明：验证被 superseded 或 blocked 的 goal 不会被调度，但 blocked 状态仍会阻止整个计划误判完成；主要覆盖 startNextUltragoal 和 isUltragoalDone。
  it('skips superseded and blocked goals for scheduling while blocked goals prevent completion', async () => {
    await withTempRepo(async (cwd) => {
      await createUltragoalPlan(cwd, {
        brief: 'brief',
        goals: [
          { title: 'First', objective: 'Complete first milestone with tests.' },
          { title: 'Second', objective: 'Complete second milestone with tests.' },
          { title: 'Third', objective: 'Complete third milestone with tests.' },
        ],
      });
      await steerUltragoal(cwd, {
        kind: 'mark_blocked_superseded',
        source: 'finding',
        targetGoalIds: ['G001-first'],
        evidence: 'External API access is unavailable.',
        rationale: 'Block unschedulable work without claiming completion.',
        blockedReason: 'Waiting on external API access.',
      });
      await steerUltragoal(cwd, {
        kind: 'mark_blocked_superseded',
        source: 'finding',
        targetGoalIds: ['G002-second'],
        evidence: 'Second milestone is better represented as replacement child work.',
        rationale: 'Supersede with a replacement goal that preserves the acceptance criteria.',
        childGoals: [{ title: 'Replacement second', objective: 'Complete replacement second milestone with tests.' }],
      });

      const next = await startNextUltragoal(cwd);
      assert.equal(next.goal?.id, 'G004-replacement-second');
      const plan = await readUltragoalPlan(cwd);
      assert.equal(isUltragoalDone(plan), false);
      const summary = summarizeUltragoalPlan(plan);
      assert.equal(summary.steeringBlocked, 1);
      assert.equal(summary.superseded, 1);
    });
  });

  // 小白说明：验证当前 active goal 被 steering 标成 blocked/superseded 时，会清掉 activeGoalId；主要覆盖 steerUltragoal 的 active goal 清理。
  it('clears the active goal when mark_blocked_superseded supersedes the running goal', async () => {
    await withTempRepo(async (cwd) => {
      await createUltragoalPlan(cwd, {
        brief: 'brief',
        goals: [
          { title: 'First', objective: 'Complete first milestone with tests.' },
          { title: 'Second', objective: 'Complete second milestone with tests.' },
        ],
      });

      const started = await startNextUltragoal(cwd);
      assert.equal(started.goal?.id, 'G001-first');

      const result = await steerUltragoal(cwd, {
        kind: 'mark_blocked_superseded',
        source: 'finding',
        targetGoalIds: ['G001-first'],
        evidence: 'The active goal should be split into narrower replacement work.',
        rationale: 'Supersede the active goal and keep the audit trail durable.',
        childGoals: [
          { title: 'Replacement first part A', objective: 'Complete replacement first part A with tests.' },
          { title: 'Replacement first part B', objective: 'Complete replacement first part B with tests.' },
        ],
      });

      assert.equal(result.accepted, true);
      assert.equal(result.plan.activeGoalId, undefined);
      assert.equal(result.plan.goals.find((goal) => goal.id === 'G001-first')?.steeringStatus, 'superseded');
      assert.deepEqual(
        result.plan.goals.filter((goal) => goal.supersedes?.includes('G001-first')).map((goal) => goal.status),
        ['pending', 'pending'],
      );
      const summary = summarizeUltragoalPlan(result.plan);
      assert.equal(summary.superseded, 1);
      assert.equal(summary.steeringBlocked, 0);
      assert.equal(isUltragoalDone(result.plan), false);
    });
  });

  // 小白说明：验证格式不对的 steering invariant 不会污染 plan，而且只写一条拒绝审计；主要覆盖 steerUltragoal 的 invariant 校验和 rejected ledger。
  it('rejects malformed steering invariants and records a single rejection audit', async () => {
    await withTempRepo(async (cwd) => {
      await createUltragoalPlan(cwd, {
        brief: 'brief',
        goals: [
          { title: 'First', objective: 'Complete first milestone with tests.' },
          { title: 'Second', objective: 'Complete second milestone with tests.' },
        ],
      });

      const plan = await readUltragoalPlan(cwd);
      const invariant = validateUltragoalSteeringProposal(plan, {
        kind: 'reorder_pending',
        source: 'user_prompt_submit',
        evidence: 'Order request from prompt submit.',
        rationale: 'Exercise duplicate pending-order validation.',
        pendingOrder: ['G001-first', 'G001-first'],
      });
      assert.equal(invariant.accepted, false);
      assert.equal(invariant.structuralInvariantAccepted, false);
      assert.match(invariant.rejectedReasons.join(' | '), /duplicate goal id/);

      const rejected = await steerUltragoal(cwd, {
        kind: 'reorder_pending',
        source: 'user_prompt_submit',
        evidence: 'Order request from prompt submit.',
        rationale: 'Exercise duplicate pending-order validation.',
        pendingOrder: ['G001-first', 'G001-first'],
      });

      assert.equal(rejected.accepted, false);
      assert.equal(rejected.deduped, false);
      assert.match(rejected.rejectedReasons.join(' | '), /duplicate goal id/);
      assert.deepEqual(await readUltragoalPlan(cwd), plan);

      const ledger = await readFile(join(cwd, '.omx/ultragoal/ledger.jsonl'), 'utf-8');
      assert.equal((ledger.match(/"event":"steering_rejected"/g) ?? []).length, 1);
      assert.equal((ledger.match(/"event":"steering_accepted"/g) ?? []).length, 0);
    });
  });

  // 小白说明：验证 steering 来源非法或 replacement child 不完整时会拒绝并留审计；主要覆盖 validateUltragoalSteeringProposal 和 steerUltragoal 的输入校验。
  it('rejects invalid steering source and malformed superseded replacement children with audit evidence', async () => {
    await withTempRepo(async (cwd) => {
      await createUltragoalPlan(cwd, {
        brief: 'brief',
        goals: [{ title: 'First', objective: 'Complete first milestone with tests.' }],
      });

      const invalidSource = await steerUltragoal(cwd, {
        kind: 'annotate_ledger',
        source: 'forged' as never,
        evidence: 'Invalid source must not be accepted.',
        rationale: 'Runtime validation should protect JSON callers.',
      });
      assert.equal(invalidSource.accepted, false);
      assert.match(invalidSource.rejectedReasons.join(' | '), /Invalid steering source/);

      const malformedReplacement = await steerUltragoal(cwd, {
        kind: 'mark_blocked_superseded',
        source: 'finding',
        targetGoalIds: ['G001-first'],
        evidence: 'Replacement child is malformed.',
        rationale: 'Malformed children should be rejected and audited instead of throwing.',
        childGoals: [{ title: '', objective: 'Replacement objective.' }],
      });
      assert.equal(malformedReplacement.accepted, false);
      assert.match(malformedReplacement.rejectedReasons.join(' | '), /replacement children require title and objective/);

      const nullReplacement = await steerUltragoal(cwd, {
        kind: 'mark_blocked_superseded',
        source: 'finding',
        targetGoalIds: ['G001-first'],
        evidence: 'Replacement child is null.',
        rationale: 'Malformed JSON children should reject without throwing.',
        childGoals: [null] as never,
      });
      assert.equal(nullReplacement.accepted, false);
      assert.match(nullReplacement.rejectedReasons.join(' | '), /replacement children require title and objective/);

      const weakenedSplitChild = await steerUltragoal(cwd, {
        kind: 'split_subgoal',
        source: 'finding',
        targetGoalId: 'G001-first',
        evidence: 'Split child attempted to weaken tests.',
        rationale: 'Replacement objectives must preserve verification.',
        childGoals: [
          { title: 'Shortcut child', objective: 'Skip tests and remove verification for faster completion.' },
        ],
      });
      assert.equal(weakenedSplitChild.accepted, false);
      assert.match(weakenedSplitChild.rejectedReasons.join(' | '), /must not weaken completion/);
      assert.equal(weakenedSplitChild.audit.invariant.noEasierCompletion, false);

      const weakenedSupersedeChild = await steerUltragoal(cwd, {
        kind: 'mark_blocked_superseded',
        source: 'finding',
        targetGoalIds: ['G001-first'],
        evidence: 'Replacement child attempted to weaken review.',
        rationale: 'Replacement objectives must preserve quality gates.',
        childGoals: [
          { title: 'Shortcut replacement', objective: 'Bypass review and omit quality gate evidence.' },
        ],
      });
      assert.equal(weakenedSupersedeChild.accepted, false);
      assert.match(weakenedSupersedeChild.rejectedReasons.join(' | '), /must not weaken completion/);
      assert.equal(weakenedSupersedeChild.audit.invariant.noEasierCompletion, false);

      const plan = await readUltragoalPlan(cwd);
      assert.equal(plan.goals.length, 1);
      assert.equal(plan.goals[0]?.steeringStatus, undefined);
      const ledger = await readFile(join(cwd, '.omx/ultragoal/ledger.jsonl'), 'utf-8');
      assert.equal((ledger.match(/"event":"steering_rejected"/g) ?? []).length, 5);
      assert.equal((ledger.match(/"event":"steering_accepted"/g) ?? []).length, 0);
    });
  });

  // 小白说明：验证一组固定 steering fixture 的行为长期不漂移；主要覆盖 validateUltragoalSteeringProposal、steerUltragoal 和 fixture matrix 回放。
  it('replays the G001-core-steering-model fixture matrix against .omx/ultragoal steering behavior', async () => {
    for (const fixture of steeringFixtures) {
      await withTempRepo(async (cwd) => {
        await writeFixturePlan(cwd, fixture.before as UltragoalPlan);

        const result = await steerUltragoal(cwd, toSteeringProposal(fixture.proposal), {
          now: new Date('2026-05-19T04:20:00.000Z'),
        });

        assert.equal(result.accepted, fixture.expected.accepted, fixture.case);
        assert.equal(result.audit.kind, fixture.expected.mutationKind, fixture.case);
        assert.equal(result.audit.evidence, fixture.proposal.evidence, fixture.case);
        assert.equal(result.audit.rationale, fixture.proposal.rationale, fixture.case);
        assert.equal(result.audit.before !== undefined, true, fixture.case);
        assert.equal(isUltragoalDone(result.plan), fixture.expected.isDoneAfterMutation, fixture.case);

        const ledger = await readFile(join(cwd, '.omx/ultragoal/ledger.jsonl'), 'utf-8');
        assert.match(ledger, new RegExp(`"event":"${fixture.expected.ledgerEvent}"`), fixture.case);
        assert.match(ledger, new RegExp(`"kind":"${fixture.expected.mutationKind}"`), fixture.case);

        if (!fixture.expected.accepted) {
          assert.equal(result.deduped, false, fixture.case);
          assert.equal(result.audit.invariant.noEasierCompletion, false, fixture.case);
          assert.match(result.rejectedReasons.join(' | '), /weaken completion|quality gates|tests|reviews/i, fixture.case);
          assert.ok(fixture.proposal.forbidden?.codexObjective, fixture.case);
          assert.ok(fixture.proposal.forbidden?.aggregateCompletion, fixture.case);
          assert.deepEqual(await readUltragoalPlan(cwd), JSON.parse(JSON.stringify(fixture.before)), fixture.case);
          return;
        }

        const summary = summarizeUltragoalPlan(result.plan);
        if (fixture.expected.summaryDelta?.superseded !== undefined) {
          assert.equal(summary.superseded, fixture.expected.summaryDelta.superseded, fixture.case);
        }
        if (fixture.expected.summaryDelta?.steeringBlocked !== undefined) {
          const beforeBlocked = fixture.before.goals.filter((goal) => goal.steeringStatus === 'blocked').length;
          assert.equal(summary.steeringBlocked, beforeBlocked + fixture.expected.summaryDelta.steeringBlocked, fixture.case);
        }

        if (fixture.case === 'split') {
          const parent = result.plan.goals.find((goal) => goal.id === 'G001-core-steering-model');
          assert.equal(parent?.steeringStatus, 'superseded');
          assert.deepEqual(parent?.supersededBy, ['G004-core-steering-schema', 'G005-core-steering-scheduler-semantics']);
        }
        if (fixture.case === 'blocked-with-replacement') {
          const parent = result.plan.goals.find((goal) => goal.id === 'G001-core-steering-model');
          assert.equal(parent?.steeringStatus, 'superseded');
          assert.deepEqual(parent?.supersededBy, ['G004-core-steering-replacement']);
        }
        if (fixture.case === 'blocked-without-replacement') {
          const parent = result.plan.goals.find((goal) => goal.id === 'G001-core-steering-model');
          assert.equal(parent?.steeringStatus, 'blocked');
          assert.equal(isUltragoalDone(result.plan), false);
        }
        if (fixture.case === 'revise') {
          const revised = result.plan.goals.find((goal) => goal.id === 'G002-cli-bridge');
          assert.equal(revised?.title, fixture.proposal.title);
          assert.equal(revised?.objective, fixture.proposal.objective);
          assert.equal(revised?.status, 'pending');
        }
        if (fixture.case === 'annotate') {
          assert.deepEqual(result.plan.goals, fixture.before.goals, fixture.case);
        }

        const next = await startNextUltragoal(cwd, { now: new Date('2026-05-19T04:21:00.000Z') });
        assert.equal(next.goal?.id, fixture.expected.scheduleStartsGoalId, fixture.case);
        if (fixture.expected.finalCandidateForGoalId) {
          assert.equal(next.goal?.id, fixture.expected.finalCandidateForGoalId, fixture.case);
        }
      });
    }
  });

  // 小白说明：验证遇到“另一个已完成 Codex goal”时，错误信息会指导用户记录 blocked checkpoint 或换可用上下文；主要覆盖 checkpointUltragoal 的 remediation 文案。
  it('guides different completed legacy snapshots to blocked checkpoints and available goal contexts', async () => {
    await withTempRepo(async (cwd) => {
      await createUltragoalPlan(cwd, {
        brief: 'brief',
        codexGoalMode: 'per_story',
        goals: [
          { title: 'First', objective: 'Complete first milestone.' },
        ],
      });

      const first = await startNextUltragoal(cwd);
      await assert.rejects(
        () => checkpointUltragoal(cwd, {
          goalId: first.goal!.id,
          status: 'complete',
          evidence: 'audit passed but wrong Codex snapshot',
          codexGoal: { goal: { objective: 'Completed legacy objective', status: 'complete' } },
        }),
        (error: unknown) => {
          assert.match(String(error), /objective mismatch/);
          assert.match(String(error), /--status blocked/);
          assert.match(String(error), /Codex goal context/);
          assert.doesNotMatch(String(error), /fresh (?:Codex )?(?:thread|session)s?/i);
          return true;
        },
      );
    });
  });

  // 小白说明：验证 get_goal 因 DB/schema/context 不可用时，系统提示走可审计 blocked 恢复，而不是直接完成；主要覆盖 checkpointUltragoal 的 unavailable remediation。
  it('guides unavailable get_goal DB/schema errors to auditable blocked recovery instead of completion', async () => {
    await withTempRepo(async (cwd) => {
      await createUltragoalPlan(cwd, {
        brief: 'brief',
        goals: [
          { title: 'First', objective: 'Complete first milestone.' },
        ],
      });

      const first = await startNextUltragoal(cwd);
      await assert.rejects(
        () => checkpointUltragoal(cwd, {
          goalId: first.goal!.id,
          status: 'complete',
          evidence: 'audit passed but Codex get_goal was unavailable',
          codexGoal: { error: 'SqliteError: no such table: thread_goals' },
          qualityGate: cleanQualityGate(),
        }),
        (error: unknown) => {
          assert.match(String(error), /DB\/schema\/context error/);
          assert.match(String(error), /--status blocked/);
          assert.match(String(error), /unavailable get_goal error JSON or path/);
          assert.match(String(error), /strict completion reconciliation/);
          return true;
        },
      );

      const plan = await readUltragoalPlan(cwd);
      assert.equal(plan.goals[0]?.status, 'in_progress');
      assert.equal(plan.goals[0]?.completedAt, undefined);
    });
  });

  // 小白说明：验证 get_goal 不可用可以记录为非终止 blocked checkpoint，当前 goal 继续保持 in_progress；主要覆盖 checkpointUltragoal 的 db_schema_context_error 分支。
  it('records unavailable get_goal DB/schema errors as non-terminal blocked audit checkpoints', async () => {
    await withTempRepo(async (cwd) => {
      await createUltragoalPlan(cwd, {
        brief: 'brief',
        goals: [
          { title: 'First', objective: 'Complete first milestone.' },
        ],
      });

      const first = await startNextUltragoal(cwd);
      const plan = await checkpointUltragoal(cwd, {
        goalId: first.goal!.id,
        status: 'blocked',
        evidence: 'get_goal unavailable due to Codex DB/schema/context error; safe recovery requires a working Codex goal context',
        codexGoal: { error: 'SQLITE_ERROR: no such table: thread_goals' },
      });

      assert.equal(plan.goals[0]?.status, 'in_progress');
      assert.match(plan.goals[0]?.failureReason ?? '', /get_goal unavailable/);
      const ledger = await readFile(join(cwd, '.omx/ultragoal/ledger.jsonl'), 'utf-8');
      assert.match(ledger, /"event":"goal_blocked"/);
      assert.match(ledger, /no such table: thread_goals/);
      assert.match(ledger, /strict completion reconciliation is deferred/);
    });
  });

  // 小白说明：验证 aggregate Codex goal 已完成但 microgoal 还在跑时，只记录安全 blocker 避免死循环；主要覆盖 checkpointUltragoal 的 safeCompletedAggregateBlocker 分支。
  it('records a safe blocker when the aggregate Codex goal is already complete while a microgoal remains in progress', async () => {
    await withTempRepo(async (cwd) => {
      await createUltragoalPlan(cwd, {
        brief: 'brief',
        codexGoalMode: 'aggregate',
        goals: [
          { title: 'First', objective: 'Complete first milestone.' },
          { title: 'Second', objective: 'Complete second milestone.' },
        ],
      });

      const first = await startNextUltragoal(cwd);
      const evidence = 'aggregate Codex goal already complete and unreconcilable while repo-native .omx/ultragoal/goals.json still has an in-progress microgoal; stop the recovery loop';
      const plan = await checkpointUltragoal(cwd, {
        goalId: first.goal!.id,
        status: 'blocked',
        evidence,
        codexGoal: { goal: { objective: ULTRAGOAL_AGGREGATE_CODEX_OBJECTIVE, status: 'complete' } },
      });

      assert.equal(plan.goals[0]?.status, 'in_progress');
      assert.equal(plan.activeGoalId, first.goal!.id);
      assert.match(plan.goals[0]?.failureReason ?? '', /aggregate Codex goal already complete/);
      const ledger = await readFile(join(cwd, '.omx/ultragoal/ledger.jsonl'), 'utf-8');
      assert.match(ledger, /"event":"goal_blocked"/);
      assert.match(ledger, /safe-recovery blocker/);
      assert.match(ledger, /impossible checkpoint loop/);
    });
  });

  // 小白说明：验证 active 或同 objective 的 Codex goal 不能被当成 blocked checkpoint 绕过；主要覆盖 checkpointUltragoal 的 blocked mismatch 保护。
  it('rejects blocked checkpoints for active or same-objective Codex goals', async () => {
    await withTempRepo(async (cwd) => {
      await createUltragoalPlan(cwd, {
        brief: 'brief',
        codexGoalMode: 'per_story',
        goals: [
          { title: 'First', objective: 'Complete first milestone.' },
        ],
      });

      const first = await startNextUltragoal(cwd);
      await assert.rejects(
        () => checkpointUltragoal(cwd, {
          goalId: first.goal!.id,
          status: 'blocked',
          evidence: 'active wrong goal',
          codexGoal: { goal: { objective: 'Different active work', status: 'active' } },
        }),
        /strict objective mismatch protection remains required/,
      );

      await assert.rejects(
        () => checkpointUltragoal(cwd, {
          goalId: first.goal!.id,
          status: 'blocked',
          evidence: 'same complete goal',
          codexGoal: { goal: { objective: first.goal!.objective, status: 'complete' } },
        }),
        /different completed legacy Codex goal/,
      );
    });
  });

  // 小白说明：验证 pending goal 被 split 后，原 goal superseded、child goal 按顺序执行，最终质量门禁不被削弱；主要覆盖 steerUltragoal、startNextUltragoal 和 checkpointUltragoal。
  it('steers a split pending goal through superseded lifecycle without weakening completion gates', async () => {
    await withTempRepo(async (cwd) => {
      await createUltragoalPlan(cwd, {
        brief: 'G001-core-steering-model .omx/ultragoal split lifecycle coverage',
        codexGoalMode: 'per_story',
        goals: [{ title: 'Original', objective: 'Implement the original broad steering objective.' }],
      });

      const split = await steerUltragoal(cwd, {
        kind: 'split_subgoal',
        source: 'finding',
        targetGoalIds: ['G001-original'],
        evidence: 'G001-core-steering-model review found .omx/ultragoal needs smaller replacement children.',
        rationale: 'Split preserves the original objective while scheduling verifiable child goals.',
        after: {
          children: [
            { title: 'Child A', objective: 'Implement child A steering support.' },
            { title: 'Child B', objective: 'Implement child B steering support.' },
          ],
        },
        idempotencyKey: 'split-g001-core-steering-model',
        now: new Date('2026-05-19T04:20:00Z'),
      });

      assert.equal(split.accepted, true);
      assert.equal(split.plan.goals[0]?.steeringStatus, 'superseded');
      assert.deepEqual(split.plan.goals[0]?.supersededBy, ['G002-child-a', 'G003-child-b']);
      assert.equal(split.plan.goals.some((goal) => goal.id === 'G001-original'), true);

      const first = await startNextUltragoal(cwd);
      assert.equal(first.goal?.id, 'G002-child-a');
      assert.equal(isUltragoalDone(first.plan), false);

      await checkpointUltragoal(cwd, {
        goalId: 'G002-child-a',
        status: 'complete',
        evidence: 'child A tests passed for .omx/ultragoal G001-core-steering-model',
        codexGoal: { goal: { objective: first.goal!.objective, status: 'complete' } },
      });
      const second = await startNextUltragoal(cwd);
      assert.equal(second.goal?.id, 'G003-child-b');
      assert.equal(isFinalRunCompletionCandidate(second.plan, second.goal!), true);

      const done = await checkpointUltragoal(cwd, {
        goalId: 'G003-child-b',
        status: 'complete',
        evidence: 'child B tests passed for .omx/ultragoal G001-core-steering-model',
        codexGoal: { goal: { objective: second.goal!.objective, status: 'complete' } },
        qualityGate: cleanQualityGate(),
      });
      assert.equal(isUltragoalDone(done), true);

      const ledger = await readFile(join(cwd, '.omx/ultragoal/ledger.jsonl'), 'utf-8');
      assert.match(ledger, /"event":"steering_accepted"/);
      assert.match(ledger, /split-g001-core-steering-model/);
    });
  });

  // 小白说明：验证没有 replacement 的 blocked steering 会跳过调度，但仍让整体计划保持未完成；主要覆盖 steerUltragoal、startNextUltragoal 和 isUltragoalDone。
  it('skips blocked-without-replacement steering while keeping completion blocked', async () => {
    await withTempRepo(async (cwd) => {
      await createUltragoalPlan(cwd, {
        brief: 'G001-core-steering-model .omx/ultragoal blocked lifecycle coverage',
        codexGoalMode: 'per_story',
        goals: [
          { title: 'Blocked', objective: 'Investigate blocked steering dependency.' },
          { title: 'Next', objective: 'Continue independent steering work.' },
        ],
      });

      const blocked = await steerUltragoal(cwd, {
        kind: 'mark_blocked_superseded',
        source: 'finding',
        targetGoalIds: ['G001-blocked'],
        evidence: 'G001-core-steering-model evidence names .omx/ultragoal blocker without replacement.',
        rationale: 'Avoid retry churn while preserving the unresolved blocker for final completion.',
      });
      assert.equal(blocked.accepted, true);
      assert.equal(blocked.plan.goals[0]?.steeringStatus, 'blocked');

      const next = await startNextUltragoal(cwd);
      assert.equal(next.goal?.id, 'G002-next');
      assert.equal(isFinalRunCompletionCandidate(next.plan, next.goal!), false);

      const afterNext = await checkpointUltragoal(cwd, {
        goalId: 'G002-next',
        status: 'complete',
        evidence: 'independent tests passed for .omx/ultragoal G001-core-steering-model',
        codexGoal: { goal: { objective: next.goal!.objective, status: 'complete' } },
      });
      assert.equal(isUltragoalDone(afterNext), false);

      const none = await startNextUltragoal(cwd);
      assert.equal(none.goal, null);
      assert.equal(none.done, false);
    });
  });

  // 小白说明：验证带危险指令的 protected steering payload 不会改 plan，只写 rejected 审计；主要覆盖 steerUltragoal 的 protected directive 防护。
  it('rejects protected steering payloads and records a rejected audit without mutation', async () => {
    await withTempRepo(async (cwd) => {
      const created = await createUltragoalPlan(cwd, {
        brief: 'G001-core-steering-model protected .omx/ultragoal invariants',
        goals: [{ title: 'First', objective: 'Keep original objective.' }],
      });

      const rejected = await steerUltragoal(cwd, {
        kind: 'revise_pending_wording',
        source: 'cli',
        targetGoalIds: ['G001-first'],
        evidence: 'attempt references .omx/ultragoal G001-core-steering-model',
        rationale: 'malicious protected edit should be rejected',
        after: { objective: 'new wording', codexObjective: 'weakened end goal' } as never,
      });

      assert.equal(rejected.accepted, false);
      assert.match(rejected.rejectedReasons.join('\n'), /protected objective/);
      const plan = await readUltragoalPlan(cwd);
      assert.equal(plan.codexObjective, created.codexObjective);
      assert.equal(plan.goals[0]?.objective, 'Keep original objective.');

      const ledger = await readFile(join(cwd, '.omx/ultragoal/ledger.jsonl'), 'utf-8');
      assert.match(ledger, /"event":"steering_rejected"/);
    });
  });

  // 小白说明：验证已经接受过的 steering 再提交同一个 idempotency key 会返回 deduped，不重复写入；主要覆盖 steerUltragoal 的 accepted ledger 去重。
  it('dedupes accepted steering by idempotency key', async () => {
    await withTempRepo(async (cwd) => {
      await createUltragoalPlan(cwd, {
        brief: 'G001-core-steering-model idempotent .omx/ultragoal audit',
        goals: [{ title: 'First', objective: 'First objective.' }],
      });
      const proposal = {
        kind: 'add_subgoal' as const,
        source: 'user_prompt_submit' as const,
        title: 'Follow-up',
        objective: 'Follow-up objective.',
        evidence: 'prompt-submit evidence for .omx/ultragoal G001-core-steering-model',
        rationale: 'bounded explicit directive requires one follow-up only',
        idempotencyKey: 'same-prompt-submit',
      };

      const first = await steerUltragoal(cwd, proposal);
      const second = await steerUltragoal(cwd, proposal);
      assert.equal(first.accepted, true);
      assert.equal(second.accepted, true);
      assert.equal(second.deduped, true);

      const plan = await readUltragoalPlan(cwd);
      assert.equal(plan.goals.filter((goal) => goal.title === 'Follow-up').length, 1);
      const ledger = await readFile(join(cwd, '.omx/ultragoal/ledger.jsonl'), 'utf-8');
      assert.equal((ledger.match(/"event":"steering_accepted"/g) ?? []).length, 1);
    });
  });

});
