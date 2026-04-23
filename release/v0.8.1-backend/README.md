# v0.8.1 backend package — Custom team roles

## File-by-file paste list

| File here | Target | Action |
|---|---|---|
| `migrations/2026_04_23_000002_create_team_roles.php` | `database/migrations/` | **Copy.** Seeds 7 builtin roles for every existing team on migrate. |
| `controllers/TeamRoleController.php` | `app/Http/Controllers/Api/TeamRoleController.php` | **Copy new file.** |
| `policies/TeamPolicy.patch.php` | `app/Policies/TeamPolicy.php` + `app/Models/User.php` | **Merge.** Adds `manageRoles` gate + `hasCapabilityOnTeam()` helper on User. |
| `routes.patch.php` | `routes/api.php` + `AuthController@me` / UserResource | **Merge.** New routes + embed `roles` on `/api/me` response. |

## Model

Create `app/Models/TeamRole.php` if it doesn't exist:

```php
<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Str;

class TeamRole extends Model
{
    public $incrementing = false;
    protected $keyType = 'string';
    protected $fillable = ['id', 'team_id', 'slug', 'name', 'description', 'capabilities', 'is_builtin'];
    protected $casts = ['capabilities' => 'array', 'is_builtin' => 'boolean'];

    protected static function booted(): void
    {
        static::creating(function ($r) { $r->id = $r->id ?: (string) Str::uuid(); });
    }
}
```

And add to `app/Models/Team.php`:

```php
public function roles()
{
    return $this->hasMany(TeamRole::class);
}
```

## Member-role validation

In the Form Request (or inline in `TeamController@updateMemberRole`), replace the hardcoded enum with a team-scoped Rule:

```php
use Illuminate\Validation\Rule;

$request->validate([
    'role' => ['required', 'string', Rule::exists('team_roles', 'slug')
        ->where('team_id', $team->id)],
]);
```

## Existing policies — migrate to capability checks

For v0.8.1 to actually respect custom roles, the existing policies must stop doing `if ($role === 'admin')` and start doing `if ($user->hasCapabilityOnTeam('xxx', $team))`. Minimum set to update:

- `AgentPolicy@launch` → `launch_agents`
- `DeployPolicy@run` → `run_deploy`
- `IssuePolicy@update/delete` → `resolve_issues`
- `IssuePolicy@reportIssue` → `report_issue` (already added in v0.8.0)
- `ProjectPolicy@update` → `edit_projects`
- `RoutinePolicy@*` → `manage_routines`
- `TeamPolicy@manage` → `manage_workspace`
- `TeamPolicy@manageRoles` → `manage_roles` (new, added here)

Roles that already existed before v0.8.1 keep working because the seed in the migration loads identical capability lists into the builtin rows.

## Deploy

```bash
# From your laptop after committing the patches
git push origin error-tracking
```

Then in Alby → Production env tab:

```bash
bash /home/alby.sh/web/alby.sh/public_html/release/v0.8.1-backend/deploy.sh
```

## Verify

```bash
curl -H 'Authorization: Bearer TOKEN' https://alby.sh/api/teams/TEAM_ID/roles
# → JSON array with 7 builtin roles

curl -H 'Authorization: Bearer TOKEN' https://alby.sh/api/me
# → teams[i].roles populated, same shape
```

In Alby → Team Settings, you should see:
- Every member row has a role dropdown (except owner)
- A new "Roles" section lists 7 builtins + a "New role" button
- Creating a "QA Lead" with just `report_issue` + `view_issues` and assigning a member to it makes their Alby client boot as an IssuerShell-like minimal view (since isIssuerOnly = size===1 && report_issue detection still triggers when caps differ but — TODO double-check on the client).
