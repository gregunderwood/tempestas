import { Controller, Get, HttpCode, Post } from '@nestjs/common';
import type { RulesEvaluation, RulesCycle } from '@tempestas/domain';
import { RulesService } from './rules.service';

@Controller('rules')
export class RulesController {
  constructor(private readonly rules: RulesService) {}

  @Get('last-evaluation')
  findLastEvaluations(): RulesEvaluation[] {
    return this.rules.findLastEvaluations();
  }

  @Get('latest-cycle')
  findLatestRulesCycle(): { cycle: RulesCycle | null } {
    return { cycle: this.rules.findLatestRulesCycle() };
  }

  // A POST because it drives real relays, on the same path as the scheduled tick.
  @Post('evaluate')
  @HttpCode(200)
  evaluate(): Promise<RulesEvaluation[]> {
    return this.rules.evaluateAll();
  }
}
