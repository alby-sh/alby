<?php
/**
 * Additions to app/Policies/TeamPolicy.php.
 *
 * Introduces a `manageRoles` gate that checks the user's effective
 * capabilities (union of their team_role.capabilities) rather than a
 * hard-coded role match. This is the pattern to follow for all other
 * policies in v0.8.1 — swap `role === 'admin'` checks for
 * `hasCapability('xxx', $team)` lookups via the User model helper below.
 */

use App\Models\User;
use App\Models\Team;

/**
 * Anyone with the `manage_roles` capability on this team. By default
 * that's owner + admin (from the builtin seed), but a custom role
 * could also grant it. Ownership transfer stays a separate action.
 */
public function manageRoles(User $user, Team $team): bool
{
    return $user->hasCapabilityOnTeam('manage_roles', $team);
}

/**
 * Place this on app/Models/User.php. Resolves the caller's role slug
 * on $team, loads its capability list from team_roles, and returns
 * whether $cap is in the list.
 *
 * Returns false if the user is not a member of $team.
 *
 *   public function hasCapabilityOnTeam(string $cap, Team $team): bool
 *   {
 *       $slug = $team->members()
 *           ->where('users.id', $this->id)
 *           ->value('team_members.role');
 *       if (! $slug) return false;
 *
 *       $caps = $team->roles()
 *           ->where('slug', $slug)
 *           ->value('capabilities') ?? [];
 *
 *       return in_array($cap, is_array($caps) ? $caps : json_decode($caps, true) ?? [], true);
 *   }
 *
 * Member-role validation on PATCH /api/teams/{team}/members/{user}/role
 * must check the new slug exists in $team->roles:
 *
 *   $request->validate([
 *       'role' => ['required', 'string', Rule::exists('team_roles', 'slug')
 *           ->where('team_id', $team->id)],
 *   ]);
 */
