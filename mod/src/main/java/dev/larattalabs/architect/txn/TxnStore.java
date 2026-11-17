package dev.larattalabs.architect.txn;

import com.google.gson.JsonObject;
import dev.larattalabs.architect.site.DurableFile;

/**
 * (slice T1, docs/TXN-DESIGN.md §3.2) Where {@code txn.json} is written: a whole-file confirmed write ({@link DurableFile} in game, the
 * model's versioned store in {@code TxnCrashModel}). OK means durable; REFUSED means nothing was installed; IN_DOUBT means it may be
 * installed and is held, never read as not written.
 */
public interface TxnStore {
	DurableFile.Outcome write(JsonObject doc);

	/** Retries the forces of an IN_DOUBT (or loaded, unconfirmed) installation; OK makes it durable. */
	DurableFile.Outcome confirm();

	/** Whether the installed file is not known durable (an IN_DOUBT write, or a load whose re-force did not return). */
	boolean inDoubt();
}
