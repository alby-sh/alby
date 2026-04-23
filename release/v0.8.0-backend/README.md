# v0.8.0 backend package

Drop these files into the Laravel repo at `/home/alby.sh/web/alby.sh/public_html` on branch `error-tracking`, commit, then run `deploy.sh` in the Production tab of Alby.

## File-by-file paste list

| File in this folder | Target path in Laravel repo | What to do |
|---|---|---|
| `migrations/2026_04_23_000001_add_manual_issue_fields.php` | `database/migrations/2026_04_23_000001_add_manual_issue_fields.php` | **Copy whole file.** |
| `controllers/IssueController.store.php` | `app/Http/Controllers/Api/IssueController.php` | **Merge.** Paste the two methods (`store`, `mine`) into the existing controller. If an SDK-ingest `store` already exists with that name, rename this one to `storeManual` and update `routes.patch.php` accordingly. |
| `policies/IssuePolicy.patch.php` | `app/Policies/IssuePolicy.php` | **Merge.** Add `reportIssue` + `viewOwnReports` methods. Also tighten `view`/`update`/`delete` to deny `issuer` except for their own rows — see the comment block. |
| `payloads/IssueEventIngest.patch.php` | Wherever the SDK ingest controller writes `IssueEvent::create([...])` | **Merge.** Add the 3 new fields + the `extractUserContext()` helper. |
| `IssueModel.patch.php` | `app/Models/Issue.php` | **Merge.** Extend `$fillable` and add the `creator()` relation. |
| `routes.patch.php` | `routes/api.php` | **Merge.** Add the 2 new routes inside the `auth:sanctum` group that already hosts issue routes. |

## Role enum

Wherever the `team_members.role` / `project_members.role` enum/string is validated (Form Request or model `$casts`), add `'issuer'` to the accepted values. No migration needed if the column is a `string` — just update the validator.

## Deploy

After everything is committed to `error-tracking`:

```bash
# From your laptop / another terminal
git push origin error-tracking
```

Then, in **Alby → Production env tab**, run:

```bash
bash /home/alby.sh/web/alby.sh/public_html/release/v0.8.0-backend/deploy.sh
```

(or paste the contents of `deploy.sh` directly if you'd rather not commit it.)

## Verify

1. `curl -H "Authorization: Bearer YOUR_TOKEN" https://alby.sh/api/issues/mine` → JSON with empty data array.
2. `curl -H "Authorization: Bearer YOUR_TOKEN" -XPOST -d '{"title":"test"}' -H "Content-Type: application/json" https://alby.sh/api/apps/APP_ID/issues` → the new issue row.
3. In the Alby client v0.8.0: log in, open any project → Issues → click "Report issue" → should submit and appear in the list with a source=manual badge.
4. In the Laravel users table, set a test user's role to `'issuer'` on some team → log in with them in Alby → you should see only the minimal "Report issue" shell.

## Rollback

```bash
php artisan migrate:rollback --path=database/migrations/2026_04_23_000001_add_manual_issue_fields.php
git revert <commit-sha>
```

The client degrades gracefully — if the backend is pre-v0.8.0, the Report-issue button still shows but clicking returns a 404 the dialog surfaces as an error. Issues keep displaying; they just don't have `source` / `creator` fields so the filter tabs treat everything as "All" and the Reported-by panel hides.
