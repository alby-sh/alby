<?php
/**
 * Additions to app/Policies/IssuePolicy.php — paste these two methods
 * alongside the existing view/update/delete ones.
 *
 * Role matrix for v0.8.0:
 *
 *                      view  update  delete  reportIssue  viewOwnReports
 *   owner              ✓     ✓       ✓       ✓            ✓
 *   admin              ✓     ✓       ✓       ✓            ✓
 *   developer/member   ✓     ✓       ✓       ✓            ✓
 *   viewer             ✓     ✗       ✗       ✓            ✓
 *   analyst            ✓     ✗       ✗       ✗            ✓
 *   issuer             ✗     ✗       ✗       ✓ (only)     ✓ (own only)
 *
 * NOTE: Also update AppPolicy / TeamPolicy / ProjectPolicy to return
 * false for `issuer` on every other capability. The `User::rolesInScope()`
 * / equivalent helper must include 'issuer' in the recognised roles.
 */

use App\Models\User;
use App\Models\Issue;
use App\Models\ReportingApp;

/**
 * Can this user submit a NEW manual issue against the given app?
 * Everyone with any role on the containing team/project can, including
 * the restricted 'issuer' role — this is literally the only thing an
 * issuer is allowed to do.
 */
public function reportIssue(User $user, ReportingApp $app): bool
{
    $role = $user->roleForApp($app); // owner|admin|developer|member|viewer|analyst|issuer|null
    return in_array($role, ['owner', 'admin', 'developer', 'member', 'viewer', 'issuer'], true);
}

/**
 * Viewing one's own reported issues is allowed for every role. For an
 * 'issuer', this is paired with a gate at the list endpoint scoping the
 * query to `created_by_user_id = auth()->id()` so they never see other
 * people's reports.
 */
public function viewOwnReports(User $user): bool
{
    return $user !== null;
}

/**
 * Override existing `view`/`update`/`delete` to explicitly deny 'issuer':
 *
 *   public function view(User $user, Issue $issue): bool
 *   {
 *       $role = $user->roleForApp($issue->app);
 *       if ($role === 'issuer') {
 *           return $issue->created_by_user_id === $user->id;
 *       }
 *       return in_array($role, ['owner','admin','developer','member','viewer','analyst'], true);
 *   }
 */
