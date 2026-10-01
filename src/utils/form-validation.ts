import type { CronFormState } from '../composables/useCronState.ts'

export function validateCronForm(
    input: CronFormState,
    deliveryValid: boolean,
    existingSessionValid = true,
): string[] {
    const errors: string[] = []

    if (!input.name?.trim()) {
        errors.push('Name is required')
    }
    if (input.executionTarget?.type === 'newSession' && !input.executionTarget.agentId?.trim()) {
        errors.push('Agent is required')
    }
    if (input.executionTarget?.type === 'existingSession' && !input.executionTarget.sessionId?.trim()) {
        errors.push('Session ID is required')
    }
    if (input.executionTarget?.type === 'existingSession' && !existingSessionValid) {
        errors.push('Session ID is invalid')
    }
    if (input.scheduleKind === 'cron' && !input.cronExpr?.trim()) {
        errors.push('Cron expression is required')
    }
    if (input.scheduleKind === 'every' && (!input.everyAmount?.trim() || !input.everyUnit?.trim())) {
        errors.push('Interval details required')
    }
    if (input.scheduleKind === 'at' && !input.scheduleAt?.trim()) {
        errors.push('Schedule time is required')
    }
    if (!deliveryValid) {
        errors.push('Delivery targets are invalid')
    }

    return errors
}

