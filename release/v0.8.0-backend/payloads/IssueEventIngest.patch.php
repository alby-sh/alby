<?php
/**
 * Add to the ingest endpoint handler (the one that receives payloads from
 * the @alby-sh/report SDK — usually something like IssueEventController@store
 * at POST /ingest/v1/{public_key} or /api/events).
 *
 * Three lines right before you call IssueEvent::create([...]):
 */

$event = IssueEvent::create([
    // ... existing fields ...

    // v0.8.0 — reporter attribution for the UI's "Reported by" panel.
    'ip'           => $request->ip(),
    'user_agent'   => $request->userAgent(),
    'user_context' => $this->extractUserContext($payload),
]);

/**
 * Helper to pull the SDK-provided end-user identity out of the payload.
 * The @alby-sh/report SDK mirrors Sentry's convention:
 *
 *   Alby.setUser({ id, email, username })
 *
 * which travels inside the event payload as `user: { id, email, username }`.
 * We accept either `user_context` (the explicit key we added) or `user`
 * (for SDKs that follow Sentry's convention) so downstream integrations
 * keep working without a breaking change.
 */
private function extractUserContext(array $payload): ?array
{
    $candidate = $payload['user_context'] ?? $payload['user'] ?? null;
    if (! is_array($candidate)) return null;
    $ctx = [];
    foreach (['id', 'email', 'username'] as $k) {
        if (isset($candidate[$k]) && is_scalar($candidate[$k])) {
            $ctx[$k] = (string) $candidate[$k];
        }
    }
    return $ctx === [] ? null : $ctx;
}
