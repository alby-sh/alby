<?php
/**
 * Add to routes/api.php inside the auth:sanctum group that already
 * hosts the team endpoints.
 */

use App\Http\Controllers\Api\TeamRoleController;

// v0.8.1 — custom team roles.
Route::get   ('teams/{team}/roles',          [TeamRoleController::class, 'index']);
Route::post  ('teams/{team}/roles',          [TeamRoleController::class, 'store']);
Route::patch ('teams/{team}/roles/{role}',   [TeamRoleController::class, 'update']);
Route::delete('teams/{team}/roles/{role}',   [TeamRoleController::class, 'destroy']);

/**
 * ALSO: update the existing /api/me response (usually AuthController@me
 * or UserResource) to embed `roles` on each team:
 *
 *   'teams' => $user->teams->map(fn($t) => [
 *       'id' => $t->id,
 *       'name' => $t->name,
 *       // ...
 *       'role' => $t->pivot->role,
 *       'roles' => $t->roles()->orderBy('is_builtin','desc')->get(), // <-- new
 *   ])->values(),
 *
 * Without this the renderer keeps falling back to the hard-coded
 * builtin capability matrix and custom roles silently act like 'viewer'.
 */
