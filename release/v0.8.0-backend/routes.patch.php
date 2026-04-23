<?php
/**
 * Add to routes/api.php — inside the same auth:sanctum group as the
 * existing issue routes.
 *
 * The manual-create route matches the Electron client's cloudClient.createIssue.
 * The mine route must be BEFORE the `issues/{issue}` catch-all, otherwise
 * Laravel route-binding tries to load an Issue with id='mine'.
 */

// v0.8.0 — manual issue creation + "my reports" list.
Route::post('apps/{app}/issues', [IssueController::class, 'store']);
Route::get('issues/mine', [IssueController::class, 'mine']);
