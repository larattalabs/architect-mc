package dev.larattalabs.architect.api;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.CompletableFuture;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import org.jspecify.annotations.Nullable;

/** The design library: bundled designs (in the jar) and the user's ({@code <gameDir>/architect/library/}). */
public interface Library {
	/** Every entry, sorted by id. Any thread. */
	List<Entry> list();

	Optional<Entry> get(String id);

	/** Reloads the library from disk (server thread; a no-op without a running server). */
	void reload();

	/**
	 * Makes a variant without Claude (the Library's Variants dialog): {@code variant.request} over the mod's sidecar link.
	 * Completes on the server thread with the new entry once it is installed and loaded; fails when the helper is not
	 * running, the source has no parametric source, or the build fails. {@code palette}: a preset name or
	 * {@code {wood?, stone?, roof?, accent?}}. Thread-safe.
	 */
	CompletableFuture<Entry> makeVariant(String entryId, @Nullable JsonElement palette, @Nullable JsonObject values, @Nullable String name);

	/** Moves a user entry to {@code architect/library-trash/} (as the UI does) and reloads. Bundled entries refuse (false). Thread-safe. */
	CompletableFuture<Boolean> delete(String entryId);

	/**
	 * Sets (or with null removes) one namespaced key ({@code "<modid>:<key>"}) of the entry's {@code ext}, in its blueprint JSON.
	 * Throws {@link IllegalArgumentException} for a bundled entry (read-only, in the jar), an unknown entry or a key without
	 * a namespace. Server thread.
	 */
	void setExt(String entryId, String key, @Nullable JsonElement value);

	/** Replaces the entry's user tags (normalised as the UI does: lower case, at most 12). Thread-safe. */
	void setTags(String entryId, List<String> userTags);

	/**
	 * A library entry.
	 *
	 * @param name the shown name (the user's display name when set)
	 * @param tags the design's tags plus the user's tags
	 * @param source the parametric source file name ({@code <id>.mjs}), absent for imports and hand-made templates
	 * @param ports named connectors (R5) in template coordinates (before rotation)
	 * @param ext namespaced extra data from the blueprint JSON (a copy)
	 */
	record Entry(String id, String name, String type, BlockSize size, List<String> tags, Optional<String> source, Map<String, JsonElement> params,
		Map<String, JsonElement> values, Optional<JsonObject> palette, Map<String, Port> ports, JsonObject ext, boolean bundled, boolean imported,
		Optional<String> variantOf) {
	}

	/**
	 * A named connector of a design (R5): {@code kind} is one of {@code item_out, item_in, water_in, water_out, redstone_in,
	 * redstone_out, bed, door} or {@code <modid>:<kind>}; {@code offset} is the cell in template coordinates, {@code facing}
	 * horizontal.
	 */
	record Port(String name, String kind, BlockPos offset, Direction facing) {
	}
}
