import { Refused } from './machine'
import type { FactoryConfig, IntakeInfo, JobAgents, Risk } from './types'

/** Intake's risk and surfaces → the job's reviewers and their models, from config. */
export function route(intake: IntakeInfo, config: FactoryConfig): JobAgents {
  const base = intake.risk ? config.routing[intake.risk as Risk] : undefined
  if (!base) {
    throw new Refused(`risk '${intake.risk}' isn't in config routing (${Object.keys(config.routing).join(', ')})`)
  }
  const reviewers = { ...base }
  for (const surface of intake.surfaces) {
    const extra = config.surfaceReviewers[surface]
    if (!extra) {
      throw new Refused(`surface '${surface}' isn't in config surfaceReviewers (${Object.keys(config.surfaceReviewers).join(', ')})`)
    }
    Object.assign(reviewers, extra)
  }
  return { reviewers }
}
