<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

/**
 * v0.8.1 — Custom team roles (Model B).
 *
 * Creates `team_roles` with a JSON capabilities list. Every team gets the
 * 7 builtin roles (owner/admin/developer/viewer/analyst/member/issuer)
 * seeded so the existing `team_members.role` strings still resolve, and
 * so a fresh team's admin can build on top of them.
 *
 * `team_members.role` stays a plain string: it references `team_roles.slug`
 * within the same team. Validation is enforced at the controller level
 * (Form Request looks up the slug in the team's roles table on update).
 *
 * This migration is IDEMPOTENT on reseed — if a builtin row is already
 * present for a team we just update its capabilities list so the matrix
 * stays in sync across app versions.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('team_roles', function (Blueprint $t) {
            $t->uuid('id')->primary();
            $t->foreignId('team_id')->constrained('teams')->cascadeOnDelete();
            $t->string('slug', 40);
            $t->string('name', 60);
            $t->string('description', 255)->nullable();
            $t->json('capabilities');
            $t->boolean('is_builtin')->default(false);
            $t->timestamps();
            $t->unique(['team_id', 'slug']);
        });

        $builtins = [
            ['owner',     'Owner',     'Full access to everything in the team.',
                ['launch_agents','edit_projects','see_reports','manage_workspace','report_issue','view_issues','resolve_issues','run_deploy','manage_routines','manage_roles']],
            ['admin',     'Admin',     'All capabilities except ownership transfer.',
                ['launch_agents','edit_projects','see_reports','manage_workspace','report_issue','view_issues','resolve_issues','run_deploy','manage_routines','manage_roles']],
            ['developer', 'Developer', 'Build, ship, and fix. No team / billing / role management.',
                ['launch_agents','edit_projects','see_reports','report_issue','view_issues','resolve_issues','run_deploy','manage_routines']],
            ['viewer',    'Viewer',    'Read-only, can file manual issue reports.',
                ['see_reports','report_issue','view_issues']],
            ['analyst',   'Analyst',   'Reports and issues, read-only.',
                ['see_reports','view_issues']],
            ['member',    'Member',    'Alias of developer for legacy teams.',
                ['launch_agents','edit_projects','see_reports','report_issue','view_issues','resolve_issues','run_deploy','manage_routines']],
            ['issuer',    'Issuer',    'Can ONLY submit new manual issue reports.',
                ['report_issue']],
        ];

        foreach (DB::table('teams')->select('id')->get() as $team) {
            foreach ($builtins as [$slug, $name, $desc, $caps]) {
                DB::table('team_roles')->updateOrInsert(
                    ['team_id' => $team->id, 'slug' => $slug],
                    [
                        'id'           => (string) Str::uuid(),
                        'name'         => $name,
                        'description'  => $desc,
                        'capabilities' => json_encode($caps),
                        'is_builtin'   => true,
                        'updated_at'   => now(),
                        'created_at'   => now(),
                    ],
                );
            }
        }
    }

    public function down(): void
    {
        Schema::dropIfExists('team_roles');
    }
};
