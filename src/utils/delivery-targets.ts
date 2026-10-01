export type DeliveryTarget =
    | { type: 'none' }
    | { type: 'notification' }
    | { type: 'email'; to: string[] }

export interface DeliveryValidationPayload {
    valid: boolean
    errors: string[]
    value: DeliveryTarget[]
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function normalizeRecipients(input: string[]): string[] {
    const seen = new Set<string>()
    const recipients: string[] = []

    for (const rawRecipient of input) {
        const recipient = rawRecipient.trim()
        if (!recipient || seen.has(recipient)) {
            continue
        }
        seen.add(recipient)
        recipients.push(recipient)
    }

    return recipients
}

export function defaultCronDeliveryTargets(): DeliveryTarget[] {
    return []
}

export function sanitizeDeliveryTargets(input: DeliveryTarget[]): DeliveryTarget[] {
    let hasNone = false
    let hasNotification = false
    const emailRecipients: string[] = []

    for (const target of input || []) {
        if (!target || typeof target !== 'object' || typeof target.type !== 'string') {
            continue
        }

        if (target.type === 'none') {
            hasNone = true
            continue
        }

        if (target.type === 'notification') {
            hasNotification = true
            continue
        }

        if (target.type === 'email') {
            for (const recipient of normalizeRecipients(Array.isArray(target.to) ? target.to : [])) {
                emailRecipients.push(recipient)
            }
        }
    }

    const uniqueEmailRecipients = normalizeRecipients(emailRecipients)
    const sanitized: DeliveryTarget[] = []

    if (hasNone) {
        sanitized.push({ type: 'none' })
    }
    if (hasNotification) {
        sanitized.push({ type: 'notification' })
    }
    if (uniqueEmailRecipients.length > 0) {
        sanitized.push({ type: 'email', to: uniqueEmailRecipients })
    }

    return sanitized
}

export function validateDeliveryTargets(input: DeliveryTarget[]): string[] {
    const errors: string[] = []
    const sanitized = sanitizeDeliveryTargets(input)
    const hasNone = sanitized.some(target => target.type === 'none')
    const emailTargets = (input || []).filter((target): target is Extract<DeliveryTarget, { type: 'email' }> => target?.type === 'email')

    if (hasNone && sanitized.length > 1) {
        errors.push('No delivery must be used by itself')
    }

    for (const target of emailTargets) {
        const recipients = normalizeRecipients(Array.isArray(target.to) ? target.to : [])
        if (recipients.length === 0) {
            errors.push('Email delivery requires at least one recipient')
            continue
        }

        for (const recipient of recipients) {
            if (!EMAIL_PATTERN.test(recipient)) {
                errors.push(`Invalid email recipient: ${recipient}`)
            }
        }
    }

    return [...new Set(errors)]
}

export function summarizeDeliveryTargets(input: DeliveryTarget[]): string {
    if (!input || input.length === 0) {
        return 'No delivery'
    }

    const sanitized = sanitizeDeliveryTargets(input)
    const errors = validateDeliveryTargets(input)

    if (errors.length > 0) {
        return 'Invalid delivery targets'
    }

    if (sanitized.length === 0) {
        return 'No delivery'
    }

    return sanitized.map(target => {
        if (target.type === 'none') {
            return 'No delivery'
        }
        if (target.type === 'notification') {
            return 'Notification'
        }
        return `Email (${target.to.join(', ')})`
    }).join(' + ')
}

export function buildDeliveryValidationPayload(input: DeliveryTarget[]): DeliveryValidationPayload {
    const sanitized = sanitizeDeliveryTargets(input)
    const errors = validateDeliveryTargets(input)
    const value = sanitized.length === 1 && sanitized[0]?.type === 'none'
        ? []
        : sanitized

    return {
        valid: errors.length === 0,
        errors,
        value,
    }
}
