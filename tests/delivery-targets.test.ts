import test from 'node:test'
import assert from 'node:assert/strict'

import {
    defaultCronDeliveryTargets,
    buildDeliveryValidationPayload,
    sanitizeDeliveryTargets,
    summarizeDeliveryTargets,
    validateDeliveryTargets,
} from '../src/utils/delivery-targets.ts'

test('sanitize merges duplicate email recipients', () => {
    const result = sanitizeDeliveryTargets([
        { type: 'email', to: [' a@example.com ', ''] },
        { type: 'email', to: ['b@example.com', 'a@example.com'] },
    ])

    assert.deepEqual(result, [{ type: 'email', to: ['a@example.com', 'b@example.com'] }])
})

test('buildDeliveryValidationPayload matches editor emit contract', () => {
    const result = buildDeliveryValidationPayload([{ type: 'none' }, { type: 'notification' }])

    assert.equal(result.valid, false)
    assert.ok(result.errors.length > 0)
})

test('buildDeliveryValidationPayload collapses none to empty client state', () => {
    const result = buildDeliveryValidationPayload([{ type: 'none' }])

    assert.equal(result.valid, true)
    assert.deepEqual(result.value, [])
})

test('new cron form defaults to no delivery targets selected', () => {
    assert.deepEqual(defaultCronDeliveryTargets(), [])
})

test('empty delivery targets are valid and mean no delivery', () => {
    assert.deepEqual(validateDeliveryTargets([]), [])
})

test('summarize returns no delivery for empty delivery targets', () => {
    assert.equal(summarizeDeliveryTargets([]), 'No delivery')
})

test('summarize keeps invalid blank email targets invalid', () => {
    assert.equal(
        summarizeDeliveryTargets([{ type: 'email', to: ['   '] }]),
        'Invalid delivery targets',
    )
})

test('summarize formats mixed notification and email delivery', () => {
    assert.equal(
        summarizeDeliveryTargets([{ type: 'notification' }, { type: 'email', to: ['ops@example.com'] }]),
        'Notification + Email (ops@example.com)',
    )
})
