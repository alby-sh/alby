<?php
/**
 * Additions to app/Models/Issue.php — merge with the existing model.
 */

use Illuminate\Database\Eloquent\Relations\BelongsTo;

// Inside the `$fillable` array, add:
//   'source', 'description', 'created_by_user_id'

// Inside `$casts`, make sure source is 'string' and occurrences_count is 'int'.

/**
 * The user who filed this manually. Null for SDK-captured issues.
 * Eager-loaded by IssueController@store + @index + @show + @mine so the
 * client can render a "Reported by <avatar> <name>" panel without a
 * second round-trip.
 */
public function creator(): BelongsTo
{
    return $this->belongsTo(User::class, 'created_by_user_id');
}
