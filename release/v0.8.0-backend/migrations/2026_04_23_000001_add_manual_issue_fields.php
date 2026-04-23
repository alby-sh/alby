<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;
use Illuminate\Support\Facades\DB;

/**
 * v0.8.0 — Manual issue creation + Issuer role.
 *
 * Adds the three columns the Electron client v0.8.0 expects:
 *
 *   issues.source                   → 'sdk' | 'manual', default 'sdk'
 *   issues.description              → nullable text, the manual reporter's prose
 *   issues.created_by_user_id       → nullable FK to users, set on manual creation
 *
 *   issue_events.ip                 → remote IP captured on ingest
 *   issue_events.user_agent         → User-Agent header captured on ingest
 *   issue_events.user_context       → JSON, SDK-provided end-user identity
 *
 * Also widens the `role` column on team_members + project_members to accept
 * the new 'issuer' value. The column is a varchar with app-level validation
 * so we don't need an ALTER TYPE — just update the check constraint if one
 * exists (MySQL doesn't enforce enums strictly when running through the
 * Laravel enum cast, so this is mostly documentation).
 *
 * Backfill: legacy rows get `source='sdk'` (already the default). IP and
 * user_agent are left NULL for events that predate this migration — the
 * UI handles that case by showing "—".
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('issues', function (Blueprint $t) {
            $t->string('source', 16)->default('sdk')->index()->after('fingerprint');
            $t->text('description')->nullable()->after('culprit');
            $t->unsignedBigInteger('created_by_user_id')->nullable()->after('description');
            $t->foreign('created_by_user_id')->references('id')->on('users')->nullOnDelete();
        });

        Schema::table('issue_events', function (Blueprint $t) {
            $t->string('ip', 64)->nullable()->after('received_at');
            $t->string('user_agent', 500)->nullable()->after('ip');
            $t->json('user_context')->nullable()->after('user_agent');
        });

        // Explicitly stamp existing rows so the frontend can trust the field.
        DB::table('issues')->whereNull('source')->update(['source' => 'sdk']);
    }

    public function down(): void
    {
        Schema::table('issues', function (Blueprint $t) {
            $t->dropForeign(['created_by_user_id']);
            $t->dropColumn(['source', 'description', 'created_by_user_id']);
        });
        Schema::table('issue_events', function (Blueprint $t) {
            $t->dropColumn(['ip', 'user_agent', 'user_context']);
        });
    }
};
