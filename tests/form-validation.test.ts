import test from 'node:test'
import assert from 'node:assert/strict'

import { validateCronForm } from '../src/utils/form-validation.ts'

test('cron form blocks save when delivery validation fails', () => {
    const errors = validateCronForm({
        name: 'daily',
        description: '',
        executionTarget: { type: 'newSession', agentId: 'main' },
        enabled: true,
        scheduleKind: 'cron',
        scheduleAt: '',
        everyAmount: '1',
        everyUnit: 'hours',
        cronExpr: '* * * * *',
        cronTz: '',
        payloadText: 'run',
        timeoutSeconds: '',
        deliveryTargets: [{ type: 'notification' }],
    }, false)

    assert.ok(errors.length > 0)
})

test('cron form allows save when delivery validation and schedule fields are valid', () => {
    const errors = validateCronForm({
        name: 'daily',
        description: '',
        executionTarget: { type: 'newSession', agentId: 'main' },
        enabled: true,
        scheduleKind: 'cron',
        scheduleAt: '',
        everyAmount: '1',
        everyUnit: 'hours',
        cronExpr: '* * * * *',
        cronTz: '',
        payloadText: 'run',
        timeoutSeconds: '',
        deliveryTargets: [{ type: 'notification' }],
    }, true)

    assert.equal(errors.length, 0)
})

test('cron form allows save when no delivery targets are selected', () => {
    const errors = validateCronForm({
        name: 'daily',
        description: '',
        executionTarget: { type: 'newSession', agentId: 'main' },
        enabled: true,
        scheduleKind: 'cron',
        scheduleAt: '',
        everyAmount: '1',
        everyUnit: 'hours',
        cronExpr: '* * * * *',
        cronTz: '',
        payloadText: 'run',
        timeoutSeconds: '',
        deliveryTargets: [],
    }, true)

    assert.equal(errors.length, 0)
})


