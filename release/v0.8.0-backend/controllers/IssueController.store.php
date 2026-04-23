<?php
/**
 * Paste this block into app/Http/Controllers/Api/IssueController.php
 * (or wherever the existing issue endpoints live). It adds two public
 * methods — `store` and `mine` — and assumes the following usual things:
 *
 *   use App\Models\Issue;
 *   use App\Models\ReportingApp;
 *   use Illuminate\Http\Request;
 *   use Illuminate\Support\Facades\Auth;
 *   use Illuminate\Support\Str;
 *
 * If the controller already has a `store()` method (creating SDK issues?),
 * rename this one to `storeManual()` and point the route at it instead.
 */

/**
 * POST /api/apps/{app}/issues  — manual issue creation.
 *
 * Body:
 *   title        string required, 1..255
 *   description  string optional, nullable, up to 10000 chars
 *   level        enum optional, one of debug|info|warning|error|fatal, default 'error'
 *
 * The server stamps:
 *   source              = 'manual'
 *   created_by_user_id  = auth()->id()
 *   fingerprint         = 'manual:' . sha1(title)  // dedup per-app on title
 *   status              = 'open'
 *   first_seen_at       = now()
 *   last_seen_at        = now()
 *   occurrences_count   = 1  (incremented on each re-submit of a matching title)
 */
public function store(Request $request, ReportingApp $app)
{
    $this->authorize('reportIssue', $app);

    $data = $request->validate([
        'title'       => ['required', 'string', 'min:1', 'max:255'],
        'description' => ['nullable', 'string', 'max:10000'],
        'level'       => ['nullable', 'string', 'in:debug,info,warning,error,fatal'],
    ]);

    $fingerprint = 'manual:' . sha1(trim($data['title']));

    // "Reopen / bump occurrences" on exact-title repeat — the same feedback
    // channel used by SDK fingerprint dedup, just with a different key.
    $issue = Issue::firstOrNew([
        'app_id'      => $app->id,
        'fingerprint' => $fingerprint,
    ]);

    $isNew = ! $issue->exists;

    $issue->fill([
        'title'              => $data['title'],
        'description'        => $data['description'] ?? null,
        'level'              => $data['level'] ?? 'error',
        'source'             => 'manual',
        'status'             => 'open',
        'created_by_user_id' => Auth::id(),
        'last_seen_at'       => now(),
    ]);
    if ($isNew) {
        $issue->id = $issue->id ?: (string) Str::uuid();
        $issue->first_seen_at = now();
        $issue->occurrences_count = 1;
    } else {
        $issue->occurrences_count = ($issue->occurrences_count ?? 0) + 1;
    }
    $issue->save();

    // Load the creator so the UI can render avatar+name+email without a
    // second round-trip. `creator` is the belongsTo relation on the model.
    $issue->load('creator:id,name,email,avatar_url');

    // Broadcast on the project channel so other clients' sidebars update
    // in real time. Uses the existing entity.changed convention so we
    // don't need a new Reverb event class.
    broadcast(new \App\Events\EntityChanged(
        projectId: $app->project_id,
        entity: 'issue',
        id: $issue->id,
    ))->toOthers();

    return response()->json($issue, $isNew ? 201 : 200);
}

/**
 * GET /api/issues/mine?page=N&per_page=M
 *
 * Lists issues the caller manually reported, newest first. Lives outside
 * the per-app route because an issuer typically spans several apps in
 * the same team — they want one list, not N.
 */
public function mine(Request $request)
{
    $perPage = min(100, max(10, (int) $request->query('per_page', 50)));

    return Issue::query()
        ->where('created_by_user_id', Auth::id())
        ->orderByDesc('last_seen_at')
        ->with('creator:id,name,email,avatar_url')
        ->paginate($perPage)
        ->toResourceCollection();
}
