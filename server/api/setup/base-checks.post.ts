import { baseChecks } from '../../factory/setup'

// Runs checks.sh on origin/<base>: slow, so kept off GET /api/setup. Takes nothing from the request.
export default defineEventHandler(() => guarded(() => baseChecks(projectDir())))
