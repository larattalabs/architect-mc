package dev.larattalabs.architect.api;

import com.google.gson.JsonObject;
import java.util.List;
import java.util.Optional;
import org.jspecify.annotations.Nullable;

/**
 * A queued batch as the API sees it (a snapshot). Since 1.4.0.
 *
 * @param group the site group its sites join (always set: a batch without one gets a new group)
 * @param stages the names of the stages this batch added to its group, in order
 * @param createdAt when it was queued (ms); {@code doneAt} when it ended (absent while running)
 * @param opKey (since 1.10.0) the caller's operation key ({@link Batch#opKey}), if it was queued with one
 */
public record BatchView(String id, @Nullable String owner, JsonObject ext, String group, Status status, List<ItemView> items, List<String> stages,
	long createdAt, Optional<Long> doneAt, Optional<String> opKey) {
	public BatchView {
		ext = ext == null ? new JsonObject() : ext;
		items = List.copyOf(items);
		stages = List.copyOf(stages);
		opKey = opKey == null ? Optional.empty() : opKey;
	}

	/** The 1.4.0 constructor (no opKey). */
	public BatchView(String id, @Nullable String owner, JsonObject ext, String group, Status status, List<ItemView> items, List<String> stages,
		long createdAt, Optional<Long> doneAt) {
		this(id, owner, ext, group, status, items, stages, createdAt, doneAt, Optional.empty());
	}

	/** {@code RUNNING}; then {@code DONE} (every item placed or failed), {@code CANCELLED} ({@link Sites#cancelBatch}) or {@code STOPPED} (stopOnFailure). */
	public enum Status {
		RUNNING, DONE, CANCELLED, STOPPED
	}

	/** An item's progress: QUEUED, WAITING (a temporary blocker), PLACING (its cells are being written), PLACED or FAILED. */
	public enum ItemStatus {
		QUEUED, WAITING, PLACING, PLACED, FAILED
	}

	/**
	 * One item.
	 *
	 * @param stage its stage's name
	 * @param mode INSTANT or CONSTRUCTION, resolved when the batch was queued
	 * @param siteId the site, once placing has started
	 * @param reason why it waits or failed
	 * @param ext its merged ext (the batch's, then the item's)
	 */
	public record ItemView(String itemKey, String stage, ItemStatus status, Mode mode, Optional<String> siteId, Optional<Reason> reason, String message,
		JsonObject ext) {
		public ItemView {
			ext = ext == null ? new JsonObject() : ext;
			message = message == null ? "" : message;
		}
	}

	public long count(ItemStatus s) {
		return items.stream().filter(i -> i.status() == s).count();
	}

	public boolean running() {
		return status == Status.RUNNING;
	}
}
