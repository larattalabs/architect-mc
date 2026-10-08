package dev.larattalabs.architect.api;

import com.google.gson.JsonObject;
import java.util.List;
import org.jspecify.annotations.Nullable;

/**
 * A polish of an installed entry (docs/CONTRACT.md phase 5b "Polish"): a critique, then up to {@code maxSteps} (1-3) targeted
 * revision steps, each confined to the parts its issue names, and at most one new version. {@code fromVersion} null = the head;
 * {@code issues}: the critique's issue indexes to target, in order (null: the highest-priority issue that names a part);
 * {@code parts} and {@code notes}: a caller's own target (notes without parts run a scoping call first, which may decline a
 * whole-look or structural request); {@code model} null = the entry's designer model; {@code budgetUsd} null = the default
 * caps; {@code apply}: what happens to the placed sites. Since 1.7.0.
 */
public record PolishRequest(String entryId, @Nullable Integer fromVersion, @Nullable List<Integer> issues, @Nullable List<String> parts,
	@Nullable String notes, int maxSteps, @Nullable String model, @Nullable Double budgetUsd, @Nullable String owner, JsonObject ext,
	@Nullable PolishApply apply) {
	public PolishRequest {
		issues = issues == null ? null : List.copyOf(issues);
		parts = parts == null ? null : List.copyOf(parts);
		maxSteps = maxSteps <= 0 ? 2 : Math.min(3, maxSteps);
		ext = ext == null ? new JsonObject() : ext.deepCopy();
	}

	/** The default polish of an entry's head (2 steps). */
	public PolishRequest(String entryId) {
		this(entryId, null, null, null, null, 2, null, null, null, new JsonObject(), null);
	}

	@Override
	public JsonObject ext() {
		return ext.deepCopy();
	}
}
