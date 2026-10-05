package dev.larattalabs.architect.site;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.Registries;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.block.Rotation;
import net.minecraft.world.level.levelgen.structure.templatesystem.StructureTemplate;
import org.jspecify.annotations.Nullable;

/**
 * A site's snapshot put back over ticks (docs/CONTRACT.md phase 4d): the same writes as {@code Sites.restoreTemplate} (the
 * snapshot placed with {@link TemplateWriter}), then the rest of a removal. Two purposes:
 * <ul>
 * <li>{@code rollback}: a site still placing is cancelled ({@code cancelBatch}, a broken job); it was never placed, so no
 * SITE_REMOVED fires;</li>
 * <li>{@code remove}: an instant site of a group or stage being undone; SITE_REMOVED fires.</li>
 * </ul>
 * Persisted by purpose and site only: after a load it starts over (writing a snapshot again is idempotent).
 */
final class RestoreJob implements Placement.Job {
	static final String ROLLBACK = "rollback";
	static final String REMOVE = "remove";

	final String siteId;
	final String purpose;
	final @Nullable String batchId;
	final @Nullable String itemKey;
	final List<TickDeferral.Held> held = new ArrayList<>();
	@Nullable TemplateWriter writer;
	/** The snapshot being restored (its leaf ring is applied at the end). */
	@Nullable CompoundTag tag;
	@Nullable List<String> dropsBefore;
	@Nullable String broken;
	boolean done;
	/** Why a rollback happens (the item's ITEM_FAILED message). */
	String why = "";
	/** A rollback after a crash: the item is queued again once its box is restored. */
	boolean requeue;
	/** What the finished removal gave back (a remove's refunds are empty: instant sites only). */
	Sites.@Nullable Removed result;

	RestoreJob(String siteId, String purpose, @Nullable String batchId, @Nullable String itemKey) {
		this.siteId = siteId;
		this.purpose = purpose;
		this.batchId = batchId;
		this.itemKey = itemKey;
	}

	@Override
	public String siteId() {
		return siteId;
	}

	@Override
	public @Nullable String batchId() {
		return batchId;
	}

	@Override
	public String kind() {
		return purpose;
	}

	@Override
	public boolean step(MinecraftServer server, long deadline) {
		Site s = Sites.get(siteId);
		ServerLevel level = s == null ? null : Sites.levelOf(server, s);
		if (s == null || level == null) {
			broken = s == null ? "no site " + siteId : s.dimension() + " is not loaded";
			return true;
		}
		if (writer == null) {
			try {
				tag = Sites.readSnapshot(s.snapshot());
			} catch (IOException | RuntimeException e) {
				broken = "the saved terrain of " + siteId + " can't be read (" + e.getMessage() + ")";
				return true;
			}
			StructureTemplate t = new StructureTemplate();
			t.load(level.registryAccess().lookupOrThrow(Registries.BLOCK), tag);
			BlockPos min = new BlockPos(s.restoreBox().minX(), s.restoreBox().minY(), s.restoreBox().minZ());
			writer = new TemplateWriter(TemplateWriter.cells(level, t, Sites.placeSettings(Rotation.NONE)), min, Sites.FLAGS);
			if (dropsBefore == null) {
				dropsBefore = Sites.Drops.before(level, s.restoreBox()).uuids();
			}
		}
		TickDeferral.begin(level, held);
		try {
			writer.step(level, deadline);
		} finally {
			TickDeferral.end();
		}
		if (!writer.done()) {
			return false;
		}
		// as Sites.restoreQuietly: the leaf ticks the restore scheduled are dropped
		TickDeferral.release(level, TickDeferral.withoutLeaves(held));
		held.clear();
		Sites.Drops drops = Sites.Drops.of(level, s.restoreBox(), dropsBefore);
		result = ROLLBACK.equals(purpose) ? Sites.finishRollback(server, level, s, drops, tag) : Sites.finishTickedRemove(server, level, s, drops, tag);
		done = true;
		return true;
	}

	@Override
	public int progress() {
		return writer == null ? 0 : writer.progress();
	}

	@Override
	public int total() {
		return writer == null ? 1 : writer.done() ? writer.total() : writer.cells.size() * 2;
	}

	@Override
	public void aborted(MinecraftServer server) {
		held.clear();
	}

	@Override
	public JsonObject toJson() {
		JsonObject o = new JsonObject();
		o.addProperty("kind", purpose);
		o.addProperty("siteId", siteId);
		if (batchId != null) {
			o.addProperty("batchId", batchId);
		}
		if (itemKey != null) {
			o.addProperty("itemKey", itemKey);
		}
		if (!why.isEmpty()) {
			o.addProperty("why", why);
		}
		if (requeue) {
			o.addProperty("requeue", true);
		}
		if (dropsBefore != null) {
			JsonArray d = new JsonArray();
			dropsBefore.forEach(d::add);
			o.add("dropsBefore", d);
		}
		return o;
	}

	static RestoreJob fromJson(JsonObject o) {
		RestoreJob j = new RestoreJob(o.get("siteId").getAsString(), o.get("kind").getAsString(), o.has("batchId") ? o.get("batchId").getAsString() : null,
			o.has("itemKey") ? o.get("itemKey").getAsString() : null);
		j.why = o.has("why") ? o.get("why").getAsString() : "";
		j.requeue = o.has("requeue") && o.get("requeue").getAsBoolean();
		if (o.has("dropsBefore")) {
			List<String> d = new ArrayList<>();
			o.getAsJsonArray("dropsBefore").forEach(e -> d.add(e.getAsString()));
			j.dropsBefore = d;
		}
		return j;
	}

	@Override
	public String toString() {
		return "RestoreJob[" + purpose + " " + siteId + "]";
	}
}
