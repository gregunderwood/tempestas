import { Controller, Get, HttpCode, Post } from '@nestjs/common';
import type { RulesEvaluation, RulesCycle } from '@tempestas/domain';
import { RulesService } from './rules.service';

@Controller('rules')
export class RulesController {
  constructor(private readonly rules: RulesService) {}

  /**
   * The endpoint whose absence made the Python version opaque: it logged what it
   * did but never what it saw, so "the burner is off" and "the rule never ran"
   * looked identical. This returns every input alongside every decision -
   * resolved climate, provenance, local time, ownership, and what each device
   * actually did with the decision.
   *
   * An array because a zone is the unit of evaluation and there may be several.
   * Empty until the first tick has run.
   */
  @Get('last-evaluation')
  lastEvaluation(): RulesEvaluation[] {
    return this.rules.lastEvaluation();
  }

  @Get('latest-cycle')
  findLatestRulesCycle(): { cycle: RulesCycle | null } {
    return { cycle: this.rules.findLatestRulesCycle() };
  }

  /**
   * Force an evaluation now, on exactly the same code path as the scheduled
   * tick. It drives real relays, so it is a POST and it sits behind the shared
   * token with the other mutating verbs.
   */
  @Post('evaluate')
  @HttpCode(200)
  evaluate(): Promise<RulesEvaluation[]> {
    return this.rules.evaluateAll();
  }
}
