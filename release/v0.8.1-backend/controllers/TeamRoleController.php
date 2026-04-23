<?php
/**
 * Paste into app/Http/Controllers/Api/TeamRoleController.php (new file).
 * Then wire it from routes/api.php — see routes.patch.php.
 *
 * Assumes:
 *   - TeamRole model with $fillable ['team_id','slug','name','description','capabilities','is_builtin']
 *     and $casts ['capabilities' => 'array', 'is_builtin' => 'boolean']
 *   - Team model has `roles()` hasMany relation
 *   - Policy gate: can('manage_roles', $team) — admin/owner or any custom
 *     role holding the 'manage_roles' capability
 */

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\Team;
use App\Models\TeamRole;
use Illuminate\Http\Request;
use Illuminate\Support\Str;
use Illuminate\Validation\Rule;

class TeamRoleController extends Controller
{
    /** All known capability slugs — server-side source of truth. Anything
     *  not in this list gets 422'd so custom roles can't grant fictional
     *  permissions the policies don't know about. Keep in sync with the
     *  renderer's WorkspaceCapability union. */
    private const KNOWN_CAPS = [
        'launch_agents', 'edit_projects', 'see_reports', 'manage_workspace',
        'report_issue', 'view_issues', 'resolve_issues', 'run_deploy',
        'manage_routines', 'manage_roles',
    ];

    public function index(Team $team)
    {
        $this->authorize('view', $team);
        return $team->roles()->orderBy('is_builtin', 'desc')->orderBy('name')->get();
    }

    public function store(Request $request, Team $team)
    {
        $this->authorize('manageRoles', $team);

        $data = $request->validate([
            'slug'          => ['required', 'string', 'regex:/^[a-z0-9][a-z0-9-]{0,39}$/'],
            'name'          => ['required', 'string', 'max:60'],
            'description'   => ['nullable', 'string', 'max:255'],
            'capabilities'  => ['required', 'array'],
            'capabilities.*' => ['string', Rule::in(self::KNOWN_CAPS)],
        ]);

        // Prevent collision with an existing slug (builtin or custom).
        if ($team->roles()->where('slug', $data['slug'])->exists()) {
            return response()->json(['message' => 'A role with that slug already exists.'], 422);
        }

        $role = $team->roles()->create([
            'id'           => (string) Str::uuid(),
            'slug'         => $data['slug'],
            'name'         => $data['name'],
            'description'  => $data['description'] ?? null,
            'capabilities' => array_values(array_unique($data['capabilities'])),
            'is_builtin'   => false,
        ]);

        broadcast(new \App\Events\EntityChanged(
            projectId: null, teamId: $team->id, entity: 'team_role', id: $role->id,
        ))->toOthers();

        return response()->json($role, 201);
    }

    public function update(Request $request, Team $team, TeamRole $role)
    {
        $this->authorize('manageRoles', $team);
        abort_unless($role->team_id === $team->id, 404);

        $data = $request->validate([
            'name'          => ['sometimes', 'string', 'max:60'],
            'description'   => ['sometimes', 'nullable', 'string', 'max:255'],
            'capabilities'  => ['sometimes', 'array'],
            'capabilities.*' => ['string', Rule::in(self::KNOWN_CAPS)],
        ]);

        // Builtins: only name + description are mutable; capabilities are
        // locked (the matrix is part of Alby's policy surface).
        if ($role->is_builtin && array_key_exists('capabilities', $data)) {
            return response()->json(['message' => 'Built-in role capabilities cannot be edited.'], 422);
        }

        if (isset($data['name']))         $role->name = $data['name'];
        if (array_key_exists('description', $data)) $role->description = $data['description'];
        if (isset($data['capabilities'])) $role->capabilities = array_values(array_unique($data['capabilities']));
        $role->save();

        broadcast(new \App\Events\EntityChanged(
            projectId: null, teamId: $team->id, entity: 'team_role', id: $role->id,
        ))->toOthers();

        return $role->fresh();
    }

    public function destroy(Request $request, Team $team, TeamRole $role)
    {
        $this->authorize('manageRoles', $team);
        abort_unless($role->team_id === $team->id, 404);
        abort_if($role->is_builtin, 422, 'Built-in roles cannot be deleted.');

        // Reassign members holding this role to a safe default BEFORE the
        // delete, atomically. Fallback to 'viewer' if the requested target
        // doesn't exist (e.g. the admin typo'd the query string).
        $reassignTo = $request->query('reassign_to', 'viewer');
        $target = $team->roles()->where('slug', $reassignTo)->first()
               ?? $team->roles()->where('slug', 'viewer')->first();
        if (! $target) return response()->json(['message' => 'No safe role to reassign to.'], 422);

        \DB::transaction(function () use ($team, $role, $target) {
            \DB::table('team_members')
                ->where('team_id', $team->id)
                ->where('role', $role->slug)
                ->update(['role' => $target->slug, 'updated_at' => now()]);
            $role->delete();
        });

        broadcast(new \App\Events\EntityChanged(
            projectId: null, teamId: $team->id, entity: 'team_role', id: $role->id,
        ))->toOthers();

        return response()->noContent();
    }
}
